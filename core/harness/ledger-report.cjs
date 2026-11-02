/* 账本摘要：把 ledger.jsonl 压成一份能回答"哪一步最贵、哪类失败最多"的报表。
 *
 * 为什么需要它：ledger.cjs 产出的是"一行一个事实"的追加流，这种格式对崩溃恢复是
 * 最优的（见该文件头部注释），但对人不是——想知道哪类失败最多、哪个阶段最贵，
 * 现在只能手工数行。这一层不改变账本格式，只做一次投影：JSONL → 一份聚合结果。
 *
 * 为什么不做成 Ledger 的方法：账本的职责是"如实追加"，多一个聚合入口就会诱使后来
 * 的人在这里改账本格式去迁就报表。导出是纯函数（buildReport / formatReport），
 * 输入只有 entries，不碰磁盘；磁盘只有 CLI 这一个入口在读，而且只读。
 *
 * 为什么不用 console.table：不同终端的列宽、截断、编码处理不一致，中文字符在
 * 部分终端里还会错位。这里自己算列宽（中文按 2 列算），输出是纯文本，管道、
 * 重定向到文件、贴进进展文档都长得一样。
 *
 * 口径（这几个定义在被问到"这个数字算的是什么"时是唯一答案）：
 *   turns      一次模型往返算一轮。loop.cjs 每轮循环只落三种账之一：loop.tools（要求
 *              调工具）、loop.final（收尾）、loop.parse-error（协议写错），三者相加
 *              就是模型被调了几次，比"步骤数"更接近真实成本。
 *   calls      工具调用次数，即 tool.call 的条数；tools[].calls 之和等于它。
 *   wallClockMs 全账最早 at 到最晚 at 的跨度，不是各条 ms 之和——并发执行的工具
 *              会重叠，把 ms 相加会算出比墙钟还大的时间。
 *   stages[].calls 该阶段落账条数（tool.call、loop.*、artifact.write 都算）。
 *   tools[].totalChars 该工具各次调用记账的 chars 之和。注意：当前 loop.cjs 的
 *              tool.call 不写 chars 字段（只写 name/ok/ms/error），所以按现有账本
 *              这个数会一直是 0，报表里会显式说明，不拿别处的数字凑。
 */
const fs = require('node:fs');
const path = require('node:path');

const LEDGER_FILE = 'ledger.jsonl';

/* 一次模型往返对应的三种账。 */
const TURN_TYPES = new Set(['loop.final', 'loop.tools', 'loop.parse-error']);

/* 后缀约定：以这些词结尾的类型一律算失败。用后缀而不是白名单，
   是为了将来新增 run.abort / tool.timeout 之类的类型时不必回来改这里。 */
const FAILURE_SUFFIX = /\.(error|fail|failed|abort|aborted|timeout)$/;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toText(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

/**
 * 把输入收敛成 { entries（按 seq 排序）, corrupt }。
 * 接受两种形态：
 *   - 数组：entries 本身（垃圾元素就地记进 corrupt）
 *   - { entries, corrupt }：Ledger#read() 的返回值，坏行信息来自读盘那一层
 * 无论哪种，lines = entries.length + corrupt 恒成立，报表里的"有效行 / 坏行"就是它。
 */
function normalizeInput(input) {
  let raw = [];
  let corrupt = 0;
  if (Array.isArray(input)) {
    raw = input;
  } else if (input && typeof input === 'object') {
    raw = Array.isArray(input.entries) ? input.entries : [];
    corrupt = Array.isArray(input.corrupt)
      ? input.corrupt.length
      : Math.max(0, Math.trunc(toNumber(input.corrupt)));
  }
  const entries = [];
  for (const item of raw) {
    /* 只有带 type 的对象才是账本记录；其余（半个对象、被截断的行、非对象）
       一律算坏行，不让一条烂数据把整份报表作废。 */
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string' && item.type) {
      entries.push(item);
    } else {
      corrupt += 1;
    }
  }
  entries.sort((a, b) => toNumber(a.seq) - toNumber(b.seq));
  return { entries, corrupt };
}

/** 一条记录是否算失败。返回 {type,name,error,at} 或 null。 */
function failureOf(entry) {
  const type = entry.type;
  const at = toNumber(entry.at);
  if (type === 'tool.call') {
    if (entry.ok === true) return null;
    return { type, name: toText(entry.name), error: toText(entry.error), at };
  }
  if (type === 'loop.parse-error') {
    return { type, name: null, error: toText(entry.error), at };
  }
  if (FAILURE_SUFFIX.test(type)) {
    return { type, name: toText(entry.name) || toText(entry.status), error: toText(entry.error), at };
  }
  return null;
}

/**
 * 账本 → 聚合结果。纯函数，不读盘、不抛错：空账本、null、半个对象都返回零值报表。
 * options.runId 只在账本本身没带 runId 时兜底（CLI 拿 run 目录名填）。
 */
function buildReport(input, options = {}) {
  const { entries, corrupt } = normalizeInput(input);
  const runId = entries.map(entry => toText(entry.runId)).find(Boolean) || toText(options.runId) || null;

  const byType = {};
  const toolMap = new Map();
  const stageMap = new Map();
  const failures = [];
  let turns = 0;
  let calls = 0;
  let minAt = 0;
  let maxAt = 0;
  let sawAt = false;

  for (const entry of entries) {
    const type = entry.type;
    byType[type] = (byType[type] || 0) + 1;
    if (TURN_TYPES.has(type)) turns += 1;

    const at = toNumber(entry.at);
    if (at > 0) {
      if (!sawAt) { minAt = at; maxAt = at; sawAt = true; }
      else { if (at < minAt) minAt = at; if (at > maxAt) maxAt = at; }
    }

    const stage = toText(entry.stage);
    if (stage) {
      const bucket = stageMap.get(stage) || { stage, calls: 0, chars: 0, ms: 0 };
      bucket.calls += 1;
      bucket.chars += toNumber(entry.chars);
      bucket.ms += toNumber(entry.ms);
      stageMap.set(stage, bucket);
    }

    if (type === 'tool.call') {
      calls += 1;
      const name = toText(entry.name) || '(未命名)';
      const bucket = toolMap.get(name) || { name, calls: 0, ok: 0, failed: 0, totalMs: 0, totalChars: 0 };
      bucket.calls += 1;
      /* 只有明确 ok:true 才算成功：字段缺失说明这条记录本身不完整，宁可算失败。 */
      if (entry.ok === true) bucket.ok += 1; else bucket.failed += 1;
      bucket.totalMs += toNumber(entry.ms);
      bucket.totalChars += toNumber(entry.chars);
      toolMap.set(name, bucket);
    }

    const failure = failureOf(entry);
    if (failure) failures.push(failure);
  }

  const tools = [...toolMap.values()]
    .map(bucket => ({
      name: bucket.name,
      calls: bucket.calls,
      ok: bucket.ok,
      failed: bucket.failed,
      avgMs: bucket.calls ? Math.round(bucket.totalMs / bucket.calls) : 0,
      totalChars: bucket.totalChars
    }))
    .sort((a, b) => (b.calls - a.calls) || (b.failed - a.failed) || a.name.localeCompare(b.name));

  const stages = [...stageMap.values()]
    .sort((a, b) => (b.ms - a.ms) || (b.chars - a.chars) || (b.calls - a.calls) || a.stage.localeCompare(b.stage));

  failures.sort((a, b) => a.at - b.at);

  return {
    runId,
    turns,
    calls,
    wallClockMs: sawAt ? Math.max(0, maxAt - minAt) : 0,
    byType,
    tools,
    stages,
    failures,
    truncation: { lines: entries.length + corrupt, corrupt }
  };
}

/* ---------- 格式化：纯文本表格，列宽按显示宽度算（中文占 2 列） ---------- */

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndWidth(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function padStartWidth(text, width) {
  const value = String(text);
  return ' '.repeat(Math.max(0, width - displayWidth(value))) + value;
}

const INDENT = '  ';

/** headers 左对齐，numeric 列右对齐；列宽取表头与所有单元格的最大显示宽度。 */
function renderTable(headers, rows, numeric = new Set()) {
  const widths = headers.map((header, index) => {
    let width = displayWidth(header);
    for (const row of rows) width = Math.max(width, displayWidth(row[index]));
    return width;
  });
  const join = cells => INDENT + cells.join('  ').replace(/\s+$/, '');
  const lines = [
    join(headers.map((header, index) => padEndWidth(header, widths[index]))),
    join(widths.map(width => '-'.repeat(width)))
  ];
  for (const row of rows) {
    lines.push(join(row.map((cell, index) => (numeric.has(index)
      ? padStartWidth(cell, widths[index])
      : padEndWidth(cell, widths[index])))));
  }
  return lines;
}

function formatDuration(ms) {
  const value = Math.max(0, toNumber(ms));
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** formatReport 的入参容错：传进来半个对象也照样出报表，不抛错。 */
function coerceReport(report) {
  const source = report && typeof report === 'object' ? report : {};
  const pickArray = value => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []);
  const truncation = source.truncation && typeof source.truncation === 'object' ? source.truncation : {};
  return {
    runId: toText(source.runId),
    turns: toNumber(source.turns),
    calls: toNumber(source.calls),
    wallClockMs: toNumber(source.wallClockMs),
    byType: source.byType && typeof source.byType === 'object' ? source.byType : {},
    tools: pickArray(source.tools),
    stages: pickArray(source.stages),
    failures: pickArray(source.failures),
    truncation: { lines: toNumber(truncation.lines), corrupt: toNumber(truncation.corrupt) }
  };
}

/** 报表 → 可直接打印的纯文本。固定列宽、无颜色、无依赖。 */
function formatReport(report) {
  const r = coerceReport(report);
  const failCount = r.failures.length;
  const validLines = Math.max(0, r.truncation.lines - r.truncation.corrupt);
  const out = [];

  out.push(`账本摘要  ${r.runId || '(未知 run)'}`);
  out.push(`轮次 ${r.turns}  工具调用 ${r.calls}  失败 ${failCount}  墙钟 ${formatDuration(r.wallClockMs)}  有效行 ${validLines}  坏行 ${r.truncation.corrupt}`);

  const types = Object.entries(r.byType).sort((a, b) => (toNumber(b[1]) - toNumber(a[1])) || String(a[0]).localeCompare(String(b[0])));
  out.push('', '按类型');
  if (!types.length) out.push(`${INDENT}（没有记录）`);
  else out.push(...renderTable(['类型', '次数'], types.map(([type, count]) => [type, String(toNumber(count))]), new Set([1])));

  out.push('', '工具');
  if (!r.tools.length) out.push(`${INDENT}（没有工具调用记录）`);
  else {
    out.push(...renderTable(
      ['工具', '次数', '成功', '失败', '平均ms', '总字符'],
      r.tools.map(tool => [
        toText(tool.name) || '(未命名)',
        String(toNumber(tool.calls)),
        String(toNumber(tool.ok)),
        String(toNumber(tool.failed)),
        String(toNumber(tool.avgMs)),
        String(toNumber(tool.totalChars))
      ]),
      new Set([1, 2, 3, 4, 5])
    ));
    const charsKnown = r.tools.some(tool => toNumber(tool.totalChars) > 0);
    if (!charsKnown) out.push(`${INDENT}注：tool.call 目前不记账 chars，总字符一列为 0 不代表没有产出。`);
  }

  out.push('', '阶段');
  if (!r.stages.length) out.push(`${INDENT}（没有带 stage 的记录）`);
  else {
    out.push(...renderTable(
      ['阶段', '记录数', '字符', '毫秒'],
      r.stages.map(stage => [
        toText(stage.stage) || '(未标注)',
        String(toNumber(stage.calls)),
        String(toNumber(stage.chars)),
        String(toNumber(stage.ms))
      ]),
      new Set([1, 2, 3])
    ));
  }

  out.push('', '失败');
  if (!failCount) out.push(`${INDENT}（没有失败记录）`);
  else {
    out.push(...renderTable(
      ['类型', '名字', '错误', '时间'],
      r.failures.slice(0, 20).map(failure => [
        toText(failure.type) || '(未知)',
        toText(failure.name) || '-',
        shorten(toText(failure.error) || '-', 60),
        formatTime(toNumber(failure.at))
      ])
    ));
    if (failCount > 20) out.push(`${INDENT}…另有 ${failCount - 20} 条失败未列出（类型统计见上方"按类型"）。`);
  }

  /* 两句结论：分别对应"哪一步最贵"和"哪类失败最多"。数据不足以判断时明说不判断。 */
  out.push('');
  const priciest = pickPriciest(r.stages);
  if (priciest) {
    const basis = toNumber(priciest.ms) > 0 ? `${formatDuration(priciest.ms)}` : `${toNumber(priciest.chars)} 字符`;
    out.push(`最贵的一步：${toText(priciest.stage) || '(未标注)'}（${basis}${toNumber(priciest.ms) > 0 ? `，${toNumber(priciest.chars)} 字符` : '，账本里没有毫秒'}）`);
  } else {
    out.push('最贵的一步：账本里没有阶段耗时记录，无法判断');
  }
  if (failCount) {
    const hot = hottestFailure(r.failures);
    out.push(`失败最多：${hot.label}（${hot.tied ? '各 ' : ''}${hot.count} 次）`);
  }

  return out.join('\n');
}

function shorten(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function formatTime(at) {
  if (!(at > 0)) return '-';
  const date = new Date(at);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 先按毫秒挑，全部为 0 时退回按字符挑（真实账本目前只有 artifact.write，ms 全空）。 */
function pickPriciest(stages) {
  if (!stages.length) return null;
  const byMs = stages.reduce((best, stage) => (toNumber(stage.ms) > toNumber(best.ms) ? stage : best));
  if (toNumber(byMs.ms) > 0) return byMs;
  return stages.reduce((best, stage) => (toNumber(stage.chars) > toNumber(best.chars) ? stage : best));
}

/**
 * 失败最多的那一类。并列时全部列出，不默默挑一个——
 * "两类各错一次"和"一类错两次"是不同的事实，报表不该把它们打印成同一个样子。
 */
function hottestFailure(failures) {
  const counts = new Map();
  for (const failure of failures) {
    const label = `${toText(failure.type) || '(未知)'}${toText(failure.name) ? ` ${toText(failure.name)}` : ''}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) if (count > max) max = count;
  if (!max) return { label: '(无)', count: 0, tied: false };
  const labels = [...counts].filter(([, count]) => count === max).map(([label]) => label).sort();
  return { label: labels.join('、'), count: max, tied: labels.length > 1 };
}

/* ---------- 只读解析 + CLI ---------- */

/**
 * 只读解析账本文件。语义与 ledger.cjs 的 read() 一致（坏行只计数、不抛错），
 * 但刻意不构造 Ledger——它的构造函数会 mkdir 账本所在目录，一个导出工具不该有这种副作用。
 */
function readLedger(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const entries = [];
  const corrupt = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && value.type) entries.push(value);
      else corrupt.push(text.slice(0, 200));
    } catch {
      corrupt.push(text.slice(0, 200));
    }
  }
  entries.sort((a, b) => toNumber(a.seq) - toNumber(b.seq));
  return { entries, corrupt };
}

/**
 * CLI：node core/harness/ledger-report.cjs <runDir>
 * <runDir> 可以给 run 目录，也可以直接给 ledger.jsonl。
 * 目录不存在、没有账本、账本是空的，都只是"没什么可看"，打一句人话并 exit 0——
 * 这不是错误，把它当错误处理会让脚本里一个"没有 run"的判断变成一堆失败退出码。
 */
function main(argv = []) {
  const target = Array.isArray(argv) ? argv[0] : argv;
  if (!target) {
    process.stdout.write('用法：node core/harness/ledger-report.cjs <runDir>\n');
    return 0;
  }
  const resolved = path.resolve(String(target));
  if (!fs.existsSync(resolved)) {
    process.stdout.write(`${target} 不存在，没有账本可导出。\n`);
    return 0;
  }
  const isDir = fs.statSync(resolved).isDirectory();
  const file = isDir ? path.join(resolved, LEDGER_FILE) : resolved;
  if (!fs.existsSync(file)) {
    process.stdout.write(`${isDir ? resolved : path.dirname(file)} 里没有 ${LEDGER_FILE}，这一轮还没写过账本。\n`);
    return 0;
  }
  const read = readLedger(file);
  if (!read.entries.length && !read.corrupt.length) {
    process.stdout.write(`账本是空的（0 行），没有可统计的东西：${file}\n`);
    return 0;
  }
  const runId = path.basename(isDir ? resolved : path.dirname(resolved));
  process.stdout.write(`${formatReport(buildReport(read, { runId }))}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  buildReport,
  formatReport,
  readLedger,
  main,
  displayWidth,
  TURN_TYPES,
  LEDGER_FILE
};
