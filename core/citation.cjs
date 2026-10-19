'use strict';

// 引用落地核验（citation landing check）
//
// 为什么要做这一层：模型编造文献的能力远强于它自我审查的能力。提示词里写“不得虚构文献”只是请求，
// 不是约束；唯一能机械执行的做法是——把答案里出现的每一个引用，拿到“本轮真实检索到的记录”里
// 逐条比对，对不上的一律标为未核验并从正文里抹掉，不让它继续冒充真实引用。
//
// 设计取舍：
// 1) 纯函数、无 IO、无网络，只用 Node 内置能力；核验依据完全来自调用方传入的 records。
// 2) 未核验的引用不是“加个降级标注”而是“移除 + 留占位”，因为留在原文里的假引用最容易被直接抄走。
// 3) 作者-年份式引用（Smith et al., 2019、某某研究（2020）、[作者, 2019]）单独归为 suspicious 而不参与
//    核验：它既没有 DOI 也没有唯一编号，正则无法判断真伪，硬核验只会制造假阳性；但它是编造文献最常用的
//    形态，单独统计出来才能提示使用者“这些引用一条都不可查”。
// 4) 所有正则都避免嵌套量词、量词都带显式上界，保证 1MB 级文本不会出现灾难性回溯。

// 三类引用的占位符分开写：DOI/arXiv 是“带编号的硬引用”，被移除时要显式说“已移除”，
// 避免读者把占位符误读成某种新的引用格式。
const PLACEHOLDER = { marker: '〔未核实引用〕', doi: '〔未核实引用，已移除〕', arxiv: '〔未核实引用，已移除〕' };

// 引用记号：[S3]、[S1,S4]、[S1-S3]、[^3]。
// 注意：实验运行编号 [E1] 不在这里处理——那属于数字门禁（core/exec/claims.cjs）。
// 早期正则会连 [E1] 一起当文献引用，核验时因为资料库没有 E 键而被删成「未核实引用」，
// 于是数字门禁失去归属、正文里还平白多出十几个「未核实引用」。
// 每段之间必须有分隔符才继续，所以这个结构没有歧义分支，回溯是线性的。
const MARKER_RE = /\[(?:\^\d+|(?:S?\d+)(?:\s*[-–,，]\s*(?:S?\d+))*)\]/g;
// DOI：\b 结尾意味着匹配不会停在标点上（正则回溯会把结尾的 . , ) 让出去），后面 trimDoi 再兜底一次。
const DOI_RE = /\b10\.\d{4,9}\/[-._;()\/:a-zA-Z0-9]+\b/g;
// arXiv：同时吃 arXiv: 前缀和 arxiv.org/abs/ 链接两种写法，版本号 v2 由 normalizeArxiv 丢掉。
const ARXIV_RE = /\barxiv(?:\s*:\s*|\s*\.org\/abs\/)\s*(\d{4}\.\d{4,5})(?:v\d+)?/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}"']{1,500}/g;
// 拉丁作者-年份：半角/全角括号都要认，括号内不允许再出现括号，长度上界 60 保证线性扫描。
const AUTHOR_YEAR_LATIN_RE = /[（(]\s*[A-Z][^()（）\n]{0,60}?(?:19|20)\d{2}[a-z]?\s*[)）]/g;
// 中文作者-年份有两种写法：作者（2020）、（作者，2020）。分支各自有界，不存在指数回溯。
const AUTHOR_YEAR_CJK_RE = /(?:[\u4e00-\u9fa5]{2,20}\s*(?:等|等人)?\s*(?:研究|团队|课题组)?\s*[（(]\s*(?:19|20)\d{2}\s*[)）]|[（(]\s*[\u4e00-\u9fa5]{2,20}\s*(?:等|等人)?\s*[，,、]\s*(?:19|20)\d{2}\s*[)）])/g;
const AUTHOR_YEAR_BRACKET_RE = /\[[^\[\]\n]{0,60}?[A-Za-z\u4e00-\u9fa5][^\[\]\n]{0,60}?(?:19|20)\d{2}[^\[\]\n]{0,20}?\]/g;

const SUSPICIOUS_PATTERNS = [
  { type: 'author-year', re: AUTHOR_YEAR_LATIN_RE, reason: '作者-年份式引用没有 DOI 或唯一编号，无法机械核验' },
  { type: 'author-year', re: AUTHOR_YEAR_CJK_RE, reason: '作者-年份式引用没有 DOI 或唯一编号，无法机械核验' },
  { type: 'author-year', re: AUTHOR_YEAR_BRACKET_RE, reason: '作者-年份式引用没有 DOI 或唯一编号，无法机械核验' },
  // doi.org / arxiv.org 的链接会被 DOI、arXiv 规则先行认领，剩下的裸链接没有可核验的编号，
  // 归入可疑项而不是引用，免得它们绕过核验。
  { type: 'link', re: URL_RE, reason: '无来源链接无法核验其指向的文献' }
];

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

// DOI 归一化：小写、去掉 https://doi.org/ 或 doi: 前缀、去首尾空白和结尾句点。
// 不做这一步的话，库里存的 "https://doi.org/10.1038/NATURE12373" 和正文里的 "10.1038/nature12373"
// 会被判成两个东西，核验就会假失败。
function normalizeDoi(value) {
  return asText(value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi\s*:\s*/i, '')
    .trim()
    .toLowerCase()
    .replace(/[.\s]+$/, '');
}

// arXiv 编号归一化：去掉 arXiv: 前缀、abs 链接前缀和版本号，只留 2101.00001 这种主体。
function normalizeArxiv(value) {
  return asText(value)
    .trim()
    .replace(/^arxiv\s*:\s*/i, '')
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
    .replace(/v\d+$/i, '')
    .trim();
}

// 兜底裁掉 DOI 结尾的标点：`)` 只在括号不配对时才算多余，避免砍掉 DOI 内部的括号。
function trimDoi(raw) {
  let out = asText(raw).replace(/[.,;:]+$/, '');
  while (out.endsWith(')')) {
    const opens = (out.match(/\(/g) || []).length;
    const closes = (out.match(/\)/g) || []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1).replace(/[.,;:]+$/, '');
  }
  return out;
}

// 引用记号拆解：[S1,S4] -> S1、S4；[S1-S3] -> S1、S2、S3；[^3] 当作独立的脚注键。
function parseMarker(raw) {
  const inner = raw.slice(1, -1);
  if (inner.startsWith('^')) return { key: inner, ids: [inner] };
  const ids = [];
  let lastPrefix = '';
  for (const part of inner.split(/[,，]/)) {
    const m = /^([SE])?(\d+)(?:\s*[-–]\s*(?:([SE])?(\d+)))?$/.exec(part.trim());
    if (!m) return null;
    const prefix = m[1] || m[3] || lastPrefix;
    const start = Number(m[2]);
    const endRaw = m[4] === undefined ? start : Number(m[4]);
    lastPrefix = prefix;
    if (endRaw < start) { ids.push(`${prefix}${start}`); continue; }
    // 上界 100：防止 [S1-S999999] 这种输入把 id 数组撑爆。
    const stop = Math.min(endRaw, start + 100);
    for (let n = start; n <= stop; n++) ids.push(`${prefix}${n}`);
  }
  if (!ids.length) return null;
  return { key: ids.length === 1 ? ids[0] : ids.join(','), ids };
}

// 在正文里扫一遍所有引用痕迹，带位置信息（供 redact 单次遍历改写，避免对每处引用各扫一遍全文）。
function scan(text) {
  const source = asText(text);
  if (!source) return [];
  const verifiable = [];
  for (const m of source.matchAll(MARKER_RE)) {
    const parsed = parseMarker(m[0]);
    if (parsed) verifiable.push({ kind: 'marker', raw: m[0], index: m.index, end: m.index + m[0].length, key: parsed.key, ids: parsed.ids });
  }
  for (const m of source.matchAll(DOI_RE)) {
    const raw = trimDoi(m[0]);
    if (raw) verifiable.push({ kind: 'doi', raw, index: m.index, end: m.index + raw.length, doi: normalizeDoi(raw) });
  }
  for (const m of source.matchAll(ARXIV_RE)) {
    const raw = m[0].trim();
    verifiable.push({ kind: 'arxiv', raw, index: m.index, end: m.index + raw.length, id: normalizeArxiv(m[1]) });
  }
  // 先认领可核验的三类，再让 suspicious 避开它们：否则 "10.x/a2019" 这种长在方括号里的假 DOI
  // 会被“作者-年份”模式整段吞掉，反而逃过核验与改写。
  const kept = sortAndFilter(verifiable);
  const suspects = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    for (const m of source.matchAll(pattern.re)) {
      let raw = m[0];
      if (pattern.type === 'link') raw = raw.replace(/[.,;:、。，]+$/, '');
      if (!raw) continue;
      suspects.push({ kind: 'suspicious', type: pattern.type, raw, index: m.index, end: m.index + raw.length, reason: pattern.reason });
    }
  }
  suspects.sort((a, b) => a.index - b.index || b.end - b.index - (a.end - a.index));
  const suspicious = [];
  for (const s of suspects) {
    if (overlaps(kept, s)) continue;
    if (suspicious.length && overlaps(suspicious, s)) continue;
    suspicious.push(s);
  }
  return [...kept, ...suspicious].sort((a, b) => a.index - b.index);
}

function sortAndFilter(hits) {
  hits.sort((a, b) => a.index - b.index || b.end - b.index - (a.end - a.index));
  const kept = [];
  let lastEnd = -1;
  for (const hit of hits) {
    if (hit.index < lastEnd) continue;
    kept.push(hit);
    lastEnd = hit.end;
  }
  return kept;
}

// 二分查找是否与已接受区间重叠（已接受区间按 index 有序且互不重叠）。
function overlaps(spans, hit) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (span.end <= hit.index) lo = mid + 1;
    else if (span.index >= hit.end) hi = mid - 1;
    else return true;
  }
  return false;
}

function extractCitations(text) {
  const hits = scan(text);
  return {
    markers: hits.filter(h => h.kind === 'marker').map(h => ({ kind: 'marker', raw: h.raw, key: h.key, ids: [...h.ids] })),
    dois: hits.filter(h => h.kind === 'doi').map(h => ({ kind: 'doi', raw: h.raw, doi: h.doi })),
    arxivIds: hits.filter(h => h.kind === 'arxiv').map(h => ({ kind: 'arxiv', raw: h.raw, id: h.id })),
    suspicious: hits.filter(h => h.kind === 'suspicious').map(h => ({ kind: 'suspicious', raw: h.raw, type: h.type, reason: h.reason }))
  };
}

// 记录里的 arXiv 编号可能没写成字段，从 id（arxiv:2101.00001）或 url（arxiv.org/abs/...）里兜底提取。
function recordArxivId(record) {
  const direct = normalizeArxiv(record.arxivId);
  if (direct) return direct;
  const fromId = /(\d{4}\.\d{4,5})(?:v\d+)?/.exec(asText(record.id));
  if (fromId) return fromId[1];
  const fromUrl = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(asText(record.url));
  return fromUrl ? fromUrl[1] : null;
}

// 记录的 DOI 同理：字段缺失时从 doi.org 链接里兜底，否则以链接给出的记录会永远核验失败。
function recordDoi(record) {
  const direct = normalizeDoi(record.doi);
  if (direct) return direct;
  const url = asText(record.url);
  return /doi\.org\//i.test(url) ? normalizeDoi(url) : '';
}

function recordIdOf(record) {
  const candidate = record.id !== undefined && record.id !== null && record.id !== '' ? record.id : record.doi;
  return asText(candidate).trim();
}

function recordTitleOf(record) {
  return asText(record.title).trim().slice(0, 200);
}

function numberOf(label) {
  const m = /(\d+)/.exec(asText(label));
  return m ? String(Number(m[1])) : null;
}

// 解析答案自带的参考文献列表：位置型引用（没有资料库键）只能靠“参考文献第 N 条”来定位。
function referenceList(text) {
  const source = asText(text);
  const head = /(?:^|\n)[ \t>*#-]*(?:参考文献|参考资料|引用文献|references?)[ \t]*[:：]?[ \t]*\n/i.exec(source);
  if (!head) return null;
  const tail = source.slice(head.index + head[0].length);
  const entries = new Map();
  const entryRe = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?(?:\[(\^?[SE]?\d+)\]|(\d+)[.、)）])[ \t]*([^\n]{0,400})/g;
  for (const m of tail.matchAll(entryRe)) {
    const num = numberOf(m[1] || m[2]);
    if (num && !entries.has(num)) entries.set(num, asText(m[3]).trim());
  }
  return entries.size ? entries : null;
}

function audit(text, records) {
  const source = asText(text);
  const extracted = extractCitations(source);
  const list = Array.isArray(records) ? records : [];
  const doiIndex = new Map();
  const arxivIndex = new Map();
  const keyIndex = new Map();
  for (const record of list) {
    if (!record || typeof record !== 'object') continue;
    const doi = recordDoi(record);
    if (doi && !doiIndex.has(doi)) doiIndex.set(doi, record);
    const arxiv = recordArxivId(record);
    if (arxiv && !arxivIndex.has(arxiv)) arxivIndex.set(arxiv, record);
    const key = asText(record.key).trim();
    if (key && !keyIndex.has(key)) keyIndex.set(key, record);
  }
  // 资料库里只要有记录带显式键，就按键核验；一条键都没有时，marker 只能算位置型引用。
  const hasKeys = keyIndex.size > 0;
  const refs = hasKeys ? null : referenceList(source);
  const resolved = [];
  const unresolved = [];
  const pass = (raw, kind, record) => resolved.push({ raw, kind, recordId: recordIdOf(record), title: recordTitleOf(record) });
  const fail = (raw, kind, reason) => unresolved.push({ raw, kind, reason });

  for (const marker of extracted.markers) {
    if (hasKeys) {
      const missing = marker.ids.filter(id => !keyIndex.has(id));
      if (missing.length) fail(marker.raw, 'marker', `资料库中没有引用键 ${missing.join(',')}`);
      else pass(marker.raw, 'marker', keyIndex.get(marker.ids[0]));
    } else if (refs) {
      const missing = marker.ids.filter(id => !refs.has(numberOf(id)));
      if (missing.length) fail(marker.raw, 'marker', `参考文献列表中没有 ${missing.join(',')} 对应的条目`);
      else {
        const num = numberOf(marker.ids[0]);
        resolved.push({ raw: marker.raw, kind: 'marker', recordId: `reference:${num}`, title: asText(refs.get(num)).slice(0, 200) });
      }
    } else {
      fail(marker.raw, 'marker', '未找到对应的资料库键');
    }
  }
  for (const doi of extracted.dois) {
    const record = doiIndex.get(doi.doi);
    if (record) pass(doi.raw, 'doi', record);
    else fail(doi.raw, 'doi', '该 DOI 不在本轮检索到的资料库中');
  }
  for (const arxiv of extracted.arxivIds) {
    const record = arxivIndex.get(arxiv.id);
    if (record) pass(arxiv.raw, 'arxiv', record);
    else fail(arxiv.raw, 'arxiv', '该 arXiv 编号不在本轮检索到的资料库中');
  }

  const counts = {
    markers: extracted.markers.length,
    dois: extracted.dois.length,
    arxivIds: extracted.arxivIds.length,
    suspicious: extracted.suspicious.length
  };
  return {
    ok: unresolved.length === 0,
    counts,
    resolved,
    unresolved,
    stats: {
      totalRecords: list.length,
      // 可疑项不参与核验，也不计入“引用总数”，否则 resolvedCount + unresolvedCount 就对不上总数了。
      totalCitations: counts.markers + counts.dois + counts.arxivIds,
      resolvedCount: resolved.length,
      unresolvedCount: unresolved.length
    }
  };
}

function redact(text, report) {
  const source = asText(text);
  const unresolved = (report && Array.isArray(report.unresolved) ? report.unresolved : []).filter(u => u && u.raw);
  const resolvedSet = new Set((report && Array.isArray(report.resolved) ? report.resolved : []).filter(u => u && u.raw).map(u => u.raw));
  const unresolvedSet = new Set(unresolved.map(u => u.raw));
  const hits = scan(source);
  let out = '';
  let cursor = 0;
  const removed = [];
  const kept = [];
  const seen = new Set();
  for (const hit of hits) {
    if (hit.kind === 'suspicious') continue; // 可疑项只统计，不改写正文，避免误伤正常句子
    // 未核验优先判定：同一个 raw 只可能有一种结论，这里写死顺序免得将来两种集合同时命中时改错。
    if (!unresolvedSet.has(hit.raw)) {
      if (resolvedSet.has(hit.raw) && !seen.has(hit.raw)) {
        seen.add(hit.raw);
        kept.push(hit.raw);
      }
      continue;
    }
    // 单次线性遍历完成全部替换：逐条 raw 做 split/join 会在引用很多时退化成 O(n*k)。
    out += source.slice(cursor, hit.index) + PLACEHOLDER[hit.kind];
    cursor = hit.end;
    removed.push(hit.raw);
  }
  out += source.slice(cursor);
  return { text: out, removed, kept, note: removed.length ? `已移除 ${removed.length} 处无法核验的引用。` : '没有需要移除的未核验引用。' };
}

function formatReference(record) {
  const r = record && typeof record === 'object' ? record : {};
  const authors = (Array.isArray(r.authors) ? r.authors : [])
    .map(a => (a && typeof a === 'object' ? asText(a.name || a.author || a.display_name).trim() : asText(a).trim()))
    .filter(Boolean);
  const authorText = authors.length ? (authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 等` : authors.join(', ')) : '';
  const title = asText(r.title).trim();
  const venue = asText(r.venue).trim();
  const year = Number.isFinite(Number(r.year)) && Number(r.year) > 0 ? String(Number(r.year)) : '';
  const doi = recordDoi(r);
  const arxiv = recordArxivId(r);
  const parts = [];
  if (authorText) parts.push(authorText);
  if (title) parts.push(title);
  const venueYear = venue && year ? `${venue}, ${year}` : venue || year;
  if (venueYear) parts.push(venueYear);
  let out = parts.join('. ');
  if (doi) out += `${out ? '. ' : ''}DOI: ${doi}`;
  else if (arxiv) out += `${out ? '. ' : ''}arXiv: ${arxiv}`;
  else if (out && !/[.。]$/.test(out)) out += '.';
  return out;
}

// 自查：检查器报坏消息时，先怀疑检查。这里用固定样例把“真引用能过、空库必须不过、
// 归一化正确、改写幂等”钉死，任何一条失败就说明核验逻辑本身坏了，不能拿去判别人的答案。
function selfTest() {
  const failures = [];
  const check = (name, fn) => {
    try {
      const problem = fn();
      if (problem) failures.push(`${name}：${problem}`);
    } catch (e) {
      failures.push(`${name}：抛出异常 ${e && e.message ? e.message : String(e)}`);
    }
  };
  const realRecord = { id: 'openalex:W2741809807', source: 'openalex', title: 'A verified paper', authors: ['A. Author', 'B. Author'], year: 2015, venue: 'Nature', doi: '10.1038/nature12373', url: 'https://doi.org/10.1038/NATURE12373', arxivId: null };
  const textWithDoi = '该结构的稳定性已被独立验证（10.1038/nature12373）。';

  check('真实 DOI 应核验通过', () => {
    const report = audit(textWithDoi, [realRecord]);
    if (report.ok !== true) return `审计判为未通过，未核验项：${report.unresolved.map(u => u.reason).join('；')}`;
    return report.resolved.length === 1 && report.resolved[0].recordId === realRecord.id ? '' : '核验通过但没有指向资料库记录';
  });

  check('空资料库应判定为未核验', () => {
    const report = audit(textWithDoi, []);
    if (report.ok !== false) return '空资料库下仍判为通过';
    return report.unresolved.length === 1 ? '' : `未核验数量为 ${report.unresolved.length}，应为 1`;
  });

  // [S1,S4] 归一成一条 marker、两个 id；两个 id 必须各自独立核验，缺一个就整条不算通过。
  check('多引用记号应拆成多个 id 并逐个核验', () => {
    const { markers } = extractCitations('[S1,S4]');
    if (markers.length !== 1) return `记号条数为 ${markers.length}，应为 1`;
    if (markers[0].ids.join(',') !== 'S1,S4') return `拆分为 ${markers[0].ids.join(',')}`;
    if (markers[0].raw !== '[S1,S4]') return `raw 为 ${markers[0].raw}`;
    // 整条按“全部 id 都能对上”才算通过：缺一个就整条不通过，从而被 redact 整条移除。
    const report = audit('[S1,S4]', [{ id: 'lib:1', key: 'S1', title: 't' }]);
    if (report.resolved.length !== 0 || report.unresolved.length !== 1) return '缺键的引用没有被判为未核验';
    if (!report.unresolved[0].reason.includes('S4')) return '未核验项没有指出缺失的 S4';
    if (report.unresolved[0].reason.includes('S1')) return '已命中的 S1 被误报为缺失';
    const solo = audit('[S4]', [{ id: 'lib:2', key: 'S4', title: 't' }]);
    return solo.ok === true ? '' : '单个 id 命中键时仍判为未通过';
  });

  check('arXiv 版本号应归一', () => {
    const first = extractCitations('见 arXiv:2101.00001v2').arxivIds[0];
    return first && first.id === '2101.00001' ? '' : `得到 ${first && first.id}`;
  });

  check('编造 DOI 在空库下必须未核验', () => {
    const report = audit('编造引用 10.9999/fake.2024.001', []);
    return report.unresolved.some(u => u.kind === 'doi' && u.raw === '10.9999/fake.2024.001') ? '' : '没有把编造 DOI 判为未核验';
  });

  check('改写应移除未核验 DOI 且幂等', () => {
    const text = '编造引用 10.9999/fake.2024.001 在此。';
    const report = audit(text, []);
    const once = redact(text, report);
    if (once.text.includes('10.9999/fake.2024.001')) return '未核验 DOI 仍留在正文';
    if (!once.text.includes(PLACEHOLDER.doi)) return '没有写入占位说明';
    const twice = redact(once.text, report);
    if (twice.text !== once.text) return '二次改写改变了文本';
    return twice.removed.length === 0 ? '' : '二次改写仍报告移除项';
  });

  return { ok: failures.length === 0, failures };
}

module.exports = { extractCitations, audit, redact, selfTest, formatReference };
