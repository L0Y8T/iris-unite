const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCES, DEFAULT_SOURCES, search, buildQuery, normalizeDoi, selfTest } = require('../core/retrieval.cjs');

// 全部离线：fetchImpl 注入假响应，任何一条用例都不许发真实网络请求。
const jsonResponse = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const textResponse = body => ({ ok: true, status: 200, text: async () => body });

const OPENALEX = {
  results: [{
    id: 'https://openalex.org/W2741809807',
    doi: 'https://doi.org/10.1038/NATURE14539',
    title: 'Deep learning',
    publication_year: 2015,
    type: 'article',
    cited_by_count: 61995,
    primary_location: { landing_page_url: 'https://www.nature.com/articles/nature14539', source: { display_name: 'Nature' } },
    authorships: [{ author: { display_name: 'Yann LeCun' } }, { author: { display_name: 'Yoshua Bengio' } }, { author: { display_name: 'Geoffrey Hinton' } }],
    // 倒排索引：开头的 Deep 在位置 0，句子能否成句全看这里有没有按位置填回。
    abstract_inverted_index: { Deep: [0], learning: [1], allows: [2], computational: [3], models: [4], composed: [5], of: [6], layers: [7] },
  }],
};

const CROSSREF = {
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

const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
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

const PUBMED_ESEARCH = { esearchresult: { idlist: ['26017442', '33000000'] } };
const PUBMED_ESUMMARY = {
  result: {
    uids: ['26017442', '33000000'],
    '26017442': { uid: '26017442', title: 'Deep learning.', pubdate: '2015 May 28', fulljournalname: 'Nature', authors: [{ name: 'LeCun Y' }, { name: 'Bengio Y' }], elocationid: 'doi: 10.1038/nature14539', pubtype: ['Journal Article'] },
    '33000000': { uid: '33000000', title: 'An early warning study.', pubdate: '2020 Nov', fulljournalname: 'Lancet', authors: [{ name: 'Chen N' }], articleids: [{ idtype: 'doi', value: '10.1016/S0140-6736(20)30183-5' }], pubtype: ['Journal Article'] },
  },
};

test('openalex: 题录字段齐全，倒排摘要按位置还原成句', async () => {
  const calls = [];
  const result = await search({
    query: 'deep learning',
    sources: ['openalex'],
    limit: 5,
    contact: 'me@example.org',
    fetchImpl: async (url) => { calls.push(url); return jsonResponse(OPENALEX); },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.id, 'openalex:W2741809807');
  assert.equal(record.source, 'openalex');
  assert.equal(record.title, 'Deep learning');
  assert.deepEqual(record.authors, ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton']);
  assert.equal(record.year, 2015);
  assert.equal(record.venue, 'Nature');
  assert.equal(record.doi, '10.1038/nature14539');
  assert.equal(record.url, 'https://www.nature.com/articles/nature14539');
  assert.equal(record.abstract, 'Deep learning allows computational models composed of layers');
  assert.equal(record.citedBy, 61995);
  assert.equal(record.type, 'article');
  assert.equal(record.query, 'deep learning');
  assert.equal(typeof record.retrievedAt, 'number');
  // 检索串编码正确，polite pool 的 mailto 也带上了。
  assert.match(calls[0], /search=deep%20learning/);
  assert.match(calls[0], /per-page=5/);
  assert.match(calls[0], /mailto=me%40example\.org/);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].source, 'openalex');
});

test('crossref: JATS 摘要去标签，年份取 issued 首段', async () => {
  const result = await search({ query: 'deep learning', sources: ['crossref'], fetchImpl: async () => jsonResponse(CROSSREF) });
  assert.equal(result.errors.length, 0);
  const [record] = result.records;
  assert.equal(record.source, 'crossref');
  assert.equal(record.title, 'Deep learning');
  assert.equal(record.year, 2015);
  assert.equal(record.doi, '10.1038/nature14539');
  assert.equal(record.venue, 'Nature');
  assert.deepEqual(record.authors, ['Yann LeCun', 'Yoshua Bengio']);
  assert.equal(record.abstract, 'Deep learning allows computational models composed of layers.');
  assert.ok(!/<\/?jats/i.test(record.abstract));
});

test('arxiv: Atom XML 手写解析，id 去版本号、落地页为 abs 页', async () => {
  const calls = [];
  const result = await search({ query: 'scaling laws', sources: ['arxiv'], fetchImpl: async (url) => { calls.push(url); return textResponse(ARXIV); } });
  assert.equal(result.errors.length, 0);
  const [record] = result.records;
  assert.equal(record.id, 'arxiv:2101.00001');
  assert.equal(record.title, 'Scaling Laws for Neural Language Models');
  assert.equal(record.year, 2021);
  assert.equal(record.venue, 'arXiv');
  assert.equal(record.url, 'https://arxiv.org/abs/2101.00001');
  assert.equal(record.doi, '10.48550/arxiv.2101.00001');
  assert.deepEqual(record.authors, ['Jared Kaplan', 'Sam McCandlish']);
  assert.equal(record.abstract, 'We study empirical scaling laws for language model performance on the cross-entropy loss.');
  assert.equal(record.citedBy, null);
  assert.match(calls[0], /search_query=all:/);
  assert.match(calls[0], /max_results=20/);
});

test('pubmed: esearch 拿 PMID、esummary 拿题录，DOI 从 elocationid 与 articleids 取', async () => {
  const calls = [];
  const result = await search({
    query: 'deep learning',
    sources: ['pubmed'],
    limit: 2,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('esearch.fcgi')) return jsonResponse(PUBMED_ESEARCH);
      if (url.includes('esummary.fcgi')) return jsonResponse(PUBMED_ESUMMARY);
      throw new Error(`未预期的地址 ${url}`);
    },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(calls.length, 2, '必须是 esearch + esummary 两步');
  assert.match(calls[0], /esearch\.fcgi\?db=pubmed&term=deep%20learning&retmax=2&retmode=json/);
  assert.match(calls[1], /esummary\.fcgi\?db=pubmed&id=26017442%2C33000000&retmode=json/);
  assert.equal(result.records.length, 2);
  const [first, second] = result.records;
  assert.equal(first.id, 'pubmed:26017442');
  assert.equal(first.title, 'Deep learning.');
  assert.equal(first.year, 2015);
  assert.equal(first.venue, 'Nature');
  assert.equal(first.doi, '10.1038/nature14539');
  assert.equal(first.abstract, '', 'esummary 没有摘要，必须留空而不是编造');
  assert.equal(first.url, 'https://pubmed.ncbi.nlm.nih.gov/26017442/');
  assert.equal(second.year, 2020);
  assert.equal(second.doi, '10.1016/s0140-6736(20)30183-5');
  assert.equal(result.queries.length, 2);
});

test('单源失败不影响其他源：抛错的源进 errors，正常的源照常返回', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('api.openalex.org')) throw new Error('boom');
    if (url.includes('api.crossref.org')) return jsonResponse(CROSSREF);
    throw new Error(`未预期的地址 ${url}`);
  };
  const result = await search({ query: 'deep learning', sources: ['openalex', 'crossref'], fetchImpl });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source, 'crossref');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'openalex');
  assert.match(result.errors[0].message, /boom/);
});

test('单源超时被隔离，不拖垮整次检索', async () => {
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    if (!url.includes('api.openalex.org')) return resolve(jsonResponse(CROSSREF));
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const result = await search({ query: 'deep learning', sources: ['openalex', 'crossref'], timeoutMs: 30, fetchImpl });
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'openalex');
  assert.match(result.errors[0].message, /超时/);
});

test('DOI 归一化：小写、去 https://doi.org/ 前缀、非 DOI 返回 null', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/ABC'), '10.1038/abc');
  assert.equal(normalizeDoi('http://dx.doi.org/10.1038/ABC'), '10.1038/abc');
  assert.equal(normalizeDoi('DOI: 10.1038/ABC'), '10.1038/abc');
  assert.equal(normalizeDoi('  10.1038/ABC  '), '10.1038/abc');
  assert.equal(normalizeDoi('not-a-doi'), null);
  assert.equal(normalizeDoi(''), null);
  assert.equal(normalizeDoi(null), null);
});

test('跨源同 DOI 去重：保留先到的记录并写 alsoFoundIn', async () => {
  const fetchImpl = async (url) => (url.includes('api.openalex.org') ? jsonResponse(OPENALEX) : jsonResponse(CROSSREF));
  const result = await search({ query: 'deep learning', sources: ['openalex', 'crossref'], fetchImpl });
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.source, 'openalex', '保留先到的源');
  assert.deepEqual(record.alsoFoundIn, ['crossref']);
  assert.equal(record.url, 'https://www.nature.com/articles/nature14539');
});

test('selfTest 纯离线自检必须通过', () => {
  const report = selfTest();
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
});

test('limit 硬上限 50：请求参数被夹到 50，返回记录也不超过 50', async () => {
  const many = { results: Array.from({ length: 60 }, (unused, index) => ({ id: `https://openalex.org/W${1000 + index}`, title: `paper ${index}`, publication_year: 2020, doi: `https://doi.org/10.1000/p${index}` })) };
  const calls = [];
  const result = await search({ query: 'x', sources: ['openalex'], limit: 1000, fetchImpl: async (url) => { calls.push(url); return jsonResponse(many); } });
  assert.match(calls[0], /per-page=50/);
  assert.ok(result.records.length <= 50);
  assert.equal(result.records.length, 50);
});

test('yearFrom 过滤掉更早的记录，年份为 null 的保留', async () => {
  const payload = { results: [
    { id: 'https://openalex.org/W1', title: 'old', publication_year: 1999, doi: 'https://doi.org/10.1000/old' },
    { id: 'https://openalex.org/W2', title: 'new', publication_year: 2020, doi: 'https://doi.org/10.1000/new' },
    { id: 'https://openalex.org/W3', title: 'unknown year', publication_year: null, doi: 'https://doi.org/10.1000/unknown' },
  ] };
  const calls = [];
  const result = await search({ query: 'x', sources: ['openalex'], yearFrom: 2010, fetchImpl: async (url) => { calls.push(url); return jsonResponse(payload); } });
  assert.deepEqual(result.records.map(record => record.title), ['new', 'unknown year']);
  assert.match(calls[0], /filter=from_publication_date:2010-01-01/);
});

test('未知源 id 进 errors，其余源正常检索；默认源与导出常量一致', async () => {
  assert.deepEqual(DEFAULT_SOURCES, ['openalex', 'crossref', 'arxiv', 'pubmed']);
  assert.deepEqual(SOURCES.map(source => source.id), DEFAULT_SOURCES);
  assert.ok(SOURCES.every(source => source.needsKey === false && source.home.startsWith('https://')));
  const result = await search({ query: 'x', sources: ['openalex', 'nonsense'], fetchImpl: async () => jsonResponse(OPENALEX) });
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'nonsense');
  assert.match(result.errors[0].message, /未知的文献源/);
});

test('空检索词直接拒绝，不发出任何请求', async () => {
  let called = false;
  await assert.rejects(search({ query: '   ', fetchImpl: async () => { called = true; return jsonResponse({}); } }), /检索词不能为空/);
  assert.equal(called, false);
  assert.equal(buildQuery({ keywords: ['deep learning', '  ', 'deep learning', 'BCI'], yearFrom: 2010 }), '"deep learning" BCI');
});

test('外部 signal 取消后整次检索报取消，不返回半截结果', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    search({ query: 'x', sources: ['openalex'], signal: controller.signal, fetchImpl: async (url, options) => {
      if (options.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return jsonResponse(OPENALEX);
    } }),
    /检索已取消/,
  );
});

test('坏源连续失败两次后本轮跳过它，不再拖慢后续检索', async () => {
  const { search, resetBreaker } = require('../core/retrieval.cjs');
  resetBreaker();
  const failing = async () => { throw new Error('请求超时（10ms）'); };
  const first = await search({ query: 'a', sources: ['arxiv'], limit: 3, fetchImpl: failing, breaker: true });
  const second = await search({ query: 'b', sources: ['arxiv'], limit: 3, fetchImpl: failing, breaker: true });
  assert.equal(first.errors.length, 1);
  assert.equal(second.errors.length, 1);
  const third = await search({ query: 'c', sources: ['arxiv'], limit: 3, fetchImpl: failing, breaker: true });
  assert.equal(third.records.length, 0);
  assert.match(third.errors[0].message, /跳过该源/);
  assert.match(third.errors[0].message, /连续失败 2 次/);
  resetBreaker();
});

test('熔断只影响坏源，其他源照常返回', async () => {
  const { search, resetBreaker } = require('../core/retrieval.cjs');
  resetBreaker();
  const failing = async (url) => {
    if (String(url).includes('arxiv.org')) throw new Error('请求超时（10ms）');
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => OPENALEX, text: async () => JSON.stringify(OPENALEX) };
  };
  for (let i = 0; i < 3; i++) await search({ query: 'q' + i, sources: ['arxiv', 'openalex'], limit: 3, fetchImpl: failing, breaker: true });
  const result = await search({ query: 'final', sources: ['arxiv', 'openalex'], limit: 3, fetchImpl: failing, breaker: true });
  assert.ok(result.records.length > 0, '熔断 arxiv 之后 openalex 仍应返回结果');
  assert.ok(result.errors.some(e => e.source === 'arxiv'));
  resetBreaker();
});
