/* 实验并行与心跳的验收。
 *
 * 两个具体收益，各一条断言：
 *   1. 并行：同一批 trial 真的同时开跑，而不是串行排队（wall clock 减半的来源）；
 *   2. 心跳：trial 进行中也在刷新 run.lastActivityAt，单个长实验不再被停滞看门狗误杀。
 *
 * 全部用假模型 + 假执行器，离线、不花钱、可重复。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const research = require('../core/research.cjs');
const profiles = require('../core/profiles.cjs');

const catalog = {
  providers: ['deepseek'],
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high'], defaultEffort: 'high' }]
};
const pick = { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' };
const conversation = { id: 'conv-par', messages: [{ role: 'user', text: '比较两个模型的准确率' }] };

function makeConfig(over = {}) {
  const base = {
    version: 4, profile: 'p1-review', tier: 'readonly',
    choices: {
      scope: pick, evidence: pick, plan: pick, screen: pick, final: pick, audit: null,
      experimentDesign: pick, experimentAnalyze: pick,
      summarize: null, teachingOutline: null, teachingSections: null, teachingExamples: null
    },
    tasks: [{ id: 'task-1', title: '路线', brief: 'b', choice: pick }, { id: 'task-2', title: '机制', brief: 'b', choice: pick }],
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
    experiments: { enabled: true, maxTrials: 4, maxRounds: 1, templateId: null, stopWhen: 'x' }
  };
  return research.validateConfig({ ...base, ...over }, catalog);
}

const design = {
  needed: true, reason: '依赖可测指标', hypothesis: 'A 优于 B', template: 'tabular-baseline',
  metric: 'test.accuracy', direction: 'maximize',
  baseline: { dataset: 'digits', model: 'logreg', testSize: 0.2, seed: 42 },
  /* 三个候选：并发 2 时必然是「2 + 1」两批，才能看出差异。 */
  searchSpace: [{ param: 'model', values: ['random_forest', 'mlp'] }],
  stopWhen: 'x', risks: []
};

const available = [{ id: 'tabular-baseline', name: '表格基线', metrics: ['test.accuracy'], params: [] }];

/** 记录并发峰值与心跳次数的假执行器。 */
function makeTools({ delayMs = 15 } = {}) {
  let running = 0;
  const stats = { maxRunning: 0, activity: 0, order: [] };
  const tools = {
    stats,
    templates: () => available,
    checkBudget: () => ({ ok: true }),
    run: async ({ params, label, onActivity }) => {
      running += 1;
      stats.maxRunning = Math.max(stats.maxRunning, running);
      stats.order.push(params.model);
      /* 模拟执行期事件：每次都要把心跳推到现在。 */
      for (let i = 0; i < 3; i += 1) {
        if (typeof onActivity === 'function') { onActivity(); stats.activity += 1; }
        await new Promise(resolve => setTimeout(resolve, delayMs / 3));
      }
      running -= 1;
      return {
        runId: `run-${params.model}`, label, status: 'done', params,
        startedAt: Date.now() - 1000, finishedAt: Date.now(),
        template: { id: 'tabular-baseline', name: '表格基线' },
        artifacts: [{ name: 'metrics.json', bytes: 10, sha256: 'x' }],
        metrics: { test: { accuracy: params.model === 'mlp' ? 0.95 : 0.9 } }
      };
    }
  };
  return tools;
}

function makeCall() {
  return async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '比较', questions: ['谁更好'], queries: ['digits'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '比较', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }, { id: 'task-2', assignment: 'c', deliverable: 'd', evidenceKeys: [] }], selectionCriteria: '准确率' }));
    if (a.stage === 'research-explore') return a.onText('路线成果');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '都保留', unsupported: [] }));
    if (a.stage === 'experiment-design') return a.onText(JSON.stringify(design));
    if (a.stage === 'experiment-analyze') return a.onText(JSON.stringify({ comparison: 'mlp 最好', continue: false, why: '够了', conclusion: 'mlp 最优', boundaries: [] }));
    if (a.stage === 'research-final') return a.onText('结论：mlp 最优。');
    throw new Error('本测试不该调用阶段：' + a.stage);
  };
}

const emptyKnowledge = () => ({ records: [], all() { return []; }, add() { return { added: [] }; }, noteError() {}, save() {}, stats() { return { total: 0 }; }, digest() { return []; }, toAuditRecords() { return []; } });

async function runWith(experiments) {
  const config = makeConfig({ experiments: { enabled: true, maxRounds: 1, stopWhen: 'x', ...experiments } });
  const run = research.createRun(config);
  const tools = makeTools();
  const events = [];
  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall(), onChange: e => events.push(e),
    experimentTools: tools, experimentRuns: [],
    verifyExperiments: () => null
  });
  return { run, tools, result, events };
}

test('默认并发 2：同一批 trial 真的同时跑，峰值并发等于 2', async () => {
  const { tools, result, run } = await runWith({});
  assert.equal(result.experimentFamily.skipped, false);
  assert.equal(tools.stats.maxRunning, 2, `期望峰值并发 2，实测 ${tools.stats.maxRunning}`);
  assert.equal(tools.stats.order.length, 3, '三个候选都该跑到');
  assert.equal(run.status, 'done');
});

test('并发调到 1 时回到严格串行（排障开关）', async () => {
  const { tools } = await runWith({ concurrency: 1 });
  assert.equal(tools.stats.maxRunning, 1, `期望串行，实测峰值 ${tools.stats.maxRunning}`);
});

test('并发上限被配置夹住：超出 4 也只按 4 算', () => {
  const normalized = profiles.normalizeExperiments({ experiments: { enabled: true, concurrency: 99 } });
  assert.equal(normalized.concurrency, 4);
  assert.equal(profiles.normalizeExperiments({ experiments: { enabled: true, concurrency: 0 } }).concurrency, 1);
  assert.equal(profiles.normalizeExperiments({ experiments: { enabled: true } }).concurrency, 2, '缺省是 2');
});

test('trial 进行中持续刷新心跳，长实验不会被自己的看门狗误杀', async () => {
  const { run, tools } = await runWith({});
  // 每个 trial 至少推 3 次心跳（模拟执行期事件），3 个 trial 合计 ≥ 9 次。
  assert.ok(tools.stats.activity >= 9, `心跳次数太少：${tools.stats.activity}`);
  const finished = run.lastActivityAt;
  assert.ok(typeof finished === 'number' && finished > 0, 'lastActivityAt 必须被写过');
  assert.ok(Date.now() - finished < 5000, '最后一次心跳应发生在最近，而不是停在很早以前');
});

test('并行不改变结果顺序：E 编号仍按设计顺序分配', async () => {
  const { result } = await runWith({});
  const runs = result.experimentFamily.runs;
  assert.deepEqual(runs.map(item => item.params.model), ['logreg', 'random_forest', 'mlp']);
});
