/* 运行记录（manifest）：一次实验的"身份证"。
 *
 * 平台的可信度全靠这个文件：答案里任何实验数字都必须能指回某条 manifest，
 * 而 manifest 里的数字只能来自本次进程真实写出的 metrics.json。
 * 所以这里既有结构校验，也有"指标必须能被文本精确复现"的比对工具。
 *
 * 纯函数 + 一个 sha256 小工具，不做 IO。
 */
const { createHash } = require('node:crypto');

const STATUS = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled', 'timeout']);

const sha = (value) => createHash('sha256').update(value).digest('hex');

function createManifest({ runId, conversationId, template, params, env, startedAt = Date.now() }) {
  if (!runId || !template) throw new Error('创建运行记录需要 runId 与 template');
  return {
    version: 1,
    runId,
    conversationId: conversationId || null,
    template: { id: template.id, version: template.version, name: template.name },
    params: params || {},
    env: env || null,
    status: 'queued',
    startedAt,
    finishedAt: null,
    exitCode: null,
    metrics: null,
    artifacts: [],
    logs: { stdout: [], stderr: [], truncated: false },
    error: null
  };
}

/** 把嵌套指标压成 "test.accuracy" 这样的点路径，只到 3 层，只收标量叶子。 */
function flattenMetrics(metrics, prefix = '', depth = 0, out = {}) {
  if (depth > 3 || metrics === null || metrics === undefined) return out;
  if (typeof metrics === 'number' || typeof metrics === 'string' || typeof metrics === 'boolean') {
    if (prefix) out[prefix] = metrics;
    return out;
  }
  if (Array.isArray(metrics)) return out;
  if (typeof metrics === 'object') {
    for (const [key, value] of Object.entries(metrics)) {
      const next = prefix ? `${prefix}.${key}` : key;
      flattenMetrics(value, next, depth + 1, out);
    }
  }
  return out;
}

/** 某次运行里所有可被引用的数值指标（字符串/布尔也保留，供 device 这类字段用）。 */
function metricTable(manifest) {
  const flat = flattenMetrics(manifest?.metrics || {});
  const numbers = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith('params.')) continue;          // 参数不是实验结果
    numbers[key] = value;
  }
  return numbers;
}

/**
 * 结构校验。缺产物、指标为空、状态与退出码矛盾，都必须抓住——
 * 这些情况一旦放过，界面就会把半截运行显示成成功。
 */
function validateManifest(manifest, { expectedTemplate } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') throw new Error('运行记录不是对象');
  if (manifest.version !== 1) problems.push({ code: 'version', message: `运行记录版本未知：${manifest.version}` });
  if (!manifest.runId) problems.push({ code: 'run-id', message: '缺少 runId' });
  if (!STATUS.includes(manifest.status)) problems.push({ code: 'status', message: `状态非法：${manifest.status}` });
  if (!manifest.template?.id) problems.push({ code: 'template', message: '缺少模板标识' });
  if (expectedTemplate && manifest.template?.id !== expectedTemplate) problems.push({ code: 'template-mismatch', message: `模板不符：期望 ${expectedTemplate}，实际 ${manifest.template?.id}` });
  if (manifest.status === 'done') {
    if (manifest.exitCode !== 0) problems.push({ code: 'exit-code', message: `状态为完成但退出码是 ${manifest.exitCode}` });
    if (!manifest.metrics || typeof manifest.metrics !== 'object') problems.push({ code: 'metrics', message: '状态为完成但没有指标' });
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) problems.push({ code: 'artifacts', message: '状态为完成但没有产物' });
    for (const artifact of manifest.artifacts || []) {
      if (!artifact?.name || typeof artifact.bytes !== 'number' || !artifact.sha256) problems.push({ code: 'artifact-shape', message: `产物记录不完整：${JSON.stringify(artifact)}` });
    }
    const metrics = metricTable(manifest);
    if (!Object.keys(metrics).length) problems.push({ code: 'metrics-empty', message: '指标为空，不能作为证据' });
  }
  if (manifest.status === 'failed' || manifest.status === 'timeout') {
    if (!manifest.error) problems.push({ code: 'error-missing', message: '失败但没有记录原因' });
  }
  return { ok: problems.length === 0, problems };
}

/** 给界面与答案用的精简视图：只留能公开的部分，日志只给最后几行。 */
function summarize(manifest, { logTail = 12 } = {}) {
  const metrics = manifest?.status === 'done' ? metricTable(manifest) : {};
  return {
    runId: manifest?.runId,
    label: manifest?.label || null,
    conversationId: manifest?.conversationId || null,
    template: manifest?.template || null,
    params: manifest?.params || {},
    status: manifest?.status,
    startedAt: manifest?.startedAt || null,
    finishedAt: manifest?.finishedAt || null,
    durationMs: manifest?.finishedAt && manifest?.startedAt ? manifest.finishedAt - manifest.startedAt : null,
    exitCode: manifest?.exitCode ?? null,
    error: manifest?.error || null,
    metrics,
    metricCount: Object.keys(metrics).length,
    artifacts: (manifest?.artifacts || []).map(a => ({ name: a.name, bytes: a.bytes })),
    logTail: logTail > 0 ? (manifest?.logs?.stdout || []).slice(-logTail) : [],
    truncated: manifest?.logs?.truncated === true
  };
}

module.exports = { STATUS, createManifest, flattenMetrics, metricTable, validateManifest, summarize, sha };
