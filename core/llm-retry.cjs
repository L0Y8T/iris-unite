/**
 * 模型通道的失败重试。
 *
 * 为什么单独成文件：main.cjs 顶部就 require('electron')，node --test 加载不了它，
 * 重试判定塞在 main.cjs 里就只能靠起真窗口来验。把「判定 + 退避」放这里，
 * main.cjs 的 call 适配器只负责把参数递进来。
 *
 * 只重试「等一会儿可能就好了」的错误：限流（429）、服务端故障（5xx）、网络抖动。
 * 密钥/余额/参数/内容截断一律不重试——重试四次只是把同一个错误撞四次，还多烧一轮前面的调用费。
 */

/* 退避 1s → 2s → 4s。数组长度就是重试次数：3 次重试，含首次共 4 次尝试。 */
const BACKOFF_MS = [1000, 2000, 4000];
const RETRYABLE_HTTP = [429];
/* 这些码来自 Node 的 undici（fetch 底层），线上日志里按原样出现，不要改写大小写。 */
const RETRYABLE_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
const CODE_PREFIX = 'UND_ERR_';

function httpStatus(error) {
  const value = Number(error?.status ?? error?.statusCode);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function asCode(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : '';
}

/**
 * 把错误身上能拿到的错误码全捞出来。多层结构都要看：
 * 自定义通道把网络异常包装成中文消息时会补一个 code；原生 fetch 把码挂在 cause 上；
 * 多地址并发失败时 cause 是 AggregateError，码在 cause.errors[] 里。
 */
function errorCodes(error) {
  const codes = [];
  const push = value => { const code = asCode(value); if (code && !codes.includes(code)) codes.push(code); };
  push(error?.code); push(error?.errno);
  push(error?.cause?.code); push(error?.cause?.errno);
  for (const group of [error?.cause?.errors, error?.errors]) {
    if (Array.isArray(group)) for (const inner of group) { push(inner?.code); push(inner?.errno); }
  }
  return codes;
}

function isRetryableCode(code) {
  return RETRYABLE_CODES.includes(code) || code.startsWith(CODE_PREFIX);
}

/* 截断是「说完了但被上限砍掉」：重试多半在同一处再被砍一次，而且已经吐出的半截正文会叠起来。 */
function isTruncated(error) {
  return /截断/.test(String(error?.message || ''));
}

/**
 * 能不能重试。顺序有意为之：先挡掉 abort 与截断这两个「怎么重试都没用」的，
 * 再看状态码白名单（只有 429 与 5xx），最后看网络错误码。
 * 不在白名单里的一律不重试——400/401/402/403 自然归到这一类，不需要单独列举。
 */
function isRetryable(error, { signal } = {}) {
  if (signal?.aborted) return false;
  if (error?.name === 'AbortError') return false;
  if (isTruncated(error)) return false;
  const status = httpStatus(error);
  if (status !== null) return RETRYABLE_HTTP.includes(status) || status >= 500;
  if (errorCodes(error).some(isRetryableCode)) return true;
  /* 兜底：被包装过的错误只把码留在消息里（「无法连接 host（ECONNRESET）」）。
     只认白名单里的码，不做模糊匹配，免得把正文里的普通词当网络错误重试。 */
  return /UND_ERR_[A-Z_]+|\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(String(error?.message || ''));
}

/* 推给界面的原因说人话：「HTTP 500」比整句服务端错误更有用，后者往往同义反复。 */
function describeError(error) {
  const status = httpStatus(error);
  if (status !== null) return `HTTP ${status}`;
  const codes = errorCodes(error);
  if (codes.length) return codes[0];
  const text = String(error?.message || error || '').trim();
  return text ? text.slice(0, 80) : '未知错误';
}

/**
 * 退避等待。signal 不是可选优化：abort 时必须立刻醒来，
 * 否则用户点了「停止」还要再等 4 秒才断，看起来像没停掉。
 * 注入的假 sleep 同样会收到 signal，测试里可以断言它被传下去了。
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已停止生成')); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new Error('已停止生成')); };
    function cleanup() { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * 包一层重试。
 *
 * 重试耗尽后抛**原始错误**，不包成 AggregateError 之类：上层按 message 判断停止/失败，
 * 换掉错误对象等于把那些判断一起废掉。
 *
 * @param {(attempt: number) => Promise<any>} run 一次尝试（从 0 开始计数）
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] 用户停止时立刻中断退避
 * @param {(info: { attempt: number, waitMs: number, reason: string, error: Error }) => void} [options.onRetry]
 *        每次重试前回调（attempt 从 1 开始，即第几次重试），用来推事件给界面。回调自己抛错不影响重试。
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] 测试注入用
 * @param {number[]} [options.backoff] 退避序列，长度即重试次数
 * @param {(error: Error) => boolean} [options.canRetry] 额外闸门（如「这次尝试已经输出过正文」）
 */
async function withRetry(run, { signal, onRetry, sleep = defaultSleep, backoff = BACKOFF_MS, canRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const exhausted = attempt >= backoff.length;
      const blocked = typeof canRetry === 'function' && canRetry(error) === false;
      if (exhausted || blocked || !isRetryable(error, { signal })) throw error;
      const waitMs = backoff[attempt];
      if (typeof onRetry === 'function') {
        try { onRetry({ attempt: attempt + 1, waitMs, reason: describeError(error), error }); } catch { /* 通知失败不阻断重试 */ }
      }
      try { await sleep(waitMs, signal); } catch { throw error; } // 等待被 abort 打断：不再重试，抛原错误
    }
  }
}

module.exports = {
  BACKOFF_MS,
  RETRYABLE_CODES,
  withRetry,
  isRetryable,
  describeError,
  errorCodes,
  httpStatus,
  defaultSleep
};
