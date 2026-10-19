/* 三档科研 Profile 的规则表、默认模板与配置迁移。
 *
 * 依据 docs/research-mode-design.md：
 *   §4.1/§5.2 Profile 与阶段表、§9.1 预算公式、§10 配置 v4、§11.1 迁移规则。
 *
 * 本模块是**纯数据 + 纯函数**：不读文件、不发网络、不调模型。
 * 所有"这一档要做哪些环节、要几次调用、哪些角色必须可用"的判断都集中在这里，
 * 避免 UI、计划编译器、运行器、审计各自复制一份规则。
 */

const PROFILE_IDS = Object.freeze(['p0-query', 'p1-review', 'p2-teach']);

/* 本期已经能真跑起来的档位。教学档只做到"配置与计划可预览"，运行要等 M4。 */
const IMPLEMENTED_PROFILES = Object.freeze(['p0-query', 'p1-review']);

const isImplemented = profile => IMPLEMENTED_PROFILES.includes(profile);

const TIER_IDS = Object.freeze(['readonly', 'generate-only', 'local-exec', 'training']);

/* §10.3 / §9.2：本期固定上限。改动必须从这里改，不能只放大输入框。 */
const POLICY = Object.freeze({
  version: 1,               // policyVersion，进入计划与快照
  maxCallsCap: 24,          // §9.2 建议保留的硬上限
  minWallClockSec: 60,
  maxWallClockSec: 1200,
  defaultWallClockSec: 900,
  teachingChapters: [2, 4],
  teachingChapterDefault: 2,
  p1Tasks: [1, 4],
  /* 实验族上限：trial 是单次训练/评估运行，round 是「跑一轮 → 看指标 → 调参再跑」的轮次 */
  maxExperimentTrials: 12,
  maxExperimentRounds: 4,
  defaultExperimentTrials: 4,
  defaultExperimentRounds: 2
});

/* 角色 → 环节 id 的映射。角色名与配置里的 choices 键一致。 */
const ROLE_STAGE = Object.freeze({
  scope: 'research-scope',
  evidence: 'research-evidence',
  summarize: 'research-summarize',
  plan: 'research-plan',
  screen: 'research-screen',
  experimentDesign: 'experiment-design',
  experimentAnalyze: 'experiment-analyze',
  final: 'research-final',
  audit: 'research-audit',
  teachingOutline: 'teaching-outline',
  teachingSections: 'teaching-sections',
  teachingExamples: 'teaching-examples'
});

/* 各档的活跃模型角色（audit 为可选，单独处理）。
   tasks[].choice 不是角色，它按任务实例化。 */
const PROFILE_ROLES = Object.freeze({
  'p0-query': Object.freeze(['scope', 'evidence', 'summarize']),
  'p1-review': Object.freeze(['scope', 'evidence', 'plan', 'screen', 'experimentDesign', 'experimentAnalyze', 'final']),
  'p2-teach': Object.freeze(['scope', 'evidence', 'teachingOutline', 'teachingSections', 'teachingExamples', 'final'])
});

/* 各档执行的环节集合。p1-review 为 null 表示沿用完整十环节骨架。 */
const PROFILE_STAGES = Object.freeze({
  'p0-query': Object.freeze(['research-scope', 'research-sources', 'research-evidence', 'research-summarize', 'research-verify', 'research-audit']),
  'p1-review': null,
  'p2-teach': Object.freeze(['research-scope', 'research-sources', 'research-evidence', 'teaching-outline', 'teaching-sections', 'teaching-examples', 'research-final', 'research-verify', 'research-audit'])
});

/* 每档的阶段元信息（名称与落位），供计划、UI、架构图共用。 */
const STAGE_META = Object.freeze({
  'research-scope': { label: '研究界定', type: 'model', role: 'scope' },
  'research-sources': { label: '资料检索', type: 'service', role: null },
  'research-evidence': { label: '证据提取', type: 'model', role: 'evidence' },
  'research-summarize': { label: '要点汇总', type: 'model', role: 'summarize' },
  'research-plan': { label: '问题分解', type: 'model', role: 'plan' },
  'research-explore': { label: '并行研究', type: 'model', role: 'tasks' },
  'research-screen': { label: '候选筛选', type: 'model', role: 'screen' },
  'research-refine': { label: '定向深化', type: 'model', role: 'tasks' },
  'experiment-design': { label: '实验设计', type: 'model', role: 'experimentDesign' },
  'experiment-build': { label: '实验程序', type: 'local', role: null },
  'experiment-run': { label: '训练与评估', type: 'exec', role: null },
  'experiment-analyze': { label: '结果分析', type: 'model', role: 'experimentAnalyze' },
  'experiment-report': { label: '实验记录', type: 'local', role: null },
  'teaching-outline': { label: '教学大纲', type: 'model', role: 'teachingOutline' },
  'teaching-sections': { label: '分节生成', type: 'model', role: 'teachingSections' },
  'teaching-examples': { label: '例题审查', type: 'model', role: 'teachingExamples' },
  'research-final': { label: '反证与整合', type: 'model', role: 'final' },
  'research-verify': { label: '引用核验', type: 'local', role: null },
  'research-audit': { label: '终审自检', type: 'local', role: null }
});

const PROFILE_INFO = Object.freeze({
  'p0-query': Object.freeze({ id: 'p0-query', name: '速查', outputRole: 'summarize', retrievalRequired: true, refinementAllowed: false, tasks: [0, 0] }),
  'p1-review': Object.freeze({ id: 'p1-review', name: '综述', outputRole: 'final', retrievalRequired: false, refinementAllowed: true, tasks: POLICY.p1Tasks }),
  'p2-teach': Object.freeze({ id: 'p2-teach', name: '教学', outputRole: 'final', retrievalRequired: false, refinementAllowed: false, tasks: [0, 0] })
});

const isProfile = value => PROFILE_IDS.includes(value);

/** 某档的活跃角色（不含可选 audit）。 */
function activeRoles(profile) {
  if (!isProfile(profile)) throw new Error(`未知的 Profile：${profile}`);
  return [...PROFILE_ROLES[profile]];
}

/* 实验族的两个角色只在实验启用时才需要模型：关掉实验不该逼用户给它们选模型。 */
const EXPERIMENT_ROLES = Object.freeze(['experimentDesign', 'experimentAnalyze']);

/** 当前配置真正需要的模型角色：activeRoles 去掉未启用的实验角色。 */
function rolesFor(config) {
  const roles = activeRoles(config?.profile);
  if (experimentsEnabled(config)) return roles;
  return roles.filter(role => !EXPERIMENT_ROLES.includes(role));
}

/** 某档要执行的环节 id。p1-review 返回完整骨架。 */
function stagesOf(profile, { allowRefinement = true } = {}) {
  if (!isProfile(profile)) throw new Error(`未知的 Profile：${profile}`);
  if (profile === 'p1-review') {
    const all = ['research-scope', 'research-sources', 'research-evidence', 'research-plan', 'research-explore', 'research-screen'];
    if (allowRefinement) all.push('research-refine');
    // 实验族：只对综述档开放，且由配置里的 experiments.enabled 决定是否真正执行
    all.push('experiment-design', 'experiment-build', 'experiment-run', 'experiment-analyze', 'experiment-report');
    all.push('research-final', 'research-verify', 'research-audit');
    return all;
  }
  return [...PROFILE_STAGES[profile]];
}

/**
 * 基准模型调用数（正常成功路径，不含可选深化/修复/重试）。
 * 公式见 §9.1：
 *   P0 = 3（scope/evidence/summarize）
 *   P1 = N + 5（有检索）或 N + 4（旧版无检索兼容）
 *   P2 = C + 5（有检索）或 C + 4（显式无资料教学）
 * 启用 audit 时额外 +1。
 */
function baseCalls(config) {
  const profile = config.profile;
  const retrieval = config.retrieval?.enabled !== false;
  const audit = config.choices?.audit ? 1 : 0;
  /* 实验族只多花两次模型调用：设计一次、每轮结果分析一次；训练与评估走执行预算，不占模型预算。 */
  const experimentCalls = experimentModelCalls(config);
  /* 接着跑实验的一轮沿用上一轮的界定/证据/任务分解，只花整合一次 + 实验那几次。 */
  if (config.resume?.mode === 'experiment-only') return 1 + audit + experimentCalls;
  if (profile === 'p0-query') return 3 + audit;
  if (profile === 'p1-review') return (config.tasks?.length || 0) + (retrieval ? 5 : 4) + audit + experimentCalls;
  if (profile === 'p2-teach') {
    const chapters = Number(config.teaching?.chapterCount) || POLICY.teachingChapterDefault;
    return chapters + (retrieval ? 5 : 4) + audit;
  }
  throw new Error(`未知的 Profile：${profile}`);
}

/** 实验族是否启用。只看综述档：速查要求快，教学不跑实验。 */
function experimentsEnabled(config) {
  if (config?.profile !== 'p1-review') return false;
  return config?.experiments?.enabled === true;
}

/** 实验配置归一：缺省值与上下界都在这里定，运行器与界面只读结果，不各自判断。 */
function normalizeExperiments(config) {
  const raw = config?.experiments || {};
  const trials = Number(raw.maxTrials ?? POLICY.defaultExperimentTrials);
  const rounds = Number(raw.maxRounds ?? POLICY.defaultExperimentRounds);
  return {
    enabled: raw.enabled === true,
    maxTrials: Math.min(POLICY.maxExperimentTrials, Math.max(1, Number.isInteger(trials) ? trials : POLICY.defaultExperimentTrials)),
    maxRounds: Math.min(POLICY.maxExperimentRounds, Math.max(1, Number.isInteger(rounds) ? rounds : POLICY.defaultExperimentRounds)),
    templateId: typeof raw.templateId === 'string' && raw.templateId ? raw.templateId : null,
    stopWhen: typeof raw.stopWhen === 'string' && raw.stopWhen ? raw.stopWhen.slice(0, 200) : '指标不再提升或达到 trial 上限'
  };
}

/** 实验族要花掉多少次模型调用（实验设计 1 次 + 每轮结果分析 1 次）。执行不在此列。 */
function experimentModelCalls(config) {
  if (!experimentsEnabled(config)) return 0;
  return 1 + normalizeExperiments(config).maxRounds;
}

/** 必须为最终输出预留的调用数（含已启用的 audit）。 */
function requiredReserve(config) {
  return 1 + (config.choices?.audit ? 1 : 0);
}

/** 配置校验：只做结构语义，不碰目录与网络。目录关联由调用方补。 */
function validateShape(config) {
  if (!config || typeof config !== 'object') throw new Error('科研配置无效');
  if (!isProfile(config.profile)) throw new Error(`未知的 Profile：${config.profile}`);
  const tier = config.tier ?? 'readonly';
  if (!TIER_IDS.includes(tier)) throw new Error(`未知的 Tier：${tier}`);
  if (tier !== 'readonly') throw new Error('本期只开放 readonly（不执行任何生成代码），其他 Tier 尚未实现');

  const info = PROFILE_INFO[config.profile];
  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  const [minTasks, maxTasks] = info.tasks;
  if (tasks.length < minTasks || tasks.length > maxTasks) {
    throw new Error(config.profile === 'p1-review'
      ? `综述需要 ${minTasks}–${maxTasks} 项并行任务，当前 ${tasks.length} 项`
      : `${info.name}档不并行研究任务，请清空任务列表（当前 ${tasks.length} 项）`);
  }
  if (config.profile !== 'p1-review' && config.allowRefinement) throw new Error(`${info.name}档不支持定向深化，请勿开启 allowRefinement`);
  if (config.profile === 'p1-review' && typeof config.allowRefinement !== 'boolean') throw new Error('综述档需要显式布尔值 allowRefinement');

  if (config.experiments?.enabled === true && config.profile !== 'p1-review') {
    throw new Error(`${info.name}档不支持自动实验，请关闭 experiments.enabled`);
  }
  if (config.experiments?.enabled === true) {
    if (Number(config.experiments.maxTrials) > POLICY.maxExperimentTrials) throw new Error(`实验运行次数上限不得超过 ${POLICY.maxExperimentTrials}`);
    if (Number(config.experiments.maxRounds) > POLICY.maxExperimentRounds) throw new Error(`实验调参轮次上限不得超过 ${POLICY.maxExperimentRounds}`);
  }

  const retrievalEnabled = config.retrieval?.enabled !== false;
  if (info.retrievalRequired && !retrievalEnabled) throw new Error(`${info.name}档必须启用资料检索`);
  if (!retrievalEnabled && config.profile === 'p2-teach' && config.evidence?.allowGeneralTeaching !== true) {
    throw new Error('教学档关闭检索时需要显式允许无外部资料教学（evidence.allowGeneralTeaching=true）');
  }

  if (config.profile === 'p2-teach') {
    const chapters = Number(config.teaching?.chapterCount ?? POLICY.teachingChapterDefault);
    const [lo, hi] = POLICY.teachingChapters;
    if (!Number.isInteger(chapters) || chapters < lo || chapters > hi) throw new Error(`教学章数需在 ${lo}–${hi} 之间`);
  }

  const base = baseCalls(config);
  const cap = Number(config.budget?.maxCalls);
  if (!Number.isInteger(cap) || cap < base) throw new Error(`调用上限需 ≥ 本档基准调用数 ${base} 次`);
  if (cap > POLICY.maxCallsCap) throw new Error(`调用上限不得超过 ${POLICY.maxCallsCap} 次`);

  const wall = Number(config.budget?.wallClockSec ?? POLICY.defaultWallClockSec);
  if (!Number.isInteger(wall) || wall < POLICY.minWallClockSec || wall > POLICY.maxWallClockSec) {
    throw new Error(`本轮时间上限需在 ${POLICY.minWallClockSec}–${POLICY.maxWallClockSec} 秒之间`);
  }
  const modelTimeout = Number(config.budget?.modelTimeoutSec ?? 300);
  if (!Number.isInteger(modelTimeout) || modelTimeout <= 0 || modelTimeout > wall) throw new Error('单模型请求期限必须为正且不得大于本轮时间上限');

  return {
    profile: config.profile,
    tier,
    baseCalls: base,
    reserve: requiredReserve(config),
    retrievalEnabled,
    chapters: config.profile === 'p2-teach' ? Number(config.teaching?.chapterCount ?? POLICY.teachingChapterDefault) : 0
  };
}

/** v2/v3 → v4 的确定性迁移。纯函数：输入深拷贝、输出新对象与迁移报告。 */
function migrateConfig(input, { catalog } = {}) {
  if (!input || typeof input !== 'object') throw new Error('科研配置无效');
  if (Number(input.version) >= 4) {
    if (!isProfile(input.profile)) throw new Error('v4 配置缺少有效的 profile');
    return { config: clone(input), report: { from: Number(input.version), changed: [], legacyUnretrieved: false } };
  }
  const changed = [];
  const legacy = Number(input.version) === 2 || !input.choices;
  // v2 结构：orchestrator/reviewer；v3 结构：choices
  const planChoice = legacy ? input.orchestrator : input.choices?.plan;
  const screenChoice = legacy ? input.orchestrator : input.choices?.screen;
  const finalChoice = legacy ? input.reviewer : input.choices?.final;
  const scopeChoice = legacy ? input.orchestrator : input.choices?.scope;
  const evidenceChoice = legacy ? input.orchestrator : input.choices?.evidence;

  const retrievalEnabled = input.retrieval?.enabled !== false;
  const perSource = Number(input.retrieval?.perSource ?? 10);
  const config = {
    version: 4,
    profile: 'p1-review',
    tier: 'readonly',
    choices: {
      scope: scopeChoice ?? null,
      evidence: evidenceChoice ?? null,
      plan: planChoice ?? null,
      screen: screenChoice ?? null,
      final: finalChoice ?? null,
      audit: input.choices?.audit ?? null,
      summarize: input.choices?.summarize ?? null,
      teachingOutline: input.choices?.teachingOutline ?? null,
      teachingSections: input.choices?.teachingSections ?? null,
      teachingExamples: input.choices?.teachingExamples ?? null
    },
    tasks: Array.isArray(input.tasks) ? clone(input.tasks) : [],
    allowRefinement: input.allowRefinement === true,
    refinement: { maxTasks: 2, maxPassesPerTask: 1 },
    /* 迁移时关闭自动实验：旧配置从未授权跑训练，不擅自开始消耗算力。
       用户在配置面板打开后即生效（报告里会写明这条迁移）。 */
    experiments: {
      enabled: false,
      maxTrials: POLICY.defaultExperimentTrials,
      maxRounds: POLICY.defaultExperimentRounds,
      templateId: null,
      stopWhen: '指标不再提升或达到 trial 上限'
    },
    teaching: {
      audience: '有基础的初学者',
      prerequisites: [],
      learningGoal: '理解概念及适用边界',
      chapterCount: POLICY.teachingChapterDefault,
      chapterChoices: {},
      numericPolicy: 'builtin-arithmetic-only'
    },
    retrieval: {
      // perSource 在旧版同时充当合并上限，这里两边都写，以保留旧实际截断行为（§11.1）
      enabled: retrievalEnabled,
      sources: Array.isArray(input.retrieval?.sources) ? [...input.retrieval.sources] : ['openalex', 'crossref', 'arxiv', 'pubmed'],
      maxQueries: Number(input.retrieval?.maxQueries ?? 4),
      maxRecordsPerSource: perSource,
      maxRecordsPerQuery: perSource,
      maxRecordsPerRun: 240,
      maxRequests: 40,
      maxRetriesPerRequest: 1,
      yearFrom: input.retrieval?.yearFrom ?? null,
      yearTo: null,
      reusePolicy: 'explicit-selection'
    },
    evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
    budget: {
      maxCalls: Number(input.maxCalls ?? 8),
      wallClockSec: 1200,     // 旧固定 20 分钟，按 §10.2 映射为原值而不是示例 15 分钟
      modelTimeoutSec: 300,
      maxConcurrentModels: 2,
      maxModelRetryAttempts: 0,
      maxRepairAttempts: 0
    },
    monitor: { enabled: input.monitor?.enabled !== false, stallPolicy: 'warn-then-stop' },
    mech: { enabled: false, provider: null, model: null, effort: null, triggers: [], maxAttemptsPerNode: 1, maxMechCalls: 0, outputPolicy: 'candidate-only', onInvalidOutput: 'fallback-deterministic' },
    output: { language: 'zh-CN', processPanelDefault: 'collapsed' }
  };
  changed.push('version:3→4', 'profile:=p1-review', 'budget.maxCalls←maxCalls', 'budget.wallClockSec:=1200');
  if (!retrievalEnabled) changed.push('migration.legacyUnretrieved=true');
  // 旧预算可能低于新版基准，这里如实标记，不自动加钱（§11.1）
  const base = baseCalls(config);
  const report = {
    from: Number(input.version) || 2,
    changed,
    baseCalls: base,
    budgetShortfall: config.budget.maxCalls < base ? base - config.budget.maxCalls : 0,
    legacyUnretrieved: !retrievalEnabled
  };
  if (report.budgetShortfall) report.changed.push(`budget.insufficient:缺 ${report.budgetShortfall} 次`);
  return { config, report };
}

/** 每档的默认配置模板。catalog 只用于挑一个存在的模型，不做能力探测。 */
function defaultsFor(profile, catalog, pickModel) {
  if (!isProfile(profile)) throw new Error(`未知的 Profile：${profile}`);
  const pick = typeof pickModel === 'function' ? pickModel : () => null;
  const strong = pick(['high', 'max', 'medium', 'default', 'low']) || null;
  const cheap = pick(['low', 'off', 'default', 'medium', 'high']) || strong;
  const deep = pick(['xhigh', 'max', 'high', 'medium', 'default', 'low']) || strong;
  const base = {
    version: 4,
    profile,
    tier: 'readonly',
    choices: {
      scope: cheap ?? null,
      evidence: strong ?? null,
      plan: null,
      screen: null,
      final: deep ?? null,
      audit: null,
      summarize: cheap ?? null,
      /* 实验设计与结果分析都要判断力：默认与统筹同一档强模型，用户可单独改。 */
      experimentDesign: profile === 'p1-review' ? (strong ?? null) : null,
      experimentAnalyze: profile === 'p1-review' ? (strong ?? null) : null,
      teachingOutline: strong ?? null,
      teachingSections: strong ?? null,
      teachingExamples: cheap ?? null
    },
    tasks: [],
    allowRefinement: profile === 'p1-review',
    refinement: { maxTasks: 2, maxPassesPerTask: 1 },
    /* 新对话默认打开自动实验（综述档）：研究任务应当能自己设计实验并调参。
       历史配置迁移时默认关闭——见 migrateConfig，理由是不替旧对话擅自消耗算力。 */
    experiments: {
      enabled: profile === 'p1-review',
      maxTrials: POLICY.defaultExperimentTrials,
      maxRounds: POLICY.defaultExperimentRounds,
      templateId: null,
      stopWhen: '指标不再提升或达到 trial 上限'
    },
    teaching: {
      audience: '有基础的初学者',
      prerequisites: [],
      learningGoal: '理解概念及适用边界',
      chapterCount: POLICY.teachingChapterDefault,
      chapterChoices: {},
      numericPolicy: 'builtin-arithmetic-only'
    },
    retrieval: {
      enabled: true,
      sources: ['openalex', 'crossref', 'arxiv', 'pubmed'],
      maxQueries: 4,
      maxRecordsPerSource: 10,
      maxRecordsPerQuery: 10,
      maxRecordsPerRun: 240,
      maxRequests: 40,
      maxRetriesPerRequest: 1,
      yearFrom: null,
      yearTo: null,
      reusePolicy: 'explicit-selection'
    },
    evidence: { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false },
    budget: {
      maxCalls: 0,
      wallClockSec: POLICY.defaultWallClockSec,
      modelTimeoutSec: 300,
      maxConcurrentModels: 2,
      maxModelRetryAttempts: 0,
      maxRepairAttempts: 0
    },
    monitor: { enabled: true, stallPolicy: 'warn-then-stop' },
    mech: { enabled: false, provider: null, model: null, effort: null, triggers: [], maxAttemptsPerNode: 1, maxMechCalls: 0, outputPolicy: 'candidate-only', onInvalidOutput: 'fallback-deterministic' },
    output: { language: 'zh-CN', processPanelDefault: 'collapsed' }
  };
  if (profile === 'p1-review') {
    base.choices.plan = strong ?? null;
    base.choices.screen = strong ?? null;
    base.tasks = [
      { id: 'concepts', title: '概念与分类', brief: '按可比条件梳理概念、方法与证据类型，指出适用范围。', choice: cheap ?? null },
      { id: 'limits', title: '反例与局限', brief: '检查外推边界、相反证据与方法局限。', choice: deep ?? null }
    ];
    base.budget.maxCalls = baseCalls(base) + 1;   // N=2 时 8：允许一次可选深化
  } else {
    base.budget.maxCalls = baseCalls(base);
  }
  /* 本档用不到的角色一律置空：避免界面上出现「速查档还挂着一个反证模型」这种陈值。 */
  for (const role of Object.keys(ROLE_STAGE)) {
    if (role !== 'audit' && !PROFILE_ROLES[profile].includes(role)) base.choices[role] = null;
  }
  return base;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  PROFILE_IDS,
  IMPLEMENTED_PROFILES,
  isImplemented,
  TIER_IDS,
  POLICY,
  ROLE_STAGE,
  PROFILE_ROLES,
  PROFILE_STAGES,
  PROFILE_INFO,
  STAGE_META,
  isProfile,
  activeRoles,
  rolesFor,
  EXPERIMENT_ROLES,
  stagesOf,
  baseCalls,
  experimentsEnabled,
  normalizeExperiments,
  experimentModelCalls,
  requiredReserve,
  validateShape,
  migrateConfig,
  defaultsFor
};
