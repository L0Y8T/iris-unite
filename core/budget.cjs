/* 调用账本：把"这一轮还能不能再发一次模型请求"变成一个可审计的计数问题。
 *
 * 依据 docs/research-mode-design.md §9.2：
 *   - 每次尝试在**发出前**占位，发出后转为已用；未发出的预约必须释放；
 *   - 失败、截断、取消的已发请求**照样计数**（不能因为失败就当没花）；
 *   - 必须为后续必需调用（最终稿、已启用的终审复核）保留额度；
 *   - 可选深化只有在"剩余 - 保留 - 其他预约 ≥ 1"时才允许启动。
 *
 * 纯内存、同步、无 IO。并发安全靠"占位与判定在同一个同步函数里完成"，
 * 不需要锁；异步间隙里不可能有别的代码插进来。
 */

const STATES = Object.freeze(['reserved', 'dispatched', 'succeeded', 'failed', 'cancelled']);

class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {number} options.limit 本轮模型调用硬上限
 * @param {number} options.reserve 必须为最终稿（含已启用复核）保留的次数
 */
function createLedger({ limit, reserve = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 0) throw new BudgetError('invalid-limit', `调用上限必须是非负整数，收到 ${limit}`);
  if (!Number.isInteger(reserve) || reserve < 0) throw new BudgetError('invalid-reserve', `保留额度必须是非负整数，收到 ${reserve}`);
  if (reserve > limit) throw new BudgetError('invalid-reserve', `保留额度 ${reserve} 不能大于上限 ${limit}`);

  const attempts = [];
  let sequence = 0;

  const outstanding = () => attempts.filter(a => a.state === 'reserved').length;
  const spent = () => attempts.filter(a => a.state === 'dispatched' || a.state === 'succeeded' || a.state === 'failed' || a.state === 'cancelled').length;
  const remaining = () => limit - spent() - outstanding();

  /** 可选节点的准入判定：扣掉保留额度与在途预约之后，还够不够再发 cost 次。 */
  function canStartOptional(cost = 1) {
    if (!Number.isInteger(cost) || cost < 1) throw new BudgetError('invalid-cost', 'cost 必须是正整数');
    return remaining() - reserve >= cost;
  }

  /**
   * 为某个节点占一个额度。required 节点只受硬上限约束，不受保留额度约束
   * （保留额度本来就是给它们准备的）；可选节点必须通过 canStartOptional。
   */
  function reserveSlot(nodeId, { required = false, note = '' } = {}) {
    const cost = 1;
    if (!required && !canStartOptional(cost)) {
      throw new BudgetError('budget-reserved', `剩余 ${remaining()} 次，其中 ${reserve} 次需保留给最终输出${note ? '（' + note + '）' : ''}`);
    }
    if (remaining() < cost) throw new BudgetError('budget-exhausted', `本轮已用 ${spent()} 次，达到上限 ${limit} 次`);
    const attempt = { attemptId: `a${++sequence}`, nodeId, required, note, state: 'reserved', at: Date.now() };
    attempts.push(attempt);
    return attempt.attemptId;
  }

  function find(attemptId) {
    const attempt = attempts.find(a => a.attemptId === attemptId);
    if (!attempt) throw new BudgetError('unknown-attempt', `找不到尝试 ${attemptId}`);
    return attempt;
  }

  /** 真正发出请求：预约转为已用。此后即使失败也占额度。 */
  function dispatch(attemptId) {
    const attempt = find(attemptId);
    if (attempt.state !== 'reserved') throw new BudgetError('invalid-transition', `尝试 ${attemptId} 当前状态是 ${attempt.state}，不能转为 dispatched`);
    attempt.state = 'dispatched';
    return attempt;
  }

  /** 结算。只允许从 dispatched 走到终态。 */
  function settle(attemptId, state, { note = '' } = {}) {
    if (!['succeeded', 'failed', 'cancelled'].includes(state)) throw new BudgetError('invalid-state', `不支持的终态：${state}`);
    const attempt = find(attemptId);
    if (attempt.state !== 'dispatched') throw new BudgetError('invalid-transition', `尝试 ${attemptId} 当前状态是 ${attempt.state}，不能结算为 ${state}`);
    attempt.state = state;
    if (note) attempt.note = note;
    return attempt;
  }

  /** 释放一个**尚未发出**的预约（例如节点被跳过）。已发出的不能释放。 */
  function release(attemptId, { note = '' } = {}) {
    const attempt = find(attemptId);
    if (attempt.state !== 'reserved') throw new BudgetError('invalid-transition', `尝试 ${attemptId} 已发出（${attempt.state}），不能释放额度`);
    attempt.state = 'released';
    if (note) attempt.note = note;
    return attempt;
  }

  /** 账本自洽检查，供发布门禁与测试使用。 */
  function assertConsistent() {
    const bad = attempts.filter(a => !STATES.includes(a.state) && a.state !== 'released');
    if (bad.length) throw new BudgetError('ledger-corrupt', `存在未知状态：${bad.map(a => a.state).join(',')}`);
    if (remaining() < 0) throw new BudgetError('ledger-corrupt', `剩余额度为负：${remaining()}`);
    if (spent() > limit) throw new BudgetError('ledger-corrupt', `已用 ${spent()} 超过上限 ${limit}`);
    return true;
  }

  function snapshot() {
    return {
      limit,
      reserve,
      spent: spent(),
      outstanding: outstanding(),
      remaining: remaining(),
      byNode: attempts.reduce((acc, a) => {
        acc[a.nodeId] = acc[a.nodeId] || { reserved: 0, dispatched: 0, succeeded: 0, failed: 0, cancelled: 0, released: 0 };
        acc[a.nodeId][a.state] = (acc[a.nodeId][a.state] || 0) + 1;
        return acc;
      }, {}),
      attempts: attempts.map(a => ({ ...a }))
    };
  }

  return { limit, reserve, canStartOptional, reserveSlot, dispatch, settle, release, remaining, spent, outstanding, assertConsistent, snapshot };
}

module.exports = { createLedger, BudgetError, STATES };
