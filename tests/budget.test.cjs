const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedger, BudgetError } = require('../core/budget.cjs');

test('占位、发出、结算：失败与取消的已发请求照样计数', () => {
  const ledger = createLedger({ limit: 5, reserve: 1 });
  const a = ledger.reserveSlot('research-scope');
  assert.equal(ledger.outstanding(), 1);
  assert.equal(ledger.remaining(), 4);
  ledger.dispatch(a);
  assert.equal(ledger.spent(), 1);
  ledger.settle(a, 'succeeded');

  const b = ledger.reserveSlot('research-evidence');
  ledger.dispatch(b);
  ledger.settle(b, 'failed');
  const c = ledger.reserveSlot('research-summarize');
  ledger.dispatch(c);
  ledger.settle(c, 'cancelled');

  assert.equal(ledger.spent(), 3, '失败与取消也占额度');
  assert.equal(ledger.remaining(), 2);
  assert.equal(ledger.assertConsistent(), true);
});

test('未发出的预约必须能释放，且释放后不占额度', () => {
  const ledger = createLedger({ limit: 3, reserve: 0 });
  const a = ledger.reserveSlot('research-refine', { required: false });
  ledger.release(a, { note: '跳过深化' });
  assert.equal(ledger.remaining(), 3);
  assert.equal(ledger.spent(), 0);
  assert.throws(() => ledger.dispatch(a), /不能转为 dispatched/);
});

test('已发出的请求不能释放额度', () => {
  const ledger = createLedger({ limit: 3, reserve: 0 });
  const a = ledger.reserveSlot('x');
  ledger.dispatch(a);
  assert.throws(() => ledger.release(a), /已发出/);
});

test('保留额度保护最终输出：可选节点在余额不足时被拒绝', () => {
  const ledger = createLedger({ limit: 8, reserve: 2 });
  // 先花掉 6 次（模拟 P1 的五次固定 + 一次深化）
  for (let i = 0; i < 6; i++) {
    const id = ledger.reserveSlot('fixed', { required: true });
    ledger.dispatch(id);
    ledger.settle(id, 'succeeded');
  }
  assert.equal(ledger.remaining(), 2);
  assert.equal(ledger.canStartOptional(1), false, '剩余 2 次全是要保留给最终稿与终审的');
  assert.throws(() => ledger.reserveSlot('research-refine', { note: '深化' }), /需保留给最终输出/);
  // 必需节点仍然可以继续
  const finalSlot = ledger.reserveSlot('research-final', { required: true });
  ledger.dispatch(finalSlot);
  ledger.settle(finalSlot, 'succeeded');
  assert.equal(ledger.remaining(), 1);
});

test('文档 §9.2 的例子：P1 N=2、A=1、上限 9', () => {
  const ledger = createLedger({ limit: 9, reserve: 2 });
  // scope/evidence/plan/两份 explore/screen = 6
  for (const node of ['scope', 'evidence', 'plan', 'explore#1', 'explore#2', 'screen']) {
    const id = ledger.reserveSlot(node, { required: true });
    ledger.dispatch(id);
    ledger.settle(id, 'succeeded');
  }
  assert.equal(ledger.remaining(), 3, '还剩 3 次');
  assert.equal(ledger.canStartOptional(2), false, '不能把两项都深化');
  assert.equal(ledger.canStartOptional(1), true, '只能深化一项');
  const refine = ledger.reserveSlot('research-refine#1');
  ledger.dispatch(refine);
  ledger.settle(refine, 'succeeded');
  assert.throws(() => ledger.reserveSlot('research-refine#2'), /需保留给最终输出/);
});

test('硬上限：达到上限后必需节点也不能再发', () => {
  const ledger = createLedger({ limit: 2, reserve: 0 });
  for (let i = 0; i < 2; i++) {
    const id = ledger.reserveSlot('x', { required: true });
    ledger.dispatch(id);
    ledger.settle(id, 'succeeded');
  }
  assert.throws(() => ledger.reserveSlot('y', { required: true }), /达到上限/);
  assert.equal(ledger.assertConsistent(), true);
});

test('非法状态转换与非法构造都被拒绝', () => {
  assert.throws(() => createLedger({ limit: -1 }), /非负整数/);
  assert.throws(() => createLedger({ limit: 3, reserve: 5 }), /不能大于上限/);
  const ledger = createLedger({ limit: 3, reserve: 0 });
  const a = ledger.reserveSlot('x');
  assert.throws(() => ledger.settle(a, 'succeeded'), /不能结算/, '未发出不能结算');
  ledger.dispatch(a);
  assert.throws(() => ledger.dispatch(a), /不能转为 dispatched/);
  assert.throws(() => ledger.settle(a, 'weird'), /不支持的终态/);
  assert.throws(() => ledger.dispatch('nope'), /找不到尝试/);
});

test('快照可审计：按节点统计且包含每次尝试', () => {
  const ledger = createLedger({ limit: 4, reserve: 1 });
  const a = ledger.reserveSlot('research-scope', { required: true });
  ledger.dispatch(a); ledger.settle(a, 'succeeded');
  const b = ledger.reserveSlot('research-refine');
  ledger.release(b);
  const snap = ledger.snapshot();
  assert.equal(snap.limit, 4);
  assert.equal(snap.reserve, 1);
  assert.equal(snap.spent, 1);
  assert.equal(snap.remaining, 3);
  assert.equal(snap.byNode['research-scope'].succeeded, 1);
  assert.equal(snap.byNode['research-refine'].released, 1);
  assert.equal(snap.attempts.length, 2);
  assert.equal(snap.attempts[0].attemptId, 'a1');
});
