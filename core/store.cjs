const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isCustomProvider } = require('./connections.cjs');
function validateModels(models) {
  if (!Array.isArray(models) || !models.length || models.length > 6 || models.some(m => !['deepseek', 'gpt'].includes(m) && !isCustomProvider(m))) throw new Error('至少使用一个模型，最多同时启用六个模型');
  return [...new Set(models)];
}
class Store {
  constructor(root) {
    this.root = root; fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, 'conversations.json');
    this.data = { version: 3, conversations: [], workspaces: [] };
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { throw new Error('本地记录无法读取，请保留 conversations.json 文件后检查，不会覆盖原记录。'); }
    }
    this.data.workspaces ||= [];
    this.data.version = 3;
    // Hide only the sample shipped with v0.1, preserving its data on disk.
    for (const c of this.data.conversations) if (c.messages[0]?.text === '功能验证（演示）：双模型桌面工作台' && c.messages.filter(m => m.role === 'assistant').every(m => m.demo)) c.archived = true;
    // Recover interrupted streams without claiming a completed answer.
    for (const c of this.data.conversations) for (const m of c.messages) if (m.status === 'streaming') {
      m.status = 'stopped'; m.error = '上次生成因应用关闭而中断。';
      if (m.collaboration) {
        Object.assign(m.collaboration, { status: 'stopped', stageLabel: '已中断', error: m.error, finishedAt: Date.now() });
        for (const a of m.collaboration.artifacts) if (a.status === 'running') Object.assign(a, { status: 'stopped', finishedAt: Date.now() });
      }
    }
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  list() { return this.data.conversations.filter(c => !c.archived).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id) { const c = this.data.conversations.find(c => c.id === id); if (!c) throw new Error('找不到这条对话'); return c; }
  create(options = {}) {
    const c = { id: randomUUID(), source: 'local', title: options.title || '新的对话', models: validateModels(options.models || ['deepseek', 'gpt']), createdAt: Date.now(), updatedAt: Date.now(), messages: [], ...options };
    c.models = validateModels(c.models);
    this.data.conversations.unshift(c); this.save(); return c;
  }
  updateModels(id, models) { const c = this.get(id); c.models = validateModels(models); this.save(); return c; }
  /** 删除一条本地对话。历史来源（DSH / Codex）不在此列，它们只读，不在本地库里。 */
  remove(id) {
    const index = this.data.conversations.findIndex(c => c.id === id);
    if (index < 0) throw new Error('找不到这条对话');
    const [removed] = this.data.conversations.splice(index, 1);
    this.save();
    return removed;
  }
  /** 会话关键词搜索：标题、工作区路径与正文都参与。 */
  search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const c of this.data.conversations) {
      if (c.archived) continue;
      const title = String(c.title || '').toLowerCase();
      const cwd = String(c.cwd || '').toLowerCase();
      let matched = title.includes(q) || cwd.includes(q) ? 'meta' : null;
      let snippet = '';
      if (!matched) {
        for (const m of c.messages) {
          const text = String(m.text || '');
          const at = text.toLowerCase().indexOf(q);
          if (at >= 0) {
            matched = 'body';
            const from = Math.max(0, at - 30);
            snippet = (from > 0 ? '…' : '') + text.slice(from, at + q.length + 40).replace(/\s+/g, ' ');
            break;
          }
        }
      }
      if (matched) hits.push({ id: c.id, title: c.title, matched, snippet });
    }
    return hits;
  }
}
module.exports = { Store, validateModels };
