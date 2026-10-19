'use strict';
/* 一轮结构化找 bug：语法、IPC 一致性、DOM id 一致性、未使用导出、残留调试代码。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith(ext));

const problems = [];
const info = {};

/* ── 1) 语法检查：所有 .cjs / .js ─────────────────────────────────────── */
const jsFiles = [];
(function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', 'build', 'release', 'dist', 'artifacts', 'backups', '.test-data', '.verification-profile'].includes(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
    else if (/\.(cjs|js)$/.test(entry.name) && !relPath.startsWith('renderer/vendor/')) jsFiles.push(relPath);
  }
})('.');

for (const file of jsFiles) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }); }
  catch (error) { problems.push(`语法错误 ${file}: ${String(error.stderr || error.message).split('\n')[0]}`); }
}
info.checkedJs = jsFiles.length;

/* ── 2) IPC 一致性：主进程 register 的通道 vs preload invoke 的通道 ────── */
const main = read('main.cjs');
const preload = read('preload.cjs');
const registered = new Set([...main.matchAll(/register\(\s*'([^']+)'/g)].map(m => m[1]));
const ipcMainHandlers = new Set([...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]));
const invoked = new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]));
const allRegistered = new Set([...registered, ...ipcMainHandlers]);
info.ipc = { registered: allRegistered.size, invoked: invoked.size };
for (const channel of invoked) if (!allRegistered.has(channel)) problems.push(`preload 调用了主进程没注册的通道：${channel}`);
for (const channel of allRegistered) if (!invoked.has(channel) && !main.includes(`send('${channel}'`)) problems.push(`主进程注册了没人用的通道：${channel}`);

/* ── 3) DOM id 一致性：JS 里 $('#x') 的 x 必须在 index.html 里存在 ─────── */
const html = read('renderer/index.html');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const rendererJs = ['renderer/app.js', 'renderer/iris-ui.js', 'renderer/exec-ui.js', 'renderer/theme.js'].map(read).join('\n');
const usedIds = new Set([...rendererJs.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)].map(m => m[1]));
for (const id of usedIds) if (!htmlIds.has(id)) problems.push(`JS 里 $('#${id}') 在 index.html 中不存在`);
info.dom = { htmlIds: htmlIds.size, usedIds: usedIds.size };

/* ── 4) core 模块导出 vs 引用 ─────────────────────────────────────────── */
for (const file of list('core', '.cjs').concat(list('core/exec', '.cjs').map(f => `exec/${f}`))) {
  const rel = `core/${file}`;
  const text = read(rel);
  if (!/module\.exports/.test(text)) { problems.push(`${rel} 没有 module.exports`); continue; }
  const exported = new Set([...text.matchAll(/^\s{2}([A-Za-z_$][\w$]*),?\s*$/gm)].map(m => m[1]));
  const destructured = [...text.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\};?\s*$/gm)].map(m => m[1]).join(',');
  const names = new Set((destructured.match(/[A-Za-z_$][\w$]*/g) || []));
  if (!names.size) problems.push(`${rel} 的导出看起来是空的`);
  void exported;
}

/* ── 5) 残留调试代码 ──────────────────────────────────────────────────── */
for (const file of jsFiles) {
  if (file.startsWith('tests/') || file.startsWith('scripts/')) continue;
  const text = read(file);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/console\.log\(/.test(line) && !/IRIS_DEBUG|debug/.test(line)) problems.push(`${file}:${index + 1} 生产代码里有 console.log`);
    if (/\bFIXME\b|\bXXX\b|HACK/.test(line)) problems.push(`${file}:${index + 1} 遗留标记：${line.trim().slice(0, 80)}`);
  });
}

/* ── 6) package.json 里的脚本引用的文件是否存在 ───────────────────────── */
const pkg = JSON.parse(read('package.json'));
for (const [name, command] of Object.entries(pkg.scripts || {})) {
  for (const m of command.matchAll(/node\s+(?:--test\s+)?([\w./-]+\.(?:cjs|mjs|js))/g)) {
    if (!fs.existsSync(path.join(root, m[1]))) problems.push(`npm run ${name} 引用了不存在的文件：${m[1]}`);
  }
  for (const m of command.matchAll(/electron\s+([\w./-]+\.(?:cjs|mjs|js))/g)) {
    if (!fs.existsSync(path.join(root, m[1]))) problems.push(`npm run ${name} 引用了不存在的文件：${m[1]}`);
  }
}

/* ── 7) 主进程 require 的文件是否存在 ─────────────────────────────────── */
for (const m of main.matchAll(/require\('(\.\/[^']+)'\)/g)) {
  if (!fs.existsSync(path.join(root, m[1]))) problems.push(`main.cjs 引用不存在的文件：${m[1]}`);
}
for (const m of preload.matchAll(/require\('(\.\/[^']+)'\)/g)) {
  if (!fs.existsSync(path.join(root, m[1]))) problems.push(`preload.cjs 引用不存在的文件：${m[1]}`);
}

console.log(JSON.stringify({ info, problems }, null, 1));
