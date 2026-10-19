/* 执行器：把一次受控实验跑起来，并把结果写成可核对的运行记录。
 *
 * 边界（这是"受控"的含义，不是临时限制）：
 *   - 只跑模板自带的脚本，脚本路径来自模板表，不接受外部传入；
 *   - 工作目录是本次 run 的独立目录，产物只能落在其中的 artifacts/；
 *   - 环境变量清空 PYTHONPATH/PYTHONHOME，避免继承开发机上的杂包；
 *   - 超时与取消都会杀掉整个进程树，不留孤儿进程。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const templates = require('./templates.cjs');
const manifests = require('./manifest.cjs');

const MAX_LOG_LINES = 1500;
const MAX_LINE_CHARS = 2000;

const isWin = () => process.platform === 'win32';

/**
 * 杀掉进程树。Windows 上只 kill 父进程会留下正在算的子进程；
 * POSIX 上父进程被 SIGKILL 后子进程会被过继给 init 继续跑——所以子进程要放进独立进程组
 * （spawn 时 detached: true），这里对 **进程组**（负 pid）发信号，才会连同孙进程一起收掉。
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (isWin()) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ }
    return;
  }
  /* 先整组，再兜底单进程：某些环境（容器里的非会话领头进程）拿不到组 id。 */
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 组不在了 */ }
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}

function listArtifacts(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { listArtifacts(full, base, out); continue; }
    const stat = fs.statSync(full);
    out.push({ name: path.relative(base, full).replace(/\\/g, '/'), bytes: stat.size, sha256: manifests.sha(fs.readFileSync(full)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 逐行喂给回调，同时按上限截断，避免一个刷屏的脚本把内存吃穿。 */
function lineFeeder(push, state) {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) push(line);
    },
    flush() { if (buffer) push(buffer); buffer = ''; },
    state
  };
}

const clampLine = line => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + ' …（已截断）' : line);

/**
 * 把模板脚本物化到数据目录再执行。
 *
 * 必须这么做：打包后脚本位于 app.asar 内，那是 Electron 的虚拟文件系统，
 * Python 进程（非 Electron）读不到 asar 里的路径。物化同时得到脚本哈希，
 * 写进运行记录，这样"这一轮到底跑了哪份代码"是可核对的。
 */
function materializeScript(template, dataRoot) {
  const source = path.join(templates.SCRIPT_DIR, template.script);
  const content = fs.readFileSync(source);
  const scriptHash = manifests.sha(content);
  const dir = path.join(dataRoot, 'exec', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${template.id}-v${template.version}-${scriptHash.slice(0, 10)}.py`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, content);
  return { scriptPath: target, scriptHash };
}

/**
 * 跑一次实验。返回最终 manifest（同时已写到 run 目录）。
 * @param {object} options
 * @param {string} options.templateId
 * @param {object} options.params
 * @param {string} options.dataRoot 应用数据目录（run 与环境都放这里）
 * @param {object} options.env ensureEnv 的结果
 * @param {number} [options.timeoutSec]
 * @param {AbortSignal} [options.signal]
 * @param {(event:object)=>void} [options.onEvent] 事件：status / log / done
 * @param {string} [options.conversationId]
 */
async function runExperiment({ templateId, params, dataRoot, env, timeoutSec, signal, onEvent = () => {}, conversationId = null }) {
  if (!env || !env.pythonPath) throw new Error('执行环境尚未就绪');
  const template = templates.templateById(templateId);
  const built = templates.buildArgs(templateId, params);
  const timeout = templates.resolveTimeout(templateId, timeoutSec);
  if (!fs.existsSync(built.script)) throw new Error(`模板脚本缺失：${built.script}`);
  const { scriptPath, scriptHash } = materializeScript(template, dataRoot);

  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(dataRoot, 'exec', 'runs', runId);
  const artifactDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  const manifest = manifests.createManifest({
    runId,
    conversationId,
    template,
    params: built.params,
    env: { pythonPath: env.pythonPath, fingerprint: env.fingerprint, packages: env.packages, pythonVersion: env.pythonVersion || null, scriptHash, scriptFile: path.basename(scriptPath) }
  });
  const persist = () => fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  persist();

  const emit = (type, payload) => { try { onEvent({ type, runId, ...payload }); } catch { /* 订阅方异常不影响运行 */ } };
  const pushLog = (stream, line) => {
    const clipped = clampLine(line);
    const bucket = manifest.logs[stream];
    if (bucket.length >= MAX_LOG_LINES) { manifest.logs.truncated = true; return; }
    bucket.push(clipped);
    emit('log', { stream, line: clipped });
  };

  manifest.status = 'running';
  persist();
  emit('status', { status: 'running', template: template.id, params: built.params });

  const envVars = {
    ...process.env,
    PYTHONPATH: '',
    PYTHONHOME: '',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1'
  };
  delete envVars.PYTHONPATH;
  delete envVars.PYTHONHOME;

  /* POSIX 上 detached 让训练进程自成一个进程组，超时/取消才能整组收掉（见 killTree）。
     Windows 没有进程组语义，那边走 taskkill /T，这两个参数会互相干扰，所以只在 POSIX 打开。 */
  const child = spawn(env.pythonPath, [scriptPath, ...built.args], { cwd: runDir, env: envVars, windowsHide: true, detached: !isWin(), stdio: ['ignore', 'pipe', 'pipe'] });

  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout * 1000);
  const onAbort = () => { cancelled = true; killTree(child); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }

  const outFeed = lineFeeder(line => pushLog('stdout', line));
  const errFeed = lineFeeder(line => pushLog('stderr', line));
  child.stdout.on('data', chunk => outFeed.feed(chunk.toString('utf8')));
  child.stderr.on('data', chunk => errFeed.feed(chunk.toString('utf8')));

  const exit = await new Promise(resolve => {
    child.on('error', error => resolve({ code: -1, error }));
    child.on('close', code => resolve({ code }));
  });
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  outFeed.flush();
  errFeed.flush();

  manifest.exitCode = exit.code;
  manifest.finishedAt = Date.now();
  const lastError = [...manifest.logs.stderr].reverse().find(line => line.trim()) || [...manifest.logs.stdout].reverse().find(line => /error/i.test(line));

  if (timedOut) {
    manifest.status = 'timeout';
    manifest.error = `超过 ${timeout} 秒上限，已终止进程树`;
  } else if (cancelled) {
    manifest.status = 'cancelled';
    manifest.error = '用户取消';
  } else if (exit.error) {
    manifest.status = 'failed';
    manifest.error = String(exit.error.message || exit.error).slice(0, 400);
  } else if (exit.code !== 0) {
    manifest.status = 'failed';
    manifest.error = (lastError || `进程退出码 ${exit.code}`).slice(0, 400);
  } else {
    const metricsPath = path.join(artifactDir, 'metrics.json');
    if (!fs.existsSync(metricsPath)) {
      manifest.status = 'failed';
      manifest.error = '运行结束但没有产出 artifacts/metrics.json，本次结果不完整';
    } else {
      try {
        manifest.metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
      } catch (e) {
        manifest.status = 'failed';
        manifest.error = `metrics.json 无法解析：${e.message}`;
      }
      if (manifest.status !== 'failed') {
        manifest.artifacts = listArtifacts(artifactDir);
        const present = new Set(manifest.artifacts.map(a => a.name));
        const missing = (template.artifacts || []).filter(name => !present.has(name));
        if (missing.length) {
          manifest.status = 'failed';
          manifest.error = `缺少模板声明的产物：${missing.join('、')}`;
        } else {
          manifest.status = 'done';
        }
      }
    }
  }

  const check = manifests.validateManifest(manifest, { expectedTemplate: template.id });
  if (!check.ok) {
    manifest.validation = check.problems;
    if (manifest.status === 'done') {
      manifest.status = 'failed';
      manifest.error = `运行记录校验未通过：${check.problems.map(p => p.message).join('；')}`;
    }
  }
  persist();
  emit('status', { status: manifest.status, error: manifest.error, metrics: manifest.status === 'done' ? manifests.metricTable(manifest) : null, artifacts: manifest.artifacts });
  return { manifest, runDir };
}

module.exports = { runExperiment, materializeScript, listArtifacts, killTree, MAX_LOG_LINES };
