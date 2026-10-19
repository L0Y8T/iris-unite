/* 「重新生成」与发布顺序验收：离线、不花钱。
 *
 * 覆盖 docs/research-mode-design.md 的两条契约：
 *   §11.5 重试不新增用户消息、不删除旧答案、成功后旧答案标为被取代、失败时旧答案保持可见；
 *   §9.2  生成中不允许重复触发。
 *
 *   node tests/retry-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
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

function startModelServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    requests.push({ url: req.url, body });
    const n = requests.length;
    if (n === 3) {                      // 第三次：故意失败，用来验证旧答案不被丢掉
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '模拟上游故障' } }));
      return;
    }
    if (n === 4) await new Promise(r => setTimeout(r, 1800));   // 第四次：慢，用于生成中重跑
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: `这是第 ${n} 次回答。` } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

(async () => {
  const { server, requests, port } = await startModelServer();
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
  let seq = 0; const pending = new Map();
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 600) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await delay(100); } throw new Error('超时: ' + expr); };
  const snapshot = id => js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});return c.messages.map(m=>({id:m.id,role:m.role,status:m.status,text:(m.text||'').slice(0,30),error:(m.error||'').slice(0,120),supersededBy:m.supersededBy||null,attemptOf:m.attemptOf||null}))})()`);
  const waitSettled = async () => {
    for (let i = 0; i < 600; i++) {
      const s = await js(`(state.active?.messages?.at(-1)?.status) || 'none'`);
      if (s && s !== 'streaming') return;
      await delay(100);
    }
    throw new Error('等待本轮结束超时');
  };

  try {
    await until('!!document.querySelector(".welcome") && state.historyLoading === false');

    // 清掉验证档里残留的连接，避免同名旧连接指向已关闭端口
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Retry QA', model: 'retry-qa', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 2048
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Retry QA');
    assert.ok(conn, '连接没有保存成功');

    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'retry-qa', effort: 'default' } };
      return window.duet.create({ models: [${JSON.stringify(conn.id)}], modelConfig });
    })()`);
    const id = conversation.id;
    await js(`refreshLocal()`);
    await js(`openThread(${JSON.stringify(id)})`);
    await js(`document.querySelector("#prompt").value='测试重新生成';document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));true`);
    await js(`document.querySelector("#send-button").click();true`);
    await delay(400);
    await waitSettled();

    const first = await snapshot(id);
    assert.equal(first.length, 2, '第一轮应为 1 条问题 + 1 条回答');
    assert.equal(first[1].status, 'done', '第一轮应当成功: ' + JSON.stringify(first[1]));
    assert.equal(requests.length, 1);

    /* 第一次重跑：成功，旧答案必须保留并标记被取代 */
    await js(`window.duet.retry(${JSON.stringify(id)}).catch(e=>String(e.message))`);
    await delay(400);
    await waitSettled();
    const afterOk = await snapshot(id);
    console.log('重跑成功后:', JSON.stringify(afterOk));
    assert.equal(afterOk.filter(m => m.role === 'user').length, 1, '重跑不应新增用户消息');
    assert.equal(afterOk.length, 3, '旧答案保留 + 新答案追加，应为 3 条');
    assert.equal(afterOk[1].status, 'done');
    assert.ok(afterOk[1].supersededBy, '新答案成功后旧答案应标为被取代');
    assert.equal(afterOk[1].supersededBy, afterOk[2].id, '被取代指向新答案');
    assert.equal(afterOk[2].status, 'done');
    assert.equal(afterOk[2].attemptOf, afterOk[1].id, '新答案应指向它重跑的那条');
    assert.match(afterOk[2].text, /第 2 次回答/);
    assert.equal(requests.length, 2);

    /* 第二次重跑：上游 500，旧答案必须仍然可用 */
    await js(`window.duet.retry(${JSON.stringify(id)}).catch(e=>String(e.message))`);
    await delay(400);
    await waitSettled();
    const afterFail = await snapshot(id);
    console.log('重跑失败后:', JSON.stringify(afterFail));
    assert.equal(afterFail.length, 4, '失败的重跑也保留一条自己的记录');
    assert.equal(afterFail[3].status, 'error', '第三次请求应失败');
    assert.equal(afterFail[2].supersededBy, null, '失败时不能把上一版答案标为被取代');
    assert.equal(afterFail[2].status, 'done', '上一版好答案必须还在');
    assert.equal(requests.length, 3);

    /* 生成中不允许重复触发 */
    await js(`window.duet.send(${JSON.stringify(id)},'第三轮').catch(()=>{});true`);
    await delay(600);
    const busy = await js(`window.duet.retry(${JSON.stringify(id)}).then(()=>'ok').catch(e=>String(e.message))`);
    assert.match(busy, /正在生成/, '生成中重跑应被拒绝，实得：' + busy);
    await js(`window.duet.stop(${JSON.stringify(id)});true`);
    await delay(300);

    console.log(JSON.stringify({
      passed: true,
      requests: requests.length,
      firstRound: first.map(m => m.role + ':' + (m.status || '-')),
      afterRetry: afterOk.map(m => m.role + ':' + (m.status || '-')),
      afterFailedRetry: afterFail.map(m => m.role + ':' + (m.status || '-')),
      userMessages: afterFail.filter(m => m.role === 'user').length
    }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
    server.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
