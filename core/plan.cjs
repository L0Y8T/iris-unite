/* 计划编译器：把配置翻译成"这一轮到底会执行什么、花多少次调用"。
 *
 * 依据 docs/research-mode-design.md §5.1：
 *   - `compileConfigPlan()` 必须是无模型调用、无网络、无文件写入的**纯计算**；
 *   - 配置 UI、架构图、阶段裁剪、就绪检查、预算计算、运行器、审计都读同一份计划；
 *   - 配置态计划（稳定）与生效态计划（含外部能力）必须分开，
 *     planVersion 只由配置态决定，能力变化不得改动它（§5.1 本次补强的四条规则）。
 */
const { createHash } = require('node:crypto');
const profiles = require('./profiles.cjs');

const PUBLISH_GATES = Object.freeze([
  'run-not-cancelled-or-expired',
  'budget-ledger-consistent',
  'fact-blocks-located-or-quarantined',
  'numeric-examples-verified-or-marked',
  'persisted-manifest-consistent'
]);

/* 模型侧被禁用的能力。T0 的含义写在这里，代码与文档同源。 */
const DISABLED_CAPABILITIES = Object.freeze([
  'execute-generated-code',
  'run-shell',
  'read-arbitrary-files',
  'network-from-model',
  'arbitrary-tool-call'
]);

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 某环节的扇出数量：explore 按任务数，sections 按章数，refine 按允许深化数，实验按 trial 上限。 */
function fanOutOf(nodeId, config) {
  if (nodeId === 'research-explore') return config.tasks.length;
  if (nodeId === 'research-refine') return Math.min(config.tasks.length, Number(config.refinement?.maxTasks ?? 2));
  if (nodeId === 'teaching-sections') return Number(config.teaching?.chapterCount ?? profiles.POLICY.teachingChapterDefault);
  if (nodeId === 'experiment-run') return profiles.normalizeExperiments(config).maxTrials;
  return 1;
}

/** 依赖与条件按 Profile 的固定模板展开，不让模型决定图结构。 */
function dependenciesOf(nodeId) {
  const table = {
    'research-scope': [],
    'research-sources': ['research-scope'],
    'research-evidence': ['research-sources'],
    'research-summarize': ['research-evidence'],
    'research-plan': ['research-evidence'],
    'research-explore': ['research-plan'],
    'research-screen': ['research-explore'],
    'research-refine': ['research-screen'],
    /* 实验族：设计 → 生成程序 → 训练评估 → 结果分析 → 记录。
       「调参」是 analyze 给出下一轮参数后再进 run，由运行器按 maxRounds 循环，图结构保持无环。 */
    'experiment-design': ['research-screen'],
    'experiment-build': ['experiment-design'],
    'experiment-run': ['experiment-build'],
    'experiment-analyze': ['experiment-run'],
    'experiment-report': ['experiment-analyze'],
    'teaching-outline': ['research-evidence'],
    'teaching-sections': ['teaching-outline'],
    'teaching-examples': ['teaching-sections'],
    'research-final': ['research-screen'],
    'research-verify': [],
    'research-audit': ['research-verify']
  };
  return [...(table[nodeId] || [])];
}

/** 生成某个节点的模型调用需求：只有 type=model 消耗模型预算；exec 走执行预算。 */
function callCostOf(nodeId, meta) {
  if (meta.type === 'local') return 0;
  if (meta.type === 'service') return 0;          // 检索消耗 HTTP 预算，不是模型调用
  if (meta.type === 'exec') return 0;             // 训练/评估消耗执行预算，不是模型调用
  if (nodeId === 'research-explore' || nodeId === 'teaching-sections') return 1; // 每个扇出单元 1 次
  if (nodeId === 'research-refine') return 1;
  if (nodeId === 'experiment-run') return 1;      // 每个 trial 由 analyze 决定，实际次数受预算裁剪
  return 1;
}

/* 节点条件：只有**配置自身**能决定的条件写在这里，外部能力（某个源此刻是否可用）
   不进入这里，那是 deriveEffectivePlan 的事，否则 planVersion 会随网络抖动。 */
const CONDITION_OF = Object.freeze({
  'research-sources': 'retrieval-enabled',
  'research-evidence': 'materials-available',
  'research-refine': 'refinement-selected',
  'experiment-design': 'experiments-enabled',
  'experiment-build': 'experiments-enabled',
  'experiment-run': 'experiments-enabled',
  'experiment-analyze': 'experiments-enabled',
  'experiment-report': 'experiments-enabled'
});

const CONDITION_EVALUATORS = Object.freeze({
  'retrieval-enabled': config => config.retrieval?.enabled !== false,
  'materials-available': config => config.retrieval?.enabled !== false,
  'refinement-selected': config => config.allowRefinement === true,
  'experiments-enabled': config => profiles.experimentsEnabled(config)
});

/** 条件节点的 required 一律为 false：被条件跳过时门禁不能要求它有产物。 */
const CONDITIONAL_NODES = Object.freeze(Object.keys(CONDITION_OF));

/* 接着跑实验时，这些环节沿用上一轮的结论，不再重跑：
   研究界定、资料库、证据、任务分解、并行研究、候选筛选、定向深化。 */
const CARRY_OVER_NODES = Object.freeze([
  'research-scope', 'research-sources', 'research-evidence', 'research-summarize',
  'research-plan', 'research-explore', 'research-screen', 'research-refine'
]);

/** 这一轮是不是「沿用上一轮、只跑实验」。 */
const isExperimentOnly = config => config?.resume?.mode === 'experiment-only';

/**
 * 按配置求值节点条件，得到这一轮真正要执行的节点。
 * 运行器、界面预览、审计都调这一个函数，避免三处各写一份判断。
 */
function activeNodes(plan, config) {
  const active = [];
  const skipped = [];
  const carrying = isExperimentOnly(config);
  for (const node of plan.nodes) {
    /* 沿用模式优先：这些环节上一轮已经跑过，重跑一次既花钱又可能换掉原来的结论。 */
    if (carrying && CARRY_OVER_NODES.includes(node.id)) {
      skipped.push({ id: node.id, condition: 'carry-over', label: node.label });
      continue;
    }
    const condition = CONDITION_OF[node.id] || null;
    const evaluator = condition ? CONDITION_EVALUATORS[condition] : null;
    if (evaluator && !evaluator(config)) skipped.push({ id: node.id, condition, label: node.label });
    else active.push(node);
  }
  return { active, skipped };
}

/**
 * 配置态计划。纯函数：同样输入必然得到同样的 planVersion。
 * @param {object} config 已通过 profiles.validateShape 的 v4 配置
 */
function compileConfigPlan(config) {
  if (!config || config.version !== 4) throw new Error('compileConfigPlan 需要 v4 配置');
  const shape = profiles.validateShape(config);
  const stages = profiles.stagesOf(config.profile, { allowRefinement: config.allowRefinement === true });
  const nodes = stages.map((id, index) => {
    const meta = profiles.STAGE_META[id];
    if (!meta) throw new Error(`未知环节：${id}`);
    const role = meta.role;
    return {
      id,
      order: index + 1,
      type: meta.type,
      label: meta.label,
      role,
      /* 条件节点被跳过时不能要求有产物，否则门禁会把「按配置跳过」判成失败。
         只有沿用模式（接着跑实验）才会放宽这些环节，正常轮次的必需性不变。 */
      required: !CONDITIONAL_NODES.includes(id) && !(isExperimentOnly(config) && CARRY_OVER_NODES.includes(id)),
      condition: CONDITION_OF[id] || null,
      fanOut: meta.type === 'model' || meta.type === 'exec' ? fanOutOf(id, config) : 1,
      callCost: callCostOf(id, meta),
      timeoutSec: meta.type === 'model' ? Number(config.budget.modelTimeoutSec ?? 300) : null,
      dependencies: dependenciesOf(id)
    };
  });
  // 末节点是 final（P1/P2）或 summarize（P0）；verify/audit 依赖它而不是固定 final
  const outputRole = profiles.PROFILE_INFO[config.profile].outputRole;
  const outputNode = nodes.find(n => n.role === outputRole);
  for (const node of nodes) {
    if (node.id === 'research-verify') node.dependencies = outputNode ? [outputNode.id] : [];
    /* 有实验族且实际启用时，整合环节必须建立在实验记录之上；实验关掉时仍依赖筛选。 */
    if (node.id === 'research-final' && profiles.experimentsEnabled(config) && nodes.some(n => n.id === 'experiment-report')) node.dependencies = ['experiment-report'];
  }

  const roleChoices = {};
  for (const role of profiles.rolesFor(config)) roleChoices[role] = config.choices[role] || null;
  if (config.choices.audit) roleChoices.audit = config.choices.audit;

  const base = profiles.baseCalls(config);
  const experimentPlan = profiles.normalizeExperiments(config);
  const stable = {
    policyVersion: profiles.POLICY.version,
    profile: config.profile,
    tier: shape.tier,
    nodes: nodes.map(n => ({ id: n.id, order: n.order, type: n.type, role: n.role, required: n.required, condition: n.condition, fanOut: n.fanOut })),
    roleChoices,
    taskIds: config.tasks.map(t => t.id),
    taskChoices: config.tasks.map(t => t.choice || null),
    retrieval: { enabled: shape.retrievalEnabled, sources: [...config.retrieval.sources], maxQueries: config.retrieval.maxQueries, maxRecordsPerSource: config.retrieval.maxRecordsPerSource, maxRecordsPerRun: config.retrieval.maxRecordsPerRun },
    teachingChapters: shape.chapters,
    experiments: { enabled: profiles.experimentsEnabled(config), maxTrials: experimentPlan.maxTrials, maxRounds: experimentPlan.maxRounds, templateId: experimentPlan.templateId },
    budget: { maxCalls: config.budget.maxCalls, wallClockSec: config.budget.wallClockSec, modelTimeoutSec: config.budget.modelTimeoutSec, maxConcurrentModels: config.budget.maxConcurrentModels },
    mech: { enabled: config.mech?.enabled === true, triggers: [...(config.mech?.triggers || [])], maxMechCalls: Number(config.mech?.maxMechCalls || 0) },
    /* 沿用模式改变了实际执行的节点集合，planVersion 必须跟着变，否则两轮不同的计划会被记成同一份。 */
    resume: isExperimentOnly(config) ? { mode: 'experiment-only', from: config.resume?.roundId || null } : null
  };

  return {
    planVersion: sha(stable).slice(0, 16),
    policyVersion: profiles.POLICY.version,
    profile: config.profile,
    profileName: profiles.PROFILE_INFO[config.profile].name,
    tier: shape.tier,
    outputRole,
    nodes,
    baseCalls: base,
    maxCalls: config.budget.maxCalls,
    maxOptionalCalls: Math.max(0, config.budget.maxCalls - base),
    reserve: profiles.requiredReserve(config),
    concurrency: config.budget.maxConcurrentModels,
    wallClockSec: config.budget.wallClockSec,
    evidencePolicy: { ...config.evidence },
    publishGates: [...PUBLISH_GATES],
    disabledCapabilities: [...DISABLED_CAPABILITIES],
    stable
  };
}

/**
 * 生效态计划：把外部能力叠在配置态计划上。
 * 只做"哪些源这次实际可用"的判定与警告，**不改变节点集合、不改 planVersion**。
 * @param {object} plan compileConfigPlan 的返回
 * @param {{sources?: object}} capabilities 源状态：{ [sourceId]: 'ok' | 'restricted' | 'blocked' }
 */
function deriveEffectivePlan(plan, capabilities = {}) {
  const configured = plan.stable.retrieval.sources;
  const state = capabilities?.sources || {};
  const sources = configured.map(id => {
    const raw = state[id] || 'ok';
    const availability = raw === 'blocked' ? 'blocked' : raw === 'restricted' ? 'restricted' : 'ok';
    return { id, availability };
  });
  const usable = sources.filter(s => s.availability !== 'blocked').map(s => s.id);
  const restricted = sources.filter(s => s.availability === 'restricted').map(s => s.id);
  const blocked = sources.filter(s => s.availability === 'blocked').map(s => s.id);
  const warnings = [];
  if (plan.stable.retrieval.enabled && usable.length === 0) warnings.push({ code: 'no-usable-source', message: '所有检索源当前不可用，本轮将只能返回证据不足报告' });
  else if (blocked.length) warnings.push({ code: 'sources-blocked', message: `已选 ${configured.length} 源，其中 ${blocked.length} 源因故跳过（${blocked.join('、')}），本轮实际 ${usable.length} 源` });
  if (restricted.length) warnings.push({ code: 'sources-restricted', message: `${restricted.join('、')} 处于受限匿名模式，覆盖率将被标为 restricted` });
  const capabilityDigest = sha({ sources }).slice(0, 16);
  return {
    planVersion: plan.planVersion,
    capabilityDigest,
    sources,
    usableSources: usable,
    restrictedSources: restricted,
    blockedSources: blocked,
    coverage: plan.stable.retrieval.enabled ? (usable.length === configured.length ? (restricted.length ? 'restricted' : 'full') : usable.length ? 'partial' : 'none') : 'disabled',
    warnings
  };
}

/** 就绪检查：活跃角色必须有可用的 provider/model。缺哪个要说清楚（§12.2）。 */
function readiness(plan, catalog) {
  const problems = [];
  const check = (label, choice) => {
    if (!choice) { problems.push({ role: label, reason: 'missing-choice', message: `${label} 未选择模型` }); return; }
    const models = catalog?.[choice.provider];
    if (!Array.isArray(models) || !models.length) { problems.push({ role: label, reason: 'provider-unavailable', message: `${label} 的通道已停用或未配置` }); return; }
    const model = models.find(m => m.id === choice.model);
    if (!model) { problems.push({ role: label, reason: 'model-unavailable', message: `${label} 的模型 ${choice.model} 不在该通道的可用目录中` }); return; }
    if (choice.effort && !model.efforts.includes(choice.effort)) problems.push({ role: label, reason: 'effort-unsupported', message: `${label} 的强度 ${choice.effort} 不被 ${model.name || model.id} 支持` });
  };
  for (const [role, choice] of Object.entries(plan.stable.roleChoices)) check(role, choice);
  for (const task of plan.stable.taskChoices || []) if (task) check('task', task);
  if (plan.profile === 'p1-review' && (!plan.stable.taskIds || !plan.stable.taskIds.length)) problems.push({ role: 'tasks', reason: 'missing-tasks', message: '综述档至少需要一项并行研究任务' });
  return { ok: problems.length === 0, problems };
}

module.exports = { compileConfigPlan, deriveEffectivePlan, readiness, activeNodes, CONDITION_OF, PUBLISH_GATES, DISABLED_CAPABILITIES };
