/* 实验族的纯逻辑：把「模型的实验设计」翻译成「真的能跑的 trial 列表」，再把结果汇总。
 *
 * 为什么单独一层：这部分必须可测、可解释、不能花模型调用。
 * 模型只负责出规格（假设、指标、搜索空间、停止条件），**能不能跑、跑什么都由这里判定**：
 *   - 参数必须过受控模板的白名单校验，越界的组合直接丢弃并记原因；
 *   - 组合数量受 maxTrials 与执行预算裁剪；
 *   - 模板没有声明的指标不允许当主指标。
 *
 * 无 IO、不起进程、不发网络。
 */
const templates = require('./exec/templates.cjs');

const stringSchema = { type: 'string' };
const stringArray = { type: 'array', items: stringSchema };

/* 实验设计：模型只填这些字段，不许发明模板或指标。 */
const EXPERIMENT_SCHEMA = {
  type: 'object',
  properties: {
    needed: { type: 'boolean' },
    reason: stringSchema,
    hypothesis: stringSchema,
    template: stringSchema,
    metric: stringSchema,
    direction: { type: 'string', enum: ['maximize', 'minimize'] },
    baseline: { type: 'object', additionalProperties: true },
    searchSpace: {
      type: 'array',
      items: {
        type: 'object',
        properties: { param: stringSchema, values: { type: 'array', items: {} } },
        required: ['param', 'values'],
        additionalProperties: false
      }
    },
    stopWhen: stringSchema,
    risks: stringArray
  },
  required: ['needed', 'reason', 'template', 'metric', 'direction', 'baseline', 'stopWhen'],
  additionalProperties: false
};

/* 结果分析：判断要不要继续调参，以及下一轮的参数从哪来。 */
const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    comparison: stringSchema,
    continue: { type: 'boolean' },
    nextBaseline: { type: 'object', additionalProperties: true },
    nextSearchSpace: {
      type: 'array',
      items: {
        type: 'object',
        properties: { param: stringSchema, values: { type: 'array', items: {} } },
        required: ['param', 'values'],
        additionalProperties: false
      }
    },
    why: stringSchema,
    conclusion: stringSchema,
    boundaries: stringArray
  },
  required: ['comparison', 'continue', 'why', 'conclusion'],
  additionalProperties: false
};

const DESIGN_PROMPT = `你是实验设计者。先判断这个问题**是否真的需要跑实验**：
- 需要：结论依赖可测量的数字（准确率、误差、耗时、收敛速度等），且数据与算力允许在受控模板上跑出来；
- 不需要：纯文献综述、概念辨析、只能靠人工判断的问题，或模板能力覆盖不到的问题。
需要时才填 template / metric / baseline / searchSpace；不需要时 needed=false，并用 reason 说明。
规则：
1) template 只能从给定模板里选；metric 必须是该模板声明过的指标名。
2) baseline 是该模板参数的起点，键必须是模板声明过的参数。
3) searchSpace 每项给出 param 与候选 values（用于调参）；每轮总运行次数不超过给定上限。
4) hypothesis 必须可证伪；stopWhen 写清什么时候停（例如"主指标连续两轮不再提升"）。
5) 不要编造数据集、指标或模型能力。模板跑不出来的东西，写进 risks 而不是硬塞。
6) 如果给了 requestedPlan（用户明确指定要执行的那一个方案），你必须**照它设计**：
   hypothesis、baseline 与 searchSpace 都要服务于这个方案，不得换成别的方向；
   受控模板确实跑不出来时，needed=false，并在 reason 里写清是哪一步做不到。`;

const ANALYZE_PROMPT = `你是实验结果分析者。只依据给出的真实运行记录判断：
1) 比较各 trial 的主指标，指出最好的一个与它的参数；差距不显著就直说。
2) 判断是否值得再跑一轮调参：只有存在明确可调方向（例如某参数趋势单调）时才 continue=true。
3) continue=true 时给出 nextBaseline 与可选的 nextSearchSpace（只能是模板声明过的参数）。
4) conclusion 只写这批数据能支撑的结论；boundaries 写清边界（样本量、单一数据集、未做外推等）。
不得编造未记录的数字；数字一律以给定运行记录为准。`;

const pick = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);

/**
 * 展开搜索空间为候选参数组合（不是全笛卡尔积：按顺序逐个变一个参数，取前 maxTrials 个）。
 * 这样既能覆盖单参数敏感性，又不会因为 3 个参数各 4 个值就炸出 64 个组合。
 */
function expandSpace(searchSpace, { maxTrials, baseline }) {
  const entries = (Array.isArray(searchSpace) ? searchSpace : [])
    .map(item => ({ param: pick(item?.param), values: Array.isArray(item?.values) ? item.values : [] }))
    .filter(item => item.param && item.values.length);
  const combos = [];
  for (const entry of entries) {
    for (const value of entry.values) {
      combos.push({ ...baseline, [entry.param]: value, __varies: entry.param });
      if (combos.length >= maxTrials) return combos;
    }
  }
  return combos;
}

/**
 * 把实验设计翻译成可执行的 trial 计划。
 * 参数越界、模板不存在、指标未声明，都在这里挡住并记录原因，绝不硬跑。
 */
function buildTrials({ design, available = [], limit = {} }) {
  const maxTrials = Math.max(1, Number(limit.maxTrials) || 4);
  const templates = Array.isArray(available) ? available : [];
  const wanted = pick(design?.template) || pick(limit.templateId);
  const template = templates.find(item => item.id === wanted) || templates.find(item => item.id === pick(limit.templateId));
  if (!template) {
    return { trials: [], rejected: [{ reason: `模板不可用：${wanted || '(未指定)'}，可选 ${templates.map(t => t.id).join('/') || '无'}` }], template: null };
  }
  const metric = pick(design?.metric);
  if (metric && Array.isArray(template.metrics) && !template.metrics.includes(metric)) {
    return { trials: [], rejected: [{ reason: `指标 ${metric} 不在模板声明的指标里（${template.metrics.join('/')}）` }], template };
  }
  const baselineInput = design?.baseline && typeof design.baseline === 'object' ? design.baseline : {};
  let baseline;
  try {
    baseline = templates_moduleValidate(template.id, baselineInput);
  } catch (error) {
    return { trials: [], rejected: [{ reason: `基线参数不合法：${error.message}` }], template };
  }
  const combos = expandSpace(design?.searchSpace, { maxTrials, baseline });
  const trials = [];
  const rejected = [];
  const push = (params, varies = null) => {
    if (trials.length >= maxTrials) return;
    /* __varies 只是「这一轮变的是哪个参数」的标记，绝不能混进模板参数里 */
    const clean = { ...params };
    delete clean.__varies;
    let validated;
    try { validated = templates_moduleValidate(template.id, clean); } catch (error) { rejected.push({ params: clean, reason: error.message }); return; }
    trials.push({
      label: `${template.id}#${trials.length + 1}`,
      template: template.id,
      params: validated,
      varies: varies || params.__varies || null,
      metric: metric || (template.metrics?.[0] ?? null),
      direction: design?.direction === 'minimize' ? 'minimize' : 'maximize'
    });
  };
  /* 先跑基线本身，再跑调参组合：没有基线就无法判断"提升"是否成立。 */
  push(baseline);
  for (const combo of combos) push(combo, combo.__varies);
  return { trials, rejected, template, metric: metric || (template.metrics?.[0] ?? null), direction: design?.direction === 'minimize' ? 'minimize' : 'maximize' };
}

/* 单独包一层：便于测试替换，也避免把 exec/templates 的报错文案改动扩散到这里。 */
function templates_moduleValidate(id, params) {
  return templates.validateParams(id, params || {});
}

/** 从一组运行记录里挑出主指标最优的那个（本地客观判断，不依赖模型）。 */
function bestTrial(runs, { metric, direction = 'maximize' } = {}) {
  const { metricTable } = require('./exec/manifest.cjs');
  let best = null;
  for (const run of runs || []) {
    if (run?.status !== 'done') continue;
    const table = metricTable(run);
    const value = table[metric];
    if (typeof value !== 'number') continue;
    if (!best || (direction === 'minimize' ? value < best.value : value > best.value)) {
      best = { runId: run.runId, value, params: run.params || {}, metric };
    }
  }
  return best;
}

/** 汇总：给分析环节与最终答案用的精简表。 */
function summarizeRuns(runs, { metric, direction } = {}) {
  const { metricTable } = require('./exec/manifest.cjs');
  const rows = (runs || []).map(run => ({
    runId: run?.runId || null,
    label: run?.label || null,
    template: run?.template?.id || null,
    status: run?.status || 'unknown',
    params: run?.params || {},
    metric: metric ? metricTable(run)[metric] ?? null : null,
    error: run?.error || null
  }));
  const completed = rows.filter(row => row.status === 'done' && typeof row.metric === 'number');
  return {
    rows,
    completed: completed.length,
    failed: rows.filter(row => row.status !== 'done').length,
    best: bestTrial(runs, { metric, direction }),
    metric: metric || null,
    direction: direction || 'maximize'
  };
}

/** 供最终答案与界面使用的实验记录文本（E 编号由运行记录本身决定，这里只描述事实）。 */
function describeRuns(runs) {
  const { metricTable } = require('./exec/manifest.cjs');
  const lines = [];
  for (const run of runs || []) {
    const table = metricTable(run);
    const pairs = Object.entries(table).map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value.toPrecision(6)) : value}`).join(', ');
    lines.push(`${run.label || run.runId} | ${run.template?.name || run.template?.id} | ${run.status} | 参数 ${JSON.stringify(run.params || {})} | 指标 ${pairs || '无'}`);
  }
  return lines.join('\n');
}

module.exports = {
  EXPERIMENT_SCHEMA,
  ANALYZE_SCHEMA,
  DESIGN_PROMPT,
  ANALYZE_PROMPT,
  expandSpace,
  buildTrials,
  bestTrial,
  summarizeRuns,
  describeRuns
};
