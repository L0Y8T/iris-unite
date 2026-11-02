/* agent 循环：调用模型 → 解析工具请求 → 执行 → 回灌 → 继续，直到模型给出最终结果。
 *
 * 这是 harness 与"聊天"的分界。此前 Iris Unite 的每一步都是一次性请求：
 * 模型读完材料就写，写完这条路就走完了（core/collaboration.cjs、core/research.cjs 全部如此）。
 * 有了这个循环，模型才能先看有什么产物、再读需要的那个、再跑一次实验、最后才写结论。
 *
 * 三条设计约束：
 *   1. 与现有 call 接口签名完全兼容（{provider, stage, messages, signal, onText, outputSchema}），
 *      所以 main.cjs 里那个 call 适配器一行都不用改就能接上。
 *   2. 循环有硬上限，且最后一步会明说"这是最后一轮"——不给通牒的迭代上限，
 *      模型会用全部额度继续查资料，最后一步都没写。
 *   3. 工具结果回灌前先截断。单个结果把上下文撑爆，是工具循环最常见的死法。
 */
const {
  ToolSniffer, parseToolCalls, stripToolBlocks, renderToolResults
} = require('./protocol.cjs');

const DEFAULT_LIMITS = {
  /* 工具往返轮数上限。8 轮足够"看清单 → 读两份 → 跑一次 → 写"，再多通常是迷路。 */
  maxSteps: 8,
  /* 单个工具结果回灌的字符上限。超出就截断并提示续读。 */
  resultChars: 8000
};

const LAST_CALL_NOTICE = [
  '【最后通牒】',
  '这是最后一轮，额度已用完。不要再调用工具，直接基于已获得的信息给出最终结果。',
  '如果信息仍不足，就在结果里明确写出"缺什么、为什么无法补齐"，不要编造。'
].join('\n');

function stringifyResult(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

/** 截断单条工具结果，但保留"可以续读"的线索，而不是硬切。 */
function trimResult(results, maxChars) {
  return results.map(item => {
    if (!item.result || !item.result.ok) return item;
    const text = stringifyResult(item.result.result);
    if (text.length <= maxChars) return item;
    return {
      ...item,
      result: {
        ...item.result,
        result: text.slice(0, maxChars) + `\n…〔工具结果已截断：原始 ${text.length} 字，只回灌前 ${maxChars} 字。需要更多请用更精确的参数（如 read_artifact 的 offset/limit）重新调用〕`,
        truncated: true
      }
    };
  });
}

/**
 * 跑一轮 agent 循环。
 *
 * 返回 { text, steps, toolCalls, stoppedReason }：
 *   stoppedReason = 'final'      模型自己收尾（正常路径）
 *                 | 'max-steps' 额度用尽，text 是最后一轮的文本
 *                 | 'no-tools'  没有可用工具，退化为单次调用
 *
 * 事件（onEvent）：
 *   { kind: 'step', step, chars }            一轮开始/结束
 *   { kind: 'tool', step, name, args, ok, ms, chars }
 *   { kind: 'tool-error', step, error }      协议解析失败，已回灌纠错
 */
async function runAgentLoop({
  provider,
  stage,
  messages,
  call,
  toolbox = null,
  limits = {},
  signal,
  ledger = null,
  onEvent = () => {},
  onText = () => {},
  outputSchema = null,
  streamMode = 'stream'
}) {
  const bound = { ...DEFAULT_LIMITS, ...limits };
  const specs = toolbox ? toolbox.specs() : [];
  const toolCalls = [];
  const conversation = [...messages];
  const job = { provider, stage };

  const guard = () => {
    if (signal && signal.aborted) throw new Error('已停止生成');
  };

  /* 没有工具，或者调用方要求强制结构化输出：这两个条件下多步循环没有意义。
     outputSchema 走的是 codex 的子进程 schema 文件，中途无法改，所以与循环互斥。 */
  const singleShot = !toolbox || !specs.length || !!outputSchema;
  const maxSteps = singleShot ? 1 : Math.max(1, bound.maxSteps);

  for (let step = 1; step <= maxSteps; step += 1) {
    guard();
    const isLast = step === maxSteps;
    if (!singleShot && isLast && step > 1) conversation.push({ role: 'user', content: LAST_CALL_NOTICE });

    let full = '';
    /* 流式嗅探：最终答案照常逐字到达界面；工具调用那一轮不会把 JSON 漏给用户。
       buffer 模式下不直连 onText，由调用方在拿到最终文本后统一输出。 */
    const sniffer = new ToolSniffer({ onText: streamMode === 'stream' ? onText : () => {} });
    const sink = chunk => {
      full += chunk;
      sniffer.feed(chunk);
    };

    const startedAt = Date.now();
    await call({
      ...job,
      messages: conversation,
      signal,
      onText: sink,
      outputSchema: isLast ? outputSchema : null
    });
    guard();
    sniffer.finish();

    /* 单次调用：full 就是结果，不做任何协议解析。 */
    if (singleShot) {
      if (streamMode !== 'stream') onText(full);
      if (ledger) ledger.append('loop.final', { provider, stage, step, chars: full.length, ms: Date.now() - startedAt, mode: 'single' });
      onEvent({ kind: 'step', step, chars: full.length, mode: 'single' });
      return { text: full, steps: step, toolCalls, stoppedReason: specs.length ? 'no-tools' : 'no-tools' };
    }

    const { calls, error } = parseToolCalls(full);

    if (error) {
      /* 协议写错：把错误原样回灌，让模型自己改。这一步不消耗工具额度以外的东西。 */
      onEvent({ kind: 'tool-error', step, error });
      if (ledger) ledger.append('loop.parse-error', { provider, stage, step, error: error.slice(0, 400) });
      conversation.push({ role: 'assistant', content: full.slice(0, 4000) || '（工具调用格式有误）' });
      conversation.push({ role: 'user', content: `【工具结果】\n格式有误，无法执行：${error}\n请按协议重新输出一个 tool 块，或直接给出最终结果。` });
      if (isLast) {
        if (streamMode !== 'stream') onText(stripToolBlocks(full) || full);
        return { text: stripToolBlocks(full) || full, steps: step, toolCalls, stoppedReason: 'max-steps' };
      }
      continue;
    }

    if (!calls.length) {
      /* 没有工具请求 = 模型自己收尾。这是正常路径。 */
      const text = stripToolBlocks(full);
      if (streamMode !== 'stream') onText(text);
      if (ledger) ledger.append('loop.final', { provider, stage, step, chars: text.length, ms: Date.now() - startedAt, mode: 'loop' });
      onEvent({ kind: 'step', step, chars: text.length, mode: 'loop' });
      return { text, steps: step, toolCalls, stoppedReason: 'final' };
    }

    /* 执行工具。并行是安全的：每个工具要么只读工作区，要么写入即产生新的不可变产物。 */
    onEvent({ kind: 'step', step, chars: full.length, tools: calls.map(item => item.name) });
    if (ledger) ledger.append('loop.tools', { provider, stage, step, names: calls.map(item => item.name), chars: full.length });

    const executed = await Promise.all(calls.map(async item => {
      const at = Date.now();
      let result;
      try {
        result = await toolbox.invoke(item.name, item.args, { signal });
      } catch (failure) {
        result = { ok: false, error: String(failure && failure.message ? failure.message : failure) };
      }
      const record = { name: item.name, args: item.args, result, ms: Date.now() - at };
      toolCalls.push({ step, name: item.name, args: item.args, ok: !!(result && result.ok), ms: record.ms });
      onEvent({
        kind: 'tool', step, name: item.name, args: item.args,
        ok: !!(result && result.ok), ms: record.ms,
        chars: result && result.ok ? stringifyResult(result.result).length : 0,
        error: result && !result.ok ? result.error : undefined
      });
      if (ledger) ledger.append('tool.call', {
        provider, stage, step, name: item.name, ok: !!(result && result.ok), ms: record.ms,
        error: result && !result.ok ? String(result.error).slice(0, 300) : undefined
      });
      return record;
    }));

    conversation.push({ role: 'assistant', content: stripToolBlocks(full) || '（调用工具）' });
    conversation.push({ role: 'user', content: renderToolResults(trimResult(executed, bound.resultChars)) });

    if (isLast) {
      /* 最后一轮还是调了工具：结果已拿到，但没有正文可交付。如实说明，不假装成功。 */
      const text = stripToolBlocks(full) || '（额度用尽时模型仍在调用工具，本轮没有产出正文。）';
      if (streamMode !== 'stream') onText(text);
      return { text, steps: step, toolCalls, stoppedReason: 'max-steps' };
    }
  }

  /* 理论上不可达：循环体在每一轮都会 return。留一条兜底以免静默返回 undefined。 */
  return { text: '', steps: maxSteps, toolCalls, stoppedReason: 'max-steps' };
}

module.exports = { runAgentLoop, DEFAULT_LIMITS, LAST_CALL_NOTICE, trimResult };
