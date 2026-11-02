/* agent 循环：调用模型 → 解析工具请求 → 执行 → 回灌 → 继续，直到模型给出最终结果。
 *
 * 这是 harness 与"聊天"的分界。此前 Iris Unite 的每一步都是一次性请求：
 * 模型读完材料就写，写完这条路就走完了（core/collaboration.cjs、core/research.cjs 全部如此）。
 * 有了这个循环，模型才能先看有什么产物、再读需要的那个、再跑一次实验、最后才写结论。
 *
 * 五条设计约束：
 *   1. 与现有 call 接口签名完全兼容（{provider, stage, messages, signal, onText, outputSchema}），
 *      所以 main.cjs 里那个 call 适配器一行都不用改就能接上。
 *   2. 循环有硬上限，且最后一步会明说"这是最后一轮"——不给通牒的迭代上限，
 *      模型会用全部额度继续查资料，最后一步都没写。
 *   3. 工具结果回灌前先截断。单个结果把上下文撑爆，是工具循环最常见的死法。
 *   4. 并行不是无条件的。工具在注册处声明 parallelSafe，执行时按声明切批次：
 *      安全的一批并发，不安全的一道屏障独占。见 planBatches。
 *   5. 花钱的动作要人点头。工具在注册处声明 requiresConfirmation，执行前先过确认闸；
 *      没有确认通道就当作拒绝。见 runOne。
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

/* 拒绝后回灌给模型的话。三个要点缺一不可：
   ① 说清是被谁拒的（否则模型会以为工具坏了，换个参数再试一遍）；
   ② 明确禁止重试（同一件事被试三次，等于用花式参数骚扰用户点三次"允许"）；
   ③ 给出替代路径（不跑实验也要交结论，否则这一轮就没产出）。 */
const CONFIRM_DENIED_TEXT = '用户拒绝了这次执行。不要重复尝试，改为在结论里说明未跑实验。';

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
 * 把一次模型请求的调用序列切成执行批次。
 *
 * 规则（连续安全的一批并发，不安全的独占一道屏障）：
 *   连续 parallelSafe:true  → 攒成一批，批内并发；
 *   parallelSafe:false      → 前面那批先全部跑完，它自己单独跑，后面那批再等它跑完；
 *   返回的批之间必须串行执行。
 *
 * 批次只决定"什么时候跑"，不决定"怎么回报"：调用方按 index 把结果放回原位置，
 * 所以回灌给模型的顺序永远等于模型给出的调用顺序。
 *
 * isSafe(name) 由调用方注入：注册表里没有这个工具（模型写错名字）时也算安全，
 * 因为那种调用瞬间返回失败，不存在竞态。
 */
function planBatches(calls, isSafe = () => true) {
  const batches = [];
  let open = null;
  calls.forEach((item, index) => {
    if (isSafe(item.name)) {
      if (!open) {
        open = { concurrent: true, entries: [] };
        batches.push(open);
      }
      open.entries.push({ item, index });
      return;
    }
    open = null;
    batches.push({ concurrent: false, entries: [{ item, index }] });
  });
  return batches;
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
 *
 * confirm 由调用方注入，形状 async ({ name, args, permission }) => boolean：
 *   允许返回 true，其余一律当拒绝。没注入 confirm 就是拒绝——没有确认通道时，
 *   "默认放行"等于把危险动作的开关交给了忘记注入的人。
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
  confirm = null,
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

    /* 执行工具：按 parallelSafe 分组调度，别处不加锁。
       安全的工具（只读工作区，或写入即产生新的不可变产物）批内并发；
       声明了 parallelSafe:false 的（起子进程、吃 GPU、改共享状态）独占一道屏障，
       它前后两批都必须等它结束——否则"读产物 + 跑实验 + 写笔记"三件一起来时，
       笔记可能读到实验写到一半的运行记录。 */
    onEvent({ kind: 'step', step, chars: full.length, tools: calls.map(item => item.name) });
    if (ledger) ledger.append('loop.tools', { provider, stage, step, names: calls.map(item => item.name), chars: full.length });

    const isParallelSafe = name => {
      if (!toolbox || typeof toolbox.get !== 'function') return true;
      const spec = toolbox.get(name);
      return !spec || spec.parallelSafe !== false;
    };

    /* 要不要问人，只看注册处的声明。注册表里查不到（模型写错名字）时不问：
       那种调用瞬间返回失败，压根没有副作用可言。 */
    const needsConfirm = name => {
      if (!toolbox || typeof toolbox.get !== 'function') return false;
      const spec = toolbox.get(name);
      return !!(spec && spec.requiresConfirmation === true);
    };

    /* 确认闸。位置很关键：在 toolbox.invoke 之前、在批内——拒绝时副作用一次都不会发生，
       而分批逻辑一行都不用动（确认不改变"什么时候跑"，只决定"跑不跑"）。
       四种情况全按拒绝处理：没注入 confirm、confirm 返回非 true、confirm 自己抛错、
       等点头期间用户按了停止。宁可这一轮少跑一次实验，也不能偷偷跑。 */
    const askPermission = async item => {
      if (!needsConfirm(item.name)) return true;
      const at = Date.now();
      let allowed = false;
      if (typeof confirm === 'function') {
        try {
          allowed = (await confirm({
            name: item.name,
            args: item.args,
            permission: (toolbox.get(item.name) || {}).permission || 'execute'
          })) === true;
        } catch (failure) {
          /* 确认通道自己坏了（窗口已销毁、对话框抛错）：没有点头就是没有点头。 */
          allowed = false;
        }
      }
      if (signal && signal.aborted) allowed = false;
      /* 记账本：被拒的调用必须留痕。事后问"这轮为什么没跑实验"时，
         账本里要能看见是模型没申请、还是用户拒绝了，两者是完全不同的故障。 */
      if (ledger) ledger.append('tool.confirm', { provider, stage, step, name: item.name, allowed, ms: Date.now() - at });
      return allowed;
    };

    const runOne = async ({ item, index }) => {
      const at = Date.now();
      let result;
      /* 确认先于执行：这一步只要被拒，invoke 一次都不会被碰到。 */
      if (await askPermission(item)) {
        try {
          result = await toolbox.invoke(item.name, item.args, { signal });
        } catch (failure) {
          result = { ok: false, error: String(failure && failure.message ? failure.message : failure) };
        }
      } else {
        /* 拒绝是正常路径，不是异常：回灌一句话让模型改路线，循环继续走。
           这里不抛错——抛出去会让整轮科研报废，而用户点"拒绝"通常只是不想花这笔钱。 */
        result = { ok: false, denied: true, error: CONFIRM_DENIED_TEXT };
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
      return { index, record };
    };

    /* 结果按原始下标落位：并发完成的先后顺序绝不能渗进回灌顺序，
       否则模型读到的 [1][2][3] 与它写的调用顺序对不上，引用错乱会一路传到结论里。 */
    const executed = new Array(calls.length);
    for (const batch of planBatches(calls, isParallelSafe)) {
      if (batch.concurrent) {
        const done = await Promise.all(batch.entries.map(runOne));
        for (const { index, record } of done) executed[index] = record;
      } else {
        const { index, record } = await runOne(batch.entries[0]);
        executed[index] = record;
      }
    }

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

module.exports = { runAgentLoop, planBatches, DEFAULT_LIMITS, LAST_CALL_NOTICE, CONFIRM_DENIED_TEXT, trimResult };
