/* 窗口尺寸自适应的验收。
 *
 * 背景：窗口原来写死 1380×920、最小 940×660。1366×768 的笔记本高度不够；
 * 1920×1080 在 150% 缩放下工作区只有 1280×672（DIP），1380 宽直接超出屏幕。
 *
 * 这里验的是纯函数：给定工作区能算出多大、放哪、以及"上次的位置还该不该用"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PREFERRED_WINDOW, fitWindowToScreen, centerWindowIn, resolveWindowBounds, sanitizeWindowBounds
} = require('../core/platform.cjs');

const area = (width, height, x = 0, y = 0) => ({ x, y, width, height });

test('大屏上保持首选尺寸不变', () => {
  const fitted = fitWindowToScreen(area(1920, 1040));
  assert.deepEqual(fitted, { width: 1380, height: 920, minWidth: 940, minHeight: 660 });
});

test('1366×768 的笔记本：高度被压到屏幕内，最小高度不越界', () => {
  const fitted = fitWindowToScreen(area(1366, 728));
  assert.equal(fitted.width, 1256, '1920×1040 之外的第一档：1366*0.92');
  assert.equal(fitted.height, 669, '728*0.92=669');
  assert.ok(fitted.height <= 728, '窗口不能比屏幕高');
  assert.ok(fitted.minHeight <= 728, '最小高度也不能比屏幕高');
});

test('150% 缩放的 1920×1080：工作区 1280×672，宽高都要收', () => {
  const fitted = fitWindowToScreen(area(1280, 672));
  assert.ok(fitted.width <= 1280, `宽度 ${fitted.width} 必须 ≤ 工作区 1280`);
  assert.ok(fitted.minWidth <= 1280, `最小宽度 ${fitted.minWidth} 也必须 ≤ 1280`);
  assert.equal(fitted.width, 1177, '1280*0.92');
  // maxHeight(618) 比 minHeight(648) 还小，于是取 minHeight —— 窗口占满「屏幕减 24」，
  // 这是刻意取舍：宁可贴着边，也不给一个高 618 却宣布最小 648 的自相矛盾配置。
  assert.equal(fitted.height, 648);
  assert.equal(fitted.minHeight, 648, '672-24');
  assert.ok(fitted.height <= 672, '不能比工作区高');
});

test('极小屏（800×560）：窗口与最小尺寸一起缩，不会出现「最小比屏幕还大」', () => {
  const fitted = fitWindowToScreen(area(800, 560));
  assert.equal(fitted.width, 776, 'minWidth 被压到 800-24');
  assert.equal(fitted.height, 536, 'minHeight 被压到 560-24');
  assert.equal(fitted.minWidth, 776);
  assert.equal(fitted.minHeight, 536);
  assert.ok(fitted.width <= 800 && fitted.height <= 560);
});

test('超大屏（3440×1400）不会把窗口撑得过大', () => {
  const fitted = fitWindowToScreen(area(3440, 1400));
  assert.equal(fitted.width, PREFERRED_WINDOW.width);
  assert.equal(fitted.height, PREFERRED_WINDOW.height);
});

test('居中：正坐标与副屏负坐标都正确', () => {
  assert.deepEqual(centerWindowIn(area(1920, 1040), { width: 1380, height: 920 }), { x: 270, y: 60 });
  // 副屏摆主屏左边时 workArea.x 是负的
  assert.deepEqual(centerWindowIn(area(1280, 672, -1280, 0), { width: 1000, height: 600 }), { x: -1140, y: 36 });
});

test('没有保存记录时：按主屏自适应并居中', () => {
  const bounds = resolveWindowBounds({ displays: [{ workArea: area(1366, 728) }] });
  assert.equal(bounds.restored, false);
  assert.equal(bounds.width, 1256);
  assert.equal(bounds.height, 669);
  assert.equal(bounds.x, 55, '(1366-1256)/2');
  assert.equal(bounds.y, 30, '(728-669)/2 = 29.5，四舍五入到 30');
});

test('保存的位置仍在某块屏内时恢复它', () => {
  const bounds = resolveWindowBounds({
    displays: [{ workArea: area(1920, 1040) }],
    saved: { x: 100, y: 80, width: 1200, height: 800, maximized: false }
  });
  assert.equal(bounds.restored, true);
  assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [100, 80, 1200, 800]);
});

test('保存的位置在屏幕外（换过显示器）时回退到居中，不能把窗口放到看不见的地方', () => {
  const bounds = resolveWindowBounds({
    displays: [{ workArea: area(1920, 1040) }],
    saved: { x: 5200, y: 3000, width: 1200, height: 800 }
  });
  assert.equal(bounds.restored, false);
  assert.equal(bounds.width, 1380);
  assert.equal(bounds.x, 270);
  assert.equal(bounds.y, 60);
});

test('保存的窗口过大时按当前屏幕收窄，而不是原样恢复', () => {
  const bounds = resolveWindowBounds({
    displays: [{ workArea: area(1366, 728) }],
    saved: { x: 10, y: 10, width: 3000, height: 2000 }
  });
  assert.equal(bounds.restored, true, '位置可用就该恢复位置');
  assert.ok(bounds.width <= 1366, `宽度 ${bounds.width} 应被收窄`);
  assert.ok(bounds.height <= 728, `高度 ${bounds.height} 应被收窄`);
});

test('标题栏被挤到屏幕外时也算不可用', () => {
  const bounds = resolveWindowBounds({
    displays: [{ workArea: area(1920, 1040) }],
    saved: { x: 2100, y: 200, width: 1200, height: 800 }   // 起点在屏右侧之外
  });
  assert.equal(bounds.restored, false);
});

test('sanitizeWindowBounds 丢弃明显不合理的尺寸', () => {
  assert.deepEqual(sanitizeWindowBounds({ x: 1, y: 2, width: 1200, height: 800, maximized: true }),
    { x: 1, y: 2, width: 1200, height: 800, maximized: true });
  assert.equal(sanitizeWindowBounds({ width: 100, height: 800 }), null, '太窄');
  assert.equal(sanitizeWindowBounds({ width: 1200, height: 100 }), null, '太矮');
  assert.equal(sanitizeWindowBounds({ width: 'x', height: 800 }), null, '非数字');
  assert.equal(sanitizeWindowBounds(null), null);
  assert.equal(sanitizeWindowBounds({ width: 99999, height: 800 }), null, '超出合理上限');
  // 没有 x/y 也接受：只有尺寸、没有位置（首次启动后只 resize 没 move 的情况）
  assert.deepEqual(sanitizeWindowBounds({ width: 1200, height: 800 }), { width: 1200, height: 800, x: undefined, y: undefined, maximized: false });
});
