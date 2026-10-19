const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CODEX_HOME, DSH_HOME } = require('./history.cjs');
const UNASSIGNED = 'unassigned';
const canonical = value => path.win32.normalize(String(value)).replace(/\\+$/, '').toLowerCase();
const workspaceId = value => 'ws:' + createHash('sha256').update(canonical(value)).digest('hex').slice(0, 20);
function readOptional(file, errors) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') errors.push(`工作区记录无法读取：${path.basename(file)}`); return {}; }
}
function loadWorkspaceCatalog(conversations, custom = [], options = {}) {
  const errors = [], workspaces = [], byPath = new Map(), native = new Map(), membership = new Map();
  const codex = readOptional(path.join(options.codexHome || CODEX_HOME, '.codex-global-state.json'), errors);
  const dsh = readOptional(path.join(options.dshHome || DSH_HOME, 'storages/workspace.json'), errors);
  function add(folder, name, source, roots = [folder]) {
    if (!folder || !path.win32.isAbsolute(folder)) return null;
    const key = canonical(folder);
    let w = byPath.get(key);
    if (!w) {
      w = { id: workspaceId(folder), name: name || path.win32.basename(folder) || folder, path: folder, roots: [], sources: [], conversationCount: 0, available: fs.existsSync(folder) };
      workspaces.push(w); byPath.set(key, w);
    }
    for (const root of roots) if (typeof root === 'string' && !w.roots.some(r => canonical(r) === canonical(root))) w.roots.push(root);
    if (!w.sources.includes(source)) w.sources.push(source);
    return w;
  }
  const projects = codex['local-projects'] || {};
  for (const id of [...new Set([...(codex['project-order'] || []), ...Object.keys(projects)])]) {
    const p = projects[id]; if (!p) continue;
    const roots = (p.rootPaths || []).filter(r => typeof r === 'string' && path.win32.isAbsolute(r));
    const w = add(roots[0], p.name, 'Codex', roots); if (w) native.set(`codex:${id}`, w.id);
  }
  for (const [id, assignment] of Object.entries(codex['thread-project-assignments'] || {})) {
    const w = native.get(`codex:${assignment.projectId}`); if (w) membership.set(`codex:${id}`, w);
  }
  const ungrouped = new Set((codex['projectless-thread-ids'] || []).map(id => `codex:${id}`));
  const dshWorkspaces = dsh.tables?.workspaces || {};
  for (const id of [...new Set([...(dsh.global?.workspaceIds || []), ...Object.keys(dshWorkspaces)])]) {
    const p = dshWorkspaces[id]; if (!p) continue;
    const w = add(p.path, p.title, 'DSH'); if (w) for (const sessionId of p.sessionIds || []) membership.set(`dsh:${sessionId}`, w.id);
  }
  for (const item of custom) add(item.path, item.name, 'Iris Unite');
  const assignments = {};
  for (const c of conversations) {
    const original = c.importedFrom ? `${c.importedFrom.source}:${c.importedFrom.id}` : c.id;
    let assigned = workspaces.some(w => w.id === c.workspaceId) ? c.workspaceId : membership.get(original);
    if (!assigned && !ungrouped.has(original) && c.cwd) {
      const cwd = canonical(c.cwd);
      const matching = workspaces.flatMap(w => w.roots.map(root => ({ w, root: canonical(root) }))).filter(x => cwd === x.root || cwd.startsWith(x.root + '\\')).sort((a, b) => b.root.length - a.root.length);
      assigned = matching[0]?.w.id;
      if (!assigned) assigned = add(c.cwd, '', '会话目录')?.id;
    }
    assignments[c.id] = assigned || UNASSIGNED;
    const w = workspaces.find(w => w.id === assigned); if (w) w.conversationCount++;
  }
  workspaces.push({ id: UNASSIGNED, name: '未分组', path: '', roots: [], sources: [], available: true, conversationCount: Object.values(assignments).filter(id => id === UNASSIGNED).length });
  return { workspaces, assignments, errors };
}
module.exports = { canonical, workspaceId, loadWorkspaceCatalog, UNASSIGNED };
