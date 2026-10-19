'use strict';

/**
 * 花费估算：只做乘法，不内置任何价格。
 *
 * 为什么不在代码里写死一份价目表：同一个模型在不同套餐、不同时段、不同地域的单价都不一样
 * （有的服务按订阅计费、根本没有 per-token 账单），写死的数字会直接变成一份错账单。
 * 这里只认用户自己填的单价（每百万 token）；没填就如实说「未设单价」，不显示任何推算出来的金额。
 */

const DEFAULT_PER = 1000000;
const SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function currencyOf(code) {
  const key = String(code || 'CNY').toUpperCase();
  return { code: key, symbol: SYMBOL[key] ?? '' };
}

/**
 * 单价查找：`provider:model` 优先，其次 `provider` 级；都没有就是未设。
 * 两个价都是 0 与「没填」等价——填 0 只意味着不想计价，不代表免费。
 */
function priceFor(pricing, provider, model) {
  if (!pricing || typeof pricing !== 'object' || !provider) return null;
  const keys = [`${provider}:${model || ''}`, String(provider)];
  for (const key of keys) {
    const entry = pricing[key];
    if (!entry || typeof entry !== 'object') continue;
    const input = num(entry.input);
    const output = num(entry.output);
    if (!input && !output) continue;
    return {
      input: input || 0,
      output: output || 0,
      currency: String(entry.currency || 'CNY').toUpperCase(),
      per: num(entry.per) || DEFAULT_PER
    };
  }
  return null;
}

/** usage 里的 token 数 × 单价。缺单价返回 null，调用方必须如实显示「未设单价」。 */
function costOf(usage, price) {
  if (!price) return null;
  const input = num(usage?.input) || 0;
  const output = num(usage?.output) || 0;
  if (!input && !output) return null;
  const per = price.per || DEFAULT_PER;
  return {
    amount: (input / per) * price.input + (output / per) * price.output,
    currency: price.currency,
    input,
    output
  };
}

/**
 * 一轮里可能同时用到多个通道，用量按 `provider:model` 分开记。
 * 货币不同时绝不合并（人民币加美元没有意义），分别给出；没设单价的通道单独点名。
 */
function totalCost(parts, pricing) {
  const amounts = new Map();
  const unpriced = new Set();
  for (const [key, usage] of Object.entries(parts || {})) {
    if (!usage || (!usage.input && !usage.output)) continue;
    const [provider, ...rest] = String(key).split(':');
    const model = rest.join(':');
    const cost = costOf(usage, priceFor(pricing, provider, model));
    if (!cost) { unpriced.add(provider); continue; }
    amounts.set(cost.currency, (amounts.get(cost.currency) || 0) + cost.amount);
  }
  return {
    amounts: [...amounts.entries()].map(([currency, amount]) => ({ currency, amount })),
    unpriced: [...unpriced]
  };
}

/** 金额显示：小于 1 给四位小数（单轮常见就是几分几厘），大于给两位。 */
function formatAmount(amount, currency) {
  const { symbol } = currencyOf(currency);
  const value = Number(amount) || 0;
  return `${symbol}${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}

/** 一句话总结：`≈¥0.0123` / `≈¥0.0123 + $0.0040` / `未设单价`。 */
function describeCost(parts, pricing) {
  const { amounts, unpriced } = totalCost(parts, pricing);
  const text = amounts.map(item => `≈${formatAmount(item.amount, item.currency)}`).join(' + ');
  if (text) return { text, priced: true, unpriced };
  return { text: unpriced.length ? '未设单价' : '', priced: false, unpriced };
}

module.exports = { priceFor, costOf, totalCost, formatAmount, currencyOf, describeCost, DEFAULT_PER };
