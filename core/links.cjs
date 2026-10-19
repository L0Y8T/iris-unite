function externalURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('无效的链接');
  let url; try { url = new URL(value); } catch { throw new Error('无效的链接'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持网页链接');
  return url.href;
}
module.exports = { externalURL };
