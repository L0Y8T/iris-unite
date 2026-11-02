/* 装配预算可配置的验收。
 *
 * 这条的背景是 2026-11-02 的实证：真调 DeepSeek 跑一轮科研，8 项材料共 14448 字符，
 * 而 itemInline 上限是 6000、总预算 120000 —— 一件都没溢出，于是模型没有任何理由
 * 去调 read_artifact，工具循环形同虚设。而预算当时写死在 context.cjs 里，用户调不了。
 *
 * 验四件事：默认行为不变、itemInline 生效、total 生效、非法值被忽略。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const research = require('../core/research.cjs');
const { openWorkspace } = require('../core/harness/workspace.cjs');
const ids = require('../core/harness/ids.cjs');

const catalog = {
  providers: ['deepseek'],
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high'], defaultEffort: 'high' }]
};
const pick = { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' };
const conversation = { id: 'conv-budget', messages: [{ role: 'user', text: '基线为什么降低方差' }] };

function makeConfig(harness) {
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
    experiments: { enabled: false, maxTrials: 4, maxRounds: 2, templateId: null, stopWhen: 'x' },
    ...(harness ? { harness } : {})
  }, catalog);
}

const emptyKnowledge = () => ({ records: [], all() { return []; }, add() { return { added: [] }; }, noteError() {}, save() {}, stats() { return { total: 0 }; }, digest() { return []; }, toAuditRecords() { return []; } });

/* 探索环节吐一段很长的材料：7200 字符，超过默认 itemInline（6000），所以默认就会溢出。
   要验"调大预算后不再溢出"，就把 itemInline 设到 9000。 */
const LONG = '推导：基线抵消了与动作无关的项。' + '长材料标记。'.repeat(1200);

function makeCall(capture) {
  return async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: 'o', questions: ['q'], queries: ['q'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: 'o', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }], selectionCriteria: 'c' }));
    if (a.stage === 'research-explore') return a.onText(LONG);
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') {
      capture.prompt = a.messages.at(-1).content;
      return a.onText('最终答案。');
    }
    throw new Error('不该调用：' + a.stage);
  };
}

async function run(harness) {
  const config = makeConfig(harness);
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-budget-')), runId: ids.newRunId() });
  const capture = { prompt: '' };
  const events = [];
  await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall(capture), workspace,
    onChange: event => events.push(event),
    verifyExperiments: () => null
  });
  return { capture, events, workspace };
}

test('默认预算：7200 字符的材料超过 itemInline 6000，会溢出——这是默认阈值生效的证据', async () => {
  const { capture, events } = await run(null);
  const context = events.find(event => event.kind === 'context');
  assert.ok(context, '应发出 context 事件');
  assert.equal(context.budget, 120000, '默认总预算应是 120000');
  assert.equal(context.spilled, 1, `默认 itemInline=6000，7200 字符的材料应溢出，实得 ${context.spilled}`);
  assert.match(capture.prompt, /read_artifact id=art-[0-9a-f]{8} offset=\d+/, '溢出材料必须带续读句柄');
});

test('把 itemInline 调大后，同一份材料改回全文内联', async () => {
  const { capture, events } = await run({ assemble: { itemInline: 9000 } });
  const context = events.find(event => event.kind === 'context');
  assert.equal(context.spilled, 0, `调到 9000 后不该再溢出，实得 ${context.spilled}`);
  assert.ok(!capture.prompt.includes('read_artifact id='), '不该出现续读句柄');
  assert.ok(capture.prompt.includes('长材料标记。'), '长材料应被内联');
});

test('把 itemInline 调小后，溢出发生得更早', async () => {
  const small = await run({ assemble: { itemInline: 500 } });
  const smallContext = small.events.find(event => event.kind === 'context');
  assert.ok(smallContext.spilled >= 1, `应有材料溢出，实得 ${smallContext.spilled}`);
  assert.match(small.capture.prompt, /read_artifact id=art-[0-9a-f]{8} offset=\d+/);
});

test('把 total 压到极小时触发降级：原本内联的项被转成溢出', async () => {
  const baseline = await run(null);
  const baseContext = baseline.events.find(event => event.kind === 'context');
  const tight = await run({ assemble: { total: 100 } });
  const tightContext = tight.events.find(event => event.kind === 'context');
  assert.ok(tightContext.downgraded >= 1, `应发生降级，实得 down=${tightContext.downgraded}`);
  assert.ok(tightContext.spilled > baseContext.spilled,
    `降级会把内联项转成溢出：${tightContext.spilled} 应大于默认的 ${baseContext.spilled}`);
  assert.ok(tightContext.inlined < baseContext.inlined,
    `内联项应减少：${tightContext.inlined} < ${baseContext.inlined}`);
});

test('非法预算值被忽略，行为与默认一致', async () => {
  const baseline = await run(null);
  const baseSpilled = baseline.events.find(event => event.kind === 'context').spilled;
  for (const bad of [{ itemInline: -5 }, { itemInline: 0 }, { itemInline: '很多' }, { total: null }]) {
    const { events } = await run({ assemble: bad });
    const context = events.find(event => event.kind === 'context');
    assert.equal(context.spilled, baseSpilled, `${JSON.stringify(bad)} 应被忽略（默认 ${baseSpilled}），实得 ${context.spilled}`);
    assert.equal(context.budget, 120000, `${JSON.stringify(bad)} 不该改变总预算`);
  }
});

test('头部加尾部超过单项上限时收敛，不让溢出项比内联项还长', async () => {
  const { events } = await run({ assemble: { itemInline: 1000, itemHead: 900, itemTail: 400 } });
  const context = events.find(event => event.kind === 'context');
  assert.ok(context.spilled >= 1);
  /* 收敛后单项占用不会超过 itemInline，所以总字数应远小于「原样 900+400」。 */
  assert.ok(context.chars < 1000 * 8, `装配结果应被收敛，实得 ${context.chars}`);
});
