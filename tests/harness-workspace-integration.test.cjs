/* 运行工作区接入科研流程的验收。
 *
 * 验的是三件事：
 *   1. 每个环节的产物真的落了盘，并且 artifact 上带回了 art- 开头的 id；
 *   2. 最终正文以 kind='final' 单独落盘（可交付物与中间材料分开）；
 *   3. 不注入工作区时行为与 0.6 完全一致（旧调用方零影响），落盘失败也不拖垮整轮。
 *
 * 统一用 p1-review 档：它是唯一同时覆盖串行环节、并行探索与最终收口的档位。
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
const conversation = { id: 'conv-ws', messages: [{ role: 'user', text: '策略梯度为什么方差大' }] };

function makeConfig(over = {}) {
  const base = {
    version: 4, profile: 'p1-review', tier: 'readonly',
    choices: {
      scope: pick, evidence: pick, plan: pick, screen: pick, final: pick, audit: null,
      experimentDesign: null, experimentAnalyze: null,
      summarize: null, teachingOutline: null, teachingSections: null, teachingExamples: null
    },
    tasks: [{ id: 'task-1', title: '路线', brief: 'b', choice: pick }],
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
  };
  return research.validateConfig({ ...base, ...over }, catalog);
}

const emptyKnowledge = () => ({ records: [], all() { return []; }, add() { return { added: [] }; }, noteError() {}, save() {}, stats() { return { total: 0 }; }, digest() { return []; }, toAuditRecords() { return []; } });

/** p1 档的最小可跑流程：界定 → 分解 → 探索 → 筛选 → 收口。 */
function makeCall({ finalText = '## 结论\n\n基线只降低方差，不改变期望。' } = {}) {
  return async a => {
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '解释方差来源', questions: ['基线的作用'], queries: ['policy gradient variance'], inclusion: ['同行评议'], exclusion: ['博客'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '解释方差来源', tasks: [{ id: 'task-1', assignment: '推导基线', deliverable: '结论', evidenceKeys: [] }], selectionCriteria: '证据强度' }));
    if (a.stage === 'research-explore') return a.onText('推导结果：基线抵消了与动作无关的项。');
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: '证据充分', unsupported: [] }));
    if (a.stage === 'research-final') return a.onText(finalText);
    throw new Error('本测试不该调用阶段：' + a.stage);
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ws-integration-'));
}

test('注入工作区后：每个环节的产物落盘，artifact 带回 art- id 与 sha256', async () => {
  const config = makeConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: tempRoot(), runId: ids.newRunId(), meta: { conversationId: conversation.id } });

  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall(), workspace,
    verifyExperiments: () => null
  });

  assert.equal(run.status, 'done');
  assert.ok(result.finalText.length > 0);

  const records = workspace.listArtifacts();
  assert.ok(records.length >= 4, `至少四个环节都该落盘，实际 ${records.length} 条`);
  const stages = records.map(record => record.stage);
  for (const stage of ['research-scope', 'research-plan', 'research-explore', 'research-final']) {
    assert.ok(stages.includes(stage), `缺少 ${stage} 的产物`);
  }

  const withIds = run.artifacts.filter(artifact => artifact.artifactId);
  assert.equal(withIds.length, records.length, '每个落盘的产物都要在 artifact 上带回 id');
  for (const artifact of withIds) {
    assert.ok(ids.isArtifactId(artifact.artifactId), `id 格式不对：${artifact.artifactId}`);
    assert.ok(artifact.sha256 && artifact.sha256.length === 64, 'sha256 必须记录，供事后校验');
    assert.ok(fs.existsSync(path.join(workspace.dir, artifact.file)), `文件应存在：${artifact.file}`);
  }

  assert.deepEqual(workspace.verifyArtifacts(), { ok: true, checked: records.length, problems: [] });
});

test('最终正文以 kind=final 单独落盘，与中间材料分开', async () => {
  const config = makeConfig();
  const run = research.createRun(config);
  const workspace = openWorkspace({ root: tempRoot(), runId: ids.newRunId() });

  await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall({ finalText: '最终答案正文。' }), workspace,
    verifyExperiments: () => null
  });

  const finals = workspace.listArtifacts({ kind: 'final' });
  assert.equal(finals.length, 1, '最终正文应恰好落盘一份');
  assert.equal(workspace.readArtifact(finals[0].id).text, '最终答案正文。');
  const notes = workspace.listArtifacts({ kind: 'note' });
  assert.ok(notes.length >= 3, '中间环节作为 note 落盘');
});

test('不注入工作区时行为不变：不落盘，artifact 上没有 file / artifactId 字段', async () => {
  const config = makeConfig();
  const run = research.createRun(config);
  await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall(), verifyExperiments: () => null
  });
  assert.equal(run.status, 'done');
  assert.ok(run.artifacts.every(artifact => artifact.file === undefined));
  assert.ok(run.artifacts.every(artifact => artifact.artifactId === undefined));
});

test('落盘失败不拖垮整轮研究，但会把原因记在 artifact 上', async () => {
  const config = makeConfig();
  const run = research.createRun(config);
  const broken = { writeArtifact() { throw new Error('磁盘满了'); } };
  const result = await research.runResearch({
    conversation, config, run, signal: new AbortController().signal,
    knowledge: emptyKnowledge(), call: makeCall(), workspace: broken, verifyExperiments: () => null
  });
  assert.equal(run.status, 'done', '落盘失败不能让研究失败');
  assert.ok(result.finalText.length > 0, '正文仍应产出');
  assert.ok(run.artifacts.some(artifact => /磁盘满了/.test(artifact.fileError || '')), '失败原因要留下');
});
