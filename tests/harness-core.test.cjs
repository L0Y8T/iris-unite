const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ids = require('../core/harness/ids.cjs');
const { openLedger } = require('../core/harness/ledger.cjs');
const { openWorkspace, listRuns, pruneRuns, summarize, sha256 } = require('../core/harness/workspace.cjs');
const { assemble } = require('../core/harness/context.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-harness-'));
}

/* ---------- ids ---------- */

test('runId 与 artifactId 格式可校验、可解析出创建时间', () => {
  const before = Date.now();
  const runId = ids.newRunId();
  const after = Date.now();
  assert.ok(ids.isRunId(runId), runId);
  assert.equal(ids.isArtifactId(runId), false);
  const created = ids.runCreatedAt(runId);
  assert.ok(created >= before && created <= after + 1000, `解析出的时间应落在生成区间内，实得 ${created}`);

  const artifactId = ids.newArtifactId();
  assert.ok(ids.isArtifactId(artifactId));
  assert.equal(ids.isRunId(artifactId), false);
  assert.equal(ids.isArtifactId('art-xyz'), false, '非十六进制必须拒绝');
  assert.equal(ids.isRunId('run-../../etc'), false, '路径穿越必须拒绝');
  assert.equal(ids.runCreatedAt('nope'), null);
});

test('safeSegment 把任意 stage 名收敛成安全目录名', () => {
  assert.equal(ids.safeSegment('research-final'), 'research-final');
  assert.equal(ids.safeSegment('../../etc/passwd'), 'etc-passwd');
  assert.equal(ids.safeSegment('中文 环节/一'), '中文-环节-一');
  assert.equal(ids.safeSegment(''), 'misc');
  assert.equal(ids.safeSegment('A'.repeat(200)).length, 64);
});

/* ---------- ledger ---------- */

test('账本只追加，seq 连续，读回顺序稳定', () => {
  const root = tempRoot();
  const file = path.join(root, 'ledger.jsonl');
  const ledger = openLedger(file);
  ledger.append('run.start', { profile: 'p1-review' });
  ledger.append('stage.enter', { stage: 'research-scope' });
  ledger.append('call.end', { provider: 'deepseek', chars: 1234 });
  const { entries, corrupt } = ledger.read();
  assert.equal(corrupt.length, 0);
  assert.deepEqual(entries.map(entry => entry.seq), [1, 2, 3]);
  assert.deepEqual(entries.map(entry => entry.type), ['run.start', 'stage.enter', 'call.end']);
  assert.equal(entries[2].chars, 1234);
  assert.ok(entries.every(entry => typeof entry.at === 'number' && entry.at > 0));
  assert.deepEqual(ledger.tail(2).map(entry => entry.type), ['stage.enter', 'call.end']);
  assert.deepEqual(ledger.where('call.end').map(entry => entry.seq), [3]);
  assert.deepEqual(ledger.verify(), { ok: true, entries: 3, corrupt: 0, problems: [] });
});

test('账本重新打开后接着原有 seq 继续，不复用编号', () => {
  const root = tempRoot();
  const file = path.join(root, 'ledger.jsonl');
  openLedger(file).append('run.start', {});
  const reopened = openLedger(file);
  reopened.append('run.end', { status: 'done' });
  assert.deepEqual(reopened.read().entries.map(entry => entry.seq), [1, 2]);
});

test('账本坏行只记进 corrupt，不影响其余记录读取', () => {
  const root = tempRoot();
  const file = path.join(root, 'ledger.jsonl');
  const ledger = openLedger(file);
  ledger.append('run.start', {});
  fs.appendFileSync(file, '{"seq":2,"type":"broken"\n', 'utf8');
  ledger.append('run.end', { status: 'done' });
  const report = ledger.read();
  assert.equal(report.entries.length, 2);
  assert.equal(report.corrupt.length, 1);
  const verified = ledger.verify();
  assert.equal(verified.ok, false);
  assert.match(verified.problems.join('；'), /无法解析/);
});

test('关闭后的账本拒绝写入，避免“看着在记、其实没记”', () => {
  const root = tempRoot();
  const ledger = openLedger(path.join(root, 'ledger.jsonl'));
  ledger.close();
  assert.throws(() => ledger.append('run.end', {}), /已关闭/);
});

/* ---------- workspace ---------- */

test('产物写入后可按字符偏移续读，sha256 与字数为真', () => {
  const root = tempRoot();
  const runId = ids.newRunId();
  const ws = openWorkspace({ root, runId, meta: { profile: 'p1-review' } });
  const body = '第一段结论。\n' + 'B'.repeat(2000) + '\n尾部收口。';
  const record = ws.writeArtifact({ stage: 'research-scope', provider: 'deepseek', title: '界定', text: body });

  assert.ok(ids.isArtifactId(record.id));
  assert.equal(record.chars, body.length);
  assert.equal(record.sha256, sha256(body));
  assert.equal(record.file, `artifacts/research-scope/${record.id}.md`);
  assert.ok(fs.existsSync(path.join(ws.dir, record.file)));

  const head = ws.readArtifact(record.id, { offset: 0, limit: 100 });
  assert.equal(head.text.length, 100);
  assert.equal(head.total, body.length);
  assert.equal(head.next, 100);

  const rest = ws.readArtifact(record.id, { offset: head.next });
  assert.equal(rest.text, body.slice(100));
  assert.equal(rest.next, null, '读到底之后 next 应为 null');

  assert.equal(ws.getArtifact('art-deadbeef'), null, '不存在的产物返回 null 而不是抛错');
  assert.throws(() => ws.readArtifact('art-deadbeef'), /找不到产物/);
});

test('产物不可变：同一 id 重复写入必须被拒绝', () => {
  const root = tempRoot();
  const ws = openWorkspace({ root, runId: ids.newRunId() });
  const record = ws.writeArtifact({ stage: 'outline', text: '原始内容' });
  assert.throws(() => ws.writeArtifact({ stage: 'outline', id: record.id, text: '被改写的内容' }), /已存在/);
  assert.equal(ws.readArtifact(record.id).text, '原始内容');
});

test('完整性自检能发现盘上产物被改动', () => {
  const root = tempRoot();
  const ws = openWorkspace({ root, runId: ids.newRunId() });
  const record = ws.writeArtifact({ stage: 'final', text: '原始答案' });
  assert.deepEqual(ws.verifyArtifacts(), { ok: true, checked: 1, problems: [] });

  fs.writeFileSync(path.join(ws.dir, record.file), '被篡改的答案', 'utf8');
  const checked = ws.verifyArtifacts();
  assert.equal(checked.ok, false);
  assert.match(checked.problems.join('；'), /内容被改动/);
});

test('工作区元数据与账本随 run 落盘，重新打开后仍可读', () => {
  const root = tempRoot();
  const runId = ids.newRunId();
  const ws = openWorkspace({ root, runId, meta: { profile: 'p0-query' } });
  ws.setMeta({ status: 'done', stage: 'research-final' });
  ws.writeArtifact({ stage: 'final', kind: 'final', text: '最终正文' });
  ws.close();

  const reopened = openWorkspace({ root, runId });
  assert.equal(reopened.getMeta().profile, 'p0-query');
  assert.equal(reopened.getMeta().status, 'done');
  assert.equal(reopened.listArtifacts().length, 1);
  const types = reopened.ledger.read().entries.map(entry => entry.type);
  assert.ok(types.includes('artifact.write'));

  const runs = listRuns({ root });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, runId);
});

test('摘要把标题、小节与实验编号提取成可装配信号', () => {
  const text = '## 结果\n\n在 CartPole 上 [E1] 达到 500 步，[E2] 为 320 步。\n\n## 局限\n\n样本少。';
  const digest = summarize(text, 200);
  assert.equal(digest.title, '结果');
  const kinds = digest.signals.map(signal => signal.kind);
  assert.ok(kinds.includes('sections'));
  assert.ok(kinds.includes('experiments'));
  const experiment = digest.signals.find(signal => signal.kind === 'experiments');
  assert.deepEqual(experiment.values, ['E1', 'E2']);
});

/* ---------- context ---------- */

test('短材料全文内联，长材料溢出并给出可照抄的续读句柄', () => {
  const short = '这是很短的材料。';
  const long = '头部结论。\n' + 'X'.repeat(9000) + '\n尾部表格。';
  const assembled = assemble({
    task: '综合双方大纲',
    question: '验证策略梯度',
    parts: [
      { title: '独立大纲', text: short, id: 'art-11111111' },
      { title: '探索结果', text: long, id: 'art-22222222' }
    ]
  });

  assert.match(assembled.text, /【任务】\n综合双方大纲/);
  assert.match(assembled.text, /\[M1\] 独立大纲/);
  assert.ok(assembled.text.includes(short), '短材料必须全文出现');
  assert.ok(!assembled.text.includes('X'.repeat(5000)), '长材料不得整段灌进上下文');
  assert.match(assembled.text, /\[M2\] 探索结果/);
  assert.match(assembled.text, /read_artifact id=art-22222222 offset=1200/);
  assert.equal(assembled.stats.inlined, 1);
  assert.equal(assembled.stats.spilled, 1);
  assert.deepEqual(assembled.spill.map(item => item.id), ['art-22222222']);
});

test('总预算超限时从最长的内联项开始降级，而不是整段截断', () => {
  const big = 'A'.repeat(4000);
  const assembled = assemble({
    task: '任务',
    parts: [
      { title: '大材料', text: big, id: 'art-33333333' },
      { title: '小材料', text: '短内容', id: 'art-44444444' }
    ],
    limits: { total: 3000, itemInline: 5000 }
  });
  assert.equal(assembled.stats.downgraded, 1);
  assert.equal(assembled.stats.spilled, 1);
  assert.equal(assembled.stats.inlined, 1, '小材料应留在内联');
  assert.ok(assembled.stats.chars <= 3000, `装配后应在预算内，实得 ${assembled.stats.chars}`);
});

test('只有摘要没有全文时标注为摘要，不冒充全文', () => {
  const assembled = assemble({
    task: '评审',
    parts: [{ title: '远处材料', summary: '摘要内容', id: 'art-55555555' }]
  });
  assert.equal(assembled.stats.summarized, 1);
  assert.match(assembled.text, /摘要：摘要内容/);
  assert.ok(!assembled.text.includes('read_artifact'), '已给的摘要不应再要求续读');
});

test('装配结果确定：同样输入产生同样文本与 digest', () => {
  const args = { task: '任务', parts: [{ title: '材料', text: '正文', id: 'art-66666666' }] };
  const first = assemble(args);
  const second = assemble(args);
  assert.equal(first.text, second.text);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest.length, 16);
});

/* ---------- 运行目录清理 ---------- */

test('运行目录按创建顺序先进先出清理，正在运行的不动', async () => {
  const root = tempRoot();
  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const runId = ids.newRunId();
    /* 把最旧的那个标成 running：它落在可删区间里，正好用来验证保护分支。 */
    const ws = openWorkspace({ root, runId, meta: i === 0 ? { status: 'running' } : { status: 'done' } });
    ws.writeArtifact({ stage: 'x', text: `内容 ${i}` });
    ws.close();
    made.push(runId);
    // runId 的时间戳精度是毫秒，串行创建可能撞同一毫秒，显式等一下保证排序稳定。
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(listRuns({ root }).length, 5);

  const pruned = pruneRuns({ root, keep: 2 });
  const left = listRuns({ root }).map(run => run.runId);
  assert.ok(left.includes(made[0]), 'running 的目录不能被删，哪怕它最旧');
  assert.ok(!left.includes(made[1]), '最旧的普通目录应被清掉');
  assert.ok(!left.includes(made[2]), '第二批普通目录也应被清掉');
  assert.equal(left.length, 3, `5 个删 2 个、留 running 与最近两份，实得 ${left.length}`);
  assert.equal(pruned.removed.length, 2);
});

test('运行目录没超过上限时一个都不删', () => {
  const root = tempRoot();
  for (let i = 0; i < 3; i += 1) openWorkspace({ root, runId: ids.newRunId(), ledger: false }).close();
  const pruned = pruneRuns({ root, keep: 10 });
  assert.deepEqual(pruned.removed, []);
  assert.equal(listRuns({ root }).length, 3);
});
