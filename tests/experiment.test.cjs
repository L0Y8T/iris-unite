/* 实验族纯逻辑验收：规格展开、trial 规划、最优判断、汇总。
 *
 * 这一层的价值在于「模型说什么不算数」：
 * 模板、参数、指标都要过本地校验，越界组合被丢弃并留下原因。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const exp = require('../core/experiment.cjs');
const templates = require('../core/exec/templates.cjs');

const available = templates.TEMPLATES
  .filter(t => !t.unimplemented)
  .map(t => ({ id: t.id, name: t.name, metrics: t.metrics, params: t.params }));

const design = over => ({
  needed: true,
  reason: '需要真实指标',
  hypothesis: '更大的样本上限会提升准确率',
  template: 'tabular-baseline',
  metric: 'test.accuracy',
  direction: 'maximize',
  baseline: { dataset: 'digits', model: 'logreg', testSize: 0.2, seed: 42 },
  searchSpace: [],
  stopWhen: '主指标不再提升',
  risks: [],
  ...over
});

test('需要的实验会被展开成 trial，基线排在第一个', () => {
  const built = exp.buildTrials({ design: design({ searchSpace: [{ param: 'model', values: ['random_forest', 'mlp'] }] }), available, limit: { maxTrials: 4 } });
  assert.deepEqual(built.rejected, []);
  assert.equal(built.trials.length, 3, '基线 + 2 个调参组合');
  assert.equal(built.trials[0].params.model, 'logreg', '基线必须是第一轮');
  assert.equal(built.trials[1].params.model, 'random_forest');
  assert.equal(built.trials[1].varies, 'model');
  assert.equal(built.trials[0].template, 'tabular-baseline');
  assert.equal(built.metric, 'test.accuracy');
  assert.equal(built.direction, 'maximize');
});

test('模板不存在或指标没声明，直接拒绝而不是硬跑', () => {
  const badTemplate = exp.buildTrials({ design: design({ template: 'gpt-finetune' }), available, limit: { maxTrials: 4 } });
  assert.equal(badTemplate.trials.length, 0);
  assert.match(badTemplate.rejected[0].reason, /模板不可用/);

  const badMetric = exp.buildTrials({ design: design({ metric: 'test.f1_macro_custom' }), available, limit: { maxTrials: 4 } });
  assert.equal(badMetric.trials.length, 0);
  assert.match(badMetric.rejected[0].reason, /不在模板声明的指标里/);
});

test('参数越界被挡下：基线非法整单拒绝，组合非法只丢那一个', () => {
  const badBaseline = exp.buildTrials({ design: design({ baseline: { dataset: 'imagenet' } }), available, limit: { maxTrials: 4 } });
  assert.equal(badBaseline.trials.length, 0);
  assert.match(badBaseline.rejected[0].reason, /基线参数不合法/);

  const partial = exp.buildTrials({
    design: design({ searchSpace: [{ param: 'testSize', values: [0.99, 0.3] }] }),
    available,
    limit: { maxTrials: 4 }
  });
  assert.equal(partial.trials.length, 2, '基线 + 合法的 0.3（0.99 越界被丢）');
  assert.equal(partial.rejected.length, 1);
  assert.match(partial.rejected[0].reason, /不能大于/);
});

test('组合数量受 maxTrials 裁剪，不会因为搜索空间大就多跑', () => {
  const built = exp.buildTrials({
    design: design({ searchSpace: [{ param: 'model', values: ['logreg', 'random_forest', 'mlp'] }, { param: 'seed', values: [1, 2, 3, 4] }] }),
    available,
    limit: { maxTrials: 3 }
  });
  assert.equal(built.trials.length, 3);
});

test('搜索空间按单参数逐个变，不做全笛卡尔积爆炸', () => {
  const combos = exp.expandSpace([{ param: 'a', values: [1, 2, 3] }, { param: 'b', values: ['x', 'y'] }], { maxTrials: 10, baseline: { base: true } });
  assert.equal(combos.length, 5, '3 + 2，而不是 3×2');
  assert.ok(combos.every(c => c.base === true));
});

test('最优 trial 按方向客观选择，失败的运行不参与比较', () => {
  const runs = [
    { runId: 'r1', label: 'E1', status: 'done', params: { seed: 1 }, metrics: { test: { accuracy: 0.9 } }, template: { id: 'tabular-baseline' } },
    { runId: 'r2', label: 'E2', status: 'done', params: { seed: 2 }, metrics: { test: { accuracy: 0.95 } }, template: { id: 'tabular-baseline' } },
    { runId: 'r3', label: 'E3', status: 'failed', metrics: { test: { accuracy: 0.99 } }, template: { id: 'tabular-baseline' } }
  ];
  const best = exp.bestTrial(runs, { metric: 'test.accuracy', direction: 'maximize' });
  assert.equal(best.runId, 'r2');
  assert.equal(best.value, 0.95);
  const min = exp.bestTrial(runs, { metric: 'test.accuracy', direction: 'minimize' });
  assert.equal(min.runId, 'r1');
  assert.equal(exp.bestTrial(runs, { metric: 'nope' }), null);
});

test('汇总区分完成与失败，并给出可读记录', () => {
  const runs = [
    { runId: 'r1', label: 'E1', status: 'done', params: { model: 'logreg' }, metrics: { test: { accuracy: 0.97 } }, template: { id: 'tabular-baseline', name: '表格基线' } },
    { runId: 'r2', label: 'E2', status: 'failed', error: '进程退出码 1', params: {}, template: { id: 'tabular-baseline', name: '表格基线' } }
  ];
  const summary = exp.summarizeRuns(runs, { metric: 'test.accuracy', direction: 'maximize' });
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.best.runId, 'r1');
  const text = exp.describeRuns(runs);
  assert.match(text, /^E1 \| 表格基线 \| done/);
  assert.match(text, /failed/);
});

test('设计与分析的结构约束：必需字段齐全，方向只允许两个值', () => {
  assert.deepEqual(exp.EXPERIMENT_SCHEMA.required.sort(), ['baseline', 'direction', 'metric', 'needed', 'reason', 'stopWhen', 'template'].sort());
  assert.deepEqual(exp.EXPERIMENT_SCHEMA.properties.direction.enum, ['maximize', 'minimize']);
  assert.ok(exp.ANALYZE_SCHEMA.required.includes('continue'));
  assert.ok(exp.DESIGN_PROMPT.includes('可证伪'));
  assert.ok(exp.ANALYZE_PROMPT.includes('不得编造'));
});
