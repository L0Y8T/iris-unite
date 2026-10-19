/* 花费估算的验收：只做乘法，不许替用户编造单价。
 *
 * 这里盯四件事：
 * 1. 没有单价就不出金额——不能拿「大概价格」凑一个数字出来。
 * 2. 单价按 provider:model → provider 逐级回退，两个价都为 0 等同于没填。
 * 3. 多通道混用时按币种分开合计，人民币和美元不许相加。
 * 4. 千 token 级别的花费要显示到分以下，不能一律四舍五入成 0.00。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../core/pricing.cjs');

const USAGE = { input: 12000, output: 3000 };

test('没有任何单价时不出金额', () => {
  assert.equal(pricing.priceFor({}, 'deepseek', 'deepseek-flash'), null);
  assert.equal(pricing.costOf(USAGE, null), null);
  const described = pricing.describeCost({ 'deepseek:deepseek-flash': USAGE }, {});
  assert.equal(described.text, '未设单价');
  assert.equal(described.priced, false);
});

test('按每百万 token 的单价算钱', () => {
  const price = pricing.priceFor({ deepseek: { input: 2, output: 8, currency: 'CNY' } }, 'deepseek', 'deepseek-flash');
  const cost = pricing.costOf(USAGE, price);
  /* 12000/1e6*2 + 3000/1e6*8 = 0.024 + 0.024 = 0.048 */
  assert.equal(Number(cost.amount.toFixed(6)), 0.048);
  assert.equal(pricing.formatAmount(cost.amount, 'CNY'), '¥0.0480');
});

test('provider:model 级单价优先于 provider 级', () => {
  const table = {
    deepseek: { input: 1, output: 2 },
    'deepseek:deepseek-v4-pro': { input: 4, output: 16 }
  };
  assert.equal(pricing.priceFor(table, 'deepseek', 'deepseek-v4-pro').input, 4);
  assert.equal(pricing.priceFor(table, 'deepseek', 'deepseek-flash').input, 1);
  /* 模型 id 为空时只走 provider 级 */
  assert.equal(pricing.priceFor(table, 'deepseek', '').input, 1);
});

test('单价填 0 等于没填，不显示 0 元', () => {
  const table = { gpt: { input: 0, output: 0 } };
  assert.equal(pricing.priceFor(table, 'gpt', 'x'), null);
  assert.equal(pricing.describeCost({ 'gpt:x': USAGE }, table).text, '未设单价');
});

test('多通道按币种分开合计，不跨币种相加', () => {
  const table = {
    deepseek: { input: 2, output: 8, currency: 'CNY' },
    'model_abc': { input: 0.5, output: 1.5, currency: 'USD' }
  };
  const result = pricing.totalCost({ 'deepseek:deepseek-flash': USAGE, 'model_abc:claude-x': { input: 100000, output: 20000 } }, table);
  const cny = result.amounts.find(a => a.currency === 'CNY');
  const usd = result.amounts.find(a => a.currency === 'USD');
  assert.equal(Number(cny.amount.toFixed(6)), 0.048);
  /* 100000/1e6*0.5 + 20000/1e6*1.5 = 0.05 + 0.03 */
  assert.equal(Number(usd.amount.toFixed(6)), 0.08);
  assert.equal(pricing.describeCost({ 'deepseek:x': USAGE, 'model_abc:y': { input: 100000, output: 20000 } }, table).text, '≈¥0.0480 + ≈$0.0800');
});

test('部分通道没单价时，金额照给，同时点名谁没算', () => {
  const table = { deepseek: { input: 2, output: 8 } };
  const described = pricing.describeCost({ 'deepseek:deepseek-flash': USAGE, 'gpt:gpt-6.1': { input: 5000, output: 1000 } }, table);
  assert.equal(described.text, '≈¥0.0480');
  assert.deepEqual(described.unpriced, ['gpt']);
});

test('单价可以自定义计量单位（per），不写死一百万', () => {
  const price = pricing.priceFor({ deepseek: { input: 0.002, output: 0.008, per: 1000 } }, 'deepseek', 'x');
  const cost = pricing.costOf(USAGE, price);
  /* 按每千 token 计：12000/1000*0.002 + 3000/1000*0.008 = 0.024 + 0.024 */
  assert.equal(Number(cost.amount.toFixed(6)), 0.048);
});

test('没有用量就不算钱，也不算「未设单价」', () => {
  assert.equal(pricing.costOf({ input: 0, output: 0 }, { input: 2, output: 8, currency: 'CNY', per: 1000000 }), null);
  assert.equal(pricing.describeCost({}, {}).text, '');
});

test('金额显示：小额给到四位小数，大额两位', () => {
  assert.equal(pricing.formatAmount(0.0004, 'CNY'), '¥0.0004');
  assert.equal(pricing.formatAmount(12.3456, 'USD'), '$12.35');
  assert.equal(pricing.formatAmount(3, 'CNY'), '¥3.00');
});
