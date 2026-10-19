/* 「按上一轮的方案执行实验」端到端验收（离线假模型 + 真跑一次轻量模板）。
 *
 * 盯的是用户提的那个问题：模型在答案里给了实验建议，用户说「就跑这个」，
 * 不该把界定/检索/证据/分解整套重来。
 *
 * 断言四件事：
 * 1. 第二轮只调用 3 次模型（实验设计 / 结果分析 / 整合），一次都没有碰前面的环节；
 * 2. 第二轮的阶段表只剩实验族 + 核验 + 自检，前 8 个环节标成沿用；
 * 3. 实验真的跑了（env-smoke 模板，真起 Python），运行记录带 runId；
 * 4. 沿用的配置不会污染对话配置——第三轮追问仍然是完整研究。
 *
 *   node tests/resume-flow-check.cjs
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

const STAGE_MARKS = [
  ['界定者', 'scope'],
  ['你是科研统筹', 'plan'],
  ['第二层研究执行者', 'explore'],
  ['你已收到全部研究结果', 'screen'],
  ['实验设计者', 'design'],
  ['结果分析者', 'analyze'],
  ['最终反证与整合者', 'final'],
  ['终审复核者', 'audit']
];

function classify(payload) {
  for (const [mark, stage] of STAGE_MARKS) if (payload.includes(mark)) return stage;
  return 'unknown';
}

function answerFor(stage, round) {
  if (stage === 'scope') return JSON.stringify({ objective: '验证样本维度对矩阵迹的影响', questions: ['维度是否影响结果'], queries: ['matrix trace'], inclusion: ['公开'], exclusion: ['私有'] });
  if (stage === 'plan') return JSON.stringify({ objective: '设计最小可执行实验', tasks: [{ id: 'task-1', assignment: '确认执行链路', deliverable: '一次真实运行的指标', evidenceKeys: [] }], selectionCriteria: '能不能真跑出数字' });
  if (stage === 'explore') return '建议用执行环境自检模板做一次真实矩阵运算，拿 run.matrix_trace 作为可核对指标。';
  if (stage === 'screen') return JSON.stringify({ selectedIds: ['task-1'], refineIds: [], feedback: '', reason: '只有一个方向，直接做实验', unsupported: [] });
  if (stage === 'design') {
    return JSON.stringify({
      needed: true,
      reason: '需要一个真实数字来回答维度是否影响结果',
      hypothesis: '矩阵维度增大时迹会按比例变化',
      template: 'env-smoke',
      metric: 'run.matrix_trace',
      direction: 'maximize',
      baseline: { dim: 64, seed: 42, sleepSec: 0 },
      searchSpace: [],
      stopWhen: '拿到一次真实结果即可',
      risks: ['只是执行链路验证']
    });
  }
  if (stage === 'analyze') return JSON.stringify({ comparison: '维度 64 的真跑结果已拿到', continue: false, why: '单次已足够验证链路', conclusion: `第 ${round} 轮拿到了真实指标`, boundaries: ['只验证执行链路'] });
  if (stage === 'final') return `本轮实验已真跑：矩阵运算的迹见运行清单 [E1]。`;
  if (stage === 'audit') return JSON.stringify({ verdict: 'pass', fabrications: [], unsupported: [], fixes: [] });
  return '未识别阶段。';
}

function startModelServer() {
  const seen = [];
  const state = { designPayload: '' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    const payload = JSON.stringify(body.messages || body);
    const stage = classify(payload);
    seen.push(stage);
    if (stage === 'design') state.designPayload = payload;
    const answer = answerFor(stage, seen.length);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, state, port: server.address().port })));
}

(async () => {
  const { server, seen, state, port } = await startModelServer();
  const dataRoot = path.join(require('node:os').tmpdir(), `iris-resume-${process.pid}-${Date.now()}`);
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
  const until = async (expr, tries = 1200) => { for (let i = 0; i < tries; i++) { try { if (await js(expr)) return; } catch { /* bootstrap */ } await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await send('Runtime.enable', {});
    await until('!!document.querySelector("#prompt") && state.historyLoading === false');
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    const saved = await js(`window.duet.saveConnection(${JSON.stringify({
      name: 'Resume QA', model: 'resume-qa', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', allowNoKey: true,
      effortMode: 'none', enabled: true, maxTokens: 4096
    })})`);
    const conn = saved.settings.connections.find(c => c.name === 'Resume QA');
    assert.ok(conn, '连接没有保存成功');
    const pick = { provider: conn.id, model: 'resume-qa', effort: 'default' };

    /* 第一轮：实验关着，只给建议——正好复现用户遇到的那个场景 */
    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const modelConfig = { ...initial.settings.defaultModelConfig, ${JSON.stringify(conn.id)}: { model: 'resume-qa', effort: 'default' } };
      const base = initial.settings.defaultResearchConfig;
      const researchConfig = {
        ...base,
        version: 4, profile: 'p1-review', tier: 'readonly', allowRefinement: false,
        retrieval: { ...base.retrieval, enabled: false, sources: ['openalex'], maxQueries: 1, maxRecordsPerSource: 3 },
        choices: {
          scope: ${JSON.stringify(pick)}, evidence: ${JSON.stringify(pick)}, plan: ${JSON.stringify(pick)},
          screen: ${JSON.stringify(pick)}, final: ${JSON.stringify(pick)}, audit: null,
          experimentDesign: ${JSON.stringify(pick)}, experimentAnalyze: ${JSON.stringify(pick)}
        },
        tasks: [{ id: 'task-1', title: '执行链路验证', brief: '确认能真跑', choice: ${JSON.stringify(pick)} }],
        budget: { maxCalls: 12, wallClockSec: 600, modelTimeoutSec: 120, maxConcurrentModels: 2 },
        experiments: { enabled: false, maxTrials: 2, maxRounds: 1, templateId: 'env-smoke', stopWhen: '拿到一次真实结果' },
        monitor: { enabled: true }
      };
      return window.duet.create({ mode: 'research', models: [${JSON.stringify(conn.id)}], modelConfig, researchConfig });
    })()`);

    const id = conversation.id;
    /* send 只是发起，立即返回；真正的完成状态要轮询。 */
    const waitReply = async () => {
      for (let i = 0; i < 1800; i++) {
        const reply = await js(`(async()=>{const c=await window.duet.get(${JSON.stringify(id)});const m=c.messages.filter(x=>x.role==='assistant').at(-1);return m?{id:m.id,status:m.status,error:m.error,text:m.text,collaboration:m.collaboration}:null})()`);
        if (reply && reply.status !== 'streaming') return reply;
        await delay(100);
      }
      throw new Error('生成超时');
    };

    await js(`window.duet.send(${JSON.stringify(id)}, '维度会不会影响矩阵迹')`);
    const firstReply = await waitReply();
    assert.equal(firstReply.status, 'done', `第一轮没有跑完：${firstReply.status} ${firstReply.error || ''}`);
    assert.equal((firstReply.collaboration.experimentRuns || []).length, 0, '第一轮本不该跑实验');
    const firstCalls = seen.length;
    assert.ok(firstCalls >= 5, `第一轮应至少 5 次模型调用，实际 ${firstCalls}`);

    /* 第二轮：走界面按钮，不直接调 IPC——按钮是用户真正会点的那个入口。
       confirm 是原生模态框，会卡住渲染进程的自动化，所以先把它替换成「确认」。 */
    await js(`openThread(${JSON.stringify(id)})`);
    await js(`!!document.querySelector('[data-reply="' + ${JSON.stringify(firstReply.id)} + '"]')`);
    const buttonBefore = await js(`!!document.querySelector('[data-reply="${firstReply.id}"] [data-run-experiment]')`);
    assert.equal(buttonBefore, true, '第一轮给了实验建议却没有「执行实验」按钮');
    const hintBefore = await js(`!document.querySelector('#resume-hint').classList.contains('hidden')`);
    assert.equal(hintBefore, true, '输入框上方没有提示「上一轮的实验还没执行」');

    /* 点按钮只应打开「执行哪一个方案」，不能直接开跑 */
    await js(`document.querySelector('#resume-run-button').click(); true`);
    await until(`document.querySelector('#experiment-choice-dialog').open === true`);
    const callsWhileDialogOpen = seen.length;
    assert.equal(callsWhileDialogOpen, firstCalls, '打开方案对话框时就发了请求，不该发生');

    /* 答案里的编号方案能被认出来，点一下填进文本框 */
    const parsed = await js(`experimentOptionsFrom(${JSON.stringify('## 5. 验证实验设计与优先级\n\n1. 是否稳定：同族多尺寸、匹配示例\n2. 是否跨任务：同设计测常识与单步\n3. 是否依赖分解：等计算预算对照')})`);
    assert.deepEqual(parsed.map(item => item.index), [1, 2, 3], `编号方案解析不对：${JSON.stringify(parsed)}`);

    /* 不写方案直接确认 → 必须被挡下 */
    await js(`(() => { const box = document.querySelector('#experiment-choice-text'); box.value = ''; return true; })()`);
    await js(`document.querySelector('#experiment-choice-form button[type="submit"]').click(); true`);
    await delay(300);
    assert.equal(seen.length, firstCalls, '没写明方案却开始跑了');
    const statusText = await js(`document.querySelector('#experiment-choice-status').textContent`);
    assert.ok(statusText.includes('请写清'), `没写方案时的提示不对：${statusText}`);

    /* 明确写下方案 → 才执行 */
    const PLAN = '执行第 2 个：同等计算预算下正确分解与打乱步骤的对照';
    await js(`(() => { document.querySelector('#experiment-choice-text').value = ${JSON.stringify(PLAN)}; return true; })()`);
    await js(`document.querySelector('#experiment-choice-form button[type="submit"]').click(); true`);
    const secondReply = await waitReply();
    const run = secondReply.collaboration;
    assert.equal(secondReply.status, 'done', `第二轮没有跑完：${secondReply.status} ${secondReply.error || ''}`);

    const resumedStages = run.stages.map(s => s.id);
    assert.deepEqual(resumedStages, ['experiment-design', 'experiment-build', 'experiment-run', 'experiment-analyze', 'experiment-report', 'research-final', 'research-verify', 'research-audit'], `第二轮阶段不对：${JSON.stringify(resumedStages)}`);

    const carried = run.skippedStages || [];
    for (const node of ['research-scope', 'research-sources', 'research-evidence', 'research-plan', 'research-explore', 'research-screen']) {
      assert.ok(carried.includes(node), `前序环节没有被标成沿用：${node}`);
    }

    /* 关键断言：第二轮一次都没碰前面的阶段 */
    const secondRoundStages = seen.slice(firstCalls);
    assert.deepEqual(secondRoundStages.filter(stage => ['scope', 'plan', 'explore', 'screen'].includes(stage)), [], `第二轮重跑了前序阶段：${JSON.stringify(secondRoundStages)}`);
    assert.ok(secondRoundStages.includes('design'), `第二轮没有做实验设计：${JSON.stringify(secondRoundStages)}`);
    assert.ok(secondRoundStages.includes('final'), `第二轮没有整合：${JSON.stringify(secondRoundStages)}`);
    assert.ok(secondRoundStages.length <= 3, `第二轮模型调用过多（应只有设计/分析/整合）：${JSON.stringify(secondRoundStages)}`);

    /* 实验真的跑了 */
    assert.ok((run.experimentRuns || []).length >= 1, '第二轮没有产生运行记录');
    assert.ok(run.experimentRuns[0].runId, '运行记录没有 runId');
    assert.ok(secondReply.text.includes('[E1]'), `答案没有引用实验运行：${secondReply.text.slice(0, 120)}`);

    /* 上一轮的筛选结论与任务分解被沿用，不是空的 */
    assert.ok(run.selection && run.selection.reason, `第二轮没有沿用上一轮的筛选结论：${JSON.stringify(run.selection)}`);
    assert.ok(run.plan && run.plan.objective, `第二轮没有沿用上一轮的任务分解：${JSON.stringify(run.plan)}`);
    /* 第一轮没启用检索（materials-available=false），所以两轮都没有证据——沿用不能凭空造出一个 */
    assert.equal(!!run.evidence, false, `没有资料的轮次不该凭空多出证据：${JSON.stringify(run.evidence)}`);

    /* 用户点名的方案必须原样进了实验设计的输入 */
    assert.ok(state.designPayload.includes(PLAN), '实验设计没有收到用户指定的方案');

    /* 沿用配置没有写回对话配置：第三轮追问应该还是完整研究 */
    const stored = await js(`(async()=>{ const c = await window.duet.get(${JSON.stringify(id)}); return { resume: c.researchConfig && c.researchConfig.resume, experiments: c.researchConfig && c.researchConfig.experiments }; })()`);
    assert.ok(!stored.resume, `沿用标记被写进了对话配置：${JSON.stringify(stored.resume)}`);
    assert.equal(stored.experiments?.enabled, false, `对话配置的实验开关被改掉了：${JSON.stringify(stored.experiments)}`);

    /* 跑过实验的轮次不该再出现「执行实验」按钮，提示条也该收起来 */
    await js(`openThread(${JSON.stringify(id)})`);
    const buttonAfter = await js(`!!document.querySelector('[data-reply="${secondReply.id}"] [data-run-experiment]')`);
    assert.equal(buttonAfter, false, '已经跑过实验的轮次不该再有「执行实验」按钮');
    const hintAfter = await js(`!document.querySelector('#resume-hint').classList.contains('hidden')`);
    assert.equal(hintAfter, false, '实验跑完后提示条不该还挂着');

    console.log(JSON.stringify({
      passed: true,
      firstCalls,
      secondCalls: secondRoundStages.length,
      firstRoundStages: seen.slice(0, firstCalls),
      secondRoundStages,
      experimentRuns: run.experimentRuns.length,
      answerChars: secondReply.text.length
    }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    server.close();
    await delay(300);
    try { require('node:fs').rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 占用 */ }
  }
})().catch(error => { console.error(JSON.stringify({ passed: false, error: String(error?.message || error) })); process.exitCode = 1; });
