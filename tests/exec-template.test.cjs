const test = require('node:test');
const assert = require('node:assert/strict');
const templates = require('../core/exec/templates.cjs');
const manifests = require('../core/exec/manifest.cjs');
const claims = require('../core/exec/claims.cjs');

/* ── 模板表与参数校验 ─────────────────────────────────────────────── */

test('模板表：每个模板都有脚本、依赖清单、产物与指标声明', () => {
  assert.ok(templates.TEMPLATES.length >= 2);
  for (const template of templates.TEMPLATES) {
    assert.match(template.id, /^[a-z0-9-]+$/);
    assert.ok(template.script.endsWith('.py'), template.id + ' 缺少脚本名');
    assert.ok(Array.isArray(template.requires.packages) && template.requires.packages.length, template.id + ' 缺少依赖清单');
    assert.ok(Array.isArray(template.artifacts) && template.artifacts.length, template.id + ' 缺少产物声明');
    assert.ok(Array.isArray(template.metrics) && template.metrics.length, template.id + ' 缺少指标声明');
    assert.ok(Array.isArray(template.params) && template.params.length, template.id + ' 缺少参数声明');
    for (const spec of template.params) {
      assert.ok(templates.PARAM_TYPES.includes(spec.type), template.id + ' 参数类型非法：' + spec.type);
      assert.ok('default' in spec, `${template.id}.${spec.id} 没有默认值`);
    }
  }
});

test('未知模板与未实现模板都被明确拒绝，不会静默降级', () => {
  assert.throws(() => templates.templateById('nope'), /未知的实验模板/);
  const pending = templates.TEMPLATES.find(t => t.unimplemented);
  assert.ok(pending, '应保留一个未实现模板用于提示');
  assert.throws(() => templates.validateParams(pending.id, {}), /尚未实现/);
});

test('参数校验：越界、类型不符、多余参数都报错，缺省值被填上', () => {
  const ok = templates.validateParams('env-smoke', {});
  assert.deepEqual(ok, { dim: 256, seed: 42, sleepSec: 0 });
  assert.throws(() => templates.validateParams('env-smoke', { dim: 8 }), /不能小于/);
  assert.throws(() => templates.validateParams('env-smoke', { dim: 99999 }), /不能大于/);
  assert.throws(() => templates.validateParams('env-smoke', { dim: 1.5 }), /必须是整数/);
  assert.throws(() => templates.validateParams('env-smoke', { dim: 'abc' }), /必须是数字/);
  assert.throws(() => templates.validateParams('env-smoke', { evil: 1 }), /不认识参数/);
  assert.throws(() => templates.validateParams('tabular-baseline', { dataset: 'imagenet' }), /只能是/);
});

test('参数翻译成 CLI 时用短横线，且只包含模板声明过的参数', () => {
  const built = templates.buildArgs('env-smoke', { dim: 64, sleepSec: 0.5 });
  assert.equal(built.args[0], '--dim');
  assert.equal(built.args[2], '--seed');
  assert.equal(built.args[4], '--sleep-sec');
  assert.equal(built.args[5], '0.5');
  assert.ok(built.script.endsWith('env-smoke.py'));
  assert.ok(!built.args.some(a => a.includes('undefined')));
});

test('超时被夹到模板声明的区间，缺省用默认值', () => {
  assert.equal(templates.resolveTimeout('env-smoke', undefined), 120);
  assert.equal(templates.resolveTimeout('env-smoke', 1), 5);
  assert.equal(templates.resolveTimeout('env-smoke', 99999), 600);
  assert.equal(templates.resolveTimeout('env-smoke', 60), 60);
});

test('依赖清单相同的模板命中同一个环境指纹，改一项就换目录', () => {
  const a = templates.envKey(['numpy>=2.0', 'scikit-learn>=1.5']);
  const b = templates.envKey(['scikit-learn>=1.5', 'numpy>=2.0']);
  const c = templates.envKey(['numpy>=2.1', 'scikit-learn>=1.5']);
  assert.equal(a, b, '顺序不同不应换环境');
  assert.notEqual(a, c, '版本不同必须换环境');
});

/* ── 运行记录 ─────────────────────────────────────────────────────── */

const sampleManifest = (over = {}) => ({
  version: 1, runId: 'run-1', conversationId: 'c1',
  template: { id: 'env-smoke', version: 1, name: '执行环境自检' },
  params: { dim: 256, seed: 42 },
  env: { pythonPath: '/x/python', fingerprint: 'abc', packages: ['numpy>=2.0'] },
  status: 'done', startedAt: 1000, finishedAt: 3000, exitCode: 0,
  metrics: { run: { seconds: 0.12, matrix_trace: 1.5 }, env: { numpy: '2.5.4' }, params: { dim: 256 } },
  artifacts: [{ name: 'metrics.json', bytes: 10, sha256: 'deadbeef' }],
  logs: { stdout: ['ok'], stderr: [], truncated: false },
  error: null,
  ...over
});

test('指标扁平化：只收标量叶子，参数不进指标表', () => {
  const flat = manifests.flattenMetrics({ test: { accuracy: 0.97, nested: { deep: { deeper: { tooDeep: 1 } } } }, list: [1, 2], top: 'x' });
  assert.equal(flat['test.accuracy'], 0.97);
  assert.equal(flat.top, 'x');
  assert.equal(flat['test.nested.deep.deeper.tooDeep'], undefined, '超过 3 层的应被丢弃');
  const table = manifests.metricTable(sampleManifest());
  assert.equal(table['run.seconds'], 0.12);
  assert.equal(table['params.dim'], undefined, '参数不是实验结果');
});

test('运行记录校验：完成态缺指标、缺产物、退出码不符都要抓住', () => {
  assert.equal(manifests.validateManifest(sampleManifest()).ok, true);
  const noMetrics = manifests.validateManifest(sampleManifest({ metrics: null }));
  assert.equal(noMetrics.ok, false);
  assert.ok(noMetrics.problems.some(p => p.code === 'metrics'));
  const noArtifacts = manifests.validateManifest(sampleManifest({ artifacts: [] }));
  assert.equal(noArtifacts.ok, false);
  const badExit = manifests.validateManifest(sampleManifest({ exitCode: 1 }));
  assert.equal(badExit.ok, false);
  const failed = manifests.validateManifest(sampleManifest({ status: 'failed', error: null }));
  assert.equal(failed.ok, false);
  assert.equal(manifests.validateManifest(sampleManifest(), { expectedTemplate: 'other' }).ok, false);
});

test('运行记录摘要只暴露可公开内容，日志只给尾部', () => {
  const log = Array.from({ length: 30 }, (_, i) => 'line' + i);
  const view = manifests.summarize(sampleManifest({ logs: { stdout: log, stderr: [], truncated: false } }), { logTail: 5 });
  assert.equal(view.logTail.length, 5);
  assert.deepEqual(manifests.summarize(sampleManifest(), { logTail: 0 }).logTail, [], 'logTail=0 时不应带日志');
  assert.equal(view.logTail.at(-1), 'line29');
  assert.equal(view.durationMs, 2000);
  assert.equal(view.metricCount, 3, 'run.seconds / run.matrix_trace / env.numpy，参数不计');
  assert.equal(view.artifacts[0].name, 'metrics.json');
});

/* ── 数字溯源 ─────────────────────────────────────────────────────── */

const run = (label, metrics, over = {}) => ({ runId: 'run-' + label, label, status: 'done', startedAt: 1, template: { id: 'tabular-baseline', name: '表格基线' }, params: { epochs: 2 }, artifacts: [{ name: 'metrics.json', bytes: 1, sha256: 'x' }], metrics, ...over });

test('数字溯源：带标记且数值与指标一致的,通过', () => {
  const runs = [run('E1', { test: { accuracy: 0.973, macro_f1: 0.962 }, train: { seconds: 0.42 } })];
  const ok = claims.verify('在 digits 上准确率 97.3% [E1]，macro-F1 为 0.962 [E1]。', runs);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.markers.resolved.length, 2);
  assert.equal(ok.numbers.bound.length, 2);
});

test('数字溯源：数字在记录里找不到就不通过', () => {
  const runs = [run('E1', { test: { accuracy: 0.973 } })];
  const bad = claims.verify('准确率 98.7% [E1]。', runs);
  assert.equal(bad.ok, false);
  assert.equal(bad.numbers.unsourced.length, 1);
  assert.match(bad.numbers.unsourced[0].reason, /找不到这个数值/);
});

test('数字溯源：标记指向不存在的运行或未完成的运行都不通过', () => {
  const done = run('E1', { test: { accuracy: 0.5 } });
  const failedRun = run('E2', {}, { status: 'failed' });
  const missing = claims.verify('准确率 50% [E3]。', [done, failedRun]);
  assert.equal(missing.ok, false);
  assert.equal(missing.markers.unresolved[0].reason, '本对话没有这条运行记录');
  const notDone = claims.verify('准确率 50% [E2]。', [done, failedRun]);
  assert.equal(notDone.ok, false);
  assert.match(notDone.markers.unresolved[0].reason, /状态是 failed/);
});

test('数字溯源：讲指标却没有标记的句子记为无出处', () => {
  const runs = [run('E1', { test: { accuracy: 0.973 } })];
  const text = '我们的准确率达到了 97.3%，明显优于基线。';
  const result = claims.verify(text, runs);
  assert.equal(result.ok, false);
  assert.equal(result.numbers.unsourced.length, 1);
  assert.match(result.numbers.unsourced[0].reason, /没有任何 \[E\] 运行标记/);
});

test('数字溯源：没有任何标记时整体不通过，并给出原因', () => {
  const none = claims.verify('本轮结论基于文献推演。', [run('E1', { test: { accuracy: 0.9 } })]);
  assert.equal(none.ok, false);
  assert.match(none.note, /没有引用任何运行记录/);
});

test('数字溯源：序号、年份、文献键里的数字不误报', () => {
  const runs = [run('E1', { test: { accuracy: 0.973 } })];
  const text = '1. 2024 年的研究 [S3] 指出准确率 97.3% [E1]。\n2. 见 [S1]。';
  const result = claims.verify(text, runs);
  assert.equal(result.ok, true, JSON.stringify(result.numbers));
});

test('数字溯源：写在正文里的参数（轮数、种子）只要与记录一致也算可核对', () => {
  const runs = [run('E1', { test: { accuracy: 0.97 } })];
  const result = claims.verify('训练 2 轮后准确率 97% [E1]。', runs);
  assert.equal(result.ok, true, '97% 与 0.97 应互认');
  const fine = claims.verify('训练 2 轮后准确率 0.97 [E1]。', runs);
  assert.equal(fine.ok, true, JSON.stringify(fine.numbers));
});

test('可引用运行清单：没有完成运行时要明确禁止写实验数字', () => {
  assert.match(claims.referenceBlock([]), /不得出现实验数字/);
  const block = claims.referenceBlock([run('E1', { test: { accuracy: 0.973 } })]);
  assert.match(block, /^E1 \|/);
  assert.match(block, /test\.accuracy=0\.973/);
});
