/* 科研模式「草稿→核验→发布」契约验收（离线，不联网、不花钱）。
 *
 * 覆盖 docs/research-mode-design.md：
 *   §14.6 整轮结束前正文区必须为空，未核验文本不得进入可读区域；
 *         核验与自检完成后才出现最终正文。
 *   §18.2 未启用检索时不得假装引用可核验，必须如实标注为「无法核验」。
 *   §9.3  调用次数不超过预算。
 *
 * 假模型服务按阶段提示词里的固定标记区分阶段，返回该阶段要求的 JSON 或正文。
 * 检索关闭（config.retrieval.enabled=false），因此不触网；
 * 引用核验的移除逻辑由 tests/citation.test.cjs 单测覆盖，这里只验「何时可见」。
 *
 *   node tests/research-run-check.cjs
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

const ANSWER = '结论：现有证据支持方案 A 有效 [S1]。\n\n这是未核验正文标记 FINAL-BODY-OK。';

function stageAnswer(payload) {
  if (payload.includes('界定者')) {
    return JSON.stringify({ objective: '评估方案 A 的可行性', questions: ['方案 A 是否有效'], queries: ['方案 A'], inclusion: ['同行评议'], exclusion: ['预印本'] });
  }
  if (payload.includes('你是科研统筹')) {
    return JSON.stringify({
      objective: '评估方案 A 的可行性',
      tasks: [
        { id: 'task-1', assignment: '技术路线发散', deliverable: '路线清单', evidenceKeys: [] },
        { id: 'task-2', assignment: '机制与创新性', deliverable: '机制分析', evidenceKeys: [] }
      ],
      selectionCriteria: '证据强度与可行性'
    });
  }
  if (payload.includes('你是第二层研究执行者')) return '任务成果：路线 R1 的关键假设与验证方案。';
  if (payload.includes('你已收到全部研究结果')) {
    return JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '证据与可行性均达标', unsupported: [] });
  }
  if (payload.includes('你是最终反证与整合者')) return ANSWER;
  if (payload.includes('你是终审复核者')) return JSON.stringify({ verdict: 'pass', fabrications: [], unsupported: [], fixes: [] });
  return '未识别阶段。';
}

function startModelServer() {
  const requests = [];
  let finished = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    requests.push(raw.length);
    const payload = JSON.stringify(body.messages || body);
    const answer = stageAnswer(payload);
    /* 稍微放慢并分两段吐字：让「草稿期」真实存在，界面才有可采样的窗口。 */
    await delay(300);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const half = Math.ceil(answer.length / 2);
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(0, half) } }] }) + '\n\n');
    await delay(250);
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(half) } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    finished++;
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port, stats: () => finished })));
}

(async () => {
  const { server, requests, port, stats } = await startModelServer();
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
  const until = async (expr, tries = 900) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await until('!!document.querySelector(".welcome") && state.historyLoading === false');
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Research QA', model: 'research-qa', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 4096
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Research QA');
    assert.ok(conn, '连接没有保存成功');
    const pick = { provider: conn.id, model: 'research-qa', effort: 'default' };

    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'research-qa', effort: 'default' } };
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

    /* 走界面发送路径：这样协作事件会落到渲染进程的运行时状态里，
       终审自检（不落盘）才读得到。 */
    await js(`refreshLocal()`);
    await js(`openThread(${JSON.stringify(id)})`);
    await delay(200);
    await js(`document.querySelector("#prompt").value='评估方案 A 的可行性';document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));true`);
    await js(`document.querySelector("#send-button").click();true`);

    /* 生成中：正文必须为空，未核验文本只能待在草稿里 */
    let sawDraft = 0;
    let sawMainText = false;
    let running = true;
    for (let i = 0; i < 900 && running; i++) {
      const snap = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return {status:m?.status,text:(m?.text||'').length,draft:(m?.draftText||'').length,hasFinal:(m?.text||'').includes('FINAL-BODY-OK')}})()`);
      if (snap.status && snap.status !== 'streaming') running = false;
      else {
        if (snap.draft > 0) sawDraft++;
        if (snap.hasFinal || snap.text > 0) sawMainText = true;
      }
      await delay(80);
    }
    assert.equal(sawMainText, false, '整轮结束前正文区不得出现内容');
    assert.ok(sawDraft > 0, '生成中应有草稿字符数增长，实得 ' + sawDraft + ' 次采样');

    const done = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);const r=c.research||null;return {status:m.status,text:m.text||'',hasDraft:Object.prototype.hasOwnProperty.call(m,'draftText'),error:m.error||'',integrity:m.integrity||null,artifacts:(m.research?.artifacts||r?.artifacts||[]).map(a=>a.stage),calls:m.usage?.calls||0}})()`);
    console.log('运行结束:', JSON.stringify({ status: done.status, textLen: done.text.length, hasDraft: done.hasDraft, error: done.error.slice(0, 120), calls: done.calls, stages: [...new Set(done.artifacts)], integrity: done.integrity && { ran: done.integrity.ran, ok: done.integrity.ok } }, null, 2));

    assert.equal(done.status, 'done', '本轮应当成功: ' + done.error);
    assert.match(done.text, /FINAL-BODY-OK/, '核验后正文应当发布');
    assert.equal(done.hasDraft, false, '发布后不得留草稿字段');
    assert.equal(done.calls, 6, '本轮应为 6 次模型调用，实得 ' + done.calls);
    assert.ok(done.calls <= 8, '不得超预算');
    assert.ok(stats() === 6, '上游应收到 6 次请求，实得 ' + stats());
    assert.ok(requests.length === 6, '上游请求数应为 6');

    /* 未启用检索：不得假装引用可核验 */
    const audit = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);const live=state.active?.messages?.find(x=>x.id===m.id);const a=live?.collaboration?.audit||null;const run=live?.collaboration||null;return {audit:a?{verdict:a.verdict,checks:a.checks.map(x=>({name:x.name,ok:x.ok,detail:x.detail}))}:null, callsUsed:run?.callsUsed||0, callBudget:run?.callBudget||0, stages:run?.stageLabel||'', integrity:m.integrity?{ran:m.integrity.ran,ok:m.integrity.ok,retrievalEnabled:m.integrity.retrievalEnabled}:null}})()`);
    console.log('终审自检:', JSON.stringify(audit, null, 2));
    assert.ok(audit.audit, '应有终审自检结果');
    assert.equal(audit.integrity?.ran, false, '未启用检索时核验环节不应声称跑过');
    assert.equal(audit.integrity?.retrievalEnabled, false);
    const citeCheck = audit.audit.checks.find(c => c.name === '引用可核验' || c.name === '引用全部可核验');
    assert.ok(citeCheck, '自检里应有引用核验项');
    assert.equal(citeCheck.ok, false, '未启用检索时引用不得判为可核验');
    assert.match(citeCheck.detail, /未启用资料检索|无法核验/, '要写明原因，实得：' + citeCheck.detail);
    assert.equal(audit.audit.verdict, 'attention', '存在未通过项时应为 attention');

    console.log(JSON.stringify({ passed: true, calls: done.calls, budget: audit.callBudget, verdict: audit.audit.verdict, textLength: done.text.length }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
    server.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
