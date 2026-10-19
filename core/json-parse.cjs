/* 宽松 JSON 解析：模型偶尔会输出括号错配的 JSON（多一个 }、少一个 ]、被截断）。
 *
 * 实测踩到的形态（真实运行）：
 *   {"claims":[...],"gaps":["...最后一条..."}],"note":"..."}
 *                                        ↑ gaps 数组里多了一个 }
 * 严格解析在 position 2272 失败，而当时的策略是「解析失败就中止整轮」——
 * 前面检索、界定、证据提取三次调用全部作废。这不可接受。
 *
 * 策略：先严格解析；失败再做**结构修复**（不改语义，只修括号配对与尾随逗号），
 * 修完仍不行就交给调用方降级处理，绝不因为格式问题丢掉已有结果。
 *
 * 纯函数，无 IO。
 */

/** 去掉 ```json 围栏与首尾空白。 */
function stripFence(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * 括号配对修复：扫描全文，用栈跟踪开括号。
 * - 遇到多余的闭合（栈顶不匹配但栈里存在对应开括号）→ 丢弃这个闭合；
 * - 遇到没有对应开括号的闭合 → 丢弃；
 * - 扫描结束仍有未闭合 → 按栈顺序补全。
 * 不改动字符串内容，不改变字段结构。
 */
function repairBrackets(text) {
  const source = String(text || '');
  const out = [];
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (escaped) { out.push(ch); escaped = false; continue; }
    if (ch === '\\') { out.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; out.push(ch); continue; }
    if (inString) { out.push(ch); continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const need = ch === '}' ? '{' : '[';
      if (stack.length && stack[stack.length - 1] === need) { stack.pop(); out.push(ch); continue; }
      /* 栈顶不匹配但内部存在对应开括号：说明模型多写了一个闭合，丢掉它。 */
      if (stack.includes(need)) continue;
      continue;
    }
    out.push(ch);
  }
  while (stack.length) out.push(stack.pop() === '{' ? '}' : ']');
  return out.join('');
}

/** 去掉对象/数组里的尾随逗号（{...,} / [...,]）。 */
function dropTrailingCommas(text) {
  return String(text || '').replace(/,\s*([}\]])/g, '$1');
}

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch (error) { return { ok: false, error }; }
}

/**
 * 宽松解析。
 * @returns {{ ok: boolean, value?: any, repaired?: boolean, error?: string, raw?: string }}
 */
function parseLoose(input, { sliceFromBraces = true } = {}) {
  const raw = stripFence(input);
  if (!raw) return { ok: false, error: '模型没有返回内容', raw };

  const direct = tryParse(raw);
  if (direct.ok) return { ok: true, value: direct.value, repaired: false, raw };

  /* 模型常在 JSON 前后夹解释文字：取第一个 { 到最后一个 } 再试。 */
  let candidate = raw;
  if (sliceFromBraces) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) candidate = raw.slice(start, end + 1);
  }
  if (candidate !== raw) {
    const sliced = tryParse(candidate);
    if (sliced.ok) return { ok: true, value: sliced.value, repaired: true, raw };
  }

  /* 结构修复：先用原片段，再用补全后的版本，最后清一次尾随逗号。 */
  const attempts = [
    dropTrailingCommas(repairBrackets(candidate)),
    repairBrackets(dropTrailingCommas(candidate)),
    dropTrailingCommas(repairBrackets(raw))
  ];
  let lastError = direct.error;
  for (const attempt of attempts) {
    const result = tryParse(attempt);
    if (result.ok) return { ok: true, value: result.value, repaired: true, raw };
    lastError = result.error;
  }
  return { ok: false, error: lastError ? lastError.message : '无法解析', raw };
}

module.exports = { parseLoose, repairBrackets, dropTrailingCommas, stripFence };
