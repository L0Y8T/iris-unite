/* 花费估算的界面验收：单价填进去 → 用量旁边出现金额；没填就如实说「未设单价」。
 *
 *   node tests/pricing-ui-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const electron = require('./lib/electron-binary.cjs').binary;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

const USAGE = { calls: 3, input: 12000, output: 3000, total: 15000, reported: 3, parts: { 'deepseek:deepseek-flash': { input: 12000, output: 3000 } } };
const ANSWER = '三种模型里 MLP 最好，测试准确率 0.9806 [E1]。';

(async () => {
  const dataRoot = path.join(os.tmpdir(), `iris-pricing-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dataRoot, 'conversations.json'), JSON.stringify({
    version: 3, workspaces: [],
    conversations: [{
      id: 'conv-pricing', source: 'local', title: '花费估算验收', models: ['deepseek'],
      createdAt: now - 60000, updatedAt: now,
      messages: [
        { id: 'u1', role: 'user', text: '算一下这轮花多少钱', roundId: 'r1', timestamp: now - 50000 },
        { id: 'a1', role: 'assistant', kind: 'answer', provider: 'deepseek', model: 'deepseek-flash', effort: 'high', text: ANSWER, status: 'done', roundId: 'r1', timestamp: now, usage: USAGE, collaboration: { version: 4, mode: 'research', status: 'done', profileName: '综述', tier: 'P1', stageLabel: '已完成', stages: [], artifacts: [], participants: [] } }
      ]
    }]
  }, null, 2), 'utf8');

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
  const until = async (expr, tries = 300) => { for (let i = 0; i < tries; i++) { try { if (await js(expr)) return; } catch { /* bootstrap */ } await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await send('Runtime.enable', {});
    await send('Page.enable', {});
    await until(`!!document.querySelector('#settings-button') && state.historyLoading === false`);

    await js(`openThread('conv-pricing')`);
    await until(`!!document.querySelector('[data-reply="a1"] .reply-usage')`);

    /* 还没填单价：用量旁边必须明说「未设单价」，不能凭空算一个数 */
    const before = await js(`document.querySelector('[data-reply="a1"] .reply-usage').textContent`);
    assert.equal(before, '15,000 tokens · 未设单价', `未设单价时的文案不对：${before}`);

    /* 设置面板：单价表按通道渲染 */
    await js(`document.querySelector('#settings-button').click();true`);
    await until(`document.querySelector('#settings-dialog').open === true && document.querySelectorAll('#pricing-list .pricing-row').length >= 2`);
    const rows = await js(`[...document.querySelectorAll('#pricing-list .pricing-row')].map(r => r.dataset.provider)`);
    assert.deepEqual(rows.slice(0, 2), ['deepseek', 'gpt'], `单价表通道不对：${JSON.stringify(rows)}`);

    /* 填 2 元 / 8 元 —— 每百万 token */
    await js(`(() => {
      const row = document.querySelector('#pricing-list .pricing-row[data-provider="deepseek"]');
      const input = row.querySelector('[data-price-input]'); const output = row.querySelector('[data-price-output]');
      input.value = '2'; output.value = '8'; output.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await js(`document.querySelector('#settings-form button[type="submit"]').click();true`);
    await until(`document.querySelector('#settings-dialog').open === false`);

    /* 落盘检查：settings.json 里真的存住了 */
    const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.pricing?.deepseek, { input: 2, output: 8, currency: 'CNY' }, `设置未落盘：${JSON.stringify(saved.pricing)}`);

    /* 回到对话：单价生效后金额立刻出现，不用重跑对话 */
    await js(`openThread('conv-pricing')`);
    await until(`document.querySelector('[data-reply="a1"] .reply-usage')?.textContent.includes('¥')`);
    const after = await js(`document.querySelector('[data-reply="a1"] .reply-usage').textContent`);
    /* 12000/1e6*2 + 3000/1e6*8 = 0.024 + 0.024 = 0.048 */
    assert.equal(after, '15,000 tokens · ≈¥0.0480', `计价文案不对：${after}`);

    /* 设置面板截图留档 */
    await js(`document.querySelector('#settings-button').click();true`);
    await until(`document.querySelector('#settings-dialog').open === true`);
    await delay(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(root, 'artifacts', 'pricing');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'settings-pricing.png'), Buffer.from(shot.data, 'base64'));

    assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(' | ')}`);
    console.log(JSON.stringify({ passed: true, before, after, providers: rows, file: path.join(outDir, 'settings-pricing.png') }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    await delay(300);
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 占用 */ }
  }
})().catch(error => { console.error(JSON.stringify({ passed: false, error: String(error?.message || error) })); process.exitCode = 1; });
