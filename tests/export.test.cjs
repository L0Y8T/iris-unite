/* 一键导出的验收：导出的正文必须自己站得住。
 *
 * 这一层盯三件事：
 * 1. 有记录就导出，没记录就整段省略——不用占位文字凑版式。
 * 2. 实验数字与运行编号必须来自运行记录，编号顺序与答案里的 [E1] 一致。
 * 3. 不把 API Key 与本机绝对路径写进导出文件。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const exporter = require('../core/export.cjs');

const FINAL = '在 digits 数据集上，训练样本上限放在 12000 时测试准确率为 0.9806 [E3]，继续放大收益很小。';

function manifest(over = {}) {
  return {
    version: 1,
    runId: 'run-a',
    conversationId: 'conv-1',
    label: 'tabular-baseline#1',
    template: { id: 'tabular-baseline', version: 1, name: '表格基线' },
    params: { dataset: 'digits', model: 'logreg', testSize: 0.2, seed: 42 },
    env: { pythonVersion: '3.12.8', numpyVersion: '1.26.4', device: 'cpu', pythonPath: 'C:\\Users\\me\\AppData\\Local\\python.exe', apiKey: 'sk-should-never-appear' },
    status: 'done',
    startedAt: 1000,
    finishedAt: 61000,
    exitCode: 0,
    metrics: { test: { accuracy: 0.97 }, train: { accuracy: 0.99 }, params: { seed: 42 } },
    artifacts: [{ name: 'metrics.json', bytes: 210, sha256: 'f'.repeat(64) }],
    logs: { stdout: [], stderr: [], truncated: false },
    error: null,
    ...over
  };
}

function run(over = {}) {
  return {
    version: 4,
    mode: 'research',
    status: 'done',
    profile: 'p1-review',
    profileName: '综述',
    tier: 'P1',
    planVersion: 'abc123',
    policyVersion: '4',
    startedAt: 1000,
    finishedAt: 200000,
    callsUsed: 11,
    callBudget: 16,
    stages: [{ id: 'research-scope', label: '研究界定', kind: 'model', phase: '检索' }],
    participants: [{ role: '最终整合', provider: 'deepseek', model: 'deepseek-chat', effort: 'high' }],
    scope: { objective: '验证样本量对准确率的影响', questions: ['样本上限与准确率关系'], queries: ['digits sample size accuracy'], inclusion: ['公开数据集'], exclusion: ['未公开数据'] },
    knowledge: { total: 72, withDoi: 40, withAbstract: 30, bySource: { arxiv: 50, crossref: 22 }, queries: ['digits sample size'], yearRange: [2011, 2024], errors: [] },
    plan: { objective: '给出可复现结论', tasks: [{ id: 'T1', assignment: '整理样本量证据', deliverable: '表格', evidenceKeys: ['S3'] }], selectionCriteria: '证据强度优先' },
    selection: { selectedIds: ['T1'], refineIds: [], reason: '证据充足', feedback: '', unsupported: [], deviations: [] },
    evidence: { claims: [{ claim: '样本上限提高后准确率趋平', keys: ['S3'], strength: '中', limitation: '仅 digits' }], gaps: ['缺少跨数据集复现'] },
    integrity: { ran: true, ok: true, librarySize: 72, counts: { total: 4, resolved: 4, unresolved: 0, removed: 0 }, unresolved: [] },
    experiments: { ran: true, ok: true, markers: { resolved: ['E3'], unresolved: [] }, numbers: { bound: [0.980556], unsourced: [] } },
    audit: { verdict: 'pass', checks: [{ name: '引用全部可核验', ok: true, detail: '未核验 0 处' }], review: { verdict: 'pass', fabrications: [], unsupported: [], fixes: [] } },
    artifacts: [
      { id: 'a1', stage: 'research-evidence', stageLabel: '证据提取', kind: 'public-work', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: '{"claims":[]}', startedAt: 1000, finishedAt: 8000 },
      { id: 'a2', stage: 'experiment-analyze', stageLabel: '结果分析', kind: 'public-work', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: '样本上限 12000 已进入平台期，继续加样本收益 < 0.002。', startedAt: 9000, finishedAt: 12000 },
      { id: 'a3', stage: 'research-final', stageLabel: '反证与整合', kind: 'final', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: FINAL, startedAt: 13000, finishedAt: 40000 }
    ],
    experimentFamily: {
      skipped: false,
      design: { template: 'tabular-baseline', metric: 'test.accuracy', direction: 'maximize', hypothesis: '样本上限越高准确率越高', baseline: { dataset: 'digits', model: 'logreg' }, searchSpace: { limitTrain: [12000, 24000] }, stopWhen: '主指标不再提升', reasoning: '模板能直接产出指标' },
      summary: { total: 3, completed: 3, best: { label: 'tabular-baseline#3', metric: 'test.accuracy', value: 0.980556 } },
      runs: [],
      rounds: []
    },
    experimentRuns: [
      { runId: 'run-c', label: 'tabular-baseline#3', status: 'done' },
      { runId: 'run-a', label: 'tabular-baseline#1', status: 'done' },
      { runId: 'run-b', label: 'tabular-baseline#2', status: 'failed' }
    ],
    ...over
  };
}

function conversation(over = {}) {
  return { id: 'conv-1', title: '样本量对准确率的影响', createdAt: 500, models: ['deepseek', 'gpt'], ...over };
}

function message(over = {}) {
  return { id: 'msg-1', role: 'assistant', kind: 'answer', provider: 'deepseek', text: FINAL, roundId: 'round-1', timestamp: 200000, collaboration: run(), ...over };
}

const manifests = [
  manifest({ runId: 'run-c', label: 'tabular-baseline#3', startedAt: 2000, finishedAt: 62000, metrics: { test: { accuracy: 0.980556 }, train: { accuracy: 0.994 }, params: { limitTrain: 12000 } } }),
  manifest({ runId: 'run-a', label: 'tabular-baseline#1', startedAt: 1000, finishedAt: 61000, metrics: { test: { accuracy: 0.96 } } }),
  manifest({ runId: 'run-b', label: 'tabular-baseline#2', startedAt: 3000, finishedAt: 31000, status: 'failed', exitCode: 1, error: '训练超时', metrics: null, artifacts: [] })
];

test('一轮完整科研会导出结论、核验、实验与复现信息', () => {
  const text = exporter.researchReport({ conversation: conversation(), message: message(), manifests });
  for (const heading of ['# 样本量对准确率的影响', '## 结论', '## 核验', '### 文献引用', '### 实验数字', '## 实验运行', '## 研究界定', '## 证据提取', '## 资料库', '## 任务分解', '## 候选人筛选'.replace('候选人筛选', '候选筛选与深化'), '## 终审自检', '## 阶段产出记录', '## 复现信息', '## 本轮模型分配', '## 元数据']) {
    assert.ok(text.includes(heading), `缺少段落：${heading}`);
  }
  assert.ok(text.includes(FINAL), '结论正文缺失');
  assert.ok(text.includes('共 72 条记录'), '资料库统计缺失');
  assert.ok(text.includes('样本上限 12000 已进入平台期'), '结果分析缺失');
  assert.ok(text.includes('最优 test.accuracy = 0.980556'), '最优指标缺失');
});

test('运行编号与核验端一致：只给成功运行，按开始时间排', () => {
  const text = exporter.researchReport({ conversation: conversation(), message: message(), manifests });
  assert.match(text, /\| E1 \| tabular-baseline#1 \| done \| test\.accuracy=0\.96 \|/);
  assert.match(text, /\| E2 \| tabular-baseline#3 \| done \| test\.accuracy=0\.980556 \|/);
  /* 失败的那条不占编号，避免和答案里的 [E3] 混淆 */
  const failed = text.split('\n').find(item => item.includes('tabular-baseline#2'));
  assert.ok(failed.includes('未编号'), '失败尝试应标为未编号');
  assert.ok(failed.includes('failed'), '失败状态丢失');
  assert.ok(!failed.includes('accuracy'), '失败运行不该出现指标列');
  assert.ok(text.includes('训练超时'), '失败原因丢失');
});

test('manifest 顺序被打乱也不影响编号', () => {
  const swapped = [manifests[2], manifests[0], manifests[1]];
  const text = exporter.researchReport({ conversation: conversation(), message: message(), manifests: swapped });
  assert.match(text, /\| E1 \| tabular-baseline#1 \| done \|/);
  assert.match(text, /\| E2 \| tabular-baseline#3 \| done \|/);
});

test('导出不含 API Key 与本机绝对路径', () => {
  const text = exporter.researchReport({ conversation: conversation(), message: message(), manifests });
  assert.ok(!text.includes('sk-should-never-appear'), 'API Key 泄漏');
  assert.ok(!/[A-Za-z]:\\Users\\/.test(text), '本机绝对路径泄漏');
  assert.ok(!text.includes('pythonPath'), '路径类环境字段泄漏');
  assert.ok(text.includes('pythonVersion'), '正常的版本字段不该被一并删掉');
});

test('缺记录的段落整段省略，不写占位结论', () => {
  const bare = run({ scope: null, knowledge: null, evidence: null, plan: null, selection: null, audit: null, artifacts: [], integrity: null, experiments: null, experimentFamily: null, experimentRuns: [] });
  const text = exporter.researchReport({ conversation: conversation(), message: message({ collaboration: bare }), manifests: [] });
  for (const missing of ['## 核验', '## 实验运行', '## 研究界定', '## 资料库', '## 任务分解', '## 终审自检', '## 复现信息']) {
    assert.ok(!text.includes(missing), `没有记录却出现了段落：${missing}`);
  }
  assert.ok(text.includes('## 结论'), '结论必须保留');
});

test('跳过的实验写明理由，不伪装成跑过', () => {
  const skipped = run({ experimentRuns: [], experiments: { ran: false, ok: false, note: '本轮未跑实验' }, experimentFamily: { skipped: true, reason: '纯文献综述，无需实验', runs: [], rounds: [] } });
  const text = exporter.researchReport({ conversation: conversation(), message: message({ collaboration: skipped }), manifests: [] });
  assert.ok(text.includes('本轮按判断跳过实验：纯文献综述，无需实验'));
  assert.ok(!text.includes('| E1 |'), '跳过的实验不该出现运行行');
});

test('未完成的一轮也要导出，并写明状态', () => {
  const partial = run({ status: 'error', error: '证据提取未返回有效结构' });
  const text = exporter.researchReport({ conversation: conversation(), message: message({ collaboration: partial }), manifests });
  assert.ok(text.includes('本轮状态为「error」'), '缺少状态说明');
  assert.ok(text.includes('证据提取未返回有效结构'), '缺少失败原因');
});

test('资料库明细随导出携带，并标注截断', () => {
  const records = [
    { key: 'S1', source: 'arxiv', year: 2023, title: 'Sample size effects | revisited', authors: 'A 等', venue: 'arXiv', doi: '10.1/x' },
    { key: 'S2', source: 'crossref', year: 2011, title: 'Deep learning', authors: 'B 等', venue: 'Nature' }
  ];
  const text = exporter.researchReport({ conversation: conversation(), message: message(), manifests, records });
  assert.ok(text.includes('| S1 | arxiv | 2023 |'), '资料库首条缺失');
  assert.ok(text.includes('Sample size effects \\| revisited'), '竖线未转义');
  assert.ok(text.includes('| S2 | crossref | 2011 |'), '资料库次条缺失');
});

test('普通对话导出保持可读分段', () => {
  const text = exporter.conversationMarkdown({ title: '问答', messages: [{ role: 'user', text: '问题' }, { role: 'assistant', kind: 'answer', text: '答案' }] });
  assert.ok(text.startsWith('# 问答'));
  assert.ok(text.includes('## 你') && text.includes('## 完整答案'));
});

test('文件名清掉非法字符并带时间戳', () => {
  const name = exporter.suggestFileName({ conversation: { title: 'A/B: 测试?<x>' }, message: { collaboration: { mode: 'research' } }, now: new Date(2026, 9, 19, 8, 5).getTime() });
  assert.equal(name, '科研结果-A_B_ 测试__x_-20261019-0805.md');
});

test('答案正文的标题被压低两级，不打乱导出结构', () => {
  const body = ['## 1. 直接比较', '### 1.1 细节', '```', '## 这是代码注释', '```', '## 2. 结论'].join('\n');
  const text = exporter.researchReport({ conversation: conversation(), message: message({ text: body }), manifests: [] });
  assert.ok(text.includes('#### 1. 直接比较'), '正文 H2 应降为 H4');
  assert.ok(text.includes('##### 1.1 细节'), '正文 H3 应降为 H5');
  assert.ok(text.includes('\n## 这是代码注释'), '代码块里的 # 不能动');
  assert.ok(text.includes('\n## 结论\n'), '导出自己的章节层级不变');
});

test('表格转义：竖线与换行不会撑破表格', () => {
  const rows = exporter.table(['列'], [['a|b\nc']]);
  assert.ok(rows.includes('a\\|b c'));
  assert.equal(rows.split('\n').length, 3);
});
