/* 阶段准入（gates）：把门禁从"事后审"改成"推进前验"。
 *
 * 为什么要挪到前面：
 * 现在的门禁全在轮次末尾——research-verify 核验引用、research-audit 终审自检。
 * 到那一步，一个空 objective 已经流过了检索、证据、分解、推演，坏产出被下游当成
 * 事实继续加工，代价是一整轮的调用预算，而且自检只能"事后标注"，不能止损。
 *
 * 这里补的是前置机械检查：某一环节刚产出时把产出挂起来，推进到下一环节之前先验。
 * 三条硬约束：
 *   1. 只做机械检查。test 是纯函数（不调模型、不读盘），所以可测、可复现、不花钱。
 *   2. 默认关闭。只有 config.harness.gates === true 才启用，既有用户与既有测试零影响。
 *   3. 不替代既有 rubric。research-audit 的判定一条不动，gates 是额外的前置检查：
 *      拦得住就早停，拦不住也还有终审兜底。
 *
 * 检查约定：
 *   - test(payload) 严格返回 true 才算通过。返回 undefined、抛错、返回 {} 一律算不通过
 *     （宁可严格也不放行：一个写坏的检查不能静默放行）。
 *   - message 是被违反的那个条件（字符串或 payload => 字符串）。
 *   - detail 可选，失败时给具体证据（哪些索引、哪些数字），只用于失败结果。
 */
const { extractNumbers, valueMatches } = require('../exec/claims.cjs');
const { metricTable } = require('../exec/manifest.cjs');

/** 准入失败的错误码。调用方靠它把"准入失败"和普通失败区分开：
 *  科研流程里实验族对任何失败都是"记下来继续"（答案必须能说没跑成），
 *  但准入失败必须中断本轮，不能被那层兜底吞掉。 */
const GATE_FAILED = 'GATE_FAILED';

/** 正文里一旦出现这三个，说明有对象/数字在落字之前就没被正确渲染。 */
const PLACEHOLDERS = ['undefined', '[object Object]', 'NaN'];

const str = value => (typeof value === 'string' ? value.trim() : '');
const arr = value => (Array.isArray(value) ? value : []);

/** 把任意值压成一句短的现场描述，只用在失败 detail 里。 */
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `长度为 ${value.length} 的数组`;
  if (typeof value === 'object') return '对象（不是数组）';
  return `${typeof value}「${String(value).slice(0, 60)}」`;
}

const resolveMessage = (message, payload) => {
  if (typeof message === 'function') {
    try { return String(message(payload) || ''); } catch { return ''; }
  }
  return typeof message === 'string' ? message : '';
};

function normalizeCheck(check, index = 0) {
  if (!check || typeof check !== 'object') throw new Error(`门禁检查必须是对象（第 ${index + 1} 条）`);
  if (typeof check.test !== 'function') throw new Error(`门禁检查 ${check.id || index + 1} 缺少 test 函数`);
  return {
    id: str(check.id) || `check-${index + 1}`,
    message: check.message,
    detail: typeof check.detail === 'function' ? check.detail : null,
    test: check.test
  };
}

/**
 * 定义一条环节门禁。
 * @param {{ stage: string, checks: Array<{ id: string, message: string|Function, test: Function, detail?: Function }> }} input
 */
function defineGate({ stage, checks } = {}) {
  const stageId = str(stage);
  if (!stageId) throw new Error('门禁必须指定 stage');
  const list = arr(checks);
  if (!list.length) throw new Error(`门禁 ${stageId} 至少要有一条检查`);
  const seen = new Set();
  const normalized = list.map((check, index) => {
    const item = normalizeCheck(check, index);
    if (seen.has(item.id)) throw new Error(`门禁 ${stageId} 的检查 id 重复：${item.id}`);
    seen.add(item.id);
    return item;
  });
  return { stage: stageId, checks: normalized };
}

/** 跑一条检查。检查自己抛错也算不通过：写坏的检查不能静默放行。 */
function runCheck(check, payload) {
  let ok = false;
  let thrown = null;
  try {
    ok = check.test(payload) === true;
  } catch (error) {
    thrown = error;
    ok = false;
  }
  const result = { id: check.id, ok, message: resolveMessage(check.message, payload) };
  if (ok) return result;
  let detail = '';
  if (thrown) detail = `检查自身出错：${String(thrown?.message || thrown).slice(0, 200)}`;
  else if (check.detail) {
    try { detail = String(check.detail(payload) || '').slice(0, 300); } catch { detail = ''; }
  }
  return detail ? { ...result, detail } : result;
}

/**
 * 跑某个环节的全部门禁。
 * @param {Array} gates 门禁表（可传一条）
 * @param {{ stage: string, payload: object }} input 环节 id 与本环节刚产出的内容
 * @returns {{ ok: boolean, stage: string, results: Array<{ id: string, ok: boolean, message: string, detail?: string }> }}
 */
function runGates(gates, { stage, payload } = {}) {
  const stageId = str(stage);
  /* 没给 stage 是调用方写错，不是"没有门禁"：按不通过处理，而不是悄悄放行。 */
  if (!stageId) return { ok: false, stage: '', results: [{ id: 'stage', ok: false, message: '阶段准入必须指定 stage' }] };
  const matched = arr(gates).filter(gate => gate && typeof gate === 'object' && gate.stage === stageId);
  const results = [];
  for (const gate of matched) for (const check of gate.checks || []) results.push(runCheck(check, payload || {}));
  return { ok: results.every(item => item.ok), stage: stageId, results };
}

/* ── 内置的四条 ─────────────────────────────────────────────────────────── */

/** research-scope：没有目标或没有问题清单，后面的检索与推演全都无的放矢。 */
const scopeGate = defineGate({
  stage: 'research-scope',
  checks: [
    {
      id: 'objective',
      message: '研究界定必须给出非空 objective',
      detail: payload => `objective 实际是 ${describe(payload.objective)}`,
      test: payload => !!str(payload.objective)
    },
    {
      id: 'questions',
      message: '研究界定必须给出非空 questions 数组',
      detail: payload => `questions 实际是 ${describe(payload.questions)}`,
      test: payload => Array.isArray(payload.questions) && payload.questions.length > 0
    }
  ]
});

/* 一条证据"有内容"就算合格：管线里存的是 claim/keys，外部可能写成 text/key，两种都收。 */
const hasClaimBody = claim => {
  if (typeof claim === 'string') return !!str(claim);
  if (!claim || typeof claim !== 'object') return false;
  return !!str(claim.text) || !!str(claim.claim) || !!str(claim.statement) || !!str(claim.key) || arr(claim.keys).some(key => !!str(key));
};

const emptyClaimIndexes = payload =>
  arr(payload.claims).map((claim, index) => (hasClaimBody(claim) ? 0 : index + 1)).filter(position => position > 0);

/** research-evidence：证据环节交出空 claims，等于让后面的推演全靠编。 */
const evidenceGate = defineGate({
  stage: 'research-evidence',
  checks: [
    {
      id: 'claims',
      message: '证据提取必须给出非空 claims 数组',
      detail: payload => `claims 实际是 ${describe(payload.claims)}`,
      test: payload => Array.isArray(payload.claims) && payload.claims.length > 0
    },
    {
      id: 'claim-shape',
      message: '每条证据至少要有 text 或 key',
      detail: payload => `第 ${emptyClaimIndexes(payload).join('、')} 条证据既没有 text 也没有 key`,
      test: payload => emptyClaimIndexes(payload).length === 0
    }
  ]
});

const foundPlaceholders = text => PLACEHOLDERS.filter(token => String(text == null ? '' : text).includes(token));

/** research-final：正文一旦带上 JS 的默认渲染痕迹，这段答案就不能交给用户。 */
const finalGate = defineGate({
  stage: 'research-final',
  checks: [
    {
      id: 'no-placeholders',
      message: '正文不得出现 undefined、[object Object] 或 NaN',
      detail: payload => `命中 ${foundPlaceholders(payload.text).join('、')}`,
      test: payload => foundPlaceholders(payload.text).length === 0
    }
  ]
});

/** 本轮运行记录里所有可被核对的数值：指标 + 参数（参数写进正文也算可核对）。 */
function traceableValues(manifests) {
  const values = [];
  for (const manifest of arr(manifests)) {
    if (!manifest || typeof manifest !== 'object') continue;
    for (const value of Object.values(metricTable(manifest))) values.push(value);
    for (const value of Object.values(manifest.params || {})) values.push(value);
  }
  return values;
}

/** 结论文本里指不回运行记录的数字。没有 conclusion 就没有约束（这一条允许缺省）。 */
function unsourcedConclusionNumbers(payload = {}) {
  const source = typeof payload.conclusion === 'string'
    ? payload.conclusion
    : payload.conclusion == null ? '' : JSON.stringify(payload.conclusion);
  const numbers = extractNumbers(source);
  if (!numbers.length) return [];
  const pool = traceableValues(payload.manifests);
  return numbers.filter(number => !pool.some(value => valueMatches(number.raw, value) || String(value) === number.token));
}

/** experiment-analyze：结论里的数字必须来自本轮真实跑出来的运行记录。 */
const analyzeGate = defineGate({
  stage: 'experiment-analyze',
  checks: [
    {
      id: 'conclusion-numbers',
      message: '结论文本里的数字必须能在本轮运行记录里找到',
      detail: payload => `找不到出处的数字：${unsourcedConclusionNumbers(payload).map(number => number.raw).join('、')}`,
      test: payload => unsourcedConclusionNumbers(payload).length === 0
    }
  ]
});

const DEFAULT_GATES = [scopeGate, evidenceGate, finalGate, analyzeGate];

module.exports = {
  GATE_FAILED,
  PLACEHOLDERS,
  defineGate,
  runGates,
  DEFAULT_GATES
};
