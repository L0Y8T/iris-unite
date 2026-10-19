/* 「按上一轮的方案执行实验」的验收：只跑实验与整合，不重跑前面的环节。
 *
 * 这一层盯四件事：
 * 1. 沿用模式只激活实验族 + 整合 + 核验 + 自检，前面的环节一个都不许再跑。
 * 2. 前序环节在沿用模式下不再是「必需产物」，否则自检会把按设计跳过判成失败。
 * 3. 基准调用数跟着降下来，界面不会继续显示「至少 10 次调用」。
 * 4. 数据不全（没界定 / 没跑完 / 已经跑过实验）时明确拒绝，不用半截数据编实验。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const research = require('../core/research.cjs');
const plan = require('../core/plan.cjs');
const profiles = require('../core/profiles.cjs');

const CATALOG = {
  deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['off', 'high'], defaultEffort: 'high' }],
  gpt: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'high'], defaultEffort: 'high' }]
};
const pick = provider => ({ provider, model: provider === 'gpt' ? 'gpt-6.1-sol' : 'deepseek-flash', effort: 'high' });

function baseConfig(over = {}) {
  const config = research.defaults(CATALOG);
  return research.validateConfig({
    ...config,
    profile: 'p1-review',
    tier: 'readonly',
    allowRefinement: false,
    tasks: [{ id: 'task-1', title: '基线验证', brief: '确认能复现', choice: pick('deepseek') }],
    experiments: { enabled: true, maxTrials: 4, maxRounds: 2, templateId: null, stopWhen: '指标不再提升' },
    budget: { maxCalls: 16, wallClockSec: 1100, modelTimeoutSec: 300, maxConcurrentModels: 2 },
    choices: Object.fromEntries(Object.keys(profiles.ROLE_STAGE).map(role => [role, pick('deepseek')])),
    ...over
  }, CATALOG);
}

function doneRun(over = {}) {
  return {
    mode: 'research',
    status: 'done',
    roundId: 'round-prev',
    scope: { objective: '确定 digits 上最合适的模型', questions: ['哪个模型更好'], queries: ['digits classifier'], inclusion: ['公开'], exclusion: ['私有'] },
    evidence: { claims: [{ claim: 'MLP 更好', keys: ['S1'], strength: '中', limitation: '单次种子' }], gaps: ['缺多种子'] },
    plan: { objective: '比较三种模型', tasks: [{ id: 'task-1', assignment: '跑基线', deliverable: '准确率表', evidenceKeys: ['S1'] }], selectionCriteria: '真实指标优先' },
    selection: { selectedIds: ['task-1'], refineIds: [], executedRefineIds: [], reason: '指标可复现', feedback: '', unsupported: [], deviations: [] },
    artifacts: [
      { stage: 'research-explore', stageLabel: '并行研究', taskLabel: '基线验证', text: '先用样本上限 12000 跑 logreg 与 mlp 对照，种子固定 42。', status: 'done' },
      { stage: 'research-screen', stageLabel: '候选筛选', text: '优先做可直接出准确率的表格分类实验。', status: 'done' }
    ],
    experimentRuns: [],
    ...over
  };
}

const CHOICE = { text: '执行第 2 个：同等计算预算下正确分解与打乱步骤的对照', index: 2, title: '分解必要性' };

function resumed(over = {}) {
  return research.withResume(baseConfig(), doneRun(over), CHOICE);
}

test('沿用模式只激活实验族与收口环节', () => {
  const config = resumed();
  const compiled = plan.compileConfigPlan(config);
  const { active, skipped } = plan.activeNodes(compiled, config);
  const ids = active.map(node => node.id);
  assert.deepEqual(ids, ['experiment-design', 'experiment-build', 'experiment-run', 'experiment-analyze', 'experiment-report', 'research-final', 'research-verify', 'research-audit']);
  const carried = skipped.filter(item => item.condition === 'carry-over').map(item => item.id);
  assert.deepEqual(carried, ['research-scope', 'research-sources', 'research-evidence', 'research-plan', 'research-explore', 'research-screen']);
});

test('沿用模式下前序环节不再被要求有产物', () => {
  const config = resumed();
  const compiled = plan.compileConfigPlan(config);
  const byId = new Map(compiled.nodes.map(node => [node.id, node]));
  assert.equal(byId.get('research-scope').required, false, '沿用模式下界定不该被当成必需产物');
  assert.equal(byId.get('research-final').required, true, '整合仍然是必需的');
  /* 正常轮次的必需性不能被这次改动带歪 */
  const normal = plan.compileConfigPlan(baseConfig());
  assert.equal(new Map(normal.nodes.map(node => [node.id, node])).get('research-scope').required, true);
});

test('基准调用数从整轮降到「整合 + 实验」', () => {
  const config = baseConfig();
  const resumedConfig = resumed();
  const normalCalls = profiles.baseCalls(config);
  const resumedCalls = profiles.baseCalls(resumedConfig);
  assert.ok(normalCalls >= 9, `整轮基准调用应不少于 9 次，实际 ${normalCalls}`);
  /* 1 次整合 + 1 次终审复核 + 1 次实验设计 + 最多 2 轮分析 */
  assert.equal(resumedCalls, 1 + 1 + 1 + 2);
  assert.ok(resumedCalls < normalCalls);
});

test('沿用模式会带上上一轮的推演成果、筛选结论与用户指定的方案', () => {
  const config = resumed();
  assert.equal(config.resume.mode, 'experiment-only');
  assert.equal(config.resume.roundId, 'round-prev');
  assert.equal(config.resume.scope.objective, '确定 digits 上最合适的模型');
  assert.equal(config.resume.selection.reason, '指标可复现');
  assert.equal(config.resume.prior.length, 2);
  assert.ok(config.resume.prior[0].text.includes('样本上限 12000'));
  /* 用户点名的方案必须原样传下去，实验设计要照它来 */
  assert.equal(config.resume.choice.text, CHOICE.text);
  assert.equal(config.resume.choice.index, 2);
  /* 实验必须真的打开，否则沿用一轮什么都跑不了 */
  assert.equal(profiles.experimentsEnabled(config), true);
});

test('沿用对象是副本：改它不会污染上一轮的记录', () => {
  const run = doneRun();
  const config = research.withResume(baseConfig(), run, CHOICE);
  config.resume.scope.objective = '被改掉';
  assert.equal(run.scope.objective, '确定 digits 上最合适的模型');
});

test('没写清执行哪一个方案时必须拒绝', () => {
  for (const choice of [undefined, null, {}, { text: '' }, { text: '  ' }, { text: 'a' }]) {
    assert.throws(() => research.withResume(baseConfig(), doneRun(), choice), /请明确说明执行哪一个方案/, `choice=${JSON.stringify(choice)} 不该被放过`);
  }
});

test('没跑完 / 没界定 / 已经跑过实验都会被拒绝', () => {
  assert.throws(() => research.withResume(baseConfig(), doneRun({ status: 'running' }), CHOICE), /还没有跑完/);
  assert.throws(() => research.withResume(baseConfig(), doneRun({ scope: null }), CHOICE), /没有可沿用的研究界定/);
  assert.throws(() => research.withResume(baseConfig(), doneRun({ experimentRuns: [{ runId: 'run-1' }] }), CHOICE), /已经跑过实验/);
  assert.throws(() => research.withResume(baseConfig(), { mode: 'collaborative' }, CHOICE), /只能沿用科研轮次/);
});

test('沿用模式换一份计划版本，不会被记成同一轮计划', () => {
  const normal = plan.compileConfigPlan(baseConfig());
  const resumedPlan = plan.compileConfigPlan(resumed());
  assert.notEqual(normal.planVersion, resumedPlan.planVersion);
});
