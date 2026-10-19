'use strict';
/* 仓库卫生检查：挡住「临时脚本被 git add -A 顺手带上」这类事故。
 *
 * 来由：抓 CI 日志的 ci-log.cjs 曾在一次提交里混进仓库，它还会读本机 git 凭据
 * （虽然不含真实 token，但放进公开仓库是明显的错误）。这类文件不该靠人肉记得删。
 *
 *   node scripts/check-repo-hygiene.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const ROOT_FILES = new Set([
  '.gitattributes', '.gitignore', 'DESIGN.md', 'LICENSE', 'README.md',
  'main.cjs', 'preload.cjs', 'package.json', 'package-lock.json'
]);
const ROOT_DIRS = new Set(['.github', 'assets', 'core', 'docs', 'renderer', 'scripts', 'tests']);

/* 调试/一次性脚本的命名特征：命中了就必须在 tests/ 或 scripts/ 里，且要有正经用途。 */
const TEMP_SCRIPT = /^(patch-|fix-|audit-|bug-|check-|verify-|inspect-|peek|sanitize-|merge-|promote-|remove-|github-|ci[0-9-]|ci-log|ci-|tmp|temp)/i;
const SECRET_FILES = /\.(p12|pfx|pem|cer|crt|key|keystore|jks|mobileprovision|provisionprofile)$/i;
/* 真凭据形态：任何文本文件里出现都算问题。 */
const SECRET_CONTENT = [
  [/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, '私钥内容'],
  [/BEGIN CERTIFICATE/, '证书内容'],
  [/ghp_[A-Za-z0-9]{16,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9]{20,}/, 'API Key']
];

/* 只在代码文件里查：文档里提到某个调用名是正常的，代码里出现才是调试脚本残留。 */
const CODE_ONLY_RULES = [
  [/git credential fill/, '读取本机凭据的调用']
];
const CODE_FILE = /\.(cjs|js|mjs|py)$/i;

/* 扫到自己会必然误报：这个文件里写着要检测的模式字符串（BEGIN CERTIFICATE、git credential fill…）。
   本地能通过，是因为当时它还是个未追踪文件、不在 git ls-files 里；一旦提交，CI 上就会命中自己。 */
const SELF_FILE = 'scripts/check-repo-hygiene.cjs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') })
  .split('\n').map(line => line.trim()).filter(Boolean);

const problems = [];

for (const file of files) {
  const segments = file.split('/');
  const base = segments[segments.length - 1];
  /* 只检查工作区里真实存在的文件：已删除但还没提交的文件不算「留在仓库里」，
     提交之后 CI 的干净 checkout 也不会有它。 */
  if (!fs.existsSync(path.join(__dirname, '..', file))) continue;

  if (segments.length === 1) {
    if (!ROOT_FILES.has(file)) problems.push(`根目录出现不该有的文件：${file}`);
  } else if (!ROOT_DIRS.has(segments[0])) {
    problems.push(`顶层出现未知目录：${segments[0]}/（来自 ${file}）`);
  }

  /* 只有根目录才按“临时脚本”拦：tests/ 与 scripts/ 下的正式脚本允许这类前缀 */
  if (segments.length === 1 && file.endsWith('.cjs') && TEMP_SCRIPT.test(base) && !ROOT_FILES.has(file)) {
    problems.push(`根目录残留调试脚本：${file}`);
  }

  if (SECRET_FILES.test(file)) problems.push(`证书或密钥文件：${file}`);
}

for (const file of files) {
  if (file === SELF_FILE) continue;
  if (!/\.(cjs|js|mjs|json|md|yml|yaml|txt|html|css|py)$/i.test(file)) continue;
  /* 已被 git 追踪但工作区里删掉的文件（删除还没提交时）读不到，跳过内容扫描即可。 */
  const absolute = path.join(__dirname, '..', file);
  if (!fs.existsSync(absolute)) continue;
  const text = fs.readFileSync(absolute, 'utf8');
  for (const [re, why] of SECRET_CONTENT) {
    const hit = re.exec(text);
    if (hit) problems.push(`${file}: ${why} → ${JSON.stringify(hit[0].slice(0, 40))}`);
  }
  if (CODE_FILE.test(file)) {
    for (const [re, why] of CODE_ONLY_RULES) {
      const hit = re.exec(text);
      if (hit) problems.push(`${file}: ${why} → ${JSON.stringify(hit[0].slice(0, 40))}`);
    }
  }
}

if (problems.length) {
  console.error('仓库卫生检查未通过：');
  for (const problem of problems) console.error('  - ' + problem);
  process.exitCode = 1;
} else {
  console.log(`仓库卫生检查通过（${files.length} 个文件）：根目录只有白名单文件，无证书/凭据/调试脚本残留。`);
}
