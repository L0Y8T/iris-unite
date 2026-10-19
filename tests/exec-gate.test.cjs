/* 执行门禁验收：独立执行预算 + 无法核对的实验数字必须被标注出来。
 *
 * 这两件事是"执行平台"和"数字可信"之间的接缝：
 *   - 预算：模型调用预算管不到执行，执行需要自己的一本账；
 *   - 改写：指不回运行记录的数字不能原样留在正文里。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBudget, DEFAULT_EXEC_LIMITS } = require('../core/exec/budget.cjs');
const claims = require('../core/exec/claims.cjs');

const NOW = new Date('2026-03-10T12:00:00').getTime();
const entry = (over = {}) => ({ runId: 'run-x', conversationId: 'c1', startedAt: NOW - 3600000, durationMs: 5000, status: 'done', ...over });

/* ── 执行预算 ─────────────────────────────────────────────────────── */

test('执行预算：空索引时可用，剩余额度取三项里最小的', () => {
  const budget = evaluateBudget({ runs: [], conversationId: 'c1', now: NOW });
  assert.equal(budget.ok, true);
  assert.equal(budget.remainingRuns, DEFAULT_EXEC_LIMITS.maxRunsPerConversation);
  assert.equal(budget.checks.length, 3);
});

test('执行预算：本对话次数到顶就拒绝，并说明是哪一项', () => {
  const runs = Array.from({ length: 20 }, (_, i) => entry({ runId: 'run-' + i }));
  const budget = evaluateBudget({ runs, conversationId: 'c1', now: NOW });
  assert.equal(budget.ok, false);
  assert.match(budget.reason, /本对话运行次数已达上限（20\/20）/);
  // 别的对话不受影响
  assert.equal(evaluateBudget({ runs, conversationId: 'other', now: NOW }).ok, true);
});

test('执行预算：没有打开的对话时不按「本对话」计数，只受每日额度约束', () => {
  const runs = Array.from({ length: 20 }, (_, i) => entry({ runId: 'run-n' + i }));
  const budget = evaluateBudget({ runs, conversationId: null, now: NOW });
  assert.equal(budget.ok, true, '独立运行不该被「本对话 20 次」挡住');
  assert.equal(budget.checks.some(check => check.key === 'conversation-runs'), false);
  assert.equal(budget.remainingRuns, DEFAULT_EXEC_LIMITS.maxRunsPerDay - 20);
});

test('执行预算：今日次数与今日时长分别把关，昨天的运行不计入今天', () => {
  const many = Array.from({ length: 50 }, (_, i) => entry({ runId: 'run-d' + i, durationMs: 1000 }));
  assert.equal(evaluateBudget({ runs: many, conversationId: null, now: NOW }).ok, false);

  const longRuns = [entry({ durationMs: 7200 * 1000 }), entry({ runId: 'run-b', durationMs: 1000 })];
  const wallLimited = evaluateBudget({ runs: longRuns, conversationId: 'c1', now: NOW });
  assert.equal(wallLimited.ok, false);
  assert.match(wallLimited.reason, /今日执行时长/);

  const yesterday = [entry({ startedAt: NOW - 86400000, durationMs: 7200 * 1000 })];
  const fresh = evaluateBudget({ runs: yesterday, conversationId: 'c1', now: NOW });
  assert.equal(fresh.ok, true, '昨天的运行不应占今天的额度');
});

test('执行预算：单次运行时长异常也不让账目失衡', () => {
  const budget = evaluateBudget({ runs: [entry({ durationMs: null }), entry({ runId: 'run-2', durationMs: undefined })], conversationId: 'c1', now: NOW });
  assert.equal(budget.ok, true);
  assert.ok(budget.checks.find(c => c.key === 'day-wall-clock').used === 0);
});

/* ── 无法核对数字的改写 ───────────────────────────────────────────── */

const doneRun = {
  runId: 'run-1', label: 'E1', status: 'done', startedAt: 1,
  template: { id: 'tabular-baseline', name: '表格基线' },
  params: { epochs: 2 }, artifacts: [{ name: 'metrics.json', bytes: 1, sha256: 'x' }],
  metrics: { test: { accuracy: 0.973 } }
};

test('改写：核验通过时正文原样返回', () => {
  const report = claims.verify('准确率 97.3% [E1]。', [doneRun]);
  const redacted = claims.redact('准确率 97.3% [E1]。', report);
  assert.equal(report.ok, true);
  assert.equal(redacted.text, '准确率 97.3% [E1]。');
  assert.deepEqual(redacted.removed, []);
});

test('改写：指向不存在运行的标记被删掉，并留下记录', () => {
  const text = '结果见 [E9]。';
  const report = claims.verify(text, [doneRun]);
  const redacted = claims.redact(text, report);
  assert.equal(redacted.text.includes('[E9]'), false);
  assert.equal(redacted.removed.length, 1);
  assert.equal(redacted.removed[0].kind, 'marker');
  assert.match(redacted.note, /1 处/);
});

test('改写：指不回记录的数字被包成〔未核对：…〕，原值仍可见', () => {
  const text = '准确率 88.8% [E1]。';
  const report = claims.verify(text, [doneRun]);
  const redacted = claims.redact(text, report);
  assert.match(redacted.text, /〔未核对：88\.8%〕/);
  assert.equal(redacted.text.includes('88.8%'), true, '不能把原值抹掉，要标出来');
  assert.equal(redacted.removed[0].kind, 'number');
});

test('改写：同一数值出现多次时全部标注，不漏掉第二处', () => {
  const text = '准确率 88.8% [E1]，另一处又写 88.8%。';
  const report = claims.verify(text, [doneRun]);
  const redacted = claims.redact(text, report);
  assert.equal((redacted.text.match(/〔未核对：88\.8%〕/g) || []).length, 2);
});

/* ── driver 层：执行方式可插拔 ─────────────────────────────────────── */

const drivers = require('../core/exec/driver.cjs');
const templates = require('../core/exec/templates.cjs');

test('driver 层：每个模板都能解析到一个 driver，且隔离状况如实标注', () => {
  for (const template of templates.TEMPLATES) {
    const driver = drivers.resolve(template);
    assert.equal(driver.id, template.driver, template.id + ' 的 driver 与声明不一致');
    assert.equal(typeof driver.prepare, 'function');
    assert.equal(typeof driver.run, 'function');
  }
  const [described] = drivers.describe();
  assert.equal(described.isolation, 'none', '当前实现没有 OS 隔离，不能美化');
  assert.equal(described.network, 'allowed', '当前实现不阻断网络，不能美化');
});

test('driver 层：模板要求别的 driver 时明确拒绝，而不是偷偷用本机跑', () => {
  const foreign = { id: 'x', name: 'x', requires: { packages: ['numpy'] }, driver: 'wsl-container' };
  assert.throws(() => drivers.resolve(foreign), /本期尚未提供/);
});
