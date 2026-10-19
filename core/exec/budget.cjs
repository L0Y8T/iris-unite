/* 执行预算是独立的一本账：它管"这一轮还能不能再跑一次实验"，
 * 和模型调用预算（core/budget.cjs）互不占用。
 *
 * 为什么必须分开：模型调用按次计费，实验按墙钟和算力计费；
 * 混在一个数字里会让"省钱"与"别把机器跑满"两件事互相挤占。
 *
 * 纯函数：只读索引条目，不读文件、不起进程。
 */

const DEFAULT_EXEC_LIMITS = Object.freeze({
  maxRunsPerConversation: 20,   // 单个对话的运行次数
  maxRunsPerDay: 50,            // 每天总运行次数
  maxWallClockSecPerDay: 7200   // 每天累计执行时长（秒）
});

const dayStartOf = now => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * 判断现在能不能再启动一次运行。
 * @param {object} options
 * @param {Array} options.runs 索引条目（含 conversationId / startedAt / durationMs / status）
 * @param {string|null} [options.conversationId]
 * @param {number} [options.now]
 * @param {object} [options.limits]
 */
function evaluateBudget({ runs = [], conversationId = null, now = Date.now(), limits = DEFAULT_EXEC_LIMITS } = {}) {
  const merged = { ...DEFAULT_EXEC_LIMITS, ...(limits || {}) };
  const dayStart = dayStartOf(now);
  const entries = Array.isArray(runs) ? runs : [];
  const today = entries.filter(item => Number(item.startedAt || 0) >= dayStart);
  const mine = conversationId ? entries.filter(item => item.conversationId === conversationId) : entries;
  const usedSeconds = Math.round(today.reduce((sum, item) => sum + Number(item.durationMs || 0) / 1000, 0));

  const checks = [
    { key: 'conversation-runs', label: '本对话运行次数', used: mine.length, limit: merged.maxRunsPerConversation },
    { key: 'day-runs', label: '今日运行次数', used: today.length, limit: merged.maxRunsPerDay },
    { key: 'day-wall-clock', label: '今日执行时长（秒）', used: usedSeconds, limit: merged.maxWallClockSecPerDay }
  ].map(check => ({ ...check, ok: check.used < check.limit, remaining: Math.max(0, check.limit - check.used) }));

  const exceeded = checks.filter(check => !check.ok);
  return {
    ok: exceeded.length === 0,
    checks,
    remainingRuns: Math.min(...checks.map(check => check.remaining)),
    reason: exceeded.map(check => `${check.label}已达上限（${check.used}/${check.limit}）`).join('；')
  };
}

module.exports = { DEFAULT_EXEC_LIMITS, evaluateBudget };
