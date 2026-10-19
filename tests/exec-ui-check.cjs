/* 实验执行界面验收：打开面板、选模板、真跑一次、看到指标与产物。
 *
 * 会真实起 Python 进程并装依赖（首次几十秒），所以只在显式需要时跑：
 *   node tests/exec-ui-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
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
  const dbg = await freePort();
  const child = spawn(electron, ['.', '--verification-profile', `--remote-debugging-port=${dbg}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, stdio: 'ignore', windowsHide: true });

  let target;
  for (let i = 0; i < 200; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* 启动中 */ }
    await delay(100);
  }
  if (!target) throw new Error('渲染进程没有起来');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 1200) => {
    for (let i = 0; i < tries; i++) {
      try { if (await js(expr)) return; } catch { /* 页面还在 bootstrap，下一轮再试 */ }
      await delay(100);
    }
    throw new Error('超时: ' + expr);
  };

  try {
    await send('Runtime.enable', {});
    await until('!!document.querySelector("#exec-button") && state.historyLoading === false');

    await js(`document.querySelector('#exec-button').click();true`);
    await until(`document.querySelector('#exec-dialog').open === true && document.querySelectorAll('#exec-template option').length > 0`);
    await delay(300);

    const templates = await js(`[...document.querySelectorAll('#exec-template option')].map(o => ({ id: o.value, text: o.textContent, disabled: o.disabled }))`);
    console.log('模板:', JSON.stringify(templates));
    assert.ok(templates.length >= 2, '应至少两个模板');
    assert.ok(templates.some(t => t.disabled && /未实现/.test(t.text)), '未实现模板必须禁用并标注');

    const env = await js(`document.querySelector('#exec-env-status').textContent`);
    console.log('环境状态:', env);
    assert.match(env, /Python/i, '应显示可用的 Python 版本');

    /* 选自检模板并真跑一次 */
    await js(`(function(){const s=document.querySelector('#exec-template');s.value='env-smoke';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await delay(200);
    const params = await js(`[...document.querySelectorAll('[data-exec-param]')].map(i => i.dataset.execParam)`);
    assert.deepEqual(params.sort(), ['dim', 'seed', 'sleepSec'], '参数控件应来自模板声明');
    await js(`(function(){const i=document.querySelector('[data-exec-param="dim"]');i.value='48';return true})()`);
    await js(`document.querySelector('#exec-run').click();true`);
    await until(`/已完成|失败|超时|已取消/.test(document.querySelector('#exec-run-status').textContent)`, 1200);

    const after = await js(`({
      status: document.querySelector('#exec-run-status').textContent,
      metrics: document.querySelector('#exec-metrics').textContent.replace(/\\s+/g,' ').trim(),
      logLines: document.querySelector('#exec-log').textContent.split('\\n').length,
      history: document.querySelectorAll('[data-exec-run]').length
    })`);
    console.log('运行后:', JSON.stringify(after));
    assert.match(after.status, /已完成/, '运行应成功：' + after.status);
    assert.match(after.metrics, /run\.seconds/, '应显示指标：' + after.metrics);
    assert.match(after.metrics, /run\.matrix_trace/);
    assert.ok(after.logLines > 1, '应有日志');
    assert.ok(after.history >= 1, '历史里应有记录');

    /* 历史记录可点开还原指标 */
    await js(`document.querySelector('[data-exec-run]').click();true`);
    await delay(600);
    const reopened = await js(`document.querySelector('#exec-metrics').textContent.replace(/\\s+/g,' ')`);
    assert.match(reopened, /run\.matrix_trace/, '点历史应还原指标');

    assert.deepEqual(pageErrors, [], '界面不应有脚本错误：' + pageErrors.join(' | '));
    console.log(JSON.stringify({ passed: true, templates: templates.length, status: after.status, metrics: after.metrics.slice(0, 90) }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
