/* 执行器验收：真实起进程、真实出指标、真实杀掉超时与取消。
 *
 * 不联网、不下载数据、不需要 GPU；只依赖 venv 里装 numpy（首次约 30–60 秒，
 * 之后按依赖指纹复用同一个环境）。跑完的 run 记录留在临时目录，便于查看现场。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const templates = require('../core/exec/templates.cjs');
const { ensureEnv } = require('../core/exec/env.cjs');
const { runExperiment } = require('../core/exec/runner.cjs');
const manifests = require('../core/exec/manifest.cjs');
const claims = require('../core/exec/claims.cjs');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-exec-'));
let envPromise = null;
const sharedEnv = () => {
  envPromise = envPromise || ensureEnv({ packages: templates.templateById('env-smoke').requires.packages, rootDir: dataRoot });
  return envPromise;
};

test('真实执行一次自检模板：产出指标、产物、可核对的运行记录', { timeout: 300000 }, async () => {
  const env = await sharedEnv();
  assert.ok(fs.existsSync(env.pythonPath), 'venv 里应有 python');
  assert.ok(env.fingerprint, '应有依赖指纹');

  const events = [];
  const { manifest, runDir } = await runExperiment({
    templateId: 'env-smoke',
    params: { dim: 64, seed: 7 },
    dataRoot,
    env,
    conversationId: 'conv-test',
    onEvent: event => events.push(event)
  });

  assert.equal(manifest.status, 'done', '运行应成功：' + (manifest.error || ''));
  assert.equal(manifest.exitCode, 0);
  assert.equal(manifest.conversationId, 'conv-test');
  assert.deepEqual(manifest.params, { dim: 64, seed: 7, sleepSec: 0 });
  assert.ok(manifest.finishedAt >= manifest.startedAt);

  const metrics = manifests.metricTable(manifest);
  assert.equal(typeof metrics['run.seconds'], 'number');
  assert.equal(metrics['run.dim'], undefined, '参数不应混进指标表');
  assert.equal(manifest.params.dim, 64, '参数应记录在 manifest.params');
  assert.match(manifest.metrics.env.numpy, /^\d+\.\d+/);

  const names = manifest.artifacts.map(a => a.name).sort();
  assert.deepEqual(names, ['metrics.json', 'summary.txt']);
  for (const artifact of manifest.artifacts) {
    assert.ok(artifact.bytes > 0, artifact.name + ' 不应为空');
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  }

  assert.match(manifest.env.scriptHash, /^[0-9a-f]{64}$/, '运行记录必须记下脚本哈希');
  assert.ok(fs.existsSync(path.join(dataRoot, 'exec', 'scripts', manifest.env.scriptFile)), '脚本应被物化到数据目录（打包后 asar 内的脚本 Python 读不到）');
  assert.equal(manifests.validateManifest(manifest, { expectedTemplate: 'env-smoke' }).ok, true);
  assert.ok(fs.existsSync(path.join(runDir, 'manifest.json')), '运行记录应落盘');
  assert.ok(events.some(e => e.type === 'log'), '应有日志事件');
  assert.ok(events.some(e => e.type === 'status' && e.status === 'running'));
  assert.ok(events.some(e => e.type === 'status' && e.status === 'done'));

  /* 用真实运行记录反过来验证溯源：指标写对了能通过，改一个数字就通不过 */
  const good = claims.verify(`矩阵迹为 ${manifest.metrics.run.matrix_trace.toFixed(4)} [E1]。`, [manifest]);
  assert.equal(good.ok, true, JSON.stringify(good));
  const bad = claims.verify('矩阵迹为 999.1234 [E1]。', [manifest]);
  assert.equal(bad.ok, false);
});

test('超时：到点杀掉整个进程树，状态记为 timeout 并写明原因', { timeout: 120000 }, async () => {
  const env = await sharedEnv();
  const started = Date.now();
  const { manifest } = await runExperiment({
    templateId: 'env-smoke',
    params: { dim: 32, sleepSec: 30 },
    dataRoot,
    env,
    timeoutSec: 5
  });
  const elapsed = Date.now() - started;
  assert.equal(manifest.status, 'timeout', '应判为超时');
  assert.match(manifest.error, /超过 5 秒上限/);
  assert.ok(elapsed < 25000, '应在超时后很快返回，实测 ' + elapsed + 'ms');
  assert.ok(manifest.logs.stdout.join('\n').includes('等待'), '应保留超时前的输出');
});

test('取消：abort 后立刻终止并记为 cancelled，不算失败', { timeout: 120000 }, async () => {
  const env = await sharedEnv();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 600);
  const { manifest } = await runExperiment({
    templateId: 'env-smoke',
    params: { dim: 32, sleepSec: 30 },
    dataRoot,
    env,
    signal: controller.signal
  });
  assert.equal(manifest.status, 'cancelled');
  assert.equal(manifest.exitCode !== 0, true, '被杀掉的进程退出码不应为 0');
});

test('环境按依赖指纹复用：第二次调用不再创建 venv', { timeout: 120000 }, async () => {
  const first = await sharedEnv();
  const second = await ensureEnv({ packages: templates.templateById('env-smoke').requires.packages, rootDir: dataRoot, onLog: () => {} });
  assert.equal(second.created, false, '第二次应命中已有环境');
  assert.equal(second.envDir, first.envDir);
  assert.equal(second.fingerprint, first.fingerprint);
});

test('参数非法时不会起进程', async () => {
  const env = await sharedEnv();
  await assert.rejects(runExperiment({ templateId: 'env-smoke', params: { dim: 4 }, dataRoot, env }), /不能小于/);
  await assert.rejects(runExperiment({ templateId: 'nope', params: {}, dataRoot, env }), /未知的实验模板/);
});
