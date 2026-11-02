const test = require('node:test');
const assert = require('node:assert/strict');
const { defineGate, runGates, DEFAULT_GATES, GATE_FAILED } = require('../core/harness/gates.cjs');
const research = require('../core/research.cjs');

/* ── 门禁本身是纯函数，先单独测 ─────────────────────────────────────────── */

const run = (stage, payload) => runGates(DEFAULT_GATES, { stage, payload });
const failedIds = result => result.results.filter(item => !item.ok).map(item => item.id);

test('defineGate 拒绝缺 stage、空 checks 与重复的检查 id', () => {
  assert.throws(() => defineGate({ checks: [{ id: 'a', message: 'm', test: () => true }] }), /stage/);
  assert.throws(() => defineGate({ stage: 'research-scope', checks: [] }), /至少要有一条检查/);
  assert.throws(() => defineGate({ stage: 'research-scope', checks: [{ id: 'a', test: () => true }, { id: 'a', test: () => true }] }), /重复/);
  assert.throws(() => defineGate({ stage: 'research-scope', checks: [{ id: 'a', message: 'm' }] }), /test 函数/);
});

test('runGates 只跑对应环节的门禁，其它环节的门禁不参与判定', () => {
  const gates = [
    defineGate({ stage: 'research-scope', checks: [{ id: 'always-fail', message: '必失败', test: () => false }] }),
    defineGate({ stage: 'research-final', checks: [{ id: 'always-pass', message: '必通过', test: () => true }] })
  ];
  const other = runGates(gates, { stage: 'research-final', payload: {} });
  assert.equal(other.ok, true);
  assert.deepEqual(other.results.map(item => item.id), ['always-pass']);
  const hit = runGates(gates, { stage: 'research-scope', payload: {} });
  assert.equal(hit.ok, false);
  assert.deepEqual(failedIds(hit), ['always-fail']);
});

test('检查不返回 true 或自身抛错时一律不放行（写坏的检查不能静默通过）', () => {
  const gates = [
    defineGate({ stage: 'x', checks: [
      { id: 'returns-undefined', message: '没写返回值', test: () => undefined },
      { id: 'throws', message: '检查内部出错', test: () => { throw new Error('boom'); } }
    ] })
  ];
  const result = runGates(gates, { stage: 'x', payload: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['returns-undefined', 'throws']);
  assert.match(result.results[1].detail, /boom/);
});

test('没给 stage 视为调用方写错，按不通过处理而不是悄悄放行', () => {
  const result = runGates(DEFAULT_GATES, { payload: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['stage']);
});

/* ── 四条 rubric：各一条正例 + 一条反例 ─────────────────────────────────── */

test('research-scope 正例：有非空 objective 与非空 questions 数组', () => {
  const result = run('research-scope', { objective: '研究注意力机制的可解释性', questions: ['它可解释吗', '如何度量'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => item.id), ['objective', 'questions']);
});

test('research-scope 反例：objective 为空、questions 为空数组都要拦下', () => {
  const blank = run('research-scope', { objective: '', questions: ['问题'] });
  assert.equal(blank.ok, false);
  assert.deepEqual(failedIds(blank), ['objective']);

  const noQuestions = run('research-scope', { objective: '目标', questions: [] });
  assert.equal(noQuestions.ok, false);
  assert.deepEqual(failedIds(noQuestions), ['questions']);
  assert.match(noQuestions.results.find(item => item.id === 'questions').detail, /长度/);

  // questions 写成字符串而不是数组也拦：下游按数组遍历，字符串会被当成长度
  const wrongType = run('research-scope', { objective: '目标', questions: '只有一个问题' });
  assert.equal(wrongType.ok, false);
  assert.deepEqual(failedIds(wrongType), ['questions']);
});

test('research-evidence 正例：claims 非空且每条都带 text 或 key', () => {
  const result = run('research-evidence', {
    claims: [
      { claim: '注意力权重与解释一致', keys: ['S1'], strength: '中', limitation: '单篇' },
      { text: '复现实验支持该结论', key: 'S2' }
    ]
  });
  assert.equal(result.ok, true);
});

test('research-evidence 反例：claims 为空、或某条既无 text 又无 key 都要拦下', () => {
  const empty = run('research-evidence', { claims: [] });
  assert.equal(empty.ok, false);
  assert.deepEqual(failedIds(empty), ['claims']);

  const hollow = run('research-evidence', { claims: [{ claim: '有结论' }, { keys: [] }] });
  assert.equal(hollow.ok, false);
  assert.deepEqual(failedIds(hollow), ['claim-shape']);
  assert.match(hollow.results.find(item => item.id === 'claim-shape').detail, /第 2 条/);
});

test('research-final 正例：正文没有渲染残留', () => {
  const result = run('research-final', { text: '唯一科研答案 [S1,S2]，数字 0.973 指回 [E1]。' });
  assert.equal(result.ok, true);
});

test('research-final 反例：undefined、[object Object]、NaN 三者任一出现都要拦下', () => {
  for (const token of ['undefined', '[object Object]', 'NaN']) {
    const result = run('research-final', { text: `结论：注意力机制${token}优于基线。` });
    assert.equal(result.ok, false, token + ' 应被拦下');
    assert.deepEqual(failedIds(result), ['no-placeholders']);
    assert.match(result.results[0].detail, new RegExp(token.replace(/[[\]]/g, '\\$&')));
  }
});

const manifests = [
  { runId: 'r1', status: 'done', metrics: { test: { accuracy: 0.973, loss: 0.21 } }, params: { epochs: 3, lr: 0.001 } },
  { runId: 'r2', status: 'done', metrics: { test: { accuracy: 0.951 } }, params: { epochs: 3 } }
];

test('experiment-analyze 正例：结论里的数字能在本轮 manifest 里找到（含百分数写法）', () => {
  const result = run('experiment-analyze', { conclusion: '准确率 0.973 高于基线 0.951，轮数 3 已够', manifests });
  assert.equal(result.ok, true);
  const percent = run('experiment-analyze', { conclusion: '本次准确率达到 97.3%', manifests });
  assert.equal(percent.ok, true, '97.3% 应能对上 0.973 的指标');
});

test('experiment-analyze 反例：找不到出处的数字要拦下；没给 conclusion 则放行', () => {
  const bad = run('experiment-analyze', { conclusion: '准确率 0.988，明显好于基线', manifests });
  assert.equal(bad.ok, false);
  assert.deepEqual(failedIds(bad), ['conclusion-numbers']);
  assert.match(bad.results[0].detail, /0\.988/);

  const noEvidence = run('experiment-analyze', { conclusion: '本轮准确率 0.988', manifests: [] });
  assert.equal(noEvidence.ok, false, '没有运行记录时数字全部无出处');

  const noConclusion = run('experiment-analyze', { conclusion: '', manifests });
  assert.equal(noConclusion.ok, true, '没给结论就没有数字约束');
});

/* ── 接进科研流程之后的集成行为 ─────────────────────────────────────────── */

const extra = 'model_11111111-1111-4111-8111-111111111111';
const catalog = {
  providers: ['deepseek', 'gpt', extra],
  defaultGptModel: 'gpt-6.1-sol',
  gpt: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  [extra]: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'default' }]
};
const conversation = { id: 'conv-gate', messages: [{ role: 'user', text: '研究问题' }] };

/** 关掉检索的最短流程：scope → plan → explore → screen → final，正好不碰网络与实验。 */
function config(harness) {
  const base = research.defaults(catalog);
  return research.validateConfig({
    ...base,
    retrieval: { ...base.retrieval, enabled: false },
    allowRefinement: false,
    ...(harness ? { harness } : {})
  }, catalog);
}

/** 正常的假模型；可通过 overrides 注入某个环节的坏产出。 */
function fakeCall(c, overrides = {}) {
  return async a => {
    if (overrides[a.stage] !== undefined) return a.onText(overrides[a.stage]);
    if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '目标', questions: ['问题'], queries: ['q'], inclusion: ['a'], exclusion: ['b'] }));
    if (a.stage === 'research-plan') return a.onText(JSON.stringify({ objective: '目标', tasks: c.tasks.map(t => ({ id: t.id, assignment: t.brief, deliverable: '成果', evidenceKeys: [] })), selectionCriteria: '准则' }));
    if (a.stage === 'research-screen') return a.onText(JSON.stringify({ selectedIds: c.tasks.map(t => t.id), refineIds: [], feedback: '', reason: '理由', unsupported: [] }));
    if (a.stage === 'research-explore') return a.onText('成果');
    a.onText('最终答案');
  };
}

async function runWith({ harness, overrides, workspace }) {
  const c = config(harness);
  const instance = research.createRun(c);
  const events = [];
  const promise = research.runResearch({
    conversation, config: c, run: instance, signal: new AbortController().signal,
    onChange: e => events.push(e),
    workspace: workspace || null,
    call: fakeCall(c, overrides)
  });
  return { c, run: instance, events, promise };
}

test('集成：开启 harness.gates 后，research-scope 交出空 questions 会在推进前中断本轮', async () => {
  const { run: instance, events, promise } = await runWith({
    harness: { gates: true },
    overrides: { 'research-scope': JSON.stringify({ objective: '目标', questions: [], queries: ['q'], inclusion: ['a'], exclusion: ['b'] }) }
  });
  await assert.rejects(promise, /阶段准入未通过（research-scope）/);
  assert.equal(instance.status, 'error');
  const gateEvent = events.find(e => e.kind === 'gate');
  assert.ok(gateEvent, '必须发出 gate 事件');
  assert.equal(gateEvent.stage, 'research-scope');
  assert.equal(gateEvent.ok, false);
  assert.deepEqual(gateEvent.failures.map(f => f.id), ['questions']);
  // 坏产出之后的下游环节一个都不该跑
  assert.ok(!events.some(e => e.kind === 'stage' && e.stage.stage === 'research-plan'), '中断后不应推进到下一环节');
  // 账本里留了这条准入
  assert.equal(instance.gates.length, 1);
  assert.equal(instance.gates[0].ok, false);
});

test('集成：research-final 正文带 undefined 时，核验前就被拦下', async () => {
  const { run: instance, events, promise } = await runWith({
    harness: { gates: true },
    overrides: { 'research-final': '答案里混进了 undefined 这个值 [S1]。' }
  });
  await assert.rejects(promise, /阶段准入未通过（research-final）/);
  assert.equal(instance.status, 'error');
  const gateEvent = events.find(e => e.kind === 'gate');
  assert.equal(gateEvent.stage, 'research-final');
  assert.deepEqual(gateEvent.failures.map(f => f.id), ['no-placeholders']);
  assert.ok(!events.some(e => e.kind === 'integrity'), '准入失败不应走到引用核验');
});

test('集成：默认关闭——没开 harness.gates 时同样的坏产出照旧跑完（既有行为零影响）', async () => {
  const { run: instance, events, promise } = await runWith({
    overrides: { 'research-scope': JSON.stringify({ objective: '目标', questions: [], queries: ['q'], inclusion: ['a'], exclusion: ['b'] }) }
  });
  await promise;
  assert.equal(instance.status, 'done');
  assert.ok(!events.some(e => e.kind === 'gate'));
  assert.equal(instance.gates, undefined, '关闭时不该写任何门禁记录');
});

test('集成：全部通过时只记账不打扰——不发 gate 事件，但记账本里有 gate.check', async () => {
  const ledger = [];
  const workspace = { appendLedger: (type, fields) => { ledger.push({ type, fields }); return null; } };
  const { run: instance, events, promise } = await runWith({ harness: { gates: true, tools: false }, workspace });
  await promise;
  assert.equal(instance.status, 'done');
  assert.ok(!events.some(e => e.kind === 'gate'), '通过时不发事件');
  const passed = instance.gates.filter(item => item.ok).map(item => item.stage);
  assert.deepEqual(passed.sort(), ['research-final', 'research-scope'], '范围与收口两个环节都应留下通过记录');
  const entries = ledger.filter(item => item.type === 'gate.check');
  assert.deepEqual(entries.map(item => item.fields.stage).sort(), ['research-final', 'research-scope']);
  assert.ok(entries.every(item => item.fields.ok === true));
});

test('集成：research-evidence 交出空 claims 时，证据环节之后就不许继续', async () => {
  /* 默认档只开检索不开证据？这里显式把证据环节打开：retrieval 关掉不影响计划，但证据节点
     需要资料库；用空检索式的最小路径不稳定，所以直接构造"有证据环节"的配置。 */
  const base = research.defaults(catalog);
  const c = research.validateConfig({ ...base, allowRefinement: false, harness: { gates: true } }, catalog);
  const instance = research.createRun(c);
  const events = [];
  const knowledge = {
    records: [{ key: 'S1', id: 'openalex:W1', source: 'openalex', title: '标题', authors: ['A'], year: 2021, venue: 'V', doi: null, url: 'https://example.org', abstract: '摘要' }],
    all() { return this.records; },
    add() { return { added: [], duplicates: [], total: this.records.length }; },
    noteError() {}, save() { return true; },
    stats() { return { total: this.records.length, withDoi: 0, bySource: {}, queries: [], yearFrom: null, errors: [] }; },
    digest({ limit = 40 } = {}) { return this.records.slice(0, limit); },
    toAuditRecords() { return this.records.map(r => ({ key: r.key, ...r })); }
  };
  const promise = research.runResearch({
    conversation, config: c, run: instance, signal: new AbortController().signal,
    knowledge,
    retrieve: async ({ query }) => ({ records: [], errors: [], query }),
    onChange: e => events.push(e),
    call: async a => {
      if (a.stage === 'research-scope') return a.onText(JSON.stringify({ objective: '目标', questions: ['问题'], queries: ['q'], inclusion: ['a'], exclusion: ['b'] }));
      if (a.stage === 'research-evidence') return a.onText(JSON.stringify({ claims: [], gaps: [] }));
      a.onText('不该走到这里');
    }
  });
  await assert.rejects(promise, /阶段准入未通过（research-evidence）/);
  const gateEvent = events.find(e => e.kind === 'gate');
  assert.equal(gateEvent.stage, 'research-evidence');
  assert.deepEqual(gateEvent.failures.map(f => f.id), ['claims']);
  assert.ok(!events.some(e => e.kind === 'stage' && e.stage.stage === 'research-plan'));
  assert.ok(gateEvent.failures.every(f => f.message));
});
