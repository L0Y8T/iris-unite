'use strict';

/* Electron 可执行文件的跨平台取法。
 *
 * 不要在测试里写 node_modules/electron/dist/electron.exe：macOS 上是
 * Electron.app/Contents/MacOS/Electron，Linux 上是 electron。electron 包在纯 Node 环境下
 * require 出来的就是当前平台的二进制路径。
 */
const electron = require('electron');
const path = require('node:path');

/* 有些宿主（例如把 Electron 当运行时内嵌的工具链）会在环境里留下 ELECTRON_RUN_AS_NODE=1。
   带着它启动，electron.exe 会退化成纯 Node：main.cjs 第 37 行的 app.setName 直接炸，
   现象是「渲染进程没有起来」——看起来像应用坏了，其实是环境变量把运行时换了。
   所有测试脚本都会先 require 这个模块，所以在这里一次性摘掉，比每个 spawn 点各写一遍可靠。 */
delete process.env.ELECTRON_RUN_AS_NODE;

module.exports = {
  /** Electron 二进制路径（跨平台）。 */
  binary: electron,
  /** 拼一个绝对路径，便于各 harness 复用同一套写法。 */
  resolve: (...parts) => path.join(...parts),
  /** 给子进程用的干净环境：去掉会把 Electron 变成纯 Node 的那个变量。 */
  env: (extra = {}) => {
    const env = { ...process.env, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }
};
