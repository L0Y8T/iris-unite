/* 学习模式的机械层（core/learning.cjs）。
 *
 * 这个文件存在的理由：学习计划里唯一"必须每次一样"的东西是顺序。
 * 模型可以换、可以重跑、可以在不同温度下给出不同的知识点，但只要同一份知识点进来，
 * 分层、分阶段、破环的结果就必须逐字节相同——否则用户第二次打开计划会发现路径变了。
 * 下面每个用例都在守这条：确定性、依赖不倒挂、坏输入不炸、修正可追溯。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const learning = require('../core/learning.cjs');

const point = (id, name, extra = {}) => ({ id, name, summary: `${name}的一句话说明`, difficulty: '基础', requires: [], evidenceKeys: [], why: `${name}的作用`, ...extra });

/** 一个典型的知识点集合：有链、有扇出、有一个环、有一个悬空先修。 */
const sample = () => [
  point('a', '前向加噪'),
  point('b', '反向去噪', { requires: ['a'] }),
  point('c', '训练目标', { requires: ['a'] }),
  point('d', '采样器', { requires: ['b', 'c'], difficulty: '前沿' }),
  point('e', '得分匹配', { requires: ['d', 'a'], difficulty: '进阶' })
];

/* ── 难度归一 ──────────────────────────────────────────────────────────── */

test('难度归一：中文、英文、数字、L 前缀都能落到 1..4', () => {
  assert.equal(learning.levelOf('入门'), 1);
  assert.equal(learning.levelOf('beginner'), 1);
  assert.equal(learning.levelOf('基础'), 2);
  assert.equal(learning.levelOf('L3'), 3);
  assert.equal(learning.levelOf(4), 4);
  assert.equal(learning.levelOf('前沿'), 4);
  assert.equal(learning.levelOf('something-else'), 2, '认不出的难度按基础处理，不抛错');
  assert.equal(learning.levelOf(undefined), 2);
  assert.equal(learning.levelLabel(3), '进阶');
  assert.equal(learning.levelLabel(99), '前沿', '越界夹回 1..4');
});

/* ── 知识点归一 ────────────────────────────────────────────────────────── */

test('知识点归一：编号重复、同名、缺 id、越界难度都被就地修好并留痕', () => {
  const result = learning.normalizePoints({
    topic: '扩散模型',
    points: [
      { id: 'dup', name: '甲', difficulty: '入门', requires: [], evidenceKeys: ['S1'], summary: 's', why: 'w' },
      { id: 'dup', name: '乙', difficulty: '基础', requires: [], evidenceKeys: [], summary: 's', why: 'w' },
      { name: '', difficulty: '基础' },
      { id: 'x', name: '甲', difficulty: '基础', requires: [], evidenceKeys: [], summary: 's', why: 'w' },
      { name: '丙', difficulty: '高级', requires: [], evidenceKeys: [], summary: 's', why: 'w' }
    ]
  }, { evidenceKeys: ['S1'] });
  assert.equal(result.topic, '扩散模型');
  assert.deepEqual(result.points.map(item => item.id), ['dup', 'dup-2', 'kp-3'], '缺少可用 id 的按顺序补，重复的加序号');
  assert.deepEqual(result.points.map(item => item.name), ['甲', '乙', '丙']);
  assert.deepEqual(result.dropped.map(item => item.reason), ['缺少名称', '同名知识点重复']);
  assert.equal(result.points[2].level, 4, '「高级」应归一到前沿');
  assert.ok(result.repaired.some(item => item.field === 'id'));
  assert.ok(result.repaired.some(item => item.field === 'difficulty'));
});

test('知识点归一：资料库里不存在的引用键一律剔除，没有资料时保留空数组', () => {
  const withKeys = learning.normalizePoints({ points: [point('a', '甲', { evidenceKeys: ['S1', 's2', '[S9]', 'S7'] })] }, { evidenceKeys: new Set(['S1', 'S2']) });
  assert.deepEqual(withKeys.points[0].evidenceKeys, ['S1', 'S2'], '键要归一大小写并剔除不存在的 S9 / S7');
  assert.ok(withKeys.repaired.some(item => /S9/.test(item.note)));

  const noKeys = learning.normalizePoints({ points: [point('a', '甲', { evidenceKeys: ['S1'] })] }, { evidenceKeys: null });
  assert.deepEqual(noKeys.points[0].evidenceKeys, ['S1'], '没给资料库时不做剔除（例如显式无资料教学前的预演）');
});

test('知识点归一：超过上限只保留前面若干个，并标记被截断', () => {
  const many = Array.from({ length: 40 }, (_, i) => point(`p${i}`, `点${i}`));
  const result = learning.normalizePoints({ points: many }, { limit: 5 });
  assert.equal(result.points.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 5);
});

test('知识点归一：裸数组也接受，字符串条目也能变成知识点', () => {
  const result = learning.normalizePoints(['甲', '乙'], {});
  assert.deepEqual(result.points.map(item => item.name), ['甲', '乙']);
  assert.deepEqual(result.points.map(item => item.id), ['kp-1', 'kp-2']);
});

/* ── 依赖图 ────────────────────────────────────────────────────────────── */

test('连边：自环与悬空先修被断开，并且逐条记录', () => {
  const { points, dangling, selfLoops } = learning.linkPoints([
    point('a', '甲', { requires: ['a', 'ghost'] }),
    point('b', '乙', { requires: ['a', 'a'] })
  ]);
  assert.deepEqual(points[0].requires, []);
  assert.deepEqual(points[1].requires, ['a']);
  assert.deepEqual(selfLoops, [{ from: 'a', to: 'a' }]);
  assert.deepEqual(dangling, [{ from: 'a', to: 'ghost' }]);
});

test('破环：A→B→C→A 会断掉一条，且断的是"指回祖先"的那条，不是随机一条', () => {
  const cyclic = [
    point('a', '甲', { requires: ['c'] }),
    point('b', '乙', { requires: ['a'] }),
    point('c', '丙', { requires: ['b'] })
  ];
  const { points, removed } = learning.breakCycles(cyclic);
  assert.equal(removed.length, 1);
  /* DFS 从 a 出发：a → c → b，b 指着还在栈里的 a，这一条才是后向边。 */
  assert.deepEqual({ from: removed[0].from, to: removed[0].to, reason: removed[0].reason }, { from: 'b', to: 'a', reason: 'cycle' });
  assert.equal(points.reduce((sum, item) => sum + item.requires.length, 0), 2);
  assert.ok(removed[0].note.includes('b') && removed[0].note.includes('a'), '断哪条要写清楚');
  /* 破环之后一定能排出层：层数等于剩下的链长。 */
  const { layers } = learning.topoLayers(points);
  assert.equal(layers.length, 3);
});

test('破环：无环图一条边都不动', () => {
  const { points, removed } = learning.breakCycles(sample());
  assert.equal(removed.length, 0);
  assert.equal(points.reduce((sum, item) => sum + item.requires.length, 0), sample().reduce((sum, item) => sum + item.requires.length, 0));
});

test('分层：层号等于依赖链长度，同层按难度升序', () => {
  const { points } = learning.breakCycles(sample());
  const { layers, order, depth } = learning.topoLayers(points);
  assert.equal(depth.get('a'), 1);
  assert.equal(depth.get('b'), 2);
  assert.equal(depth.get('d'), 3);
  assert.equal(depth.get('e'), 4);
  assert.deepEqual(layers.map(ids => ids.length), [1, 2, 1, 1]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
  /* 同层内：b(基础) 与 c(基础) 按原始顺序，不被难度打乱 */
  assert.deepEqual(layers[1], ['b', 'c']);
});

/* ── 先修检查 ──────────────────────────────────────────────────────────── */

test('先修检查：声明的已有基础知识点被排除，没匹配上的也如实报告', () => {
  const result = learning.markKnown(sample(), ['前向加噪', '量子场论']);
  assert.deepEqual(result.matched.map(item => item.id), ['a']);
  assert.equal(result.points.find(item => item.id === 'a').assumed, true);
  assert.deepEqual(result.unmatched, ['量子场论']);
  assert.equal(result.points.filter(item => item.assumed).length, 1, '一条声明只吃掉一个知识点');
});

test('先修检查：包含关系也算匹配，但过短的声明不参与匹配', () => {
  const hit = learning.markKnown([point('a', '概率论基础')], ['概率论']);
  assert.equal(hit.matched.length, 1, '「概率论」应命中「概率论基础」');
  const miss = learning.markKnown([point('a', '概率论基础')], ['力']);
  assert.equal(miss.matched.length, 0, '单字声明太容易被误命中，不参与匹配');
});

test('先修检查：被排除的点不再阻塞依赖它的知识点', () => {
  const kit = learning.buildKit({ points: sample() }, { known: ['前向加噪'], stageCount: 2 });
  assert.deepEqual(kit.known.map(item => item.id), ['a']);
  assert.ok(kit.stages.every(stage => !stage.pointIds.includes('a')));
  const validation = learning.validateKit(kit, { stageCount: 2 });
  assert.equal(validation.ok, true, '排除先修之后不该出现"依赖未排入主路径"的结构错误');
});

/* ── 分阶段 ────────────────────────────────────────────────────────────── */

test('分阶段：连续块一定满足依赖（先修不会落到更后面的阶段）', () => {
  const { points } = learning.breakCycles(sample());
  const { stages } = learning.planStages(points, { stageCount: 3 });
  assert.equal(stages.length, 3);
  const stageOf = id => stages.findIndex(stage => stage.pointIds.includes(id));
  for (const item of points) for (const ref of item.requires) assert.ok(stageOf(ref) <= stageOf(item.id), `${item.id} 的先修 ${ref} 排到了后面`);
  assert.deepEqual(stages.map(stage => stage.pointIds.length), [1, 2, 2], '余数给靠后的阶段');
});

test('分阶段：阶段数超过知识点数时收敛到知识点数，并记录这次偏离', () => {
  const { points } = learning.breakCycles([point('a', '甲'), point('b', '乙')]);
  const { stages, deviations } = learning.planStages(points, { stageCount: 4 });
  assert.equal(stages.length, 2);
  assert.equal(deviations[0].code, 'stage-count-clamped');
});

test('分阶段：没有知识点时返回空阶段而不是抛错', () => {
  const { stages, deviations } = learning.planStages([], { stageCount: 2 });
  assert.deepEqual(stages, []);
  assert.equal(deviations[0].code, 'no-points');
});

test('分阶段：同一份输入两次排出完全相同的阶段', () => {
  const once = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const twice = learning.buildKit({ points: sample() }, { stageCount: 2 });
  assert.deepEqual(once.stages.map(stage => stage.pointIds), twice.stages.map(stage => stage.pointIds));
  assert.deepEqual(once.layers, twice.layers);
});

/* ── 自测题 ────────────────────────────────────────────────────────────── */

test('自测题：指不回知识点的、重复的、题干为空的都被丢掉', () => {
  const { questions, dropped } = learning.normalizeQuestions({
    questions: [
      { pointId: 'a', question: '甲的定义是什么', answer: '要点', check: '两点都对', difficulty: '入门' },
      { pointId: 'a', question: '甲的定义是什么', answer: '重复', check: 'x', difficulty: '入门' },
      { pointId: 'zzz', question: '孤儿题', answer: 'y', check: 'z', difficulty: '入门' },
      { pointId: 'b', question: '   ', answer: 'y', check: 'z', difficulty: '基础' }
    ]
  }, { pointIds: ['a', 'b'] });
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0], { id: 'q-1', pointId: 'a', question: '甲的定义是什么', answer: '要点', check: '两点都对', level: 1, levelLabel: '入门' });
  assert.deepEqual(dropped.map(item => item.reason), ['重复题目', '指不回任何知识点', '题干为空']);
});

/* ── 整套校验 ──────────────────────────────────────────────────────────── */

test('校验：骨架漏排知识点是结构问题，自测覆盖不全只是警告', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const leaky = { ...kit, stages: kit.stages.map((stage, index) => index === 1 ? { ...stage, pointIds: stage.pointIds.slice(1) } : stage) };
  const result = learning.validateKit(leaky, { stageCount: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(item => item.code === 'unassigned-point'));

  const noQuestions = learning.validateKit(kit, { stageCount: 2 });
  assert.equal(noQuestions.ok, true, '没有自测题不影响结构合法性');
  assert.ok(noQuestions.warnings.some(item => item.code === 'coverage-gap'));
  assert.equal(noQuestions.coverage.covered, 0);
});

test('校验：知识点被排到它先修的同一阶段之后会被判为顺序违规', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  /* 人为把顺序倒过来：把最后的阶段放到最前。 */
  const reversed = { ...kit, stages: kit.stages.slice().reverse().map((stage, index) => ({ ...stage, index: index + 1 })) };
  const result = learning.validateKit(reversed, { stageCount: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(item => item.code === 'order-violation'));
});

test('校验：空阶段与重复排入都被判为结构问题', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const shared = kit.stages[0].pointIds[0];
  const bad = {
    ...kit,
    stages: [
      { ...kit.stages[0], pointIds: [...kit.stages[0].pointIds, shared] },
      { ...kit.stages[1], pointIds: [shared, ...kit.stages[1].pointIds] }
    ]
  };
  const result = learning.validateKit(bad, { stageCount: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(item => item.code === 'duplicate-point'));

  const emptyStage = { ...kit, stages: [{ ...kit.stages[0], pointIds: [] }, kit.stages[1]] };
  const emptyResult = learning.validateKit(emptyStage, { stageCount: 2 });
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.problems.some(item => item.code === 'empty-stage'));
  assert.ok(emptyResult.problems.some(item => item.code === 'unassigned-point'));
});

/* ── 组装与渲染 ────────────────────────────────────────────────────────── */

test('组装：一遍走完的 kit 自带统计、修正清单与原样的知识点', () => {
  const kit = learning.buildKit({
    topic: '扩散模型',
    points: [
      point('a', '前向加噪', { evidenceKeys: ['S1', 'S9'] }),
      point('b', '反向去噪', { requires: ['a', 'ghost'] }),
      point('c', '得分匹配', { requires: ['b', 'a'] }),
      point('d', '训练目标', { requires: ['c'] })
    ]
  }, { evidenceKeys: ['S1'], known: [], stageCount: 2 });
  assert.equal(kit.topic, '扩散模型');
  assert.equal(kit.stats.points, 4);
  assert.equal(kit.stats.stages, 2);
  const codes = kit.deviations.map(item => item.code);
  assert.ok(codes.includes('dangling-requires'));
  assert.ok(codes.includes('point-repaired'));
  assert.ok(kit.deviations.every(item => typeof item.message === 'string' && item.message.length > 0), '每条修正都要有一句能读懂的话');
});

test('渲染：确定性正文包含阶段、自测与修正清单', () => {
  const kit = learning.buildKit({ topic: '扩散模型', points: sample() }, { stageCount: 2 });
  learning.attachSection(kit, 'stage-1', { title: '打地基', objective: '能写出前向过程的闭式解', keyQuestions: ['为什么加噪要写成马尔可夫链'], milestones: ['能独立推导'], pitfalls: ['把 β 与 α 混用'], materials: ['S1 第 3 节'] });
  kit.questions = learning.normalizeQuestions({ questions: [{ pointId: 'a', question: '写出 q(x_t|x_0)', answer: '闭式高斯', check: '均值方差都对', difficulty: '入门' }] }, { pointIds: kit.points.map(item => item.id) }).questions;

  const body = learning.renderPlan(kit, { title: '扩散模型学习计划' });
  assert.match(body, /^# 扩散模型学习计划/);
  assert.match(body, /## 知识点地图/);
  assert.match(body, /### 打地基/);
  assert.match(body, /学完能做到：能写出前向过程的闭式解/);
  assert.match(body, /参考答案：闭式高斯/);
  assert.match(body, /## 自测题/);
  assert.equal(learning.renderPlan(null), '');

  /* 同一份 kit 渲染两次必须逐字相同。 */
  assert.equal(body, learning.renderPlan(kit, { title: '扩散模型学习计划' }));
});

test('阶段写作挂回 kit：模型只能填内容，不能改结构', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const before = JSON.stringify(kit.stages.map(stage => stage.pointIds));
  const section = learning.attachSection(kit, 'stage-1', { title: '第一步', objective: '目标', keyQuestions: ['q'], milestones: ['m'], pitfalls: ['p'], materials: ['S1'], pointIds: ['zzz'] });
  assert.equal(section.title, '第一步');
  assert.equal(kit.stages[0].authored.title, '第一步');
  assert.equal(JSON.stringify(kit.stages.map(stage => stage.pointIds)), before, '模型塞进来的 pointIds 必须被忽略');
  assert.equal(learning.attachSection(kit, 'nope', { title: 'x' }), null, '不存在的阶段不许凭空造出来');
});

test('空标题的段会退回自动标题，不会渲染出没有名字的章节', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const section = learning.attachSection(kit, 'stage-1', { title: '', objective: '目标' });
  assert.match(section.title, /^阶段 1/);
});

test('摘要：给界面的 scale 信息与健康度', () => {
  const kit = learning.buildKit({ points: sample() }, { stageCount: 2 });
  const summary = learning.summarizeKit(kit);
  assert.equal(summary.points, 5);
  assert.equal(summary.stages.length, 2);
  assert.equal(summary.ok, true);
  assert.equal(summary.coverage.total, 5);
  assert.equal(typeof summary.deviations, 'number');
});
