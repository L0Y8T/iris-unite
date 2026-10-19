const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const platform = require('./platform.cjs');

/**
 * DSH Desktop 的安装目录：只在解压 .zstd 会话日志时需要（要借用它自带的解码器）。
 * 这是可选能力——路径不存在时读取会失败，调用方要按「读不到」处理，不能让整个启动失败。
 * 具体候选路径见 core/platform.cjs。
 */
const DSH_INSTALL = platform.dshInstallCandidates()[0];
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
/** DSH 只读历史是否可用：home 里有东西才算，避免在没装过 DSH 的机器上白跑一遍目录遍历。 */
async function dshAvailable(home = DSH_HOME) {
  try { await fs.access(home); return true; } catch { return false; }
}
async function walk(root, accept) {
  const result = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && accept(entry.name)) result.push(file);
    }
  }
  await visit(root);
  return result;
}
function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(x => ['text', 'input_text', 'output_text'].includes(x.type)).map(x => x.text || '').join('\n');
}
function isUserContent(text) {
  return text.trim() && !/^\s*(?:<environment_context>|<external_codex_apps_open_page>|<turn_aborted>|# AGENTS\.md instructions|<permissions instructions>)/.test(text);
}
function parseCodex(lines, file, title) {
  let meta = {}, model = '';
  const structured = [], legacy = [], response = [];
  const seen = new Set();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    if (row.type === 'session_meta') meta = p;
    if (row.type === 'turn_context' && p.model) model = p.model;
    if (row.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item || {};
      const kind = (item.type || '').toLowerCase();
      if (kind !== 'usermessage' && kind !== 'agentmessage') continue;
      const role = kind === 'usermessage' ? 'user' : 'assistant';
      const text = item.text || textOf(item.content);
      if (!text.trim() || (role === 'user' && !isUserContent(text))) continue;
      const id = item.id || `${row.timestamp}-${structured.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      structured.push({ id, role, text, provider: role === 'assistant' ? 'gpt' : undefined, timestamp: row.timestamp, model });
    }
    if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)) {
      const role = p.type === 'user_message' ? 'user' : 'assistant';
      if (role === 'user' && !isUserContent(p.message || '')) continue;
      legacy.push({ id: `${row.timestamp}-${legacy.length}`, role, text: p.message || '', provider: role === 'assistant' ? 'gpt' : undefined, timestamp: row.timestamp, model });
    }
    if (row.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const text = textOf(p.content);
      if (!text.trim() || (p.role === 'user' && !isUserContent(text))) continue;
      response.push({ id: p.id || `${row.timestamp}-${response.length}`, role: p.role, text, provider: p.role === 'assistant' ? 'gpt' : undefined, timestamp: row.timestamp, model });
    }
  }
  const messages = structured.length ? structured : legacy.length ? legacy : response;
  const id = meta.id || meta.session_id || path.basename(file, '.jsonl');
  return { id: `codex:${id}`, source: 'codex', originalId: id, file, title: title || messages.find(m => m.role === 'user')?.text.replace(/\s+/g, ' ').slice(0, 48) || 'Codex 对话', cwd: meta.cwd || '', createdAt: Date.parse(meta.timestamp) || Date.now(), updatedAt: Date.parse(messages.at(-1)?.timestamp) || Date.parse(meta.timestamp) || Date.now(), models: ['gpt'], messages, model, child: !!(meta.source && typeof meta.source === 'object' && meta.source.subagent) };
}
async function codexTitles(home) {
  const result = new Map();
  try {
    for (const line of (await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8')).split('\n')) {
      try { const x = JSON.parse(line); result.set(x.id, x.thread_name || x.title); } catch { /* torn append */ }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return result;
}
async function listCodex(home = CODEX_HOME) {
  const titles = await codexTitles(home);
  const files = await walk(path.join(home, 'sessions'), n => n.endsWith('.jsonl'));
  const items = [], errors = [];
  for (const file of files) {
    try {
      const parsed = parseCodex((await fs.readFile(file, 'utf8')).split('\n'), file);
      if (parsed.child) continue;
      parsed.title = titles.get(parsed.originalId) || parsed.title;
      parsed.updatedAt = (await fs.stat(file)).mtimeMs;
      parsed.messageCount = parsed.messages.length;
      delete parsed.messages;
      items.push(parsed);
    } catch (e) { errors.push(`Codex: ${path.basename(file)} (${e.code || e.message})`); }
  }
  return { items, errors };
}
async function listDsh(home = DSH_HOME) {
  const cache = path.join(home, 'storages/session_projcache/sessions');
  const files = await walk(path.join(home, 'sessions'), n => /\.jsonl(?:\.zstd)?$/.test(n));
  const items = [], errors = [];
  for (const file of files) {
    try {
      let id = path.basename(path.dirname(file));
      if (id.startsWith('--')) id = path.basename(file).replace(/\.jsonl(?:\.zstd)?$/, '');
      let record = {};
      try { record = JSON.parse(await fs.readFile(path.join(cache, id + '.json'), 'utf8')).record || {}; }
      catch (e) { if (e.code !== 'ENOENT') errors.push(`DSH 缓存 ${id}: ${e.code || '无法读取'}`); }
      const rows = record.rows || {};
      if (record.identity?.parentSession || rows.subagent?.val?.descriptor || rows.subagentTiming?.val?.descriptorSeen) continue;
      const stat = await fs.stat(file);
      const model = rows.modelSelection?.val?.lastUsed?.model;
      items.push({ id: `dsh:${id}`, originalId: id, source: 'dsh', file, title: rows.title?.val || rows.titleInput?.val?.first?.text?.slice(0, 48) || `DeepSeek 对话 ${id.replace(/^session-/, '').slice(0, 8)}`, cwd: record.identity?.cwd || '', createdAt: record.identity?.createdAt || stat.birthtimeMs, updatedAt: rows.sessionListMetadata?.val?.lastPromptAt || stat.mtimeMs, models: ['deepseek'], model });
    } catch (e) { errors.push(`DSH: ${path.basename(file)} (${e.code || e.message})`); }
  }
  return { items, errors };
}
let decoderModule;
async function readDsh(item, install = DSH_INSTALL) {
  const buffer = await fs.readFile(item.file);
  let events, meta;
  if (item.file.endsWith('.zstd')) {
    decoderModule ||= import(pathToFileURL(path.join(install, 'resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href);
    const { JsonlSessionPersistence } = await decoderModule;
    // Pure decoder of the installed version. No services, coordinators,
    // repair or append methods are constructed or called.
    const reader = Object.create(JsonlSessionPersistence.prototype);
    const decoded = await reader.readZstdPrefix(buffer);
    events = decoded.events; meta = decoded.meta;
  } else {
    const lines = buffer.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    meta = lines.shift(); events = lines;
  }
  const messages = [];
  for (const event of events) {
    if (!['user/message', 'assistant/message'].includes(event.type)) continue;
    const message = event.type === 'user/message' ? (event.data?.message || event.data || {}) : (event.data?.message || {});
    const role = event.type === 'user/message' ? 'user' : 'assistant';
    if (role === 'user' && message.source?.kind && message.source.kind !== 'user') continue;
    const text = textOf(message.content);
    if (text.trim()) messages.push({ id: message.id || String(event.seq), role, text, provider: role === 'assistant' ? 'deepseek' : undefined, timestamp: event.time || event.timestamp || message.createdAt || meta.createdAt, model: item.model });
  }
  return { ...item, cwd: meta.cwd || item.cwd, messages };
}
async function readHistory(item) {
  if (item.source === 'dsh') return readDsh(item);
  return parseCodex((await fs.readFile(item.file, 'utf8')).split('\n'), item.file, item.title);
}
module.exports = { listCodex, listDsh, readHistory, readDsh, parseCodex, textOf, dshAvailable, DSH_INSTALL, DSH_HOME, CODEX_HOME };
