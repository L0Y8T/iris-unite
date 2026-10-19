/* 用真实数据的只读副本给侧边栏拍照：确认「还有 N 个对话」折叠在真实数据上成立。 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve('.');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

(async () => {
  const dataRoot = path.join(os.tmpdir(), `iris-sidebar-${process.pid}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  const source = path.join(process.env.APPDATA, 'IrisUnite', 'conversations.json');
  fs.copyFileSync(source, path.join(dataRoot, 'conversations.json'));

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
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 300) => { for (let i = 0; i < tries; i++) { try { if (await js(expr)) return; } catch { /* bootstrap */ } await delay(100); } throw new Error('超时: ' + expr); };

  const outDir = path.join(root, 'artifacts', 'ui-run');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await send('Runtime.enable', {});
    await send('Page.enable', {});
    await until(`!!document.querySelector('#workspace-tree') && state.historyLoading === false`);
    await js(`state.workspaces.forEach(w => state.expanded.add(w.id)); renderSidebar(); true`);
    await delay(400);
    const stats = await js(`(() => {
      const groups = [...document.querySelectorAll('.workspace-group')];
      return {
        groups: groups.length,
        chats: document.querySelectorAll('.conversation-item').length,
        more: [...document.querySelectorAll('.group-more')].map(b => b.textContent.trim()),
        sidebarScroll: document.querySelector('.sidebar')?.scrollHeight || 0
      };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'sidebar-real.png'), Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ stats, file: path.join(outDir, 'sidebar-real.png') }, null, 1));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    await delay(300);
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 占用 */ }
  }
})().catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
