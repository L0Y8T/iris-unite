/* 实验族接入研究流程的验收：设计 → 生成 → 训练评估 → 分析调参 → 记录。
 *
 * 模型用假 stub，执行用假 driver，所以离线、不花钱、可重复。
 * 真训练由 tests/exec-run.test.cjs 单独验，这里只验流程编排与门禁。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const research = require('../core/research.cjs');

const catalog = {
  providers: ['deepseek'],
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high'], defaultEffort: 'high' }]
};
const pick = { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' };
const conversation = { id: 'conv-exp', messages: [{ role: 'user', text: '比较不同模型在小数据集上的准确率' }] };

function makeConfig(over = {}) {
  const base = {
    version: 4,
    profile: 'p1-review',
    tier: 'readonly',
    choices: {
      scope: pick, evidence: pick, plan: pick, screen: pick, final: pick, audit: null,
      experimentDesign: pick, experimentAnalyze: pick,
      summarize: null, teachingOutline: null, teachingSections: null, teachingExamples: null
    },
    tasks: [
      { id: 'task-1', title: '路线发散', brief: '发散路线', choice: pick },
      { id: 'task-2', title: '机制', brief: '构造机制', choice: pick }
    ],
    allowRefinement: false,
    refinement: { maxTasks: 2, maxPassesPerTurn: 1 },
    teaching: { audience: 'x', prerequisites: [], learningGoal: 'x', chapterCount: 2, chapterChoices: {}, numericPolicy: 'builtin-arithmetic-only' },
    retrieval: {
      enabled: false, sources: ['openalex'], maxQueries: 1, maxRecordsPerSource: 3, maxRecordsPerQuery: 3,
      maxRecordsPerRun: 20, maxRequests: 10, maxRetriesPerRequest: 0, yearFrom: null, yearTo: null, reusePolicy: 'explicit-selection'
    },
    evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
    budget: { maxCalls: 14, wallClockSec: 900, modelTimeoutSec: 300, maxConcurrentModels: 2, maxModelRetryAttempts: 0, maxRepairAttempts: 0 },
    monitor: { enabled: false },
    mech: { enabled: false, provider: null, model: null, effort: null, triggers: [], maxAttemptsPerNode: 1, maxMechCalls: 0, outputPolicy: 'candidate-only', onInvalidOutput: 'fallback-deterministic' },
    output: { language: 'zh-CN', processPanelDefault: 'collapsed' },
    experiments: { enabled: true, maxTrials: 4, maxRounds: 2, templateId: null, stopWhen: '主指标不再提升' }
  };
  const merged = { ...base, ...over };
  return research.validateConfig(merged, catalog);
}

const available = [{ id: 'tabular-baseline', name: '表格基线', metrics: ['test.accuracy', 'test.macro_f1'], params: [] }];

const designOf = over => ({
  needed: true,
  reason: '结论依赖可测量的准确率',
  hypothesis: '随机森林优于逻辑回归',
  template: 'tabular-baseline',
  metric: 'test.accuracy',
  direction: 'maximize',
  baseline: { dataset: 'digits', model: 'logreg', testSize: 0.2, seed: 42 },
  searchSpace: [{ param: 'model', values: ['random_forest'] }],
  stopWhen: '主指标不再提升',
  risks: [],
  ...over
});

/** 造一套实验工具：run 返回伪运行记录，metrics 可按参数变化。 */
function makeTools({ accuracyByModel = { logreg: 0.93, random_forest: 0.97 }, budget = { ok: true }, failOn = [] } = {}) {
  let counter = 0;
  const calls = [];
  return {
    calls,
    templates: () => available,
    checkBudget: () => budget,
    run: async ({ templateId, params, label }) => {
      calls.push({ templateId, params, label });
      counter += 1;
      const runId = `run-${counter}`;
      if (failOn.includes(params.model)) return { runId, label, status: 'failed', error: '模拟训练失败', params, template: { id: templateId, name: '表格基线' } };
      const value = accuracyByModel[params.model] ?? 0.9;
      return {
        runId, label, status: 'done', params, startedAt: Date.now() - 1000, finishedAt: Date.now(),
        template: { id: templateId, name: '表格基线' }, artifacts: [{ name: 'metrics.json', bytes: 10, sha256: 'x' }],
        metrics: { test: { accuracy: value, macro_f1: value - 0.01 } }
      };
    }
  };
}

/** 一个够用的研究流程 stub：只回答与本测试相关的阶段。 */
function makeCall({ design = designOf(), analyses = [], finalText = '结论：随机森林更好 [E1]。' } = {}) {
  const seen = { stages: [], designs: 0, analyses: 0 };
  const call = async a => {
    seen.stages.push(a.stage);
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '比较模型', questions: ['哪个更准'], queries: ['digits'], inclusion: ['同行评议'], exclusion: ['博客'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '比较模型', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }, { id: 'task-2', assignment: 'c', deliverable: 'd', evidenceKeys: [] }], selectionCriteria: '准确率' }));
    if (a.stage === 'research-explore') return a.onText('路线成果');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '都保留', unsupported: [] }));
    if (a.stage === 'experiment-design') { seen.designs += 1; return a.onText(JSON.stringify(design)); }
    if (a.stage === 'experiment-analyze') {
      const next = analyses[Math.min(seen.analyses, analyses.length - 1)] || { comparison: '随机森林更优', continue: false, why: '已明显更优', conclusion: '随机森林更好', boundaries: ['单一数据集'] };
      seen.analyses += 1;
      return a.onText(JSON.stringify(next));
    }
    if (a.stage === 'research-final') return a.onText(finalText);
    throw new Error('本测试不该调用阶段：' + a.stage);
  };
  return { call, seen };
}

const emptyKnowledge = () => ({
  records: [], all() { return []; }, add() { return { added: [] }; },
  noteError() {}, save() {}, stats() { return { total: 0 }; }, digest() { return []; }, toAuditRecords() { return []; }
});

test('流程内跑实验：设计 → 基线 + 调参 → 分析 → 记录，且不调参时只跑一轮', async () => {
  const c = makeConfig();
  const run = research.createRun(c);
  const tools = makeTools();
  const { call, seen } = makeCall();
  const events = [];
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, onChange: e => events.push(e),
    experimentTools: tools, experimentRuns: [],
    experimentReference: runs => `可用运行 ${runs.length} 个`,
    verifyExperiments: () => ({ ok: true, text: '', markers: { total: 0, resolved: [], unresolved: [] }, numbers: { total: 0, bound: [], unsourced: [] }, removed: [], note: '' })
  });

  assert.equal(run.status, 'done');
  assert.ok(seen.stages.includes('experiment-design'), '应执行实验设计');
  assert.ok(seen.stages.includes('experiment-analyze'), '应执行结果分析');
  assert.equal(tools.calls.length, 2, '基线 + 1 个调参组合');
  assert.deepEqual(tools.calls.map(x => x.params.model), ['logreg', 'random_forest']);
  assert.equal(result.experimentFamily.skipped, false);
  assert.equal(result.experimentFamily.summary.completed, 2);
  assert.equal(result.experimentFamily.summary.best.value, 0.97);
  assert.equal(result.experimentFamily.rounds.length, 1, '分析判定不继续，只跑一轮');
  assert.ok(events.some(e => e.kind === 'experiment-design'));
  assert.ok(events.some(e => e.kind === 'experiment-runs'));
  assert.ok(events.some(e => e.kind === 'experiment-report'));
  const check = events.find(e => e.kind === 'research-audit').audit.checks.find(x => x.name === '实验族已执行');
  assert.ok(check && check.ok, '自检里应记录实验族执行成功');
});

test('分析要求继续调参时再跑一轮，但总量不超过 maxTrials', async () => {
  const c = makeConfig({ experiments: { enabled: true, maxTrials: 3, maxRounds: 3, templateId: null, stopWhen: 'x' } });
  const run = research.createRun(c);
  const tools = makeTools();
  const continueAnalysis = { comparison: '有提升空间', continue: true, nextBaseline: { dataset: 'digits', model: 'mlp', testSize: 0.2, seed: 42 }, nextSearchSpace: [], why: '继续试 mlp', conclusion: '待定', boundaries: [] };
  const stopAnalysis = { comparison: '最优已确定', continue: false, why: '不再提升', conclusion: '随机森林最优', boundaries: [] };
  const { call } = makeCall({ analyses: [continueAnalysis, stopAnalysis] });
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, experimentTools: tools, verifyExperiments: () => null
  });
  assert.ok(tools.calls.length <= 3, '总运行次数不得超过 maxTrials，实测 ' + tools.calls.length);
  assert.equal(result.experimentFamily.rounds.length, 2, '应跑两轮');
  assert.ok(tools.calls.some(x => x.params.model === 'mlp'), '第二轮应使用分析给出的新基线');
});

test('模型判断不需要实验时：不跑训练，也不调结果分析', async () => {
  const c = makeConfig();
  const run = research.createRun(c);
  const tools = makeTools();
  const { call, seen } = makeCall({ design: designOf({ needed: false, reason: '纯概念问题，没有可测指标' }) });
  const events = [];
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, onChange: e => events.push(e), experimentTools: tools, verifyExperiments: () => null
  });
  assert.equal(tools.calls.length, 0, '不该跑任何训练');
  assert.ok(!seen.stages.includes('experiment-analyze'), '不该调用结果分析');
  assert.equal(result.experimentFamily.skipped, true);
  const check = events.find(e => e.kind === 'research-audit').audit.checks.find(x => x.name === '实验族（按判断跳过）');
  assert.ok(check && check.ok, '应记录为按判断跳过');
});

test('训练失败不中止整轮研究，但自检要如实记为失败', async () => {
  const c = makeConfig();
  const run = research.createRun(c);
  const tools = makeTools({ failOn: ['random_forest'] });
  const { call } = makeCall({ finalText: '结论：仅逻辑回归跑成功。' });
  const events = [];
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, onChange: e => events.push(e), experimentTools: tools, verifyExperiments: () => null
  });
  assert.equal(run.status, 'done', '实验失败不该让整轮研究失败');
  assert.equal(result.experimentFamily.summary.completed, 1);
  assert.equal(result.experimentFamily.summary.failed, 1);
});

test('执行预算不足时停止后续 trial，并把原因说清楚', async () => {
  const c = makeConfig();
  const run = research.createRun(c);
  const tools = makeTools({ budget: { ok: false, reason: '今日执行时长已达上限（7200/7200）' } });
  const { call } = makeCall();
  const events = [];
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, onChange: e => events.push(e), experimentTools: tools, verifyExperiments: () => null
  });
  assert.equal(tools.calls.length, 0, '预算不足时一次都不该跑');
  const notice = events.find(e => e.kind === 'artifact' && /执行预算不足/.test(e.artifact?.text || ''));
  assert.ok(notice, '应发出预算不足的提示');
  assert.equal(run.status, 'done', '预算不足不该让研究失败');
});

test('模型给出的实验方案跑不了时被拦下，不会硬跑', async () => {
  const c = makeConfig();
  const run = research.createRun(c);
  const tools = makeTools();
  const { call } = makeCall({ design: designOf({ template: 'gpt-finetune-from-space' }) });
  const events = [];
  const result = await research.runResearch({
    conversation, config: c, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, onChange: e => events.push(e), experimentTools: tools, verifyExperiments: () => null
  });
  assert.equal(tools.calls.length, 0, '不可执行的方案一次都不该跑');
  assert.match(result.experimentFamily.reason, /模板不可用/);
  const notice = events.find(e => e.kind === 'artifact' && /实验方案无法执行/.test(e.artifact?.text || ''));
  assert.ok(notice, '应说明为什么没跑');
});
