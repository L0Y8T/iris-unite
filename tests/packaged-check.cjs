const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const executable = process.env.DUET_VERIFY_EXE || path.resolve(__dirname, '../build/IrisUnite-win32-x64/IrisUnite.exe');
const delay = ms => new Promise(r => setTimeout(r, ms));
const children = new Set();
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function launch() {
  const p = await port();
  const child = spawn(executable, ['--verification-profile', `--remote-debugging-port=${p}`, '--remote-debugging-address=127.0.0.1'], { cwd: path.dirname(executable), stdio: 'ignore', windowsHide: true, detached: true });
  children.add(child); child.once('exit', () => children.delete(child));
  let target;
  for (let i = 0; i < 150; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* starting */ }
    await delay(100);
  }
  if (!target) throw new Error('Packaged app did not start its renderer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = event => { const msg = JSON.parse(event.data); const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result); } };
  function send(method, params) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function js(expression) { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
  const until = async expression => { for (let i = 0; i < 600; i++) { if (await js(expression)) return; await delay(100); } throw new Error('Packaged UI timed out: ' + expression); };
  await until('document.querySelector("#history-count")?.textContent !== "…" && !!document.querySelector(".welcome")');
  return { child, socket, js, until };
}
(async () => {
  let app = await launch();
  const count = await app.js('Number(document.querySelector("#history-count").textContent)');
  assert.ok(count > 0, 'Packaged worker can read local history from ASAR');
  const initial = await app.js('window.duet.init()');
  assert.equal(initial.settings.mode, undefined);
  assert.ok(await app.js('typeof window.marked?.Marked === "function" && typeof window.DOMPurify?.sanitize === "function" && !!window.DUET_ICONS?.folder'));
  assert.ok(await app.js('document.querySelector(".title-brand").textContent.includes("Iris Unite 0.6")'));
  assert.ok(await app.js('document.querySelector(".iris-light").complete && document.querySelector(".iris-light").naturalWidth > 0'));
  assert.deepEqual(await app.js('window.__irisErrors'), []);
  const displayName = initial.modelCatalog.gpt.find(m => m.id === initial.settings.defaultModelConfig.gpt.model).name;
  assert.ok(await app.js(`document.querySelector('[data-model=gpt]').textContent.includes(${JSON.stringify(displayName)})`));
  const workspace = initial.workspaces.find(w => w.sources.includes('Codex'));
  const modelConfig = initial.settings.defaultModelConfig;
  modelConfig.gpt.effort = 'high'; modelConfig.deepseek.effort = 'max';
  const conversation = await app.js(`window.duet.create(${JSON.stringify({ models: ['gpt'], modelConfig, workspaceId: workspace.id })})`);
  const id = conversation.id;
  assert.equal(conversation.cwd, workspace.path);
  // Saved custom profiles and research configuration must survive a packaged restart.
  // This endpoint is deliberately never called by the verification harness.
  for (const profile of initial.settings.connections) await app.js(`window.duet.removeConnection(${JSON.stringify(profile.id)})`);
  const saved = await app.js(`window.duet.saveConnection(${JSON.stringify({ name: 'Packaged QA Profile', model: 'packaged-qa', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'packaged-isolated-test-key', effortMode: 'openai', enabled: true, maxTokens: 4096 })})`);
  const profile = saved.settings.connections[0];
  assert.ok(profile.hasKey); assert.equal(profile.encryptedKey, undefined); assert.equal(profile.apiKey, undefined);
  const researchConfig = saved.settings.defaultResearchConfig;
  // 0.6.0 起科研配置是 v4：档位 + 逐环节模型 + 预算块。
  assert.equal(researchConfig.version, 4);
  assert.equal(researchConfig.profile, 'p1-review');
  assert.equal(researchConfig.tier, 'readonly');
  assert.equal(researchConfig.choices.plan.provider, 'deepseek');
  assert.equal(researchConfig.choices.plan.effort, 'high');
  assert.equal(researchConfig.choices.final.effort, 'max');
  assert.equal(researchConfig.choices.summarize, null);
  assert.equal(researchConfig.retrieval.enabled, true);
  assert.ok(researchConfig.budget.maxCalls >= 7, '预算应覆盖综述档基准调用');
  researchConfig.tasks[1].choice = { provider: profile.id, model: profile.model, effort: 'high' };
  const researchConversation = await app.js(`window.duet.create(${JSON.stringify({ models: ['gpt'], workspaceId: workspace.id, mode: 'research', researchConfig })})`);
  const history = await app.js('window.duet.historyList()');
  for (const source of ['dsh', 'codex']) {
    const c = history.items.find(c => c.source === source && (c.messageCount === undefined || c.messageCount > 0));
    const data = await app.js(`window.duet.historyRead(${JSON.stringify(c.id)})`); assert.ok(data.messages.length > 0);
  }
  await app.js('document.querySelector("#nav-workspaces").click()');
  await app.until('document.querySelectorAll(".workspace-card").length > 1');
  await app.js('window.duetTheme.set("dark");renderTheme();true');
  assert.equal(await app.js('getComputedStyle(document.querySelector(".main")).backgroundColor'), 'rgb(21, 21, 23)');
  const exited = new Promise(r => app.child.once('exit', r));
  await app.js('setTimeout(()=>window.duet.window("close"),100);true');
  app.socket.close(); await exited;
  // Copy only the completed real test answer into this isolated verification profile.
  const liveData = JSON.parse(await fs.readFile(path.join(__dirname, '../.test-data/v3-ui/conversations.json'), 'utf8'));
  const real = liveData.conversations.flatMap(c => c.messages).find(m => m.collaboration?.status === 'done' && m.collaboration.artifacts.length === 8);
  assert.ok(real, 'A completed real cooperative run is required');
  const dataFile = path.join(path.dirname(executable), '.verification-profile/conversations.json');
  const data = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  data.conversations.find(c => c.id === id).messages.push({ ...real, id: 'packaged-persistence-answer' });
  const researchData = JSON.parse(await fs.readFile(path.join(__dirname, '../.test-data/v5-ui/conversations.json'), 'utf8'));
  const researchAnswer = researchData.conversations.flatMap(c => c.messages).find(m => m.status === 'done' && m.collaboration?.mode === 'research' && m.collaboration.callsUsed === 5);
  assert.ok(researchAnswer, 'A completed real research run is required');
  const previousProfile = researchAnswer.collaboration.artifacts.find(a => a.provider.startsWith('model_')).provider;
  const restoredResearchAnswer = JSON.parse(JSON.stringify(researchAnswer).replaceAll(previousProfile, profile.id));
  data.conversations.find(c => c.id === researchConversation.id).messages.push({ ...restoredResearchAnswer, id: 'packaged-research-answer' });
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
  const settingsText = await fs.readFile(path.join(path.dirname(executable), '.verification-profile/settings.json'), 'utf8');
  assert.ok(!settingsText.includes('packaged-isolated-test-key'));
  assert.ok(JSON.parse(settingsText).connections[0].encryptedKey);
  app = await launch();
  assert.equal(await app.js('document.documentElement.dataset.theme'), 'dark');
  await app.js('window.duetTheme.set("light");renderTheme();true');
  const restarted = await app.js('window.duet.init()');
  assert.equal(restarted.settings.connections.find(c => c.id === profile.id).hasKey, true);
  assert.equal(restarted.modelCatalog[profile.id][0].id, 'packaged-qa');
  const restoredResearch = await app.js(`window.duet.get(${JSON.stringify(researchConversation.id)})`);
  // 存的是校验后的 v4：字段被归一过，所以只比对语义关键项，不比对整个对象。
  assert.equal(restoredResearch.mode, 'research');
  assert.equal(restoredResearch.researchConfig.version, 4);
  assert.equal(restoredResearch.researchConfig.profile, researchConfig.profile);
  assert.deepEqual(restoredResearch.researchConfig.choices.plan, researchConfig.choices.plan);
  assert.deepEqual(restoredResearch.researchConfig.choices.final, researchConfig.choices.final);
  assert.equal(restoredResearch.researchConfig.budget.maxCalls, researchConfig.budget.maxCalls);
  assert.deepEqual(restoredResearch.researchConfig.tasks[1].choice, researchConfig.tasks[1].choice);
  await app.js(`document.querySelector('[data-thread="${researchConversation.id}"]').click()`);
  await app.until('document.querySelectorAll(".research-model-chip").length === 7 && !!document.querySelector(".process-details")');
  assert.ok(await app.js('document.querySelector("#model-controls").textContent.includes("Packaged QA Profile")'));
  assert.equal(await app.js('document.querySelector(".process-details").open'), false);
  await app.js('document.querySelector(".process-details>summary").click()');
  await app.until('document.querySelectorAll(".process-artifact").length === 5');
  const restored = await app.js(`window.duet.get(${JSON.stringify(id)})`);
  assert.deepEqual(restored.models, ['gpt']); assert.equal(restored.modelConfig.gpt.effort, 'high'); assert.equal(restored.modelConfig.deepseek.effort, 'max'); assert.equal(restored.workspaceId, workspace.id);
  await app.js(`document.querySelector('[data-thread="${id}"]').click()`);
  await app.until('document.querySelector("#conversation-workspace")');
  assert.equal(await app.js('document.querySelectorAll(".model-chip.selected").length'), 1);
  assert.ok(await app.js('document.querySelector("[data-model-options=gpt]").textContent.trim().length > 0'));
  assert.equal(restored.messages.at(-1).collaboration.artifacts.length, 8);
  assert.equal(await app.js('document.querySelector(".process-details").open'), false);
  await app.js('document.querySelector(".process-details>summary").click()');
  await app.until('document.querySelectorAll(".process-artifact").length===8');
  await app.js('document.querySelector("[data-model-options=gpt]").click()');
  await app.until('!!document.querySelector("#power-slider")');
  assert.ok(await app.js('Number(document.querySelector("#power-slider").max)>1'));
  await app.js('document.querySelector("[data-model=gpt]").click()');
  await app.until('document.querySelector("#toast.visible")');
  assert.deepEqual(await app.js('window.__irisErrors'), []);

  /* 打包后的执行能力：脚本在 app.asar 内，Python 读不到虚拟路径，
     必须由执行器物化到数据目录再跑。这一段就是验证那条路真的通。 */
  const execInfo = await app.js('window.duet.execTemplates()');
  assert.ok(execInfo.templates.length >= 2, '应能看到实验模板');
  assert.ok(execInfo.python, '打包版也应找到 Python：' + (execInfo.pythonError || ''));
  assert.ok(execInfo.templates.some(t => t.unimplemented), '未实现的模板应标记出来');
  const execRun = await app.js(`window.duet.execRun({ templateId: 'env-smoke', params: { dim: 24 } })`);
  assert.ok(execRun.runId, '启动执行应返回 runId');
  for (let i = 0; i < 600; i++) {
    const status = await app.js(`window.duet.execGet(${JSON.stringify(execRun.runId)}).then(r => r.view.status).catch(() => 'missing')`);
    if (['done', 'failed', 'timeout', 'cancelled'].includes(status)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const execView = await app.js(`window.duet.execGet(${JSON.stringify(execRun.runId)}).then(r => r.view)`);
  assert.equal(execView.status, 'done', '打包版执行应成功：' + (execView.error || ''));
  assert.ok(execView.metricCount > 0, '打包版执行应产出指标');
  assert.ok(execView.artifacts.length >= 2, '打包版执行应产出产物');

  const result = { passed: true, executable, version: '0.6.0', historiesDetected: count, packagedHistoryRead: true, nativeWorkspaces: true, restartRestoresStrengths: true, restartRestoresWorkspaceAndSelection: true, restartRestoresRealCooperation: true, restartRestoresResearchModeAndTaskModels: true, restartRestoresResearchAnswer: true, encryptedProfileSurvivesRestart: true, restartRestoresTheme: true, irisBrandAndIcon: true, localMarkdownAndIcons: true, concreteModelName: displayName, powerSlider: true, noDemoMode: true, verificationProfileIsolated: true, packagedExecRun: execView.status, packagedExecMetrics: execView.metricCount };
  await fs.writeFile(path.join(__dirname, '../artifacts/v5-packaged-check.json'), JSON.stringify(result, null, 2));
  // Close the test instance so the final app can start without a debugging port.
  const exitedAgain = new Promise(r => app.child.once('exit', r));
  await app.js('setTimeout(()=>window.duet.window("close"),100);true'); app.socket.close(); await exitedAgain;
  console.log(JSON.stringify(result));
})().catch(e => { for (const child of children) child.kill(); console.error(e.stack); process.exit(1); });
