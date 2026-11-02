/* 收口环节接入 agent 循环的验收。
 *
 * 这是 1.0 与 0.6 的分界线：收口不再"把全部材料 JSON.stringify 进 prompt"，
 * 而是装配成【任务】+【材料】，长材料只给首尾和续读句柄，模型用 read_artifact 自己取。
 *
 * 验四件事：
 *   1. 收口收到的确实是装配文本，不是全量 JSON；
 *   2. 模型调工具能真的读到前序环节落盘的产物；
 *   3. 工具的 JSON 不会漏进最终正文；
 *   4. 最终正文照旧落盘、照旧进入 finalText。
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
const conversation = { id: 'conv-tools', messages: [{ role: 'user', text: '基线为什么降低方差' }] };

function makeConfig() {
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

/* 故意写超过装配层的单项内联上限（6000 字），用来验证溢出与续读句柄。 */
const EXPLORE_TEXT = '推导结果：基线抵消了与动作无关的项，因此方差下降但期望不变。这是一段故意写长的材料，用来触发装配层的溢出逻辑。' + '补充论证。'.repeat(1500);

test('收口环节走装配 + 工具循环：材料是装配文本，工具能读到前序产物', async () => {
  const config = makeConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-final-')), runId: ids.newRunId() });

  const finalTurns = [];
  const events = [];
  const call = async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '解释方差', questions: ['基线作用'], queries: ['pg variance'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '解释方差', tasks: [{ id: 'task-1', assignment: '推导', deliverable: '结论', evidenceKeys: [] }], selectionCriteria: '证据' }));
    if (a.stage === 'research-explore') return a.onText(EXPLORE_TEXT);
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') {
      const last = a.messages.at(-1).content;
      finalTurns.push(last);
      if (finalTurns.length === 1) {
        /* 第一轮：模型先要材料清单。 */
        return a.onText('先看看有哪些材料。\n```tool\n{"calls":[{"name":"list_artifacts","args":{}}]}\n```');
      }
      /* 第二轮：拿清单后直接收口。 */
      return a.onText('## 结论\n\n基线只降低方差，不改变期望。');
    }
    throw new Error('本测试不该调用阶段：' + a.stage);
  };

  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, workspace, onChange: event => events.push(event),
    verifyExperiments: () => null
  });

  /* 1. 收口收到的是装配文本，不是全量 JSON。 */
  assert.match(finalTurns[0], /【任务】/, '必须有任务段');
  assert.match(finalTurns[0], /【材料】/, '必须有材料段');
  assert.match(finalTurns[0], /【工具协议】/, '必须带工具协议说明');
  assert.ok(!finalTurns[0].includes('"explorations"'), '不应再把材料整份 JSON.stringify 进 prompt');

  /* 2. 长材料被溢出，并给出可照抄的续读句柄。 */
  assert.match(finalTurns[0], /read_artifact id=art-[0-9a-f]{8} offset=\d+/, '溢出材料必须带续读句柄');
  assert.ok(!finalTurns[0].includes(EXPLORE_TEXT), '长材料不该整段灌进上下文');

  /* 3. 工具结果回灌到第二轮。 */
  assert.match(finalTurns[1], /【工具结果】/);
  assert.match(finalTurns[1], /list_artifacts/);

  /* 4. 最终答案干净：没有 tool 块，也没有被 JSON 污染。 */
  assert.match(result.finalText, /基线只降低方差/);
  assert.ok(!result.finalText.includes('```tool'), '最终正文里不能残留工具块');

  const finalArtifact = run.artifacts.find(artifact => artifact.kind === 'final');
  assert.ok(finalArtifact, '应有一条 final 产物');
  assert.ok(finalArtifact.toolCalls >= 1, '应记录工具调用次数');
  assert.equal(finalArtifact.stopReason, 'final');
  assert.ok(events.some(event => event.kind === 'context'), '应发出上下文装配摘要事件');
  assert.ok(events.some(event => event.kind === 'tool'), '应发出工具调用事件');

  const finals = workspace.listArtifacts({ kind: 'final' });
  assert.equal(finals.length, 1, '最终正文应落盘');
  assert.match(workspace.readArtifact(finals[0].id).text, /基线只降低方差/);
});

test('模型不调工具时，收口就是一次普通调用，正文照常流式产出', async () => {  const config = makeConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-final2-')), runId: ids.newRunId() });
  const streamed = [];

  const call = async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: 'o', questions: ['q'], queries: ['q'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: 'o', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }], selectionCriteria: 'c' }));
    if (a.stage === 'research-explore') return a.onText('探索');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') return a.onText('直接给答案，不查工具。');
    throw new Error('不该调用：' + a.stage);
  };

  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, workspace, onFinal: chunk => streamed.push(chunk),
    verifyExperiments: () => null
  });

  assert.equal(result.finalText, '直接给答案，不查工具。');
  assert.ok(streamed.join('').includes('直接给答案'), 'onFinal 应逐字收到正文');
  const finalArtifact = run.artifacts.find(artifact => artifact.kind === 'final');
  assert.equal(finalArtifact.toolCalls, 0);
  assert.equal(finalArtifact.stopReason, 'final');
});

test('关闭 harness.tools 时退回 0.6 的全量 JSON 路径', async () => {
  const base = makeConfig();
  const config = research.validateConfig({ ...base, harness: { tools: false } }, catalog);
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-final3-')), runId: ids.newRunId() });
  let finalPayload = '';

  const call = async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: 'o', questions: ['q'], queries: ['q'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: 'o', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }], selectionCriteria: 'c' }));
    if (a.stage === 'research-explore') return a.onText('探索');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') { finalPayload = a.messages.at(-1).content; return a.onText('老路径答案。'); }
    throw new Error('不该调用：' + a.stage);
  };

  await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, workspace, verifyExperiments: () => null
  });

  assert.match(finalPayload, /协作资料（JSON 数据/, '关闭后应回到 0.6 的 JSON 材料格式');
  assert.ok(!finalPayload.includes('【工具协议】'), '关闭后不该出现工具协议');
});

test('收口循环的每一步都进账本：工具调用与收尾都留痕', async () => {
  /* 这条守的是一个真实缺陷：2026-11-02 的 1.0 里，requestWithTools 没有把账本
     传给 runAgentLoop，于是工具往返与收尾全都不留痕——事后查账本会得出
     "工具从未被调用"的错误结论。 */
  const config = makeConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'iris-final4-')), runId: ids.newRunId() });

  const call = async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: 'o', questions: ['q'], queries: ['q'], inclusion: ['x'], exclusion: ['y'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: 'o', tasks: [{ id: 'task-1', assignment: 'a', deliverable: 'b', evidenceKeys: [] }], selectionCriteria: 'c' }));
    if (a.stage === 'research-explore') return a.onText('探索');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: 'ok', unsupported: [] }));
    if (a.stage === 'research-final') {
      const already = a.messages.some(message => String(message.content).includes('【工具结果】'));
      if (!already) return a.onText('先看看有什么。\n```tool\n{"calls":[{"name":"list_artifacts","args":{}}]}\n```');
      return a.onText('按材料给答案。');
    }
    throw new Error('不该调用：' + a.stage);
  };

  await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call, workspace, verifyExperiments: () => null
  });

  const types = workspace.ledger.read().entries.map(entry => entry.type);
  assert.ok(types.includes('tool.call'), `账本里必须有 tool.call，实际只有 ${types.join('、')}`);
  assert.ok(types.includes('loop.final'), `账本里必须有 loop.final，实际只有 ${types.join('、')}`);

  const toolEntry = workspace.ledger.read().entries.find(entry => entry.type === 'tool.call');
  assert.equal(toolEntry.name, 'list_artifacts');
  assert.equal(toolEntry.ok, true);
  assert.equal(toolEntry.stage, 'research-final');
  assert.ok(toolEntry.runId, '账本条目要带 runId');
});
