/* 把构建产物发布到 GitHub Releases。
 *
 * 为什么单独写成脚本：发布是一次性动作，但会重复发生（每次出新版本）。写进仓库之后，
 * 「这一版到底传了什么」有据可查，也不用每次现敲一长串 curl。
 *
 * 用法：
 *   node scripts/publish-release.cjs --tag v1.2.0 --name "1.2.0 …" --notes-file docs/CHANGELOG-1.2.md \
 *        --asset "C:\path\IrisUnite-1.2.0-win32-x64.zip"
 *   node scripts/publish-release.cjs --tag v1.2.0 --list          # 只看现有 release 与资产
 *   node scripts/publish-release.cjs --tag v1.2.0 --dry-run ...    # 只打印要做什么
 *
 * 约定：
 *   - 令牌只从环境变量 GITHUB_TOKEN 读，读不到才退回 `git credential fill`（本机 GCM 存的那份）。
 *     令牌绝不打印、不写进日志、不进命令行参数（命令行参数会进 shell 历史与进程列表）。
 *   - 幂等：同名 release 已存在就复用；同名资产已存在就跳过，除非显式 --replace。
 *   - tag 必须已经存在。缺 tag 时脚本会失败而不是让 GitHub 在默认分支上凭空建一个——
 *     那种 tag 指向的源码和这个二进制根本对不上，是最糟的一种"看起来对"。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function parseArgs(argv) {
  const args = { assets: [] };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${key} 缺少参数`);
      return value;
    };
    if (key === '--tag') args.tag = next();
    else if (key === '--name') args.name = next();
    else if (key === '--notes') args.notes = next();
    else if (key === '--notes-file') args.notesFile = next();
    else if (key === '--asset') args.assets.push(next());
    else if (key === '--target') args.target = next();
    else if (key === '--replace') args.replace = true;
    else if (key === '--dry-run') args.dryRun = true;
    else if (key === '--list') args.list = true;
    else if (key === '--prerelease') args.prerelease = true;
    else throw new Error(`未知参数：${key}`);
  }
  return args;
}

/** 仓库坐标从 origin 的 URL 里取，避免脚本里写死 owner。 */
function repository() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const url = String(result.stdout || '').trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) throw new Error(`无法从 origin 解析仓库：${url || '(空)'}`);
  return { owner: match[1], repo: match[2] };
}

/**
 * 令牌：环境变量优先，否则问本机的 git 凭据管理器要。
 * 只在本进程里用，不打印、不落盘。
 */
function token() {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  /* git credential fill 的输入与输出都不进日志：只在本进程的管道里过一遍。 */
  const filled = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const line = String(filled.stdout || '').split(/\r?\n/).find(item => item.startsWith('password='));
  if (!line) throw new Error('没有可用令牌：请设置 GITHUB_TOKEN，或先在 git 里登录过 github.com');
  return line.slice('password='.length);
}

async function api(auth, method, url, body) {
  const response = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      Authorization: `token ${auth}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'iris-unite-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${url} 失败（${response.status}）：${json?.message || text.slice(0, 200)}`);
  return json;
}

async function findRelease(auth, owner, repo, tag) {
  try {
    return await api(auth, 'GET', `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (/失败（404）/.test(error.message)) return null;
    throw error;
  }
}

async function ensureTag(auth, owner, repo, tag) {
  try {
    await api(auth, 'GET', `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    return;
  } catch (error) {
    if (!/失败（404）/.test(error.message)) throw error;
  }
  const local = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { encoding: 'utf8' });
  if (local.status !== 0) throw new Error(`tag ${tag} 在本地和远端都不存在；先建好 tag 再发布，不要让 GitHub 在默认分支上凭空造一个`);
  const sha = String(local.stdout).trim();
  await api(auth, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  console.log(`已创建远端 tag ${tag} -> ${sha.slice(0, 7)}`);
}

/** 上传一个资产。文件用流而不是整块读进内存：单个包接近 1GB。 */
async function upload(auth, owner, repo, releaseId, file, { replace = false, existing = [] } = {}) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const previous = existing.find(asset => asset.name === name);
  if (previous && !replace) {
    console.log(`跳过（已存在）：${name}  ${(previous.size / 1048576).toFixed(0)} MB`);
    return previous;
  }
  if (previous && replace) await api(auth, 'DELETE', `/repos/${owner}/${repo}/releases/assets/${previous.id}`);
  const started = Date.now();
  console.log(`上传：${name}  ${(size / 1048576).toFixed(0)} MB …`);
  const response = await fetch(`${UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `token ${auth}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'iris-unite-publish',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size)
    },
    body: fs.createReadStream(file),
    duplex: 'half'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`上传 ${name} 失败（${response.status}）：${text.slice(0, 300)}`);
  const asset = JSON.parse(text);
  const seconds = (Date.now() - started) / 1000;
  console.log(`完成：${name}  ${(size / 1048576 / seconds).toFixed(1)} MB/s  用时 ${seconds.toFixed(0)}s`);
  return asset;
}

(async () => {
  const args = parseArgs(process.argv);
  const { owner, repo } = repository();
  const auth = token();

  if (args.list) {
    const releases = await api(auth, 'GET', `/repos/${owner}/${repo}/releases?per_page=20`);
    for (const release of releases) {
      console.log(`${release.tag_name.padEnd(24)} ${release.name || ''}`);
      for (const asset of release.assets) console.log(`    ${(asset.size / 1048576).toFixed(0).padStart(6)} MB  ${asset.name}`);
    }
    return;
  }

  if (!args.tag) throw new Error('缺少 --tag');
  const notes = args.notesFile ? fs.readFileSync(args.notesFile, 'utf8') : (args.notes || '');
  const assets = args.assets.map(file => {
    if (!fs.existsSync(file)) throw new Error(`资产不存在：${file}`);
    return file;
  });

  if (args.dryRun) {
    console.log(`[dry-run] 仓库 ${owner}/${repo}   tag ${args.tag}   资产 ${assets.length} 个`);
    for (const file of assets) console.log(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(0)} MB`);
    return;
  }

  await ensureTag(auth, owner, repo, args.tag);
  let release = await findRelease(auth, owner, repo, args.tag);
  if (!release) {
    release = await api(auth, 'POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: args.tag,
      name: args.name || args.tag,
      body: notes,
      prerelease: args.prerelease === true
    });
    console.log(`已创建 release ${args.tag}（id ${release.id}）`);
  } else {
    console.log(`复用已有 release ${args.tag}（id ${release.id}）`);
  }

  for (const file of assets) await upload(auth, owner, repo, release.id, file, { replace: args.replace, existing: release.assets });
  const final = await findRelease(auth, owner, repo, args.tag);
  const total = (final.assets || []).reduce((sum, asset) => sum + asset.size, 0);
  console.log(`\n${args.tag}：${(final.assets || []).length} 个资产，共 ${(total / 1048576).toFixed(0)} MB`);
  for (const asset of final.assets || []) console.log(`  ${(asset.size / 1048576).toFixed(0).padStart(6)} MB  ${asset.name}  ${asset.browser_download_url}`);
})().catch(error => { console.error('FAILED:', error.message); process.exitCode = 1; });
