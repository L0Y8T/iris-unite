const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async (win, root, store) => {
  win.webContents.setBackgroundThrottling(false);
  const js = expression => win.webContents.executeJavaScript(expression, true);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (expression, timeout = 90000) => { const began = Date.now(); while (Date.now() - began < timeout) { if (await js(expression)) return; await delay(100); } throw new Error('Frontend timed out: ' + expression); };
  const artifacts = path.join(root, 'artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const capture = async name => {
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await delay(250);
    // 0.6.0 的暗色画布是 #151517（带一点蓝），不是中性灰，所以按通道逐个比，不能只比红通道。
    const samples = await js('(()=>{const rgb=e=>getComputedStyle(e).backgroundColor.match(/\\d+/g).slice(0,3).map(Number);const modal=Array.from(document.querySelectorAll("dialog[open]")).at(-1);if(modal){const r=modal.getBoundingClientRect();return [{x:r.left+16,y:r.top+Math.min(80,r.height/2),rgb:rgb(modal),selector:modal.id}]}const samples=[{x:innerWidth-20,y:160,rgb:rgb(document.querySelector(".main"))}];for(const selector of [".new-chat",".quick-prompts button"]){const e=document.querySelector(selector);if(!e||getComputedStyle(e).display==="none"||e.getBoundingClientRect().width===0)continue;const r=e.getBoundingClientRect();samples.push({x:r.right-8,y:r.top+r.height/2,rgb:rgb(e),selector})}return samples})()');
    let screenshot;
    for (let attempt = 0; attempt < 30; attempt++) {
      screenshot = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const size = screenshot.getSize(), bitmap = screenshot.toBitmap();
      const viewport = await js('({width:innerWidth,height:innerHeight})');
      const mismatches = samples.map(s => {
        const at = (Math.round(s.y * size.height / viewport.height) * size.width + Math.round(s.x * size.width / viewport.width)) * 4;
        // Electron 的 toBitmap() 在 Windows 上是 BGRA，不是 RGBA，取通道要倒过来。
        const actual = [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
        return { ...s, actual, off: actual.some((v, i) => Math.abs(v - s.rgb[i]) > 1) };
      }).filter(s => s.off);
      if (!mismatches.length) break;
      if (attempt === 29) throw new Error('Screenshot did not repaint to the current theme: ' + name + ' ' + JSON.stringify(mismatches));
      await delay(150);
    }
    await fs.writeFile(path.join(artifacts, name), screenshot.toPNG());
  };
  await until('!!document.querySelector(".welcome") && state.historyLoading === false');
  assert.deepEqual(await js('window.__irisErrors'), []);
  await js('window.__frontendErrors=[];window.addEventListener("error",e=>window.__frontendErrors.push(e.message));true');
  const initial = await js('window.duet.init()');
  for (const connection of initial.settings.connections || []) await js(`window.duet.removeConnection(${JSON.stringify(connection.id)}).then(applyConnectionResult)`);
  await js('state.researchConfig=clone(state.settings.defaultResearchConfig);true');
  assert.ok(initial.workspaces.length > 1); assert.equal(initial.settings.mode, undefined);
  const setTheme = async theme => {
    await js(`window.duetTheme.set(${JSON.stringify(theme)});renderTheme();true`);
    assert.equal(await js('document.documentElement.dataset.theme'), theme);
    assert.equal(await js('getComputedStyle(document.querySelector(".main")).backgroundColor'), theme === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)');
    await delay(180);
  };
  await js((await fs.readFile(path.join(root, 'node_modules/axe-core/axe.min.js'), 'utf8')) + ';true');
  const audits = [];
  const audit = async name => {
    const result = await js('axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa"]}}).then(r=>({violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),passes:r.passes.length}))');
    audits.push({ name, ...result });
    if (result.violations.length) { await fs.writeFile(path.join(artifacts, 'v5-a11y-failures.json'), JSON.stringify(audits, null, 2)); throw new Error(name + ': ' + JSON.stringify(result.violations)); }
  };
  await setTheme('light'); await capture('v5-welcome-light.png'); await audit('light welcome');
  assert.equal(await js('document.querySelector("#send-button").disabled'), true);
  await js('document.querySelector("[data-prompt]").click()');
  assert.equal(await js('document.querySelector("#send-button").disabled'), false);
  assert.ok(await js('document.querySelector("#prompt").value.length>5'));
  await js('document.querySelector("#prompt").value="";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));true');
  await setTheme('dark'); await capture('v5-welcome-dark.png'); await audit('dark welcome');
  const name = initial.modelCatalog.gpt.find(m => m.id === initial.settings.defaultModelConfig.gpt.model).name;
  assert.ok(await js(`document.querySelector('[data-model=gpt]').textContent.includes(${JSON.stringify(name)})`));
  await js('document.querySelector("[data-model-options=gpt]").click()');
  await until('document.activeElement.id==="power-slider"');
  const first = await js('Number(document.querySelector("#power-slider").value)');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
  await until('document.querySelector("#power-slider").value===document.querySelector("#power-slider").max');
  assert.ok(await js('document.querySelector("#power-slider").getAttribute("aria-valuetext").length>0'));
  await capture('v5-power-dark.png'); await audit('dark power');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until('document.activeElement.dataset.modelOptions==="gpt" && document.querySelector("#model-popover").classList.contains("hidden")');
  await js('document.querySelector("[data-model=gpt]").click();document.querySelector("[data-model=deepseek]").click()');
  await until('document.querySelector("#toast.visible")');
  assert.equal(await js('document.querySelector("#toast").textContent'), '至少使用一个模型');
  assert.equal(await js('document.querySelectorAll(".model-chip.selected").length'), 1);
  await delay(2900); assert.ok(await js('document.querySelector("#toast").classList.contains("hidden")'));
  await js('document.querySelector("[data-model=gpt]").click();document.querySelector("#nav-workspaces").click()');
  await until('document.querySelectorAll(".workspace-card").length>1');
  await setTheme('light'); await capture('v5-workspaces.png'); await audit('light workspaces');
  await js('document.querySelector("#new-chat").click();document.querySelector("#settings-button").click()');
  await until('document.querySelector("#settings-dialog").open'); await audit('light settings');
  await setTheme('dark'); await audit('dark settings');
  await js('document.querySelector("#settings-dialog .dialog-close").click()');
  const data = JSON.parse(await fs.readFile(path.join(root, '.test-data/v3-ui/conversations.json'), 'utf8'));
  const actual = data.conversations.find(c => c.messages.some(m => m.collaboration?.status === 'done' && m.collaboration.artifacts.length === 8));
  assert.ok(actual, 'Use the completed real cooperative run from the prior integration test');
  const copied = store.create({ title: actual.title, models: ['deepseek','gpt'], workspaceId: actual.workspaceId, cwd: actual.cwd, modelConfig: actual.modelConfig, messages: JSON.parse(JSON.stringify(actual.messages)) });
  await js('refreshLocal()'); await js(`openThread(${JSON.stringify(copied.id)})`);
  await until('!!document.querySelector(".process-details")');
  assert.equal(await js('document.querySelector(".process-details").open'), false);
  assert.equal(await js('document.querySelectorAll(".reply-card").length'), 1);
  await capture('v5-answer-dark.png'); await audit('dark answer');
  await js('document.querySelector(".process-details>summary").click()');
  await until('document.querySelectorAll(".process-artifact").length===8');
  await capture('v5-process-dark.png'); await audit('dark public process');
  await js('document.querySelector(".process-details>summary").click()');
  const richText = '## 让回答更容易阅读\n\n先说明结论，再给出依据。**重要内容**保持清楚的层次。\n\n- 保留原有工作区和历史。\n- 两个模型共同审查，最终只输出完整答案。\n\n| 功能 | 使用方式 |\n| --- | --- |\n| 模型强度 | 拖动 Power 滑块 |\n| 协作记录 | 按需展开 |\n\n```javascript\nconst answer = await duet.ask(question);\nconsole.log(answer);\n```\n\n> 大纲和评审默认收起。\n\n[查看参考](https://example.com)\n\n<script>window.__xss=true</script>\n\n[无效链接](javascript:alert(1))';
  await js(`state.active.messages.at(-1).text=${JSON.stringify(richText)};renderMessages();true`);
  assert.equal(await js('document.querySelectorAll(".markdown-table table th[scope=col]").length'), 2);
  assert.equal(await js('document.querySelectorAll(".code-block button[data-copy-code]").length'), 1);
  assert.equal(await js('document.querySelectorAll(".reply-body script,.reply-body [onclick],.reply-body a[href^=javascript]").length'), 0);
  assert.equal(await js('Boolean(window.__xss)'), false);
  await js('document.querySelector("[data-copy-code]").click()'); await until('document.querySelector("#toast.visible")');
  await capture('v5-markdown-dark.png'); await audit('dark rich answer');
  await setTheme('light'); await capture('v5-markdown-light.png'); await audit('light rich answer');
  await js('state.active.messages.at(-1).collaboration.status="running";state.active.messages.at(-1).collaboration.stage="synthesis";state.active.messages.at(-1).collaboration.stageLabel="综合大纲";state.active.messages.at(-1).collaboration.stageIndex=3;state.active.messages.at(-1).collaboration.completedTasks=1;state.active.messages.at(-1).collaboration.totalTasks=2;state.active.messages.at(-1).status="streaming";state.busy.add(state.active.id);renderChat();true');
  assert.equal(await js('document.querySelectorAll(".stage-flow li").length'), 5);
  assert.equal(await js('document.querySelector(".stage-flow [aria-current=step]").textContent.includes("综合大纲")'), true);
  await capture('v5-stage-progress.png'); await audit('light running');
  await js('state.busy.delete(state.active.id);state.active.messages.at(-1).status="error";state.active.messages.at(-1).error="网络连接中断，请检查连接后重新发送。";state.active.messages.at(-1).collaboration.status="error";renderChat();true');
  await audit('light error');
  await js('document.querySelector("#new-chat").click()');
  /* 联调脚本会发起真实模型请求（消耗额度），默认不跑。
     设 IRIS_LIVE_TEST=1 才启用；0.6.0 起 iris-ui-check 的科研断言尚未按 10 环节重写，
     所以它现在即使打开也会失败——这是已知的、明确标注的缺口，不是被静默跳过。 */
  if (process.env.IRIS_LIVE_TEST === '1') {
    const irisChecks = await require('./iris-ui-check.cjs').run({win,root,js,until,capture,audit});
    globalThis.__irisChecks = irisChecks;
  } else {
    console.log('[skip] iris-ui-check（真实模型联调）未执行：设置 IRIS_LIVE_TEST=1 才运行。');
  }
  win.setMinimumSize(320, 560);
  const widths = [1440,1024,768,320];
  for (const width of widths) {
    win.setSize(width, 900); await delay(250);
    const bounds = await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,sendRight:document.querySelector("#send-button").getBoundingClientRect().right,modelRight:document.querySelector("[data-model=gpt]").getBoundingClientRect().right})');
    assert.ok(bounds.scrollWidth <= bounds.width + 1, JSON.stringify(bounds)); assert.ok(bounds.sendRight <= bounds.width); assert.ok(bounds.modelRight <= bounds.width);
    await capture(`v5-responsive-${width}.png`);
    if (width === 320) {
      await audit('320px welcome');
      await js('document.querySelector("#expand-sidebar").click()'); assert.ok(await js('document.body.classList.contains("sidebar-open")'));
      await js('document.querySelector("#sidebar-scrim").click()'); assert.ok(await js('document.querySelector(".sidebar").inert'));
    }
  }
  win.setSize(1380, 920); await delay(200); await setTheme('light');
  await js('document.querySelector("[data-model-options=gpt]").click()'); await capture('v5-power-light.png');
  assert.deepEqual(await js('window.__frontendErrors'), []);
  assert.deepEqual(await js('window.__irisErrors'), []);
  const report = { passed: true, version: '0.6.0', gptModelVisible: name, widths, axeAudits: audits.map(({name, passes, violations}) => ({name,passes,violations:violations.length})), checks: ['light and dark themes','concrete model names','Power keyboard and focus return','last-model toast','workspaces and history','real saved cooperation record','collapsed process default','safe Markdown tables and code copy','empty, loading and error states','narrow sidebar drawer','no runtime console errors'], liveChecks: process.env.IRIS_LIVE_TEST === '1' ? 'iris-ui-check ran' : 'iris-ui-check skipped (set IRIS_LIVE_TEST=1; 0.6 流程断言尚未重写)', note: '隔离数据的界面回归。不发起任何真实模型请求，除非设置 IRIS_LIVE_TEST=1。' };
  await fs.writeFile(path.join(artifacts, 'v5-frontend-test.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
};
