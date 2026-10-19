/**
 * 注意：本文件是 0.5.0「五阶段、GPT 统筹」科研流程的联调脚本，断言写死了
 * run.callsUsed === 5、artifacts.length === 5、终审 provider === 'gpt'，
 * 并且会发起真实模型请求（消耗额度）。
 *
 * 0.6.0 把流程改成 10 个环节、每个环节可独立选模型、预算下限变成「任务数+5」，
 * 所以这份脚本里的科研部分**已经过期，必须重写**，不能只改选择器。
 * 目前它只作为 0.5.0 的历史联调记录保留，默认不执行（见 frontend-check.cjs 的
 * IRIS_LIVE_TEST 守卫）。0.6.0 的界面验收请看 tests/dsh-visual-check.cjs。
 */
const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
exports.run=async({win,root,js,until,capture,audit})=>{
 const requests=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requests.push({headers:req.headers,body:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'缓存减少重复计算；实验需控制数据分布，对比冷缓存与热缓存的延迟。'}}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));server.unref();const port=server.address().port;
 try{
  await js('document.querySelector("#new-chat").click();document.querySelector("#settings-button").click()');
  const oldIds=await js('(state.settings.connections||[]).map(c=>c.id)');
  await js('document.querySelector("#add-connection").click()');await until('document.querySelector("#connection-dialog").open');
  await js(`document.querySelector('#connection-name').value='Local QA Model';document.querySelector('#connection-model').value='local-qa';document.querySelector('#connection-url').value='http://127.0.0.1:${port}/v1';document.querySelector('#connection-key').value='iris-test-secret-only';document.querySelector('#connection-effort').value='openai';true`);
  await audit('light add-model connection');await capture('v5-add-model.png');
  await js('document.querySelector("#connection-form").requestSubmit()');await until('!document.querySelector("#connection-dialog").open || !!document.querySelector("#connection-error").textContent || window.__irisErrors.length>0');
  assert.deepEqual(await js('window.__irisErrors'),[]);assert.equal(await js('document.querySelector("#connection-error").textContent'),'');
  const profile=await js(`state.settings.connections.find(c=>!${JSON.stringify(oldIds)}.includes(c.id))`);assert.ok(profile);assert.ok(profile.hasKey);assert.equal(profile.apiKey,undefined);assert.equal(profile.encryptedKey,undefined);
  await js(`document.querySelector('[data-test-connection="${profile.id}"]').click()`);await until('document.querySelector("#toast").textContent==="连接测试成功"');
  assert.equal(requests.at(-1).headers.authorization,'Bearer iris-test-secret-only');
  const saved=JSON.parse(await fs.readFile(path.join(root,'.test-data/v5-ui/settings.json'),'utf8'));assert.ok(saved.connections.find(c=>c.id===profile.id).encryptedKey);assert.ok(!JSON.stringify(saved).includes('iris-test-secret-only'));
  await js('document.querySelector("#settings-dialog .dialog-close").click();document.querySelector("[data-open-models]").click()');
  await until('document.querySelector("#models-dialog").open');await audit('light model picker');await capture('v5-model-picker.png');
  await js(`document.querySelector('[data-picker-model="${profile.id}"]').click()`);await until(`document.querySelector('[data-model="${profile.id}"]')`);
  await js('document.querySelector("#models-dialog .primary-button").click();document.querySelector("[data-model=gpt]").click()');
  await until('!document.querySelector("[data-model=gpt]").classList.contains("selected")');await js('document.querySelector("[data-model=deepseek]").click()');
  await until('document.querySelectorAll(".model-chip.selected").length===1');
  assert.ok(await js(`document.querySelector('[data-model="${profile.id}"]').textContent.includes('Local QA Model')`));
  await js(`document.querySelector('[data-model-options="${profile.id}"]').click()`);await until('document.querySelector("#power-slider")');
  await js('document.querySelector("#power-slider").value=2;document.querySelector("#power-slider").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#power-slider").dispatchEvent(new Event("change",{bubbles:true}));true');
  await capture('v5-model-power.png');
  await js('document.querySelector("#prompt").value="简短验证自定义模型连接。";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#send-button").click()');
  await until('document.querySelector(".reply-status")?.textContent==="已完成" && !document.querySelector("#send-button.stop")');
  assert.equal(requests.at(-1).body.reasoning_effort,'medium');assert.ok(await js('document.querySelector(".reply-body").textContent.includes("缓存")'));
  assert.equal(await js('state.active.messages.at(-1).provider'),profile.id);
  await js('document.querySelector("#new-chat").click();document.querySelector("[data-run-mode=research]").click()');
  await until('document.querySelector("[data-run-mode=research]").getAttribute("aria-pressed")==="true"');
  await capture('v5-research-welcome.png');await audit('light research welcome');
  await js('document.querySelector("#research-config-button").click()');await until('document.querySelector("#research-dialog").open');
  assert.equal(await js('document.querySelector("[data-research-effort=orchestrator]").value'),'medium');
  assert.equal(await js('document.querySelector("[data-research-effort=reviewer]").value'),'xhigh');
  await js(`(()=>{const e=document.querySelector('[data-research-choice="task-2"]');e.value=${JSON.stringify(JSON.stringify({provider:profile.id,model:'local-qa'}))};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await js('document.querySelector("[data-research-effort=task-2]").value="high";document.querySelector("[data-add-research-task]").click()');
  assert.equal(await js('document.querySelectorAll("[data-research-task]").length'),3);
  await js('document.querySelectorAll("[data-remove-research-task]")[2].click()');
  assert.equal(await js('document.querySelectorAll("[data-research-task]").length'),2);
  await capture('v5-research-architecture.png');await audit('light research architecture');
  await js('window.duetTheme.set("dark");renderTheme();true');await audit('dark research architecture');await capture('v5-research-architecture-dark.png');
  // Keep the live verification brief; production defaults remain Medium / XHigh.
  await js('document.querySelector("[data-research-effort=orchestrator]").value="low";document.querySelector("[data-research-effort=reviewer]").value="low";document.querySelector("#research-budget").value="5";document.querySelector("#research-form").requestSubmit()');
  await until('!document.querySelector("#research-dialog").open');
  await js('window.__researchStages=[];window.duet.onEvent(e=>{if(e.type==="collaboration"&&e.event.kind==="stage")window.__researchStages.push(e.event.stage.stage)});true');
  await js('document.querySelector("#prompt").value="研究缓存命中率对响应延迟的影响，简短提出一个可证伪的对照实验。最终答案不超过100字，阶段材料保持简短。";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#send-button").click()');
  await until('!document.querySelector("#run-status").classList.contains("hidden")');await capture('v5-research-running.png');
  await until('!document.querySelector("#send-button.stop")',240000);
  const actual=await js('window.duet.get(state.active.id)');const answer=actual.messages.at(-1),run=answer.collaboration;
  assert.equal(answer.status,'done',answer.error);assert.equal(run.mode,'research');assert.equal(run.status,'done');assert.equal(run.callsUsed,5);assert.equal(run.callBudget,5);assert.equal(run.artifacts.length,5);
  assert.equal(actual.researchConfig.tasks[1].choice.provider,profile.id);assert.equal(actual.researchConfig.tasks[1].choice.effort,'high');
  assert.ok(run.artifacts.some(a=>a.provider===profile.id));assert.equal(run.artifacts.at(-1).provider,'gpt');assert.ok(answer.text.trim());
  assert.equal(await js('document.querySelectorAll(".reply-card").length'),1);assert.equal(await js('document.querySelector(".process-details").open'),false);
  await capture('v5-research-answer.png');await audit('dark completed research');
  await js('document.querySelector(".process-details>summary").click()');await until('document.querySelectorAll(".process-artifact").length===5');await audit('dark research records');
  await capture('v5-research-records.png');
  await js(`openThread(${JSON.stringify(actual.id)})`);assert.equal(await js('document.querySelector(".process-details").open'),true);
  await js('document.querySelector(".process-details>summary").click()');
  const result={connectionUi:true,encryptedSecret:true,customEndpointIntegration:true,researchLayerSelectable:true,researchDefaultsMediumAndXHigh:true,liveResearchCalls:5,realProviders:['gpt','deepseek'],secondLayerLocalFixture:true,finalAnswerCharacters:answer.text.length,researchStages:await js('window.__researchStages'),callBudgetEnforced:true,researchPersistence:true};
  await fs.writeFile(path.join(root,'artifacts/v5-research-integration.json'),JSON.stringify(result,null,2));
  await js('window.duetTheme.set("light");renderTheme();document.querySelector("#new-chat").click();document.querySelector("[data-run-mode=standard]").click();true');
  return result;
 }finally{await new Promise(r=>server.close(r));}
};
