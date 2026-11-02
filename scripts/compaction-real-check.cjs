/* 历史压缩的真材料实测：造一份 25 万字符的历史，看压缩到底压掉了多少。
 *
 * 为什么单独一个脚本而不是只靠单元测试：这条任务的教训是"规模不到就等于没做"——
 * 装配预算 6000 时 8 项材料全内联，压到 2000 才有 4 项溢出。
 * 历史同理：只跑 12 条 × 15000 的构造用例，证明不了真实长会话下会怎样。
 *
 * 摘要器是**本地桩**，不是真模型：真模型调用要密钥，这里只验规模与不变量。
 * 桩做的是一件可核验的事——把被压缩段的头尾与条数如实写进摘要，
 * 于是"标记里真的有摘要内容"这条断言不靠运气。
 *
 * 用法：node scripts/compaction-real-check.cjs
 */
const { compact, DEFAULTS } = require('../core/harness/compaction.cjs');

const COUNT = 50;
const EACH = 5000;
const TOTAL = COUNT * EACH;

const FILLER = '真实长文本填充，用于验证压缩在真实规模下真的发生。'.repeat(400);

function buildHistory() {
  return Array.from({ length: COUNT }, (_, i) => {
    const head = `第 ${i + 1} 轮：`;
    return { role: i % 2 === 0 ? 'user' : 'assistant', content: head + FILLER.slice(0, EACH - head.length) };
  });
}

/** 本地桩摘要器：如实报告它收到了多少字、段首是哪一句。 */
function localSummarizer(text) {
  const first = text.split('\n\n')[0].slice(0, 80);
  return `摘要器收到 ${text.length} 字；段首：${first}；早期历史主要是连续的长文本轮次，用户在做长会话规模验证。`;
}

const chars = list => list.reduce((sum, m) => sum + String(m.content || '').length, 0);

function check(ok, message) {
  if (!ok) {
    console.error(`✖ ${message}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`✔ ${message}`);
  return true;
}

(async () => {
  const messages = buildHistory();
  const before = chars(messages);
  check(before === TOTAL, `造出 ${before} 字历史（${COUNT} 条 × ${EACH} 字，user/assistant 交替）`);

  const result = await compact({ messages, summarize: localSummarizer });
  const after = chars(result.messages);
  const line = DEFAULTS.maxChars * 0.75;

  check(result.compacted === true, `compacted === true（真的压了，不是空转）`);
  check(result.freedChars > 0, `freedChars = ${result.freedChars} > 0`);
  check(after <= line, `压缩后 ${after} 字 ≤ ${line} 字（${DEFAULTS.maxChars} × 0.75）`);
  check(Boolean(result.marker) && result.marker.role === 'user', '标记消息存在，role = user');
  check(String(result.marker?.content || '').includes(result.summaryText) && result.summaryText.length > 0, '标记内容包含摘要正文');
  check(String(result.marker?.content || '').startsWith('〔已压缩'), '标记格式可识别：以「〔已压缩」开头');
  check(result.messages.slice(-6).every((m, i) => m.content === messages[messages.length - 6 + i].content), '最近 6 条原文原样保留');

  console.log('');
  console.log('实测数字');
  console.log(`  造     ${before} 字（${COUNT} 条）`);
  console.log(`  压掉   ${result.freedChars} 字（${result.dropped} 条 → 1 条摘要）`);
  console.log(`  剩     ${after} 字（摘要标记 ${result.marker.content.length} 字 + 保留 ${result.messages.length - 1} 条）`);
  console.log(`  收窄   ${(100 - (after / before) * 100).toFixed(1)}%（占用降到预算的 ${((after / DEFAULTS.maxChars) * 100).toFixed(1)}%）`);
  console.log('');
  console.log('标记原文：');
  console.log(`  ${result.marker.content.slice(0, 200)}${result.marker.content.length > 200 ? '…' : ''}`);
})();
