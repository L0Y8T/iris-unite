/* 科研配置界面的档位与计划预览验收（离线、不联网、不花钱）。
 *
 * 覆盖 docs/research-mode-design.md：
 *   §5.1 计划预览由主进程编译器给出，界面只显示：这一轮跑几步、花几次调用；
 *   §4.1 三档可选，本期只实现速查与综述，教学档必须显式标为「尚未实现」并禁用；
 *   §10  保存后的配置是 v4 形状（profile/tier/budget），不是旧的 maxCalls 平铺结构。
 *
 *   node tests/research-ui-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
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

(async () => {
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
  let seq = 0; const pending = new Map(); const pageErrors = [];
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') pageErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 400) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await delay(100); } throw new Error('超时: ' + expr); };

  try {
    await send('Runtime.enable', {});
    await until('!!document.querySelector(".welcome") && state.historyLoading === false');

    /* 先确保至少有一个可用模型通道，否则界面无法给出默认选择 */
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    await js(`window.duet.saveConnection(${JSON.stringify({ name: 'UI QA', model: 'ui-qa', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', allowNoKey: true, effortMode: 'none', enabled: true })})`);
    await js(`(async()=>{const initial=await window.duet.init();state.catalog=initial.catalog||state.catalog;return true})()`);
    await js(`refreshLocal().then(()=>{renderModels();return true})`);
    await delay(300);

    /* 科研配置是对话级设置，先建一个对话并打开，才能验证真正会被保存的形状 */
    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const conn = initial.settings.connections.find(c=>c.name==='UI QA');
      const modelConfig = { ...initial.settings.defaultModelConfig, [conn.id]: { model: 'ui-qa', effort: 'default' } };
      return window.duet.create({ models: [conn.id], modelConfig });
    })()`);
    await js(`refreshLocal()`);
    await js(`openThread(${JSON.stringify(conversation.id)})`);
    await delay(300);

    /* 进入科研模式并打开配置面板 */
    await js(`document.querySelector('[data-run-mode="research"]').click();true`);
    await delay(300);
    await js(`document.querySelector('#research-config-button').click();true`);
    await until(`document.querySelector('#research-dialog').open === true && !!document.querySelector('.research-profile-option')`);
    await delay(400);

    const profiles = await js(`[...document.querySelectorAll('.research-profile-option')].map(b=>({id:b.dataset.researchProfile,selected:b.classList.contains('selected'),disabled:b.disabled,text:b.textContent.trim()}))`);
    console.log('档位按钮:', JSON.stringify(profiles));
    assert.equal(profiles.length, 3, '应有三档');
    assert.deepEqual(profiles.map(p => p.id), ['p0-query', 'p1-review', 'p2-teach']);
    const p2 = profiles.find(p => p.id === 'p2-teach');
    assert.equal(p2.disabled, true, '教学档本期必须禁用');
    assert.match(p2.text, /尚未实现/);
    const selected = profiles.find(p => p.selected);
    assert.equal(selected.id, 'p1-review', '默认应落在综述档');

    const preview1 = await js(`document.querySelector('#research-plan-preview').textContent.replace(/\\s+/g,' ')`);
    console.log('综述档预览:', preview1);
    assert.match(preview1, /15 个环节，其中 9 个会调用模型/, '预览要给环节数与模型环节数');
    assert.match(preview1, /基准 10 次调用/, '综述档默认含实验族：N+5+实验设计 1+分析 2');

    /* 自动实验是流程内的一个环节族：配置面板里必须有开关、次数与轮次，
       关掉之后实验角色的模型选择器要跟着消失（不是独立功能，不该常驻）。 */
    const expUi = await js(`({
      toggle: !!document.querySelector('#experiments-enabled'),
      checked: document.querySelector('#experiments-enabled')?.checked === true,
      trials: document.querySelector('#experiments-trials')?.value,
      rounds: document.querySelector('#experiments-rounds')?.value,
      stages: [...document.querySelectorAll('.research-stage:not(.research-stage-optional) h3')].map(h => h.textContent.trim())
    })`);
    console.log('实验配置:', JSON.stringify(expUi));
    assert.equal(expUi.toggle, true, '综述档必须有自动实验开关');
    assert.equal(expUi.checked, true, '新对话默认开启自动实验');
    assert.equal(expUi.trials, '4');
    assert.equal(expUi.rounds, '2');
    assert.ok(expUi.stages.includes('实验设计') && expUi.stages.includes('结果分析'), '启用时应出现实验角色的模型选择：' + expUi.stages.join('/'));
    await js(`(()=>{const c=document.querySelector('#experiments-enabled');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await delay(700);
    const offStages = await js(`[...document.querySelectorAll('.research-stage:not(.research-stage-optional) h3')].map(h=>h.textContent.trim())`);
    assert.ok(!offStages.includes('实验设计'), '关掉实验后不该再显示实验角色的模型选择：' + offStages.join('/'));
    const offPreview = await js(`document.querySelector('#research-plan-preview').textContent.replace(/\\s+/g,' ')`);
    assert.match(offPreview, /基准 7 次调用/, '关掉实验后基准应回到 7 次');
    await js(`(()=>{const c=document.querySelector('#experiments-enabled');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await delay(700);
    assert.match(preview1, /上限 \d+ 次/, '预览要给调用上限');
    assert.match(preview1, /为收口保留 \d+ 次/, '预览要说清保留额度');

    /* 切到速查档：任务区应消失，出现要点汇总、不再有反证与整合 */
    await js(`document.querySelector('[data-research-profile="p0-query"]').click();true`);
    await delay(600);
    const p0 = await js(`({
      preview: document.querySelector('#research-plan-preview').textContent.replace(/\\s+/g,' '),
      stages: [...document.querySelectorAll('.research-stage:not(.research-stage-optional) h3')].map(h=>h.textContent.trim()),
      tasks: document.querySelectorAll('[data-research-task]').length,
      min: document.querySelector('#research-min-calls').textContent.trim(),
      budget: document.querySelector('#research-budget').value
    })`);
    console.log('速查档界面:', JSON.stringify(p0));
    assert.match(p0.preview, /基准 3 次调用/, '速查档基准应为 3 次调用');
    assert.equal(p0.min, '3');
    assert.equal(p0.tasks, 0, '速查档不应有并行任务');
    assert.ok(p0.stages.includes('要点汇总'), '速查档要有要点汇总环节，实得：' + p0.stages.join('/'));
    assert.ok(!p0.stages.includes('反证与整合'), '速查档不应出现反证与整合');

    /* 保存后主进程里的配置必须是 v4 */
    await js(`document.querySelector('#research-form').requestSubmit();true`);
    await delay(1200);
    const saveError = await js(`document.querySelector('#research-error').textContent.trim()`);
    if (saveError) throw new Error('保存配置时报错：' + saveError);
    await until(`document.querySelector('#research-dialog').open === false`, 200);
    const saved = await js(`(async()=>{const c=await window.duet.get(state.active.id);return {mode:c.mode,version:c.researchConfig?.version,profile:c.researchConfig?.profile,maxCalls:c.researchConfig?.budget?.maxCalls,tasks:(c.researchConfig?.tasks||[]).length,summarize:!!c.researchConfig?.choices?.summarize,final:c.researchConfig?.choices?.final||null}})()`);
    console.log('保存后的配置:', JSON.stringify(saved));
    assert.equal(saved.mode, 'research');
    assert.equal(saved.version, 4, '保存的配置必须是 v4');
    assert.equal(saved.profile, 'p0-query');
    assert.equal(saved.tasks, 0);
    assert.equal(saved.summarize, true, '速查档必须带要点汇总的模型');
    assert.equal(saved.final, null, '速查档不应保留反证与整合的模型');
    assert.equal(saved.maxCalls, 3, '速查档没有可选环节，预算应收到基准 3 次');

    assert.deepEqual(pageErrors, [], '界面不应有脚本错误：' + pageErrors.join(' | '));
    console.log(JSON.stringify({ passed: true, profiles: profiles.length, p0Base: 3, saved }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
