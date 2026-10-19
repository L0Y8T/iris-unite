// 验证新增的 duet:profiles / duet:plan 两个通道在真实应用里可用（纯计算，不发模型请求）。
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(r => setTimeout(r, ms));
const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

(async () => {
  const port = await freePort();
  const child = spawn(electron, ['.', '--verification-profile', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, stdio: 'ignore', windowsHide: true });
  let target;
  for (let i = 0; i < 200; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* 启动中 */ }
    await delay(100);
  }
  if (!target) throw new Error('渲染进程未启动');
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
  const until = async (expr, tries = 400) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await until('!!document.querySelector(".welcome") && state.historyLoading === false');

    const meta = await js('window.duet.profiles()');
    console.log('profiles:', JSON.stringify(meta.ids), '| 档位名:', meta.info.map(i => i.name).join('/'));
    assert.deepEqual(meta.ids, ['p0-query', 'p1-review', 'p2-teach']);
    assert.equal(meta.info.find(i => i.id === 'p0-query').retrievalRequired, true);

    // 默认配置（v3）走计划预览：应能编译并给出 p1-review 的计划
    const preview = await js('window.duet.plan({})');
    console.log('默认配置预览:', JSON.stringify({ ok: preview.ok, profile: preview.profile, base: preview.baseCalls, max: preview.maxCalls, reserve: preview.reserve, stages: preview.stages && preview.stages.length, migrated: preview.migration && preview.migration.from }));
    assert.equal(preview.ok, true, '计划编译应成功：' + JSON.stringify(preview.readiness && preview.readiness.problems));
    assert.equal(preview.profile, 'p1-review');
    assert.equal(preview.reserve, 1);
    assert.ok(preview.stages.length > 5, 'P1 应包含完整环节');
    /* 实验族是计划里的正式节点：默认开启时应能看到这五个环节，且训练评估是 exec 类型。 */
    const stageIds = preview.stages.map(s => s.id);
    for (const id of ['experiment-design', 'experiment-build', 'experiment-run', 'experiment-analyze', 'experiment-report']) {
      assert.ok(stageIds.includes(id), '默认配置的计划里应有 ' + id);
    }
    assert.equal(preview.stages.find(s => s.id === 'experiment-run').type, 'exec');
    assert.equal(preview.baseCalls, 10, '默认含实验族：N=2 有检索 7 + 设计 1 + 分析 2');

    // 关掉实验：节点仍在计划里但会被条件跳过，基准回到 7
    const noExp = await js(`(async()=>{const initial = await window.duet.init();const cfg = JSON.parse(JSON.stringify(initial.settings.defaultResearchConfig));cfg.experiments = { ...(cfg.experiments||{}), enabled: false };return window.duet.plan({ config: cfg })})()`);
    assert.equal(noExp.baseCalls, 7, '关掉实验后基准应回到 7');
    assert.ok(noExp.stages.some(s => s.id === 'experiment-run' && s.condition === 'experiments-enabled'), '实验节点应保留并带条件');

    // 直接给一个 v4 的 P0 配置：应为 3 次基准、无 explore
    const p0 = await js(`window.duet.plan({ config: ${JSON.stringify({
      version: 4, profile: 'p0-query', tier: 'readonly',
      choices: { scope: { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' }, evidence: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' }, summarize: { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' }, audit: null },
      tasks: [], allowRefinement: false,
      retrieval: { enabled: true, sources: ['openalex', 'arxiv'], maxQueries: 3, maxRecordsPerSource: 8, maxRecordsPerQuery: 8, maxRecordsPerRun: 240, maxRequests: 20, maxRetriesPerRequest: 1, yearFrom: null, yearTo: null, reusePolicy: 'explicit-selection' },
      evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
      budget: { maxCalls: 3, wallClockSec: 300, modelTimeoutSec: 120, maxConcurrentModels: 2, maxModelRetryAttempts: 0, maxRepairAttempts: 0 },
      monitor: { enabled: true, stallPolicy: 'warn-then-stop' },
      output: { language: 'zh-CN', processPanelDefault: 'collapsed' }
    }) } })`);
    console.log('P0 预览:', JSON.stringify({ ok: p0.ok, base: p0.baseCalls, max: p0.maxCalls, stages: p0.stages && p0.stages.map(s => s.id), coverage: p0.effective && p0.effective.coverage }));
    assert.equal(p0.baseCalls, 3);
    assert.equal(p0.maxCalls, 3);
    assert.ok(!p0.stages.some(s => s.id === 'research-plan'), 'P0 不应有问题分解');
    assert.equal(p0.effective.coverage, 'full');

    // 非法配置要给出可读错误而不是崩
    const bad = await js('window.duet.plan({ config: { version: 4, profile: "p2-teach", tier: "local-exec" } })');
    console.log('非法 Tier:', JSON.stringify({ ok: bad.ok, error: bad.error }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /readonly/);

    console.log(JSON.stringify({ passed: true, profiles: meta.ids.length, p1Base: preview.baseCalls, p0Base: p0.baseCalls }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
