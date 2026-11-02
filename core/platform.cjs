'use strict';

/**
 * 平台差异集中在这里，全部是纯函数，参数默认取当前进程。
 *
 * 为什么单独抽一层：这台机器只有 Windows，macOS / Linux 的分支没法真机验证。
 * 把路径与行为决策收进可注入 platform 的纯函数后，三个平台的分支都能在任意机器上跑单测，
 * 至少保证「不会因为写死 Windows 路径而在 mac 上直接崩」。真机体验仍需 CI 与使用者反馈。
 */

const os = require('node:os');
const path = require('node:path');

/**
 * 按「目标平台」拼路径，而不是按运行平台。
 * path.join 用运行平台的分隔符，拿它拼别的平台路径会得到 C:\Users\me/AppData/... 这种混合串——
 * 单测在 Linux 上校验 win32 分支时就会撞上这个坑。
 */
function targetJoin(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts.filter(part => part !== undefined && part !== null && part !== '').join(sep);
}

/**
 * Python 候选命令。
 * macOS 与多数 Linux 发行版只有 `python3`，没有 `python` 别名（macOS 的 python 甚至不存在）；
 * `py` 是 Windows 的启动器，其他平台没有。
 */
function pythonCandidates(platform = process.platform, env = process.env) {
  const explicit = env.IRIS_PYTHON;
  if (platform === 'win32') {
    return [explicit, 'python', 'python3', 'py']
      .filter(Boolean)
      .map(name => ({ command: name, prefix: name === 'py' ? ['-3'] : [] }));
  }
  return [explicit, 'python3', 'python'].filter(Boolean).map(name => ({ command: name, prefix: [] }));
}

function codexBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'codex.exe' : 'codex';
}

/** Codex CLI 的兜底搜索目录：PATH 没带上 npm 全局目录时（GUI 启动的进程尤其常见）还有这一步。 */
function codexRoots(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return [targetJoin(platform, home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')];
  return ['/usr/local/bin', '/opt/homebrew/bin', targetJoin(platform, home, '.npm-global', 'bin'), targetJoin(platform, home, '.local', 'bin')];
}

/** DSH Desktop 的安装位置：只在解它的 .zstd 会话日志时需要，缺失属于正常情况。 */
function dshInstallCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  if (env.DSH_INSTALL_DIR) return [env.DSH_INSTALL_DIR];
  if (platform === 'win32') return [targetJoin(platform, home, 'AppData', 'Local', 'Programs', 'DSH Desktop')];
  if (platform === 'darwin') return ['/Applications/DSH Desktop.app', targetJoin(platform, home, 'Applications', 'DSH Desktop.app')];
  return [targetJoin(platform, home, '.local', 'share', 'dsh-desktop'), '/opt/dsh-desktop', '/usr/lib/dsh-desktop'];
}

/** 图标按平台优先选：mac 只认 .icns，Linux 认 png，Windows 认 ico。 */
function iconCandidates(platform, assetsDir) {
  const named = name => path.join(assetsDir, name);
  if (platform === 'darwin') return [named('iris.icns'), named('iris.png'), named('iris.ico')];
  if (platform === 'win32') return [named('iris.ico'), named('iris.png'), named('iris.icns')];
  return [named('iris.png'), named('iris.ico'), named('iris.icns')];
}

/**
 * 窗口外观。
 * macOS 必须保留系统红绿灯（hiddenInset），否则自绘标题栏会把关闭/最小化按钮盖掉，用户关不掉窗口；
 * 其他平台继续用无边框自绘标题栏。
 */
function windowOptions(platform = process.platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } };
  return { frame: false };
}

/** mac 用 Cmd，其他平台用 Ctrl。 */
function primaryModifier(platform = process.platform) {
  return platform === 'darwin' ? 'metaKey' : 'ctrlKey';
}

/** 界面上显示的快捷键文案。 */
function shortcutLabel(platform = process.platform, key = 'N') {
  return platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`;
}

/** 关掉全部窗口后是否退出：mac 的惯例是留在 Dock，点图标再开。 */
function quitOnWindowClose(platform = process.platform) {
  return platform !== 'darwin';
}

/**
 * 是否需要应用菜单。mac 上如果没有 Edit 菜单，Cmd+C / Cmd+V / Cmd+Z 全部失效——
 * 这不是"少个菜单"的问题，是复制粘贴直接不能用。
 */
function needsApplicationMenu(platform = process.platform) {
  return platform === 'darwin';
}

/* ── 窗口尺寸自适应 ────────────────────────────────────────────────────
 *
 * 原来窗口写死 1380×920、最小 940×660。在 1366×768 的笔记本上，
 * 高度 920 比整块屏幕还高；在 150% 缩放的 1920×1080 上，工作区只有 1280×640（单位是 DIP），
 * 1380 宽直接超出屏幕。两头的症状一样：窗口一开就有一块在屏幕外，用户还得手动挪。
 *
 * 所以尺寸要按当前屏幕的工作区算，而不是按设计稿算。
 */

const PREFERRED_WINDOW = Object.freeze({ width: 1380, height: 920, minWidth: 940, minHeight: 660 });

/**
 * 按工作区把首选尺寸收进屏幕内。
 * 单位是 DIP（Electron 的 workArea 本来就是 DIP），所以在任何系统缩放下都成立。
 * 留出 margin 是为了窗口周围还能看见桌面、以及不被任务栏/任务切换边缘吸附。
 */
function fitWindowToScreen(workArea, preferred = PREFERRED_WINDOW, margin = 0.92) {
  const areaWidth = Math.max(320, Math.floor(Number(workArea?.width) || 0));
  const areaHeight = Math.max(240, Math.floor(Number(workArea?.height) || 0));
  const maxWidth = Math.max(320, Math.floor(areaWidth * margin));
  const maxHeight = Math.max(240, Math.floor(areaHeight * margin));
  /* 最小尺寸绝不能超过屏幕：一旦超过，窗口就再也缩不回屏幕内。减 24 给边框与阴影留余地。 */
  const minWidth = Math.max(320, Math.min(preferred.minWidth, areaWidth - 24));
  const minHeight = Math.max(240, Math.min(preferred.minHeight, areaHeight - 24));
  const width = Math.max(minWidth, Math.min(preferred.width, maxWidth));
  const height = Math.max(minHeight, Math.min(preferred.height, maxHeight));
  return { width, height, minWidth, minHeight };
}

/** 在工作区内居中。工作区原点可能是负的（副屏摆在主屏左边/上面）。 */
function centerWindowIn(workArea, size) {
  const x = Math.round((Number(workArea?.x) || 0) + Math.max(0, (Number(workArea?.width) || 0) - size.width) / 2);
  const y = Math.round((Number(workArea?.y) || 0) + Math.max(0, (Number(workArea?.height) || 0) - size.height) / 2);
  return { x, y };
}

/**
 * 决定这一次开窗用多大、放哪里。
 *
 * 优先级：上次的尺寸位置（若当前显示器仍在）> 主屏居中。
 * 判断"仍在"的条件是标题栏必须可见——哪怕只露出 80×24：
 * 换过显示器、拔掉副屏、改过缩放的机器上，上次保存的坐标会把窗口放到看不见的地方。
 */
function resolveWindowBounds({ displays = [], saved = null, preferred = PREFERRED_WINDOW, margin = 0.92 } = {}) {
  const usable = (Array.isArray(displays) ? displays : []).filter(d => d && d.workArea && d.workArea.width > 0);
  const primaryArea = usable[0]?.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const fitted = fitWindowToScreen(primaryArea, preferred, margin);

  if (saved && Number.isFinite(Number(saved.width)) && Number.isFinite(Number(saved.height))) {
    const wanted = { width: Math.round(Number(saved.width)), height: Math.round(Number(saved.height)) };
    const host = usable.find(d => {
      const a = d.workArea;
      const sx = Number(saved.x);
      const sy = Number(saved.y);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
      /* 标题栏区域（顶部 24px）必须落在工作区内，用户才抓得到窗口。 */
      const titleBarVisible = sx + 80 > a.x && sx < a.x + a.width && sy + 24 > a.y && sy < a.y + a.height;
      return titleBarVisible;
    });
    if (host) {
      const a = host.workArea;
      const limits = fitWindowToScreen(a, { ...preferred, width: wanted.width, height: wanted.height }, margin);
      const width = Math.max(limits.minWidth, Math.min(wanted.width, Math.floor(a.width * margin)));
      const height = Math.max(limits.minHeight, Math.min(wanted.height, Math.floor(a.height * margin)));
      const x = Math.round(Math.min(Math.max(Number(saved.x), a.x), a.x + a.width - width));
      const y = Math.round(Math.min(Math.max(Number(saved.y), a.y), a.y + a.height - height));
      return { ...limits, width, height, x, y, restored: true };
    }
  }

  return { ...fitted, ...centerWindowIn(primaryArea, fitted), restored: false };
}

/** 窗口尺寸值不值得记住：太小、太怪的一律丢弃，宁可回到默认。 */
function sanitizeWindowBounds(input) {
  if (!input || typeof input !== 'object') return null;
  const width = Math.round(Number(input.width));
  const height = Math.round(Number(input.height));
  const x = Math.round(Number(input.x));
  const y = Math.round(Number(input.y));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 320 || height < 240 || width > 8000 || height > 5000) return null;
  return {
    width, height,
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    maximized: input.maximized === true
  };
}

module.exports = {
  pythonCandidates,
  codexBinaryName,
  codexRoots,
  dshInstallCandidates,
  iconCandidates,
  windowOptions,
  primaryModifier,
  shortcutLabel,
  quitOnWindowClose,
  needsApplicationMenu,
  PREFERRED_WINDOW,
  fitWindowToScreen,
  centerWindowIn,
  resolveWindowBounds,
  sanitizeWindowBounds
};
