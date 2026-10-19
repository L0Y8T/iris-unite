'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitations, audit, redact, selfTest, formatReference } = require('../core/citation.cjs');

const realRecord = { id: 'openalex:W2741809807', source: 'openalex', title: 'A verified paper', authors: ['A. Author', 'B. Author'], year: 2015, venue: 'Nature', doi: '10.1038/nature12373', url: 'https://doi.org/10.1038/nature12373', arxivId: null };
const textWithDoi = '该结构的稳定性已被独立验证（10.1038/nature12373）。';

// 检查器本身必须先自证可靠：这条失败时后面所有断言都不可信。
test('selfTest 自身必须通过，否则核验逻辑不可信', () => {
  const result = selfTest();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

// 1. 真实 DOI + 带该 DOI 的记录 -> 核验通过
test('真实 DOI 命中资料库时审计通过并指向具体记录', () => {
  const report = audit(textWithDoi, [realRecord]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { markers: 0, dois: 1, arxivIds: 0, suspicious: 0 });
  assert.equal(report.resolved.length, 1);
  assert.equal(report.resolved[0].raw, '10.1038/nature12373');
  assert.equal(report.resolved[0].kind, 'doi');
  assert.equal(report.resolved[0].recordId, realRecord.id);
  assert.equal(report.resolved[0].title, realRecord.title);
  assert.deepEqual(report.unresolved, []);
});

// 2. 同一段文本 + 空资料库 -> 必须判未通过，且未核验数量正确
test('同一段文本在空资料库下必须判为未核验', () => {
  const report = audit(textWithDoi, []);
  assert.equal(report.ok, false);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].reason, '该 DOI 不在本轮检索到的资料库中');
  assert.equal(report.stats.resolvedCount, 0);
  assert.equal(report.stats.unresolvedCount, 1);
});

// 3. [S1,S4] 必须拆成 2 个 marker，区间写法要展开；实验编号 [E12] 不归这里管
test('引用记号按逗号拆分、按区间展开；实验编号不被当成文献引用', () => {
  const { markers } = extractCitations('结论 [S1,S4] 与 [S1-S3] 以及 [E12]、[^3]。');
  assert.equal(markers.length, 3, '[E12] 属于实验运行编号，不能算文献引用');
  assert.deepEqual(markers[0].ids, ['S1', 'S4']);
  assert.equal(markers[0].kind, 'marker');
  assert.deepEqual(markers[1].ids, ['S1', 'S2', 'S3']);
  assert.equal(markers[2].key, '^3');
  assert.equal(markers.some(m => m.key === 'E12'), false, '实验编号必须留给数字门禁，否则会被删成未核实引用');
});

// 4. arXiv 号带 v2 后缀要归一
test('arXiv 号去掉版本号后再比对', () => {
  const text = '预印本见 arXiv:2101.00001v2 与 https://arxiv.org/abs/2101.00002v3。';
  const { arxivIds } = extractCitations(text);
  assert.deepEqual(arxivIds.map(a => a.id), ['2101.00001', '2101.00002']);
  const report = audit(text, [{ id: 'arxiv:2101.00001', source: 'arxiv', title: 'Preprint', arxivId: null }]);
  assert.equal(report.counts.arxivIds, 2);
  assert.equal(report.resolved.length, 1);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].raw.includes('2101.00002'), true);
  assert.match(report.unresolved[0].reason, /arXiv/);
});

// 5. 编造的 DOI 在空库下必须 unresolved
test('编造 DOI 在空库下必须未核验，混进真记录也不能蒙混过关', () => {
  const fake = '10.9999/fake.2024.001';
  assert.equal(audit(`引用 ${fake}`, []).ok, false);
  const report = audit(`真 ${'10.1038/nature12373'} 假 ${fake}`, [realRecord]);
  assert.equal(report.ok, false);
  assert.equal(report.stats.totalCitations, 2);
  assert.equal(report.stats.resolvedCount, 1);
  assert.equal(report.stats.unresolvedCount, 1);
  assert.equal(report.unresolved[0].raw, fake);
});

// 6. redact 必须移除未核验 DOI，并且幂等
test('redact 移除未核验 DOI，保留已核验引用，且幂等', () => {
  const text = `真实结果见 10.1038/nature12373，编造的见 10.9999/fake.2024.001。`;
  const report = audit(text, [realRecord]);
  const once = redact(text, report);
  assert.equal(once.text.includes('10.9999/fake.2024.001'), false);
  assert.equal(once.text.includes('10.1038/nature12373'), true);
  assert.equal(once.text.includes('〔未核实引用，已移除〕'), true);
  assert.deepEqual(once.removed, ['10.9999/fake.2024.001']);
  assert.deepEqual(once.kept, ['10.1038/nature12373']);
  assert.equal(once.note, '已移除 1 处无法核验的引用。');
  const twice = redact(once.text, report);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.removed, []);
});

// 7. 结尾带句点的 DOI 要能正确提取
test('结尾带句点的 DOI 不会把句点吃进去', () => {
  const { dois } = extractCitations('参考 10.1038/nature12373. 另见 10.1000/xyz.123）.');
  assert.deepEqual(dois.map(d => d.doi), ['10.1038/nature12373', '10.1000/xyz.123']);
  assert.deepEqual(dois.map(d => d.raw), ['10.1038/nature12373', '10.1000/xyz.123']);
  assert.equal(audit('10.1038/nature12373.', [realRecord]).ok, true);
});

// 8. formatReference 缺字段时不能吐 undefined / null
test('formatReference 规范输出且缺字段时省略片段', () => {
  const full = formatReference({ authors: ['张三', '李四', '王五', '赵六'], title: '标题', venue: '期刊', year: 2021, doi: '10.1000/abc' });
  assert.equal(full, '张三, 李四, 王五 等. 标题. 期刊, 2021. DOI: 10.1000/abc');
  const sparse = formatReference({ title: '只有标题' });
  assert.equal(sparse, '只有标题.');
  const empty = formatReference({});
  for (const value of [full, sparse, empty, formatReference(null), formatReference({ authors: [], year: null, doi: null })]) {
    assert.equal(/undefined|null|NaN/.test(value), false, `出现占位垃圾：${value}`);
  }
});

// 9. 1MB 文本不能崩、不能慢
test('1MB 文本在 2 秒内完成提取、审计与改写', () => {
  const units = ['研究结论如下，', '[S1]', '[S2,S5]', '10.1038/nature12373 ', 'arXiv:2101.00001v3 ', '(Smith et al., 2019) ', '见 https://example.org/x ', '（某某研究（2020）表明）', '[^4]', '[作者, 2019] ', '纯文本段落，没有引用。'];
  let seed = 123456789;
  let big = '';
  while (big.length < 1024 * 1024) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    big += units[seed % units.length];
  }
  big = big.slice(0, 1024 * 1024);
  const started = Date.now();
  const extracted = extractCitations(big);
  const report = audit(big, []);
  const redacted = redact(big, report);
  const elapsed = Date.now() - started;
  assert.ok(extracted.dois.length > 0);
  assert.ok(extracted.markers.length > 0);
  assert.ok(extracted.suspicious.length > 0);
  assert.equal(report.ok, false);
  assert.equal(redacted.text.includes('10.1038/nature12373'), false);
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms，超过 2 秒`);
});

// 10. audit 的 stats 计数正确
test('audit 的 counts 与 stats 计数自洽', () => {
  const text = '正文 [S1] 与 [S2,S3]，DOI 10.1038/nature12373，arXiv:2101.00001v2，另有 (Smith et al., 2019) 与 [作者, 2019]。';
  const records = [{ id: 'lib:1', source: 'openalex', key: 'S1', title: '键记录' }, { id: 'lib:2', source: 'openalex', title: 'DOI 记录', doi: 'https://doi.org/10.1038/NATURE12373' }];
  const report = audit(text, records);
  assert.deepEqual(report.counts, { markers: 2, dois: 1, arxivIds: 1, suspicious: 2 });
  assert.deepEqual(report.stats, { totalRecords: 2, totalCitations: 4, resolvedCount: 2, unresolvedCount: 2 });
  assert.equal(report.ok, false);
  assert.equal(report.stats.resolvedCount + report.stats.unresolvedCount, report.stats.totalCitations);
  assert.equal(report.resolved[0].recordId, 'lib:1');
  assert.match(report.unresolved[0].reason, /S2/);
  assert.deepEqual(audit('', []).stats, { totalRecords: 0, totalCitations: 0, resolvedCount: 0, unresolvedCount: 0 });
  assert.equal(audit('', []).ok, true);
});

// 补充：没有显式键时，位置型引用必须靠参考文献列表定位，否则一律未核验
test('位置型引用只能靠参考文献列表定位，且写法不掩埋假引用', () => {
  const withList = '结论成立 [S1]。\n\n## 参考文献\n[S1] 张三. 某研究综述. 2020.\n';
  const located = audit(withList, []);
  assert.equal(located.ok, true);
  assert.equal(located.resolved[0].recordId, 'reference:1');
  const withoutList = audit('结论成立 [S1]。', []);
  assert.equal(withoutList.ok, false);
  assert.equal(withoutList.unresolved[0].reason, '未找到对应的资料库键');
  const text = '假键 [S9] 与真键 [S1]。';
  const report = audit(text, [{ id: 'lib:1', key: 'S1', title: 't' }]);
  const redacted = redact(text, report);
  assert.equal(redacted.text.includes('[S9]'), false);
  assert.equal(redacted.text.includes('[S1]'), true);
  assert.equal(redacted.text.includes('〔未核实引用〕'), true);
});

// 补充：作者-年份式引用只统计、不参与核验，也不被改写
test('作者-年份式引用归为 suspicious 且不参与核验', () => {
  const text = '已有研究（Smith et al., 2019）与 [作者, 2019] 以及“某某研究（2020）表明”都只是说法。';
  const { suspicious, dois, markers } = extractCitations(text);
  assert.equal(suspicious.length, 3);
  assert.ok(suspicious.every(s => s.kind === 'suspicious' && s.reason.length > 0));
  assert.deepEqual(dois, []);
  assert.deepEqual(markers, []);
  const report = audit(text, []);
  assert.equal(report.counts.suspicious, 3);
  assert.equal(report.ok, true);
  assert.equal(redact(text, report).text, text);
});

// 补充：空文本、非字符串输入不能崩
test('空输入与非字符串输入按空文本处理', () => {
  assert.deepEqual(extractCitations(''), { markers: [], dois: [], arxivIds: [], suspicious: [] });
  assert.deepEqual(extractCitations(undefined), { markers: [], dois: [], arxivIds: [], suspicious: [] });
  assert.equal(audit(null, null).ok, true);
  assert.deepEqual(redact(null, null), { text: '', removed: [], kept: [], note: '没有需要移除的未核验引用。' });
  assert.equal(formatReference(undefined), '');
});
