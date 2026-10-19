/* 数字溯源：答案里的实验数字必须指回某次真实运行。
 *
 * 这一层是执行平台可信的前提。没有它，"准确率 97.3%" 与模型编造的
 * "准确率 97.3%" 在界面上长得一模一样。
 *
 * 规则（MVP，宁可严格也不放行）：
 *   1. 答案用 [E1] / [E1,E2] 标记引用运行记录；标记必须指向本对话里状态为 done 的运行。
 *   2. 带标记的表达里出现的数字，必须能在该运行的指标里找到（允许百分数与小数互认）。
 *   3. 出现指标词（准确率 / loss / 耗时 …）却没有任何标记的实验性数字，一律记为无出处。
 *
 * 纯函数：不读文件、不调模型。
 */

const MARKER = /\[\s*E\d+(?:\s*,\s*E\d+)*\s*\]/g;
const MARKER_IDS = /E\d+/g;

const METRIC_WORDS = [
  '准确率', '精确率', '召回率', 'f1', 'macro', 'loss', '损失', '耗时', '用时', '秒',
  'accuracy', 'precision', 'recall', 'error', '误差', '提升', '下降', '基线', 'baseline',
  'epoch', '轮', '样本', 'samples', 'device'
];

/** 给运行记录编号：优先用已有 label，否则按开始时间顺序编 E1、E2… */
function labelRuns(manifests = []) {
  const list = [...manifests].filter(m => m && m.runId);
  list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  /* 只有形如 E12 的 label 才是「已经分配好的编号」；别的（如 trial 展示名）一律忽略并重新编号。 */
  const isMarkerLabel = value => typeof value === 'string' && /^E\d+$/.test(value);
  const used = new Set(list.map(m => m.label).filter(isMarkerLabel));
  let next = 1;
  return list.map(manifest => {
    if (isMarkerLabel(manifest.label)) return { label: manifest.label, manifest };
    while (used.has('E' + next)) next += 1;
    const label = 'E' + next;
    used.add(label);
    next += 1;
    return { label, manifest };
  });
}

const decimalsOf = token => {
  const match = /\.(\d+)/.exec(token);
  return match ? match[1].length : 0;
};
const toleranceFor = decimals => Math.max(1e-9, 0.5 * 10 ** -decimals);

/**
 * 数值匹配：三种写法分别解释，精度按写法本身决定。
 *   - 带 % 的数字：按百分比解释，容差 = 半个末位（97% 的末位是 1%，容差 0.005）
 *   - 带小数的数字：直接比较，容差 = 半个末位（0.973 容差 0.005）
 *   - 整数：必须精确相等（否则"准确率 1"会被宽松地匹配到 0.97）
 */
function valueMatches(text, metricValue) {
  if (typeof metricValue !== 'number' || !Number.isFinite(metricValue)) return false;
  const hasPercent = String(text).includes('%');
  const token = String(text).replace('%', '').trim();
  const raw = Number(token);
  if (!Number.isFinite(raw)) return false;
  const decimals = decimalsOf(token);
  if (hasPercent) {
    const tol = toleranceFor(decimals) / 100;
    return Math.abs(raw / 100 - metricValue) <= tol || Math.abs(raw - metricValue) <= tol;
  }
  if (decimals > 0) return Math.abs(raw - metricValue) <= toleranceFor(decimals);
  return raw === metricValue;
}

const flatMetrics = manifest => {
  const { metricTable } = require('./manifest.cjs');
  return metricTable(manifest);
};

/** 抽出句子里的候选数字，排除序号、年份、日期、引用键里的数字。 */
function extractNumbers(sentence) {
  const cleaned = sentence
    .replace(/\[\s*S\d+(?:\s*,\s*S\d+)*\s*\]/g, ' ')     // 文献引用键
    .replace(/\[[^\]]*\]/g, ' ')                          // 其他方括号内容（含运行标记）
    .replace(/https?:\/\/\S+/g, ' ')                      // 链接
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ');              // 日期
  const out = [];
  /* 前置断言很关键：F1、top-1、E1 这类词内数字不是数据，不能当指标读。 */
  const pattern = /(?<![A-Za-z0-9_\-.])(-?\d+(?:\.\d+)?)\s*(%?)/g;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const raw = match[1];
    const percent = match[2] === '%';
    const start = match.index;
    const before = cleaned.slice(Math.max(0, start - 3), start);
    const after = cleaned.slice(start + match[0].length, start + match[0].length + 2);
    // 行首编号 "1." / "2、" 不是数据
    if (/(^|\n)\s*$/.test(before) && /^[.、)）]/.test(after)) continue;
    // 年份：四位整数、无小数、不带百分号
    if (!raw.includes('.') && !percent && /^(19|20)\d{2}$/.test(raw)) continue;
    out.push({ raw: raw + (percent ? '%' : ''), token: raw, percent });
  }
  return out;
}

const splitSentences = text => String(text || '').split(/(?<=[。！？；!?;\n])/).filter(s => s.trim());

/**
 * 核验文本里的实验数字。
 * @param {string} text 待核验正文
 * @param {Array} manifests 本对话的运行记录
 */
function verify(text, manifests = []) {
  const labelled = labelRuns(manifests);
  const byLabel = new Map(labelled.map(entry => [entry.label, entry.manifest]));
  const source = String(text || '');
  const markers = [...source.matchAll(MARKER)].map(m => ({ raw: m[0], ids: m[0].match(MARKER_IDS) || [], index: m.index || 0 }));

  const resolved = [];
  const unresolved = [];
  for (const marker of markers) {
    for (const id of marker.ids) {
      const manifest = byLabel.get(id);
      if (!manifest) { unresolved.push({ raw: marker.raw, id, reason: '本对话没有这条运行记录' }); continue; }
      if (manifest.status !== 'done') { unresolved.push({ raw: marker.raw, id, reason: `该运行状态是 ${manifest.status}，不能作为证据` }); continue; }
      resolved.push({ id, runId: manifest.runId, template: manifest.template?.id || null });
    }
  }

  /* 数字归属：句子内出现的数字，归给同一句里最后一个标记；同句没有标记则无出处。 */
  const bound = [];
  const unsourced = [];
  for (const sentence of splitSentences(source)) {
    const sentenceMarkers = [...sentence.matchAll(MARKER)].map(m => (m[0].match(MARKER_IDS) || []));
    const hasWord = METRIC_WORDS.some(word => sentence.toLowerCase().includes(word.toLowerCase()));
    const numbers = extractNumbers(sentence);
    if (!numbers.length) continue;
    const ids = sentenceMarkers.flat();
    if (!ids.length) {
      if (!hasWord) continue;
      for (const number of numbers) unsourced.push({ raw: number.raw, value: Number(number.token), reason: '这句在讲指标，但没有任何 [E] 运行标记' });
      continue;
    }
    for (const number of numbers) {
      const matched = ids.some(id => {
        const manifest = byLabel.get(id);
        if (!manifest || manifest.status !== 'done') return false;
        const metrics = flatMetrics(manifest);
        const params = manifest.params || {};
        // 参数（轮数、批大小、种子）写进正文也算可核对，只要与记录一致
        return [...Object.values(metrics), ...Object.values(params)].some(value => valueMatches(number.raw, value) || String(value) === number.token);
      });
      if (matched) bound.push({ raw: number.raw, value: Number(number.token), ids });
      else unsourced.push({ raw: number.raw, value: Number(number.token), reason: `在 ${ids.join('/')} 的指标与参数里找不到这个数值`, ids });
    }
  }

  const ok = markers.length > 0 && unresolved.length === 0 && unsourced.length === 0;
  return {
    ran: true,
    ok,
    markers: { total: markers.length, resolved, unresolved },
    numbers: { total: bound.length + unsourced.length, bound, unsourced },
    note: ok
      ? ''
      : markers.length === 0
        ? '答案里没有引用任何运行记录，实验数字无法核对。'
        : unresolved.length
          ? `有 ${unresolved.length} 处运行标记无法对应到已完成的运行。`
          : `有 ${unsourced.length} 处实验数字无法指回运行记录。`
  };
}

/**
 * 把无法核对的实验数字/标记在正文里标出来。
 *
 * 与 citation.redact 同一思路：不删句子，只让"这句话里的数字没有出处"变得可见。
 * 标记指向不存在的运行就直接删掉标记；数字找不到出处就包成〔未核对：…〕。
 */
function redact(text, report) {
  const source = String(text || '');
  if (!report || report.ok) return { text: source, removed: [], note: '' };
  let out = source;
  const removed = [];
  for (const item of report.markers.unresolved || []) {
    if (!out.includes(item.raw)) continue;
    out = out.split(item.raw).join('');
    removed.push({ kind: 'marker', raw: item.raw, reason: item.reason });
  }
  /* 同一个数值在正文里可能出现多次，report 里也会有多个条目；
     这里按 raw 去重，并且已经标注过的不再套一层（否则会出现〔未核对：〔未核对：360〕〕）。 */
  const seenNumbers = new Set();
  for (const item of report.numbers.unsourced || []) {
    if (!item.raw || seenNumbers.has(item.raw)) continue;
    seenNumbers.add(item.raw);
    const already = `〔未核对：${item.raw}〕`;
    if (!out.includes(item.raw)) continue;
    if (out.includes(already)) { removed.push({ kind: 'number', raw: item.raw, reason: item.reason }); continue; }
    out = out.split(item.raw).join(already);
    removed.push({ kind: 'number', raw: item.raw, reason: item.reason });
  }
  return {
    text: out,
    removed,
    note: removed.length ? `已标注 ${removed.length} 处无法核对的实验数字或运行标记。` : ''
  };
}

/** 供答案生成前提示模型：可引用的运行与它们的指标。 */
function referenceBlock(manifests = []) {
  const labelled = labelRuns(manifests).filter(entry => entry.manifest.status === 'done');
  if (!labelled.length) return '本轮没有任何已完成的实验运行：正文里不得出现实验数字，也不得声称做过实验。';
  return labelled.map(({ label, manifest }) => {
    const metrics = flatMetrics(manifest);
    const pairs = Object.entries(metrics).map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value.toPrecision(6)) : value}`).join(', ');
    return `${label} | ${manifest.template?.name || manifest.template?.id} | 参数 ${JSON.stringify(manifest.params)} | 指标 ${pairs} | 产物 ${(manifest.artifacts || []).map(a => a.name).join(', ')}`;
  }).join('\n');
}

module.exports = { verify, redact, referenceBlock, labelRuns, valueMatches, extractNumbers, METRIC_WORDS };
