// 把 docs/research-architecture.svg 离屏渲染成 PNG（用 Electron，不额外装依赖）。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = path.join(__dirname, '..', 'docs', 'research-architecture.svg');
  const png = path.join(__dirname, '..', 'docs', 'research-architecture.png');
  const win = new BrowserWindow({ width: 1400, height: 2200, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(svg);
  await new Promise(r => setTimeout(r, 500));
  // 取 SVG 元素自身的尺寸，而不是 document 的 —— 窗口比图宽时会把右边的空白一起截进去。
  const size = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('svg');
    const r = el.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
  })()`);
  win.setContentSize(Math.max(200, size.w), Math.min(Math.max(200, size.h), 4200));
  await new Promise(r => setTimeout(r, 600));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(png, image.toPNG());
  console.log('png ' + image.getSize().width + 'x' + image.getSize().height + '  (svg ' + size.w + 'x' + size.h + ')');
  app.exit(0);
});
