'use strict';
/* 端到端验证：全新克隆 + 装依赖 + 跑测试，模拟第一次用这个仓库的人。
   npm ci 会下载 Electron（约 200 MB），所以整段比较慢。 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = path.join(os.tmpdir(), `iris-fresh-${Date.now()}`);
const step = (name, command, args, options = {}) => {
  const began = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || target,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 900000,
    env: { ...process.env, ...(options.env || {}) }
  });
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  const ok = result.status === 0;
  const tail = `${result.stdout || ''}${result.stderr || ''}`.split('\n').filter(Boolean).slice(-6).join('\n');
  console.log(`${ok ? '✔' : '✘'} ${name}  (${seconds}s)`);
  if (!ok) console.log(tail);
  return { ok, seconds: Number(seconds), tail };
};

const results = {};

results.clone = step('全新克隆', 'git', ['clone', '--depth', '1', 'https://github.com/L0Y8T/iris-unite.git', target], { cwd: os.tmpdir() });
if (!results.clone.ok) { console.log(JSON.stringify({ passed: false, results }, null, 1)); process.exit(1); }

const files = [];
(function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
    else files.push(relPath);
  }
})(target);
results.fileCount = files.length;

results.install = step('安装依赖 npm ci', 'npm', ['ci'], { timeout: 900000 });
results.hygiene = step('仓库卫生检查', 'node', ['scripts/check-repo-hygiene.cjs']);
results.unit = step('单元测试 npm test', 'npm', ['test'], { timeout: 900000 });
results.platform = step('平台分支检查', 'node', ['--test', 'tests/platform.test.cjs']);

/* 关键文件是否都在 */
const must = ['main.cjs', 'preload.cjs', 'package.json', 'LICENSE', 'README.md', '.gitignore', '.gitattributes',
  '.github/workflows/ci.yml', 'assets/iris.ico', 'assets/iris.icns', 'assets/iris.png',
  'core/platform.cjs', 'core/export.cjs', 'core/pricing.cjs', 'scripts/check-repo-hygiene.cjs'];
results.missing = must.filter(file => !files.includes(file));
results.forbidden = files.filter(file => /^(build|release|dist|node_modules|\.test-data|\.verification-profile|artifacts)\//.test(file) || /ci-log\.cjs$/.test(file));

const allOk = Object.values(results).every(value => !value || typeof value !== 'object' || value.ok !== false)
  && results.missing.length === 0 && results.forbidden.length === 0;

console.log('\n' + JSON.stringify({
  passed: allOk,
  cloneDir: target,
  fileCount: results.fileCount,
  steps: Object.fromEntries(Object.entries(results).filter(([, v]) => v && typeof v === 'object' && 'ok' in v).map(([k, v]) => [k, { ok: v.ok, seconds: v.seconds }])),
  missing: results.missing,
  forbidden: results.forbidden
}, null, 1));
