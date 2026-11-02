/* 确认闸的验收：花钱的执行动作必须先经人点头。
 *
 * 验八件事（对应 core/harness/loop.cjs 的 askPermission 与 registry.cjs 的 requiresConfirmation）：
 *   1. 声明是注册处的事：默认 false，只有 run_experiment 是 true，且不泄露给模型；
 *   2. 允许 → 真的执行，账本记 tool.confirm(allowed:true)；
 *   3. 拒绝 → 一次都不执行，回灌"用户拒绝"，账本记 allowed:false；
 *   4. 没注入 confirm → 默认拒绝（没有确认通道就不许执行危险动作）；
 *   5. 不需要确认的工具完全不受影响（连 confirm 都不会被调用）；
 *   6. 确认发生在 toolbox.invoke 之前——用调用顺序断言，不靠推断；
 *   7. 拒绝是正常路径：循环继续走到 'final'，不抛错；confirm 自己抛错也按拒绝；
 *   8. 研究流程这条链路真的接上了：runResearch 的 confirm 一路传到循环（漏一次就没人点头）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistry } = require('../core/harness/tools/registry.cjs');
const { createToolbox } = require('../core/harness/tools/index.cjs');
const { runAgentLoop, CONFIRM_DENIED_TEXT } = require('../core/harness/loop.cjs');
const { openWorkspace } = require('../core/harness/workspace.cjs');
const ids = require('../core/harness/ids.cjs');
const research = require('../core/research.cjs');

const fence = calls => '```tool\n' + JSON.stringify(calls) + '\n```';

function makeWorkspace() {
  return openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-confirm-')), runId: ids.newRunId(), ledger: false });
}

/* 假账本：只收 append，断言全靠它。 */
function makeLedger() {
  const entries = [];
  return {
    entries,
    append: (type, fields) => { entries.push({ type, ...fields }); },
    of: type => entries.filter(entry => entry.type === type)
  };
}

/* 真工具箱：工具是否存在、要不要确认都走注册处的真代码路径。 */
function makeRealBox(runs) {
  return createToolbox({
    workspace: makeWorkspace(),
    capabilities: {
      /* 这里必须解构 templateId：main.cjs 的 experimentTools.run 收的就是这个键。
         照着 tools/index.cjs 的旧写法解构 template，会拿到 undefined，
         于是「工具真的跑了」这条断言形同虚设——真机路径正是这样静默坏掉的。 */
      runExperiment: async ({ templateId, params, label }) => {
        runs.push({ templateId, params, label });
        return { runId: 'run-fixed', status: 'done', exitCode: 0, metrics: { return_mean: 500 } };
      }
    }
  });
}

/* 脚本工具箱：可以精确控制"确认"与"执行"的先后。 */
function makeScriptedBox(order) {
  const registry = createRegistry();
  registry.define({
    name: 'costly',
    permission: 'execute',
    requiresConfirmation: true,
    params: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { order.push('invoke:costly'); return { ok: true, result: 'COSTLY' }; }
  });
  registry.define({
    name: 'plain',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { order.push('invoke:plain'); return { ok: true, result: 'PLAIN' }; }
  });
  return {
    specs: () => registry.specs(),
    invoke: (name, args, ctx) => registry.invoke(name, args, ctx),
    get: name => registry.get(name)
  };
}

/* 跑一轮：第一轮把 calls 全部发出去，第二轮截住回灌内容并收尾。 */
async function runBurst(box, calls, { confirm, ledger } = {}) {
  let replayed = '';
  let round = 0;
  const result = await runAgentLoop({
    provider: 'deepseek',
    stage: 'research-final',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: box,
    confirm,
    ledger,
    call: async ({ messages, onText }) => {
      round += 1;
      if (round === 1) onText(fence({ calls }));
      else { replayed = messages.at(-1).content; onText('done'); }
    }
  });
  return { result, replayed };
}

const RUN_CALL = [{ name: 'run_experiment', args: { template: 'env-smoke', params: { dim: 32 }, label: 'baseline' } }];

/* ---------- 1. 声明 ---------- */

test('确认声明：注册处默认 false，只有 run_experiment 为 true，且 specs() 不外泄', () => {
  const registry = createRegistry();
  registry.define({ name: 'plain', execute: async () => ({ ok: true }) });
  registry.define({ name: 'costly', requiresConfirmation: true, execute: async () => ({ ok: true }) });
  assert.equal(registry.get('plain').requiresConfirmation, false, '默认必须不确认，否则什么都没干就先弹窗');
  assert.equal(registry.get('costly').requiresConfirmation, true);
  for (const spec of registry.specs()) {
    assert.ok(!('requiresConfirmation' in spec), `specs() 不该把执行语义泄露给模型：${spec.name}`);
    assert.ok(!('parallelSafe' in spec), 'parallelSafe 也不该泄露');
  }

  const box = makeRealBox([]);
  assert.equal(box.get('run_experiment').requiresConfirmation, true, '跑实验会花钱占机器，必须确认');
  assert.equal(box.get('read_artifact').requiresConfirmation, false);
  assert.equal(box.get('write_note').requiresConfirmation, false);
  assert.ok(box.specs().every(spec => !('requiresConfirmation' in spec)));
});

/* ---------- 2. 允许 ---------- */

test('确认返回 true：工具真的执行，账本记 tool.confirm 且 allowed 为 true', async () => {
  const runs = [];
  const ledger = makeLedger();
  const asked = [];
  const box = makeRealBox(runs);
  const { result, replayed } = await runBurst(box, RUN_CALL, {
    ledger,
    confirm: async ask => { asked.push(ask); return true; }
  });

  /* 键名是 templateId 不是 template：main.cjs 的 experimentTools.run 解构的是
     templateId，tools/index.cjs 负责把模型侧的 template 转成它。
     这条断言守的正是那次转换——转丢了真机路径就会 templateById(undefined) 抛错。 */
  assert.deepEqual(runs, [{ templateId: 'env-smoke', params: { dim: 32 }, label: 'baseline' }], '允许后必须真跑一次');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].ok, true);
  assert.match(replayed, /return_mean/, '运行结果要回灌给模型');

  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'run_experiment');
  assert.equal(asked[0].permission, 'execute');
  assert.deepEqual(asked[0].args, { template: 'env-smoke', params: { dim: 32 }, label: 'baseline' },
    '确认时必须带上模型给的原始参数，人要知道自己批准了什么');

  const confirms = ledger.of('tool.confirm');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].name, 'run_experiment');
  assert.equal(confirms[0].allowed, true);
  assert.equal(typeof confirms[0].ms, 'number');
  assert.ok(confirms[0].ms >= 0);
  assert.equal(confirms[0].provider, 'deepseek');
  assert.equal(confirms[0].stage, 'research-final');
});

/* ---------- 3. 拒绝 ---------- */

test('确认返回 false：一次都不执行，回灌"用户拒绝"，账本记 allowed:false', async () => {
  const runs = [];
  const ledger = makeLedger();
  const box = makeRealBox(runs);
  const { result, replayed } = await runBurst(box, RUN_CALL, { ledger, confirm: async () => false });

  assert.deepEqual(runs, [], '拒绝后 capabilities.runExperiment 绝不能被调用');
  assert.match(replayed, /用户拒绝了这次执行/, `回灌里必须明说被拒：${replayed}`);
  assert.match(replayed, /不要重复尝试/, '必须明确禁止重试，否则模型会换个参数再骚扰一次');
  assert.ok(replayed.includes(CONFIRM_DENIED_TEXT));
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].ok, false);

  const confirms = ledger.of('tool.confirm');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].allowed, false);
  assert.equal(confirms[0].name, 'run_experiment');
  assert.equal(ledger.of('tool.call').length, 1, '被拒的调用照样要留痕');
});

/* ---------- 4. 没有确认通道 ---------- */

test('没注入 confirm：默认拒绝，危险动作不执行', async () => {
  const runs = [];
  const ledger = makeLedger();
  const box = makeRealBox(runs);
  const { result, replayed } = await runBurst(box, RUN_CALL, { ledger });

  assert.deepEqual(runs, [], '没有确认通道就不许执行危险动作');
  assert.match(replayed, /用户拒绝了这次执行/);
  assert.equal(result.toolCalls[0].ok, false);
  const confirms = ledger.of('tool.confirm');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].allowed, false, '没通道也要记账，否则事后看不出是漏注入');
});

/* ---------- 5. 不需要确认的工具 ---------- */

test('不需要确认的工具不受影响：confirm 一次都不会被调用', async () => {
  const asked = [];
  const order = [];
  const box = makeScriptedBox(order);
  const { result } = await runBurst(box, [{ name: 'plain', args: {} }], {
    confirm: async ask => { asked.push(ask); return false; }
  });
  assert.equal(asked.length, 0, '只读工具不该打扰用户');
  assert.equal(result.toolCalls[0].ok, true);
  assert.deepEqual(order, ['invoke:plain']);
});

/* ---------- 6. 顺序：确认先于执行 ---------- */

test('确认发生在 toolbox.invoke 之前（调用顺序断言）', async () => {
  const order = [];
  const box = makeScriptedBox(order);
  await runBurst(box, [{ name: 'costly', args: {} }], {
    confirm: async () => { order.push('confirm'); return true; }
  });
  assert.deepEqual(order, ['confirm', 'invoke:costly'], '必须先拿到允许，再谈执行');

  const deniedOrder = [];
  const deniedBox = makeScriptedBox(deniedOrder);
  await runBurst(deniedBox, [{ name: 'costly', args: {} }], {
    confirm: async () => { deniedOrder.push('confirm'); return false; }
  });
  assert.deepEqual(deniedOrder, ['confirm'], '拒绝时 invoke 一次都不该出现');
});

/* ---------- 7. 拒绝是正常路径 ---------- */

test('拒绝后循环继续走到 final，不抛错；confirm 自己抛错也按拒绝', async () => {
  const order = [];
  const box = makeScriptedBox(order);
  const { result, replayed } = await runBurst(box, [{ name: 'costly', args: {} }], { confirm: async () => false });
  assert.equal(result.stoppedReason, 'final', '拒绝不是异常，整轮不能因此报废');
  assert.equal(result.steps, 2, '拒绝后仍要给模型一次改路线的机会');
  assert.match(replayed, /用户拒绝/);

  /* 确认通道自己坏了（窗口已销毁、对话框抛错）：同样按拒绝，不能放行。 */
  const brokenOrder = [];
  const brokenBox = makeScriptedBox(brokenOrder);
  const broken = await runBurst(brokenBox, [{ name: 'costly', args: {} }], {
    confirm: async () => { throw new Error('窗口已销毁'); }
  });
  assert.deepEqual(brokenOrder, [], 'confirm 抛错时绝不能执行');
  assert.match(broken.replayed, /用户拒绝/);

  /* 非 true 的返回值也不算允许：只认明确的 true。 */
  const sketchyOrder = [];
  const sketchyBox = makeScriptedBox(sketchyOrder);
  await runBurst(sketchyBox, [{ name: 'costly', args: {} }], { confirm: async () => 'yes' });
  assert.deepEqual(sketchyOrder, [], '返回值不是 true 就当拒绝');
});

/* ---------- 8. 研究流程这条链路 ---------- */

/* 这条守的是"接线漏了没人发现"：confirm 要经过 runResearch → requestWithTools → runAgentLoop
   三跳才到闸门，中途少传一次，闸门就永远收到 null（于是永远拒绝）或者永远收不到。 */
const catalog = {
  providers: ['deepseek'],
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high'], defaultEffort: 'high' }]
};
const pick = { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' };
const conversation = { id: 'conv-confirm', messages: [{ role: 'user', text: '为什么基线降低方差' }] };

function makeResearchConfig() {
  return research.validateConfig({
    version: 4, profile: 'p1-review', tier: 'readonly',
    choices: {
      scope: pick, evidence: pick, plan: pick, screen: pick, final: pick, audit: null,
      experimentDesign: null, experimentAnalyze: null,
      summarize: null, teachingOutline: null, teachingSections: null, teachingExamples: null
    },
    tasks: [{ id: 'task-1', title: '推导线', brief: '推导', choice: pick }],
    allowRefinement: false,
    refinement: { maxTasks: 2, maxPassesPerTurn: 1 },
    teaching: { audience: 'x', prerequisites: [], learningGoal: 'x', chapterCount: 2, chapterChoices: {}, numericPolicy: 'builtin-arithmetic-only' },
    retrieval: {
      enabled: false, sources: ['openalex'], maxQueries: 1, maxRecordsPerSource: 3, maxRecordsPerQuery: 3,
      maxRecordsPerRun: 20, maxRequests: 10, maxRetriesPerRequest: 0, yearFrom: null, yearTo: null, reusePolicy: 'explicit-selection'
    },
    evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
    budget: { maxCalls: 12, wallClockSec: 900, modelTimeoutSec: 300, maxConcurrentModels: 2, maxModelRetryAttempts: 0, maxRepairAttempts: 0 },
    monitor: { enabled: false },
    mech: { enabled: false, provider: null, model: null, effort: null, triggers: [], maxAttemptsPerNode: 1, maxMechCalls: 0, outputPolicy: 'candidate-only', onInvalidOutput: 'fallback-deterministic' },
    output: { language: 'zh-CN', processPanelDefault: 'collapsed' },
    experiments: { enabled: false, maxTrials: 4, maxRounds: 2, templateId: null, stopWhen: 'x' }
  }, catalog);
}

const emptyKnowledge = () => ({ records: [], all() { return []; }, add() { return { added: [] }; }, noteError() {}, save() {}, stats() { return { total: 0 }; }, digest() { return []; }, toAuditRecords() { return []; } });

/* 走一遍真研究流程，让模型在收口环节申请跑实验。 */
async function runResearchWithExperimentRequest({ confirm, runs }) {
  const config = makeResearchConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-confirm-flow-')), runId: ids.newRunId() });
  let replayed = '';

  const call = async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '解释方差', questions: ['基线作用'], queries: ['pg variance'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '解释方差', tasks: [{ id: 'task-1', assignment: '推导', deliverable: '结论', evidenceKeys: [] }], selectionCriteria: '证据' }));
    if (a.stage === 'research-explore') return a.onText('推导：基线抵消了与动作无关的项。');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') {
      const last = String(a.messages.at(-1).content);
      if (!last.includes('【工具结果】')) {
        return a.onText('先跑一次实验。\n' + fence({ calls: RUN_CALL }));
      }
      replayed = last;
      return a.onText('## 结论\n\n基线只降低方差，本轮未跑实验。');
    }
    throw new Error('本测试不该调用阶段：' + a.stage);
  };

  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, workspace, confirm,
    verifyExperiments: () => null,
    experimentTools: {
      templates: () => [{ id: 'env-smoke', name: '环境冒烟' }],
      checkBudget: () => ({ ok: true, remainingRuns: 3 }),
      run: async options => {
        runs.push(options);
        return { runId: 'run-flow', status: 'done', exitCode: 0, metrics: { return_mean: 500 }, label: 'E1' };
      }
    }
  });

  const types = workspace.ledger.read().entries.map(entry => entry.type);
  return { result, replayed, types, entries: workspace.ledger.read().entries };
}

test('研究流程的确认通道确实接上了：拒绝时实验工具一次都没跑', async () => {
  const runs = [];
  const asked = [];
  const flow = await runResearchWithExperimentRequest({ runs, confirm: async ask => { asked.push(ask); return false; } });

  assert.equal(asked.length, 1, 'run_experiment 必须先问人');
  assert.equal(asked[0].name, 'run_experiment');
  assert.deepEqual(runs, [], '拒绝后 experimentTools.run 绝不能被调用');
  assert.match(flow.replayed, /用户拒绝了这次执行/);
  assert.match(flow.result.finalText, /未跑实验/);
  assert.ok(flow.types.includes('tool.confirm'), `账本里必须有 tool.confirm，实际只有 ${flow.types.join('、')}`);
  const entry = flow.entries.find(item => item.type === 'tool.confirm');
  assert.equal(entry.allowed, false);
  assert.equal(entry.name, 'run_experiment');
  assert.ok(entry.runId, '账本条目要带 runId');
});

test('研究流程的确认通道确实接上了：允许时实验工具被调用一次', async () => {
  const runs = [];
  const flow = await runResearchWithExperimentRequest({ runs, confirm: async () => true });

  assert.equal(runs.length, 1, '允许后必须真跑一次');
  assert.equal(runs[0].templateId, 'env-smoke');
  const entry = flow.entries.find(item => item.type === 'tool.confirm');
  assert.equal(entry.allowed, true);
  assert.match(flow.result.finalText, /基线只降低方差/);
});
