/* 运行中阶段的排版体检：量出溢出宽度、每格实际宽度与被裁掉的文字。
 * 临时诊断脚本：node tests/ui-run-shots.cjs [宽度...]
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const STAGES = [
  ['research-scope', '研究界定'], ['research-sources', '资料检索'], ['research-evidence', '证据提取'],
  ['research-summarize', '要点汇总'], ['research-plan', '问题分解'], ['research-explore', '并行研究'],
  ['research-screen', '候选筛选'], ['research-refine', '定向深化'], ['experiment-design', '实验设计'],
  ['experiment-build', '实验程序'], ['experiment-run', '训练与评估'], ['experiment-analyze', '结果分析'],
  ['experiment-report', '实验记录'], ['research-final', '反证与整合'], ['research-verify', '引用核验'],
  ['research-audit', '终审自检']
];

const RUN = {
  version: 4, mode: 'research', status: 'running', profile: 'p1-review', profileName: '综述', tier: 'P1',
  stage: 'research-explore', stageLabel: '并行研究', stageIndex: 6, totalStages: 16,
  stages: STAGES.map(([id, label]) => ({ id, label, kind: 'model', phase: '推演' })),
  completedTasks: 1, totalTasks: 3, startedAt: Date.now() - 95000, finishedAt: null,
  participants: [], artifacts: [
    { id: 'a1', stage: 'research-evidence', stageLabel: '证据提取', kind: 'public-work', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: '抽到 7 条结论，8 处缺口：样本量、任务族覆盖、提示格式可比性。', startedAt: Date.now() - 90000, finishedAt: Date.now() - 80000 }
  ],
  writer: 'deepseek', plan: null, selection: null, scope: null, knowledge: { total: 42 }, integrity: null,
  callsUsed: 7, callBudget: 16, baseCalls: 10, reserve: 2, budgetLimit: 16, skippedStages: ['research-refine']
};

(async () => {
  const dataRoot = path.join(os.tmpdir(), `iris-ui-shots-${process.pid}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'conversations.json'), JSON.stringify({ version: 3, workspaces: [], conversations: [] }), 'utf8');

  const dbg = await freePort();
  const child = spawn(electron, ['.', `--user-data-dir=${path.join(dataRoot, 'chromium')}`, `--remote-debugging-port=${dbg}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: root, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, IRIS_DATA_ROOT: dataRoot }
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
  const widths = process.argv.slice(2).map(Number).filter(Boolean);
  const sizes = widths.length ? widths : [1440, 1200, 1024, 900];

  try {
    await send('Runtime.enable', {});
    await send('Page.enable', {});
    await until(`!!document.querySelector('#run-status') && state.historyLoading === false`);
    await js(`state.settings.pricing = { deepseek: { input: 2, output: 8, currency: 'CNY' } }; state.active = { id: 'ui-run', title: '阶段列表排版体检', source: 'local', models: ['deepseek'], createdAt: Date.now() - 100000, updatedAt: Date.now(), messages: [{ id: 'u1', role: 'user', text: '测试运行中阶段列表在各宽度下的排版', roundId: 'r1', timestamp: Date.now() - 99000 }, { id: 'a1', role: 'assistant', kind: 'answer', provider: 'deepseek', model: 'deepseek-chat', text: '', status: 'streaming', roundId: 'r1', timestamp: Date.now() - 98000, usage: { calls: 7, input: 121234, output: 31234, total: 152468, reported: 7, parts: { 'deepseek:deepseek-chat': { input: 121234, output: 31234 } } }, collaboration: ${JSON.stringify(RUN)} }] }; state.view = 'chat'; renderChat(); true`);
    await delay(500);

    const report = [];
    for (const width of sizes) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await delay(350);
      /* 等两帧再量：状态区会被计时器按秒重建，刚插入的元素这一帧还没完成布局。 */
      await js(`new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))`);
      const metrics = await js(`(() => {
        const flow = document.querySelector('.stage-flow');
        if (!flow) return { missing: true };
        const box = flow.getBoundingClientRect();
        const items = [...flow.children].map((li, index) => {
          const r = li.getBoundingClientRect();
          const label = li.textContent.trim();
          return { index, label, width: Math.round(r.width), height: Math.round(r.height), clipped: li.scrollWidth > li.clientWidth + 1, top: Math.round(r.top) };
        });
        const heading = document.querySelector('.run-heading');
        const status = document.querySelector('#run-status');
        const footer = document.querySelector('.reply-footer');
        const bar = document.querySelector('.run-progress');
        const fill = bar ? bar.firstElementChild : null;
        return {
          viewport: window.innerWidth,
          flowWidth: Math.round(box.width),
          flowScroll: flow.scrollWidth,
          flowRows: new Set(items.map(i => i.top)).size,
          overflowX: flow.scrollWidth > flow.clientWidth + 1,
          bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          rows: items,
          headingWidth: heading ? Math.round(heading.getBoundingClientRect().width) : null,
          headingScroll: heading ? heading.scrollWidth : null,
          headingOverflow: heading ? heading.scrollWidth > heading.clientWidth + 1 : null,
          headingText: heading ? heading.textContent.trim() : null,
          footerOverflow: footer ? footer.scrollWidth > footer.clientWidth + 1 : null,
          footerText: footer ? footer.textContent.trim() : null,
          progressTrack: bar ? Math.round(bar.getBoundingClientRect().width) : null,
          progressFill: fill ? Math.round(fill.getBoundingClientRect().width) : null,
          progressRatio: bar && fill ? Number((fill.getBoundingClientRect().width / bar.getBoundingClientRect().width).toFixed(3)) : null,
          progressAria: bar ? bar.getAttribute('aria-valuenow') : null,
          progressSegments: bar ? bar.children.length : null,
          progressDone: bar ? bar.querySelectorAll('i.done').length : null,
          progressActive: bar ? bar.querySelectorAll('i.active').length : null,
          progressSkipped: bar ? bar.querySelectorAll('i.skipped').length : null,
          fillComputed: fill ? getComputedStyle(fill).width : null,
          fillDisplay: fill ? getComputedStyle(fill).display : null,
          trackDisplay: bar ? getComputedStyle(bar).display : null,
          statusHeight: status ? Math.round(status.getBoundingClientRect().height) : null
        };
      })()`);
      report.push({ width, ...metrics });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `run-status-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(JSON.stringify({ passed: true, outDir, report }, null, 1));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    await delay(300);
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 占用 */ }
  }
})().catch(error => { console.error(JSON.stringify({ passed: false, error: String(error?.message || error) })); process.exitCode = 1; });
