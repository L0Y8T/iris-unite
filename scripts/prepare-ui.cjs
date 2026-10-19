const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const icons = { panel: 'layout-sidebar', plus: 'plus', search: 'search', folder: 'folder', history: 'history', refresh: 'refresh', settings: 'adjustments-horizontal', 'arrow-right': 'arrow-right', 'arrow-up': 'arrow-up', stop: 'player-stop', chevron: 'chevron-right', down: 'chevron-down', export: 'download', edit: 'pencil', copy: 'copy', chat: 'message', code: 'code', plan: 'list-details', compare: 'arrows-diff', check: 'check', close: 'x', sun: 'sun', moon: 'moon', auto: 'device-desktop', bolt: 'bolt', keyboard: 'command', link: 'external-link' };
const svg = Object.fromEntries(Object.entries(icons).map(([key, name]) => [key, fs.readFileSync(path.join(root, 'node_modules/@tabler/icons/icons/outline', name + '.svg'), 'utf8').replace('<svg', '<svg aria-hidden="true" focusable="false"').replace(/\s+/g, ' ')]));
fs.writeFileSync(path.join(root, 'renderer/icons.js'), '// Generated from @tabler/icons. MIT license in vendor/licenses.\nwindow.DUET_ICONS = Object.freeze(' + JSON.stringify(svg) + ');\n');
const vendor = path.join(root, 'renderer/vendor'); fs.mkdirSync(path.join(vendor, 'licenses'), { recursive: true });
for (const [source, target] of [['marked/lib/marked.umd.js', 'marked.js'], ['dompurify/dist/purify.min.js', 'purify.js'], ['@tabler/icons/LICENSE', 'licenses/tabler.txt'], ['marked/LICENSE', 'licenses/marked.txt'], ['dompurify/LICENSE', 'licenses/dompurify.txt']]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(vendor, target));
// 应用图标的署名必须随包分发（CC BY 3.0）。它不属于 npm 依赖，所以在这里生成而不是复制。
fs.writeFileSync(path.join(vendor, 'licenses/iris-icon.txt'), [
  'Iris 应用图标  —  出处与授权',
  '================================',
  '花纹底形 (fleur-de-lis 路径) 取自  game-icons:fleur-de-lys  by Delapouite',
  '  https://game-icons.net    许可: CC BY 3.0',
  '  https://creativecommons.org/licenses/by/3.0/',
  '',
  '本图标的改动: 六边形内接构图 / 圆角卡片 / 花纹横向宽高比 x0.86 /',
  '下缝接合 (束带与脚颈之间加凹弧桥接) / 多尺寸 ico 打包',
  '',
  'CC BY 3.0 要求署名随作品一起出现。此文件随应用打包分发，不得删除。',
  ''
].join('\n'), 'utf8');
console.log('Prepared 27 Tabler icons, local Markdown renderer and icon attribution.');
