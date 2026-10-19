/* 阶段产出可见性验收：每个阶段一完成，运行中的状态条就要摊出产出摘要。
 *
 * 用慢速假模型（每阶段延迟）制造足够的观察窗口，在主界面直接抓 #run-status。
 *   node tests/stage-preview-check.cjs
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

function stageAnswer(payload) {
  if (payload.includes('界定者')) return JSON.stringify({ objective: '验证阶段产出可见性', questions: ['每阶段能否看到产出'], queries: ['visibility'], inclusion: ['同行评议'], exclusion: ['博客'] });
  if (payload.includes('你是科研统筹')) return JSON.stringify({ objective: '验证可见性', tasks: [{ id: 'task-1', assignment: '路线', deliverable: '清单', evidenceKeys: [] }, { id: 'task-2', assignment: '机制', deliverable: '说明', evidenceKeys: [] }], selectionCriteria: '清晰度' });
  if (payload.includes('你是第二层研究执行者')) return '这一阶段的可公开产出：路线要点 A / B / C，每条都带可验证的停止条件。';
  if (payload.includes('你已收到全部研究结果')) return JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '保留', unsupported: [] });
  if (payload.includes('你是最终反证与整合者')) return '最终答案：本轮的阶段产出都可见。';
  return '未识别阶段。';
}

function startModelServer() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    const payload = JSON.stringify(body.messages || body);
    await delay(900);                      // 每阶段慢一点，留出观察窗口
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: stageAnswer(payload) } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

(async () => {
  const { server, port } = await startModelServer();
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
  const until = async (expr, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      try { if (await js(expr)) return; } catch { /* bootstrap */ }
      await delay(100);
    }
    throw new Error('超时: ' + expr);
  };

  try {
    await until('typeof state !== "undefined" && state.historyLoading === false');
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Preview QA', model: 'preview-qa', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 2048
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Preview QA');
    const pick = { provider: conn.id, model: 'preview-qa', effort: 'default' };

    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'preview-qa', effort: 'default' } };
      const researchConfig = {
        version: 3,
        retrieval: { enabled: false, sources: ['openalex'], perSource: 3, yearFrom: null, maxQueries: 1 },
        choices: { scope: ${JSON.stringify(pick)}, evidence: ${JSON.stringify(pick)}, plan: ${JSON.stringify(pick)}, screen: ${JSON.stringify(pick)}, final: ${JSON.stringify(pick)}, audit: null },
        tasks: [
          { id: 'task-1', title: '路线', brief: '发散路线', choice: ${JSON.stringify(pick)} },
          { id: 'task-2', title: '机制', brief: '构造机制', choice: ${JSON.stringify(pick)} }
        ],
        maxCalls: 8,
        allowRefinement: false,
        monitor: { enabled: false }
      };
      return window.duet.create({ mode: 'research', models: [${JSON.stringify(conn.id)}], modelConfig, researchConfig });
    })()`);
    const id = conversation.id;

    await js(`refreshLocal()`);
    await js(`openThread(${JSON.stringify(id)})`);
    await delay(300);

    await js(`document.querySelector('#prompt').value='验证阶段产出可见';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#send-button').click();true`);

    /* 运行中轮询：状态条里必须出现「刚完成阶段 + 产出摘要」 */
    const samples = [];
    let sawPreview = false;
    for (let i = 0; i < 200; i++) {
      const snap = await js(`(()=>{const box=document.querySelector('#run-status .run-last');const status=document.querySelector('#run-status');return {visible: !status.classList.contains('hidden'), last: box ? box.textContent.replace(/\\s+/g,' ').trim() : null}})()`);
      if (snap.last) { sawPreview = true; samples.push(snap.last); }
      const done = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return m && m.status !== 'streaming'})()`);
      if (done) break;
      await delay(120);
    }

    console.log('运行中抓到的阶段摘要样例:', JSON.stringify(samples.slice(0, 3), null, 1));
    assert.equal(sawPreview, true, '运行中必须在状态条看到刚完成阶段的产出摘要');
    assert.ok(samples.some(text => text.length > 8), '摘要不能是空的：' + JSON.stringify(samples.slice(0, 3)));
    assert.ok(samples.some(text => /研究界定|问题分解|并行研究|候选筛选/.test(text)), '摘要里应出现阶段名，实得：' + JSON.stringify(samples.slice(0, 3)));
    assert.equal(samples.some(text => text.includes('{"')), false, '摘要不该是原始 JSON：' + JSON.stringify(samples.slice(0, 2)));

    /* 整轮结束后：过程面板仍在，标题写明可点开查看各阶段产出 */
    await until(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return m && m.status !== 'streaming'})()`, 400);
    const after = await js(`(()=>{const d=document.querySelector('.process-details');return d ? {summary: d.querySelector('summary').textContent.replace(/\\s+/g,' ').trim(), open: d.open, artifacts: document.querySelectorAll('.process-artifact').length} : null})()`);
    console.log('结束后过程面板:', JSON.stringify(after));
    assert.ok(after, '结束后应保留过程面板');
    assert.match(after.summary, /各阶段产出/);
    assert.match(after.summary, /点开查看/);
    assert.equal(after.open, false, '中间材料仍然默认收起');

    await js(`document.querySelector('.process-details>summary').click();true`);
    await delay(400);
    const expanded = await js(`(async()=>{const d=document.querySelector('.process-details');const c=await window.duet.get(${JSON.stringify(id)});return {open:d.open, bodies:[...document.querySelectorAll('.process-artifact .artifact-body')].map(b=>b.textContent.trim().length)}})()`);
    assert.equal(expanded.open, true, '点开should展开');
    assert.ok(expanded.bodies.length >= 3, '每个阶段都要有产出块，实得 ' + expanded.bodies.length);
    assert.ok(expanded.bodies.every(len => len > 0), '阶段产出块不能为空：' + JSON.stringify(expanded.bodies));

    console.log(JSON.stringify({ passed: true, previewSamples: samples.length, artifacts: after.artifacts, bodyLengths: expanded.bodies }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
    server.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
