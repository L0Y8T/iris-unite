const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../core/profiles.cjs');
const plan = require('../core/plan.cjs');

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
const config = profile => profiles.defaultsFor(profile, catalog, picker);

test('同一配置编译出的 planVersion 稳定，且与调用次数无关', () => {
  const c = config('p1-review');
  const a = plan.compileConfigPlan(c);
  const b = plan.compileConfigPlan(JSON.parse(JSON.stringify(c)));
  assert.equal(a.planVersion, b.planVersion);
  assert.equal(a.planVersion.length, 16);
  // 改一个模型就应当变
  const changed = JSON.parse(JSON.stringify(c));
  changed.choices.final = { provider: 'deepseek', model: 'deepseek-flash', effort: 'max' };
  assert.notEqual(plan.compileConfigPlan(changed).planVersion, a.planVersion);
});

test('planVersion 不受外部能力变化影响（配置态 vs 生效态）', () => {
  const c = config('p1-review');
  const base = plan.compileConfigPlan(c);
  const effectiveOk = plan.deriveEffectivePlan(base, { sources: { openalex: 'ok' } });
  const effectiveBlocked = plan.deriveEffectivePlan(base, { sources: { openalex: 'blocked', crossref: 'blocked', arxiv: 'blocked', pubmed: 'blocked' } });
  assert.equal(effectiveOk.planVersion, base.planVersion);
  assert.equal(effectiveBlocked.planVersion, base.planVersion, '能力变化不得改 planVersion');
  assert.notEqual(effectiveOk.capabilityDigest, effectiveBlocked.capabilityDigest, '能力摘要必须不同以便追溯');
});

test('三档的计划节点集合互相不同，且 P0 不含推演环节', () => {
  const p0 = plan.compileConfigPlan(config('p0-query'));
  const p1 = plan.compileConfigPlan(config('p1-review'));
  const p2 = plan.compileConfigPlan(config('p2-teach'));
  const ids = p => p.nodes.map(n => n.id);
  assert.ok(!ids(p0).includes('research-plan') && !ids(p0).includes('research-explore'));
  assert.ok(ids(p0).includes('research-summarize'));
  assert.ok(ids(p1).includes('research-explore') && ids(p1).includes('research-refine'));
  assert.ok(ids(p2).includes('teaching-sections') && !ids(p2).includes('research-plan'));
  assert.notEqual(p0.planVersion, p1.planVersion);
  assert.notEqual(p1.planVersion, p2.planVersion);
});

test('预算字段来自统一公式：基准、上限、可选余量、保留额度', () => {
  const p1 = plan.compileConfigPlan(config('p1-review'));
  /* 默认开实验：N=2 有检索 7 次 + 实验设计 1 次 + 默认 2 轮分析 2 次 */
  assert.equal(p1.baseCalls, 10);
  assert.equal(p1.maxCalls, 11);
  assert.equal(p1.maxOptionalCalls, 1);
  assert.equal(p1.reserve, 1);

  /* 关掉实验后回到 N+5 */
  const noExp = config('p1-review');
  noExp.experiments = { ...noExp.experiments, enabled: false };
  assert.equal(plan.compileConfigPlan(noExp).baseCalls, 7);
  assert.equal(plan.activeNodes(plan.compileConfigPlan(noExp), noExp).skipped.some(s => s.id === 'experiment-run'), true, '关掉实验时实验节点应被跳过');

  const withAudit = config('p1-review');
  withAudit.choices.audit = picker(['low']);
  withAudit.budget.maxCalls = 12;
  const p1a = plan.compileConfigPlan(withAudit);
  assert.equal(p1a.baseCalls, 11);
  assert.equal(p1a.reserve, 2, '启用终审复核时保留额度应变为 2');
  const p0 = plan.compileConfigPlan(config('p0-query'));
  assert.equal(p0.baseCalls, 3);
  assert.equal(p0.maxOptionalCalls, 0, '速查档默认没有可选余量');
});

test('实验族是计划里的正式节点：exec 类型、trial 扇出、不占模型预算', () => {
  const c = config('p1-review');
  const p = plan.compileConfigPlan(c);
  const byId = Object.fromEntries(p.nodes.map(n => [n.id, n]));
  for (const id of ['experiment-design', 'experiment-build', 'experiment-run', 'experiment-analyze', 'experiment-report']) {
    assert.ok(byId[id], '计划里必须有 ' + id);
    assert.equal(byId[id].condition, 'experiments-enabled', id + ' 必须由实验开关控制');
    assert.equal(byId[id].required, false, id + ' 是条件节点，被跳过时不能要求产物');
  }
  assert.equal(byId['experiment-design'].type, 'model');
  assert.equal(byId['experiment-design'].callCost, 1);
  assert.equal(byId['experiment-run'].type, 'exec', '训练与评估走执行预算');
  assert.equal(byId['experiment-run'].callCost, 0, '执行不消耗模型调用');
  assert.equal(byId['experiment-run'].fanOut, c.experiments.maxTrials);
  assert.deepEqual(byId['experiment-run'].dependencies, ['experiment-build']);
  assert.deepEqual(byId['research-final'].dependencies, ['experiment-report'], '整合必须建立在实验记录之上');
  assert.equal(p.stable.experiments.enabled, true);
});

test('实验开关改变 planVersion，但同配置重复编译稳定', () => {
  const on = config('p1-review');
  const off = { ...config('p1-review'), experiments: { ...on.experiments, enabled: false } };
  const a = plan.compileConfigPlan(on).planVersion;
  const b = plan.compileConfigPlan(on).planVersion;
  const c = plan.compileConfigPlan(off).planVersion;
  assert.equal(a, b, '同配置必须稳定');
  assert.notEqual(a, c, '开关变化必须体现为不同计划');
});

test('依赖图与扇出按模板展开', () => {
  const p1 = plan.compileConfigPlan(config('p1-review'));
  const byId = Object.fromEntries(p1.nodes.map(n => [n.id, n]));
  assert.deepEqual(byId['research-sources'].dependencies, ['research-scope']);
  assert.equal(byId['research-evidence'].condition, 'materials-available');
  assert.equal(byId['research-explore'].fanOut, 2, 'N=2 时应扇出 2');
  assert.equal(byId['research-refine'].required, false, '深化是可选节点');
  assert.deepEqual(byId['research-verify'].dependencies, ['research-final'], '核验依赖实际输出节点');
  const p0 = plan.compileConfigPlan(config('p0-query'));
  assert.deepEqual(Object.fromEntries(p0.nodes.map(n => [n.id, n]))['research-verify'].dependencies, ['research-summarize']);
  const p2 = plan.compileConfigPlan(config('p2-teach'));
  assert.equal(Object.fromEntries(p2.nodes.map(n => [n.id, n]))['teaching-sections'].fanOut, 2, 'C=2 时应扇出 2');
});

test('T0 的被禁用能力写在计划里，可被断言', () => {
  const p1 = plan.compileConfigPlan(config('p1-review'));
  assert.ok(p1.disabledCapabilities.includes('execute-generated-code'));
  assert.ok(p1.disabledCapabilities.includes('run-shell'));
  assert.deepEqual(p1.publishGates, plan.PUBLISH_GATES);
  assert.equal(p1.tier, 'readonly');
});

test('就绪检查：缺模型、通道停用、强度不支持都要说清原因', () => {
  const p1 = config('p1-review');
  const good = plan.compileConfigPlan(p1);
  assert.equal(plan.readiness(good, catalog).ok, true);

  const missing = JSON.parse(JSON.stringify(p1));
  missing.choices.evidence = null;
  const r1 = plan.readiness(plan.compileConfigPlan(missing), catalog);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some(p => p.reason === 'missing-choice' && p.role === 'evidence'));

  const disabled = JSON.parse(JSON.stringify(p1));
  disabled.choices.scope = { provider: 'model_gone', model: 'x', effort: 'low' };
  const r2 = plan.readiness(plan.compileConfigPlan(disabled), catalog);
  assert.ok(r2.problems.some(p => p.reason === 'provider-unavailable'));

  const badEffort = JSON.parse(JSON.stringify(p1));
  badEffort.choices.final = { provider: 'deepseek', model: 'deepseek-flash', effort: 'xhigh' };
  const r3 = plan.readiness(plan.compileConfigPlan(badEffort), catalog);
  assert.ok(r3.problems.some(p => p.reason === 'effort-unsupported'));
});

test('生效态计划：被阻断的源会给出警告并降级覆盖状态', () => {
  const p1 = plan.compileConfigPlan(config('p1-review'));
  const partial = plan.deriveEffectivePlan(p1, { sources: { arxiv: 'blocked' } });
  assert.equal(partial.coverage, 'partial');
  assert.deepEqual(partial.blockedSources, ['arxiv']);
  assert.ok(partial.warnings.some(w => w.code === 'sources-blocked'));
  assert.match(partial.warnings.find(w => w.code === 'sources-blocked').message, /实际 3 源/);

  const restricted = plan.deriveEffectivePlan(p1, { sources: { openalex: 'restricted' } });
  assert.equal(restricted.coverage, 'restricted');
  assert.ok(restricted.warnings.some(w => w.code === 'sources-restricted'));

  const none = plan.deriveEffectivePlan(p1, { sources: { openalex: 'blocked', crossref: 'blocked', arxiv: 'blocked', pubmed: 'blocked' } });
  assert.equal(none.coverage, 'none');
  assert.ok(none.warnings.some(w => w.code === 'no-usable-source'));
});

test('教学档关闭检索时，检索环节仍列在计划里但被标为关闭', () => {
  const p2 = config('p2-teach');
  p2.retrieval.enabled = false;
  p2.evidence.allowGeneralTeaching = true;
  p2.budget.maxCalls = 6;
  const compiled = plan.compileConfigPlan(p2);
  assert.equal(compiled.stable.retrieval.enabled, false);
  const effective = plan.deriveEffectivePlan(compiled, {});
  assert.equal(effective.coverage, 'disabled');
  assert.equal(effective.warnings.length, 0);
});
