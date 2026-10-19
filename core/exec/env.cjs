/* 执行环境：每次按依赖清单建一个独立 venv，装完锁指纹复用。
 *
 * 为什么不用系统 Python：本机系统解释器里有互相牵制的残包（探针时 pandas/torch
 * 报的是导入期异常而不是缺失），拿它跑实验等于把不可复现的隐患写进证据。
 * venv 路径由依赖清单哈希决定：同样的清单必然命中同一个环境，换了清单就换目录。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { envKey } = require('./templates.cjs');
const platform = require('../platform.cjs');

const IS_WIN = process.platform === 'win32';

/** Python 候选：顺序由 core/platform.cjs 决定（mac/Linux 只有 python3）。 */
function pythonCandidates() {
  return platform.pythonCandidates();
}

const PYTHON_HELP = '找不到可用的 Python 3.8+。装一个 Python 3.10+（macOS 可用 brew install python，Debian/Ubuntu 用 sudo apt install python3-venv），'
  + '或在环境变量 IRIS_PYTHON 里指定解释器路径。执行实验的其余功能不受影响。';

/** 跑一个子进程并收集输出；用于 venv 与 pip 这类必须等结果的短命令。 */
function execFileP(command, args, { timeoutMs = 600000, onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const feed = (chunk, sink) => {
      const text = chunk.toString('utf8');
      sink(text);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } reject(new Error(`${path.basename(command)} 超时（${Math.round(timeoutMs / 1000)}s）`)); }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } reject(new Error('已取消')); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', c => feed(c, t => { stdout += t; }));
    child.stderr.on('data', c => feed(c, t => { stderr += t; }));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${path.basename(command)} 退出码 ${code}：${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 400)}`));
    });
  });
}

/** 找出一个可用的 Python。允许用 IRIS_PYTHON 覆盖，便于用户指向 conda 环境。 */
async function detectPython() {
  const tried = [];
  for (const candidate of pythonCandidates()) {
    try {
      const { stdout, stderr } = await execFileP(candidate.command, [...candidate.prefix, '--version'], { timeoutMs: 20000 });
      const version = (stdout || stderr).trim();
      tried.push(`${candidate.command} → ${version || '无输出'}`);
      if (/^Python 3\.(1[0-9]|[89])/.test(version)) return { command: candidate.command, prefix: candidate.prefix, version };
    } catch (error) {
      tried.push(`${candidate.command} → ${String(error?.message || error).slice(0, 80)}`);
    }
  }
  /* 把试过的候选写进错误里：用户装了两个 Python 却都不合格时，这句话能省掉一轮来回。 */
  throw new Error(`${PYTHON_HELP}\n已尝试：${tried.join('；')}`);
}

const venvPythonPath = envDir => IS_WIN ? path.join(envDir, 'Scripts', 'python.exe') : path.join(envDir, 'bin', 'python');

/**
 * 确保依赖清单对应的环境可用。
 * @returns {Promise<{envDir:string, pythonPath:string, fingerprint:string, packages:string[], created:boolean}>}
 */
async function ensureEnv({ packages, rootDir, onLog = () => {}, signal } = {}) {
  if (!Array.isArray(packages) || !packages.length) throw new Error('模板没有声明依赖清单');
  const fingerprint = envKey(packages);
  const envDir = path.join(rootDir, 'exec', 'envs', fingerprint);
  const marker = path.join(envDir, '.iris-env.json');
  const pythonPath = venvPythonPath(envDir);

  if (fs.existsSync(pythonPath) && fs.existsSync(marker)) {
    try {
      const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (meta.fingerprint === fingerprint && Array.isArray(meta.packages)) {
        onLog(`复用已就绪环境 ${fingerprint}`);
        return { envDir, pythonPath, fingerprint, packages: meta.packages, created: false, pythonVersion: meta.pythonVersion };
      }
    } catch { /* 标记坏了就重建 */ }
  }

  const python = await detectPython();
  fs.mkdirSync(path.dirname(envDir), { recursive: true });
  onLog(`创建隔离环境（依赖 ${packages.length} 项），首次执行需要几十秒`);
  await execFileP(python.command, [...python.prefix, '-m', 'venv', envDir], { onLine: line => onLog(line), timeoutMs: 300000, signal });
  onLog('安装依赖：' + packages.join(' '));
  await execFileP(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', ...packages], { onLine: line => onLog(line), timeoutMs: 900000, signal });
  const versionOut = await execFileP(pythonPath, ['-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 30000 });
  const meta = { fingerprint, packages, pythonVersion: versionOut.stdout.trim(), createdAt: Date.now() };
  fs.writeFileSync(marker, JSON.stringify(meta, null, 2), 'utf8');
  onLog(`环境就绪：Python ${meta.pythonVersion}`);
  return { envDir, pythonPath, fingerprint, packages, created: true, pythonVersion: meta.pythonVersion };
}

module.exports = { ensureEnv, detectPython, execFileP, venvPythonPath };
