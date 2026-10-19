/* 宽松 JSON 解析验收：真实运行里出现过的括号错配必须能救回来。
 *
 * 失败样本形态取自真实运行（gaps 数组里多一个 }），但内容换成本测试自己造的，
 * 不把用户的科研内容放进仓库。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLoose, repairBrackets, dropTrailingCommas, stripFence } = require('../core/json-parse.cjs');

test('正常 JSON 直接解析，不做修复', () => {
  const r = parseLoose('{"claims":[],"gaps":["a"]}');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.value.gaps, ['a']);
});

test('```json 围栏会被剥掉', () => {
  const r = parseLoose('```json\n{"a":1}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 1);
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
});

test('前后夹解释文字时取对象主体', () => {
  const r = parseLoose('好的，结果如下：\n{"a":1,"b":[1,2]}\n以上。');
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { a: 1, b: [1, 2] });
});

test('真实踩到的形态：数组里多一个 } 也能救回来', () => {
  /* 就是这一处：gaps 的最后一项后面多了一个 }，严格解析报 Expected ',' or ']' */
  const broken = '{"claims":[{"claim":"x","keys":["S1"]}],"gaps":["第一条","第二条"}],"note":"末注"}';
  assert.throws(() => JSON.parse(broken), '样本本身必须是非法 JSON');
  const r = parseLoose(broken);
  assert.equal(r.ok, true, '应能修复：' + r.error);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value.gaps, ['第一条', '第二条']);
  assert.equal(r.value.note, '末注');
  assert.deepEqual(r.value.claims[0].keys, ['S1']);
});

test('尾随逗号会被清掉', () => {
  const r = parseLoose('{"a":[1,2,],"b":{"c":3,},}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: [1, 2], b: { c: 3 } });
  assert.equal(dropTrailingCommas('{"a":1,}'), '{"a":1}');
});

test('被截断的 JSON 会补全括号', () => {
  const r = parseLoose('{"objective":"目标","tasks":[{"id":"task-1","assignment":"a"');
  assert.equal(r.ok, true, '应能补全：' + r.error);
  assert.equal(r.value.objective, '目标');
  assert.equal(r.value.tasks[0].id, 'task-1');
});

test('修复不改变字符串里的花括号', () => {
  const text = '{"a":"这条结论含 { 和 } 两个符号","b":["x}y"]}';
  const r = parseLoose(text);
  assert.equal(r.ok, true);
  assert.equal(r.value.a, '这条结论含 { 和 } 两个符号');
  assert.deepEqual(r.value.b, ['x}y']);
});

test('彻底无法解析时明确失败，交给调用方降级', () => {
  const r = parseLoose('这不是 JSON，只是一段普通文字。');
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(parseLoose('').ok, false);
});

test('括号修复器不制造新的不合法结构', () => {
  const cases = [
    '{"a":[{"b":1}]}',
    '{"a":[1,2,3]}',
    '[[1,2],[3,4]]',
    '{"a":{"b":{"c":[1]}}}'
  ];
  for (const text of cases) {
    assert.equal(repairBrackets(text), text, '合法 JSON 不应被改动：' + text);
  }
});
