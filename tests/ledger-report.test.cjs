const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildReport, formatReport, readLedger, displayWidth } = require('../core/harness/ledger-report.cjs');

const CLI = path.join(__dirname, '..', 'core', 'harness', 'ledger-report.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ledger-report-'));
}

/* 一份手算得出的假账本：数字都能对着 entries 一条条数出来，
   断言就不必依赖"跑一遍看看输出长什么样"。
   seq / at 都写死，墙钟 2700 - 1000 = 1700ms 是确定值，不随机器变。 */
function fakeLedger() {
  return [
    { seq: 1, at: 1000, type: 'run.start', runId: 'run-2026a', profile: 'p6-review' },
    { seq: 2, at: 1000, type: 'stage.enter', runId: 'run-2026a', stage: 'scope' },
    { seq: 3, at: 1500, type: 'artifact.write', runId: 'run-2026a', artifactId: 'art-1', stage: 'scope', kind: 'note', chars: 100, sha256: 'aa' },
    { seq: 4, at: 2000, type: 'loop.tools', stage: 'explore', step: 1, names: ['read_artifact', 'run_shell'], chars: 400 },
    { seq: 5, at: 2100, type: 'tool.call', stage: 'explore', step: 1, name: 'read_artifact', ok: true, ms: 100 },
    { seq: 6, at: 2300, type: 'tool.call', stage: 'explore', step: 1, name: 'run_shell', ok: false, ms: 200, error: '退出码 1' },
    { seq: 7, at: 2600, type: 'loop.final', stage: 'explore', step: 2, chars: 250, ms: 600, mode: 'loop' },
    { seq: 8, at: 2700, type: 'tool.call', stage: 'explore', step: 2, name: 'read_artifact', ok: true, ms: 50 }
  ];
}

test('假账本：runId / 轮次 / 工具调用数 / 墙钟 / 类型计数都对得上', () => {
  const report = buildReport(fakeLedger());
  assert.equal(report.runId, 'run-2026a');
  /* 轮次 = loop.tools + loop.final + loop.parse-error = 1 + 1 + 0 */
  assert.equal(report.turns, 2);
  /* 工具调用次数 = tool.call 条数 */
  assert.equal(report.calls, 3);
  assert.equal(report.wallClockMs, 1700);
  assert.deepEqual(report.byType, {
    'run.start': 1,
    'stage.enter': 1,
    'artifact.write': 1,
    'loop.tools': 1,
    'tool.call': 3,
    'loop.final': 1
  });
  assert.equal(report.truncation.lines, 8);
  assert.equal(report.truncation.corrupt, 0);
});

test('工具统计：成功/失败/平均耗时逐项正确，按调用次数排序', () => {
  const report = buildReport(fakeLedger());
  assert.equal(report.tools.length, 2);

  const [first, second] = report.tools;
  assert.deepEqual(first, {
    name: 'read_artifact', calls: 2, ok: 2, failed: 0, avgMs: 75, totalChars: 0
  });
  assert.deepEqual(second, {
    name: 'run_shell', calls: 1, ok: 0, failed: 1, avgMs: 200, totalChars: 0
  });

  /* 各工具的 calls 之和必须等于总调用数，否则报表内部就自相矛盾。 */
  const sum = report.tools.reduce((total, tool) => total + tool.calls, 0);
  assert.equal(sum, report.calls);

  const okSum = report.tools.reduce((total, tool) => total + tool.ok + tool.failed, 0);
  assert.equal(okSum, report.calls);
});

test('阶段统计：记录数、字符、毫秒按 stage 相加，按耗时有耗时的在前', () => {
  const report = buildReport(fakeLedger());
  assert.equal(report.stages.length, 2);

  const explore = report.stages.find(item => item.stage === 'explore');
  /* explore 下有 loop.tools(4) + 三条 tool.call(5,6,8) + loop.final(7) = 5 条记录 */
  assert.deepEqual(explore, { stage: 'explore', calls: 5, chars: 650, ms: 950 });

  const scope = report.stages.find(item => item.stage === 'scope');
  /* scope 下有 stage.enter(2) + artifact.write(3) = 2 条记录 */
  assert.deepEqual(scope, { stage: 'scope', calls: 2, chars: 100, ms: 0 });

  assert.equal(report.stages[0].stage, 'explore', '有耗时的阶段应排在前面');
});

test('失败收集：tool.call 失败与 loop.parse-error 都进 failures，并在 formatReport 里数出来', () => {
  const entries = [
    ...fakeLedger(),
    { seq: 9, at: 2800, type: 'loop.parse-error', stage: 'explore', step: 3, error: '缺少 tool 块' }
  ];
  const report = buildReport(entries);
  assert.equal(report.failures.length, 2);
  assert.deepEqual(report.failures[0], { type: 'tool.call', name: 'run_shell', error: '退出码 1', at: 2300 });
  assert.deepEqual(report.failures[1], { type: 'loop.parse-error', name: null, error: '缺少 tool 块', at: 2800 });
  assert.equal(report.turns, 3, '一次协议写错也是一次模型往返');

  const text = formatReport(report);
  assert.match(text, /失败 2/);
  /* 两类各一条是并列：必须如实说"各 1 次"，不能默默挑一类冒充结论。 */
  assert.match(text, /失败最多：loop\.parse-error、tool\.call run_shell（各 1 次）/);
});

test('tool.call 带 chars 时总字符按工具累加（当前 loop.cjs 不写这个字段，字段仍要正确）', () => {
  const entries = [
    { seq: 1, at: 10, type: 'tool.call', stage: 'explore', name: 'read_artifact', ok: true, ms: 10, chars: 120 },
    { seq: 2, at: 20, type: 'tool.call', stage: 'explore', name: 'read_artifact', ok: true, ms: 30, chars: 80 },
    { seq: 3, at: 30, type: 'tool.call', stage: 'explore', name: 'write_note', ok: false, ms: 5, chars: 0, error: '盘满' }
  ];
  const report = buildReport(entries);
  const read = report.tools.find(tool => tool.name === 'read_artifact');
  assert.equal(read.totalChars, 200);
  assert.equal(read.avgMs, 20);
  const write = report.tools.find(tool => tool.name === 'write_note');
  assert.equal(write.totalChars, 0);
  assert.equal(write.failed, 1);
  /* 有工具真的记了 chars，就不该再打那行"不记账 chars"的说明。 */
  assert.equal(formatReport(report).includes('不记账 chars'), false);
});

test('空账本与畸形输入不崩：返回零值报表，formatReport 也能出文本', () => {
  for (const input of [[], null, undefined, {}, [], { entries: [] }]) {
    const report = buildReport(input);
    assert.equal(report.runId, null);
    assert.equal(report.turns, 0);
    assert.equal(report.calls, 0);
    assert.equal(report.wallClockMs, 0);
    assert.deepEqual(report.byType, {});
    assert.deepEqual(report.tools, []);
    assert.deepEqual(report.stages, []);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.truncation, { lines: 0, corrupt: 0 });

    const text = formatReport(report);
    assert.match(text, /\((未知|没有)/);
    assert.match(text, /账本摘要/);
  }

  /* formatReport 也不该因为传了半个对象就炸。 */
  assert.equal(typeof formatReport(undefined), 'string');
  assert.equal(typeof formatReport({ tools: [{}], failures: [{}] }), 'string');
});

test('坏行被跳过且计入 truncation，好行照常统计', () => {
  const good = [
    { seq: 1, at: 10, type: 'tool.call', stage: 's1', name: 'read_artifact', ok: true, ms: 10 },
    { seq: 2, at: 20, type: 'loop.final', stage: 's1', chars: 30, ms: 20 }
  ];

  /* 形态一：Ledger#read() 的返回值，坏行来自读盘那一层 */
  const viaRead = buildReport({ entries: good, corrupt: ['{"seq":3,"at":3', 'not json'] });
  assert.equal(viaRead.truncation.corrupt, 2);
  assert.equal(viaRead.truncation.lines, 4, 'lines = 有效行 + 坏行');
  assert.equal(viaRead.calls, 1);
  assert.equal(viaRead.turns, 1);

  /* 形态二：直接塞进数组的垃圾元素就地算坏行 */
  const dirty = [...good, null, 'garbage', 42, { at: 99 }, ['array'], { type: '' }];
  const viaArray = buildReport(dirty);
  assert.equal(viaArray.truncation.corrupt, 6);
  assert.equal(viaArray.truncation.lines, 8);
  assert.equal(viaArray.calls, 1);
  assert.equal(viaArray.tools[0].name, 'read_artifact');

  assert.match(formatReport(viaArray), /坏行 6/);
});

test('formatReport 输出含工具名、失败数与最贵的一步', () => {
  const text = formatReport(buildReport(fakeLedger()));
  assert.ok(text.includes('read_artifact'), '应列出工具名');
  assert.ok(text.includes('run_shell'), '应列出失败的工具名');
  assert.ok(text.includes('失败 1'), '表头应给出失败总数');
  assert.ok(text.includes('失败最多：tool.call run_shell（1 次）'));
  assert.ok(text.includes('最贵的一步：explore'), '耗时有值时应按毫秒选最贵阶段');
  assert.ok(text.includes('账本摘要  run-2026a'));
  assert.ok(text.includes('按类型') && text.includes('阶段') && text.includes('工具'));

  /* 中文字符按 2 列算，表格才不会错位。 */
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('账本'), 4);
  for (const line of text.split('\n')) {
    assert.ok(!/\t/.test(line), '不使用制表符，避免终端展开不一致');
    assert.ok(!/\x1b\[/.test(line), '不带颜色控制码');
  }
});

test('毫秒全为 0 时按字符兜底挑"最贵的一步"（真实账本目前就是这种情况）', () => {
  const entries = [
    { seq: 1, at: 100, type: 'artifact.write', stage: 'scope', artifactId: 'a1', chars: 113, sha256: 'x' },
    { seq: 2, at: 200, type: 'artifact.write', stage: 'plan', artifactId: 'a2', chars: 222, sha256: 'y' }
  ];
  const text = formatReport(buildReport(entries));
  assert.ok(text.includes('最贵的一步：plan（222 字符，账本里没有毫秒）'), text);
  assert.ok(text.includes('没有工具调用记录'));
  assert.ok(text.includes('没有失败记录'));
});

/* ---------- CLI ---------- */

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI：打印 formatReport 的结果并 exit 0', () => {
  const root = tempRoot();
  const runDir = path.join(root, 'run-2026a');
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'ledger.jsonl');
  fs.writeFileSync(file, fakeLedger().map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

  const result = runCli([runDir]);
  assert.equal(result.status, 0, result.stderr);
  const expected = formatReport(buildReport(readLedger(file), { runId: 'run-2026a' }));
  assert.equal(result.stdout.trimEnd(), expected.trimEnd());
  assert.ok(result.stdout.includes('read_artifact'));

  /* 直接给账本文件路径也应可用。 */
  const byFile = runCli([file]);
  assert.equal(byFile.status, 0, byFile.stderr);
  assert.equal(byFile.stdout.trimEnd(), result.stdout.trimEnd(), '传文件时 runId 应退回目录名，输出保持一致');
});

test('CLI：目录不存在 / 没有账本 / 账本为空都打一句人话并 exit 0', () => {
  const root = tempRoot();

  const missing = runCli([path.join(root, '不存在的run')]);
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /不存在，没有账本可导出/);

  const noLedger = path.join(root, 'run-empty-dir');
  fs.mkdirSync(noLedger, { recursive: true });
  const without = runCli([noLedger]);
  assert.equal(without.status, 0);
  assert.match(without.stdout, /没有 ledger\.jsonl/);

  const emptyRun = path.join(root, 'run-zero');
  fs.mkdirSync(emptyRun, { recursive: true });
  fs.writeFileSync(path.join(emptyRun, 'ledger.jsonl'), '', 'utf8');
  const empty = runCli([emptyRun]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /账本是空的/);

  /* 没有参数只打用法，同样是 exit 0：脚本里不该被"忘了带参数"弄成失败。 */
  const usage = runCli([]);
  assert.equal(usage.status, 0);
  assert.match(usage.stdout, /用法/);
});

test('CLI：坏行夹在真实账本里时照常出报表，并报出坏行数', () => {
  const root = tempRoot();
  const runDir = path.join(root, 'run-dirty');
  fs.mkdirSync(runDir, { recursive: true });
  const body = [
    '{"seq":1,"at":1000,"type":"artifact.write","runId":"run-dirty","stage":"scope","artifactId":"a1","kind":"note","chars":50,"sha256":"x"}',
    '{"seq":2,"at":1500,"type":"tool.call","stage":"scope","name":"read_artifact","ok":true,"ms":80}',
    '{"seq":3,"at":18',  /* 模拟进程被杀时写坏的半行 */
    '{"seq":4,"at":2000,"type":"loop.final","stage":"scope","chars":20,"ms":300}'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(runDir, 'ledger.jsonl'), body, 'utf8');

  const result = runCli([runDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /坏行 1/);
  assert.match(result.stdout, /read_artifact/);
  assert.match(result.stdout, /有效行 3/);
});
