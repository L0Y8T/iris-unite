'use strict';

/* Electron 可执行文件的跨平台取法。
 *
 * 不要在测试里写 node_modules/electron/dist/electron.exe：macOS 上是
 * Electron.app/Contents/MacOS/Electron，Linux 上是 electron。electron 包在纯 Node 环境下
 * require 出来的就是当前平台的二进制路径。
 */
const electron = require('electron');
const path = require('node:path');

module.exports = {
  /** Electron 二进制路径（跨平台）。 */
  binary: electron,
  /** 拼一个绝对路径，便于各 harness 复用同一套写法。 */
  resolve: (...parts) => path.join(...parts)
};
