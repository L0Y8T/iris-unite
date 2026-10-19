/* Iris Unite 的模型连接与科研流程配置。
 *
 * 这一版的重点：每个科研环节的模型都能单独选（含原来写死的统筹与终审），
 * 并且流程从「检索真实资料」开始，所以配置里多了一整块检索设置。
 */
function irisMark() { return '<span class="iris-mark"><img class="iris-light" src="../assets/iris.svg" alt=""><img class="iris-dark" src="../assets/iris-dark.svg" alt=""></span>'; }
function runMode() { return state.active?.mode || state.mode || 'standard'; }
/** 读取当前科研配置。旧对话里存的是 0.5.0 的 v2/v3 结构，这里就地补齐到 v4 形状。
 *  档位、预算与环节的规则由主进程（core/profiles.cjs）判定，界面只负责把它显示出来。 */
function currentResearch() {
  const c = clone(state.active?.researchConfig || state.researchConfig || state.settings.defaultResearchConfig);
  if (!c.choices) {
    const plan = c.orchestrator || null, final = c.reviewer || null;
    c.choices = { scope: plan, evidence: plan, plan, screen: plan, final, audit: null, summarize: null };
  }
  if (!c.retrieval) c.retrieval = { enabled: true, sources: ['openalex', 'crossref', 'arxiv', 'pubmed'], perSource: 10, yearFrom: null, maxQueries: 4 };
  if (!c.retrieval.maxRecordsPerSource) c.retrieval.maxRecordsPerSource = Number(c.retrieval.perSource) || 10;
  if (!c.monitor) c.monitor = { enabled: true };
  if (!c.experiments) c.experiments = { enabled: false, maxTrials: 4, maxRounds: 2, templateId: null, stopWhen: '指标不再提升或达到 trial 上限' };
  if (!c.profile) c.profile = 'p1-review';
  if (!c.tier) c.tier = 'readonly';
  if (!c.budget) c.budget = { maxCalls: Number(c.maxCalls) || 8, wallClockSec: 900, modelTimeoutSec: 300, maxConcurrentModels: 2, maxModelRetryAttempts: 0, maxRepairAttempts: 0 };
  if (!c.refinement) c.refinement = { maxTasks: 2, maxPassesPerTask: 1 };
  if (!c.teaching) c.teaching = { audience: '有基础的初学者', prerequisites: [], learningGoal: '理解概念及适用边界', chapterCount: 2, chapterChoices: {}, numericPolicy: 'builtin-arithmetic-only' };
  if (!c.evidence) c.evidence = { policyVersion: 1, requireSnippet: true, unsupportedPolicy: 'quarantine-block', allowGeneralTeaching: false };
  if (!Array.isArray(c.tasks)) c.tasks = [];
  c.version = 4;
  return c;
}

/* 档位元信息与环节表都从主进程取，界面不复制规则。 */
function researchMeta() {
  return state.researchProfiles || { ids: ['p1-review'], implemented: ['p1-review'], info: [{ id: 'p1-review', name: '综述', roles: ['scope', 'evidence', 'plan', 'screen', 'final'], roleLabels: {} }] };
}
function profileInfo(id) {
  const meta = researchMeta();
  return meta.info.find(p => p.id === id) || meta.info[0];
}
/* 实验族的两个角色只在开启自动实验时才需要模型，关掉时不显示、也不写回空值。 */
const EXPERIMENT_ROLES = ['experimentDesign', 'experimentAnalyze'];
function experimentsOn(c) {
  return c?.profile === 'p1-review' && c?.experiments?.enabled === true;
}
/** 会调用模型的环节：本档活跃角色（实验关闭时剔除实验角色）。核验与终审自检是机械环节，不占预算。 */
function activeStageRows(c) {
  const info = profileInfo(c.profile);
  const on = experimentsOn(c);
  return (info.roles || [])
    .filter(role => on || !EXPERIMENT_ROLES.includes(role))
    .filter(role => c.choices?.[role])
    .map(role => [role, info.roleLabels?.[role] || role]);
}

/* 会调用模型的环节按档位不同，本地只保留兜底顺序；标签从主进程的规则表来。 */
const RESEARCH_STAGES = [
  ['scope', '研究界定', '把问题拆成研究问题、检索式与纳入 / 排除标准'],
  ['evidence', '证据提取', '只从资料库记录里抽取结论、证据强度与缺口'],
  ['summarize', '要点汇总', '速查档收口：把证据收成带引用的短答案'],
  ['plan', '问题分解', '分解任务、规定交付物与评审准则'],
  ['screen', '候选筛选', '按证据、创新性与反例风险筛选候选'],
  ['experimentDesign', '实验设计', '把候选方向变成假设、指标、搜索空间与停止条件'],
  ['experimentAnalyze', '结果分析', '读真实指标，决定是否调参、调什么、何时停'],
  ['final', '反证与整合', '检验证据与反例，形成唯一完整答案']
];

function renderModeControls() {
  const busy = state.busy.has(state.active?.id), mode = runMode();
  $('#composer-mode').classList.toggle('hidden', !!isHistory());
  document.querySelectorAll('[data-run-mode]').forEach(button => { button.classList.toggle('selected', button.dataset.runMode === mode); button.setAttribute('aria-pressed', String(button.dataset.runMode === mode)); button.disabled = busy || !!isHistory(); });
  $('#research-config-button').classList.toggle('hidden', mode !== 'research'); $('#research-config-button').disabled = busy;
}
async function changeRunMode(mode) {
  if (state.busy.has(state.active?.id) || isHistory()) return;
  if (state.active) { const id = state.active.id, updated = await window.duet.runConfig(id, mode, currentResearch()); if (state.active?.id === id) { state.active.mode = updated.mode; state.active.researchConfig = updated.researchConfig; } }
  state.mode = mode; renderModels(); renderRunStatus();
}

/** 输入区下面那排芯片：把每个环节实际会用到的模型直接摊开，不用点开面板才知道。 */
function researchModelChips(busy) {
  const c = currentResearch(), rows = [];
  for (const [key, label] of activeStageRows(c)) if (c.choices?.[key]) rows.push({ title: label, choice: c.choices[key], key });
  for (const t of c.tasks || []) if (t.choice) rows.push({ title: t.title, choice: t.choice, key: 'task:' + t.id });
  const sources = c.retrieval?.enabled ? `<span class="research-chip-source" title="${esc((c.retrieval.sources || []).join('、'))}">${icon('search')}检索 ${(c.retrieval.sources || []).length} 源</span>` : '<span class="research-chip-source off">未启用检索</span>';
  const tier = `<span class="research-profile-chip" title="档位决定跑哪些环节">${esc(profileInfo(c.profile).name)}</span>`;
  return tier + rows.map(r => `<button class="research-model-chip" data-open-research ${busy ? 'disabled' : ''} title="${esc(r.title)}：${esc(modelName(r.choice.provider, r.choice.model))}"><span class="research-chip-role">${esc(r.title)}</span><span>${esc(modelName(r.choice.provider, r.choice.model))}</span><small>${esc(effortLabel(r.choice.effort))}</small></button>`).join('') + sources;
}

function researchWelcome() {
  const c = currentResearch();
  const info = profileInfo(c.profile);
  const enabled = !c.retrieval || c.retrieval.enabled !== false;
  const outputChoice = c.choices?.[info.outputRole] || c.choices?.final || c.choices?.scope;
  const outputLabel = info.roleLabels?.[info.outputRole] || '最终答案';
  const row = (glyph, title, detail) => `<div>${icon(glyph)}<span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span></div><span class="research-flow-arrow">${icon('down')}</span>`;
  return `<div class="research-welcome">`
    + row('search', enabled ? '先检索真实资料' : '未启用资料检索', enabled ? `${(c.retrieval.sources || []).length} 个学术源，每源最多 ${c.retrieval.maxRecordsPerSource || c.retrieval.perSource} 条` : '答案里的引用将无法核验')
    + row('plan', `${esc(info.name)}档：每个环节单独选模型`, `${esc(modelName(c.choices?.scope?.provider, c.choices?.scope?.model))} → ${esc(modelName(outputChoice?.provider, outputChoice?.model))}（${esc(outputLabel)}）`)
    + (c.tasks?.length ? row('compare', `${c.tasks.length} 项并行研究任务`, c.tasks.map(t => modelName(t.choice.provider, t.choice.model)).join(' + ')) : '')
    + row('check', '引用核验与终审自检', '引用指不回资料库就当场移除，不占用调用预算')
    + `<button class="secondary-button" data-open-research>配置科研流程${icon('settings')}</button></div>`;
}

function researchArtifact(a, run) {
  if (a.status !== 'done') return '';
  if (a.stage === 'research-scope' && run.scope) {
    const s = run.scope;
    return `<p><strong>研究目标：</strong>${esc(s.objective)}</p>`
      + `<p><strong>研究问题：</strong></p><ol>${(s.questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ol>`
      + `<p><strong>检索式：</strong></p><ul>${(s.queries || []).map(q => `<li><code>${esc(q)}</code></li>`).join('')}</ul>`
      + `<p><strong>纳入标准：</strong>${(s.inclusion || []).map(esc).join('；') || '未给出'}</p>`
      + `<p><strong>排除标准：</strong>${(s.exclusion || []).map(esc).join('；') || '未给出'}</p>`;
  }
  if (a.stage === 'research-evidence' && run.evidence) {
    const e = run.evidence;
    const claims = (e.claims || []).map(c => `<li>${esc(c.claim)} <span class="evidence-keys">${c.keys.map(k => '[' + esc(k) + ']').join(' ')}</span> <small>${esc(c.strength)}${c.limitation ? ' · ' + esc(c.limitation) : ''}</small></li>`).join('');
    return `${claims ? `<p><strong>已验证证据：</strong></p><ol>${claims}</ol>` : '<p>没有从资料库中提取到可直接支撑的结论。</p>'}`
      + `<p><strong>证据缺口：</strong>${(e.gaps || []).map(esc).join('；') || '无'}</p>`
      + (run.evidenceSanitized?.unsupportedClaims ? `<p class="muted">有 ${run.evidenceSanitized.unsupportedClaims} 条结论没有对应的资料库记录，已标记为假设。</p>` : '');
  }
  if (a.stage === 'research-plan' && run.researchPlan) {
    const p = run.researchPlan;
    return `<p><strong>研究目标：</strong>${esc(p.objective)}</p><ol>${p.tasks.map(t => `<li><strong>${esc(t.id)}</strong> ${esc(t.assignment)}<br>${esc(t.deliverable)}${t.evidenceKeys?.length ? `<br><small>依据：${t.evidenceKeys.map(k => '[' + esc(k) + ']').join(' ')}</small>` : ''}</li>`).join('')}</ol><p><strong>筛选准则：</strong>${esc(p.selectionCriteria)}</p>`;
  }
  if (a.stage === 'research-screen' && run.selection) {
    const s = run.selection;
    return `<p><strong>保留候选：</strong>${s.selectedIds.map(esc).join('、')}</p><p>${esc(s.reason)}</p><p><strong>深化要求：</strong>${esc(s.feedback || '无需追加深化')}</p>`
      + (s.unsupported?.length ? `<p><strong>缺乏证据支撑：</strong>${s.unsupported.map(esc).join('；')}</p>` : '')
      + (s.budgetNote ? `<p>${esc(s.budgetNote)}</p>` : '') + (s.monitorNote ? `<p>${esc(s.monitorNote)}</p>` : '');
  }
  return '';
}

/** 「协作记录」页里的资料库与核验摘要。 */
function researchSummary(run) {
  if (run.mode !== 'research') return '';
  const k = run.knowledge;
  const rows = [];
  if (k) rows.push(`<li>资料库：${k.total} 条记录，${k.withDoi} 条带 DOI${k.yearRange ? `，年份 ${k.yearRange[0]}–${k.yearRange[1]}` : ''}${k.queries?.length ? `；检索式 ${k.queries.length} 条` : ''}</li>`);
  if (run.integrity?.ran) rows.push(`<li>引用核验：${run.integrity.ok ? '全部可核验' : `移除 ${run.integrity.removed?.length || 0} 处无法核验的引用`}（共 ${run.integrity.stats?.totalCitations ?? 0} 处引用，记录 ${run.integrity.stats?.totalRecords ?? 0} 条）</li>`);
  if (run.audit) rows.push(`<li>终审自检：${run.audit.verdict === 'passed' ? '全部检查通过' : '需要关注'}${run.audit.review ? `；模型复核 ${esc(run.audit.review.verdict)}` : ''}</li>`);
  if (run.monitorLog?.length) rows.push(`<li>监控提示：${run.monitorLog.map(d => esc(d.reason)).join('；')}</li>`);
  if (!rows.length) return '';
  return `<div class="process-note research-summary"><strong>完整性与证据</strong><ul>${rows.join('')}</ul></div>`;
}

function connectionReady(id) { const c = state.settings.connections?.find(c => c.id === id); return id === 'gpt' ? state.settings.codexAvailable : id === 'deepseek' ? state.settings.hasKey : !!c && (c.hasKey || c.allowNoKey); }
function renderModelPicker() {
  const selected = state.active?.models || state.models;
  $('#model-picker-list').innerHTML = (state.catalog.providers || ['deepseek', 'gpt']).map(p => {
    const chosen = config()[p], ready = connectionReady(p);
    return `<button type="button" class="model-picker-row ${selected.includes(p) ? 'selected' : ''}" data-picker-model="${esc(p)}" aria-pressed="${selected.includes(p)}"><span class="picker-check">${icon('check')}</span><span><strong>${esc(modelName(p, chosen?.model))}</strong><small>${esc(chosen?.model || '')}</small></span><span class="model-ready">${ready ? '可用' : '待配置'}</span></button>`;
  }).join('');
}
function openModelPicker() { closePopover(); renderModelPicker(); $('#models-dialog').showModal(); }
function applyConnectionResult(data) {
  state.settings = data.settings; state.catalog = data.modelCatalog;
  if (!state.active) state.config = { ...state.settings.defaultModelConfig, ...state.config };
  renderConnections(); renderModels(); renderSidebar();
  if ($('#models-dialog').open) renderModelPicker();
}
function renderConnections() {
  const items = state.settings.connections || [];
  $('#connections-list').innerHTML = items.length ? items.map(c => `<div class="connection-row"><div class="connection-row-info"><strong>${esc(c.name)}<span class="connection-enabled">${c.enabled ? '已启用' : '已停用'}</span></strong><small>${esc(c.model)}<br>${esc(c.protocol === 'anthropic' ? 'Claude Messages' : 'OpenAI 兼容')} / ${esc(new URL(c.baseUrl).host)} / ${c.hasKey ? '密钥已保存' : c.allowNoKey ? '无需密钥' : '待填写密钥'}</small></div><div class="connection-row-actions"><button type="button" data-test-connection="${esc(c.id)}">测试</button><button type="button" data-edit-connection="${esc(c.id)}">编辑</button><button type="button" data-remove-connection="${esc(c.id)}" aria-label="移除 ${esc(c.name)}">移除</button></div></div>`).join('') : '<div class="connections-empty">尚未添加其他模型。可从服务商预设一键填入地址，也可以连接任何 OpenAI 兼容或 Claude 格式的服务。</div>';
}
/* 单价表：每个通道一行。留空就是不计价——不给任何「参考价」，价格写死就会变成错账单。 */
function renderPricingList() {
  const host = $('#pricing-list');
  if (!host) return;
  const table = state.settings.pricing || {};
  const channels = [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'gpt', name: 'GPT · Codex' }];
  for (const connection of state.settings.connections || []) channels.push({ id: connection.id, name: connection.name || connection.id });
  host.innerHTML = channels.map(channel => {
    const entry = table[channel.id] || {};
    const value = key => (Number(entry[key]) > 0 ? esc(String(entry[key])) : '');
    return `<div class="pricing-row" data-provider="${esc(channel.id)}"><span class="pricing-name" title="${esc(channel.id)}">${esc(channel.name)}</span><label class="pricing-field"><span>输入</span><input type="number" min="0" step="0.01" inputmode="decimal" data-price-input value="${value('input')}" placeholder="0" aria-label="${esc(channel.name)} 输入单价（每百万 token）"></label><label class="pricing-field"><span>输出</span><input type="number" min="0" step="0.01" inputmode="decimal" data-price-output value="${value('output')}" placeholder="0" aria-label="${esc(channel.name)} 输出单价（每百万 token）"></label><label class="pricing-field"><span>币种</span><select data-price-currency aria-label="${esc(channel.name)} 计价币种"><option value="CNY"${(entry.currency || 'CNY') === 'CNY' ? ' selected' : ''}>¥ 人民币</option><option value="USD"${entry.currency === 'USD' ? ' selected' : ''}>$ 美元</option><option value="EUR"${entry.currency === 'EUR' ? ' selected' : ''}>€ 欧元</option></select></label></div>`;
  }).join('') + '<p class="pricing-hint">按每百万 token 计价。输入价与输出价都留空表示不计价；用量旁边会显示「未设单价」而不是一个猜出来的数字。</p>';
}
function collectPricing() {
  const table = {};
  for (const row of document.querySelectorAll('#pricing-list .pricing-row')) {
    const provider = row.dataset.provider;
    const input = Number(row.querySelector('[data-price-input]')?.value);
    const output = Number(row.querySelector('[data-price-output]')?.value);
    if (!(input > 0) && !(output > 0)) continue;
    table[provider] = { input: input > 0 ? input : 0, output: output > 0 ? output : 0, currency: row.querySelector('[data-price-currency]')?.value || 'CNY' };
  }
  return table;
}

function protocolFields() {
  const claude = $('#connection-protocol').value === 'anthropic', current = $('#connection-effort').value;
  $('#connection-effort').innerHTML = `<option value="none">服务端默认（不发送参数）</option><option value="${claude ? 'anthropic' : 'openai'}">${claude ? 'output_config.effort' : 'reasoning_effort'}</option>`;
  $('#connection-effort').value = ['none', claude ? 'anthropic' : 'openai'].includes(current) ? current : 'none';
}
function presetOptions(current) {
  const list = state.settings.presets || [];
  return `<option value="">自定义</option>` + list.map(p => `<option value="${esc(p.id)}" ${p.id === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
function applyPreset(id) {
  const preset = (state.settings.presets || []).find(p => p.id === id);
  const hint = $('#connection-preset-hint');
  if (!preset) { hint.textContent = '自定义连接：请手动填写地址与接口格式。'; return; }
  if (preset.baseUrl) $('#connection-url').value = preset.baseUrl;
  $('#connection-protocol').value = preset.protocol;
  protocolFields();
  $('#connection-effort').value = preset.effortMode;
  $('#connection-no-key').checked = preset.allowNoKey === true;
  if (!$('#connection-name').value) $('#connection-name').value = preset.name;
  if (!$('#connection-model').value && preset.modelHint) $('#connection-model').value = preset.modelHint;
  hint.textContent = `${preset.note || ''} 地址与模型 ID 以服务商文档为准，可随时手改。`;
}
function openConnection(id) {
  const c = state.settings.connections?.find(c => c.id === id);
  $('#connection-form').reset();
  $('#connection-id').value = c?.id || '';
  $('#connection-title').textContent = c ? '编辑模型连接' : '添加模型连接';
  $('#connection-preset').innerHTML = presetOptions(c?.preset || '');
  $('#connection-name').value = c?.name || '';
  $('#connection-protocol').value = c?.protocol || 'openai';
  protocolFields();
  $('#connection-url').value = c?.baseUrl || '';
  $('#connection-model').value = c?.model || '';
  $('#connection-model-options').innerHTML = '';
  $('#connection-effort').value = c?.effortMode || 'none';
  $('#connection-tokens').value = c?.maxTokens || 8192;
  $('#connection-enabled').checked = c?.enabled !== false;
  $('#connection-no-key').checked = !!c?.allowNoKey;
  $('#connection-clear-row').classList.toggle('hidden', !c?.hasKey);
  $('#connection-error').textContent = '';
  $('#connection-key').value = '';
  $('#connection-preset-hint').textContent = '选择预设会自动填好地址、接口格式与推理参数形态；也可以直接手填。';
  if (!c) applyPreset('openai');
  $('#connection-dialog').showModal();
  $('#connection-name').focus();
}
function readConnection() {
  return {
    id: $('#connection-id').value || undefined,
    preset: $('#connection-preset').value || undefined,
    name: $('#connection-name').value,
    protocol: $('#connection-protocol').value,
    baseUrl: $('#connection-url').value,
    model: $('#connection-model').value,
    apiKey: $('#connection-key').value,
    clearKey: $('#connection-clear-key').checked,
    effortMode: $('#connection-effort').value,
    maxTokens: Number($('#connection-tokens').value),
    enabled: $('#connection-enabled').checked,
    allowNoKey: $('#connection-no-key').checked
  };
}

function choiceOptions(current) {
  const providers = state.catalog.providers || ['gpt', 'deepseek'];
  let found = false;
  const options = providers.map(p => `<optgroup label="${esc(providerName(p))}">${(state.catalog[p] || []).map(m => {
    const selected = !!current && current.provider === p && current.model === m.id;
    if (selected) found = true;
    return `<option value="${esc(JSON.stringify({ provider: p, model: m.id }))}" ${selected ? 'selected' : ''}>${esc(m.name)}</option>`;
  }).join('')}</optgroup>`).join('');
  const fallback = current && !found ? `<option value="${esc(JSON.stringify({ provider: current.provider, model: current.model }))}" selected>${esc(current.model)}（不可用）</option>` : '';
  return fallback + options;
}
function effortOptions(current) {
  const options = state.catalog[current?.provider]?.find(m => m.id === current?.model)?.efforts || [current?.effort || 'default'];
  return options.map(e => `<option value="${esc(e)}" ${e === current?.effort ? 'selected' : ''}>${esc(effortLabel(e))}</option>`).join('');
}
let researchDraft;
function researchChoiceFields(key, value, label) {
  return `<div class="research-choice-fields"><label>${esc(label)}模型<select data-research-choice="${esc(key)}" aria-label="${esc(label)}模型">${choiceOptions(value)}</select></label><label>强度<select data-research-effort="${esc(key)}" aria-label="${esc(label)}推理强度">${effortOptions(value)}</select></label></div>`;
}

/* 计划预览：全部由主进程的计划编译器算，界面只显示结果。 */
let researchPlanCache = null;
async function refreshPlanPreview() {
  try {
    researchPlanCache = await window.duet.plan({ config: collectResearchForm() });
  } catch (e) {
    researchPlanCache = { ok: false, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '') };
  }
  return researchPlanCache;
}

function renderPlanPreview() {
  const plan = researchPlanCache;
  if (!plan) return '';
  if (plan.ok === false) return `<div class="plan-preview-bad">${esc(plan.error || '配置还不能运行')}</div>`;
  const effective = plan.effective || {};
  const coverage = effective.coverage;
  const sources = coverage === 'disabled' ? '不检索（引用无法核验）' : `${coverage === 'full' ? '全部可用' : coverage === 'partial' ? '部分可用' : coverage === 'restricted' ? '受限匿名' : '不可用'}${(effective.usableSources || []).length ? `（${effective.usableSources.length} 源）` : ''}`;
  const problems = (plan.readiness?.problems || []).map(p => `<li>${esc(p.message)}</li>`).join('');
  const warnings = (effective.warnings || []).map(w => `<li>${esc(w.message)}</li>`).join('');
  const stages = plan.stages || [];
  const modelStages = stages.filter(s => s.type === 'model').length;
  return `<div class="plan-preview-grid">`
    + `<span>档位</span><strong>${esc(plan.profileName || plan.profile)}（Tier ${esc(plan.tier || 'readonly')}）</strong>`
    + `<span>环节</span><strong>${stages.length} 个环节，其中 ${modelStages} 个会调用模型；基准 ${plan.baseCalls ?? '-'} 次调用</strong>`
    + `<span>预算</span><strong>上限 ${plan.maxCalls} 次，为收口保留 ${plan.reserve} 次，可留 ${Math.max(0, plan.maxCalls - (plan.baseCalls || 0))} 次给可选环节</strong>`
    + `<span>检索</span><strong>${esc(sources)}</strong>`
    + `<span>计划版本</span><strong>${esc(plan.planVersion || '-')}</strong>`
    + `</div>`
    + (problems ? `<p class="plan-preview-problem">还不能运行：</p><ul class="plan-preview-list">${problems}</ul>` : '')
    + (warnings ? `<ul class="plan-preview-list">${warnings}</ul>` : '');
}

function renderResearchForm() {
  const c = researchDraft;
  const meta = researchMeta();
  const info = profileInfo(c.profile);
  const implemented = (meta.implemented || []).includes(c.profile);
  const retrieval = c.retrieval || { enabled: true, sources: [], maxRecordsPerSource: 10, yearFrom: null, maxQueries: 4 };
  const sources = state.settings.retrievalSources || [];
  const profileButtons = meta.info.map(p => {
    const enabled = (meta.implemented || []).includes(p.id);
    const selected = p.id === c.profile;
    return `<button type="button" class="research-profile-option${selected ? ' selected' : ''}" data-research-profile="${esc(p.id)}" aria-pressed="${selected}" ${enabled ? '' : 'disabled'}>`
      + `<strong>${esc(p.name)}</strong>`
      + `<small>${enabled ? `${(p.roles || []).length} 个模型环节${p.tasks?.[1] ? `，最多 ${p.tasks[1]} 项并行任务` : ''}` : '尚未实现'}</small>`
      + `</button>`;
  }).join('');
  $('#research-profile').innerHTML = `<div class="research-profile-heading"><strong>档位</strong><span>档位决定跑哪些环节、要几次调用；环节内部的模型仍然逐个可选。</span></div><div class="research-profile-options">${profileButtons}</div>`
    + (implemented ? '' : `<p class="plan-preview-problem">教学档本期只做配置与计划预览，暂不能真正运行：分段生成、例题与算式校验在后续里程碑补齐。</p>`);
  $('#research-plan-preview').innerHTML = renderPlanPreview();
  const stageRows = activeStageRows(c).map(([key, label]) => {
    const detail = (RESEARCH_STAGES.find(s => s[0] === key) || [key, label, ''])[2];
    return `<section class="research-stage"><div class="research-layer-heading"><span class="layer-number">${(info.stages || []).findIndex(s => s.role === key) + 1 || '·'}</span><div><h3>${esc(label)}</h3><p>${esc(detail)}</p></div></div>${researchChoiceFields(key, c.choices[key], label)}</section>`;
  }).join('');
  const auditRow = `<section class="research-stage research-stage-optional"><div class="research-layer-heading"><span class="layer-number">＋</span><div><h3>终审复核（可选）</h3><p>额外加一次模型复核，检查编造、把假设写成事实、结论超出证据。不选则只做机械自检，不消耗调用。</p></div></div><label class="research-audit-label">复核模型<select data-research-choice="audit" aria-label="终审复核模型"><option value="" ${!c.choices.audit ? 'selected' : ''}>不使用模型（只做机械自检）</option>${choiceOptions(c.choices.audit)}</select></label>${c.choices.audit ? researchChoiceFields('audit', c.choices.audit, '终审复核') : ''}</section>`;
  const [minTasks, maxTasks] = info.tasks || [0, 0];
  const tasks = maxTasks > 0 ? `<section class="research-workers"><div class="research-workers-heading"><div><h3>并行研究任务</h3><p>每项任务可以选不同模型；同一个模型也可以承担不同任务。</p></div><button type="button" data-add-research-task class="secondary-button" ${c.tasks.length >= maxTasks ? 'disabled' : ''}>${icon('plus')}添加任务</button></div><div class="research-task-grid">${c.tasks.map((t, i) => `<div class="research-task" data-research-task="${esc(t.id)}"><div class="research-task-heading"><span>任务 ${i + 1}</span><button type="button" class="icon-button" data-remove-research-task="${esc(t.id)}" aria-label="移除任务 ${i + 1}" ${c.tasks.length <= minTasks ? 'disabled' : ''}>${icon('close')}</button></div><label>任务名称<input data-task-title maxlength="80" value="${esc(t.title)}" required></label><label>研究职责<textarea data-task-brief maxlength="2000" rows="3" required>${esc(t.brief)}</textarea></label>${researchChoiceFields('task:' + t.id, t.choice, t.title || '任务')}</div>`).join('')}</div></section>`
    : `<section class="research-workers"><div class="research-workers-heading"><div><h3>并行研究任务</h3><p>${esc(info.name)}档不并行研究任务，整轮由本档的模型环节直接收口。</p></div></div></section>`;
  const retrievalSection = `<section class="research-retrieval"><div class="research-workers-heading"><div><h3>资料检索</h3><p>从公开学术库检索真实题录，建立本轮资料库。检索本身不调用模型、不消耗预算。</p></div><label class="checkbox-label"><input id="retrieval-enabled" type="checkbox" ${retrieval.enabled !== false ? 'checked' : ''} ${info.retrievalRequired ? 'disabled' : ''}>启用${info.retrievalRequired ? '（本档必需）' : ''}</label></div><div class="source-grid">${sources.map(s => `<label class="checkbox-label source-item"><input type="checkbox" data-source="${esc(s.id)}" ${(retrieval.sources || []).includes(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')}</div><div class="research-budget-inline"><label>每源条数<input id="retrieval-per-source" type="number" min="3" max="25" value="${Number(retrieval.maxRecordsPerSource) || 10}"></label><label>最早年份<input id="retrieval-year-from" type="number" min="1900" max="${new Date().getFullYear()}" value="${retrieval.yearFrom || ''}" placeholder="不限"></label><label>最多检索式<input id="retrieval-max-queries" type="number" min="1" max="8" value="${Number(retrieval.maxQueries) || 4}"></label></div><p class="setting-help">检索结果只保存题录与摘要；这些记录同时决定答案允许引用的范围。</p></section>`;
  /* 自动实验：这是流程内的一个环节族，不是一个独立功能，所以设置放在这里、紧挨环节列表。 */
  const exp = c.experiments || {};
  const experimentSection = c.profile === 'p1-review'
    ? `<section class="research-experiments"><div class="research-workers-heading"><div><h3>自动实验</h3><p>研究任务会自己设计实验、生成实验程序、跑训练与评估，再按真实指标调参。训练与评估消耗执行预算，不占模型调用。</p></div><label class="checkbox-label"><input id="experiments-enabled" type="checkbox" ${exp.enabled === true ? 'checked' : ''}>启用</label></div>`
      + `<div class="research-budget-inline"><label>最多运行次数<input id="experiments-trials" type="number" min="1" max="12" value="${Number(exp.maxTrials) || 4}"></label><label>最多调参轮次<input id="experiments-rounds" type="number" min="1" max="4" value="${Number(exp.maxRounds) || 2}"></label></div>`
      + `<p class="setting-help">停下来的条件：${esc(exp.stopWhen || '指标不再提升或达到 trial 上限')}。执行前会先建隔离环境，结果写进可核对的运行记录。</p></section>`
    : '';
  /* 顺序按 §15.1：档位（目标）→ 计划预览 → 模型分工 → 资料范围 → 预算 → 高级（复核）。 */
  $('#research-architecture').innerHTML = `${stageRows}${tasks}<div class="architecture-arrow">${icon('down')}</div>${experimentSection}${retrievalSection}${auditRow}`;
  const plan = researchPlanCache;
  const base = plan?.baseCalls ?? 0;
  $('#research-budget').min = base || 1;
  $('#research-budget').max = meta.policy?.maxCallsCap || 24;
  $('#research-budget').value = Math.max(Number(c.budget?.maxCalls) || 0, base || 1);
  $('#research-refinement').checked = c.allowRefinement === true;
  $('#research-refinement').disabled = info.refinementAllowed !== true;
  $('#monitor-enabled').checked = c.monitor?.enabled !== false;
  $('#research-min-calls').textContent = String(base || '—');
}

function collectResearchForm() {
  const next = clone(researchDraft);
  const readChoice = key => {
    const select = document.querySelector(`[data-research-choice="${CSS.escape(key)}"]`);
    const effortSelect = document.querySelector(`[data-research-effort="${CSS.escape(key)}"]`);
    if (!select || !select.value) return null;
    const picked = JSON.parse(select.value);
    const effort = effortSelect?.value;
    const model = state.catalog[picked.provider]?.find(m => m.id === picked.model);
    return { ...picked, effort: model?.efforts.includes(effort) ? effort : model?.defaultEffort || model?.efforts?.[0] || 'default' };
  };
  const info = profileInfo(next.profile);
  /* 只收集本档活跃角色；实验关闭时把实验角色写回 null，避免残留误导。
     其他档/未启用的角色一律置空，免得切换档位后带着上一档的模型。 */
  const experimentOn = next.profile === 'p1-review' && $('#experiments-enabled')?.checked === true;
  for (const [key] of RESEARCH_STAGES) {
    const needed = (info.roles || []).includes(key) && (experimentOn || !EXPERIMENT_ROLES.includes(key));
    next.choices[key] = needed ? readChoice(key) || next.choices[key] || null : null;
  }
  next.choices.audit = readChoice('audit');
  next.experiments = next.profile === 'p1-review'
    ? {
      ...(next.experiments || {}),
      enabled: experimentOn,
      maxTrials: Number($('#experiments-trials')?.value) || Number(next.experiments?.maxTrials) || 4,
      maxRounds: Number($('#experiments-rounds')?.value) || Number(next.experiments?.maxRounds) || 2
    }
    : { ...(next.experiments || {}), enabled: false };
  if ((info.tasks?.[1] || 0) > 0) {
    for (const task of next.tasks) {
      const row = document.querySelector(`[data-research-task="${CSS.escape(task.id)}"]`);
      if (!row) continue;
      task.title = row.querySelector('[data-task-title]').value;
      task.brief = row.querySelector('[data-task-brief]').value;
      task.choice = readChoice('task:' + task.id) || task.choice;
    }
  } else {
    next.tasks = [];
    next.allowRefinement = false;
  }
  next.retrieval = {
    ...next.retrieval,
    enabled: info.retrievalRequired ? true : $('#retrieval-enabled').checked,
    sources: [...document.querySelectorAll('[data-source]')].filter(i => i.checked).map(i => i.dataset.source),
    maxRecordsPerSource: Number($('#retrieval-per-source').value),
    perSource: Number($('#retrieval-per-source').value),
    yearFrom: $('#retrieval-year-from').value ? Number($('#retrieval-year-from').value) : null,
    maxQueries: Number($('#retrieval-max-queries').value)
  };
  next.budget = { ...next.budget, maxCalls: Number($('#research-budget').value) };
  next.allowRefinement = info.refinementAllowed === true ? $('#research-refinement').checked : false;
  next.monitor = { enabled: $('#monitor-enabled').checked };
  return next;
}
async function openResearchDialog() {
  if (state.busy.has(state.active?.id)) return;
  closePopover();
  if (!state.researchProfiles) { try { state.researchProfiles = await window.duet.profiles(); } catch (e) { fail(e); return; } }
  researchDraft = currentResearch();
  $('#research-error').textContent = '';
  researchPlanCache = null;
  renderResearchForm();
  $('#research-dialog').showModal();
  await refreshPlanPreview();
  renderResearchForm();
}

document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.runMode) { await changeRunMode(b.dataset.runMode); return; }
    if (b.hasAttribute('data-open-models')) { openModelPicker(); return; }
    if (b.hasAttribute('data-open-research') || b.id === 'research-config-button') { openResearchDialog(); return; }
    if (b.dataset.pickerModel) { await toggleModel(b.dataset.pickerModel); renderModelPicker(); return; }
    if (b.id === 'manage-connections') { $('#models-dialog').close(); openSettings(); return; }
    if (b.id === 'add-connection') { openConnection(); return; }
    if (b.dataset.editConnection) { openConnection(b.dataset.editConnection); return; }
    if (b.dataset.removeConnection) { applyConnectionResult(await window.duet.removeConnection(b.dataset.removeConnection)); toast('连接已移除，历史记录保留'); return; }
    if (b.dataset.testConnection) { const text = b.textContent; b.disabled = true; b.textContent = '测试中…'; try { await window.duet.testConnection(b.dataset.testConnection); toast('连接测试成功'); } finally { b.disabled = false; b.textContent = text; } return; }
    if (b.id === 'connection-fetch-models') {
      const hint = $('#connection-model-hint');
      const original = b.textContent;
      b.disabled = true; b.textContent = '拉取中…';
      try {
        const { models } = await window.duet.modelList({ id: $('#connection-id').value || undefined, baseUrl: $('#connection-url').value, protocol: $('#connection-protocol').value, apiKey: $('#connection-key').value, allowNoKey: $('#connection-no-key').checked });
        $('#connection-model-options').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
        hint.textContent = models.length ? `已获取 ${models.length} 个模型，点输入框可直接选择。` : '服务端没有返回模型列表，请手填模型 ID。';
        if (models.length && !$('#connection-model').value) $('#connection-model').value = models[0];
      } catch (e) { hint.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
      finally { b.disabled = false; b.textContent = original; }
      return;
    }
    if (b.dataset.researchProfile) {
      if (b.disabled) return;
      researchDraft = collectResearchForm();
      researchDraft.profile = b.dataset.researchProfile;
      // 换档位时补齐该档需要而当前缺失的角色模型：用本档第一个可用模型兜底，用户可再改。
      const info = profileInfo(researchDraft.profile);
      const fallback = researchDraft.choices.scope || researchDraft.choices.evidence || null;
      for (const role of info.roles || []) if (!researchDraft.choices[role]) researchDraft.choices[role] = clone(fallback);
      if (!researchDraft.tasks.length && (info.tasks?.[1] || 0) > 0) {
        researchDraft.tasks = [
          { id: 'concepts', title: '概念与分类', brief: '按可比条件梳理概念、方法与证据类型，指出适用范围。', choice: clone(fallback) },
          { id: 'limits', title: '反例与局限', brief: '检查外推边界、相反证据与方法局限。', choice: clone(fallback) }
        ];
      }
      if ((info.tasks?.[1] || 0) === 0) { researchDraft.tasks = []; researchDraft.allowRefinement = false; }
      /* 预算按新档重算：先放到硬上限让编译器算出基准，再收回到「基准 + 一次可选深化」。 */
      researchDraft.budget = { ...researchDraft.budget, maxCalls: researchMeta().policy?.maxCallsCap || 24 };
      const plan = await refreshPlanPreview();
      const base = plan?.baseCalls;
      if (Number.isInteger(base) && base > 0) {
        researchDraft.budget = { ...researchDraft.budget, maxCalls: base + (info.refinementAllowed ? 1 : 0) };
        await refreshPlanPreview();
      }
      renderResearchForm();
      return;
    }
    if (b.hasAttribute('data-add-research-task')) {
      researchDraft = collectResearchForm();
      const [, maxTasks] = profileInfo(researchDraft.profile).tasks || [0, 0];
      if (researchDraft.tasks.length >= maxTasks) return;
      researchDraft.tasks.push({ id: 'task-' + crypto.randomUUID().slice(0, 8), title: '证据与实验设计', brief: '检查关键证据缺口，提出可证伪的实验与停止条件。引用只能来自资料库。', choice: clone(researchDraft.tasks[0]?.choice || researchDraft.choices.scope) });
      await refreshPlanPreview();
      renderResearchForm(); return;
    }
    if (b.dataset.removeResearchTask) {
      researchDraft = collectResearchForm();
      const [minTasks] = profileInfo(researchDraft.profile).tasks || [0, 0];
      if (researchDraft.tasks.length <= minTasks) return;
      researchDraft.tasks = researchDraft.tasks.filter(t => t.id !== b.dataset.removeResearchTask);
      await refreshPlanPreview();
      renderResearchForm();
    }
  } catch (e) { fail(e); }
});

document.addEventListener('DOMContentLoaded', () => {
  $('#connection-preset').addEventListener('change', () => applyPreset($('#connection-preset').value));
  $('#connection-protocol').addEventListener('change', () => {
    protocolFields();
    const claude = $('#connection-protocol').value === 'anthropic';
    if (claude && !$('#connection-model').value) $('#connection-model').value = 'claude-sonnet-4-5';
  });
  $('#connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.submitter || $('#connection-form [type=submit]');
    submit.disabled = true;
    try { applyConnectionResult(await window.duet.saveConnection(readConnection())); $('#connection-key').value = ''; $('#connection-dialog').close(); toast('模型连接已保存'); }
    catch (e) { $('#connection-error').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
    finally { submit.disabled = false; }
  });
  $('#research-form').addEventListener('change', async event => {
    const choiceChanged = event.target.hasAttribute('data-research-choice');
    /* 计划预览是纯计算，不发请求也不花钱，任何改动后都重算一遍最省心。 */
    researchDraft = collectResearchForm();
    const key = choiceChanged ? event.target.dataset.researchChoice : null;
    await refreshPlanPreview();
    renderResearchForm();
    if (key) { const again = document.querySelector(`[data-research-choice="${CSS.escape(key)}"]`); if (again) again.focus(); }
  });
  $('#research-form').addEventListener('submit', async event => {
    event.preventDefault();
    const next = collectResearchForm();
    try {
      let saved = next;
      if (state.active) {
        const id = state.active.id, updated = await window.duet.runConfig(id, runMode(), next);
        if (state.active?.id === id) { state.active.researchConfig = updated.researchConfig; state.active.mode = updated.mode; }
        saved = updated.researchConfig || next;
      }
      state.researchConfig = saved;
      $('#research-dialog').close(); renderModels(); toast('科研配置已保存');
    } catch (e) { $('#research-error').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  });
});
