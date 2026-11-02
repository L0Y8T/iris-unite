/* 工具调用协议：用文本约定实现"模型请求动作"，不依赖各家 provider 的 tools 字段。
 *
 * 为什么不直接上原生 tool calling：
 *   - Iris Unite 四条通道里，GPT 走 `codex exec` 子进程（providers.cjs:129），
 *     它自带工具与只读沙箱，无法按同一协议逐次调用工具，只能整轮交付；
 *   - 自定义连接目前只声明 openai / anthropic 两种文字协议（connections.cjs:19），
 *     要加 tools 得改连接 schema 与表单，属于跨版本兼容变更。
 * 文本协议对所有通道一视同仁，包括 GPT：它对 GPT 是"一次调用做完一整段"，对其余三条
 * 通道是真正的多步循环。这个取舍写在 docs/harness/architecture.md 里。
 *
 * 协议形状（写进系统提示词，见 renderProtocol）：
 *
 *   ```tool
 *   {"calls":[{"name":"read_artifact","args":{"id":"art-1f4c7d9e","offset":1200}}]}
 *   ```
 *
 * 只输出正文、不带 tool 块 = 本轮结束，正文就是结果。允许多条并行调用。
 * 解析器同时容忍三种常见写法（calls 数组 / 单个 {name,args} / 顶层数组），
 * 因为模型漂移出格式时，"严词拒绝"远不如"照它写的执行"有用。
 */

const TOOL_FENCE = '```tool';
const FENCE_CLOSE = '```';

/**
 * 流式嗅探器：在不破坏流式输出的前提下，判断这一轮到底是不是工具调用。
 *
 * 做法：正常透传增量，但始终囤住末尾 6 个字符（` ```tool `.length - 1 ），
 * 因为一个 tool 围栏可能正好跨在两个 chunk 之间。一旦确认出现 tool 围栏，
 * 立刻停止透传，后续内容全部归给解析器。
 *
 * 这样最终答案仍然逐字流式到达界面，而工具调用那一轮不会把 JSON 漏给用户。
 */
class ToolSniffer {
  constructor({ onText = () => {} } = {}) {
    this.onText = onText;
    this.buffer = '';
    this.sawTool = false;
    this.held = '';
    this._reserve = TOOL_FENCE.length - 1;
  }

  feed(chunk) {
    const text = String(chunk == null ? '' : chunk);
    if (!text) return;
    if (this.sawTool) { this.buffer += text; return; }

    this.buffer += text;
    const at = this.buffer.indexOf(TOOL_FENCE);
    if (at >= 0) {
      this.sawTool = true;
      /* 围栏之前的正文照常透传——那通常是模型陈述意图的"思考"，不该被吞掉。 */
      const before = this.buffer.slice(0, at);
      if (before) this.onText(before);
      return;
    }
    /* 未出现围栏：安全透传，但留住可能被截断的尾巴。 */
    if (this.buffer.length > this._reserve) {
      const safe = this.buffer.slice(0, this.buffer.length - this._reserve);
      this.buffer = this.buffer.slice(this.buffer.length - this._reserve);
      this.onText(safe);
    }
  }

  /** 收尾：把还囤着的尾巴一起放出去。工具调用轮不冲刷，那些内容是 JSON。 */
  finish() {
    if (!this.sawTool && this.buffer) {
      this.onText(this.buffer);
      this.buffer = '';
    }
    return { text: this.buffer, sawTool: this.sawTool };
  }
}

/** 取出最后一个 tool 围栏里的原文。没有围栏返回 null。 */
function extractToolBlock(text) {
  const source = String(text == null ? '' : text);
  const start = source.lastIndexOf(TOOL_FENCE);
  if (start < 0) return null;
  const bodyStart = start + TOOL_FENCE.length;
  const end = source.indexOf(FENCE_CLOSE, bodyStart);
  const body = end < 0 ? source.slice(bodyStart) : source.slice(bodyStart, end);
  return body.trim();
}

/**
 * 解析工具调用。返回 { calls: [...], error? }。
 * 解析失败时 error 是一句可以直接回灌给模型的话，让它自己改格式重试。
 */
function parseToolCalls(text) {
  const block = extractToolBlock(text);
  if (block == null) return { calls: [] };
  let value;
  try {
    value = JSON.parse(block);
  } catch (error) {
    return { calls: [], error: `tool 块不是合法 JSON（${error.message}）。请只输出 {"calls":[{"name":"…","args":{…}}]}。` };
  }
  let rawCalls;
  if (Array.isArray(value)) rawCalls = value;
  else if (value && Array.isArray(value.calls)) rawCalls = value.calls;
  else if (value && typeof value.name === 'string') rawCalls = [value];
  else return { calls: [], error: 'tool 块里没有 calls 数组，也没有 name 字段。' };

  const calls = [];
  for (const [index, raw] of rawCalls.entries()) {
    if (!raw || typeof raw !== 'object') {
      return { calls: [], error: `第 ${index + 1} 个调用不是对象。` };
    }
    const name = raw.name || raw.tool || raw.tool_name;
    if (typeof name !== 'string' || !name.trim()) {
      return { calls: [], error: `第 ${index + 1} 个调用缺 name。` };
    }
    let args = raw.args ?? raw.arguments ?? raw.input ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { return { calls: [], error: `第 ${index + 1} 个调用的 args 是字符串但不是 JSON。` }; }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { calls: [], error: `第 ${index + 1} 个调用的 args 必须是对象。` };
    }
    calls.push({ name: name.trim(), args });
  }
  if (!calls.length) return { calls: [], error: 'calls 是空数组；要么给出调用，要么不要输出 tool 块。' };
  return { calls };
}

/** 去掉 tool 块，只留正文。最终答案落盘时用。 */
function stripToolBlocks(text) {
  return String(text == null ? '' : text).replace(/```tool[\s\S]*?(?:```|$)/g, '').trim();
}

/**
 * 把工具结果回灌成模型下一轮能读的一段话。
 * 失败结果必须带上 hint——只说"失败了"模型会原样重试，直到迭代上限烧光。
 */
function renderToolResults(results) {
  const lines = ['【工具结果】'];
  for (const [index, item] of results.entries()) {
    const head = `[${index + 1}] ${item.name}(${JSON.stringify(item.args || {})})`;
    if (item.result && item.result.ok) {
      const payload = item.result.result;
      lines.push(`${head} → ok`);
      if (payload != null) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        lines.push(text);
      }
    } else {
      const error = (item.result && item.result.error) || '未知错误';
      const hint = item.result && item.result.hint;
      lines.push(`${head} → 失败：${error}${hint ? `\n修正建议：${hint}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 写进系统提示词的那一段协议说明。所有用到工具循环的角色共用同一份措辞。 */
function renderProtocol({ tools, maxSteps = 8 } = {}) {
  const list = tools && tools.length
    ? tools.map(spec => `- ${spec.name}（${spec.permission}）：${spec.summary}`).join('\n')
    : '- （本轮没有可用工具）';
  return [
    '【工具协议】',
    '你可以在需要时调用工具取回真实数据，而不是凭记忆作答。',
    '调用时只输出一个 tool 代码块，块内是 JSON，形状固定为：',
    '```tool',
    '{"calls":[{"name":"工具名","args":{"参数":"值"}}]}',
    '```',
    '规则：',
    `1. 一次可以并行给出多个 calls；总共最多 ${maxSteps} 轮工具往返。`,
    '2. 工具结果会作为下一条消息回给你，读完再用它继续推理。',
    '3. 不需要工具、要给出最终结果时，正常输出正文，不要带 tool 块——正文就是交付内容。',
    '4. 如果工具报错，按它给的修正建议改一次再试，不要原样重复。',
    '5. 不要在正文里伪造工具结果；没有调用工具就不能声称读过文件或跑过实验。',
    '可用工具：',
    list
  ].join('\n');
}

module.exports = {
  TOOL_FENCE, FENCE_CLOSE,
  ToolSniffer, extractToolBlock, parseToolCalls, stripToolBlocks, renderToolResults, renderProtocol
};
