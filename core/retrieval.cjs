// 真实学术文献检索适配层。
// 这一层存在的理由：资料库和引用核验只认这里产出的题录，模型不许自己编 DOI。
// 所以每条记录都必须来自真实接口的原始响应；解析不出来就丢弃该条，绝不补全猜测值。
// 四个源全部免费、无需 API Key，只用 Node 内置 fetch / AbortSignal，不引入任何依赖。
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_TIMEOUT = 12000;
const MAX_AUTHORS = 12;
const MAX_ABSTRACT = 2000;
// 带一个可识别的 UA：NCBI、Crossref 对匿名抓取会限流，标识自己比伪装浏览器更稳妥。
const USER_AGENT = 'IrisUnite/0.5 (+academic retrieval; free public APIs)';
const CROSSREF_SELECT = 'DOI,title,author,issued,container-title,type,abstract,is-referenced-by-count,URL';

const SOURCES = [
  { id: 'openalex', name: 'OpenAlex', needsKey: false, home: 'https://openalex.org', note: '覆盖面最广的开放题录库，含摘要还原与引用数；支持中文检索词' },
  { id: 'crossref', name: 'Crossref', needsKey: false, home: 'https://www.crossref.org', note: 'DOI 注册库，元数据由出版商提交，DOI 权威性最高' },
  { id: 'arxiv', name: 'arXiv', needsKey: false, home: 'https://arxiv.org', note: '预印本，未经同行评审，适合追最新进展' },
  { id: 'pubmed', name: 'PubMed', needsKey: false, home: 'https://pubmed.ncbi.nlm.nih.gov', note: '生物医学文献，走 NCBI E-utilities，免费无 Key' },
];
const DEFAULT_SOURCES = ['openalex', 'crossref', 'arxiv', 'pubmed'];
const SOURCE_IDS = SOURCES.map(source => source.id);

// ---------------------------------------------------------------------------
// 通用文本工具
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...' };
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// 上游摘要里混着 JATS/HTML 标签（<jats:p>、<i> 等）。不剥掉的话，资料库里会出现一堆标签，
// 后面拿摘要做检索或喂模型都会污染输入，所以在入口处一次性洗干净。
function stripTags(value) {
  return String(value ?? '').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
}

function cleanText(value, max = Infinity) {
  const text = decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}` : text;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

// DOI 统一成小写裸值：大小写不同的同一个 DOI 在去重时必须被认成同一篇，
// "https://doi.org/" 前缀也必须去掉，否则后续解析/跳转/核验都会因为格式差异失败。
function normalizeDoi(value) {
  if (typeof value !== 'string') return null;
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/[.,;]+$/, '')
    .toLowerCase();
  // 只认 10.xxxx/yyy 这一种形状：不是 DOI 的字符串（PII、空值、垃圾）宁可返回 null，
  // 也不许塞进 doi 字段冒充真实标识。
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

function yearOf(value) {
  const match = String(value ?? '').match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function authorList(value) {
  const list = (Array.isArray(value) ? value : []).map(name => cleanText(name)).filter(Boolean);
  return [...new Set(list)].slice(0, MAX_AUTHORS);
}

// 记录形状必须完全一致：下游（资料库、引用核验）按固定字段读，多一个少一个都会炸。
function makeRecord(fields, context) {
  return {
    id: String(fields.id),
    source: String(fields.source),
    title: cleanText(fields.title),
    authors: authorList(fields.authors),
    year: intOrNull(fields.year),
    venue: cleanText(fields.venue),
    doi: normalizeDoi(fields.doi ?? ''),
    url: typeof fields.url === 'string' ? fields.url : '',
    abstract: cleanText(fields.abstract, MAX_ABSTRACT),
    citedBy: intOrNull(fields.citedBy),
    type: cleanText(fields.type),
    query: context.query,
    retrievedAt: context.retrievedAt,
  };
}

// ---------------------------------------------------------------------------
// 网络请求：单源独立超时，外部 signal 与超时信号合并
// ---------------------------------------------------------------------------

function describeFetchError(error, timedOut, externalSignal, timeoutMs) {
  if (timedOut) return new Error(`请求超时（${timeoutMs}ms）`);
  if (externalSignal?.aborted) return new Error('检索已取消');
  return new Error(`网络请求失败：${error?.message || String(error)}`);
}

async function requestText(url, source, context) {
  // 先把请求登记进 queries：失败也能在界面上看到"试过哪个地址"，
  // 这样用户能自己判断是检索词的问题还是网络的问题。
  context.queries.push({ source, query: context.query, url });
  const controller = new AbortController();
  let timedOut = false;
  /* 超时用「竞速」而不是只靠 abort 信号：
     abort 只是通知，真正打断取决于 fetch 实现是否响应 signal。第三方适配器、自造 mock、
     以及某些运行时都可能不响应——那样 await 就永久挂住。这里让定时器直接赢得竞速，
     保证无论 fetch 是否配合，这一路检索都按时收口。 */
  let wakeTimeout;
  const timeoutGuard = new Promise((_, reject) => { wakeTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    wakeTimeout(new Error(`请求超时（${context.timeoutMs}ms）`));
  }, context.timeoutMs);
  /* 这里刻意不 unref：
     超时定时器必须能维持事件循环到它触发为止。unref 之后，如果宿主环境此刻没有别的待办
     （测试进程就是这种情况），Node 会认为事件循环已空，定时器不触发、await 永久挂住，
     表现为「Promise resolution is still pending」。
     代价可以忽略：请求一结束就 clearTimeout，不会拖慢进程退出。 */
  // 外部取消（用户点了停止）和本源的超时都要能打断请求，两个信号合并成一个。
  const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  try {
    const response = await Promise.race([
      context.fetchImpl(url, { signal, headers: { accept: 'application/json, application/atom+xml, application/xml;q=0.9, */*;q=0.8', 'user-agent': USER_AGENT } }),
      timeoutGuard
    ]);
    if (response && response.ok === false) throw new Error(`接口返回 HTTP ${response.status || '未知状态'}`);
    if (!response) throw new Error('接口没有返回响应');
    if (typeof response.text === 'function') return await response.text();
    if (typeof response.json === 'function') return JSON.stringify(await response.json());
    throw new Error('接口响应不可读取');
  } catch (error) {
    throw describeFetchError(error, timedOut, context.signal, context.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJSON(url, source, context) {
  const text = await requestText(url, source, context);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回的不是有效 JSON');
  }
}

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

// OpenAlex 的摘要不是文本，而是倒排索引 {词: [位置...]}（为了节省传输体积）。
// 必须按位置填回原句，否则摘要字段要么是空的，要么是乱序单词，拿来检索/引用毫无意义。
function restoreInvertedAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const slot = intOrNull(position);
      if (slot !== null && slot >= 0 && slot < 100000) slots[slot] = word;
    }
  }
  return cleanText(slots.filter(word => typeof word === 'string').join(' '));
}

function openAlexWorkId(record) {
  const raw = String(record?.id ?? '');
  const match = raw.match(/(W\d+)\s*$/i);
  if (match) return match[1].toUpperCase();
  const fallback = raw.split('/').filter(Boolean).pop();
  return fallback ? fallback.toUpperCase() : '';
}

function parseOpenAlexWorks(payload, context) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map(item => {
    const localId = openAlexWorkId(item);
    const doi = normalizeDoi(item?.doi ?? '');
    const landing = typeof item?.primary_location?.landing_page_url === 'string' ? item.primary_location.landing_page_url : '';
    const url = landing || (doi ? `https://doi.org/${doi}` : localId ? `https://openalex.org/${localId}` : '');
    return makeRecord({
      id: `openalex:${localId || doi || ''}`,
      source: 'openalex',
      title: item?.title || item?.display_name || '',
      authors: (Array.isArray(item?.authorships) ? item.authorships : []).map(entry => entry?.author?.display_name || ''),
      year: item?.publication_year,
      venue: item?.primary_location?.source?.display_name || '',
      doi,
      url,
      abstract: restoreInvertedAbstract(item?.abstract_inverted_index),
      citedBy: item?.cited_by_count,
      type: item?.type || '',
    }, context);
  }).filter(record => record.title);
}

async function runOpenAlex(context, source) {
  const params = [`search=${encodeURIComponent(context.query)}`, `per-page=${context.limit}`];
  if (context.yearFrom) params.push(`filter=from_publication_date:${context.yearFrom}-01-01`);
  // mailto 会进 OpenAlex 的 polite pool，配额更宽松。联系人由用户自己填，不在代码里硬编码。
  if (context.contact) params.push(`mailto=${encodeURIComponent(context.contact)}`);
  return parseOpenAlexWorks(await requestJSON(`https://api.openalex.org/works?${params.join('&')}`, source, context), context);
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

function crossrefYear(item) {
  for (const key of ['issued', 'published-print', 'published-online', 'created']) {
    const parts = item?.[key]?.['date-parts'];
    const year = intOrNull(parts?.[0]?.[0]);
    if (year) return year;
  }
  return null;
}

function parseCrossrefWorks(payload, context) {
  const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
  return items.map(item => {
    const doi = normalizeDoi(item?.DOI ?? '');
    const title = Array.isArray(item?.title) ? item.title[0] : item?.title;
    const container = Array.isArray(item?.['container-title']) ? item['container-title'][0] : item?.['container-title'];
    const authors = (Array.isArray(item?.author) ? item.author : []).map(author => {
      if (!author) return '';
      const full = [author.given, author.family].filter(Boolean).join(' ');
      return full || author.name || '';
    });
    // abstract 是 JATS XML 片段，交给 cleanText 剥标签；剥不干净也比把 <jats:p> 存进库好。
    return makeRecord({
      id: `crossref:${doi || String(item?.URL || title || '')}`,
      source: 'crossref',
      title,
      authors,
      year: crossrefYear(item),
      venue: container || '',
      doi,
      url: typeof item?.URL === 'string' ? item.URL : doi ? `https://doi.org/${doi}` : '',
      abstract: item?.abstract || '',
      citedBy: item?.['is-referenced-by-count'],
      type: item?.type || '',
    }, context);
  }).filter(record => record.title);
}

async function runCrossref(context, source) {
  const base = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(context.query)}&rows=${context.limit}`;
  let payload;
  try {
    payload = await requestJSON(`${base}&select=${encodeURIComponent(CROSSREF_SELECT)}`, source, context);
  } catch (error) {
    // select 在某些字段组合下会让 Crossref 整体报错。去掉 select 重试一次能拿回完整元数据，
    // 代价只是多传几个字段；只有在超时/用户取消时才不再重试，否则会白等两倍时间。
    if (context.signal?.aborted || /超时|取消/.test(error.message)) throw error;
    payload = await requestJSON(base, source, context);
  }
  return parseCrossrefWorks(payload, context);
}

// ---------------------------------------------------------------------------
// arXiv（Atom XML，手写解析，不引第三方 XML 库）
// ---------------------------------------------------------------------------

function firstTag(block, name) {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? match[1] : '';
}

function allTags(block, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...block.matchAll(pattern)].map(match => match[1]);
}

function parseArxivAtom(xml, context) {
  const text = String(xml ?? '');
  const entries = text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return entries.map(entry => {
    const rawId = cleanText(firstTag(entry, 'id'));
    // arXiv 的 <id> 带版本后缀（2101.00001v1）。去掉版本号，同一个预印本的各版本才能稳定合并。
    const bareId = (rawId.split('/').filter(Boolean).pop() || '').replace(/v\d+$/i, '');
    const doiRaw = firstTag(entry, 'doi') || firstTag(entry, 'arxiv:doi');
    const doi = normalizeDoi(doiRaw);
    return makeRecord({
      id: `arxiv:${bareId}`,
      source: 'arxiv',
      title: firstTag(entry, 'title'),
      authors: allTags(entry, 'name').map(name => name),
      year: yearOf(firstTag(entry, 'published') || firstTag(entry, 'updated')),
      venue: 'arXiv',
      doi,
      url: bareId ? `https://arxiv.org/abs/${bareId}` : rawId,
      abstract: firstTag(entry, 'summary'),
      citedBy: null,
      type: 'preprint',
    }, context);
  }).filter(record => record.title && record.id !== 'arxiv:');
}

async function runArxiv(context, source) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(context.query)}&start=0&max_results=${context.limit}`;
  return parseArxivAtom(await requestText(url, source, context), context);
}

// ---------------------------------------------------------------------------
// PubMed（两步：esearch 拿 PMID 列表，esummary 拿题录）
// ---------------------------------------------------------------------------

function pubmedDoi(item) {
  const elocation = String(item?.elocationid ?? '');
  const inElocation = elocation.match(/10\.\d{4,9}\/[^\s]+/);
  if (inElocation) return normalizeDoi(inElocation[0]);
  const ids = Array.isArray(item?.articleids) ? item.articleids : [];
  const entry = ids.find(candidate => String(candidate?.idtype).toLowerCase() === 'doi');
  return entry ? normalizeDoi(String(entry.value ?? '')) : null;
}

function parsePubmedSummaries(payload, context) {
  const result = payload?.result;
  if (!result || typeof result !== 'object') return [];
  const uids = Array.isArray(result.uids) ? result.uids.map(String) : Object.keys(result).filter(key => key !== 'uids');
  return uids.map(uid => {
    const item = result[uid];
    if (!item || typeof item !== 'object' || item.error) return null;
    return makeRecord({
      id: `pubmed:${uid}`,
      source: 'pubmed',
      title: item.title || '',
      authors: (Array.isArray(item.authors) ? item.authors : []).map(author => author?.name || author?.fullname || ''),
      year: yearOf(item.pubdate || item.sortpubdate),
      venue: item.fulljournalname || item.source || '',
      doi: pubmedDoi(item),
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      // esummary 不返回摘要。要摘要就得再抓 efetch，成本与失败面都翻倍，这里留空由上层按需取。
      abstract: '',
      citedBy: null,
      type: Array.isArray(item.pubtype) ? item.pubtype[0] || '' : '',
    }, context);
  }).filter(record => record && record.title);
}

async function runPubmed(context, source) {
  // NCBI 要求带上 tool（有邮箱再带 email），否则高频调用会被限流甚至封段。
  const identity = `&tool=iris-unite${context.contact ? `&email=${encodeURIComponent(context.contact)}` : ''}`;
  const searchURL = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(context.query)}&retmax=${context.limit}&retmode=json${identity}`;
  const search = await requestJSON(searchURL, source, context);
  const ids = (Array.isArray(search?.esearchresult?.idlist) ? search.esearchresult.idlist : []).map(String).filter(Boolean);
  if (!ids.length) return [];
  const summaryURL = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(ids.join(','))}&retmode=json${identity}`;
  const summary = await requestJSON(summaryURL, source, context);
  return parsePubmedSummaries(summary, context);
}

// ---------------------------------------------------------------------------
// 检索主流程
// ---------------------------------------------------------------------------

const RUNNERS = { openalex: runOpenAlex, crossref: runCrossref, arxiv: runArxiv, pubmed: runPubmed };

function clampLimit(value) {
  const number = intOrNull(value);
  if (number === null || number <= 0) return DEFAULT_LIMIT;
  return Math.min(number, MAX_LIMIT);
}

// 跨源去重：同一个 DOI 就是同一篇文献，保留先到的记录，把后来的来源记进 alsoFoundIn。
// 该字段只在真的重复时才出现，避免给所有记录塞一个空数组。
function dedupeRecords(records) {
  const kept = [];
  const byDoi = new Map();
  for (const record of records) {
    if (!record.doi) { kept.push(record); continue; }
    const existing = byDoi.get(record.doi);
    if (!existing) { byDoi.set(record.doi, record); kept.push(record); continue; }
    if (existing.source !== record.source) {
      const also = existing.alsoFoundIn || (existing.alsoFoundIn = []);
      if (!also.includes(record.source)) also.push(record.source);
    }
  }
  return kept;
}

/* 每个源的礼貌间隔与超时。
 *
 * arXiv 的 API 明确要求请求之间留出间隔，连续 4 条检索式连发会被它回 429；
 * 实测一轮科研检索 4 次请求里 2 次 429、2 次超时，等于这个源整个缺席。
 * PubMed 同理（无 key 时 3 请求/秒上限）。这里按源做节流，并给慢源更长的超时。
 */
const MIN_INTERVAL_MS = { arxiv: 3000, pubmed: 400 };
const SOURCE_TIMEOUT_MS = { arxiv: 10000, pubmed: 15000 };
const lastRequestAt = new Map();

/* 熔断：同一个源连续失败到阈值后，本轮剩下的检索直接跳过它。
 *
 * 为什么需要：某个源被上游限流或不可达时，每次都等满超时会把整轮检索拖长到几分
 * 钟——实测 4 条检索式里 arXiv 4 次全失败（超时 + 429），每一条都要白等十几秒，
 * 而 OpenAlex 一秒内就返回了。失败两次之后就不再试，把时间留给能用的源，
 * 并在 errors 里明确写出「已跳过」，不假装它被查过。
 */
const MAX_CONSECUTIVE_FAILURES = 2;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟后再给它一次机会，不要一整个会话都拉黑
const failures = new Map();
function breakerOpen(source) {
  const state = failures.get(source);
  if (!state || state.count < MAX_CONSECUTIVE_FAILURES) return false;
  if (Date.now() - state.at > BREAKER_COOLDOWN_MS) { failures.delete(source); return false; }
  return true;
}
function noteFailure(source) { const state = failures.get(source); failures.set(source, { count: (state?.count || 0) + 1, at: Date.now() }); }
function noteSuccess(source) { failures.delete(source); }
function resetBreaker() { failures.clear(); lastRequestAt.clear(); }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('检索已取消')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new Error('检索已取消')); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 同一源两次请求之间至少间隔 minInterval，避免触发上游限流。 */
async function pace(source, minIntervalMs, signal) {
  if (!minIntervalMs) return;
  const previous = lastRequestAt.get(source) || 0;
  const wait = previous + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt.set(source, Date.now());
}

async function search(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : cleanText(options.query);
  if (!query) throw new Error('检索词不能为空');
  const limit = clampLimit(options.limit);
  const timeoutMs = intOrNull(options.timeoutMs) && intOrNull(options.timeoutMs) > 0 ? intOrNull(options.timeoutMs) : DEFAULT_TIMEOUT;
  const yearFrom = intOrNull(options.yearFrom);
  const contact = typeof options.contact === 'string' ? options.contact.trim() : '';
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch');
  const errors = [];
  const queries = [];
  const requested = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES;
  const ids = [];
  for (const raw of requested) {
    const id = String(raw ?? '').trim().toLowerCase();
    if (!SOURCE_IDS.includes(id)) { errors.push({ source: id || String(raw), message: `未知的文献源：${raw}` }); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  const context = { query, limit, yearFrom, signal: options.signal || null, fetchImpl, contact, timeoutMs, retrievedAt: Date.now(), queries };
  /* 注入了 fetchImpl 说明是离线测试，不需要限速；真实网络请求才按源节流。
     minIntervalMs 可显式覆盖（0 = 关闭限速）。 */
  const intervalFor = id => {
    if (typeof options.fetchImpl === 'function') return 0;
    if (Number.isFinite(options.minIntervalMs) && options.minIntervalMs >= 0) return options.minIntervalMs;
    return MIN_INTERVAL_MS[id] || 0;
  };
  /* 熔断只在真实网络请求时启用。注入了 fetchImpl 说明是离线测试/模拟环境，
     那里每个用例都自己安排源的成功失败，不能让上一个用例的失败影响下一个。
     breaker:true 可强制打开（测试熔断本身用），breaker:false 可强制关闭。 */
  const breakerEnabled = options.breaker === true
    ? true
    : options.breaker === false
      ? false
      : typeof options.fetchImpl !== 'function';
  const batches = await Promise.all(ids.map(async id => {
    try {
      // 已经连续失败的源不再试，直接说明跳过原因，避免整轮检索被它拖住。
      if (breakerEnabled && breakerOpen(id)) {
        errors.push({ source: id, message: `已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，本次检索跳过该源` });
        return [];
      }
      const perSourceTimeout = SOURCE_TIMEOUT_MS[id] || timeoutMs;
      await pace(id, intervalFor(id), options.signal);
      const runOnce = () => RUNNERS[id]({ ...context, timeoutMs: perSourceTimeout }, id);
      let records;
      try {
        records = await runOnce();
      } catch (error) {
        // 429 是限流而不是真的查不到：等一会儿重试一次，再失败才记为错误。
        if (/429|too many requests|过于频繁/i.test(error?.message || '') && !options.signal?.aborted) {
          await sleep(Math.max(5000, (MIN_INTERVAL_MS[id] || 0) * 2), options.signal);
          lastRequestAt.set(id, Date.now());
          records = await runOnce();
        } else throw error;
      }
      noteSuccess(id);
      return records;
    } catch (error) {
      // 单源失败必须被隔离：某个库宕机/超时不能把整次检索废掉，其余源的真实结果照样要交付。
      // 失败信息统一进 errors，由上层提示用户"这个源没查到"而不是"检索失败"。
      noteFailure(id);
      errors.push({ source: id, message: error?.message || String(error) });
      return [];
    }
  }));
  // 用户主动停止时整次检索作废：返回半截结果会被误当成"查无此文"。
  if (options.signal?.aborted) throw new Error('检索已取消');
  const merged = dedupeRecords(batches.flat())
    .filter(record => !(yearFrom && record.year !== null && record.year < yearFrom))
    .slice(0, limit);
  return { records: merged, errors, queries };
}

function buildQuery({ keywords } = {}) {
  const list = (Array.isArray(keywords) ? keywords : [keywords]).map(keyword => cleanText(keyword)).filter(Boolean);
  const seen = new Set();
  const parts = [];
  for (const keyword of list) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // 多词短语加引号：OpenAlex / Crossref 默认宽松词匹配，不加引号会把 "deep learning" 拆成两个词，
    // 召回噪声极大。已经带引号的不重复加。
    parts.push(/\s/.test(keyword) && !/^".*"$/.test(keyword) ? `"${keyword.replace(/"/g, '')}"` : keyword);
  }
  // yearFrom 不拼进检索串：年份过滤在 search 里用结构化参数（OpenAlex filter / 本地过滤）做，
  // 塞进字符串反而会让上游把年份当关键词。参数保留是为了调用方签名一致。
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// selfTest：用离线样例把四个解析器各跑一遍
// 出发点是原项目的教训——"先验检查本身"必须能被检查。样例是内置字符串，不发网络请求；
// 解析器改动把字段打坏时，selfTest 立刻会红，而不是等用户检索出一堆空标题。
// ---------------------------------------------------------------------------

const SAMPLE_OPENALEX = {
  results: [{
    id: 'https://openalex.org/W2741809807',
    doi: 'https://doi.org/10.1038/NATURE14539',
    title: 'Deep learning',
    display_name: 'Deep learning',
    publication_year: 2015,
    type: 'article',
    cited_by_count: 61995,
    primary_location: { landing_page_url: 'https://www.nature.com/articles/nature14539', source: { display_name: 'Nature' } },
    authorships: [{ author: { display_name: 'Yann LeCun' } }, { author: { display_name: 'Yoshua Bengio' } }, { author: { display_name: 'Geoffrey Hinton' } }],
    abstract_inverted_index: { Deep: [0], learning: [1], allows: [2], computational: [3], models: [4], composed: [5], of: [6], layers: [7] },
  }],
};

const SAMPLE_CROSSREF = {
  message: {
    items: [{
      DOI: '10.1038/NATURE14539',
      title: ['Deep learning'],
      author: [{ given: 'Yann', family: 'LeCun' }, { given: 'Yoshua', family: 'Bengio' }],
      issued: { 'date-parts': [[2015, 5, 28]] },
      'container-title': ['Nature'],
      type: 'journal-article',
      abstract: '<jats:p>Deep learning allows <jats:italic>computational</jats:italic> models composed of layers.</jats:p>',
      'is-referenced-by-count': 61995,
      URL: 'https://doi.org/10.1038/nature14539',
    }],
  },
};

const SAMPLE_ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <updated>2021-01-02T00:00:00Z</updated>
    <published>2021-01-01T00:00:00Z</published>
    <title>Scaling Laws for Neural Language Models</title>
    <summary>We study empirical scaling laws for language model performance
      on the cross-entropy loss.</summary>
    <arxiv:doi>10.48550/arXiv.2101.00001</arxiv:doi>
    <author><name>Jared Kaplan</name></author>
    <author><name>Sam McCandlish</name></author>
    <primary_category term="cs.LG"/>
  </entry>
</feed>`;

const SAMPLE_PUBMED = {
  result: {
    uids: ['26017442'],
    '26017442': {
      uid: '26017442',
      title: 'Deep learning.',
      pubdate: '2015 May 28',
      fulljournalname: 'Nature',
      source: 'Nature',
      authors: [{ name: 'LeCun Y' }, { name: 'Bengio Y' }],
      elocationid: 'doi: 10.1038/nature14539',
      pubtype: ['Journal Article'],
    },
  },
};

function selfTest() {
  const failures = [];
  const context = { query: 'self-test', retrievedAt: Date.now() };
  const check = (source, run) => { try { run(); } catch (error) { failures.push(`${source}: 解析抛出异常 ${error?.message || error}`); } };
  const expect = (source, label, condition) => { if (!condition) failures.push(`${source}: ${label}`); };

  check('openalex', () => {
    const [record] = parseOpenAlexWorks(SAMPLE_OPENALEX, context);
    expect('openalex', '没有解析出记录', !!record);
    if (!record) return;
    expect('openalex', '标题为空', record.title === 'Deep learning');
    expect('openalex', 'id 不是 openalex:W 形式', record.id === 'openalex:W2741809807');
    expect('openalex', '年份解析失败', record.year === 2015);
    expect('openalex', 'DOI 未归一化', record.doi === '10.1038/nature14539');
    expect('openalex', '作者未解析', record.authors.length === 3 && record.authors[0] === 'Yann LeCun');
    expect('openalex', '期刊名未解析', record.venue === 'Nature');
    expect('openalex', '倒排摘要未还原成句', record.abstract.startsWith('Deep learning allows computational models'));
    expect('openalex', '引用数未解析', record.citedBy === 61995);
  });

  check('crossref', () => {
    const [record] = parseCrossrefWorks(SAMPLE_CROSSREF, context);
    expect('crossref', '没有解析出记录', !!record);
    if (!record) return;
    expect('crossref', '标题为空', record.title === 'Deep learning');
    expect('crossref', '年份解析失败', record.year === 2015);
    expect('crossref', 'DOI 未归一化', record.doi === '10.1038/nature14539');
    expect('crossref', '作者未解析', record.authors[0] === 'Yann LeCun');
    expect('crossref', '期刊名未解析', record.venue === 'Nature');
    expect('crossref', 'JATS 摘要标签未去除', !/<\/?jats/i.test(record.abstract) && record.abstract.includes('computational models'));
  });

  check('arxiv', () => {
    const [record] = parseArxivAtom(SAMPLE_ARXIV, context);
    expect('arxiv', '没有解析出记录', !!record);
    if (!record) return;
    expect('arxiv', '标题为空', record.title === 'Scaling Laws for Neural Language Models');
    expect('arxiv', 'id 未去掉版本号', record.id === 'arxiv:2101.00001');
    expect('arxiv', '落地页不是 abs 页', record.url === 'https://arxiv.org/abs/2101.00001');
    expect('arxiv', '年份解析失败', record.year === 2021);
    expect('arxiv', '作者未解析', record.authors.length === 2 && record.authors[0] === 'Jared Kaplan');
    expect('arxiv', '摘要未做空白归一', record.abstract === 'We study empirical scaling laws for language model performance on the cross-entropy loss.');
    expect('arxiv', 'arXiv DOI 未解析', record.doi === '10.48550/arxiv.2101.00001');
  });

  check('pubmed', () => {
    const [record] = parsePubmedSummaries(SAMPLE_PUBMED, context);
    expect('pubmed', '没有解析出记录', !!record);
    if (!record) return;
    expect('pubmed', '标题为空', record.title === 'Deep learning.');
    expect('pubmed', 'id 不是 pubmed:PMID 形式', record.id === 'pubmed:26017442');
    expect('pubmed', '年份解析失败', record.year === 2015);
    expect('pubmed', 'DOI 未从 elocationid 解析', record.doi === '10.1038/nature14539');
    expect('pubmed', '作者未解析', record.authors[0] === 'LeCun Y');
    expect('pubmed', '期刊名未解析', record.venue === 'Nature');
  });

  check('doi', () => {
    expect('doi', 'DOI 归一化失败', normalizeDoi('https://doi.org/10.1038/ABC') === '10.1038/abc');
    expect('doi', '非 DOI 字符串未返回 null', normalizeDoi('not-a-doi') === null);
  });

  return { ok: failures.length === 0, failures };
}

module.exports = { SOURCES, DEFAULT_SOURCES, search, buildQuery, normalizeDoi, selfTest, resetBreaker };
