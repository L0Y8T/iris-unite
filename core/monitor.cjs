'use strict';
// core/monitor.cjs —— 低成本的运行监控与自动调整（"守夜人"模式）。
//
// 定位：它不是调度器，也不是日志管道。它只在"值得叫醒人"的时候才返回 decision，
// 其余时候 observe() 返回 null，调用方继续睡。
//
// 四条来自实战（两个跑过整夜的守护脚本）的硬约束：
//   1) 一次触发必须带完整现场：decision.reason 写清楚依据的数字，scene() 直接拼好
//      一份可打印的中文报告，一次唤醒 == 一次完整检查，绝不流式刷日志。
//   2) 两次确认：retry-cheaper / skip-stage / abort 这类破坏性动作，必须连续 N 次观测
//      到同一个异常才执行，排除瞬时抖动（对应旧脚本里的 onBat >= 2）。
//   3) 空闲超时判完成：连续 M 次观测不到任何变化，视为真的结束，而不是异常。
//   4) 不绑定实例：每条规则每一 tick 都从传进来的 snapshot 重新发现目标，
//      因为下一轮的目标实例可能是新的（旧脚本每轮重新找进程，这里每轮重新读快照）。
//
// 成本约束：纯内存、无 IO、无网络、无定时器、不调用模型、只读快照的"尾巴"。
// 计时完全由调用方驱动（每 tick 调一次 observe），因此也可以注入假时钟做测试。

// 运行进入这些状态后，除了"结束"以外的一切规则都失去意义（没有可处置的对象）。
const TERMINAL_STATUSES = new Set(['done', 'error', 'stopped']);

// 同一 tick 有多个规则同时触发时，先报谁：严重级别高的优先，同级按下面顺序。
const RULE_ORDER = Object.freeze({ finished: 0, 'repeat-failure': 1, stall: 2, duplicate: 3, budget: 4, 'no-progress': 5 });
const SEVERITY_RANK = Object.freeze({ critical: 3, warn: 2, info: 1 });

// 查重用的"已上报 key"上限。key 都是异常身份 + 等级，天然有限，但整夜运行不设上限
// 会缓慢吃内存，所以要有个硬顶，超出后淘汰最老的（淘汰后老异常可能再报一次，可接受）。
const EMITTED_CAP = 512;

// scene() 只打印最近几条产物：现场报告要能一眼看完，不是全量导出。
const SCENE_ARTIFACT_TAIL = 5;

const DEFAULT_LIMITS = Object.freeze({
  // 10 分钟没有任何文本增量才算 stall。取值依据：一次研究调用即便很慢，首字/增量通常
  // 也在几十秒内出现；10 分钟远超正常抖动，又短于一顿饭，夜里叫醒一次不算扰民。
  stallMs: 600000,
  // 连续 2 次观测到同一 stall 才降级重试。tick 30~120 秒，2 次确认意味着多等一个 tick，
  // 用极小的时间代价排掉网络瞬时抖动（对应旧脚本的 onBat >= 2）。
  stallRetryCount: 2,
  // 在"同一阶段最近 4 个已完成产物"范围内查重。窗口太小会把正常的前后呼应误判，
  // 太大则跨了子任务、本来就可能重复引用同一份材料；4 约等于一个阶段并行任务的典型数量。
  duplicateWindow: 4,
  // 同一个错误串连续出现 3 次才 abort。三次独立请求都撞同一堵墙，说明是系统性故障
  // （鉴权失效、模型下线、配置错误），再重试只是烧预算；两次又分不清偶发。
  repeatFailureCount: 3,
  // 距离预算耗尽还剩 1 次就提醒。终审必须至少留一次调用，等到剩 0 次才喊就来不及了。
  budgetReserve: 1,
  // 连续 4 次观测（tick 60 秒时约 4 分钟）完全没变化，视为已经结束。一个空转的进程
  // 也会维持 running，所以"没变化"比"显示 running"更可信。
  idleTicksToFinish: 4,
  // 至少用掉 2 次调用才允许报预算。预算极小（如总共 3 次）时第一次调用就已经贴着预留线，
  // 此时提醒没有任何可操作空间，只会变成噪音。
  minCallsForBudgetWarn: 2,
  // decisions 数组的硬顶，防止整夜运行无限增长（只影响历史记录，不影响规则判断）。
  maxDecisions: 200
});

// ---------------------------------------------------------------------------
// 哈希：用于查重。不引 crypto、不读文件，纯算术，稳定跨进程/跨次运行。
// ---------------------------------------------------------------------------
// 先做轻量归一化（合并空白、去首尾空），这样"仅换行/空格不同"的产物会被判为重复：
// 模型换个排版就重写一遍同样内容，正是要抓的低价值重复。
function normalizeForHash(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// 16 位十六进制 = 两路独立 32 位 FNV-1a 变体拼接。对"查重"这个用途足够
// （碰撞要两路同时撞，实际概率远低于 2^-32），且比 SHA-256 便宜得多。
function hashText(text) {
  if (typeof text !== 'string') throw new TypeError('hashText 只接受字符串');
  const value = normalizeForHash(text);
  let a = 0x811c9dc5; // 第一路：FNV-1a 标准 32 位偏移基数
  let b = 0x9e3779b9; // 第二路：黄金比例常量做种子，与第一路错开
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0; // FNV 质数
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0; // 与第一路不同的乘法器
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

// 报告抬头的时间，格式 0:42:10（本地时间，和用户看表一致）。
function formatClock(ms) {
  const date = new Date(ms);
  return `${date.getHours()}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// 时长用中文口语单位，不出现 "600000ms" 这种让人现场再换算的东西。
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function listArtifacts(snap) {
  if (!Array.isArray(snap.artifacts)) return [];
  return snap.artifacts.filter((item) => item && typeof item === 'object');
}

// 快照指纹：阶段 + 已用调用数 + 产物数量 + 产物状态 + 运行状态。
// 只要任何一样变了就算"有进展"，所以指纹不变才等价于"真的没动"。
function fingerprintOf(snap) {
  const artifacts = listArtifacts(snap);
  const statuses = artifacts.map((item) => (typeof item.status === 'string' ? item.status : '?')).join(',');
  const stage = typeof snap.stage === 'string' ? snap.stage : '';
  const status = typeof snap.status === 'string' ? snap.status : '';
  return `${stage}|${toFinite(snap.callsUsed) ?? '?'}|${artifacts.length}|${statuses}|${status}`;
}

function mergeLimits(input) {
  const merged = { ...DEFAULT_LIMITS };
  if (!input || typeof input !== 'object') return merged;
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = input[key];
    // 只接受有限的非负数；非法值退回默认，而不是抛错——监控挂在夜里，
    // 不能因为调用方一个手滑的配置就把整轮观察停掉。
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// createMonitor
// ---------------------------------------------------------------------------
function createMonitor(options = {}) {
  const config = options && typeof options === 'object' ? options : {};
  const limits = mergeLimits(config.limits);
  const now = typeof config.now === 'function' ? config.now : () => Date.now();

  // 每个破坏性规则最少的确认次数硬性下限是 2：即使有人把 stallRetryCount 配成 1，
  // 也不允许"第一次观测就动手"，这是本模块的设计底线。
  const stallConfirmations = Math.max(2, Math.floor(limits.stallRetryCount) || 2);
  const duplicateConfirmations = 2; // skip-stage 是破坏性动作，固定两次确认
  const noProgressConfirmations = Math.max(2, Math.floor(limits.idleTicksToFinish) || 2);

  const decisions = [];
  const emitted = new Set();
  const emittedOrder = [];

  const state = {
    ticks: 0,
    idleTicks: 0, // 连续"指纹没变"的次数（首次观测只建立基线，不计）
    progressEpisode: 0, // 指纹每变化一次 +1，用来区分"新一段无进展"
    lastFingerprint: null,
    lastStatus: null,
    streaks: {}, // 每个规则当前的连续异常：{ key, count, episode }
    episodes: {} // 每个规则"第几段异常"的计数器，见 track()
  };

  function asSnapshot(input, where) {
    if (!input || typeof input !== 'object') throw new TypeError(`${where} 需要 snapshot 对象`);
    return input;
  }

  // 连续确认计数：key 变了（异常身份变了）就从 1 重新数；key 为空表示异常已消失，清零。
  // 同时给每一段新异常发一个 episode 号：它是"上报 key 的一部分"，用来区分
  // "同一阶段同一产物，恢复增量后又再次卡住"这种新的一段异常——异常消失过再回来，
  // 属于状态变化，允许再报一次；而同一段异常内部保持幂等。
  function track(kind, key) {
    if (!key) {
      state.streaks[kind] = { key: null, count: 0, episode: 0 };
      return state.streaks[kind];
    }
    const previous = state.streaks[kind];
    if (previous && previous.key === key) {
      previous.count += 1;
      return previous;
    }
    state.episodes[kind] = (state.episodes[kind] || 0) + 1;
    state.streaks[kind] = { key, count: 1, episode: state.episodes[kind] };
    return state.streaks[kind];
  }

  // 幂等上报：同一个 key 只消费一次。返回 false 表示这条早报过了。
  function claim(key) {
    if (emitted.has(key)) return false;
    emitted.add(key);
    emittedOrder.push(key);
    if (emittedOrder.length > EMITTED_CAP) emitted.delete(emittedOrder.shift());
    return true;
  }

  function record(at, candidate) {
    const decision = Object.freeze({
      at,
      kind: candidate.kind,
      severity: candidate.severity,
      action: candidate.action,
      reason: candidate.reason,
      detail: Object.freeze({ ...candidate.detail })
    });
    decisions.push(decision);
    const cap = Math.max(1, Math.floor(limits.maxDecisions) || 1);
    if (decisions.length > cap) decisions.splice(0, decisions.length - cap);
    return decision;
  }

  // --- 规则：结束 -----------------------------------------------------------
  // status 已变成 done/error/stopped：只报一次。这里按 status 值做 key，
  // 所以"error 之后又被标成 stopped"这种真实的状态变化可以再报一次，同一状态不重复。
  function ruleFinished(snap) {
    const status = typeof snap.status === 'string' ? snap.status : '';
    if (!TERMINAL_STATUSES.has(status)) return null;
    const artifacts = listArtifacts(snap);
    const text = {
      done: '运行已结束（status=done）',
      error: '运行以错误结束（status=error），请看现场决定下一步',
      stopped: '运行被停止（status=stopped）'
    }[status];
    return {
      kind: 'finished',
      severity: 'info',
      action: 'none',
      reason: `${text}；本阶段 ${snap.stage || '未知'}，共产生 ${artifacts.length} 个产物。`,
      detail: { status, stage: snap.stage ?? null, stageIndex: toFinite(snap.stageIndex), artifactCount: artifacts.length },
      key: `finished:${status}`
    };
  }

  // --- 规则：连续失败 -------------------------------------------------------
  // 同一个错误串连续 repeatFailureCount 次 -> abort。
  // 这里的"确认"来自产物本身：三次独立请求都报同一个错误，已经是三次独立观测，
  // 不必再额外多等两个 tick（那样只会让预算继续被烧）。
  function ruleRepeatFailure(snap) {
    const need = Math.max(2, Math.floor(limits.repeatFailureCount) || 2);
    // 跨阶段统计：同一句 "401 unauthorized" 出现在不同阶段，恰恰是系统性故障的特征。
    const failures = listArtifacts(snap).filter(
      (item) => item.status === 'error' && typeof item.error === 'string' && item.error.trim() !== ''
    );
    let best = null;
    let run = null;
    for (const item of failures) {
      const message = item.error.trim();
      if (run && run.message === message) run.items.push(item);
      else run = { message, items: [item] };
      if (!best || run.items.length > best.items.length) best = run;
    }
    if (!best || best.items.length < need) {
      track('repeat-failure', null);
      return null;
    }
    const signature = hashText(best.message);
    track('repeat-failure', `repeat-failure:${signature}`);
    return {
      kind: 'repeat-failure',
      severity: 'critical',
      action: 'abort',
      reason: `连续 ${best.items.length} 个产物报同一个错误（阈值 ${need} 次），判定为系统性故障，继续重试只会烧预算：${truncate(best.message, 120)}`,
      detail: {
        error: truncate(best.message, 240),
        errorHash: signature,
        count: best.items.length,
        artifactIds: best.items.map((item) => item.id ?? null),
        stage: snap.stage ?? null
      },
      key: `repeat-failure:${signature}`
    };
  }

  // --- 规则：stall ----------------------------------------------------------
  // 当前阶段有 running 产物，但 lastActivityAt 超过 stallMs 没有任何增量。
  // 第一次只报告（warn + none），连续第 stallConfirmations 次起才 retry-cheaper。
  // 注意"当阶段有 running 产物"这个前置条件：没有在飞的东西就不是卡住，是空转，
  // 空转归 no-progress 管，两条规则不重叠。
  function ruleStall(snap, at) {
    if (snap.status !== 'running') {
      track('stall', null);
      return null;
    }
    const stage = typeof snap.stage === 'string' ? snap.stage : '';
    const running = listArtifacts(snap).filter((item) => item.status === 'running' && (item.stage ?? '') === stage);
    if (running.length === 0) {
      track('stall', null);
      return null;
    }
    const lastActivityAt = toFinite(snap.lastActivityAt);
    if (lastActivityAt === null) {
      // 没给时间戳就不猜（"不许猜"）：宁可漏报，也不要凭空报一个静默时长。
      track('stall', null);
      return null;
    }
    const silentMs = at - lastActivityAt;
    if (!(silentMs > limits.stallMs)) {
      track('stall', null);
      return null;
    }
    const artifactIds = running.map((item) => item.id ?? null).sort();
    const streakKey = `stall:${stage}:${artifactIds.join(',')}`;
    const streak = track('stall', streakKey);
    const confirmations = streak.count;
    const escalate = confirmations >= stallConfirmations;
    const action = escalate ? 'retry-cheaper' : 'none';
    const reason = escalate
      ? `连续 ${confirmations} 次确认本阶段无增量（已静默 ${formatDuration(silentMs)}，阈值 ${formatDuration(limits.stallMs)}），用更低强度重试当前产物。`
      : `本阶段已静默 ${formatDuration(silentMs)}（阈值 ${formatDuration(limits.stallMs)}），第 ${confirmations} 次观测，先只报告，累计 ${stallConfirmations} 次确认后再降级重试。`;
    return {
      kind: 'stall',
      severity: 'warn',
      action,
      reason,
      detail: {
        silentMs,
        thresholdMs: limits.stallMs,
        stage,
        confirmations,
        confirmationsRequired: stallConfirmations,
        artifactIds
      },
      key: `${streakKey}#${action}#e${streak.episode}`
    };
  }

  // --- 规则：duplicate ------------------------------------------------------
  // 同一阶段最近 duplicateWindow 个"已完成且有正文"的产物里出现同哈希。
  // 空正文不参与比对：两个空产物撞出的"重复"是假警报。
  // 第一次 none（只报告），第二次同一对产物确认后才 skip-stage。
  function ruleDuplicate(snap) {
    const stage = typeof snap.stage === 'string' ? snap.stage : '';
    const windowSize = Math.max(2, Math.floor(limits.duplicateWindow) || 2);
    const done = listArtifacts(snap).filter(
      (item) => item.status === 'done' && (item.stage ?? '') === stage && typeof item.text === 'string' && item.text.trim() !== ''
    );
    const recent = done.slice(-windowSize);
    let pair = null;
    if (recent.length >= 2) {
      const seen = new Map(); // hash -> 该哈希最近一次出现的产物
      for (let i = 0; i < recent.length; i += 1) {
        const item = recent[i];
        const hash = hashText(item.text);
        const earlier = seen.get(hash);
        if (earlier) pair = { hash, duplicate: item, duplicateOf: earlier }; // 越晚出现的越优先
        seen.set(hash, item);
      }
    }
    if (!pair) {
      track('duplicate', null);
      return null;
    }
    const duplicateId = pair.duplicate.id ?? '(无 id)';
    const duplicateOfId = pair.duplicateOf.id ?? '(无 id)';
    const streakKey = `duplicate:${stage}:${duplicateId}:${duplicateOfId}`;
    const streak = track('duplicate', streakKey);
    const confirmations = streak.count;
    const escalate = confirmations >= duplicateConfirmations;
    const action = escalate ? 'skip-stage' : 'none';
    const reason = escalate
      ? `连续 ${confirmations} 次确认：产物 ${duplicateId} 与产物 ${duplicateOfId} 内容相同（哈希 ${pair.hash}，本阶段最近 ${recent.length} 个完成产物内），跳过该阶段剩余重复工作。`
      : `产物 ${duplicateId} 与产物 ${duplicateOfId} 内容相同（哈希 ${pair.hash}，本阶段最近 ${recent.length} 个完成产物内），第 ${confirmations} 次观测，先只报告，再确认一次才跳过。`;
    return {
      kind: 'duplicate',
      severity: 'warn',
      action,
      reason,
      detail: {
        stage,
        hash: pair.hash,
        duplicateId: pair.duplicate.id ?? null,
        duplicateOf: pair.duplicateOf.id ?? null,
        window: recent.length,
        confirmations,
        confirmationsRequired: duplicateConfirmations
      },
      key: `${streakKey}#${action}#e${streak.episode}`
    };
  }

  // --- 规则：预算 -----------------------------------------------------------
  // callsUsed >= callBudget - budgetReserve 时提醒（永远留一次给终审）。
  // 不处置（action 恒为 none）：预算只能由人/上层决定怎么收敛，监控只负责把数字摆出来。
  function ruleBudget(snap) {
    const used = toFinite(snap.callsUsed);
    const total = toFinite(snap.callBudget);
    if (used === null || total === null || total <= 0) {
      track('budget', null);
      return null;
    }
    const remaining = total - used;
    if (remaining > limits.budgetReserve) {
      track('budget', null);
      return null;
    }
    if (used < limits.minCallsForBudgetWarn) {
      // 预算极小：第一次调用就贴线，喊了也无事可做，属于噪音。
      track('budget', null);
      return null;
    }
    // 以"已用/总量"做 key：只要还贴线，每多用一次最多提醒一次，有界且每次都有新信息。
    track('budget', `budget:${used}/${total}`);
    const reserve = limits.budgetReserve;
    return {
      kind: 'budget',
      severity: remaining <= 0 ? 'warn' : 'info',
      action: 'none',
      reason:
        remaining <= 0
          ? `调用已用 ${used}/${total}，已超出预算 ${-remaining} 次，终审调用不保，请立即收敛。`
          : `调用已用 ${used}/${total}，剩余 ${remaining} 次调用，为终审预留 ${reserve} 次；不要再增加调用，先完成整合与终审。`,
      detail: { callsUsed: used, callBudget: total, remaining, reserve },
      key: `budget:${used}/${total}`
    };
  }

  // --- 规则：无进展 ---------------------------------------------------------
  // 连续 noProgressConfirmations 次"指纹完全没变" -> 视为结束。
  // 首次观测只建立基线（否则一个刚启动的运行会被立刻判成结束）。
  // 已经进入终态时不报这条：那种情况由 finished 负责，重复报告是噪音。
  function ruleNoProgress(snap) {
    if (TERMINAL_STATUSES.has(snap.status)) {
      track('no-progress', null);
      return null;
    }
    if (state.idleTicks < noProgressConfirmations) {
      track('no-progress', null);
      return null;
    }
    const fingerprint = state.lastFingerprint ?? fingerprintOf(snap);
    track('no-progress', `no-progress:${fingerprint}`);
    return {
      kind: 'no-progress',
      severity: 'info',
      action: 'none',
      reason: `连续 ${state.idleTicks} 次观测（阈值 ${noProgressConfirmations} 次）阶段、调用数、产物数量与状态完全没变，可视为已经结束，不必继续等。`,
      detail: {
        idleTicks: state.idleTicks,
        thresholdTicks: noProgressConfirmations,
        fingerprint,
        stage: snap.stage ?? null,
        callsUsed: toFinite(snap.callsUsed),
        artifactCount: listArtifacts(snap).length
      },
      key: `no-progress:${state.progressEpisode}:${fingerprint}`
    };
  }

  // --- observe --------------------------------------------------------------
  function observe(input) {
    const snap = asSnapshot(input, 'monitor.observe');
    const at = now();
    state.ticks += 1;

    // 指纹与空闲计数（所有规则都要用，先算一次）。
    const fingerprint = fingerprintOf(snap);
    if (state.lastFingerprint === null) {
      state.idleTicks = 0;
    } else if (fingerprint === state.lastFingerprint) {
      state.idleTicks += 1;
    } else {
      state.idleTicks = 0;
      state.progressEpisode += 1;
    }
    state.lastFingerprint = fingerprint;
    state.lastStatus = typeof snap.status === 'string' ? snap.status : null;

    const candidates = [];
    const finished = ruleFinished(snap);
    if (finished) candidates.push(finished);

    if (!TERMINAL_STATUSES.has(snap.status)) {
      // 顺序按"先看会不会立刻出人命，再看要不要降级"：失败 -> 卡住 -> 重复 -> 预算 -> 空转。
      for (const rule of [ruleRepeatFailure, ruleBudget]) {
        const candidate = rule(snap, at);
        if (candidate) candidates.push(candidate);
      }
      for (const rule of [ruleStall, ruleDuplicate, ruleNoProgress]) {
        const candidate = rule(snap, at);
        if (candidate) candidates.push(candidate);
      }
    } else {
      // 终态：把其余规则的连续计数清掉，避免下次运行沿用上一轮的旧计数。
      for (const kind of ['repeat-failure', 'stall', 'duplicate', 'budget', 'no-progress']) track(kind, null);
    }

    if (candidates.length === 0) return null;
    // 一次 observe 只返回一条 decision（签名如此）：同一 tick 里多个规则都触发时，
    // 按"严重级别高者优先、同级按 RULE_ORDER"取第一条还没报过的。
    // 落选的那些不消费自己的上报 key，会在下一个 tick 自己冒出来，不会被吞掉。
    candidates.sort((left, right) => {
      const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
      if (bySeverity !== 0) return bySeverity;
      return RULE_ORDER[left.kind] - RULE_ORDER[right.kind];
    });
    for (const candidate of candidates) {
      if (claim(candidate.key)) return record(at, candidate);
    }
    return null;
  }

  // --- scene ----------------------------------------------------------------
  function describeStage(snap) {
    const label =
      typeof snap.stageLabel === 'string' && snap.stageLabel.trim() !== ''
        ? snap.stageLabel.trim()
        : typeof snap.stage === 'string' && snap.stage
          ? snap.stage
          : '未知阶段';
    const index = toFinite(snap.stageIndex);
    const total = toFinite(snap.totalStages);
    if (index === null || total === null || total <= 0) return `阶段 ${label}`;
    return `阶段 ${index}/${total}  ${label}`;
  }

  function describeCalls(snap) {
    const used = toFinite(snap.callsUsed);
    const total = toFinite(snap.callBudget);
    if (used === null) return '调用 未知';
    return total === null ? `调用 ${used}` : `调用 ${used}/${total}`;
  }

  function describeCounts(artifacts) {
    const count = (status) => artifacts.filter((item) => item.status === status).length;
    const parts = [`完成 ${count('done')}`, `运行 ${count('running')}`, `失败 ${count('error')}`];
    const stopped = count('stopped');
    if (stopped > 0) parts.push(`停止 ${stopped}`);
    return `产物 ${artifacts.length}（${parts.join(' / ')}）`;
  }

  function describeSilence(snap, at) {
    const lastActivityAt = toFinite(snap.lastActivityAt);
    if (lastActivityAt === null) return '无增量 未知（快照未提供 lastActivityAt）';
    return `无增量 ${formatDuration(at - lastActivityAt)}`;
  }

  function describeArtifact(item) {
    const status = typeof item.status === 'string' ? item.status : '?';
    const stage = typeof item.stage === 'string' && item.stage ? item.stage : '-';
    const model = [item.provider, item.model].filter((part) => typeof part === 'string' && part.trim() !== '').join(' ');
    const text = typeof item.text === 'string' ? item.text : '';
    const head = `[${status}] ${stage} ${model || '-'}`;
    const parts = [];
    if (status === 'error') {
      const message = typeof item.error === 'string' && item.error.trim() !== '' ? item.error.trim() : '未知错误';
      parts.push(`失败：${truncate(message, 80)}`);
    } else if (status === 'running' || status === 'stopped') {
      if (text.length > 0) parts.push(`${text.length} 字`);
      parts.push('…');
    } else {
      parts.push(`${text.length} 字`);
      const startedAt = toFinite(item.startedAt);
      const finishedAt = toFinite(item.finishedAt);
      if (startedAt !== null && finishedAt !== null && finishedAt >= startedAt) {
        parts.push(formatDuration(finishedAt - startedAt));
      }
    }
    return [head, ...parts].join('  ');
  }

  // 一次唤醒 == 一次完整检查：阶段、调用、产物统计、静默时长、尾巴产物、最近决策。
  // 调用方拿到字符串直接打印/写进通知即可，不需要再拼接。
  function scene(input) {
    const snap = asSnapshot(input, 'monitor.scene');
    const at = now();
    const artifacts = listArtifacts(snap);
    const latest = decisions.length > 0 ? decisions[decisions.length - 1] : null;
    const lines = [];
    lines.push(`=== 监控触发：${latest ? latest.kind : '无'}   ${formatClock(at)} ===`);
    lines.push(describeStage(snap));
    lines.push(`${describeCalls(snap)}   ${describeCounts(artifacts)}`);
    lines.push(describeSilence(snap, at));
    lines.push('最近产物：');
    const tail = artifacts.slice(-SCENE_ARTIFACT_TAIL);
    if (tail.length === 0) lines.push('  （无）');
    else for (const item of tail) lines.push(`  ${describeArtifact(item)}`);
    lines.push(latest ? `决策：${latest.action} — ${latest.reason}` : '决策：none — 当前没有触发任何规则');
    return lines.join('\n');
  }

  function reset() {
    decisions.length = 0;
    emitted.clear();
    emittedOrder.length = 0;
    state.ticks = 0;
    state.idleTicks = 0;
    state.progressEpisode = 0;
    state.lastFingerprint = null;
    state.lastStatus = null;
    state.streaks = {};
    state.episodes = {};
  }

  return {
    observe,
    scene,
    // decisions 给的是只读快照：外部改不动内部记录，要完整导出用 toJSON()。
    get decisions() {
      return Object.freeze(decisions.slice());
    },
    reset,
    toJSON() {
      return JSON.parse(JSON.stringify({ decisions, state }));
    }
  };
}

module.exports = { DEFAULT_LIMITS, createMonitor, hashText };
