/* 从 assets/iris.png 生成 macOS 用的 assets/iris.icns（以及一张 1024 的备用大图）。
 *
 * 为什么需要 ICNS：macOS 的 .app 图标只认 .icns（Info.plist 里 CFBundleIconFile），
 * 给 .ico 或单张 png 都会被忽略，最后显示成默认的电子图标。
 *
 * ICNS 允许直接把 PNG 塞进条目里，所以这里不引第三方库：
 * 用 Electron 自带的 nativeImage 做多尺寸缩放，再按容器格式拼起来。
 *
 *   npx electron scripts/make-icons.cjs
 */
const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
];

function packIcns(pngs) {
  const parts = [];
  for (const [type, size] of pngs) {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(size.length + 8, 4);
    parts.push(header, size);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'assets', 'iris.png');
  if (!fs.existsSync(source)) { console.error('缺少 assets/iris.png'); app.exit(1); return; }
  const base = nativeImage.createFromPath(source);
  const size = base.getSize();
  if (!size.width) { console.error('iris.png 无法解码'); app.exit(1); return; }

  const pngs = ENTRIES.map(([type, target]) => {
    /* 小尺寸直接从大图缩，不逐级缩：逐级缩会累积模糊。 */
    const image = target <= size.width ? base.resize({ width: target, height: target, quality: 'best' }) : base;
    return [type, image.toPNG()];
  });

  const icns = path.join(root, 'assets', 'iris.icns');
  fs.writeFileSync(icns, packIcns(pngs));
  console.log(`icns ${(fs.statSync(icns).size / 1024).toFixed(1)} KB  源图 ${size.width}x${size.height}  尺寸 ${ENTRIES.map(([, n]) => n).join('/')}`);
  app.exit(0);
});
