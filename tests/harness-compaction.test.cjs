/* 历史压缩的验收。
 *
 * 背景（2026-11-02 实测）：压缩的价值取决于材料规模——装配预算 6000 时 8 项材料全内联、
 * 模型 0 次调工具；itemInline 压到 2000 后 4 项溢出、模型调了 4 次 read_artifact。
 * 同理：历史从来没超过 24 万字符时，压缩就是空转。所以这里除了行为断言，
 * 还专门造一份 25 万字符的真材料，断言压缩**真的发生过**。
 *
 * 验七件事：未超预算不动 / 超预算早期被替换 / 最近 6 条保留 / 标记可识别 /
 * 无摘要器退回老行为 / 摘要器抛错退回老行为 / freedChars 数值对得上。
 * 另加：摘要超时与空摘要的兜底、historyFor 的事件与账本、真材料 25 万字符。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compact, historyFor, usableMessages, DEFAULTS } = require('../core/harness/compaction.cjs');
const { contextFor } = require('../core/providers.cjs');

/** 造一条正好 n 字符的正文，前 8 字带序号，便于断言"哪条还在"。 */
function body(index, n) {
  const head = `M${String(index).padStart(3, '0')}：`;
  return head + '材料内容填充。'.repeat(Math.ceil((n - head.length) / 7)).slice(0, Math.max(0, n - head.length));
}

function history(count, each) {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: body(i + 1, each) }));
}

const chars = list => list.reduce((sum, m) => sum + String(m.content || '').length, 0);
const summarizer = text => `早期历史共 ${text.length} 字，主题是材料填充。`;

test('未超预算：原样返回，一个字都不动', async () => {
  const messages = history(4, 200);
  const result = await compact({ messages, maxChars: 1000, summarize: summarizer });
  assert.equal(result.compacted, false);
  assert.equal(result.freedChars, 0);
  assert.equal(result.marker, null);
  assert.equal(result.summaryText, '');
  assert.equal(result.reason, 'under-budget');
  assert.equal(result.messages.length, messages.length);
  assert.deepEqual(result.messages, messages);
  /* 摘要器一次都不该被调用：规模不到，压缩就是空转。 */
});

test('刚好等于预算也算未超：边界不给压缩留发挥空间', async () => {
  const messages = history(2, 500);
  const result = await compact({ messages, maxChars: 1000, summarize: summarizer });
  assert.equal(result.compacted, false);
  assert.equal(result.after, 1000);
});

test('超预算：早期历史被一条摘要替换，最近的原文仍在', async () => {
  /* 20 条 × 15000 = 300000 字符，预算 240000，目标 168000。 */
  const messages = history(20, 15000);
  const before = chars(messages);
  assert.equal(before, 300000);
  const result = await compact({ messages, summarize: summarizer });

  assert.equal(result.compacted, true);
  assert.equal(result.fallback, false);
  assert.equal(result.before, before);
  assert.ok(result.after < before, '压缩后必须变小');
  assert.equal(result.messages[0].content.startsWith('〔已压缩 '), true);
  /* 被切掉的那些消息不再出现：否则"压缩"只是加了一条摘要。 */
  assert.equal(result.messages.some(m => m.content.startsWith('M001：')), false);
  /* 最后一条原样保留。 */
  assert.deepEqual(result.messages[result.messages.length - 1], messages[messages.length - 1]);
  assert.equal(chars(result.messages), result.after);
});

test('至少保留最近 6 条（默认 keepRecent），即使这样仍超预算', async () => {
  /* 12 条 × 30000 = 360000：切到 keepRecent 边界就会停，压不到 0.7 也认。 */
  const messages = history(12, 30000);
  const result = await compact({ messages, summarize: summarizer });

  assert.equal(result.compacted, true);
  assert.equal(result.dropped, 6);
  assert.equal(result.messages.length, 7, '1 条摘要 + 最近 6 条');
  for (const original of messages.slice(6)) {
    assert.equal(result.messages.some(m => m.content === original.content), true, '最近 6 条必须原样保留');
  }
  assert.equal(result.messages.some(m => m.content.startsWith('M001：')), false);
});

test('标记可识别：一条 user 消息，带条数、原字符数与摘要正文', async () => {
  const messages = history(20, 15000);
  const result = await compact({ messages, summarize: summarizer });

  assert.equal(result.marker.role, 'user');
  assert.equal(result.marker, result.messages[0]);
  assert.match(result.marker.content, /^〔已压缩 9 条历史（原 135000 字符）。摘要：/);
  assert.match(result.marker.content, /材料填充/);
  assert.ok(result.marker.content.includes(result.summaryText));
  assert.equal(result.marker.content.endsWith('〕'), true);
});

test('没有摘要器：退回 contextFor 的老行为（整段截取，不压缩）', async () => {
  const messages = history(20, 15000);
  const result = await compact({ messages, summarize: null });

  assert.equal(result.compacted, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'no-summarizer');
  assert.ok(result.freedChars > 0, '老行为同样省了字符，只是靠丢而不是靠收');
  const expected = contextFor({ messages: messages.map(m => ({ role: m.role, text: m.content })) }, { maxChars: 240000 });
  assert.deepEqual(result.messages, expected, '必须与 contextFor 逐条一致');
  assert.equal(result.messages.some(m => m.content.startsWith('〔已压缩')), false);
});

test('摘要器抛错：同样退回老行为，不让整轮挂掉', async () => {
  const messages = history(20, 15000);
  const boom = async () => { throw new Error('摘要通道 502'); };
  const result = await compact({ messages, summarize: boom });

  assert.equal(result.compacted, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'summary-failed');
  assert.match(result.summaryError, /502/);
  const expected = contextFor({ messages: messages.map(m => ({ role: m.role, text: m.content })) }, { maxChars: 240000 });
  assert.deepEqual(result.messages, expected);
});

test('摘要器超时：不等待，退回老行为', async () => {
  const messages = history(20, 15000);
  const hang = () => new Promise(() => {});
  const result = await compact({ messages, summarize: hang, limits: { summarizeTimeoutMs: 20 } });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'summary-failed');
  assert.match(result.summaryError, /超时/);
});

test('摘要器返回空串：等同于没压成功，退回老行为', async () => {
  const messages = history(20, 15000);
  const result = await compact({ messages, summarize: async () => '   ' });
  assert.equal(result.compacted, false);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'summary-failed');
});

test('freedChars 数值正确：等于压缩前后总字符之差', async () => {
  const messages = history(20, 15000);
  const result = await compact({ messages, summarize: summarizer });
  const before = chars(messages);
  const after = chars(result.messages);
  assert.equal(result.after, after);
  assert.equal(result.freedChars, before - after);
  assert.equal(result.after, result.before - result.freedChars);
});

test('全都在最近窗口里：没有早期历史可压，退回老行为兜底', async () => {
  const messages = history(3, 120000);
  const result = await compact({ messages, summarize: summarizer });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'nothing-to-cut');
  assert.ok(result.after <= 240000, '不能因为"没得压"就原样返回一份超预算历史');
});

test('压缩后的占用落在 0.75 预算以内（0.7 目标 + 最多 5% 摘要）', async () => {
  const messages = history(30, 12000);
  const result = await compact({ messages, summarize: summarizer });
  assert.equal(result.compacted, true);
  assert.ok(result.after <= 240000 * 0.75, `压缩后 ${result.after} 超过 0.75 条线`);
});

test('historyFor：压缩发生时发事件、记账本、挂在 run 上', async () => {
  const conversation = {
    id: 'conv-compact',
    messages: history(20, 15000).map(m => ({ role: m.role, text: m.content, status: m.role === 'assistant' ? 'done' : undefined }))
  };
  const events = [];
  const ledger = [];
  const run = {};
  const out = await historyFor(conversation, {
    summarize: summarizer,
    emit: event => events.push(event),
    workspace: { appendLedger: (type, fields) => ledger.push({ type, fields }) },
    run
  });

  assert.equal(out[0].content.startsWith('〔已压缩 '), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'compaction');
  assert.deepEqual(Object.keys(events[0]).sort(), ['after', 'before', 'dropped', 'freedChars', 'kind']);
  assert.ok(events[0].freedChars > 0);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, 'compaction');
  assert.equal(ledger[0].fields.after, events[0].after);
  assert.equal(run.compaction.count, 1);
  assert.equal(run.compaction.freedChars, events[0].freedChars);
});

test('historyFor：未超预算时不发事件、不动 run', async () => {
  const conversation = { id: 'conv-short', messages: [{ role: 'user', text: '短问题' }, { role: 'assistant', text: '短回答', status: 'done' }] };
  const events = [];
  const run = {};
  const out = await historyFor(conversation, { summarize: summarizer, emit: e => events.push(e), run });
  assert.equal(out.length, 2);
  assert.equal(events.length, 0);
  assert.equal(run.compaction, undefined);
});

test('historyFor 的可用消息过滤与 contextFor 一致（误/流/停止的 assistant 不进历史）', () => {
  const conversation = {
    messages: [
      { role: 'user', text: '问' },
      { role: 'assistant', text: '坏', status: 'error' },
      { role: 'assistant', text: '流', status: 'streaming' },
      { role: 'assistant', text: '停', status: 'stopped' },
      { role: 'assistant', text: '好', status: 'done' }
    ]
  };
  assert.deepEqual(usableMessages(conversation).map(m => m.content), ['问', '好']);
});

/* ── 硬要求：真材料，25 万字符 ────────────────────────────────────────────
   50 条 user/assistant 交替消息，每条 5000 字，共计 250 000 字符。
   这不是构造出来的边界值，而是"长会话真的长到该压缩了"的规模。 */
const REAL_TOTAL = 250000;
const FILLER = '真实长文本填充，用于验证压缩在真实规模下真的发生。'.repeat(400);
const realHistory = () => Array.from({ length: 50 }, (_, i) => {
  const head = `第 ${i + 1} 轮：`;
  return { role: i % 2 === 0 ? 'user' : 'assistant', content: head + FILLER.slice(0, 5000 - head.length) };
});

test('真材料：25 万字符历史，压缩必须真的发生', async () => {
  const messages = realHistory();
  const before = chars(messages);
  assert.equal(before, REAL_TOTAL);

  const result = await compact({ messages, summarize: text => `早期 ${text.length} 字历史已压缩：用户在做长会话验证。` });

  assert.equal(result.compacted, true, '25 万字符必须触发压缩');
  assert.ok(result.freedChars > 0, '必须真的省下字符');
  const after = chars(result.messages);
  assert.ok(after <= DEFAULTS.maxChars * 0.75, `压缩后 ${after} 字必须 ≤ ${DEFAULTS.maxChars * 0.75}`);
  assert.equal(result.after, after);

  assert.equal(result.marker.role, 'user');
  assert.equal(result.messages[0], result.marker);
  assert.ok(result.marker.content.includes('已压缩'));
  assert.ok(result.marker.content.includes('摘要：'));
  assert.ok(result.marker.content.includes('长会话验证'), '标记里必须带摘要正文，不能只有壳');

  /* 最近 6 条原样保留，最早期那条彻底进了摘要。 */
  assert.deepEqual(result.messages.slice(-6), messages.slice(messages.length - 6));
  assert.equal(result.messages.length, 1 + (messages.length - result.dropped), '1 条摘要 + 全部未被切掉的消息');
  assert.ok(result.messages.length > 6);
  assert.equal(result.messages.some(m => m.content === messages[0].content), false);

  console.log(`[真材料] 造 ${before} 字 → 压掉 ${result.freedChars} 字 → 剩 ${after} 字（标记 ${result.marker.content.length} 字，保留最近 6 条）`);
});
