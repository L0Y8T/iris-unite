const fs = require('node:fs/promises');
const path = require('node:path');
const p = require('../core/providers.cjs');
(async () => {
  const report = {};
  for (const provider of ['deepseek', 'gpt']) {
    let output = '';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 65000);
    const args = { settings: { deepseekModel: 'deepseek-flash', deepseekEffort: 'low', gptModel: '', gptEffort: 'low' }, conversation: { messages: [{ role: 'user', text: '请只回复：Duet连接成功' }] }, signal: controller.signal, onText: chunk => { output += chunk; }, cwd: path.join(__dirname, '..') };
    try {
      if (provider === 'deepseek') await p.runDeepseek({ ...args, key: p.deepseekKey({ useDshKey: true }, () => '').key });
      else await p.runCodex(args);
      report[provider] = { ok: !!output.trim(), response: output.trim().slice(0, 80) };
    } catch (e) { report[provider] = { ok: false, error: e.message }; }
    finally { clearTimeout(timer); }
  }
  await fs.mkdir(path.join(__dirname, '../artifacts'), { recursive: true });
  await fs.writeFile(path.join(__dirname, '../artifacts/live-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})();
