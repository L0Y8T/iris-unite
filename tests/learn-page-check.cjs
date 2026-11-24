/* 学习模式独立页验收（离线、不联网、不花钱）。
 *
 * 用户真实反馈过两件事：「点了学习模式没有反应」「图标不会像另外两个按钮一样变灰」
 * 「没有单独的页面」。根因是切档只改了配置与按钮高亮，页面还是聊天页，看不出区别。
 * 这条脚本守的是：点一下必须换页、按钮必须变、提交必须真的把主题送进那一轮。
 *
 *   node tests/learn-page-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
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

    /* 一个指向死端口的连接：只为让模型芯片有东西可选，不会被真的调用（页面校验不会发请求）。 */
    await js(`(async()=>{const initial=await window.duet.init();for(const c of (initial.settings.connections||[]))await window.duet.removeConnection(c.id);return true})()`);
    await js(`window.duet.saveConnection(${JSON.stringify({ name: 'Learn QA', model: 'learn-qa', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', allowNoKey: true, effortMode: 'none', enabled: true })})`);
    await js(`(async()=>{const initial=await window.duet.init();state.catalog=initial.catalog||state.catalog;return true})()`);
    await js('refreshLocal().then(()=>{renderModels();return true})');
    await delay(400);

    /* 1. 点一下必须换页 */
    const beforeView = await js('state.view');
    await js(`document.querySelector('[data-run-mode="learn"]').click();true`);
    await delay(1200);
    const page = await js(`({
      view: state.view,
      hasPage: !!document.querySelector('#content .learn-page'),
      hasForm: !!document.querySelector('#learn-form'),
      hasTopic: !!document.querySelector('#learn-topic'),
      badge: document.querySelector('#mode-badge').textContent.trim(),
      composerHidden: document.querySelector('#composer-area').classList.contains('hidden'),
      selected: [...document.querySelectorAll('[data-run-mode]')].filter(b=>b.classList.contains('selected')).map(b=>b.dataset.runMode),
      stepCount: document.querySelectorAll('.learn-step').length
    })`);
    console.log('点学习模式后:', JSON.stringify({ beforeView, ...page }));
    assert.equal(page.view, 'learn', '点学习模式必须切到独立页，不能还是聊天页');
    assert.equal(page.hasPage, true, '必须有 .learn-page 这一页');
    assert.equal(page.hasForm, true);
    assert.equal(page.hasTopic, true);
    assert.equal(page.badge, '学习模式');
    assert.equal(page.composerHidden, true, '学习页有自己的输入，聊天输入区应隐藏');
    assert.deepEqual(page.selected, ['learn'], '同一时刻只有学习模式按钮高亮');
    assert.equal(page.stepCount, 4, '页面上要说明四步流程');

    /* 2. 选中态必须真的和未选中不同（用户反馈「图标不会变」） */
    const styles = await js(`(()=>{
      const learn = document.querySelector('[data-run-mode="learn"]');
      const research = document.querySelector('[data-run-mode="research"]');
      const a = getComputedStyle(learn), b = getComputedStyle(research);
      return { learnBg: a.backgroundColor, researchBg: b.backgroundColor, learnColor: a.color, researchColor: b.color };
    })()`);
    console.log('按钮样式:', JSON.stringify(styles));
    assert.notEqual(styles.learnBg, styles.researchBg, '选中与未选中的背景必须不同');

    /* 3. 切回科研模式：学习页消失、按钮换人（必须在提交之前测——提交后这一轮在跑，切模式会被 busy 挡住） */
    await js(`document.querySelector('[data-run-mode="research"]').click();true`);
    await delay(1500);
    const back = await js(`({ view: state.view, hasPage: !!document.querySelector('#content .learn-page'), selected: [...document.querySelectorAll('[data-run-mode]')].filter(b=>b.classList.contains('selected')).map(b=>b.dataset.runMode) })`);
    console.log('切回科研模式:', JSON.stringify(back));
    assert.equal(back.view, 'chat');
    assert.equal(back.hasPage, false, '离开学习模式后学习页要消失');
    assert.deepEqual(back.selected, ['research']);

    /* 4. 再回到学习页，填主题与水平并提交 */
    await js(`document.querySelector('[data-run-mode="learn"]').click();true`);
    await delay(1200);
    await js(`(()=>{
      document.querySelector('#learn-topic').value = '系统学一遍扩散模型的推导与采样';
      document.querySelector('#learn-level').value = '读过论文但没推过';
      return true;
    })()`);
    await js(`document.querySelector('#learn-form').requestSubmit();true`);
    await delay(2500);
    const started = await js(`(async()=>{
      const c = state.active ? await window.duet.get(state.active.id) : null;
      const teaching = c?.researchConfig?.teaching || {};
      const first = (c?.messages || []).find(m => m.role === 'user');
      return {
        view: state.view,
        mode: state.mode,
        profile: c?.researchConfig?.profile || null,
        firstUserText: first?.text || '',
        intakeLevel: teaching.intake?.summary?.level || '',
        intakeTopic: teaching.intake?.topic || '',
        presetPrereq: teaching.prerequisites || [],
        badge: document.querySelector('#mode-badge').textContent.trim()
      };
    })()`);
    console.log('提交后:', JSON.stringify(started));
    assert.equal(started.view, 'chat', '提交后要回到聊天页看进度');
    assert.equal(started.mode, 'research');
    assert.equal(started.profile, 'p2-teach', '这一轮必须是学习档');
    assert.match(started.firstUserText, /扩散模型/, '主题要作为这一轮的用户消息发出去');
    assert.equal(started.intakeLevel, '读过论文但没推过', '手填的水平要写进问诊摘要');
    assert.equal(started.intakeTopic, '系统学一遍扩散模型的推导与采样');
    assert.equal(started.badge, '学习模式');

    assert.deepEqual(pageErrors, [], '界面不应有脚本错误：' + pageErrors.join(' | '));
    console.log(JSON.stringify({ passed: true, steps: page.stepCount, profile: started.profile }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已关闭 */ }
    child.kill();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
