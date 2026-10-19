const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async (win, root) => {
  const js = code => win.webContents.executeJavaScript(code, true);
  const until = async (code, timeout = 25000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await js(code)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('UI timed out: ' + code); };
  const capture = async name => { await fs.mkdir(path.join(root, 'artifacts'), { recursive: true }); await fs.writeFile(path.join(root, 'artifacts', name), (await win.webContents.capturePage()).toPNG()); };
  await until('document.querySelector(".welcome") && document.querySelector("#history-count").textContent !== "…"', 90000);
  await js('window.__uiErrors=[];window.addEventListener("error",e=>window.__uiErrors.push(e.message));window.__phases=[];window.duet.onEvent(e=>{if(e.type==="collaboration"&&e.event.kind==="stage")window.__phases.push(e.event.stage.stage)});true');
  const initial = await js('window.duet.init()');
  assert.equal(initial.settings.mode, undefined);
  assert.ok(initial.workspaces.some(w => w.sources.includes('DSH')));
  assert.ok(initial.workspaces.some(w => w.sources.includes('Codex')));
  const fullName = initial.modelCatalog.gpt.find(m => m.id === initial.settings.defaultModelConfig.gpt.model).name;
  assert.ok(await js(`document.querySelector('[data-model=gpt]').textContent.includes(${JSON.stringify(fullName)})`));
  for (const selector of ['body', '.sidebar', '.main', '.new-chat', '.send-button']) {
    const colors = await js(`(()=>{const s=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return [s.color,s.backgroundColor]})()`);
    /* 0.6.0 起设计系统使用带轻微冷调的中性灰（--ink #0f1115、--canvas #ebeef2），
       不再满足 R==G==B。原意是"不许出现明显色偏"，这里改成通道极差阈值。 */
    for (const c of colors) {
      const rgb = c.match(/[\d.]+/g).slice(0, 3).map(Number);
      assert.ok(Math.max(...rgb) - Math.min(...rgb) <= 16, `${selector} 出现明显色偏：${c}`);
    }
  }
  await capture('v3-welcome.png');
  await js('document.querySelector("[data-model=gpt]").click()');
  await until('document.querySelectorAll(".model-chip.selected").length === 1');
  await js('window.__guardAt=performance.now();document.querySelector("[data-model=deepseek]").click()');
  await until('document.querySelector("#toast.visible")');
  assert.equal(await js('document.querySelector("#toast").textContent'), '至少使用一个模型');
  assert.equal(await js('document.querySelector("dialog[open]")'), null);
  await until('document.querySelector("#toast.fading")', 5000);
  const fadeAt = await js('performance.now()-window.__guardAt'); assert.ok(fadeAt >= 2450 && fadeAt < 4500);
  await until('document.querySelector("#toast.hidden")');
  await js('document.querySelector("[data-model=gpt]").click();document.querySelector("#nav-workspaces").click()');
  await until('document.querySelectorAll(".workspace-card").length > 1'); await capture('v3-workspaces.png');
  const catalog = await js('window.duet.workspaces()');
  const workspace = catalog.workspaces.find(w => w.sources.includes('Codex') && w.conversationCount > 0) || catalog.workspaces.find(w => w.conversationCount > 0 && w.path);
  await js(`Array.from(document.querySelectorAll('.workspace-card')).find(b=>b.dataset.workspace===${JSON.stringify(workspace.id)}).click()`);
  await until('document.querySelectorAll(".history-row").length > 0');
  const ids = await js('Array.from(document.querySelectorAll(".history-row")).map(b=>b.dataset.thread)'); assert.ok(ids.every(id => catalog.assignments[id] === workspace.id));
  await js('document.querySelector("#new-chat").click();document.querySelector("[data-model-options=gpt]").click()');
  await until('document.querySelector("#power-slider")'); await capture('v3-power.png');
  const slider = await js('(()=>{const e=document.querySelector("#power-slider"),r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,value:Number(e.value),max:Number(e.max)}})()');
  // Exercise the native range with a pointer drag, then keyboard navigation.
  const y = Math.round(slider.y + slider.height / 2), startX = Math.round(slider.x + 7 + (slider.width - 14) * slider.value / slider.max), rightX = Math.round(slider.x + slider.width - 7);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rightX, y, movementX: rightX - startX, movementY: 0 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: rightX, y, button: 'left', clickCount: 1 });
  await until('document.querySelector("#power-slider").value===document.querySelector("#power-slider").max');
  await js('document.querySelector("#power-slider").focus()');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
  await until(`Number(document.querySelector('#power-slider').value)===${slider.max - 1}`);
  const lowPower = async provider => {
    await js(`(()=>{const b=document.querySelector('[data-model-options=${provider}]');if(b.getAttribute('aria-expanded')!=='true')b.click();const e=document.querySelector('#power-slider');e.value=JSON.parse(e.dataset.efforts).indexOf('low');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.querySelector('[data-model-options=${provider}]').textContent.includes('轻量')`);
  };
  await lowPower('gpt'); await lowPower('deepseek');
  await js('document.querySelector(".advanced-model").open=true'); await capture('v3-power-advanced.png');
  await js('document.querySelector("#prompt").value="用不超过30字解释缓存的作用，各阶段公开材料保持简洁。";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#send-button").click()');
  await until('document.querySelector("#run-status:not(.hidden)")'); await capture('v3-running.png');
  assert.ok(await js('document.querySelector("#run-status").textContent.includes("阶段")'));
  assert.equal(await js('document.querySelectorAll(".reply-card").length'), 1);
  assert.equal(await js('document.querySelectorAll(".process-details[open]").length'), 0);
  assert.equal(await js('document.querySelectorAll(".process-artifact").length'), 0);
  await until('document.querySelector(".reply-status")?.textContent==="已完成" && !document.querySelector("#send-button.stop")', 480000);
  await capture('v3-conversation.png');
  const savedId = await js('Array.from(document.querySelectorAll(".conversation-item.selected")).map(b=>b.dataset.thread)[0]'); assert.ok(savedId);
  const saved = await js(`window.duet.get(${JSON.stringify(savedId)})`), answers = saved.messages.filter(m => m.role === 'assistant');
  assert.equal(saved.workspaceId, workspace.id); assert.equal(saved.modelConfig.gpt.effort, 'low'); assert.equal(saved.modelConfig.deepseek.effort, 'low');
  assert.equal(answers.length, 1); assert.equal(answers[0].status, 'done'); assert.ok(answers[0].text.trim());
  const run = answers[0].collaboration; assert.equal(run.status, 'done'); assert.equal(run.artifacts.length, 8); assert.ok(run.artifacts.every(a => a.status === 'done'));
  assert.ok(['deepseek','gpt'].includes(run.writer)); assert.equal(answers[0].provider, run.writer);
  assert.deepEqual(await js('window.__phases'), ['outline','review','synthesis','coordination','writing']);
  assert.equal(await js('document.querySelectorAll(".process-artifact").length'), 0);
  const displayedAnswer = await js('document.querySelector(".reply-body").innerText'); assert.ok(displayedAnswer.trim());
  await js('document.querySelector(".process-details>summary").click()');
  await until('document.querySelectorAll(".process-artifact").length===8'); await capture('v3-process.png');
  await js('document.querySelector(".process-details>summary").click()');
  await until('document.querySelectorAll(".process-artifact").length===0');
  await js('document.querySelector("[data-chat-tab=process]").click()'); await until('document.querySelectorAll(".process-artifact").length===8');
  await js('document.querySelector("[data-chat-tab=answer]").click()'); assert.equal(await js('document.querySelectorAll(".reply-card").length'), 1);
  await js('document.querySelector("#nav-history").click()'); await until('document.querySelectorAll(".history-row").length > 1');
  await js(`document.querySelector('[data-thread="${savedId}"]').click()`); await until('document.querySelector(".process-details")');
  assert.equal(await js('document.querySelector(".process-details").open'), false);
  assert.equal((await js(`window.duet.get(${JSON.stringify(savedId)})`)).messages.at(-1).collaboration.artifacts.length, 8);
  const other = catalog.workspaces.find(w => w.id !== workspace.id && w.path && w.available);
  await js(`document.querySelector('#conversation-workspace').value=${JSON.stringify(other.id)};document.querySelector('#conversation-workspace').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('#workspace-select').value===${JSON.stringify(other.id)}`);
  assert.equal((await js(`window.duet.get(${JSON.stringify(savedId)})`)).workspaceId, other.id);
  const histories = await js('window.duet.historyList()');
  for (const source of ['dsh', 'codex']) {
    const id = histories.items.find(c => c.source === source && (c.messageCount === undefined || c.messageCount > 0)).id;
    const c = await js(`window.duet.historyRead(${JSON.stringify(id)})`); assert.ok(c.messages.length > 0);
  }
  await js('document.querySelector("#collapse-sidebar").click()'); assert.ok(await js('document.body.classList.contains("sidebar-collapsed")'));
  await js('document.querySelector("#expand-sidebar").click();document.querySelector("#new-chat").click()');
  win.setSize(1000, 720); await new Promise(r => setTimeout(r, 300)); await capture('v3-compact.png');
  assert.ok(await js('document.querySelector("#send-button").getBoundingClientRect().right<=innerWidth'));
  assert.deepEqual(await js('window.__uiErrors'), []);
  const report = { passed: true, guardFadeStartsAfterMs: Math.round(fadeAt), workspaces: catalog.workspaces.length, concreteGptModel: fullName, realPipelineCalls: run.artifacts.length, writer: run.writer, finalAnswerCharacters: answers[0].text.length, phases: ['独立大纲','交叉审查','综合大纲','GPT统筹','完整写作'], checked: ['原生滑块拖动与键盘选择','模型名称常驻','双模型真实协作与单份最终答案','中间材料默认收起','展开与独立协作记录页','保存后重开协作记录','工作区与原客户端历史','黑白布局与紧凑窗口','最后一个模型2.5秒提示'] };
  await fs.writeFile(path.join(root, 'artifacts/v3-ui-test.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
};
