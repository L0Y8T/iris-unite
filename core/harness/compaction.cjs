/* 历史压缩：早期历史换成一条摘要，而不是整段丢掉。
 *
 * 这个模块解决的是"这一次调用到底该带多少旧对话"。
 *
 * 现状（可测的事实）：
 *   - core/providers.cjs 第 54 行 contextFor：总字符超过 240 000 就从后往前截，
 *     更早的消息**整段消失**，模型再也看不见它们；从 0.6 到现在没动过。
 *   - 一轮科研 10 次调用，每一次都把同一段 24 万字符历史重新塞一遍，
 *     于是成本随轮次线性增长，而装配层（harness/context.cjs）完全管不到这一块。
 *
 * 两件事同时不对：
 *   1. 截断是"丢"不是"收"：被丢掉的那部分里往往有用户的目标、约束、否决过的方向；
 *   2. 丢完还照样超预算外的部分没人管，因为超出的判定和裁切是同一行代码。
 *
 * 压缩的思路（借自对话系统里的 compaction）：把超出预算的那段早期历史交给
 * 一次便宜的模型调用压成一段摘要，摘要作为**一条** user 消息留在最前面，
 * 最近 keepRecent 条原样保留。原文不删——conversations.json 里仍然完整，
 * 这里只改"这一次发给模型的东西"。
 *
 * 四条硬规则：
 *   1. 没超预算就一个字不动：规模不到，压缩就是空转（与装配预算同一课）；
 *   2. 压到 maxChars × 0.7，不是压到刚好达标——否则下一次调用立刻又超；
 *   3. 至少保留最近 keepRecent 条，即使这样仍超预算：摘要不能吃掉当下的问题；
 *   4. 没有摘要器、摘要器抛错、摘要超时、摘要为空 → **退回 contextFor 的老行为**。
 *      压缩是优化，不是前置条件；它坏掉不能让一整轮研究挂掉。
 *
 * 为什么压完还有上限：摘要本身也占字符。摘要长度按 maxChars 的 5% 封顶
 * （且不超过 8000 字），于是"0.7 的目标 + 5% 的摘要"恰好落在 0.75 以内——
 * 这是可直接断言的数字，不是估计。
 */
const { contextFor } = require('../providers.cjs');

const DEFAULTS = {
  /* 与 providers.cjs 的 contextFor 同一个预算：改这里就等于改那条老规矩。 */
  maxChars: 240000,
  /* 压缩后的目标占用比例。留 30% 余量，是因为压缩之后这一轮还会继续长。 */
  targetRatio: 0.7,
  /* 最近多少条原样保留。6 条 ≈ 三轮一问一答，够模型接上当下的话题。 */
  keepRecent: 6,
  /* 摘要长度上限：绝对值与相对比例取小。两者相加不超过 0.75 那条线。 */
  summaryCapChars: 8000,
  summaryCapRatio: 0.05,
  /* 送进摘要器的原文上限。被压缩的历史可能有几十万字，
     全部塞给摘要器等于把省下来的钱又花回去；头尾各留一段，中间明说省略了多少。 */
  summarizeMaxChars: 60000,
  /* 摘要调用自身的超时。摘要器是外部模型，卡住不能把整轮拖住。 */
  summarizeTimeoutMs: 60000
};

/* 摘要消息的固定前缀里，除摘要正文外的那些字符（"〔已压缩 N 条历史（原 K 字符）。摘要：〕"）
   在实际数字下的长度，用于给摘要封顶时留出位置。宁可多留几个字。 */
const MARKER_RESERVE = 64;

function charsOf(message) {
  const content = message?.content;
  return String(content == null ? '' : content).length;
}

function totalChars(messages) {
  return messages.reduce((sum, message) => sum + charsOf(message), 0);
}

/** 与 contextFor 完全一致的可用消息过滤：只认 user 与"正常结束且有正文"的 assistant。 */
function usableMessages(conversation) {
  const list = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return list
    .filter(m => m.role === 'user' || (m.role === 'assistant' && !['error', 'streaming', 'stopped'].includes(m.status) && m.text?.trim()))
    .map(m => ({ role: m.role, content: m.text || '' }));
}

/** 把待压缩的消息渲染成摘要器的输入。超长时保留头尾，中间明说省略了多少字。 */
function renderForSummary(messages, maxChars) {
  const label = role => (role === 'assistant' ? '助手' : '用户');
  const text = messages.map(m => `[${label(m.role)}] ${String(m.content == null ? '' : m.content)}`).join('\n\n');
  if (text.length <= maxChars) return text;
  const tail = Math.floor(maxChars / 3);
  const head = Math.max(0, maxChars - tail - MARKER_RESERVE);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n……〔摘要输入共 ${text.length} 字，中间 ${omitted} 字未送入摘要器；原文仍完整保存在对话记录里〕……\n\n${text.slice(text.length - tail)}`;
}

/** 给摘要器加一道超时闸。超时不代表摘要器坏了，只代表这一轮别再等它。 */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`摘要超时（${ms}ms）`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 压缩历史。
 *
 * 入参：
 *   messages    消息数组，每项 { role, content }（contextFor / 各家 SDK 的形状）
 *   maxChars    总字符预算，默认 240 000
 *   summarize   异步回调 (text) => 摘要字符串；缺省即不压缩
 *   keepRecent  最近多少条原样保留，默认 6
 *   limits      覆盖 DEFAULTS 里其余项（targetRatio / summaryCapChars / …）
 *
 * 返回：
 *   messages     压缩后的消息数组（含那条摘要标记）
 *   compacted    是否真的压过
 *   freedChars   省下的字符数（= 压缩前总字 - 压缩后总字，负数记 0）
 *   marker       那条摘要消息；没压缩时为 null
 *   summaryText  摘要正文；没压缩时为空串
 *   另有 before / after / dropped / reason / fallback 便于记账与排查
 */
async function compact({ messages = [], maxChars = DEFAULTS.maxChars, summarize = null, keepRecent = DEFAULTS.keepRecent, limits = {} } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const bound = { ...DEFAULTS, ...limits };
  const budget = Number(maxChars) > 0 ? Number(maxChars) : bound.maxChars;
  const keep = Number.isFinite(Number(keepRecent)) && Number(keepRecent) >= 0 ? Math.floor(Number(keepRecent)) : bound.keepRecent;
  const before = totalChars(list);

  /* 未超预算：原样返回。不做任何"顺手优化"——规模不够时压缩只会增加不确定性。 */
  if (!list.length || before <= budget) {
    return { messages: list, compacted: false, freedChars: 0, marker: null, summaryText: '', before, after: before, dropped: 0, reason: 'under-budget', fallback: false };
  }

  /* 老行为：从后往前累积到预算为止，更早的整段消失。
     这是压缩器失败时的兜底，也是"没有摘要器"时的既有契约。 */
  const legacy = reason => {
    const picked = contextFor({ messages: list.map(m => ({ role: m.role, text: String(m.content == null ? '' : m.content) })) }, { maxChars: budget });
    const out = picked.map(m => ({ role: m.role, content: m.content }));
    const after = totalChars(out);
    return { messages: out, compacted: false, freedChars: Math.max(0, before - after), marker: null, summaryText: '', before, after, dropped: list.length - out.length, reason, fallback: true };
  };

  if (typeof summarize !== 'function') return legacy('no-summarizer');
  /* 全都在 keepRecent 窗口里：没有"早期历史"可压。仍未超预算的部分交给老行为兜底，
     否则这里会原样返回一份超预算的历史——那比不压缩更糟。 */
  if (list.length - keep <= 0) return legacy('nothing-to-cut');

  /* 从头累积切掉，直到剩余 ≤ target。切到 keepRecent 边界就停，哪怕仍超预算。 */
  const target = Math.floor(budget * bound.targetRatio);
  const cuttable = list.length - keep;
  let cut = 0;
  let remaining = before;
  while (cut < cuttable && remaining > target) {
    remaining -= charsOf(list[cut]);
    cut += 1;
  }

  const dropped = list.slice(0, cut);
  const kept = list.slice(cut);
  const droppedChars = before - remaining;

  let summaryText = '';
  try {
    const raw = await withTimeout(Promise.resolve().then(() => summarize(renderForSummary(dropped, bound.summarizeMaxChars))), bound.summarizeTimeoutMs);
    summaryText = String(raw == null ? '' : raw).trim();
  } catch (error) {
    /* 摘要失败 = 没压缩成功。退回硬截断，本轮继续跑；原因留在返回值里供记账排查。 */
    return { ...legacy('summary-failed'), summaryError: String(error?.message || error).slice(0, 200) };
  }
  /* 空摘要与没有摘要等价：留下一条"摘要："后面什么都没有的消息，只会误导模型。 */
  if (!summaryText) return legacy('summary-failed');

  /* 摘要封顶：0.7 的目标 + 最多 5% 的摘要，落点正好在 0.75 以内。 */
  const cap = Math.max(0, Math.min(bound.summaryCapChars, Math.floor(budget * bound.summaryCapRatio) - MARKER_RESERVE));
  if (summaryText.length > cap) summaryText = summaryText.slice(0, Math.max(0, cap - 1)) + '…';

  const marker = { role: 'user', content: `〔已压缩 ${dropped.length} 条历史（原 ${droppedChars} 字符）。摘要：${summaryText}〕` };
  const out = [marker, ...kept];
  const after = totalChars(out);

  return {
    messages: out,
    compacted: true,
    freedChars: Math.max(0, before - after),
    marker,
    summaryText,
    before,
    after,
    dropped: dropped.length,
    droppedChars,
    reason: 'compacted',
    fallback: false
  };
}

/**
 * 直接由会话得到"这一次该发给模型的历史"。
 *
 * 为什么不先 contextFor 再 compact：contextFor 已经把历史裁到 24 万以内，
 * 压缩器再看永远不超预算——那压缩就是空转，和"材料太小装配预算等于没设"是同一课。
 * 所以这里先取**未截断**的全量可用消息，再交给压缩器决定留多少。
 *
 * 压缩真的发生时：发一条 { kind:'compaction', freedChars, before, after } 事件（界面可见），
 * 往本轮工作区账本记一条（事后可核对），并挂在 run.compaction 上（运行记录里留痕）。
 * 没有工作区、没有 emit 都不影响压缩本身——记账失败不该让这一轮失去压缩效果。
 */
async function historyFor(conversation, { summarize = null, maxChars = DEFAULTS.maxChars, keepRecent = DEFAULTS.keepRecent, limits = {}, emit = null, workspace = null, run = null } = {}) {
  const result = await compact({ messages: usableMessages(conversation), maxChars, summarize, keepRecent, limits });
  if (!result.compacted) return result.messages;

  const record = { freedChars: result.freedChars, before: result.before, after: result.after, dropped: result.dropped };
  if (typeof emit === 'function') {
    try { emit({ kind: 'compaction', ...record }); } catch { /* 事件发不出去不影响已完成的压缩 */ }
  }
  if (workspace && typeof workspace.appendLedger === 'function') {
    try { workspace.appendLedger('compaction', record); } catch { /* 记账失败不还原压缩 */ }
  }
  if (run && typeof run === 'object') {
    run.compaction = { ...record, at: Date.now(), count: ((run.compaction && run.compaction.count) || 0) + 1 };
  }
  return result.messages;
}

module.exports = { compact, historyFor, usableMessages, renderForSummary, DEFAULTS };
