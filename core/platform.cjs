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
  if (platform === 'win32') return [path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')];
  return [path.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin')];
}

/** DSH Desktop 的安装位置：只在解它的 .zstd 会话日志时需要，缺失属于正常情况。 */
function dshInstallCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  if (env.DSH_INSTALL_DIR) return [env.DSH_INSTALL_DIR];
  if (platform === 'win32') return [path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop')];
  if (platform === 'darwin') return ['/Applications/DSH Desktop.app', path.join(home, 'Applications', 'DSH Desktop.app')];
  return [path.join(home, '.local', 'share', 'dsh-desktop'), '/opt/dsh-desktop', '/usr/lib/dsh-desktop'];
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
  needsApplicationMenu
};
