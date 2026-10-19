const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../core/profiles.cjs');

const catalog = {
  providers: ['deepseek', 'gpt'],
  deepseek: [{ id: 'deepseek-flash', name: 'Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  gpt: [{ id: 'gpt-6.1-sol', name: 'GPT', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  defaultGptModel: 'gpt-6.1-sol'
};
const picker = efforts => {
  for (const effort of efforts) {
    for (const provider of ['deepseek', 'gpt']) {
      const model = catalog[provider].find(m => m.efforts.includes(effort));
      if (model) return { provider, model: model.id, effort };
    }
  }
  return null;
};

test('三档的活跃角色与阶段集合与文档 §5.2 一致', () => {
  assert.deepEqual(profiles.PROFILE_IDS, ['p0-query', 'p1-review', 'p2-teach']);
  assert.deepEqual(profiles.activeRoles('p0-query'), ['scope', 'evidence', 'summarize']);
  assert.deepEqual(profiles.activeRoles('p2-teach'), ['scope', 'evidence', 'teachingOutline', 'teachingSections', 'teachingExamples', 'final']);
  const p0 = profiles.stagesOf('p0-query');
  assert.ok(p0.includes('research-summarize'));
  assert.ok(!p0.includes('research-plan'), 'P0 不应包含问题分解');
  assert.ok(!p0.includes('research-explore'));
  const p1 = profiles.stagesOf('p1-review', { allowRefinement: false });
  assert.ok(p1.includes('research-refine') === false, '关闭深化时不应有 refine');
  assert.ok(profiles.stagesOf('p1-review', { allowRefinement: true }).includes('research-refine'));
  const p2 = profiles.stagesOf('p2-teach');
  assert.ok(p2.includes('teaching-sections') && p2.includes('research-final'));
});

test('基准调用数按 §9.1 公式计算（含实验族）', () => {
  const p0 = profiles.defaultsFor('p0-query', catalog, picker);
  assert.equal(profiles.baseCalls(p0), 3);
  assert.equal(p0.experiments.enabled, false, '速查档不开自动实验');

  const p1 = profiles.defaultsFor('p1-review', catalog, picker);
  /* 默认打开实验：实验设计 1 次 + 每轮结果分析 1 次（默认 2 轮），执行本身走执行预算 */
  assert.equal(p1.experiments.enabled, true, '综述档默认打开自动实验');
  assert.equal(profiles.baseCalls(p1), 2 + 5 + 3, 'P1 N=2 有检索 + 实验族应为 10');

  p1.experiments.enabled = false;
  assert.equal(profiles.baseCalls(p1), 2 + 5, '关掉实验后回到 N+5=7');

  p1.experiments.enabled = true;
  p1.tasks.push({ id: 'x', title: 'x', brief: 'x', choice: picker(['low']) });
  assert.equal(profiles.baseCalls(p1), 3 + 5 + 3, 'P1 N=3 应为 11');
  p1.retrieval.enabled = false;
  assert.equal(profiles.baseCalls(p1), 3 + 4 + 3, 'P1 N=3 无检索兼容应为 N+4+实验');

  p1.experiments.maxRounds = 1;
  assert.equal(profiles.baseCalls(p1), 3 + 4 + 2, '实验轮次减少，模型调用随之减少');

  const p2 = profiles.defaultsFor('p2-teach', catalog, picker);
  assert.equal(p2.experiments.enabled, false, '教学档不开自动实验');
  assert.equal(profiles.baseCalls(p2), 2 + 5, 'P2 C=2 有检索应为 7');
  p2.teaching.chapterCount = 4;
  assert.equal(profiles.baseCalls(p2), 9);
  p2.choices.audit = picker(['low']);
  assert.equal(profiles.baseCalls(p2), 10, '启用终审复核应 +1');
});

test('实验族的角色只在启用时才需要模型', () => {
  const on = profiles.defaultsFor('p1-review', catalog, picker);
  assert.ok(profiles.rolesFor(on).includes('experimentDesign'));
  assert.ok(profiles.rolesFor(on).includes('experimentAnalyze'));
  const off = { ...on, experiments: { ...on.experiments, enabled: false } };
  assert.ok(!profiles.rolesFor(off).includes('experimentDesign'), '实验关闭时不该要求实验模型');
  assert.ok(profiles.rolesFor(off).includes('final'));
  assert.equal(profiles.normalizeExperiments({ experiments: { enabled: true, maxTrials: 99, maxRounds: 99 } }).maxTrials, profiles.POLICY.maxExperimentTrials);
  assert.equal(profiles.experimentsEnabled({ profile: 'p0-query', experiments: { enabled: true } }), false, '速查档即使写 true 也不启用实验');
});

test('P0 不再被"任务数+5"卡住：0 任务 3 次调用合法', () => {
  const p0 = profiles.defaultsFor('p0-query', catalog, picker);
  assert.equal(p0.tasks.length, 0);
  assert.equal(p0.budget.maxCalls, 3);
  const shape = profiles.validateShape(p0);
  assert.equal(shape.baseCalls, 3);
  assert.equal(shape.reserve, 1);
});

test('校验：档位与任务数、深化开关、检索开关的强制关系', () => {
  const p0 = profiles.defaultsFor('p0-query', catalog, picker);
  assert.throws(() => profiles.validateShape({ ...p0, tasks: [{ id: 't', title: 't', brief: 'b', choice: picker(['low']) }] }), /不并行研究任务/);
  assert.throws(() => profiles.validateShape({ ...p0, allowRefinement: true }), /不支持定向深化/);
  assert.throws(() => profiles.validateShape({ ...p0, retrieval: { ...p0.retrieval, enabled: false } }), /必须启用资料检索/);
  const p1 = profiles.defaultsFor('p1-review', catalog, picker);
  assert.throws(() => profiles.validateShape({ ...p1, tasks: [] }), /1–4 项并行任务/);
  assert.throws(() => profiles.validateShape({ ...p1, allowRefinement: undefined }), /显式布尔值/);
  const p2 = profiles.defaultsFor('p2-teach', catalog, picker);
  assert.throws(() => profiles.validateShape({ ...p2, retrieval: { ...p2.retrieval, enabled: false } }), /显式允许无外部资料教学/);
  const ok = profiles.validateShape({ ...p2, retrieval: { ...p2.retrieval, enabled: false }, evidence: { ...p2.evidence, allowGeneralTeaching: true }, budget: { ...p2.budget, maxCalls: 6 } });
  assert.equal(ok.retrievalEnabled, false);
});

test('校验：预算上下限、时间上限、Tier 白名单', () => {
  const p1 = profiles.defaultsFor('p1-review', catalog, picker);
  assert.throws(() => profiles.validateShape({ ...p1, budget: { ...p1.budget, maxCalls: 4 } }), /基准调用数 10/);
  assert.throws(() => profiles.validateShape({ ...p1, budget: { ...p1.budget, maxCalls: 25 } }), /不得超过 24/);
  assert.throws(() => profiles.validateShape({ ...p1, budget: { ...p1.budget, wallClockSec: 30 } }), /60–1200/);
  assert.throws(() => profiles.validateShape({ ...p1, budget: { ...p1.budget, modelTimeoutSec: 5000 } }), /不得大于本轮时间上限/);
  assert.throws(() => profiles.validateShape({ ...p1, tier: 'local-exec' }), /只开放 readonly/);
  assert.throws(() => profiles.validateShape({ ...p1, profile: 'p9-nope' }), /未知的 Profile/);
});

test('v3 配置迁移到 v4：保留模型选择、预算与深化开关，不擅自加钱', () => {
  const legacy = {
    version: 3,
    retrieval: { enabled: true, sources: ['openalex', 'arxiv'], perSource: 12, yearFrom: 2020, maxQueries: 3 },
    choices: {
      scope: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'high' },
      evidence: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
      plan: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'medium' },
      screen: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'medium' },
      final: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'xhigh' },
      audit: null
    },
    tasks: [{ id: 'task-1', title: '路线', brief: '职责', choice: { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' } }],
    maxCalls: 6,
    allowRefinement: true,
    monitor: { enabled: true }
  };
  const { config, report } = profiles.migrateConfig(legacy);
  assert.equal(config.version, 4);
  assert.equal(config.profile, 'p1-review');
  assert.equal(config.budget.maxCalls, 6, '不擅自增加额度');
  assert.equal(config.allowRefinement, true);
  assert.deepEqual(config.choices.final, legacy.choices.final);
  assert.equal(config.retrieval.maxRecordsPerSource, 12, 'perSource 映射到源内上限');
  assert.equal(config.retrieval.maxRecordsPerQuery, 12, '同时映射到合并上限以保留旧截断行为');
  assert.equal(config.retrieval.yearFrom, 2020);
  assert.equal(config.budget.wallClockSec, 1200, '旧 20 分钟上限如实映射');
  // N=1 有检索 → 基准 6，旧预算 6 刚好够
  assert.equal(report.baseCalls, 6);
  assert.equal(report.budgetShortfall, 0);
});

test('v3 旧预算低于新版基准时如实报告缺额，不自动加钱', () => {
  const legacy = {
    version: 3,
    retrieval: { enabled: true, sources: ['openalex'], perSource: 5 },
    choices: { scope: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' }, evidence: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' }, plan: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' }, screen: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' }, final: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' } },
    tasks: [{ id: 't1', title: 'a', brief: 'a', choice: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' } }, { id: 't2', title: 'b', brief: 'b', choice: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' } }, { id: 't3', title: 'c', brief: 'c', choice: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'low' } }],
    maxCalls: 5,
    allowRefinement: false
  };
  const { config, report } = profiles.migrateConfig(legacy);
  assert.equal(config.budget.maxCalls, 5);
  assert.equal(report.baseCalls, 8, 'N=3 有检索基准应为 8');
  assert.equal(report.budgetShortfall, 3);
});

test('v2 配置（orchestrator/reviewer）迁移到 v4', () => {
  const legacy = {
    version: 2,
    orchestrator: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'medium' },
    reviewer: { provider: 'gpt', model: 'gpt-6.1-sol', effort: 'xhigh' },
    tasks: [{ id: 'task-1', title: 'a', brief: 'a', choice: { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' } }],
    maxCalls: 8,
    allowRefinement: true
  };
  const { config } = profiles.migrateConfig(legacy);
  assert.equal(config.profile, 'p1-review');
  assert.deepEqual(config.choices.plan, legacy.orchestrator);
  assert.deepEqual(config.choices.screen, legacy.orchestrator);
  assert.deepEqual(config.choices.final, legacy.reviewer);
});

test('v4 配置原样通过迁移（幂等）', () => {
  const p1 = profiles.defaultsFor('p1-review', catalog, picker);
  const once = profiles.migrateConfig(p1).config;
  const twice = profiles.migrateConfig(once).config;
  assert.deepEqual(once, twice);
  assert.equal(profiles.migrateConfig({ version: 5, profile: 'p1-review' }).config.version, 5, '未知高版本保持可读');
});

test('每档默认模板只使用目录里真实存在的模型', () => {
  for (const profile of profiles.PROFILE_IDS) {
    const config = profiles.defaultsFor(profile, catalog, picker);
    const choices = Object.entries(config.choices).filter(([, v]) => v);
    assert.ok(choices.length > 0, `${profile} 没有任何模型选择`);
    for (const [role, choice] of choices) {
      const model = catalog[choice.provider]?.find(m => m.id === choice.model);
      assert.ok(model, `${profile} 的 ${role} 指向不存在的模型`);
      assert.ok(model.efforts.includes(choice.effort), `${profile} 的 ${role} 强度不被支持`);
    }
  }
});
