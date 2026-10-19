'use strict';

/**
 * 一键导出：把一轮科研结果整理成一份自包含的 Markdown。
 *
 * 三条硬规则：
 * 1. 只写记录里真实存在的字段。缺哪一段就整段省略，不用「暂无数据」之类的占位结论凑版式。
 * 2. 不写 API Key、不写本机绝对路径。运行记录只保留 runId 与产物哈希，同机复现靠 runId 回溯。
 * 3. 实验数字必须来自对应运行的 manifest；manifest 里没有的数字一律不出现。
 */

const SENSITIVE_KEY = /api[-_]?key|token|secret|password|credential|authorization/i;
const LOCAL_PATH_KEY = /path|dir|home|user|root|cwd|temp|executable|binary/i;
const PRIVATE_PATH = /(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root|tmp)\/)/;

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function formatNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return value.toExponential(4);
    return String(Number(value.toPrecision(6)));
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 表格单元格：换行压平，竖线转义，空值留空。 */
function cell(value) {
  const text = formatNumber(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return text;
}

function table(headers, rows) {
  const body = (rows || []).filter(row => Array.isArray(row) && row.some(v => cell(v) !== ''));
  if (!body.length) return '';
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const lines = body.map(row => `| ${headers.map((_, index) => cell(row[index] ?? '')).join(' | ')} |`);
  return [head, sep, ...lines].join('\n');
}

function bullets(items) {
  const lines = (items || []).map(item => String(item ?? '').trim()).filter(Boolean);
  return lines.length ? lines.map(line => `- ${line}`).join('\n') : '';
}

function heading(level, title) {
  return `${'#'.repeat(level)} ${title}`;
}

function block(parts) {
  return parts.filter(part => typeof part === 'string' && part.trim()).join('\n\n');
}

/** 截断长文本，保留尾部省略说明，避免导出里出现半句话被当成结论。 */
function clip(text, limit) {
  const value = String(text ?? '').trim();
  if (!limit || value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}…（原文 ${value.length} 字，此处截断）`;
}

/** 答案正文自带的标题整体压两级，免得正文里的 ## 和导出章节平级、把目录结构冲散。
    代码块里的 # 是注释，不能动。 */
function demoteHeadings(text) {
  let fenced = false;
  return String(text ?? '').split('\n').map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    const match = /^(#{1,4})(\s+.*)$/.exec(line);
    if (!match) return line;
    return `${'#'.repeat(Math.min(6, match[1].length + 2))}${match[2]}`;
  }).join('\n');
}

function isPlainScalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'string' || !PRIVATE_PATH.test(value));
}

/** 复现信息：环境指纹里只留能公开的版本号，路径与本机目录一律剔除。 */
function publicEnv(env) {
  if (!env || typeof env !== 'object') return [];
  const rows = [];
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEY.test(key) || LOCAL_PATH_KEY.test(key)) continue;
    if (!isPlainScalar(value)) continue;
    if (String(value).trim() === '') continue;
    rows.push([key, cell(value)]);
  }
  return rows;
}

/** 参数表：模板参数都是受控类型，原样输出即可；但剔除可能带凭据的键。 */
function publicParams(params) {
  if (!params || typeof params !== 'object') return [];
  return Object.entries(params)
    .filter(([key, value]) => !SENSITIVE_KEY.test(key) && isPlainScalar(value))
    .map(([key, value]) => [key, cell(value)]);
}

function manifestMetrics(manifest) {
  const metrics = manifest?.metrics;
  if (!metrics || typeof metrics !== 'object') return [];
  const rows = [];
  const walk = (value, prefix, depth) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (isPlainScalar(value)) { if (prefix) rows.push([prefix, cell(value)]); return; }
    if (Array.isArray(value) || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key, depth + 1);
  };
  walk(metrics, '', 0);
  return rows.filter(([key]) => !key.startsWith('params.'));
}

/**
 * 把运行映射成答案里那套 E 编号。
 *
 * 编号规则必须和核验端（core/exec/claims.cjs）一致：只有成功运行占编号，按开始时间升序。
 * 否则导出表格里的 E3 会和答案正文里的 [E3] 指向两条不同的运行。
 */
function labelRuns(experimentRuns, manifests) {
  const byId = new Map((manifests || []).map(manifest => [manifest?.runId, manifest]));
  const items = Array.isArray(experimentRuns) && experimentRuns.length
    ? experimentRuns.map(item => ({ runId: item?.runId || null, label: item?.label || null, status: item?.status || null, manifest: item?.runId ? byId.get(item.runId) || null : null }))
    : (manifests || []).map(manifest => ({ runId: manifest?.runId || null, label: manifest?.label || null, status: manifest?.status || null, manifest }));
  const done = items.filter(item => (item.manifest?.status || item.status) === 'done');
  done.sort((a, b) => (a.manifest?.startedAt ?? 0) - (b.manifest?.startedAt ?? 0));
  const codeOf = new Map(done.map((item, index) => [item, `E${index + 1}`]));
  return items.map(item => ({ ...item, code: codeOf.get(item) || '' }));
}

function scopeSection(scope) {
  if (!scope || typeof scope !== 'object') return '';
  const body = block([
    scope.objective ? `**研究目标**：${String(scope.objective).trim()}` : '',
    bullets(scope.questions) ? `**研究问题**\n\n${bullets(scope.questions)}` : '',
    bullets(scope.queries) ? `**检索式**\n\n${bullets(scope.queries)}` : '',
    table(['纳入标准', '排除标准'], maxPair(scope.inclusion, scope.exclusion)) || '',
    scope.queriesFallback === true ? '检索式由本地规则补全（模型未返回结构化结果）。' : ''
  ]);
  return body ? block([heading(2, '研究界定'), body]) : '';
}

function maxPair(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const size = Math.max(a.length, b.length);
  const rows = [];
  for (let index = 0; index < size; index++) rows.push([a[index] ?? '', b[index] ?? '']);
  return rows;
}

function librarySection(stats, records) {
  const list = Array.isArray(records) ? records : [];
  const meta = stats && typeof stats === 'object' ? stats : {};
  const summary = block([
    meta.total || list.length ? `共 ${meta.total ?? list.length} 条记录，其中带 DOI ${meta.withDoi ?? 0} 条、带摘要 ${meta.withAbstract ?? 0} 条。` : '',
    meta.bySource && Object.keys(meta.bySource).length ? `来源分布：${Object.entries(meta.bySource).map(([key, value]) => `${key} ${value} 条`).join('，')}。` : '',
    Array.isArray(meta.yearRange) && meta.yearRange.length === 2 ? `年份范围：${meta.yearRange[0]}–${meta.yearRange[1]}。` : '',
    Array.isArray(meta.queries) && meta.queries.length ? `实际检索式：${meta.queries.join('；')}` : '',
    Array.isArray(meta.errors) && meta.errors.length ? `检索失败：${meta.errors.slice(0, 6).join('；')}` : ''
  ]);
  const rows = list.map(record => [
    record.key,
    record.source,
    record.year,
    record.title,
    record.authors,
    record.venue,
    record.doi || record.arxivId || (record.url ? '有链接' : '')
  ]);
  /* 本轮没有资料库就整段不要；有统计但没有明细时才说明一句，免得看的人以为漏掉了。 */
  const body = block([
    summary,
    rows.length ? table(['键', '来源', '年份', '标题', '作者', '出处', '标识'], rows) : '',
    rows.length || !summary ? '' : '资料库明细未随导出携带（本轮记录里只有统计信息）。'
  ]);
  return body ? block([heading(2, '资料库'), body]) : '';
}

function artifactByStage(artifacts, stage) {
  const hits = (artifacts || []).filter(item => item?.stage === stage && typeof item.text === 'string' && item.text.trim());
  return hits.length ? hits[hits.length - 1].text.trim() : '';
}

function evidenceSection(run) {
  const raw = run?.evidence && typeof run.evidence === 'object' ? run.evidence : null;
  const text = raw ? '' : artifactByStage(run?.artifacts, 'research-evidence');
  const parts = [];
  if (raw && Array.isArray(raw.claims)) {
    parts.push(table(['结论', '证据键', '强度', '局限'], raw.claims.map(claim => [claim.claim, (claim.keys || []).join(' '), claim.strength, claim.limitation])));
  }
  if (raw && Array.isArray(raw.gaps) && raw.gaps.length) parts.push(`**证据缺口**\n\n${bullets(raw.gaps)}`);
  if (!raw && text) parts.push(`**证据提取原文**\n\n${clip(text, 6000)}`);
  const body = block(parts);
  return body ? block([heading(2, '证据提取'), body]) : '';
}

function planSection(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const body = block([
    plan.objective ? `**本轮目标**：${String(plan.objective).trim()}` : '',
    tasks.length ? table(['任务', '分工', '交付物', '依据键'], tasks.map(task => [task.id, task.assignment, task.deliverable, (task.evidenceKeys || []).join(' ')])) : '',
    plan.selectionCriteria ? `**评审准则**：${String(plan.selectionCriteria).trim()}` : '',
    plan.parseFailed === true ? '任务分解未返回合法结构，已按用户配置兜底。' : ''
  ]);
  return body ? block([heading(2, '任务分解'), body]) : '';
}

function selectionSection(selection) {
  if (!selection || typeof selection !== 'object') return '';
  const body = block([
    Array.isArray(selection.selectedIds) && selection.selectedIds.length ? `**入选**：${selection.selectedIds.join('、')}` : '',
    Array.isArray(selection.refineIds) && selection.refineIds.length ? `**深化**：${selection.refineIds.join('、')}` : '',
    selection.reason ? `**筛选理由**：${String(selection.reason).trim()}` : '',
    selection.feedback ? `**反馈**：${String(selection.feedback).trim()}` : '',
    Array.isArray(selection.unsupported) && selection.unsupported.length ? `**证据薄弱处**\n\n${bullets(selection.unsupported)}` : '',
    Array.isArray(selection.deviations) && selection.deviations.length ? `**偏离记录**\n\n${bullets(selection.deviations)}` : '',
    selection.budgetNote ? String(selection.budgetNote) : ''
  ]);
  return body ? block([heading(2, '候选筛选与深化'), body]) : '';
}

function experimentSection(run, manifests) {
  const family = run?.experimentFamily && typeof run.experimentFamily === 'object' ? run.experimentFamily : null;
  const runs = labelRuns(run?.experimentRuns, manifests);
  if (!family && !runs.length) return '';

  const design = family?.design && typeof family.design === 'object' ? family.design : null;
  const designBody = design
    ? block([
        design.template ? `**模板**：${design.template}` : '',
        design.metric ? `**主指标**：${design.metric}（${design.direction === 'minimize' ? '越小越好' : '越大越好'}）` : '',
        design.hypothesis ? `**假设**：${String(design.hypothesis).trim()}` : '',
        design.stopWhen ? `**停止条件**：${String(design.stopWhen).trim()}` : '',
        design.baseline && typeof design.baseline === 'object'
          ? `**基线参数**\n\n${table(['参数', '取值'], publicParams(design.baseline))}`
          : '',
        design.searchSpace && typeof design.searchSpace === 'object'
          ? `**搜索空间**\n\n${table(['参数', '候选值'], Object.entries(design.searchSpace).map(([key, value]) => [key, Array.isArray(value) ? value.join(' / ') : formatNumber(value)]))}`
          : '',
        design.reasoning ? `**设计理由**：${String(design.reasoning).trim()}` : ''
      ])
    : '';

  const trialRows = runs.map(item => {
    const manifest = item.manifest;
    const metrics = manifestMetrics(manifest);
    const primary = metrics.find(([key]) => key === family?.metric) || metrics[0] || null;
    return [
      item.code || '未编号',
      item.label || manifest?.label || manifest?.template?.name || manifest?.template?.id || '',
      manifest?.status || item.status || '',
      primary ? `${primary[0]}=${primary[1]}` : '',
      formatDuration(manifest?.finishedAt && manifest?.startedAt ? manifest.finishedAt - manifest.startedAt : null),
      (manifest?.artifacts || []).map(artifact => artifact.name).join(' ')
    ];
  });

  const detail = runs.map(item => {
    const manifest = item.manifest;
    if (!manifest) return '';
    const metrics = manifestMetrics(manifest);
    const parts = [
      heading(4, `${item.code || '未编号尝试'}${item.label ? ` · ${item.label}` : ''}`),
      bullets([
        `模板：${manifest.template?.id || ''}${manifest.template?.version ? ` v${manifest.template.version}` : ''}`,
        `运行编号：${manifest.runId || '未记录'}`,
        `状态：${manifest.status}${manifest.exitCode === null || manifest.exitCode === undefined ? '' : `（退出码 ${manifest.exitCode}）`}`,
        manifest.startedAt ? `开始：${formatTime(manifest.startedAt)}` : '',
        manifest.finishedAt ? `结束：${formatTime(manifest.finishedAt)}` : '',
        manifest.error ? `失败原因：${clip(manifest.error, 400)}` : ''
      ]),
      publicParams(manifest.params).length ? table(['参数', '取值'], publicParams(manifest.params)) : '',
      metrics.length ? table(['指标', '数值'], metrics) : '',
      (manifest.artifacts || []).length
        ? table(['产物', '字节', 'SHA-256'], manifest.artifacts.map(artifact => [artifact.name, artifact.bytes, (artifact.sha256 || '').slice(0, 16)]))
        : '',
      publicEnv(manifest.env).length ? table(['环境', '取值'], publicEnv(manifest.env)) : ''
    ];
    return block(parts);
  }).filter(Boolean);

  const summary = family?.summary && typeof family.summary === 'object' ? family.summary : null;
  const summaryBody = summary
    ? block([
        `完成 ${summary.completed ?? 0}/${summary.total ?? runs.length} 次运行。`,
        summary.best && summary.best.metric ? `最优 ${summary.best.metric} = ${formatNumber(summary.best.value)}（${summary.best.label || ''}）` : ''
      ])
    : '';

  const analysisText = artifactByStage(run?.artifacts, 'experiment-analyze');
  const reportText = artifactByStage(run?.artifacts, 'experiment-report');

  const body = block([
    family?.skipped ? `本轮按判断跳过实验：${family.reason || '未说明原因'}` : '',
    family?.error ? `实验族未能完成：${clip(family.error, 400)}` : '',
    designBody,
    trialRows.length ? table(['编号', '尝试', '状态', '主指标', '耗时', '产物'], trialRows) : '',
    trialRows.length ? '编号 E1、E2… 与答案正文里的 [E1] 一一对应，只给成功的运行；失败尝试保留在表里但不占编号。' : '',
    summaryBody,
    detail.length ? `${heading(3, '逐次运行记录')}\n\n${detail.join('\n\n')}` : '',
    analysisText ? `${heading(3, '结果分析')}\n\n${clip(analysisText, 6000)}` : '',
    reportText ? `${heading(3, '实验记录')}\n\n${clip(reportText, 4000)}` : ''
  ]);
  return body ? block([heading(2, '实验运行'), body]) : '';
}

function verifySection(run) {
  const integrity = run?.integrity && typeof run.integrity === 'object' ? run.integrity : null;
  const experiments = run?.experiments && typeof run.experiments === 'object' ? run.experiments : null;
  const parts = [];
  if (integrity) {
    const counts = integrity.counts || {};
    parts.push(block([
      `${heading(3, '文献引用')}`,
      bullets([
        integrity.ran ? `核验结果：${integrity.ok ? '全部可核验' : '存在未核验引用'}` : '未执行核验',
        integrity.librarySize !== undefined ? `资料库规模：${integrity.librarySize} 条` : '',
        counts.total !== undefined ? `引用标记：${counts.total} 处（已核验 ${counts.resolved ?? 0}，未核验 ${counts.unresolved ?? 0}，已移除 ${counts.removed ?? 0}）` : '',
        integrity.note ? String(integrity.note) : ''
      ]),
      Array.isArray(integrity.unresolved) && integrity.unresolved.length ? `未核验清单：${integrity.unresolved.slice(0, 40).join('、')}` : ''
    ]));
  }
  if (experiments) {
    const markers = experiments.markers || {};
    const numbers = experiments.numbers || {};
    parts.push(block([
      `${heading(3, '实验数字')}`,
      bullets([
        experiments.ran ? `核验结果：${experiments.ok ? '全部绑定到真实运行' : '存在无法核对的数字'}` : '未执行核验',
        Array.isArray(markers.resolved) ? `运行标记：已绑定 ${markers.resolved.length} 处，未绑定 ${(markers.unresolved || []).length} 处` : '',
        Array.isArray(numbers.bound) ? `数值：已核对 ${numbers.bound.length} 个，未核对 ${(numbers.unsourced || []).length} 个` : '',
        experiments.note ? String(experiments.note) : ''
      ]),
      Array.isArray(numbers.unsourced) && numbers.unsourced.length
        ? `未核对数值：${numbers.unsourced.slice(0, 20).map(item => (typeof item === 'string' ? item : item?.value ?? '')).filter(Boolean).join('、')}`
        : ''
    ]));
  }
  return parts.filter(Boolean).length ? block([heading(2, '核验'), parts.filter(Boolean).join('\n\n')]) : '';
}

function auditSection(run) {
  const audit = run?.audit && typeof run.audit === 'object' ? run.audit : null;
  if (!audit) return '';
  const checks = Array.isArray(audit.checks) ? audit.checks : [];
  const review = audit.review && typeof audit.review === 'object' ? audit.review : null;
  const body = block([
    audit.verdict ? `**结论**：${audit.verdict === 'pass' ? '通过' : audit.verdict === 'attention' ? '需要留意' : audit.verdict}` : '',
    checks.length ? table(['检查项', '结果', '说明'], checks.map(check => [check.name, check.ok ? '通过' : '未通过', check.detail])) : '',
    review
      ? block([
          `${heading(3, '模型复核')}`,
          bullets([
            review.verdict ? `复核结论：${review.verdict}` : '',
            review.error ? `复核失败：${clip(review.error, 200)}` : ''
          ]),
          Array.isArray(review.fabrications) && review.fabrications.length ? `**疑似编造**\n\n${bullets(review.fabrications)}` : '',
          Array.isArray(review.unsupported) && review.unsupported.length ? `**缺乏支撑**\n\n${bullets(review.unsupported)}` : '',
          Array.isArray(review.fixes) && review.fixes.length ? `**建议修正**\n\n${bullets(review.fixes)}` : ''
        ])
      : ''
  ]);
  return body ? block([heading(2, '终审自检'), body]) : '';
}

function stageSection(run) {
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
  if (!artifacts.length) return '';
  const rows = artifacts.map(artifact => [
    artifact.stageLabel || artifact.stage,
    artifact.kind === 'final' ? '成形' : artifact.kind === 'notice' ? '提示' : '公开产出',
    artifact.status,
    `${artifact.provider || ''}${artifact.model ? ` / ${artifact.model}` : ''}`.trim(),
    typeof artifact.text === 'string' ? artifact.text.length : 0,
    formatDuration(artifact.finishedAt && artifact.startedAt ? artifact.finishedAt - artifact.startedAt : null),
    artifact.taskLabel || ''
  ]);
  return block([heading(2, '阶段产出记录'), table(['阶段', '类型', '状态', '模型', '字数', '耗时', '任务'], rows)]);
}

function headerSection(conversation, message, run, now) {
  const created = conversation?.createdAt || message?.timestamp;
  return bullets([
    `导出时间：${formatTime(now)}`,
    created ? `对话创建：${formatTime(created)}` : '',
    run?.profileName || run?.profile ? `档位：${run.profileName || run.profile}${run.tier ? `（${run.tier}）` : ''}` : '',
    run?.callsUsed !== undefined ? `模型调用：${run.callsUsed}${run.callBudget ? ` / ${run.callBudget}` : ''}` : '',
    run?.stages?.length ? `计划阶段：${run.stages.length} 个` : '',
    run?.planVersion ? `计划版本：${run.planVersion}` : '',
    run?.finishedAt && run?.startedAt ? `本轮耗时：${formatDuration(run.finishedAt - run.startedAt)}` : '',
    conversation?.models?.length ? `对话通道：${conversation.models.join('、')}` : ''
  ]);
}

function writerSection(run) {
  const participants = Array.isArray(run?.participants) ? run.participants : [];
  const rows = participants.map(item => [item.role || '', item.provider || '', item.model || '', item.effort || '']);
  return rows.length ? table(['角色', '通道', '模型', '力度'], rows) : '';
}

function reproduceSection(run, manifests) {
  const runs = labelRuns(run?.experimentRuns, manifests);
  const rows = runs
    .filter(item => item.manifest)
    .map(item => [
      item.code,
      item.manifest.runId,
      item.manifest.template?.id || '',
      item.manifest.template?.version ?? '',
      (item.manifest.artifacts || []).map(artifact => `${artifact.name} ${(artifact.sha256 || '').slice(0, 16)}`).join('；')
    ]);
  /* 没有运行记录就没有可复现的东西，整段不出现。 */
  if (!rows.length) return '';
  const body = block([
    table(['编号', '运行编号', '模板', '版本', '产物（名称 + 哈希前缀）'], rows),
    '同机复现：用上面的运行编号在应用内打开对应运行记录，即可看到完整参数、环境指纹与原产物校验值。'
  ]);
  return body ? block([heading(2, '复现信息'), body]) : '';
}

function metaSection(conversation, message, run) {
  return bullets([
    conversation?.id ? `对话编号：${conversation.id}` : '',
    message?.id ? `消息编号：${message.id}` : '',
    message?.roundId ? `轮次编号：${message.roundId}` : '',
    run?.policyVersion ? `策略版本：${run.policyVersion}` : '',
    message?.provider ? `答案主笔通道：${message.provider}` : ''
  ]);
}

/**
 * 生成科研结果导出正文。
 * @param {{ conversation?: object, message?: object, manifests?: object[], records?: object[], now?: number }} input
 */
function researchReport({ conversation, message, manifests = [], records = [], now = Date.now() } = {}) {
  const run = message?.collaboration && typeof message.collaboration === 'object' ? message.collaboration : {};
  const answer = String(message?.text || '').trim();
  const title = String(conversation?.title || '科研结果').trim() || '科研结果';

  const parts = [
    heading(1, title),
    headerSection(conversation, message, run, now),
    run.status && run.status !== 'done' ? `> 本轮状态为「${run.status}」${run.error ? `：${run.error}` : ''}，以下内容是该状态下已完成的产出。` : '',
    answer ? block([heading(2, '结论'), demoteHeadings(answer)]) : '',
    verifySection(run),
    experimentSection(run, manifests),
    scopeSection(run.scope),
    evidenceSection(run),
    librarySection(run.knowledge, records),
    planSection(run.plan),
    selectionSection(run.selection),
    auditSection(run),
    stageSection(run),
    reproduceSection(run, manifests),
    writerSection(run) ? block([heading(2, '本轮模型分配'), writerSection(run)]) : '',
    metaSection(conversation, message, run) ? block([heading(2, '元数据'), metaSection(conversation, message, run)]) : ''
  ];

  return `${block(parts)}\n`;
}

/** 普通（非科研）对话导出：保留原有排版，只做标题与正文分段。 */
function conversationMarkdown(conversation) {
  const title = String(conversation?.title || '对话').trim() || '对话';
  const lines = [heading(1, title), ''];
  for (const message of conversation?.messages || []) {
    const who = message.role === 'user' ? '你' : message.kind === 'answer' ? '完整答案' : '助手';
    lines.push(heading(2, who), '');
    lines.push(String(message.text || '').trim() || '（空）', '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 导出文件名：清掉 Windows 保留字符，保留可读标题与时间戳。 */
function suggestFileName({ conversation, message, now = Date.now() } = {}) {
  const run = message?.collaboration || {};
  const prefix = run.mode === 'research' ? '科研结果' : '对话记录';
  const raw = String(conversation?.title || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  const base = (raw || prefix).slice(0, 60);
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${prefix}-${base}-${stamp}.md`;
}

module.exports = {
  researchReport,
  conversationMarkdown,
  suggestFileName,
  formatTime,
  formatNumber,
  table,
  labelRuns
};
