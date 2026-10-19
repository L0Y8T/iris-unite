/* 真训练闭环验收：研究流程自己设计实验、真跑 sklearn 训练、按指标分析、写进答案。
 *
 * 假模型只提供 JSON（设计/分析/成文），执行侧是真 Python：
 *   研究消息 → 实验设计(假模型) → 实验程序(本地编译) → 训练评估(真跑 2 次)
 *            → 结果分析(假模型) → 实验记录 → 整合 → 核验 → 自检
 *
 *   node tests/experiment-flow-check.cjs
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

function stageAnswer(payload) {
  if (payload.includes('界定者')) return JSON.stringify({ objective: '比较不同模型在 digits 上的准确率', questions: ['哪个模型更准'], queries: ['digits classification'], inclusion: ['同行评议'], exclusion: ['博客'] });
  if (payload.includes('你是科研统筹')) return JSON.stringify({
    objective: '比较模型准确率',
    tasks: [
      { id: 'task-1', assignment: '路线发散', deliverable: '路线清单', evidenceKeys: [] },
      { id: 'task-2', assignment: '机制分析', deliverable: '机制说明', evidenceKeys: [] }
    ],
    selectionCriteria: '准确率与可复现性'
  });
  if (payload.includes('你是第二层研究执行者')) return '路线成果：建议用树模型对比线性模型。';
  if (payload.includes('你已收到全部研究结果')) return JSON.stringify({ selectedIds: ['task-1', 'task-2'], refineIds: [], feedback: '', reason: '两者都保留', unsupported: [] });
  if (payload.includes('你是实验设计者')) return JSON.stringify({
    needed: true,
    reason: '结论依赖可测量的准确率',
    hypothesis: '随机森林在 digits 上的测试准确率高于逻辑回归',
    template: 'tabular-baseline',
    metric: 'test.accuracy',
    direction: 'maximize',
    baseline: { dataset: 'digits', model: 'logreg', testSize: 0.2, seed: 42 },
    searchSpace: [{ param: 'model', values: ['random_forest'] }],
    stopWhen: '主指标不再提升或达到 trial 上限',
    risks: ['单一数据集，未做跨数据集外推']
  });
  if (payload.includes('你是实验结果分析者')) return JSON.stringify({
    comparison: '两次运行已完成，按主指标比较随机森林与逻辑回归',
    continue: false,
    why: '已有两个候选可直接比较，无需再调参',
    conclusion: '本轮跑通了对比实验，具体数值以运行记录为准',
    boundaries: ['单一数据集', '固定测试集比例']
  });
  if (payload.includes('你是最终反证与整合者')) return '本轮在 digits 上完成了模型对比实验，最优结果与参数见运行记录 [E1]。';
  if (payload.includes('你是终审复核者')) return JSON.stringify({ verdict: 'pass', fabrications: [], unsupported: [], fixes: [] });
  return '未识别阶段。';
}

function startModelServer() {
  const state = { requests: 0, stages: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    state.requests += 1;
    const payload = JSON.stringify(body.messages || body);
    for (const [marker, name] of [['界定者', 'scope'], ['你是科研统筹', 'plan'], ['你是第二层研究执行者', 'explore'], ['你已收到全部研究结果', 'screen'], ['你是实验设计者', 'experiment-design'], ['你是实验结果分析者', 'experiment-analyze'], ['你是最终反证与整合者', 'final']]) {
      if (payload.includes(marker)) state.stages.push(name);
    }
    const answer = stageAnswer(payload);
    await delay(50);
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
  const until = async (expr, tries = 2000) => {
    for (let i = 0; i < tries; i++) {
      try { if (await js(expr)) return; } catch { /* 页面还在 bootstrap */ }
      await delay(150);
    }
    throw new Error('超时: ' + expr);
  };

  try {
    await until('typeof state !== "undefined" && state.historyLoading === false');
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Exp QA', model: 'exp-qa', protocol: 'openai',
      baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 4096
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Exp QA');
    assert.ok(conn, '连接没有保存成功');
    const pick = { provider: conn.id, model: 'exp-qa', effort: 'default' };

    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'exp-qa', effort: 'default' } };
      const researchConfig = {
        version: 4,
        profile: 'p1-review',
        tier: 'readonly',
        choices: { scope: ${JSON.stringify(pick)}, evidence: ${JSON.stringify(pick)}, plan: ${JSON.stringify(pick)}, screen: ${JSON.stringify(pick)}, final: ${JSON.stringify(pick)}, audit: null, experimentDesign: ${JSON.stringify(pick)}, experimentAnalyze: ${JSON.stringify(pick)}, summarize: null, teachingOutline: null, teachingSections: null, teachingExamples: null },
        tasks: [
          { id: 'task-1', title: '路线发散', brief: '发散路线', choice: ${JSON.stringify(pick)} },
          { id: 'task-2', title: '机制', brief: '构造机制', choice: ${JSON.stringify(pick)} }
        ],
        allowRefinement: false,
        refinement: { maxTasks: 2, maxPassesPerTask: 1 },
        teaching: { audience: 'x', prerequisites: [], learningGoal: 'x', chapterCount: 2, chapterChoices: {}, numericPolicy: 'builtin-arithmetic-only' },
        retrieval: { enabled: false, sources: ['openalex'], maxQueries: 1, maxRecordsPerSource: 3, maxRecordsPerQuery: 3, maxRecordsPerRun: 20, maxRequests: 10, maxRetriesPerRequest: 0, yearFrom: null, yearTo: null, reusePolicy: 'explicit-selection' },
        evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
        budget: { maxCalls: 14, wallClockSec: 900, modelTimeoutSec: 300, maxConcurrentModels: 2, maxModelRetryAttempts: 0, maxRepairAttempts: 0 },
        monitor: { enabled: false },
        mech: { enabled: false, provider: null, model: null, effort: null, triggers: [], maxAttemptsPerNode: 1, maxMechCalls: 0, outputPolicy: 'candidate-only', onInvalidOutput: 'fallback-deterministic' },
        output: { language: 'zh-CN', processPanelDefault: 'collapsed' },
        experiments: { enabled: true, maxTrials: 2, maxRounds: 2, templateId: null, stopWhen: '主指标不再提升' }
      };
      return window.duet.create({ mode: 'research', models: [${JSON.stringify(conn.id)}], modelConfig, researchConfig });
    })()`);
    const id = conversation.id;

    await js(`window.duet.send(${JSON.stringify(id)},'比较不同模型在 digits 上的准确率').catch(e=>String(e.message));true`);
    await until(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return m && m.status !== 'streaming'})()`, 3000);

    const reply = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.at(-1);return {status:m.status,error:m.error||'',text:m.text||'',experiments:m.experiments||null,family:m.experimentFamily||null}})()`);
    console.log('运行结果:', JSON.stringify({
      status: reply.status,
      error: reply.error.slice(0, 200),
      familyRuns: (reply.family?.runs || []).length,
      completed: reply.family?.summary?.completed,
      best: reply.family?.summary?.best,
      rounds: (reply.family?.rounds || []).length,
      gateOk: reply.experiments?.ok
    }, null, 1));

    assert.equal(reply.status, 'done', '研究应成功：' + reply.error);
    assert.ok(reply.family, '运行记录里应有实验族结果');
    assert.equal(reply.family.skipped, false, '应真的跑了实验');
    assert.equal(reply.family.runs.length, 2, '应有两次真实运行（基线 + 调参）');
    assert.equal(reply.family.summary.completed, 2, '两次都应成功：' + JSON.stringify(reply.family.summary.rows));
    const best = reply.family.summary.best;
    assert.ok(best && typeof best.value === 'number' && best.value > 0.5 && best.value <= 1, '最优指标应是真实准确率，实得 ' + JSON.stringify(best));
    console.log('真实最优:', JSON.stringify(best));

    /* 假模型确实被要求做了实验设计与结果分析 */
    assert.ok(state.stages.includes('experiment-design'), '应调用实验设计：' + state.stages.join(','));
    assert.ok(state.stages.includes('experiment-analyze'), '应调用结果分析');
    assert.ok(state.stages.includes('final'), '应调用整合');

    /* 运行记录落盘、可核验 */
    const list = await js(`window.duet.execList(${JSON.stringify({ conversationId: id })})`);
    assert.ok(list.runs.length >= 2, '本对话应能查到实验运行记录');

    console.log(JSON.stringify({ passed: true, modelCalls: state.requests, stages: [...new Set(state.stages)], familyRuns: reply.family.runs.length, bestMetric: best.metric, bestValue: best.value, gateOk: reply.experiments?.ok }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
    server.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
