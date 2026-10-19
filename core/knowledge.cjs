/* 资料库：保存本轮真实检索到的题录，并给每条记录分配一个稳定的引用键（S1、S2…）。
 *
 * 为什么要有这一层：科研答案里的每一处引用都必须能指回这里的一条真实记录。
 * 模型「记得」某篇论文不算证据，只有落在这张表里的才算。核验阶段只认这张表，
 * 表里没有的 DOI / arXiv 号一律按编造处理并移除。
 *
 * 存储：<dataRoot>/knowledge/<conversationId>.json，原子写入（临时文件 + rename），
 * 与 conversations.json 的写入策略保持一致，避免写到一半损坏。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_RECORDS = 240;          // 单轮资料库上限，防止预算与内存被掏空
const MAX_ABSTRACT = 2000;        // 单条摘要截断长度

function normalizeDoi(value) {
  if (typeof value !== 'string') return null;
  let doi = value.trim().toLowerCase();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  doi = doi.replace(/^doi:\s*/, '');
  doi = doi.replace(/[.,;)\]]+$/, '');
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** 把检索器返回的原始记录整理成资料库条目，补上引用键。 */
function normalizeRecord(raw) {
  const doi = normalizeDoi(raw?.doi);
  const url = typeof raw?.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : (doi ? `https://doi.org/${doi}` : '');
  const arxivId = typeof raw?.arxivId === 'string' && /^\d{4}\.\d{4,5}$/.test(raw.arxivId)
    ? raw.arxivId
    : (/(?:arxiv\.org\/abs\/)(\d{4}\.\d{4,5})/i.exec(url)?.[1] || null);
  return {
    source: cleanText(raw?.source, 40),
    sourceId: cleanText(raw?.id, 120),
    title: cleanText(raw?.title, 400),
    authors: Array.isArray(raw?.authors) ? raw.authors.slice(0, 12).map(a => cleanText(a, 80)).filter(Boolean) : [],
    year: Number.isInteger(raw?.year) ? raw.year : null,
    venue: cleanText(raw?.venue, 200),
    doi,
    arxivId,
    url,
    abstract: cleanText(raw?.abstract, MAX_ABSTRACT),
    citedBy: Number.isInteger(raw?.citedBy) ? raw.citedBy : null,
    query: cleanText(raw?.query, 200)
  };
}

class KnowledgeBase {
  constructor({ conversationId, dir }) {
    this.conversationId = String(conversationId || '');
    this.dir = dir ? path.join(dir, 'knowledge') : null;
    this.records = [];
    this.queries = [];
    this.errors = [];
  }

  /** 合并检索结果。同一 DOI / arXiv 号 / 源内 id 视为同一篇，不重复入库。 */
  add(rawRecords, { query = '', source = '' } = {}) {
    const added = [];
    const duplicates = [];
    for (const raw of rawRecords || []) {
      if (this.records.length >= MAX_RECORDS) break;
      const record = normalizeRecord(raw);
      if (!record.title) continue;
      const existing = this.records.find(r =>
        (record.doi && r.doi === record.doi) ||
        (record.arxivId && r.arxivId === record.arxivId) ||
        (record.sourceId && r.sourceId === record.sourceId));
      if (existing) {
        duplicates.push(record.title);
        if (record.source && !existing.alsoFoundIn?.includes(record.source)) {
          existing.alsoFoundIn = [...(existing.alsoFoundIn || []), record.source];
        }
        continue;
      }
      if (query && !this.queries.includes(query)) this.queries.push(query);
      const key = 'S' + (this.records.length + 1);
      this.records.push({ ...record, key, query: query || record.query, source: record.source || source, retrievedAt: Date.now() });
      added.push(key);
    }
    return { added, duplicates, total: this.records.length };
  }

  noteError(source, message) {
    if (this.errors.length < 40) this.errors.push({ source: cleanText(source, 40), message: cleanText(message, 300) });
  }

  all() { return this.records; }
  get(key) { return this.records.find(r => r.key === String(key).toUpperCase()) || null; }
  findByDoi(doi) { const d = normalizeDoi(doi); return d ? this.records.find(r => r.doi === d) || null : null; }
  findByArxiv(id) { return this.records.find(r => r.arxivId === id) || null; }

  /** 供 citation.audit 使用的记录视图（键名与核验模块约定一致）。 */
  toAuditRecords() {
    return this.records.map(r => ({ key: r.key, id: r.sourceId || r.key, source: r.source, title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, url: r.url, arxivId: r.arxivId }));
  }

  stats() {
    const withDoi = this.records.filter(r => r.doi).length;
    const withAbstract = this.records.filter(r => r.abstract).length;
    const years = this.records.map(r => r.year).filter(y => Number.isInteger(y));
    const bySource = {};
    for (const r of this.records) bySource[r.source || '未知'] = (bySource[r.source || '未知'] || 0) + 1;
    return {
      total: this.records.length,
      withDoi,
      withAbstract,
      bySource,
      queries: this.queries.slice(),
      yearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
      errors: this.errors.slice()
    };
  }

  /** 交给模型的紧凑证据清单：只给能核对的部分，摘要截断，避免把预算花在原文上。 */
  digest({ limit = 40, abstractChars = 600 } = {}) {
    return this.records.slice(0, limit).map(r => ({
      key: r.key,
      title: r.title,
      authors: r.authors.slice(0, 3),
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      arxivId: r.arxivId,
      url: r.url,
      citedBy: r.citedBy,
      abstract: r.abstract ? r.abstract.slice(0, abstractChars) : ''
    }));
  }

  file() { return this.dir ? path.join(this.dir, this.conversationId + '.json') : null; }

  save() {
    const file = this.file();
    if (!file) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const payload = { version: 1, conversationId: this.conversationId, savedAt: Date.now(), queries: this.queries, errors: this.errors, records: this.records };
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
    fs.renameSync(temporary, file);
  }

  static load({ conversationId, dir }) {
    const kb = new KnowledgeBase({ conversationId, dir });
    const file = kb.file();
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data.records)) kb.records = data.records;
        if (Array.isArray(data.queries)) kb.queries = data.queries;
        if (Array.isArray(data.errors)) kb.errors = data.errors;
      } catch { /* 损坏就当作空库，本轮重新检索，不影响主流程 */ }
    }
    return kb;
  }

  static remove({ conversationId, dir }) {
    const file = new KnowledgeBase({ conversationId, dir }).file();
    try { if (file) fs.unlinkSync(file); } catch { /* 已不存在 */ }
  }
}

module.exports = { KnowledgeBase, normalizeDoi, normalizeRecord, MAX_RECORDS };
