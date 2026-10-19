/* 平台差异的验收：三平台的分支都能在这台机器上跑。
 *
 * 这里不验证「在 mac 上长得对不对」——那要真机。验证的是更要紧的一件事：
 * 代码里有没有还在写死 Windows 路径、写死 Ctrl、写死 .ico 的地方。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../core/platform.cjs');

test('Python 候选：Windows 有 py 启动器，mac/Linux 先试 python3', () => {
  const win = platform.pythonCandidates('win32', {}).map(item => item.command);
  assert.deepEqual(win, ['python', 'python3', 'py']);
  assert.deepEqual(platform.pythonCandidates('win32', {}).find(item => item.command === 'py').prefix, ['-3']);

  for (const id of ['darwin', 'linux']) {
    const list = platform.pythonCandidates(id, {}).map(item => item.command);
    assert.deepEqual(list, ['python3', 'python'], `${id} 上应该先试 python3`);
    assert.ok(!list.includes('py'), `${id} 上没有 py 启动器`);
    assert.ok(platform.pythonCandidates(id, {}).every(item => item.prefix.length === 0));
  }
});

test('Python 候选：IRIS_PYTHON 优先，空字符串不会变成候选', () => {
  const withEnv = platform.pythonCandidates('darwin', { IRIS_PYTHON: '/opt/homebrew/bin/python3.12' });
  assert.equal(withEnv[0].command, '/opt/homebrew/bin/python3.12');
  assert.ok(platform.pythonCandidates('linux', { IRIS_PYTHON: '' }).every(item => item.command));
});

test('Codex 兜底目录按平台走，不出现 AppData', () => {
  const home = '/Users/me';
  const mac = platform.codexRoots('darwin', home);
  const linux = platform.codexRoots('linux', home);
  const win = platform.codexRoots('win32', 'C:\\Users\\me');
  for (const list of [mac, linux]) {
    assert.ok(list.every(item => !item.includes('AppData')), `非 Windows 平台不该有 AppData：${JSON.stringify(list)}`);
    assert.ok(list.some(item => item.includes('.npm-global')), '应该覆盖 npm 全局目录');
  }
  assert.ok(mac.includes('/opt/homebrew/bin'), 'Apple Silicon 的 brew 目录要覆盖');
  assert.ok(win.every(item => item.includes('AppData')), 'Windows 路径保持原样');
  assert.equal(platform.codexBinaryName('win32'), 'codex.exe');
  assert.equal(platform.codexBinaryName('darwin'), 'codex');
});

test('DSH 安装目录：三平台各自合理，且能被子环境变量覆盖', () => {
  assert.ok(platform.dshInstallCandidates('darwin', '/Users/me', {}).includes('/Applications/DSH Desktop.app'));
  assert.ok(!platform.dshInstallCandidates('linux', '/home/me', {}).some(item => item.includes('AppData')));
  assert.deepEqual(platform.dshInstallCandidates('win32', 'C:\\Users\\me', {}), ['C:\\Users\\me\\AppData\\Local\\Programs\\DSH Desktop']);
  assert.deepEqual(platform.dshInstallCandidates('linux', '/home/me', { DSH_INSTALL_DIR: '/srv/dsh' }), ['/srv/dsh']);
});

test('图标：mac 先找 icns，Linux 先找 png，Windows 先找 ico', () => {
  const assets = '/app/assets';
  assert.ok(platform.iconCandidates('darwin', assets)[0].endsWith('iris.icns'));
  assert.ok(platform.iconCandidates('linux', assets)[0].endsWith('iris.png'));
  assert.ok(platform.iconCandidates('win32', assets)[0].endsWith('iris.ico'));
  /* 三个候选都要给全：某个格式缺失时还能退到下一个，不至于没图标 */
  for (const id of ['darwin', 'linux', 'win32']) assert.equal(platform.iconCandidates(id, assets).length, 3);
});

test('窗口：mac 保留红绿灯，其他平台无边框自绘', () => {
  const mac = platform.windowOptions('darwin');
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 15 });
  assert.equal(mac.frame, undefined, 'mac 不能把 frame 设成 false，否则红绿灯会消失');
  for (const id of ['win32', 'linux']) {
    assert.deepEqual(platform.windowOptions(id), { frame: false });
  }
});

test('快捷键：mac 用 Cmd，其余用 Ctrl', () => {
  assert.equal(platform.primaryModifier('darwin'), 'metaKey');
  assert.equal(platform.primaryModifier('win32'), 'ctrlKey');
  assert.equal(platform.primaryModifier('linux'), 'ctrlKey');
  assert.equal(platform.shortcutLabel('darwin', 'N'), '⌘N');
  assert.equal(platform.shortcutLabel('win32', 'N'), 'Ctrl+N');
});

test('关闭窗口与菜单：mac 不退出、必须有 Edit 菜单', () => {
  assert.equal(platform.quitOnWindowClose('darwin'), false, 'mac 关窗应留在 Dock');
  assert.equal(platform.quitOnWindowClose('win32'), true);
  assert.equal(platform.quitOnWindowClose('linux'), true);
  /* mac 没有应用菜单时 Cmd+C/V/Z 全部失效，这条不能退化 */
  assert.equal(platform.needsApplicationMenu('darwin'), true);
  assert.equal(platform.needsApplicationMenu('win32'), false);
});

test('仓库里不再有写死的 Windows 专有路径或快捷键判断', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const suspicious = [];
  const check = (file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [needle, why] of [
      ["AppData/Local/OpenAI/Codex", 'Codex 路径应走 platform.cjs'],
      ["AppData/Local/Programs/DSH Desktop", 'DSH 路径应走 platform.cjs'],
      ["assets/iris.ico'", '图标路径应走 platformAssets / iconCandidates'],
      ["e.ctrlKey && e.key", '快捷键应按平台判断']
    ]) {
      if (text.includes(needle)) suspicious.push(`${file}: ${why}（命中 ${needle}）`);
    }
  };
  for (const file of ['core/providers.cjs', 'core/history.cjs', 'main.cjs', 'renderer/app.js']) check(file);
  assert.deepEqual(suspicious, []);
});
