/* Visual/accessibility check for the DeepSeek Desktop alignment layer.
   Launches the dev app against isolated test data, screenshots the key states
   in both themes, runs axe, and asserts the design tokens actually applied.
   It never sends a message to a model. */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const packagedExe = process.env.DSH_CHECK_EXE || '';
const artifacts = path.join(root, 'artifacts');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

async function launch() {
  const port = await freePort();
  const child = packagedExe
    ? spawn(packagedExe, ['--verification-profile', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: path.dirname(packagedExe), stdio: 'ignore', windowsHide: true })
    : spawn(electron, ['.', '--verification-profile', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, stdio: 'ignore', windowsHide: true });
  let target;
  for (let i = 0; i < 200; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* starting */ }
    await delay(100);
  }
  if (!target) throw new Error('renderer did not start');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const msg = JSON.parse(event.data); const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, tries = 600) => { for (let i = 0; i < tries; i++) { if (await js(expression)) return; await delay(100); } throw new Error('timed out: ' + expression); };
  const capture = async name => {
    await delay(280);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, name), Buffer.from(shot.data, 'base64'));
    return name;
  };
  return { child, socket, send, js, until, capture };
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  /* Seed the isolated profile with one real saved cooperative run so the
     collaboration record is rendered from genuine data. */
  const profile = packagedExe ? path.join(path.dirname(packagedExe), '.verification-profile') : path.join(root, '.verification-profile');
  await fs.mkdir(profile, { recursive: true });
  const live = JSON.parse(await fs.readFile(path.join(root, '.test-data/v3-ui/conversations.json'), 'utf8'));
  const real = live.conversations.find(c => c.messages.some(m => m.collaboration?.status === 'done' && m.collaboration.artifacts?.length === 8));
  if (real) await fs.writeFile(path.join(profile, 'conversations.json'), JSON.stringify({ version: 3, conversations: [real], workspaces: [] }, null, 2));
  const app = await launch();
  const report = { stages: [], audits: [] };
  try {
    await app.until('!!document.querySelector(".welcome") && state.historyLoading === false');
    await app.send('Page.enable', {});
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1380, height: 920, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await app.js('window.__irisErrors'), [], 'startup errors');

    const axe = await fs.readFile(path.join(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
    await app.js(axe + '; true');

    const audit = async stage => {
      const result = await app.js('axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]}}).then(r=>({violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),passes:r.passes.length}))');
      report.audits.push({ stage, violations: result.violations.length, ids: result.violations.map(v => v.id), passes: result.passes });
      if (result.violations.length) throw new Error(stage + ': ' + JSON.stringify(result.violations, null, 2));
    };
    const theme = async value => {
      await app.js(`window.duetTheme.set(${JSON.stringify(value)});renderTheme();true`);
      assert.equal(await app.js('document.documentElement.dataset.theme'), value);
      await delay(200);
    };

    /* --- token presence: the palette must actually come from tokens.css --- */
    await app.js('window.duetTheme.set("light");renderTheme();true');
    await delay(220);
    const tokens = await app.js(`(()=>{const r=getComputedStyle(document.documentElement);const q=(n)=>r.getPropertyValue(n).trim();return {
      ink:q('--ink'), secondary:q('--secondary'), muted:q('--muted'), sidebar:q('--sidebar'), bubble:q('--bubble'), accent:q('--accent'),
      radiusBubble:q('--radius-bubble'), radiusXl:q('--radius-xl'), ease:q('--ease'), bodyFont:getComputedStyle(document.body).fontFamily,
      sidebarBg:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
      bubbleBg:getComputedStyle(document.querySelector('.new-chat')).backgroundColor,
      newChatHeight:getComputedStyle(document.querySelector('.new-chat')).height,
      newChatRadius:getComputedStyle(document.querySelector('.new-chat')).borderRadius}})()`);
    report.tokens = tokens;
    assert.equal(tokens.sidebarBg, 'rgb(249, 250, 251)', 'sidebar uses DeepSeek bluish-50');
    assert.equal(tokens.newChatHeight, '38px', 'new session button height');
    assert.equal(tokens.newChatRadius, '12px', 'new session button radius');
    assert.ok(tokens.bodyFont.includes('PingFang SC') && tokens.bodyFont.includes('Microsoft YaHei'), 'DeepSeek font stack');

    await theme('light');
    report.stages.push(await app.capture('dsh-welcome-light.png'));
    await audit('light welcome');
    await theme('dark');
    report.stages.push(await app.capture('dsh-welcome-dark.png'));
    await audit('dark welcome');

    /* --- a real conversation rendered with the new reading ladder --- */
    await theme('light');
    const created = await app.js('(async()=>{const initial=await window.duet.init();return window.duet.create({ models:["deepseek","gpt"], modelConfig: initial.settings.defaultModelConfig })})()');
    await app.js(`refreshLocal()`);
    await app.js(`openThread(${JSON.stringify(created.id)})`);
    await app.until('!!document.querySelector("#prompt")');
    const rich = '## 结论\n\n先给判断，再补依据。**关键结论**应当一眼可见。\n\n- 多模型协作只输出一份最终答案。\n- 公开大纲默认收起。\n\n| 能力 | 状态 |\n| --- | --- |\n| 工作区 | 已支持 |\n| 科研模式 | 已支持 |\n\n```js\nconst answer = await duet.ask(question);\n```\n\n> 引用块用于补充说明。\n\n[参考链接](https://example.com)';
    await app.js(`(()=>{
      state.active.messages = [
        { role: 'user', text: '用不超过 80 字解释多模型协作的作用，并给出一个表格。', status: 'done', createdAt: Date.now() - 65000 },
        { role: 'assistant', text: ${JSON.stringify(rich)}, status: 'done', provider: 'gpt', model: 'gpt-5.1-codex', effort: 'medium', createdAt: Date.now() }
      ];
      renderMessages();
      return true;
    })()`);
    await app.until('!!document.querySelector(".reply-body.markdown-table, .reply-body .markdown-table")');
    const ladder = await app.js(`(()=>{const b=document.querySelector('.reply-body');const h2=b.querySelector('h2');
      return { body:getComputedStyle(b).fontSize+'/'+getComputedStyle(b).lineHeight, h2:getComputedStyle(h2).fontSize+'/'+getComputedStyle(h2).lineHeight+' w'+getComputedStyle(h2).fontWeight,
        bubble:getComputedStyle(document.querySelector('.user-text')).backgroundColor,
        bubbleRadius:getComputedStyle(document.querySelector('.user-text')).borderRadius,
        link:getComputedStyle(b.querySelector('a')).color,
        code:getComputedStyle(b.querySelector('code')).borderRadius }})()`);
    report.ladder = ladder;
    assert.equal(ladder.body, '14px/24px', 'reading body follows the DeepSeek ladder');
    assert.equal(ladder.h2, '19px/28px w700', 'h2 follows the DeepSeek ladder');
    assert.equal(ladder.bubble, 'rgb(237, 243, 254)', 'user bubble uses DeepSeek blue tint');
    assert.equal(ladder.bubbleRadius, '22px', 'user bubble radius');
    report.stages.push(await app.capture('dsh-answer-light.png'));
    await audit('light answer');
    await theme('dark');
    report.stages.push(await app.capture('dsh-answer-dark.png'));
    await audit('dark answer');

    /* --- model controls: capsule chips and the Power overlay --- */
    await theme('light');
    await app.js('document.querySelector("[data-model-options=gpt]").click();true');
    await app.until('!document.querySelector("#model-popover").classList.contains("hidden")');
    await delay(400);
    const popover = await app.js(`(()=>{const p=document.querySelector('#model-popover');const chip=document.querySelector('[data-model=gpt]');
      return { radius:getComputedStyle(p).borderRadius, shadow:getComputedStyle(p).boxShadow.length>10, chipHeight:getComputedStyle(document.querySelector('.model-chip')).height,
        chipRadius:getComputedStyle(document.querySelector('.model-chip')).borderRadius, sendRadius:getComputedStyle(document.querySelector('#send-button')).borderRadius }})()`);
    report.popover = popover;
    report.popoverStyle = await app.js(`(()=>{const p=document.querySelector('#model-popover');const s=getComputedStyle(p);
      const chain=[];for(let e=p;e&&e!==document.body;e=e.parentElement){const cs=getComputedStyle(e);chain.push({tag:e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+e.className.split(' ').join('.'):''),bg:cs.backgroundColor,opacity:cs.opacity,overflow:cs.overflow,filter:cs.filter,z:cs.zIndex,position:cs.position});}
      return {bg:s.backgroundColor, opacity:s.opacity, classes:p.className, inline:p.getAttribute('style'), chain}})()`);
    assert.equal(popover.radius, '20px', 'popover radius');
    assert.equal(popover.chipRadius, '999px', 'model chip is a capsule');
    assert.ok(['50%', '999px', '34px'].includes(popover.sendRadius), 'send button stays circular: ' + popover.sendRadius);
    report.stages.push(await app.capture('dsh-power-light.png'));
    await audit('light power popover');
    await theme('dark');
    report.stages.push(await app.capture('dsh-power-dark.png'));
    await audit('dark power popover');
    await app.js('document.querySelector("[data-model-options=gpt]").click();true');

    /* --- the real saved cooperative run: collapsed then expanded record --- */
    await theme('light');
    assert.ok(real, 'a real completed cooperative run exists in the test data');
    await app.js('refreshLocal();true');
    await app.js(`openThread(${JSON.stringify(real.id)})`);
    await app.until('!!document.querySelector(".process-details")');
    assert.equal(await app.js('document.querySelector(".process-details").open'), false, 'public record starts collapsed');
    report.stages.push(await app.capture('dsh-process-collapsed-light.png'));
    await audit('light collaboration collapsed');
    await app.js('document.querySelector(".process-details>summary").click();true');
    await app.until('document.querySelectorAll(".process-artifact").length === 8');
    report.stages.push(await app.capture('dsh-process-expanded-light.png'));
    await audit('light collaboration expanded');
    await theme('dark');
    report.stages.push(await app.capture('dsh-process-expanded-dark.png'));
    await audit('dark collaboration expanded');
    await app.js('document.querySelector(".process-details>summary").click();true');

    /* --- workspace library and settings --- */
    await theme('light');
    await app.js('document.querySelector("#nav-workspaces").click();true');
    await app.until('document.querySelectorAll(".workspace-card").length > 0');
    report.stages.push(await app.capture('dsh-workspaces-light.png'));
    await audit('light workspaces');
    await app.js('document.querySelector("#settings-button").click();true');
    await app.until('document.querySelector("#settings-dialog").open');
    report.stages.push(await app.capture('dsh-settings-light.png'));
    await audit('light settings');
    await theme('dark');
    report.stages.push(await app.capture('dsh-settings-dark.png'));
    await audit('dark settings');
    await app.js('document.querySelector("#settings-dialog .dialog-close").click();true');

    /* --- 科研流程配置：每个环节都能选模型 + 检索设置 --- */
    await theme('light');
    await app.js('document.querySelector("#new-chat").click();true');
    await app.js('document.querySelector("[data-run-mode=research]").click();true');
    await app.until('!document.querySelector("#research-config-button").classList.contains("hidden")');
    await app.js('document.querySelector("#research-config-button").click();true');
    await app.until('document.querySelector("#research-dialog").open');
    const researchForm = await app.js(`(()=>{
      const dlg=document.querySelector('#research-dialog');
      const stages=[...dlg.querySelectorAll('[data-research-choice]')].map(s=>s.dataset.researchChoice);
      const sources=[...dlg.querySelectorAll('[data-source]')].map(s=>s.dataset.source);
      return { stages, sources, budgetMin:Number(dlg.querySelector('#research-budget').min), budgetMax:Number(dlg.querySelector('#research-budget').max), monitor:!!dlg.querySelector('#monitor-enabled'), minCalls:dlg.querySelector('#research-min-calls').textContent };
    })()`);
    report.researchForm = researchForm;
    for (const key of ['scope', 'evidence', 'plan', 'screen', 'final', 'audit']) assert.ok(researchForm.stages.includes(key), '科研环节缺少可选的模型：' + key);
    assert.ok(researchForm.sources.length === 4, '四个检索源都应可勾选');
    assert.equal(researchForm.budgetMax, 24, '调用预算上限');
    assert.ok(researchForm.monitor, '监控开关应存在');
    report.stages.push(await app.capture('dsh-research-config-light.png'));
    await audit('light research config');
    await theme('dark');
    report.stages.push(await app.capture('dsh-research-config-dark.png'));
    await audit('dark research config');
    await app.js('document.querySelector("#research-dialog .dialog-close").click();true');

    /* --- 实验执行面板：模板与参数控件 --- */
    await theme('light');
    await app.js('document.querySelector("#exec-button").click();true');
    await app.until('document.querySelector("#exec-dialog").open && document.querySelectorAll("#exec-template option").length > 0');
    const execForm = await app.js(`(() => {
      const dlg = document.querySelector('#exec-dialog');
      return {
        templates: [...dlg.querySelectorAll('#exec-template option')].map(o => ({ id: o.value, disabled: o.disabled })),
        params: [...dlg.querySelectorAll('[data-exec-param]')].map(i => i.dataset.execParam),
        hasLog: !!dlg.querySelector('#exec-log'),
        hasMetrics: !!dlg.querySelector('#exec-metrics'),
        env: dlg.querySelector('#exec-env-status').textContent.trim()
      };
    })()`);
    report.execForm = execForm;
    assert.ok(execForm.templates.length >= 2, '至少两个实验模板');
    assert.ok(execForm.templates.some(t => t.disabled), '未实现的模板必须禁用');
    assert.ok(execForm.params.length >= 3, '参数控件应由模板声明生成');
    assert.ok(execForm.hasLog && execForm.hasMetrics, '日志与指标区都应存在');
    report.stages.push(await app.capture('dsh-exec-light.png'));
    await audit('light exec dialog');
    await theme('dark');
    report.stages.push(await app.capture('dsh-exec-dark.png'));
    await audit('dark exec dialog');
    await app.js('document.querySelector("#exec-dialog .dialog-close").click();true');

    /* --- 连接对话框：服务商预设 --- */
    await theme('light');
    await app.js('document.querySelector("#settings-button").click();true');
    await app.until('document.querySelector("#settings-dialog").open');
    await app.js('document.querySelector("#add-connection").click();true');
    await app.until('document.querySelector("#connection-dialog").open');
    const presetCount = await app.js('document.querySelectorAll("#connection-preset option").length');
    report.presetCount = presetCount;
    assert.ok(presetCount >= 12, '服务商预设数量：' + presetCount);
    report.stages.push(await app.capture('dsh-connection-light.png'));
    await audit('light connection dialog');
    await app.js('document.querySelector("#connection-dialog .dialog-close").click();document.querySelector("#settings-dialog .dialog-close").click();true');

    /* --- 新增 IPC 通道必须真的可用 --- */
    const ipc = await app.js(`(async()=>{
      const out={};
      out.search=Array.isArray(await window.duet.search('测试')) ? 'array' : 'not-array';
      out.knowledge=typeof (await window.duet.knowledge(${JSON.stringify(created.id)})).stats === 'object';
      try { await window.duet.modelList({ baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', allowNoKey: true }); out.modelList='unexpected-success'; }
      catch (e) { out.modelList=/拉取模型列表失败|检查地址/.test(String(e.message)) ? 'clear-error' : 'unclear-error:' + String(e.message).slice(0, 60); }
      out.deleted=(await window.duet.deleteThread(${JSON.stringify(created.id)})).id === ${JSON.stringify(created.id)};
      out.afterDelete=(await window.duet.list()).some(c=>c.id===${JSON.stringify(created.id)});
      return out;
    })()`);
    report.ipc = ipc;
    assert.equal(ipc.search, 'array', 'duet:search 应返回数组');
    assert.equal(ipc.knowledge, true, 'duet:knowledge 应返回统计');
    assert.equal(ipc.modelList, 'clear-error', '模型列表失败要给出可读错误：' + ipc.modelList);
    assert.equal(ipc.deleted, true, '删除应返回被删对象');
    assert.equal(ipc.afterDelete, false, '删除后列表里不应再有它');

    /* --- narrow layouts must not overflow --- */
    for (const width of [768, 320]) {
      await app.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await delay(300);
      const narrow = await app.js('({scrollWidth:document.documentElement.scrollWidth,width:innerWidth,sendRight:document.querySelector("#send-button").getBoundingClientRect().right})');
      report[`narrow${width}`] = narrow;
      assert.ok(narrow.scrollWidth <= narrow.width + 1, `no horizontal overflow at ${width}px: ` + JSON.stringify(narrow));
      assert.ok(narrow.sendRight <= narrow.width, `send button inside viewport at ${width}px`);
      report.stages.push(await app.capture(`dsh-narrow-${width}.png`));
    }

    report.passed = true;
  } finally {
    try { app.socket.close(); } catch { /* closed */ }
    app.child.kill();
  }
  await fs.writeFile(path.join(artifacts, 'dsh-ui-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages, audits: report.audits.map(a => a.stage + ':' + a.violations), ladder: report.ladder, tokens: { sidebarBg: report.tokens.sidebarBg, ink: report.tokens.ink } }, null, 2));
})().catch(error => { console.error('FAILED:', error.message); process.exitCode = 1; });
