const fs = require('node:fs/promises');
const path = require('node:path');
const h = require('../core/history.cjs');
(async () => {
  const parts = await Promise.all([h.listCodex(), h.listDsh()]);
  const report = { sources: { codex: parts[0].items.length, dsh: parts[1].items.length }, read: 0, messages: 0, empty: 0, errors: parts.flatMap(p => p.errors) };
  for (const item of parts.flatMap(p => p.items)) {
    try {
      const before = await fs.stat(item.file);
      const c = await h.readHistory(item);
      const after = await fs.stat(item.file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('文件在读取期间被原客户端更新');
      report.read++; report.messages += c.messages.length;
      if (!c.messages.length) report.empty++;
    } catch (e) { report.errors.push({ source: item.source, id: item.originalId, error: e.message }); }
  }
  await fs.mkdir(path.join(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.join(__dirname, '../artifacts/history-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})();
