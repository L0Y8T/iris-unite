/* 一键导出的界面验收：点一下按钮，真的落地一个文件，内容对得上记录。
 *
 * 这条检查盯的是「一键」这件事本身：不弹对话框、不重渲染、点完就能在导出目录里找到文件。
 * 数据用隔离目录（IRIS_DATA_ROOT / IRIS_EXPORT_DIR），不碰真实对话。
 *
 *   node tests/export-ui-check.cjs
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const delay = ms => new Promise(r => setTimeout(r, ms));

const CONV = 'conv-export-check';
const RUN = 'run-export-check';
const ANSWER = '三种模型里 MLP 最好：测试准确率 0.980556 [E1]，比逻辑回归高 0.0083。';

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

function seed(dataRoot) {
  const now = Date.now();
  const manifest = {
    version: 1,
    runId: RUN,
    conversationId: CONV,
    label: 'tabular-baseline#1',
    template: { id: 'tabular-baseline', version: 1, name: '表格分类基线' },
    params: { dataset: 'digits', model: 'mlp', testSize: 0.2, seed: 42 },
    env: { fingerprint: 'deadbeefcafe', pythonVersion: '3.12.8', scriptHash: 'a'.repeat(64), scriptFile: 'tabular-baseline-v1-aaaa.py' },
    status: 'done',
    startedAt: now - 40000,
    finishedAt: now - 36000,
    exitCode: 0,
    metrics: { test: { accuracy: 0.980556, macro_f1: 0.9801, n_samples: 360 } },
    artifacts: [{ name: 'metrics.json', bytes: 256, sha256: 'b'.repeat(64) }, { name: 'confusion-matrix.png', bytes: 40960, sha256: 'c'.repeat(64) }],
    logs: { stdout: [], stderr: [], truncated: false },
    error: null
  };
  const collaboration = {
    version: 4,
    mode: 'research',
    status: 'done',
    profile: 'p1-review',
    profileName: '综述',
    tier: 'P1',
    planVersion: 'plan-export-check',
    policyVersion: '4',
    startedAt: now - 200000,
    finishedAt: now - 1000,
    callsUsed: 11,
    callBudget: 16,
    stageLabel: '已完成',
    stages: [{ id: 'research-scope', label: '研究界定', kind: 'model', phase: '检索' }],
    participants: [{ role: '最终整合', provider: 'deepseek', model: 'deepseek-chat', effort: 'high' }],
    scope: { objective: '确定 digits 上最合适的分类模型', questions: ['三种模型的准确率差异'], queries: ['digits classifier comparison'], inclusion: ['公开数据集'], exclusion: ['私有数据'] },
    knowledge: { total: 3, withDoi: 2, withAbstract: 1, bySource: { arxiv: 2, crossref: 1 }, queries: ['digits classifier'], yearRange: [2019, 2024], errors: [] },
    plan: { objective: '给出可复现结论', tasks: [{ id: 'T1', assignment: '比较三种模型', deliverable: '准确率表', evidenceKeys: ['S1'] }], selectionCriteria: '真实指标优先' },
    selection: { selectedIds: ['T1'], refineIds: [], reason: '指标可直接复现', feedback: '', unsupported: [], deviations: [] },
    evidence: { claims: [{ claim: 'MLP 在 digits 上准确率最高', keys: ['S1'], strength: '中', limitation: '单次种子' }], gaps: ['未做多种子重复'] },
    integrity: { ran: true, ok: true, librarySize: 3, counts: { total: 1, resolved: 1, unresolved: 0, removed: 0 }, unresolved: [] },
    experiments: { ran: true, ok: true, markers: { resolved: ['E1'], unresolved: [] }, numbers: { bound: [0.980556], unsourced: [] } },
    audit: { verdict: 'pass', checks: [{ name: '引用全部可核验', ok: true, detail: '未核验 0 处' }], review: { verdict: 'pass', fabrications: [], unsupported: [], fixes: [] } },
    artifacts: [
      { id: 'ar1', stage: 'experiment-analyze', stageLabel: '结果分析', kind: 'public-work', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: 'MLP 领先 0.83 个百分点，超出单次训练的波动范围。', startedAt: now - 30000, finishedAt: now - 20000 },
      { id: 'ar2', stage: 'research-final', stageLabel: '反证与整合', kind: 'final', status: 'done', provider: 'deepseek', model: 'deepseek-chat', text: ANSWER, startedAt: now - 15000, finishedAt: now - 2000 }
    ],
    experimentFamily: {
      skipped: false,
      design: { template: 'tabular-baseline', metric: 'test.accuracy', direction: 'maximize', hypothesis: 'MLP 优于线性模型', baseline: { dataset: 'digits', model: 'logreg' }, searchSpace: { model: ['logreg', 'mlp'] }, stopWhen: '主指标不再提升', reasoning: '模板直接产出指标' },
      summary: { total: 1, completed: 1, best: { label: 'tabular-baseline#1', metric: 'test.accuracy', value: 0.980556 } },
      runs: [],
      rounds: []
    },
    experimentRuns: [{ runId: RUN, label: 'tabular-baseline#1', status: 'done', params: { dataset: 'digits', model: 'mlp' } }]
  };

  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'conversations.json'), JSON.stringify({
    version: 3,
    workspaces: [],
    conversations: [{
      id: CONV,
      source: 'local',
      title: '导出验收：digits 三种模型',
      models: ['deepseek'],
      createdAt: now - 300000,
      updatedAt: now - 1000,
      messages: [
        { id: 'u-export', role: 'user', text: '比较逻辑回归、随机森林和 MLP 在 digits 上的准确率', roundId: 'round-export', timestamp: now - 250000 },
        { id: 'a-export', role: 'assistant', kind: 'answer', provider: 'deepseek', model: 'deepseek-chat', effort: 'high', text: ANSWER, status: 'done', roundId: 'round-export', timestamp: now - 1000, collaboration }
      ]
    }]
  }, null, 2), 'utf8');

  /* 资料库落在 <dataRoot>/knowledge/<对话 id>.json —— KnowledgeBase 构造函数自己拼的子目录。 */
  fs.mkdirSync(path.join(dataRoot, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'knowledge', CONV + '.json'), JSON.stringify({
    version: 1,
    conversationId: CONV,
    savedAt: now,
    queries: ['digits classifier'],
    errors: [],
    records: [
      { key: 'S1', source: 'arxiv', sourceId: '2401.00001', title: 'Comparing classifiers on digit recognition', authors: 'Li 等', year: 2024, venue: 'arXiv', doi: '10.48550/arXiv.2401.00001', abstract: '摘要' },
      { key: 'S2', source: 'crossref', sourceId: '10.1/x', title: 'Classical baselines', authors: 'Wang 等', year: 2019, venue: 'JMLR', doi: '10.1/x' },
      { key: 'S3', source: 'arxiv', sourceId: '2101.00002', title: 'Neural nets for small images', authors: 'Zhao 等', year: 2021, venue: 'arXiv', arxivId: '2101.00002' }
    ]
  }, null, 2), 'utf8');

  fs.mkdirSync(path.join(dataRoot, 'exec', 'runs', RUN), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'exec', 'runs', RUN, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataRoot, 'exec', 'runs-index.json'), JSON.stringify([{ runId: RUN, conversationId: CONV, status: 'done', template: manifest.template, startedAt: manifest.startedAt }], null, 1), 'utf8');
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataRoot = path.join(os.tmpdir(), `iris-export-data-${stamp}`);
  const exportRoot = path.join(os.tmpdir(), `iris-export-out-${stamp}`);
  seed(dataRoot);
  fs.mkdirSync(exportRoot, { recursive: true });

  const dbg = await freePort();
  /* IRIS_EXE 指向打包产物时，直接验那条 exe；不设则用源码里的 electron。
     独立的 user-data-dir：避免和正在运行的正版应用抢单实例锁，否则 CDP 会连到别人的窗口。 */
  const exe = process.env.IRIS_EXE ? path.resolve(process.env.IRIS_EXE) : electron;
  const argv = [
    ...(process.env.IRIS_EXE ? [] : ['.']),
    `--user-data-dir=${path.join(dataRoot, 'chromium')}`,
    `--remote-debugging-port=${dbg}`,
    '--remote-debugging-address=127.0.0.1'
  ];
  const child = spawn(exe, argv, {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, IRIS_DATA_ROOT: dataRoot, IRIS_EXPORT_DIR: exportRoot }
  });

  let target;
  for (let i = 0; i < 300; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* 启动中 */ }
    await delay(100);
  }
  if (!target) throw new Error('渲染进程没有起来');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, tries = 600) => {
    for (let i = 0; i < tries; i++) {
      try { if (await js(expr)) return; } catch { /* 页面还在 bootstrap */ }
      await delay(100);
    }
    throw new Error('超时: ' + expr);
  };

  try {
    await send('Runtime.enable', {});
    await until(`!!document.querySelector('#export-button') && state.historyLoading === false && state.local.length === 1`);

    /* 直接走页面自己的打开逻辑，不依赖侧边栏是否把这条对话渲染出来。 */
    await js(`openThread('${CONV}')`);
    await until(`!!document.querySelector('button[data-export-result="${'a-export'}"]')`);

    /* 一键：不该弹出任何原生对话框，所以点下去只需要等提示落地，再从导出目录取文件。 */
    await js(`document.querySelector('button[data-export-result="a-export"]').click();true`);
    await until(`document.querySelector('#toast').textContent.includes('已导出')`);

    let exported = [];
    for (let i = 0; i < 100; i++) {
      exported = fs.readdirSync(exportRoot).filter(name => name.endsWith('.md'));
      if (exported.length) break;
      await delay(100);
    }
    assert.ok(exported.length === 1, `导出目录里应恰好一个文件，实际 ${JSON.stringify(exported)}`);

    const file = path.join(exportRoot, exported[0]);
    const text = fs.readFileSync(file, 'utf8');

    /* 文件名带标题与时间戳，便于归档 */
    assert.match(exported[0], /^科研结果-导出验收：digits 三种模型-\d{8}-\d{4}\.md$/);

    for (const need of ['## 结论', '## 核验', '## 实验运行', '## 资料库', '## 复现信息', '## 终审自检']) {
      assert.ok(text.includes(need), `导出缺少段落：${need}`);
    }
    assert.ok(text.includes(ANSWER), '结论正文缺失');
    assert.ok(/\| E1 \| tabular-baseline#1 \| done \| test\.accuracy=0\.980556 \|/.test(text), '实验表格缺少 E1 行');
    assert.ok(text.includes(RUN), '运行编号缺失');
    assert.ok(text.includes('b'.repeat(16)), '产物哈希缺失');
    assert.ok(text.includes('pythonVersion') && !text.includes('AppData'), '环境信息应只含版本号，不带本机路径');
    const libStart = text.indexOf('## 资料库');
    assert.ok(libStart >= 0, '导出缺少资料库段落');
    assert.ok(text.includes('| S1 | arxiv | 2024 |'), '资料库明细缺失');
    assert.ok(!/sk-[A-Za-z0-9]{8}/.test(text), '导出里出现了疑似密钥');

    /* 点完之后那颗按钮就地变成「打开所在文件夹」，不重渲染整页。 */
    const buttonLabel = await js(`document.querySelector('button[data-reveal]')?.textContent || ''`);
    assert.equal(buttonLabel, '打开所在文件夹', '导出后按钮应变成打开所在文件夹');
    const toastText = await js(`document.querySelector('#toast').textContent`);
    assert.ok(toastText.includes('已导出'), `提示文案不对：${toastText}`);

    /* renderer 不能拿 reveal 当任意文件探测器：没导出过的路径必须被拒绝。 */
    const revealVerdict = await js(`window.duet.reveal('C:\\\\Windows\\\\win.ini').then(() => 'allowed', () => 'rejected')`);
    assert.equal(revealVerdict, 'rejected', '未导出过的路径不该允许定位');

    /* 再导一次：同名文件不能被覆盖，上一次的成果要留得住 */
    await js(`window.duet.exportResult({ id: '${CONV}', messageId: 'a-export', mode: 'quick' })`);
    const after = fs.readdirSync(exportRoot).filter(name => name.endsWith('.md'));
    assert.equal(after.length, 2, `第二次导出应生成新文件，实际 ${JSON.stringify(after)}`);
    assert.ok(after.some(name => /-2\.md$/.test(name)), '第二次导出应带 -2 后缀');

    assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(' | ')}`);

    console.log(JSON.stringify({ passed: true, file: exported[0], bytes: text.length, files: after.length, dataRoot, exportRoot }, null, 2));
  } finally {
    try { socket.close(); } catch { /* 已断开 */ }
    child.kill();
    await delay(300);
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 进程可能还占着文件 */ }
    try { fs.rmSync(exportRoot, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
})().catch(error => { console.error(JSON.stringify({ passed: false, error: String(error?.message || error) })); process.exitCode = 1; });
