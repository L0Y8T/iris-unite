/* 实验 → 科研答案 → 数字门禁 的端到端验收。
 *
 * 验证目标里最关键的一条：答案中的实验数字必须绑定真实 run-id 才能算核对通过。
 *   1. 真的跑一次实验（真 Python），拿到真实指标；
 *   2. 让科研流程的最终答案引用这些真实数字 + [E1] → 门禁应通过；
 *   3. 换成一个记录里不存在的数字 → 门禁应拦下，正文被标注〔未核对：…〕。
 *
 * 模型侧用本地假模型服务（离线、不花钱），执行侧是真跑。
 *   node tests/exec-gate-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
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

function stageAnswer(payload, finalText) {
  if (payload.includes('界定者')) return JSON.stringify({ objective: '验证实验数字可核对', questions: ['矩阵迹是多少'], queries: ['matrix trace'], inclusion: ['同行评议'], exclusion: ['博客'] });
  if (payload.includes('你是科研统筹')) return JSON.stringify({
    objective: '验证实验数字可核对',
    tasks: [
      { id: 'task-1', assignment: '技术路线发散', deliverable: '路线清单', evidenceKeys: [] },
      { id: 'task-2', assignment: '机制与创新性', deliverable: '机制分析', evidenceKeys: [] }
    ],
    selectionCriteria: '证据强度与可行性'
  });
  if (payload.includes('你是第二层研究执行者')) return '任务成果：路线 R1 的关键假设与验证方案。';
  if (payload.includes('你已收到全部研究结果')) return JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '证据与可行性均达标', unsupported: [] });
  if (payload.includes('你是最终反证与整合者')) return finalText;
  if (payload.includes('你是终审复核者')) return JSON.stringify({ verdict: 'pass', fabrications: [], unsupported: [], fixes: [] });
  return '未识别阶段。';
}

function startModelServer() {
  const state = { finalText: '', requests: 0, finalPayload: '' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    state.requests += 1;
    const payload = JSON.stringify(body.messages || body);
    if (payload.includes('你是最终反证与整合者')) state.finalPayload = payload;
    const answer = stageAnswer(payload, state.finalText);
    await delay(60);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

(async () => {
  const { server, state, port } = await startModelServer();
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
  const until = async (expr, tries = 1200) => {
    for (let i = 0; i < tries; i++) {
      try { if (await js(expr)) return; } catch { /* 页面还在 bootstrap */ }
      await delay(100);
    }
    throw new Error('超时: ' + expr);
  };

  try {
    await until('typeof state !== "undefined" && state.historyLoading === false');
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Gate QA', model: 'gate-qa', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 4096
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Gate QA');
    assert.ok(conn, '连接没有保存成功');
    const pick = { provider: conn.id, model: 'gate-qa', effort: 'default' };

    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'gate-qa', effort: 'default' } };
      const researchConfig = {
        version: 3,
        retrieval: { enabled: false, sources: ['openalex'], perSource: 3, yearFrom: null, maxQueries: 1 },
        choices: { scope: ${JSON.stringify(pick)}, evidence: ${JSON.stringify(pick)}, plan: ${JSON.stringify(pick)}, screen: ${JSON.stringify(pick)}, final: ${JSON.stringify(pick)}, audit: null },
        tasks: [
          { id: 'task-1', title: '技术路线发散', brief: '发散路线', choice: ${JSON.stringify(pick)} },
          { id: 'task-2', title: '机制与创新性', brief: '构造机制', choice: ${JSON.stringify(pick)} }
        ],
        maxCalls: 8,
        allowRefinement: true,
        monitor: { enabled: true }
      };
      return window.duet.create({ mode: 'research', models: [${JSON.stringify(conn.id)}], modelConfig, researchConfig });
    })()`);
    const id = conversation.id;

    /* 1) 真跑一次实验，绑定到这个对话 */
    const execRun = await js(`window.duet.execRun(${JSON.stringify({ templateId: 'env-smoke', params: { dim: 32 }, conversationId: id })})`);
    assert.ok(execRun.runId, '应返回 runId');
    for (let i = 0; i < 900; i++) {
      const status = await js(`window.duet.execGet(${JSON.stringify(execRun.runId)}).then(r => r.view.status).catch(() => 'pending')`);
      if (['done', 'failed', 'timeout', 'cancelled'].includes(status)) break;
      await delay(500);
    }
    const execView = await js(`window.duet.execGet(${JSON.stringify(execRun.runId)}).then(r => r.view)`);
    assert.equal(execView.status, 'done', '实验应成功：' + (execView.error || ''));
    const trace = execView.metrics['run.matrix_trace'];
    assert.equal(typeof trace, 'number', '应有 matrix_trace 指标');

    const researchRefs = await js(`window.duet.execVerify(${JSON.stringify({ conversationId: id })})`);
    assert.match(researchRefs.reference, /^E1 \|/, '科研流程应拿到可引用运行清单');
    assert.match(researchRefs.reference, /^E1 \|/, '科研流程应拿到可引用运行清单，实得：' + researchRefs.reference.slice(0, 80));
    console.log('可引用运行:', researchRefs.reference.split('\n')[0].slice(0, 120));

    /* 2) 真实数字 + [E1] → 门禁应通过 */
    const goodNumber = Number(trace).toFixed(6);
    state.finalText = `实验测得的矩阵迹为 ${goodNumber} [E1]。`;
    await js(`window.duet.send(${JSON.stringify(id)},'矩阵迹是多少').catch(e=>String(e.message));true`);
    await until(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return m && m.status !== 'streaming'})()`, 1200);
    const first = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return {status:m.status,text:m.text||'',error:m.error||'',experiments:m.experiments||null}})()`);
    console.log('第一轮:', JSON.stringify({ status: first.status, experiments: first.experiments && { ran: first.experiments.ran, ok: first.experiments.ok, bound: first.experiments.numbers?.bound?.length } }));
    assert.equal(first.status, 'done', '研究应成功：' + first.error);
    /* 提示词必须真的教过模型怎么写实验引用，否则模型只会写数字、门禁必然拦下。 */
    assert.match(state.finalPayload, /\[E1\]/, '最终提示词必须说明 [E1] 这种引用写法');
    assert.match(state.finalPayload, /已完成的实验运行/, '最终提示词必须指明数字只能来自运行清单');
    assert.ok(first.experiments?.ran, '应执行实验数字核验');
    assert.equal(first.experiments.ok, true, '真实数字应核对通过：' + JSON.stringify(first.experiments.numbers));
    assert.equal(first.experiments.numbers.bound.length, 1);
    assert.match(first.text, new RegExp(goodNumber.replace('.', '\\.')), '正文应保留真实数字');

    /* 3) 记录里不存在的数字 → 门禁应拦下并标注 */
    state.finalText = '实验测得的矩阵迹为 999.999999 [E1]。';
    await js(`window.duet.send(${JSON.stringify(id)},'再核对一次').catch(e=>String(e.message));true`);
    await until(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return m && m.status !== 'streaming'})()`, 1200);
    const second = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);const r=m.research;return {status:m.status,text:m.text||'',experiments:m.experiments||null,audit:(m.collaboration?.audit||r?.audit||null)}})()`);
    console.log('第二轮:', JSON.stringify({ status: second.status, ok: second.experiments?.ok, unsourced: second.experiments?.numbers?.unsourced?.length, note: second.experiments?.note }));
    assert.equal(second.status, 'done');
    assert.equal(second.experiments.ok, false, '编造的数字不该通过');
    assert.match(second.text, /〔未核对：999\.999999〕/, '无法核对的数字必须被标注，实得：' + second.text.slice(0, 200));

    console.log(JSON.stringify({ passed: true, runId: execRun.runId, trace, gatePass: first.experiments.ok, gateBlocked: !second.experiments.ok }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
    server.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
