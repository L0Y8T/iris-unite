/* 平台注入的运行时验收：sandbox preload 到底能不能把 process.platform 交给渲染进程。
 *
 * 这条没法用单测证明——preload 跑在受限环境里，能不能访问 process 是运行时事实。
 * 拿不到的话，mac 上会静默退化成「自绘窗口按钮 + Ctrl 快捷键」，而 Windows 上看不出任何异常。
 *
 *   node tests/runtime-probe.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve('.');
const electron = require('./lib/electron-binary.cjs').binary;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

(async () => {
  const dataRoot = path.join(os.tmpdir(), `iris-probe-${process.pid}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'conversations.json'), JSON.stringify({ version: 3, workspaces: [], conversations: [] }), 'utf8');

  const dbg = await freePort();
  const child = spawn(electron, ['.', `--user-data-dir=${path.join(dataRoot, 'chromium')}`, `--remote-debugging-port=${dbg}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, IRIS_DATA_ROOT: dataRoot }
  });

  let target;
  for (let i = 0; i < 300; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* 启动中 */ }
    await delay(100);
  }
  if (!target) throw new Error('渲染进程没有起来');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let seq = 0; const pending = new Map();
  const pageErrors = [];
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') pageErrors.push('console.error: ' + JSON.stringify(m.params.args?.map(a => a.value ?? a.description)));
    const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 300) => { for (let i = 0; i < tries; i++) { try { if (await js(expr)) return; } catch { /* bootstrap */ } await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await send('Runtime.enable');
    await until(`!!window.duet && state.historyLoading === false`);

    const report = await js(`(() => {
      const exposed = Object.keys(window.duet || {});
      const fn = exposed.filter(key => typeof window.duet[key] === 'function');
      const nonFn = exposed.filter(key => typeof window.duet[key] !== 'function');
      return {
        platform: window.duet.platform,
        dataset: document.documentElement.dataset.platform,
        exposedCount: fn.length,
        nonFunctionKeys: nonFn.map(k => k + '=' + String(window.duet[k])),
        missingSettings: ['pricing'].filter(k => !('pricing' in (state.settings || {}))),
        pricingValue: state.settings && state.settings.pricing,
        shortcutGuard: typeof platformInfo
      };
    })()`);

    /* 关键：sandbox preload 里 process.platform 到底有没有值 */
    const platformOk = report.platform === 'win32' && report.dataset === 'win32';
    const titlebarVisible = await js(`getComputedStyle(document.querySelector('.window-actions')).display`);

    /* 逐项验证窗口控制的 IPC 通道可用（不真的关窗） */
    const windowIpc = await js(`window.duet.window('maximize').then(() => 'ok', e => 'error: ' + e.message)`);

    /* 断言：平台值必须真的传进渲染进程，否则 mac 上会退化成「自绘按钮 + Ctrl 快捷键」 */
    assert.equal(report.platform, process.platform, `window.duet.platform 应为 ${process.platform}，实际 ${report.platform}`);
    assert.equal(report.dataset, process.platform, 'html[data-platform] 没跟着平台走');
    assert.equal(report.shortcutGuard, 'string', 'platformInfo 没有在脚本最早处定义');
    assert.deepEqual(report.missingSettings, [], 'publicSettings 缺少前端要用的字段');
    assert.equal(report.nonFunctionKeys.length, 1, `window.duet 上除 platform 外不该有非函数键：${JSON.stringify(report.nonFunctionKeys)}`);
    assert.ok(report.exposedCount >= 40, `暴露的 IPC 方法过少：${report.exposedCount}`);
    assert.equal(windowIpc, 'ok', '窗口控制通道不可用');
    assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(' | ')}`);

    console.log(JSON.stringify({
      passed: true,
      platform: report.platform,
      exposedMethods: report.exposedCount,
      titlebarDisplay: titlebarVisible,
      note: process.platform === 'darwin' ? 'mac 上这里应该是系统红绿灯 + 顶栏让位' : '自绘标题栏'
    }, null, 1));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    await delay(300);
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 占用 */ }
  }
})().catch(error => { console.error(JSON.stringify({ passed: false, error: String(error?.message || error) })); process.exitCode = 1; });
