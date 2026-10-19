'use strict';
// tests/monitor.test.cjs —— core/monitor.cjs 的行为测试。
// 全部用注入的假时钟：监控模块自己不起定时器，时间只从 now() 来，所以测试可以精确控制。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LIMITS, createMonitor, hashText } = require('../core/monitor.cjs');

const T0 = 1792340000000;
const MINUTE = 60000;

// 假时钟：advance() 走时间，still() 不动（用来制造"没有任何变化"的观测）。
function fakeClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    }
  };
}

function artifact(overrides = {}) {
  return {
    id: 'a1',
    stage: 'research-explore',
    provider: 'deepseek',
    model: 'deepseek-flash',
    status: 'done',
    text: '一段研究产物',
    startedAt: T0 - 80000,
    finishedAt: T0 - 1000,
    error: null,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    conversationId: 'conv-1',
    stage: 'research-explore',
    stageLabel: '并行研究',
    stageIndex: 2,
    totalStages: 8,
    status: 'running',
    callsUsed: 3,
    callBudget: 8,
    artifacts: [],
    lastActivityAt: T0,
    ...overrides
  };
}

test('1. 正常推进不产生任何 decision', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  const produced = [];

  let snap = snapshot({ callsUsed: 1, artifacts: [artifact({ id: 'a1', status: 'running', text: '', finishedAt: null })] });
  produced.push(monitor.observe(snap));

  clock.advance(MINUTE);
  snap = snapshot({
    callsUsed: 2,
    lastActivityAt: clock.now(),
    artifacts: [artifact({ id: 'a1', text: '第一批增量' }), artifact({ id: 'a2', status: 'running', text: '', finishedAt: null })]
  });
  produced.push(monitor.observe(snap));

  clock.advance(MINUTE);
  snap = snapshot({
    stage: 'research-screen',
    stageLabel: '候选筛选',
    stageIndex: 3,
    callsUsed: 3,
    lastActivityAt: clock.now(),
    artifacts: [artifact({ id: 'a1', text: '第一批增量' }), artifact({ id: 'a2', text: '第二批候选' })]
  });
  produced.push(monitor.observe(snap));

  assert.deepEqual(produced, [null, null, null]);
  assert.equal(monitor.decisions.length, 0);
  assert.deepEqual(monitor.toJSON().decisions, []);
  // 阶段切换 + 调用数 + 产物都变了，指纹必须一直在变，空闲计数应为 0。
  assert.equal(monitor.toJSON().state.idleTicks, 0);
});

test('2. stall 第一次只 warn + none，第二次确认才 retry-cheaper', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  const running = artifact({ id: 'a1', status: 'running', text: '', finishedAt: null });
  const snap = () =>
    snapshot({
      callsUsed: 2,
      // 已经静默 10 分钟零 1 毫秒，刚越过 stallMs = 600000 的阈值
      lastActivityAt: T0 - DEFAULT_LIMITS.stallMs - 1,
      artifacts: [running]
    });

  const first = monitor.observe(snap());
  assert.ok(first, '首次静默超时应当报告');
  assert.equal(first.kind, 'stall');
  assert.equal(first.severity, 'warn');
  assert.equal(first.action, 'none', '第一次只报告，不动手');
  assert.equal(first.detail.confirmations, 1);
  assert.equal(first.detail.silentMs, DEFAULT_LIMITS.stallMs + 1);
  assert.match(first.reason, /10 分/);

  clock.advance(30000);
  const second = monitor.observe(snap());
  assert.ok(second, '第二次确认应当升级动作');
  assert.equal(second.kind, 'stall');
  assert.equal(second.action, 'retry-cheaper');
  assert.equal(second.detail.confirmations, 2);
  assert.match(second.reason, /连续 2 次确认/);

  // 第三次同样静默：动作不再变化，不允许重复堆 decision。
  clock.advance(30000);
  assert.equal(monitor.observe(snap()), null);
  assert.equal(monitor.decisions.length, 2);

  // 增量恢复后再静默，是新的一段异常，计数重新从 1 开始。
  clock.advance(MINUTE);
  const fresh = snapshot({
    callsUsed: 3,
    lastActivityAt: clock.now(),
    artifacts: [artifact({ id: 'a1', status: 'running', text: '恢复增量', finishedAt: null })]
  });
  assert.equal(monitor.observe(fresh), null, '恢复增量时不该有决策');
  clock.advance(DEFAULT_LIMITS.stallMs + 1000);
  const again = monitor.observe(fresh);
  assert.ok(again);
  assert.equal(again.kind, 'stall');
  assert.equal(again.action, 'none', '重新计数后第一次仍然只报告');
  assert.equal(again.detail.confirmations, 1);
});

test('3. duplicate 能找到重复产物，第二次确认后才 skip-stage', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  const first = artifact({ id: 'art-1', text: '同一份结论：气候模型误差主要来自边界条件' });
  const second = artifact({ id: 'art-2', text: '同一份结论：气候模型误差主要来自边界条件' });

  const firstDecision = monitor.observe(snapshot({ callsUsed: 2, artifacts: [first, second] }));
  assert.ok(firstDecision);
  assert.equal(firstDecision.kind, 'duplicate');
  assert.equal(firstDecision.severity, 'warn');
  assert.equal(firstDecision.action, 'none', '第一次只报告');
  assert.equal(firstDecision.detail.duplicateId, 'art-2');
  assert.equal(firstDecision.detail.duplicateOf, 'art-1');
  assert.equal(firstDecision.detail.hash, hashText(first.text));
  assert.match(firstDecision.reason, /art-2/);
  assert.match(firstDecision.reason, /art-1/);

  clock.advance(MINUTE);
  const secondDecision = monitor.observe(snapshot({ callsUsed: 3, lastActivityAt: clock.now(), artifacts: [first, second] }));
  assert.ok(secondDecision);
  assert.equal(secondDecision.kind, 'duplicate');
  assert.equal(secondDecision.action, 'skip-stage', '确认后才跳过阶段');
  assert.match(secondDecision.reason, /连续 2 次确认/);

  // 内容不同时不误报。
  const clean = createMonitor({ now: () => T0 });
  assert.equal(
    clean.observe(snapshot({ artifacts: [artifact({ id: 'x1', text: '结论甲' }), artifact({ id: 'x2', text: '结论乙' })] })),
    null
  );
});

test('4. 同一个错误连续 3 次出现才 abort，2 次不动手', () => {
  const clock = fakeClock();
  const errorOf = (id) => artifact({ id, status: 'error', text: '', finishedAt: T0, error: '401 invalid api key' });

  const notYet = createMonitor({ now: clock.now });
  assert.equal(notYet.observe(snapshot({ callsUsed: 2, artifacts: [errorOf('e1'), errorOf('e2')] })), null, '两次不算系统性故障');

  const monitor = createMonitor({ now: clock.now });
  const decision = monitor.observe(snapshot({ callsUsed: 3, artifacts: [errorOf('e1'), errorOf('e2'), errorOf('e3')] }));
  assert.ok(decision);
  assert.equal(decision.kind, 'repeat-failure');
  assert.equal(decision.severity, 'critical');
  assert.equal(decision.action, 'abort');
  assert.equal(decision.detail.count, 3);
  assert.deepEqual(decision.detail.artifactIds, ['e1', 'e2', 'e3']);
  assert.match(decision.reason, /401 invalid api key/);

  clock.advance(MINUTE);
  assert.equal(monitor.observe(snapshot({ callsUsed: 3, artifacts: [errorOf('e1'), errorOf('e2'), errorOf('e3')] })), null);
  assert.equal(monitor.decisions.length, 1);

  // 错误消息不同（换了一种故障）则不累计。
  const mixed = createMonitor({ now: clock.now });
  mixed.observe(snapshot({ callsUsed: 2, artifacts: [errorOf('e1'), errorOf('e2')] }));
  assert.equal(
    mixed.observe(snapshot({ callsUsed: 3, artifacts: [errorOf('e1'), errorOf('e2'), artifact({ id: 'e3', status: 'error', error: '超时', text: '' })] })),
    null
  );
});

test('5. 预算不足时提醒，且不误报', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });

  // 预算充裕：7 次里只用 2 次，不该提醒。
  assert.equal(monitor.observe(snapshot({ callsUsed: 2, callBudget: 8 })), null);
  // 距离耗尽还剩 2 次 > budgetReserve(1)，仍然不该提醒。
  assert.equal(monitor.observe(snapshot({ callsUsed: 6, callBudget: 8 })), null);

  clock.advance(MINUTE);
  const warn = monitor.observe(snapshot({ callsUsed: 7, callBudget: 8, lastActivityAt: clock.now() }));
  assert.ok(warn);
  assert.equal(warn.kind, 'budget');
  assert.equal(warn.severity, 'info');
  assert.equal(warn.action, 'none', '预算只提醒，不自动处置');
  assert.equal(warn.detail.remaining, 1);
  assert.equal(warn.detail.reserve, DEFAULT_LIMITS.budgetReserve);
  assert.match(warn.reason, /剩余 1 次调用/);
  assert.match(warn.reason, /为终审预留/);

  // 同一组数字再观测一次不重复报。
  clock.advance(MINUTE);
  assert.equal(monitor.observe(snapshot({ callsUsed: 7, callBudget: 8, lastActivityAt: clock.now() })), null);

  // 预算极小（总 2 次）时第一次调用就贴线，属于噪音，靠 minCallsForBudgetWarn 压住。
  const tiny = createMonitor({ now: clock.now });
  assert.equal(tiny.observe(snapshot({ callsUsed: 1, callBudget: 2 })), null);

  // 真的用尽：警告级别升到 warn，并写明已超出。
  const spent = createMonitor({ now: clock.now });
  const over = spent.observe(snapshot({ callsUsed: 9, callBudget: 8 }));
  assert.ok(over);
  assert.equal(over.kind, 'budget');
  assert.equal(over.severity, 'warn');
  assert.equal(over.detail.remaining, -1);
  assert.match(over.reason, /超出预算/);
});

test('6. 连续 4 次观测无变化判为 no-progress', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  // 完全没有产物、也没有任何变化：既不会 stall（没有 running 产物），也不会 duplicate。
  const frozen = snapshot({ callsUsed: 2, artifacts: [] });

  assert.equal(monitor.observe(frozen), null, '第 1 次只是建立基线');
  clock.advance(MINUTE);
  assert.equal(monitor.observe(frozen), null);
  clock.advance(MINUTE);
  assert.equal(monitor.observe(frozen), null);
  clock.advance(MINUTE);
  assert.equal(monitor.observe(frozen), null, '累计 3 次无变化还差一次');

  clock.advance(MINUTE);
  const decision = monitor.observe(frozen);
  assert.ok(decision, '第 4 次连续无变化应当判定结束');
  assert.equal(decision.kind, 'no-progress');
  assert.equal(decision.severity, 'info');
  assert.equal(decision.action, 'none');
  assert.equal(decision.detail.idleTicks, DEFAULT_LIMITS.idleTicksToFinish);
  assert.match(decision.reason, /连续 4 次观测/);

  clock.advance(MINUTE);
  assert.equal(monitor.observe(frozen), null, '同一段无进展只报一次');

  // 有进展立刻清零，重新计时。
  clock.advance(MINUTE);
  assert.equal(monitor.observe(snapshot({ callsUsed: 3, artifacts: [artifact({ id: 'a9' })], lastActivityAt: clock.now() })), null);
  assert.equal(monitor.toJSON().state.idleTicks, 0);
});

test('7. status 变 done 只报一次 finished，且其余规则不再插话', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  // 故意同时放上"会触发别的规则"的材料：静默超时 + 重复产物 + 满预算。
  const dup = (id) => artifact({ id, text: '完全一样的内容' });
  const done = snapshot({
    status: 'done',
    stageIndex: 5,
    totalStages: 5,
    callsUsed: 8,
    callBudget: 8,
    lastActivityAt: T0 - DEFAULT_LIMITS.stallMs - 60000,
    artifacts: [dup('d1'), dup('d2')]
  });

  const first = monitor.observe(done);
  assert.ok(first);
  assert.equal(first.kind, 'finished');
  assert.equal(first.severity, 'info');
  assert.equal(first.action, 'none');
  assert.equal(first.detail.status, 'done');
  assert.match(first.reason, /status=done/);

  clock.advance(MINUTE);
  assert.equal(monitor.observe(done), null, '重复 observe 不重复报');
  assert.equal(monitor.decisions.length, 1);
  assert.ok(monitor.decisions.every((item) => item.kind === 'finished'), '终态下其它规则不该报');

  // 状态真的变成 error 属于新的状态变化，允许再报一次。
  const ended = monitor.observe({ ...done, status: 'error' });
  assert.ok(ended);
  assert.equal(ended.kind, 'finished');
  assert.equal(ended.detail.status, 'error');
  assert.equal(monitor.decisions.length, 2);
});

test('8. scene() 输出包含阶段、调用数与产物统计', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });
  const snap = snapshot({
    callsUsed: 3,
    callBudget: 8,
    lastActivityAt: clock.now() - (10 * MINUTE + 12000),
    artifacts: [
      artifact({ id: 's1', provider: 'deepseek', model: 'deepseek-flash', text: 'x'.repeat(1820) }),
      artifact({ id: 's2', provider: 'gpt', model: 'gpt-6.1-sol', text: 'y'.repeat(900) }),
      artifact({ id: 's3', provider: 'gpt', model: 'gpt-6.1-sol', text: 'z'.repeat(50) }),
      artifact({ id: 's4', provider: 'gpt', model: 'gpt-6.1-sol', status: 'running', text: '', finishedAt: null })
    ]
  });

  monitor.observe(snap);
  const report = monitor.scene(snap);

  assert.equal(typeof report, 'string');
  assert.ok(report.includes('阶段 2/8'), report);
  assert.ok(report.includes('并行研究'), report);
  assert.ok(report.includes('调用 3/8'), report);
  assert.ok(report.includes('产物 4'), report);
  assert.ok(report.includes('完成 3'), report);
  assert.ok(report.includes('运行 1'), report);
  assert.ok(report.includes('失败 0'), report);
  assert.ok(report.includes('无增量 10 分 12 秒'), report);
  assert.ok(report.includes('最近产物：'), report);
  assert.ok(report.includes('[done]'), report);
  assert.ok(report.includes('[running]'), report);
  assert.ok(report.includes('1820 字'), report);
  assert.ok(report.includes('决策：none'), report);
  // 报告是给人直接看的文本，不该出现 Markdown 或 emoji 之类的装饰。
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(report), '不允许出现 emoji');

  // 有决策时抬头写清触发的是哪条规则，并带上动作和理由。
  const clock2 = fakeClock();
  const second = createMonitor({ now: clock2.now });
  const stalled = snapshot({
    callsUsed: 2,
    lastActivityAt: T0 - DEFAULT_LIMITS.stallMs - 1,
    artifacts: [artifact({ id: 'r1', status: 'running', text: '', finishedAt: null })]
  });
  second.observe(stalled);
  clock2.advance(30000);
  second.observe(stalled);
  const stalledReport = second.scene(stalled);
  assert.match(stalledReport, /^=== 监控触发：stall   \d+:\d\d:\d\d ===/);
  assert.match(stalledReport, /决策：retry-cheaper — /);
});

test('9. hashText 稳定、定长，且能区分不同文本', () => {
  assert.equal(hashText('同一段文本'), hashText('同一段文本'));
  assert.match(hashText('任意内容'), /^[0-9a-f]{16}$/, '必须是 16 位十六进制');
  assert.match(hashText(''), /^[0-9a-f]{16}$/);
  assert.notEqual(hashText('结论甲'), hashText('结论乙'));
  // 只是空白/换行不同不算新内容（模型换个排版不等于重新研究）。
  assert.equal(hashText('  甲\n\n乙  '), hashText('甲 乙'));
  assert.notEqual(hashText('a'.repeat(1000)), hashText(`${'a'.repeat(1000)}b`));
  assert.throws(() => hashText(123), TypeError, '非字符串要直接报错，不要静默当成空串');
});

test('10. 幂等：同一异常连续 observe 不重复堆 decision', () => {
  const clock = fakeClock();
  const monitor = createMonitor({ now: clock.now });

  // 重复产物连观测 5 次：第 1 次 none、第 2 次升为 skip-stage，之后不再重复堆。
  const dup = (id) => artifact({ id, text: '一模一样的正文' });
  const snap = snapshot({ callsUsed: 3, artifacts: [dup('p1'), dup('p2')] });
  const firstDup = monitor.observe(snap);
  assert.equal(firstDup.action, 'none');
  clock.advance(MINUTE);
  const confirmed = monitor.observe(snap);
  assert.equal(confirmed.action, 'skip-stage', '两次确认后才跳过');
  for (let index = 0; index < 2; index += 1) {
    clock.advance(MINUTE);
    assert.equal(monitor.observe(snap), null, `第 ${index + 3} 次观测不该再报`);
  }
  assert.equal(monitor.decisions.length, 2, '只有两条：先报告，再确认');
  assert.deepEqual(
    monitor.decisions.map((item) => item.action),
    ['none', 'skip-stage']
  );

  // 预算同样只报一次。
  const budget = createMonitor({ now: () => T0 });
  const tight = snapshot({ callsUsed: 7, callBudget: 8, artifacts: [] });
  assert.ok(budget.observe(tight));
  assert.equal(budget.observe(tight), null);
  assert.equal(budget.observe(tight), null);
  assert.equal(budget.decisions.length, 1);

  // 终态 likewise 只报一次。
  const ended = createMonitor({ now: () => T0 });
  const done = snapshot({ status: 'done', artifacts: [] });
  assert.ok(ended.observe(done));
  assert.equal(ended.observe(done), null);
  assert.equal(ended.decisions.length, 1);

  // reset() 之后状态清空，同样的异常可以重新报一遍。
  monitor.reset();
  assert.equal(monitor.decisions.length, 0);
  assert.deepEqual(monitor.toJSON(), {
    decisions: [],
    state: { ticks: 0, idleTicks: 0, progressEpisode: 0, lastFingerprint: null, lastStatus: null, streaks: {}, episodes: {} }
  });
  const afterReset = monitor.observe(snap);
  assert.ok(afterReset);
  assert.equal(afterReset.kind, 'duplicate');
});

test('11. 契约：DEFAULT_LIMITS 冻结且包含全部必需项；decisions 只读', () => {
  for (const key of [
    'stallMs',
    'stallRetryCount',
    'duplicateWindow',
    'repeatFailureCount',
    'budgetReserve',
    'idleTicksToFinish',
    'minCallsForBudgetWarn'
  ]) {
    assert.equal(typeof DEFAULT_LIMITS[key], 'number', `${key} 必须是数字`);
  }
  assert.equal(DEFAULT_LIMITS.stallMs, 600000);
  assert.equal(DEFAULT_LIMITS.stallRetryCount, 2);
  assert.equal(DEFAULT_LIMITS.duplicateWindow, 4);
  assert.equal(DEFAULT_LIMITS.repeatFailureCount, 3);
  assert.equal(DEFAULT_LIMITS.budgetReserve, 1);
  assert.equal(DEFAULT_LIMITS.idleTicksToFinish, 4);
  assert.equal(DEFAULT_LIMITS.minCallsForBudgetWarn, 2);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));

  const monitor = createMonitor();
  assert.equal(typeof monitor.observe, 'function');
  assert.equal(typeof monitor.scene, 'function');
  assert.equal(typeof monitor.reset, 'function');
  assert.equal(typeof monitor.toJSON, 'function');
  assert.ok(Object.isFrozen(monitor.decisions));

  // 非法 limits 退回默认，不抛错（监控不能因为配置手滑停摆）；快照缺失才报错。
  const loose = createMonitor({ limits: { stallMs: -5, duplicateWindow: 'x', idleTicksToFinish: Number.NaN } });
  assert.equal(loose.observe(snapshot({ callsUsed: 1, callBudget: 8 })), null);
  assert.throws(() => loose.observe(undefined), TypeError);
  assert.throws(() => loose.scene(null), TypeError);
});
