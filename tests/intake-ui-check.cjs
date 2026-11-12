/* 课前问诊的界面验收（离线、不联网、不花钱）。
 *
 * 这条链路横跨三层，只测其中一层都不足以说明它真的能用：
 *   界面（问诊对话框）→ 主进程（生成问题的一次模型调用 + 答案归并）→ 配置（存进去，下一轮沿用）
 * 所以这里起一个假的 OpenAI 兼容服务，把真应用跑起来，从点按钮一路走到读回保存后的配置。
 *
 *   node tests/intake-ui-check.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const electron = require('./lib/electron-binary.cjs').binary;
const delay = ms => new Promise(r => setTimeout(r, ms));

/* 假模型要返回的问诊问题：刻意做得像"针对主题问的"，好让断言区分"模型真的被调用了"和"用了兜底问法"。 */
const INTAKE_ANSWER = {
  greeting: '先问四个问题：答完就不用再答，计划会按它们排。',
  questions: [
    {
      ask: '你在扩散模型的推导上是什么水平？',
      why: '决定从哪一层开始拆知识点。',
      mapsTo: 'level',
      kind: 'single',
      options: [
        { label: '没接触过', hint: '从高斯与马尔可夫链补起' },
        { label: '读过论文但没推过', hint: '缺的是推导手感' },
        { label: '自己推过一遍', hint: '可以直达采样器设计' }
      ]
    },
    {
      ask: '你想学到什么程度？',
      why: '决定计划在哪一步收尾。',
      mapsTo: 'goal',
      kind: 'single',
      options: [{ label: '能读懂推导' }, { label: '能自己实现采样' }]
    },
    {
      ask: '想重点覆盖哪些方向？',
      why: '这些方向必须有对应知识点。',
      mapsTo: 'focus',
      kind: 'multi',
      options: [{ label: '采样加速' }, { label: '条件生成' }]
    },
    { ask: '你已经掌握哪些相关概念？（一行一个）', why: '命中的知识点不进主路径。', mapsTo: 'known', kind: 'text', options: [] }
  ]
};

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

function startFakeModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { requests.push({ url: req.url, body: JSON.parse(raw) }); } catch { requests.push({ url: req.url, body: null }); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(INTAKE_ANSWER) } }] })}\n\ndata: [DONE]\n\n`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

(async () => {
  const fake = await startFakeModel();
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

    /* 一个指向假服务的连接：问诊那次模型调用走的就是它。 */
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    await js(`window.duet.saveConnection(${JSON.stringify({ name: 'Intake QA', model: 'intake-qa', protocol: 'openai', baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: '', allowNoKey: true, effortMode: 'none', enabled: true })})`);
    await js(`(async()=>{const initial=await window.duet.init();state.catalog=initial.catalog||state.catalog;return true})()`);
    await js('refreshLocal().then(()=>{renderModels();return true})');
    await delay(300);

    /* 建一个对话，并把它这一轮的科研配置整个指到假服务上。
       不这样做的话，配置里残留的默认通道（deepseek / gpt）会被真的调用出去——
       这份脚本声明自己离线不花钱，就必须做到每一处模型选择都指向本地。 */
    const conversation = await js(`(async()=>{
      const initial = await window.duet.init();
      const conn = initial.settings.connections.find(c=>c.name==='Intake QA');
      const modelConfig = { ...initial.settings.defaultModelConfig, [conn.id]: { model: 'intake-qa', effort: 'default' } };
      return window.duet.create({ models: [conn.id], modelConfig });
    })()`);
    const fakeChoice = await js(`(async()=>{
      const initial = await window.duet.init();
      const conn = initial.settings.connections.find(c=>c.name==='Intake QA');
      return { provider: conn.id, model: 'intake-qa', effort: 'default' };
    })()`);
    await js(`(async()=>{
      const choice = ${JSON.stringify(fakeChoice)};
      const initial = await window.duet.init();
      const base = initial.settings.defaultResearchConfig || {};
      const config = {
        ...base, version: 4, profile: 'p2-teach', tier: 'readonly',
        choices: { scope: choice, evidence: choice, teachingOutline: choice, teachingSections: choice, teachingExamples: choice, final: choice, audit: null },
        tasks: [], allowRefinement: false,
        experiments: { ...(base.experiments || {}), enabled: false },
        teaching: { ...(base.teaching || {}), chapterCount: 2, maxPoints: 12 },
        budget: { ...(base.budget || {}), maxCalls: 12 }
      };
      await window.duet.runConfig(${JSON.stringify(conversation.id)}, 'research', config);
      return true;
    })()`);
    await js(`refreshLocal()`);
    await js(`openThread(${JSON.stringify(conversation.id)})`);
    await delay(400);
    await js(`(()=>{const p=document.querySelector('#prompt');p.value='帮我系统学一遍扩散模型的推导与采样';p.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);

    /* 进教学档，打开科研配置，找到问诊入口 */
    await js(`document.querySelector('[data-run-mode="research"]').click();true`);
    await delay(300);
    await js(`document.querySelector('#research-config-button').click();true`);
    await until(`document.querySelector('#research-dialog').open === true && !!document.querySelector('.research-profile-option')`);
    await delay(300);
    await js(`document.querySelector('[data-research-profile="p2-teach"]').click();true`);
    await delay(800);

    const rowBefore = await js(`({
      hasButton: !!document.querySelector('[data-open-intake]'),
      note: document.querySelector('.intake-row-note')?.textContent.trim() || '',
      buttonText: document.querySelector('[data-open-intake]')?.textContent.trim() || ''
    })`);
    console.log('问诊入口:', JSON.stringify(rowBefore));
    assert.equal(rowBefore.hasButton, true, '教学档必须有课前问诊入口');
    assert.match(rowBefore.note, /还没做问诊/, '没答过时说清楚：计划会按默认受众排');
    assert.match(rowBefore.buttonText, /课前问诊/);

    await js(`document.querySelector('[data-open-intake]').click();true`);
    await until(`document.querySelector('#intake-dialog').open === true`);
    await delay(200);

    const subject = await js(`document.querySelector('#intake-topic').value`);
    assert.equal(subject, '帮我系统学一遍扩散模型的推导与采样', '主题默认取对话里最后一条用户消息，省一次手打');
    assert.equal(await js(`document.querySelector('#intake-save').disabled`), true, '没有问题之前不能保存');
    assert.match(await js(`document.querySelector('#intake-cost').textContent`), /不占本轮调用上限/, '要说清这一次调用不进本轮账本');

    /* 生成问题：走一次真实的主进程模型调用（打到假服务上） */
    const before = fake.requests.length;
    await js(`document.querySelector('#intake-generate').click();true`);
    await until(`document.querySelectorAll('[data-intake-question]').length > 0`, 600);
    await delay(200);
    console.log('生成后诊断:', JSON.stringify({
      requests: fake.requests.length,
      note: await js(`document.querySelector('#intake-note').textContent.trim()`),
      error: await js(`document.querySelector('#intake-error').textContent.trim()`),
      questions: await js(`(intakeDraft?.questions || []).length`)
    }));
    assert.equal(fake.requests.length, before + 1, '生成问题应当只发生一次模型调用');
    const sent = fake.requests.at(-1).body;
    const promptText = sent.messages.map(m => m.content).join('\n');
    assert.match(promptText, /帮我系统学一遍扩散模型的推导与采样/, '问诊提示词必须带上主题，问题才可能针对它');
    assert.match(promptText, /mapsTo/, '要按槽位问，答完才能落进计划');
    assert.equal(sent.stream, true);

    const rendered = await js(`[...document.querySelectorAll('[data-intake-question]')].map(s=>({
      slot: s.querySelector('.intake-slot')?.textContent.trim() || '',
      ask: s.querySelector('.intake-question-head strong')?.textContent.trim() || '',
      why: s.querySelector('.intake-why')?.textContent.trim() || '',
      options: [...s.querySelectorAll('[data-intake-option]')].map(i=>i.value),
      text: !!s.querySelector('[data-intake-text]')
    }))`);
    console.log('渲染出的问题:', JSON.stringify(rendered));
    assert.equal(rendered.length, 4);
    assert.deepEqual(rendered.map(q => q.slot), ['现有水平', '想达到的程度', '想覆盖的方向', '已掌握的具体概念']);
    assert.ok(rendered[0].why.length > 0, '每题要说明为什么问');
    assert.deepEqual(rendered[0].options, ['没接触过', '读过论文但没推过', '自己推过一遍']);
    assert.equal(rendered[3].text, true, '已掌握概念应当是填空');
    assert.equal(await js(`document.querySelector('#intake-save').disabled`), false);
    assert.equal(await js(`document.querySelector('#intake-generate').textContent.trim()`), '重新生成问题');

    /* 答题并保存 */
    await js(`(()=>{
      const first = document.querySelectorAll('[data-intake-question]')[0];
      first.querySelectorAll('[data-intake-option]')[1].checked = true;
      const second = document.querySelectorAll('[data-intake-question]')[1];
      second.querySelectorAll('[data-intake-option]')[0].checked = true;
      const third = document.querySelectorAll('[data-intake-question]')[2];
      third.querySelectorAll('[data-intake-option]')[0].checked = true;
      document.querySelector('[data-intake-text]').value = '重参数化\\nKL 散度';
      return true;
    })()`);
    await js(`document.querySelector('#intake-form').requestSubmit();true`);
    await until(`document.querySelector('#intake-dialog').open === false`, 200);
    await delay(400);

    const rowAfter = await js(`({
      note: document.querySelector('.intake-row-note')?.textContent.trim() || '',
      buttonText: document.querySelector('[data-open-intake]')?.textContent.trim() || ''
    })`);
    console.log('问诊摘要:', JSON.stringify(rowAfter));
    assert.match(rowAfter.note, /主题：帮我系统学一遍扩散模型的推导与采样/);
    assert.match(rowAfter.note, /水平：读过论文但没推过/);
    assert.match(rowAfter.note, /目标：能读懂推导/);
    assert.match(rowAfter.note, /想覆盖：采样加速/);
    assert.match(rowAfter.note, /已掌握 2 项/, '填空里一行一个的概念要拆成两条');
    assert.match(rowAfter.buttonText, /查看或重做/);

    /* 保存科研配置，读回主进程里真正存下来的形状 */
    await js(`document.querySelector('#research-form').requestSubmit();true`);
    await delay(1200);
    const saveError = await js(`document.querySelector('#research-error').textContent.trim()`);
    if (saveError) throw new Error('保存配置时报错：' + saveError);
    await until(`document.querySelector('#research-dialog').open === false`, 200);
    const saved = await js(`(async()=>{const c=await window.duet.get(state.active.id);const t=c.researchConfig?.teaching||{};return {profile:c.researchConfig?.profile,intake:t.intake||null,prerequisites:t.prerequisites||[]}})()`);
    console.log('保存后的问诊:', JSON.stringify(saved.intake && { topic: saved.intake.topic, level: saved.intake.summary.level, known: saved.intake.summary.known }));
    assert.equal(saved.profile, 'p2-teach');
    assert.ok(saved.intake, '问诊必须真的存进配置，下一轮不用再问');
    assert.equal(saved.intake.topic, '帮我系统学一遍扩散模型的推导与采样');
    assert.deepEqual(saved.intake.summary.known, ['重参数化', 'KL 散度']);
    assert.equal(saved.intake.summary.level, '读过论文但没推过');
    assert.equal(saved.intake.questions.length, 4, '问题一起存下来，重开对话框能看到上次问的');
    assert.deepEqual(saved.prerequisites, [], '手填的先修不被问诊污染，合并只发生在派生视图里');

    /* 再打开一次：上次的问题与答案都还在，不用重答 */
    await js(`document.querySelector('#research-config-button').click();true`);
    await until(`document.querySelector('#research-dialog').open === true`);
    await delay(300);
    await js(`document.querySelector('[data-open-intake]').click();true`);
    await until(`document.querySelector('#intake-dialog').open === true`);
    await delay(250);
    const reopened = await js(`({
      questions: document.querySelectorAll('[data-intake-question]').length,
      checked: [...document.querySelectorAll('[data-intake-option]')].filter(i=>i.checked).map(i=>i.value),
      text: document.querySelector('[data-intake-text]')?.value || ''
    })`);
    assert.equal(reopened.questions, 4);
    assert.deepEqual(reopened.checked, ['读过论文但没推过', '能读懂推导', '采样加速']);
    assert.equal(reopened.text, '重参数化\nKL 散度', '填空要保留换行，否则"一行一个"的输入没法再拆');
    await js(`document.querySelector('#intake-dialog .dialog-close').click();true`);
    await delay(200);
    await js(`document.querySelector('#research-dialog .dialog-close').click();true`);
    await delay(200);

    assert.deepEqual(pageErrors, [], '界面不应有脚本错误：' + pageErrors.join(' | '));
    console.log(JSON.stringify({ passed: true, questions: rendered.length, intakeCalls: fake.requests.length }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    try { fake.server.close(); } catch { /* 已关闭 */ }
    child.kill();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
