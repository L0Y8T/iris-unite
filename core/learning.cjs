/* 学习模式的机械层：知识点 → 依赖图 → 拓扑分层 → 学习阶段 → 自测题 → 计划正文。
 *
 * 为什么这些判断必须写在代码里，而不是交给模型：
 *   1. 排序必须是确定性的。让模型顺手把学习顺序一起写了，同一份知识点跑两次会得到
 *      两个顺序，用户第二次打开计划就发现路径变了。变了就不是计划，是一次性回复。
 *      模型只回答「有哪些知识点」和「谁依赖谁」，排序、分层、分阶段全部由本模块算。
 *   2. 破环必须可解释。知识点之间出现循环依赖是常见模型输出（A 依赖 B，B 又依赖 A），
 *      让模型自己"调和"会悄悄丢掉一条边。这里用确定性的 DFS 找后向边并记录，
 *      丢掉哪条、为什么丢，都能在产物里指出来。
 *   3. 先修可以机械判定。用户声明「我已会概率论」，就该把匹配到的知识点从主路径挪到
 *      「已有基础」，而不是每次靠模型理解这句话。
 *
 * 本模块是**纯函数**：不读文件、不发网络、不调模型。所有规则一条命令就能跑完测试。
 */

const MAX_POINTS = 30;
const MIN_POINTS = 3;
const DEFAULT_STAGE_COUNT = 2;

const LEVEL_LABELS = Object.freeze(['入门', '基础', '进阶', '前沿']);

/* 难度归一表。模型可能写「入门」「beginner」「L1」「1」，都落到 1..4。
   只做包含匹配时按字数从长到短试，避免「进阶」先被「级」吃掉这类误配。 */
const LEVEL_WORDS = Object.freeze([
  ['入门', 1], ['初学', 1], ['零基础', 1], ['introductory', 1], ['intro', 1], ['beginner', 1], ['basic-1', 1],
  ['基础', 2], ['fundamental', 2], ['foundation', 2], ['basic', 2],
  ['进阶', 3], ['中级', 3], ['intermediate', 3], ['advanced', 3],
  ['前沿', 4], ['高级', 4], ['研究级', 4], ['expert', 4], ['frontier', 4]
]);

const stringSchema = { type: 'string' };
const stringArray = { type: 'array', items: stringSchema };

/** 知识点拆解：模型只回答「有哪些点、谁先修、出处是哪几条记录」。 */
const POINTS_SCHEMA = {
  type: 'object',
  properties: {
    topic: stringSchema,
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: stringSchema,
          name: stringSchema,
          summary: stringSchema,
          difficulty: stringSchema,
          requires: stringArray,
          evidenceKeys: stringArray,
          why: stringSchema
        },
        required: ['id', 'name', 'summary', 'difficulty', 'requires', 'evidenceKeys', 'why'],
        additionalProperties: false
      }
    }
  },
  required: ['topic', 'points'],
  additionalProperties: false
};

/** 单个学习阶段：这里要的是「学完能做到什么」，不是章节正文。 */
const STAGE_SCHEMA = {
  type: 'object',
  properties: {
    title: stringSchema,
    objective: stringSchema,
    keyQuestions: stringArray,
    milestones: stringArray,
    pitfalls: stringArray,
    materials: stringArray
  },
  required: ['title', 'objective', 'keyQuestions', 'milestones', 'pitfalls', 'materials'],
  additionalProperties: false
};

/** 自测题：每题必须能指回一个知识点，并给出参考答案与判分口径。 */
const SELFTEST_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pointId: stringSchema,
          question: stringSchema,
          answer: stringSchema,
          check: stringSchema,
          difficulty: stringSchema
        },
        required: ['pointId', 'question', 'answer', 'check', 'difficulty'],
        additionalProperties: false
      }
    }
  },
  required: ['questions'],
  additionalProperties: false
};

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const text = (value, max = 600) => (typeof value === 'string' ? value : value == null ? '' : String(value))
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

function listOf(value, { max = 40, size = 200 } = {}) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    const one = text(typeof item === 'object' && item ? (item.id ?? item.name ?? item.text ?? '') : item, size);
    if (one && !out.includes(one)) out.push(one);
    if (out.length >= max) break;
  }
  return out;
}

/** 难度归一：数字、中文、英文、L1 这类别名都落到 1..4，认不出按 2（基础）。 */
function levelOf(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 4) return numeric;
  const raw = text(value, 24).toLowerCase().replace(/^l(?=\d)/, '');
  if (!raw) return 2;
  if (/^[1-4]$/.test(raw)) return Number(raw);
  for (const [word, level] of LEVEL_WORDS) if (raw.includes(word)) return level;
  return 2;
}

const levelLabel = level => LEVEL_LABELS[Math.max(1, Math.min(4, Number(level) || 2)) - 1];

/** 知识点 id：只保留小写字母数字与连字符，别的字符一律折叠掉。
 *  一个字母的 id（a、b）是合法输入，别把用户/模型的短记法当成非法值。 */
function slug(value, fallback) {
  const raw = text(value, 60).toLowerCase().replace(/[^a-z0-9\-\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  const ascii = raw.replace(/[^a-z0-9-]+/g, '');
  return ascii.length >= 1 ? ascii.slice(0, 24) : fallback;
}

const norm = value => text(value, 120).toLowerCase().replace(/[\s·・、,，.。:：;；()[\]{}"'“”‘’《》\-_/\\]+/g, '');

/** 键归一：S1 / s1 / [S1] 都算 S1。 */
const keyOf = value => text(value, 20).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/* ── 1. 知识点归一 ──────────────────────────────────────────────────────── */

/**
 * 把模型返回的知识点揉成可信的结构。所有异常都就地修，不抛错：
 * 一次拆解失败不该让整轮学习计划作废，缺一条知识点比没有计划好。
 *
 * @param {object|Array} raw 模型输出（`{ topic, points }` 或裸数组都接受）
 * @param {{evidenceKeys?: Set<string>|string[], limit?: number}} options
 *   evidenceKeys 为本轮资料库里真实存在的键集合；给了就剔除不存在的键，不给就全保留。
 */
function normalizePoints(raw, { evidenceKeys = null, limit = MAX_POINTS } = {}) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.points) ? raw.points : [];
  const allowed = evidenceKeys == null
    ? null
    : evidenceKeys instanceof Set ? evidenceKeys : new Set([...evidenceKeys].map(keyOf).filter(Boolean));
  const cap = Math.max(MIN_POINTS, Math.min(MAX_POINTS, Number.isInteger(limit) && limit > 0 ? limit : MAX_POINTS));
  const points = [];
  const dropped = [];
  const repaired = [];
  const seenIds = new Set();
  const seenNames = new Set();

  source.forEach((item, index) => {
    if (points.length >= cap) return;
    const name = text(typeof item === 'string' ? item : item?.name ?? item?.title ?? item?.point, 80);
    if (!name) { dropped.push({ index, reason: '缺少名称' }); return; }
    const dedupe = norm(name);
    if (seenNames.has(dedupe)) { dropped.push({ index, name, reason: '同名知识点重复' }); return; }
    seenNames.add(dedupe);

    let id = slug(item?.id ?? item?.key, '');
    if (!id) { id = `kp-${points.length + 1}`; repaired.push({ index, field: 'id', note: `缺少可用 id，按顺序补成 ${id}` }); }
    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}-${suffix}`)) suffix += 1;
      repaired.push({ index, field: 'id', note: `${id} 重复，改为 ${id}-${suffix}` });
      id = `${id}-${suffix}`;
    }
    seenIds.add(id);

    const rawKeys = listOf(item?.evidenceKeys ?? item?.keys ?? item?.sources, { max: 20, size: 24 }).map(keyOf).filter(Boolean);
    let keys = rawKeys;
    if (allowed) {
      keys = rawKeys.filter(key => allowed.has(key));
      const removed = rawKeys.filter(key => !allowed.has(key));
      if (removed.length) repaired.push({ index, field: 'evidenceKeys', note: `剔除资料库里不存在的键：${removed.join('、')}` });
    }

    const level = levelOf(item?.difficulty ?? item?.level);
    if (!Number.isInteger(Number(item?.difficulty)) && !LEVEL_LABELS.includes(text(item?.difficulty, 12))) {
      const raw = text(item?.difficulty ?? item?.level, 12);
      if (raw && levelOf(raw) !== 2) repaired.push({ index, field: 'difficulty', note: `难度「${raw}」归一为 ${levelLabel(level)}` });
    }

    points.push({
      id,
      name,
      summary: text(item?.summary ?? item?.description ?? item?.what, 600),
      level,
      levelLabel: levelLabel(level),
      requires: listOf(item?.requires ?? item?.prerequisites ?? item?.dependsOn, { max: 20, size: 40 }).map(value => slug(value, '')).filter(Boolean),
      evidenceKeys: keys,
      why: text(item?.why ?? item?.reason ?? item?.use ?? '', 300),
      index,
      assumed: false
    });
  });

  return {
    topic: text(Array.isArray(raw) ? '' : raw?.topic ?? raw?.subject ?? '', 120),
    points,
    dropped,
    repaired,
    truncated: source.length > points.length + dropped.length,
    limit: cap
  };
}

/* ── 2. 依赖图 ──────────────────────────────────────────────────────────── */

/**
 * 把 requires 变成真实的边：去自环、去悬空（指向不存在的知识点）、去重。
 * 这三件都必须留痕——模型指着不存在的点说「先学它」，直接吞掉会让用户以为依赖满足了。
 */
function linkPoints(points) {
  const ids = new Set(points.map(point => point.id));
  const dangling = [];
  const selfLoops = [];
  const linked = points.map(point => {
    const requires = [];
    for (const ref of point.requires || []) {
      if (ref === point.id) { selfLoops.push({ from: point.id, to: ref }); continue; }
      if (!ids.has(ref)) { dangling.push({ from: point.id, to: ref }); continue; }
      if (!requires.includes(ref)) requires.push(ref);
    }
    return { ...point, requires };
  });
  return { points: linked, dangling, selfLoops };
}

/**
 * 破环：按原始顺序做 DFS，遇到指向「正在访问」的节点的边就判定为后向边并删除。
 *
 * 为什么不是随便删一条：DFS 删的这条边在原始书写顺序里指向更早的祖先，
 * 保留下来的边都符合「先学的点排在前面」，与用户的直觉一致，而且结果可复现。
 */
function breakCycles(points) {
  const byId = new Map(points.map(point => [point.id, point]));
  const order = points.map(point => point.id);
  const state = new Map();          // id -> 1 访问中 / 2 已完成
  const removed = [];
  const dropped = new Set();        // "from->to"

  const visit = id => {
    state.set(id, 1);
    const point = byId.get(id);
    for (const ref of point?.requires || []) {
      if (dropped.has(`${id}->${ref}`)) continue;
      const mark = state.get(ref);
      if (mark === 1) { dropped.add(`${id}->${ref}`); removed.push({ from: id, to: ref, reason: 'cycle', note: `${id} 与 ${ref} 互相依赖，断开 ${id}→${ref}` }); continue; }
      if (mark === undefined) visit(ref);
    }
    state.set(id, 2);
  };
  for (const id of order) if (state.get(id) === undefined) visit(id);

  return {
    points: points.map(point => ({ ...point, requires: point.requires.filter(ref => !dropped.has(`${point.id}->${ref}`)) })),
    removed
  };
}

/**
 * 拓扑分层：层号 = 1 + 依赖里最深的层号。同层内部按难度升序、再按原始顺序。
 * 前提是图已经无环（先过 breakCycles），有环时会兜底把剩下的点放进 `cyclic` 而不是悄悄丢。
 */
function topoLayers(points) {
  const byId = new Map(points.map(point => [point.id, point]));
  const depth = new Map();
  const order = [];

  const depthOf = id => {
    if (depth.has(id)) return depth.get(id);
    const point = byId.get(id);
    if (!point) return 0;
    depth.set(id, 1);                       // 占位，防止意外的环把递归打爆
    let best = 0;
    for (const ref of point.requires) best = Math.max(best, depthOf(ref));
    const value = best + 1;
    depth.set(id, value);
    return value;
  };
  for (const point of points) depthOf(point.id);

  const flat = [...points].sort((a, b) => (depth.get(a.id) - depth.get(b.id)) || (a.level - b.level) || (a.index - b.index));
  for (const point of flat) order.push(point.id);

  const layers = [];
  for (const point of flat) {
    const layer = depth.get(point.id);
    while (layers.length < layer) layers.push([]);
    layers[layer - 1].push(point.id);
  }
  return { depth, order, layers: layers.map(ids => ids.filter(Boolean)) };
}

/* ── 3. 先修检查 ────────────────────────────────────────────────────────── */

/**
 * 用户声明「我已会 X」时，把匹配到的知识点标成 assumed（已有基础）。
 *
 * 匹配规则保守：要求归一后的字符串互相包含且长度 ≥ 2。宁可少匹配（多学一个已会的点，
 * 代价是几分钟），也不要错匹配（把没学的点当成已会，后面整段路径都塌了）。
 */
function markKnown(points, known = []) {
  const phrases = listOf(known, { max: 12, size: 60 }).map(value => ({ raw: value, normalized: norm(value) })).filter(item => item.normalized.length >= 2);
  const matched = [];
  const used = new Set();
  const marked = points.map(point => {
    const name = norm(point.name);
    const summary = norm(point.summary);
    const hit = phrases.find(item => !used.has(item.raw) && (
      (name.length >= 2 && (name.includes(item.normalized) || item.normalized.includes(name))) ||
      (summary.length >= 2 && item.normalized.length >= 3 && summary.includes(item.normalized))
    ));
    if (!hit) return point;
    used.add(hit.raw);
    matched.push({ id: point.id, name: point.name, by: hit.raw });
    return { ...point, assumed: true, assumedBy: hit.raw };
  });
  return { points: marked, matched, unmatched: phrases.filter(item => !used.has(item.raw)).map(item => item.raw) };
}

/* ── 4. 分阶段 ──────────────────────────────────────────────────────────── */

/**
 * 把拓扑序切成 k 个连续块，每块就是一个学习阶段。
 *
 * 为什么连续块一定满足依赖：拓扑序里每个点的依赖都排在它前面，所以第 i 块里任一点的
 * 依赖要么也在第 i 块（且更靠前），要么在更早的块。绝不会落到后面的块里去。
 *
 * 余数分给靠后的阶段：入门段通常点少而密，进阶段点少而深，尾部多分一个更自然。
 */
function planStages(points, { stageCount = DEFAULT_STAGE_COUNT } = {}) {
  const active = points.filter(point => !point.assumed);
  const { layers, order, depth } = topoLayers(active);
  const total = active.length;
  const wanted = Number.isInteger(stageCount) && stageCount > 0 ? stageCount : DEFAULT_STAGE_COUNT;
  const deviations = [];
  if (!total) {
    return { stages: [], order: [], layers, deviations: [{ code: 'no-points', message: '没有可排入阶段的知识点' }] };
  }
  let count = Math.max(1, Math.min(wanted, total));
  if (count < wanted) deviations.push({ code: 'stage-count-clamped', message: `只有 ${total} 个知识点，阶段数从 ${wanted} 收敛到 ${count}` });

  const base = Math.floor(total / count);
  const remainder = total % count;
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(base + (i >= count - remainder ? 1 : 0));

  const byId = new Map(active.map(point => [point.id, point]));
  const stages = [];
  let cursor = 0;
  sizes.forEach((size, index) => {
    const pointIds = order.slice(cursor, cursor + size);
    cursor += size;
    const members = pointIds.map(id => byId.get(id)).filter(Boolean);
    if (!members.length) return;
    const levels = members.map(point => point.level);
    const layerOf = id => depth.get(id) || 1;
    const layerIds = pointIds.map(layerOf);
    const stageIndex = stages.length + 1;
    stages.push({
      id: `stage-${stageIndex}`,
      index: stageIndex,
      title: `阶段 ${stageIndex} · ${levelLabel(Math.min(...levels))}${Math.max(...levels) !== Math.min(...levels) ? `→${levelLabel(Math.max(...levels))}` : ''}`,
      pointIds,
      names: members.map(point => point.name),
      levelFrom: Math.min(...levels),
      levelTo: Math.max(...levels),
      layerFrom: Math.min(...layerIds),
      layerTo: Math.max(...layerIds),
      authored: null
    });
  });
  return { stages, order, layers, deviations };
}

/* ── 5. 自测题 ──────────────────────────────────────────────────────────── */

/**
 * 自测题归一：题号补全、pointId 必须真实存在、答案与判分口径不能空。
 * 指不回知识点的题直接丢弃——一道不知道该测什么的题，对学习者只是负担。
 */
function normalizeQuestions(raw, { pointIds = [], limit = 60 } = {}) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : [];
  const known = new Set(pointIds);
  const questions = [];
  const dropped = [];
  const seen = new Set();
  for (const item of source) {
    if (questions.length >= limit) break;
    const pointId = slug(item?.pointId ?? item?.point ?? item?.id, '');
    if (!pointId || !known.has(pointId)) { dropped.push({ reason: '指不回任何知识点', pointId, question: text(item?.question, 80) }); continue; }
    const question = text(item?.question ?? item?.q ?? item?.prompt, 600);
    if (!question) { dropped.push({ reason: '题干为空', pointId }); continue; }
    const answer = text(item?.answer ?? item?.answerPoints ?? item?.reference ?? '', 1200);
    if (seen.has(`${pointId}|${question}`)) { dropped.push({ reason: '重复题目', pointId, question }); continue; }
    seen.add(`${pointId}|${question}`);
    questions.push({
      id: `q-${questions.length + 1}`,
      pointId,
      question,
      answer,
      check: text(item?.check ?? item?.criteria ?? item?.rubric ?? '', 300),
      level: levelOf(item?.difficulty ?? item?.level),
      levelLabel: levelLabel(levelOf(item?.difficulty ?? item?.level))
    });
  }
  return { questions, dropped };
}

/* ── 6. 整套校验 ────────────────────────────────────────────────────────── */

/**
 * 结构问题（problems）与质量问题（warnings）分开：
 *   problems 说明这套计划自相矛盾（知识点漏排、阶段为空、题指不回点），必须修；
 *   warnings 说明计划能读但不完整（某个知识点没自测题），可以接受但要写进自检。
 */
function validateKit(kit, { stageCount = DEFAULT_STAGE_COUNT } = {}) {
  const problems = [];
  const warnings = [];
  const stages = Array.isArray(kit?.stages) ? kit.stages : [];
  const points = Array.isArray(kit?.points) ? kit.points : [];
  const questions = Array.isArray(kit?.questions) ? kit.questions : [];
  const active = points.filter(point => !point.assumed);
  const byId = new Map(points.map(point => [point.id, point]));

  if (!points.length) problems.push({ code: 'no-points', message: '没有拆出任何知识点，学习计划没有骨架' });
  if (points.length && !active.length) problems.push({ code: 'all-assumed', message: '所有知识点都被判为已有基础，没有可排的学习内容' });
  if (!stages.length && active.length) problems.push({ code: 'no-stages', message: '知识点没有排进任何学习阶段' });
  if (stages.length > Math.max(1, active.length)) problems.push({ code: 'too-many-stages', message: `阶段数 ${stages.length} 多于知识点数 ${active.length}` });
  if (Number.isInteger(stageCount) && stages.length > stageCount) warnings.push({ code: 'stage-count-exceeded', message: `实际阶段数 ${stages.length} 超过配置的 ${stageCount}` });

  const assigned = new Map();
  for (const stage of stages) {
    if (!stage.pointIds?.length) problems.push({ code: 'empty-stage', message: `${stage.title || stage.id} 里没有任何知识点` });
    for (const id of stage.pointIds || []) {
      if (!byId.has(id)) { problems.push({ code: 'unknown-point', message: `${stage.id} 引用了不存在的知识点 ${id}` }); continue; }
      if (byId.get(id).assumed) problems.push({ code: 'assumed-in-stage', message: `${stage.id} 把已有基础的 ${id} 又排进了主路径` });
      if (assigned.has(id)) problems.push({ code: 'duplicate-point', message: `知识点 ${id} 同时出现在 ${assigned.get(id)} 与 ${stage.id}` });
      else assigned.set(id, stage.id);
    }
  }
  for (const point of active) if (!assigned.has(point.id)) problems.push({ code: 'unassigned-point', message: `知识点「${point.name}」没有排进任何阶段` });

  /* 依赖被排到更后的阶段，等于计划自己违反了先修关系。这条是本文档存在的理由之一。 */
  const stageIndexOf = id => stages.findIndex(stage => (stage.pointIds || []).includes(id));
  for (const point of active) {
    for (const ref of point.requires || []) {
      const self = stageIndexOf(point.id);
      const dep = stageIndexOf(ref);
      if (dep < 0) { warnings.push({ code: 'assumed-dependency', message: `「${point.name}」的先修 ${ref} 未排入主路径（按已有基础处理）` }); continue; }
      if (dep > self) problems.push({ code: 'order-violation', message: `「${point.name}」排在第 ${self + 1} 阶段，但它依赖的 ${ref} 在第 ${dep + 1} 阶段` });
    }
  }

  const covered = new Set(questions.map(question => question.pointId));
  const missing = active.filter(point => !covered.has(point.id)).map(point => ({ id: point.id, name: point.name }));
  for (const question of questions) {
    if (!byId.has(question.pointId)) problems.push({ code: 'question-orphan', message: `自测题「${question.question.slice(0, 30)}」指不回任何知识点` });
    if (!question.answer) warnings.push({ code: 'question-no-answer', message: `知识点 ${question.pointId} 的题目没有参考答案` });
    if (!question.check) warnings.push({ code: 'question-no-check', message: `知识点 ${question.pointId} 的题目没有判分口径` });
  }
  if (missing.length) warnings.push({ code: 'coverage-gap', message: `${missing.length} 个知识点没有自测题：${missing.map(point => point.name).join('、')}` });

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    coverage: { total: active.length, covered: active.length - missing.length, missing, questions: questions.length }
  };
}

/* ── 7. 组装与渲染 ──────────────────────────────────────────────────────── */

/**
 * 一次把「模型给的知识点」变成「可以照着学的计划」。
 * 步骤固定为：归一 → 连边 → 标已有基础 → 破环 → 分层 → 分阶段 → 校验。
 * 每一步的修正都进 deviations，最终写进产物与自检，不让用户以为一切顺利。
 */
function buildKit(raw, { evidenceKeys = null, known = [], stageCount = DEFAULT_STAGE_COUNT, limit = MAX_POINTS } = {}) {
  const normalized = normalizePoints(raw, { evidenceKeys, limit });
  const linked = linkPoints(normalized.points);
  const knownResult = markKnown(linked.points, known);
  const acyclic = breakCycles(knownResult.points);
  const planned = planStages(acyclic.points, { stageCount });
  const deviations = [];
  for (const item of normalized.dropped) deviations.push({ code: 'point-dropped', message: `丢弃知识点：${item.reason}${item.name ? `（${item.name}）` : ''}` });
  for (const item of normalized.repaired) deviations.push({ code: 'point-repaired', message: item.note });
  for (const item of linked.dangling) deviations.push({ code: 'dangling-requires', message: `${item.from} 的先修 ${item.to} 不存在，已断开` });
  for (const item of linked.selfLoops) deviations.push({ code: 'self-requires', message: `${item.from} 把自己列为先修，已断开` });
  for (const item of acyclic.removed) deviations.push({ code: 'cycle-broken', message: item.note });
  for (const item of knownResult.matched) deviations.push({ code: 'known-matched', message: `「${item.name}」按「${item.by}」判为已有基础，不进主路径` });
  for (const item of knownResult.unmatched) deviations.push({ code: 'known-unmatched', message: `声明的已有基础「${item}」没有匹配到任何知识点` });
  for (const item of planned.deviations) deviations.push(item);
  if (normalized.truncated) deviations.push({ code: 'points-truncated', message: `知识点超过上限 ${normalized.limit}，只保留前 ${normalized.limit} 个` });

  const kit = {
    topic: normalized.topic,
    points: acyclic.points,
    known: knownResult.matched.map(item => ({ id: item.id, name: item.name, by: item.by })),
    knownUnmatched: knownResult.unmatched,
    layers: planned.layers,
    order: planned.order,
    stages: planned.stages,
    sections: {},
    questions: [],
    deviations,
    stats: {
      points: acyclic.points.length,
      active: acyclic.points.length - knownResult.matched.length,
      known: knownResult.matched.length,
      layers: planned.layers.length,
      stages: planned.stages.length,
      edges: acyclic.points.reduce((sum, point) => sum + point.requires.length, 0)
    }
  };
  return kit;
}

/** 把某阶段的模型写作结果挂回 kit。阶段对象是计划的一部分，模型只能填进去，不能改结构。 */
function attachSection(kit, stageId, raw) {
  const stage = (kit?.stages || []).find(item => item.id === stageId);
  if (!stage) return null;
  const section = {
    title: text(raw?.title, 60) || stage.title,
    objective: text(raw?.objective ?? raw?.goal, 800),
    keyQuestions: listOf(raw?.keyQuestions ?? raw?.questions, { max: 8, size: 300 }),
    milestones: listOf(raw?.milestones ?? raw?.checkpoints, { max: 6, size: 300 }),
    pitfalls: listOf(raw?.pitfalls ?? raw?.misconceptions ?? raw?.mistakes, { max: 6, size: 300 }),
    materials: listOf(raw?.materials ?? raw?.resources, { max: 8, size: 300 })
  };
  stage.authored = section;
  if (kit.sections) kit.sections[stageId] = section;
  return section;
}

/** 计划正文（确定性渲染）。模型的最终答案会更好读，但这份可以独立核对结构是否完整。 */
function renderPlan(kit, { title = null } = {}) {
  if (!kit) return '';
  const lines = [];
  lines.push(`# ${text(title, 120) || kit.topic || '学习计划'}`);
  lines.push('');
  const stats = kit.stats || {};
  lines.push(`知识点 ${stats.points || 0} 个（已在基础 ${stats.known || 0} 个），依赖层 ${stats.layers || 0} 层，学习阶段 ${stats.stages || 0} 个。`);
  if (kit.known?.length) {
    lines.push('');
    lines.push('## 已有基础（不进主路径）');
    for (const item of kit.known) lines.push(`- ${item.name}（依据：${item.by}）`);
  }
  lines.push('');
  lines.push('## 知识点地图');
  (kit.layers || []).forEach((ids, index) => {
    const names = ids.map(id => (kit.points || []).find(point => point.id === id)?.name || id);
    lines.push(`${index + 1}. 第 ${index + 1} 层：${names.join(' → ')}`);
  });
  lines.push('');
  lines.push('## 学习阶段');
  for (const stage of kit.stages || []) {
    const section = stage.authored || kit.sections?.[stage.id] || {};
    lines.push('');
    lines.push(`### ${section.title || stage.title}`);
    lines.push('');
    lines.push(`本阶段知识点：${stage.names.join('、')}`);
    if (section.objective) lines.push(`学完能做到：${section.objective}`);
    if (section.keyQuestions?.length) {
      lines.push('自问清单：');
      for (const item of section.keyQuestions) lines.push(`- ${item}`);
    }
    if (section.milestones?.length) {
      lines.push('里程碑：');
      for (const item of section.milestones) lines.push(`- ${item}`);
    }
    if (section.pitfalls?.length) {
      lines.push('常见误区：');
      for (const item of section.pitfalls) lines.push(`- ${item}`);
    }
    if (section.materials?.length) {
      lines.push('材料：');
      for (const item of section.materials) lines.push(`- ${item}`);
    }
  }
  if (kit.questions?.length) {
    lines.push('');
    lines.push('## 自测题');
    for (const question of kit.questions) {
      const point = (kit.points || []).find(item => item.id === question.pointId);
      lines.push('');
      lines.push(`**${question.id}（${point?.name || question.pointId} · ${question.levelLabel}）** ${question.question}`);
      if (question.answer) lines.push(`参考答案：${question.answer}`);
      if (question.check) lines.push(`判分口径：${question.check}`);
    }
  }
  if (kit.deviations?.length) {
    lines.push('');
    lines.push('## 计划的自动修正');
    for (const item of kit.deviations) lines.push(`- ${item.message}`);
  }
  return lines.join('\n');
}

/** 给事件/日志用的紧凑摘要：整张图太贵，界面只需要知道规模与健康度。 */
function summarizeKit(kit) {
  const validation = validateKit(kit, { stageCount: kit?.stages?.length || 0 });
  return {
    topic: kit?.topic || '',
    points: kit?.points?.length || 0,
    known: kit?.known?.length || 0,
    layers: kit?.layers?.length || 0,
    stages: (kit?.stages || []).map(stage => ({ id: stage.id, title: stage.authored?.title || stage.title, points: stage.pointIds.length })),
    questions: kit?.questions?.length || 0,
    coverage: validation.coverage,
    ok: validation.ok,
    problems: validation.problems,
    warnings: validation.warnings,
    deviations: (kit?.deviations || []).length
  };
}

module.exports = {
  MAX_POINTS,
  MIN_POINTS,
  DEFAULT_STAGE_COUNT,
  LEVEL_LABELS,
  POINTS_SCHEMA,
  STAGE_SCHEMA,
  SELFTEST_SCHEMA,
  levelOf,
  levelLabel,
  normalizePoints,
  linkPoints,
  breakCycles,
  topoLayers,
  markKnown,
  planStages,
  normalizeQuestions,
  validateKit,
  buildKit,
  attachSection,
  renderPlan,
  summarizeKit
};
