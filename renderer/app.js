const $ = selector => document.querySelector(selector);
const icon = name => window.DUET_ICONS[name] || window.DUET_ICONS.folder;
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const markdownParser = new window.marked.Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => esc(text) } });
function markdown(text) {
  const template = document.createElement('template');
  template.innerHTML = window.DOMPurify.sanitize(markdownParser.parse(String(text || '')), { ALLOWED_TAGS: ['p','br','strong','em','del','code','pre','blockquote','h1','h2','h3','h4','h5','h6','a','table','thead','tbody','tr','th','td','ul','ol','li','hr'], ALLOWED_ATTR: ['href','title','class','start','align'] });
  template.content.querySelectorAll('a').forEach(a => { if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) a.removeAttribute('href'); else { a.rel = 'noopener noreferrer'; a.title = a.getAttribute('href'); } });
  template.content.querySelectorAll('h1').forEach(h => { const replacement = document.createElement('h2'); replacement.innerHTML = h.innerHTML; h.replaceWith(replacement); });
  template.content.querySelectorAll('table').forEach(table => { const wrap = document.createElement('div'); wrap.className = 'markdown-table'; wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '表格，可横向滚动'); table.before(wrap); wrap.append(table); table.querySelectorAll('th').forEach(h => h.scope = 'col'); });
  template.content.querySelectorAll('pre').forEach(pre => { const wrap = document.createElement('div'); wrap.className = 'code-block'; const language = pre.querySelector('code')?.className.replace('language-', '') || '代码'; wrap.innerHTML = `<div class="code-toolbar"><span>${esc(language)}</span><button data-copy-code aria-label="复制代码">${icon('copy')}复制</button></div>`; pre.before(wrap); wrap.append(pre); });
  return template.innerHTML;
}
/* 平台标记：mac 上隐藏自绘窗口按钮（有系统红绿灯）、快捷键改用 Cmd。
   在脚本最早处打上，避免首屏闪一下再切换。 */
const platformInfo = window.duet?.platform || 'win32';
document.documentElement.dataset.platform = platformInfo;

const state = { local: [], history: [], workspaces: [], assignments: {}, settings: {}, catalog: { gpt: [], deepseek: [], labels: {} }, active: null, view: 'chat', models: ['deepseek', 'gpt'], config: null, selectedWorkspace: 'all', expanded: new Set(), expandedChats: new Set(), filter: 'all', query: '', sidebarQuery: '', searchHits: new Map(), historyErrors: [], historyLoading: true, busy: new Set(), drafts: new Map(), navigation: 0, popover: null, chatTab: 'answer', openProcesses: new Set(), pendingEvents: [], configQueue: Promise.resolve(), mode: 'standard', researchConfig: null };
/* 侧边栏每个工作区默认只铺前几个对话：64 个对话全展开会把侧栏撑成一整屏，
   真正要找的那条反而更难扫到。多出来的折成一行「还有 N 个」。 */
const SIDEBAR_CHAT_LIMIT = 6;
const providerName = p => state.catalog.providerNames?.[p] || (p === 'deepseek' ? 'DeepSeek' : p === 'gpt' ? 'GPT · Codex' : p || 'Iris Unite');
const sourceLabel = s => s === 'codex' ? 'Codex' : s === 'dsh' ? 'DSH Desktop' : 'Iris Unite';
const isHistory = (c = state.active) => c && c.source !== 'local';
const allConversations = () => [...state.local, ...state.history].sort((a, b) => b.updatedAt - a.updatedAt);
const workspaceOf = c => c.workspaceId || state.assignments[c.id] || 'unassigned';
const selectedWorkspace = () => state.workspaces.find(w => w.id === state.selectedWorkspace);
const activeWorkspace = () => state.active ? state.workspaces.find(w => w.id === workspaceOf(state.active)) : selectedWorkspace();
const effortLabel = e => state.catalog.labels[e]?.[0] || e;
const config = () => clone({ ...state.settings.defaultModelConfig, ...(state.active?.modelConfig || state.config || {}) });
const modelName = (provider, id) => state.catalog[provider]?.find(m => m.id === id)?.name || id || providerName(provider);
function toast(text, duration = 2500) {
  clearTimeout(toast.timer); clearTimeout(toast.hideTimer);
  const el = $('#toast'); el.textContent = text; el.classList.remove('hidden', 'fading');
  requestAnimationFrame(() => el.classList.add('visible'));
  toast.timer = setTimeout(() => { el.classList.remove('visible'); el.classList.add('fading'); toast.hideTimer = setTimeout(() => el.classList.add('hidden'), 300); }, duration);
}
const fail = error => toast(String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''), 5000);
/* 一键导出：默认直接落到下载目录，不弹对话框；按住 Shift 点击才另存为。
   导出成功后把那颗按钮就地变成「打开所在文件夹」，不重渲染整个对话——
   重渲染会把用户正在看的滚动位置顶掉。 */
async function exportResult(messageId, saveAs = false) {
  if (!state.active) return false;
  const result = await window.duet.exportResult({ id: state.active.id, messageId, mode: saveAs ? 'save' : 'quick' });
  if (!result?.ok) {
    if (result?.canceled) return false;
    if (result?.reason === 'external') { toast('外部客户端的历史会话没有本地协作记录，无法导出研究结果', 4000); return false; }
    if (result?.reason === 'empty') { toast('这一轮还没有可导出的内容', 3000); return false; }
    toast('导出失败', 3000); return false;
  }
  state.lastExport = { id: messageId || null, filePath: result.filePath, name: result.name };
  toast(`已导出 ${result.name}（${Math.max(1, Math.round(result.bytes / 1024))} KB）`, 6000);
  const target = messageId
    ? document.querySelector(`button[data-export-result="${CSS.escape(messageId)}"]`)
    : document.querySelector('button[data-export-result]');
  if (target) {
    delete target.dataset.exportResult;
    target.dataset.reveal = result.filePath;
    target.title = result.filePath;
    target.textContent = '打开所在文件夹';
  }
  return true;
}
/* 接着跑实验：沿用这一轮的界定/证据/资料库，只执行实验与整合。
   必须先明确「执行哪一个方案」——答案里常常列了好几个候选方向，
   程序自己挑一个等于替用户做了实验设计决定。 */
let experimentTarget = null;
/** 从答案里挑出实验建议段落下的编号条目：只用于预填，用户仍要确认或改。 */
function experimentOptionsFrom(text) {
  const lines = String(text || '').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^#{1,6}\s/.test(lines[i]) && /实验/.test(lines[i])) { start = i; break; }
  const slice = start >= 0 ? lines.slice(start + 1) : lines;
  const options = [];
  for (const line of slice) {
    if (start < 0 && options.length && /^#{1,6}\s/.test(line)) break;
    const match = /^\s*(?:[-*]\s*)?(\d{1,2})[.、)]\s*(.{6,300})$/.exec(line);
    if (match) options.push({ index: Number(match[1]), text: match[2].trim() });
    if (options.length >= 8) break;
  }
  return options;
}
function openExperimentChoice(messageId) {
  const message = state.active?.messages.find(item => item.id === messageId);
  if (!message) return;
  if (state.busy.has(state.active.id)) { toast('当前对话正在生成回答'); return; }
  const options = experimentOptionsFrom(message.text);
  experimentTarget = { messageId, options };
  $('#experiment-choice-options').innerHTML = options.length
    ? options.map(option => `<button type="button" class="experiment-option" data-plan-index="${option.index}"><span class="experiment-option-index">${option.index}</span><span>${esc(option.text)}</span></button>`).join('')
    : '<p class="dialog-hint">这一轮的答案里没有编号方案，请直接写下要执行的那一个。</p>';
  $('#experiment-choice-text').value = options.length === 1 ? options[0].text : '';
  $('#experiment-choice-status').textContent = '';
  $('#experiment-choice-dialog').showModal();
  $('#experiment-choice-text').focus();
}
async function runExperiment(messageId, plan) {
  const c = state.active;
  if (!c) return;
  if (state.busy.has(c.id)) { toast('当前对话正在生成回答'); return; }
  const text = String(plan?.text || '').trim();
  if (text.length < 2) { toast('请明确说明执行哪一个方案'); return; }
  state.busy.add(c.id); renderSend(); renderModels();
  try {
    const next = await window.duet.runExperiment(c.id, messageId, { text, index: plan?.index ?? null, title: plan?.title || null });
    if (state.active?.id === c.id) {
      state.active = next; state.chatTab = 'answer'; renderChat();
      const pending = state.pendingEvents.splice(0); pending.forEach(handleEvent);
      $('#content').scrollTop = $('#content').scrollHeight;
    }
    await refreshLocal();
  } catch (error) {
    state.busy.delete(c.id); renderSend(); renderModels(); fail(error);
  }
}
function formatTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }); }
function formatDate(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }); }
function applyCatalog(data) {
  state.workspaces = data.workspaces; state.assignments = data.assignments;
  if (state.selectedWorkspace !== 'all' && !state.workspaces.some(w => w.id === state.selectedWorkspace)) state.selectedWorkspace = 'all';
}
function threadItem(c) {
  return `<button class="conversation-item ${state.active?.id === c.id ? 'selected' : ''}" data-thread="${esc(c.id)}" ${state.active?.id === c.id ? 'aria-current="page"' : ''} title="${esc(c.title)} · ${sourceLabel(c.source)}"><span class="thread-title">${esc(c.title)}</span><span class="thread-source">${c.source === 'dsh' ? 'DSH' : sourceLabel(c.source)}</span></button>`;
}
/** 展开时先铺前几个，剩下的折起来；搜索命中时不折叠（正在找的东西不能被藏）。 */
function sidebarChats(workspace, children, q) {
  const expanded = q || state.expandedChats.has(workspace.id);
  const shown = expanded ? children : children.slice(0, SIDEBAR_CHAT_LIMIT);
  const rest = children.length - shown.length;
  const more = rest > 0 ? `<button class="group-more" data-more="${esc(workspace.id)}">还有 ${rest} 个对话${icon('down')}</button>` : '';
  return shown.map(threadItem).join('') + more;
}
function renderSidebar() {
  const all = allConversations(), q = state.sidebarQuery.toLowerCase();
  $('#workspace-select').innerHTML = `<option value="all">所有工作区</option>${state.workspaces.map(w => `<option value="${esc(w.id)}">${esc(w.name)} (${w.conversationCount})</option>`).join('')}`;
  $('#workspace-select').value = state.selectedWorkspace;
  $('#workspace-count').textContent = state.workspaces.filter(w => w.id !== 'unassigned').length;
  $('#history-count').textContent = state.historyLoading ? '…' : all.length;
  $('#nav-workspaces').classList.toggle('active', state.view === 'workspaces');
  $('#nav-history').classList.toggle('active', state.view === 'history' && state.selectedWorkspace === 'all');
  $('#deepseek-status').classList.toggle('ready', state.settings.hasKey); $('#codex-status').classList.toggle('ready', state.settings.codexAvailable);
  $('#deepseek-status').title = state.settings.hasKey ? '已找到 DeepSeek 密钥' : '尚未配置 DeepSeek 密钥'; $('#codex-status').title = state.settings.codexAvailable ? '已找到 Codex CLI' : '未找到 Codex CLI';
  $('#workspace-tree').innerHTML = state.workspaces.map(w => {
    const nameMatch = w.name.toLowerCase().includes(q);
    // 搜索不只看标题：正文命中由主进程扫描后放进 state.searchHits。
    const children = all.filter(c => workspaceOf(c) === w.id && (!q || nameMatch || c.title.toLowerCase().includes(q) || state.searchHits.has(c.id)));
    if (q && !nameMatch && !children.length) return '';
    const expanded = q || state.expanded.has(w.id);
    return `<div class="workspace-group ${expanded ? 'expanded' : ''}" data-workspace-group="${esc(w.id)}"><div class="group-heading ${state.selectedWorkspace === w.id ? 'selected' : ''}"><button class="group-toggle" data-expand="${esc(w.id)}" aria-label="展开或折叠 ${esc(w.name)}" aria-expanded="${!!expanded}">${icon('chevron')}</button><button class="group-name" data-workspace="${esc(w.id)}" title="${esc(w.path || w.name)}">${icon('folder')}<span>${esc(w.name)}</span><span class="count">${children.length}</span></button></div>${expanded ? `<div class="group-chats">${children.length ? sidebarChats(w, children, q) : `<div class="side-empty">${state.historyLoading ? '读取中…' : '暂无对话'}</div>`}</div>` : ''}</div>`;
  }).join('') || `<div class="side-empty">${q ? '没有匹配的工作区、对话或正文' : '暂无工作区'}</div>`;
}
function draftKey() { return state.active?.id || 'new:' + state.selectedWorkspace; }
function saveDraft() { state.drafts.set(draftKey(), $('#prompt').value); }
function restoreDraft() { $('#prompt').value = state.drafts.get(draftKey()) || ''; }
function renderModels() {
  const selected = state.active?.models || state.models, choices = config();
  const busy = state.busy.has(state.active?.id);
  const researching = runMode() === 'research';
  $('#model-controls').innerHTML = researching ? researchModelChips(busy) : [...new Set(['deepseek','gpt', ...selected])].map(provider => { const choice = choices[provider]; if (!choice) return ''; return `<div class="model-control ${selected.includes(provider) ? 'enabled' : ''}"><button class="model-chip ${selected.includes(provider) ? 'selected' : ''}" data-model="${provider}" aria-pressed="${selected.includes(provider)}" title="${selected.includes(provider) ? '停用' : '启用'} ${esc(modelName(provider, choice.model))}" ${busy ? 'disabled' : ''}><span class="model-tick">${icon('check')}</span><span class="concrete-model-name">${esc(modelName(provider, choice.model))}</span></button><button class="model-options" data-model-options="${provider}" aria-label="调整 ${esc(modelName(provider, choice.model))} 强度：${esc(effortLabel(choice.effort))}" title="模型与强度" aria-expanded="${state.popover === provider}" ${busy ? 'disabled' : ''}><span>${esc(effortLabel(choice.effort))}</span>${icon('down')}</button></div>`; }).join('') + `<button id="select-models" class="add-model-button" data-open-models aria-label="选择参与模型" title="选择参与模型" ${busy ? 'disabled' : ''}>${icon('plus')}</button>`;
  $('#prompt').placeholder = researching ? '描述研究问题、已知证据与约束，交给科研模式分析…' : selected.length > 1 ? '输入问题，交给所选模型一起解答…' : `向 ${modelName(selected[0], choices[selected[0]]?.model)} 提问…`;
  $('#composer-context').textContent = researching ? '科研推演 · 公开过程按需展开' : selected.length > 1 ? `共享上下文 · ${selected.length} 模型协作` : '共享历史 · 单模型回答';
  $('#mode-badge').textContent = isHistory() ? '历史记录' : researching ? '科研模式' : selected.length > 1 ? '协作模式' : '标准模式';
  renderModeControls();
  if (!state.active && state.view === 'chat' && state.chatTab === 'answer') $('#content').innerHTML = welcome();
}
function closePopover(restoreFocus = false) { const provider = state.popover; state.popover = null; $('#model-popover').classList.add('hidden'); document.querySelectorAll('[data-model-options]').forEach(el => el.setAttribute('aria-expanded', 'false')); if (restoreFocus && provider) document.querySelector(`[data-model-options="${provider}"]`)?.focus(); }
function renderPopover(provider) {
  if (!state.catalog[provider]?.length) { toast('此连接已停用，请在设置中启用或更换模型'); return; }
  const current = config()[provider];
  const catalog = state.catalog[provider];
  const known = catalog.find(m => m.id === current.model);
  const entries = known ? catalog : [{ id: current.model, name: current.model || 'Codex 默认模型', efforts: provider === 'gpt' ? ['low', 'medium', 'high', 'xhigh'] : ['off', 'low', 'high', 'max'] }, ...catalog];
  const model = entries.find(m => m.id === current.model) || entries[0];
  $('#model-popover').innerHTML = `<div class="popover-heading"><span>模型与强度<small>${esc(providerName(provider))}</small></span><button class="icon-button" data-close-popover aria-label="关闭模型强度">${icon('close')}</button></div><label class="model-select-label">当前模型<select id="provider-model-select" aria-label="选择 ${providerName(provider)} 模型">${entries.map(m => `<option value="${esc(m.id)}" ${m.id === current.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label><div class="power-selection"><span>Power <small>推理强度</small></span><strong id="power-value">${esc(effortLabel(current.effort))}</strong></div><div class="power-track"><input id="power-slider" type="range" min="0" max="${Math.max(1, model.efforts.length - 1)}" step="1" value="${Math.max(0, model.efforts.indexOf(current.effort))}" ${model.efforts.length === 1 ? 'disabled' : ''} aria-label="${esc(model.name)} 推理强度" aria-valuetext="${esc(effortLabel(current.effort))}" data-efforts="${esc(JSON.stringify(model.efforts))}"><div class="power-ticks" aria-hidden="true">${model.efforts.map(e => `<span title="${esc(effortLabel(e))}"></span>`).join('')}</div></div><div class="power-ends"><span>更快 <small>Faster</small></span><span>更深入 <small>Smarter</small></span></div><div class="power-presets">${model.efforts.map(e => `<button data-effort="${esc(e)}" aria-pressed="${current.effort === e}" class="${current.effort === e ? 'selected' : ''}">${esc(effortLabel(e))}</button>`).join('')}</div><p id="power-description">${esc(state.catalog.labels[current.effort]?.[1] || '')}</p><details class="advanced-model"><summary>高级设置${icon('down')}</summary><label>精确档位<select id="provider-effort-select" aria-label="精确选择推理强度">${model.efforts.map(e => `<option value="${esc(e)}" ${e === current.effort ? 'selected' : ''}>${esc(effortLabel(e))} · ${esc(e)}</option>`).join('')}</select></label></details><p class="popover-note">更高强度通常需要更多时间与额度。仅应用于后续消息。</p>`;
  state.popover = provider; $('#model-popover').classList.remove('hidden'); renderModels();
  previewPower($('#power-slider')); $('#power-slider').focus({ preventScroll: true });
}
function previewPower(slider) {
  const efforts = JSON.parse(slider.dataset.efforts), effort = efforts[Math.min(efforts.length - 1, Number(slider.value))];
  slider.style.setProperty('--power-percent', `${Number(slider.value) / Math.max(1, Number(slider.max)) * 100}%`);
  slider.setAttribute('aria-valuetext', effortLabel(effort)); $('#power-value').textContent = effortLabel(effort);
  $('#power-description').textContent = state.catalog.labels[effort]?.[1] || '';
  $('#provider-effort-select').value = effort;
  document.querySelectorAll('.power-presets [data-effort]').forEach(b => { const selected = b.dataset.effort === effort; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); });
}
async function updateConfig(provider, changes) {
  const next = config(); next[provider] = { ...next[provider], ...changes };
  const id = state.active?.id;
  if (id) state.active.modelConfig = next; else state.config = next;
  renderModels();
  if (id) {
    const pending = state.configQueue.then(() => window.duet.modelConfig(id, next));
    state.configQueue = pending.catch(() => {});
    try { await pending; } catch (error) { if (state.active?.id === id) state.active.modelConfig = (await window.duet.get(id)).modelConfig; renderModels(); throw error; }
  }
}
function renderSend() {
  const busy = state.busy.has(state.active?.id);
  $('#send-button').classList.toggle('stop', busy); $('#send-button').innerHTML = icon(busy ? 'stop' : 'arrow-up'); $('#send-button').setAttribute('aria-label', busy ? '停止生成' : '发送消息'); $('#send-button').disabled = !busy && !$('#prompt').value.trim(); $('#prompt').disabled = busy;
}
function welcome() {
  const w = selectedWorkspace();
  const selected = state.models, researching = runMode() === 'research';
  const prompts = [['plan','拆解一个计划','从目标到可执行的下一步','帮我把一个新想法拆解成可执行的步骤。'],['code','审查一段代码','找出问题，给出具体修正','我想审查一段代码。请先告诉我需要提供哪些背景，再检查正确性和边界情况。'],['compare','比较两种方案','理清差异与取舍','帮我比较两种方案。请先确认我的目标、约束和候选方案。'],['chat','解释一个概念','用清楚的例子建立理解','请用一个简单的例子解释异步编程。']];
  return `<div class="welcome-container"><section class="welcome"><div class="welcome-mark" aria-hidden="true">${irisMark()}</div><h1>${researching ? '让研究问题，经得起推敲。' : '今天想解决什么问题？'}</h1><p>${researching ? '由 GPT 统筹，研究模型并行探索，再经过反证审查形成建议。' : selected.length > 1 ? '多个模型交换观点、互相审查，为你形成一份完整答案。' : `由 ${esc(providerName(selected[0]))} 为你解答，随时可以启用多模型协作。`}</p><div class="welcome-workspace" title="${esc(w?.path || '')}">${icon('folder')}<span>${esc(w && w.id !== 'unassigned' ? w.name : '选择工作区，或直接开始')}</span>${w && w.id !== 'unassigned' ? '' : `<button data-action="workspaces">选择工作区${icon('chevron')}</button>`}</div>${researching ? researchWelcome() : `<div class="quick-prompts">${prompts.map(([glyph,title,description,prompt]) => `<button data-prompt="${esc(prompt)}"><span class="prompt-icon">${icon(glyph)}</span><span><strong>${title}</strong><small>${description}</small></span><span class="prompt-arrow">${icon('arrow-right')}</span></button>`).join('')}</div>`}</section></div>`;
}
function replyContent(m) {
  if (m.text) return markdown(m.text);
  if (m.status === 'streaming') {
    // 科研模式的正文在核验前不进正文区，只显示进度（§14.6）
    if (m.collaboration?.mode === 'research') return `<span class="thinking"><i></i><i></i><i></i>${m.draftChars ? `已生成 ${m.draftChars} 字，核验通过后发布` : '正在研究，完成后统一核验再发布'}</span>`;
    return `<span class="thinking"><i></i><i></i><i></i>${m.collaboration?.mode === 'collaborative' ? '正在协作，完成后展示完整答案' : '正在生成答案'}</span>`;
  }
  return m.status === 'stopped' ? '<span class="thinking">已停止</span>' : '';
}
function elapsed(run) { const seconds = Math.max(0, Math.floor(((run.finishedAt || Date.now()) - run.startedAt) / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
/* 阶段产出可能是 JSON（研究界定、问题分解等），直接摊原文对用户没意义：
   这里优先取结论性字段，取不到再退回原文截断。 */
function previewOf(text, max = 160) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let obj = null;
  try { obj = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* 不是 JSON */ }
  if (obj && typeof obj === 'object') {
    for (const key of ['objective', 'conclusion', 'reason', 'selectionCriteria', 'comparison', 'claim', 'summary', 'why']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, max);
    }
    for (const key of ['questions', 'queries', 'selectedIds', 'claims', 'tasks']) {
      if (Array.isArray(obj[key]) && obj[key].length) {
        const first = obj[key][0];
        const label = typeof first === 'string' ? first : (first?.claim || first?.assignment || first?.id || '');
        return `${obj[key].length} 项${label ? '：' + String(label).slice(0, max - 6) : ''}`;
      }
    }
    return Object.keys(obj).slice(0, 4).join('、');
  }
  return raw.replace(/\s+/g, ' ').slice(0, max);
}
function processTimeline(run) {
  const participants = run.participants.map(p => `${modelName(p.provider, p.model)} · ${effortLabel(p.effort)}`).join(' + ');
  return `<div class="process-note">${esc(participants)}<br>这里展示模型公开生成的大纲、评审与提案，不包含内部思维链。${run.mode === 'research' ? `<br>实际调用 ${run.callsUsed} / ${run.callBudget} 次。${esc(run.selection?.budgetNote || '')}` : ''}</div>${researchSummary(run)}<ol class="process-timeline">${run.artifacts.map(a => `<li class="process-artifact ${a.status}" data-artifact="${esc(a.id)}"><div class="artifact-heading"><span class="artifact-dot"></span><strong>${esc(a.stageLabel)}${a.taskLabel ? ` / ${esc(a.taskLabel)}` : ''}</strong><span>${esc(a.model ? modelName(a.provider, a.model) + ' · ' + effortLabel(a.effort) : providerName(a.provider))}${a.recipient ? ` → ${esc(a.recipient.split(',').map(providerName).join('、'))}` : ''}</span><small>${a.status === 'running' ? '进行中' : a.status === 'done' ? '完成' : a.status === 'error' ? '失败' : '已停止'}</small></div><div class="artifact-body">${a.stage === 'coordination' && run.plan && a.status === 'done' ? `${markdown(run.plan.outline)}<p><strong>写作分配：</strong>${esc(modelName(run.writer, run.participants.find(p => p.provider === run.writer)?.model))}</p><p>${esc(run.plan.reason)}</p><p><strong>写作要求：</strong>${esc(run.plan.instructions)}</p>` : researchArtifact(a, run) || markdown(a.text) || '<span class="muted">等待模型返回…</span>'}${a.error ? `<p class="error-text">${esc(a.error)}</p>` : ''}</div></li>`).join('')}</ol>`;
}
function processDetails(m) {
  const run = m.collaboration; if (!run) return '';
  return `<details class="process-details" data-process="${esc(m.id)}" ${state.openProcesses.has(m.id) ? 'open' : ''}><summary>${icon('chevron')}<span>各阶段产出</span><span class="process-summary">${esc(run.stageLabel)} · ${run.artifacts.length} 项记录 · 点开查看</span><span class="process-elapsed" data-elapsed="${esc(m.id)}">${elapsed(run)}</span></summary><div class="process-expanded">${state.openProcesses.has(m.id) ? processTimeline(run) : ''}</div></details>`;
}
function replyCard(m) {
  const integrity = m.integrity;
  // 只有本地产生的、已经结束的一轮才能重跑：历史副本和正在生成的不行。
  const retryable = !!m.collaboration && !m.imported && m.status !== 'streaming';
  /* 三种状态必须分开说：核验通过、核验后移除了引用、根本没核验。
     以前「没核验」会落进「已移除 0 处」那条，等于说了一句不成立的话。 */
  const badge = !integrity ? ''
    : integrity.ran === false
      ? `<span class="integrity-badge warn" title="${esc(integrity.note || '本轮未执行引用核验')}">引用未核验</span>`
      : integrity.ok
        ? `<span class="integrity-badge ok" title="答案里的引用都能指回本轮检索到的资料库记录">${icon('check')}引用已核验 ${integrity.stats?.resolvedCount ?? 0}/${integrity.stats?.totalCitations ?? 0}</span>`
        : `<span class="integrity-badge warn" title="${esc((integrity.unresolved || []).map(u => u.raw + ' ' + u.reason).slice(0, 6).join('；'))}">${icon('close')}已移除 ${integrity.removed?.length || 0} 处无法核验的引用</span>`;
  /* 实验数字：只有真正绑定到已完成运行的数值才算核对通过。 */
  const experiments = m.experiments;
  const expBadge = experiments?.ran
    ? experiments.ok
      ? `<span class="integrity-badge ok" title="实验数字都能指回本对话已完成的运行记录">${icon('check')}实验数字已核对 ${experiments.numbers?.bound?.length ?? 0} 项</span>`
      : `<span class="integrity-badge warn" title="${esc(experiments.note || '')}">〔未核对〕实验数字 ${(experiments.numbers?.unsourced || []).length} 处</span>`
    : '';
  const usage = m.usage?.reported ? `<span class="reply-usage" title="token 由通道真实返回；金额按你在设置里填的单价估算，以官方账单为准">${esc(usageLabel(m.usage))}</span>` : '';
  const stages = m.collaboration?.mode === 'research' ? (m.collaboration.knowledge ? `<span>资料库 ${m.collaboration.knowledge.total} 条</span>` : '') : '';
  /* 导出按钮只挂在有正文的消息上：空答案是导不出东西的，给了按钮也是骗人。 */
  const exportButton = String(m.text || '').trim()
    ? `<button data-export-result="${esc(m.id)}" title="一键导出这一轮的全部结果到下载目录（按住 Shift 另存为）">导出结果</button>`
    : '';
  /* 这一轮给了实验建议却没跑实验时，给一个「就按这个跑」的入口：
     接着跑只花实验与整合，不重跑界定/检索/证据，也不会把原来的结论换掉。
     只挂在最近一条科研轮次上：更早的轮次已经被后来的结果覆盖，再点一次等于重复花钱。 */
  const latestResearchId = [...(state.active?.messages || [])].reverse().find(item => item.collaboration?.mode === 'research')?.id;
  const canRunExperiment = m.collaboration?.mode === 'research' && m.collaboration.status === 'done'
    && m.id === latestResearchId
    && !(m.collaboration.experimentRuns || []).length && String(m.text || '').trim().length > 0;
  const experimentButton = canRunExperiment
    ? `<button data-run-experiment="${esc(m.id)}" title="沿用这一轮的研究界定、证据与资料库，直接执行实验（不重跑前面环节）">执行实验</button>`
    : '';
  return `<article class="reply-card" data-reply="${esc(m.id)}"><div class="reply-header"><span class="answer-mark">${m.kind === 'answer' ? irisMark() : esc(providerName(m.provider).slice(0,1))}</span><strong>${m.kind === 'answer' ? 'Iris Unite' : providerName(m.provider)}</strong><span class="reply-model" title="${esc(m.model || '')}">${m.provider ? esc(modelName(m.provider, m.model)) : '多模型协作'}</span><span class="reply-effort">${esc(m.effort ? effortLabel(m.effort) : '')}</span><span class="reply-status">${m.status === 'streaming' ? esc(m.collaboration?.stageLabel || '生成中') : m.status === 'error' ? '调用失败' : m.status === 'stopped' ? '已停止' : '已完成'}</span></div>${processDetails(m)}<div class="reply-body">${replyContent(m)}${integrity && !integrity.ok ? `<div class="integrity-note">${esc(integrity.note || (integrity.retrievalEnabled === false ? '本轮未启用资料检索，引用无法核验。' : '本轮未能执行引用核验。'))}</div>` : ''}${m.error ? `<div class="error-text">${esc(m.error)}</div>` : ''}${retryable && (m.status === 'error' || m.status === 'stopped') ? `<div class="reply-recover"><span>${m.status === 'stopped' ? '本轮已停止，没有产出答案。' : '本轮没有跑完。'}</span><button type="button" class="secondary-button" data-retry="${esc(m.id)}">${icon('refresh')}重新生成</button><span class="reply-recover-hint">用同样的配置重跑一轮，预算重新计算</span></div>` : ''}</div><div class="reply-footer"><span>${m.imported ? '来自原客户端历史' : m.collaboration?.mode === 'research' ? '科研模式' : m.collaboration?.mode === 'collaborative' ? '多模型协作' : ''}</span>${stages}${badge}${expBadge}${usage}<button data-copy="${esc(m.id)}" ${!m.text ? 'disabled' : ''}>${icon('copy')}复制</button>${experimentButton}${exportButton}${retryable ? `<button data-retry="${esc(m.id)}">${icon('refresh')}重新生成</button>` : ''}</div></article>`;
}
function renderRunStatus() {
  const m = state.active?.messages?.findLast(m => m.collaboration), run = m?.collaboration;
  const el = $('#run-status'); const visible = state.view === 'chat' && run?.status === 'running';
  el.classList.toggle('hidden', !visible);
  if (visible) {
    const stages = run.stages || (run.mode === 'single' ? ['生成完整答案'] : ['独立大纲','交叉审查','综合大纲','GPT 统筹','完整写作']).map((label,i) => ({ id: String(i), label }));
    /* 阶段一完成就把产出摘出来，不用等整轮结束再点开「思考过程」。 */
    const finished = [...(run.artifacts || [])].reverse().find(a => a.status === 'done' && a.stage !== 'research-final');
    const preview = finished
      ? `<div class="run-last"><strong>${esc(finished.stageLabel)}${finished.taskLabel ? ' / ' + esc(finished.taskLabel) : ''}</strong><span>已完成</span><p>${finished.text ? esc(previewOf(finished.text)) : '结构化产出，点开「各阶段产出」查看'}</p></div>`
      : '';
    /* 阶段条本身允许换行（P1 有 16 个环节），另加一条细进度条给「还剩多少」的直觉。
       aria-valuenow 用已完成环节数，读屏读到的不是百分比而是一步一步的推进。 */
    const total = Math.max(1, stages.length);
    const current = Math.min(Math.max(1, run.stageIndex || 1), total);
    /* 进度条按环节分段：一段一格，和上面的阶段条一一对应。
       不用 inline style 是因为 index.html 的 CSP 是 style-src 'self'，
       markup 里的 style 属性会被直接丢掉——这类比例只能靠 class 表达。 */
    const progressSegments = stages.map((stage, i) => {
      const kind = run.skippedStages?.includes(stage.id) ? 'skipped' : i + 1 < run.stageIndex ? 'done' : i + 1 === run.stageIndex ? 'active' : '';
      return `<i class="${kind}"></i>`;
    }).join('');
    const live = usageLabel(m.usage);
    el.innerHTML = `<div class="run-heading"><span class="run-spinner" aria-hidden="true"></span><strong>${esc(run.stageLabel)}</strong><span>阶段 ${run.stageIndex} / ${run.totalStages}${run.totalTasks > 1 ? ` · ${run.completedTasks} / ${run.totalTasks} 项完成` : ''}${run.callBudget ? ` · 调用 ${run.callsUsed}/${run.callBudget}` : ''}${live ? ` · ${esc(live)}` : ''}</span><span class="run-elapsed" aria-hidden="true">${elapsed(run)}</span></div><div class="run-progress" role="progressbar" aria-label="本轮进度" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${current - 1}">${progressSegments}</div><ol class="stage-flow" aria-label="协作进度">${stages.map((stage,i) => `<li class="${run.skippedStages?.includes(stage.id) ? 'skipped' : i + 1 < run.stageIndex ? 'complete' : i + 1 === run.stageIndex ? 'current' : ''}" ${i + 1 === run.stageIndex ? 'aria-current="step"' : ''}><span class="stage-marker">${run.skippedStages?.includes(stage.id) ? '−' : i + 1 < run.stageIndex ? icon('check') : i + 1}</span><span>${esc(stage.label)}</span></li>`).join('')}</ol>${preview}`;
  }
  $('#process-count').textContent = state.active?.messages?.reduce((n, m) => n + (m.collaboration?.artifacts.length || 0), 0) || '';
}
function workspaceOptions(selected) { return state.workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === selected ? 'selected' : ''}>${esc(w.name)}</option>`).join(''); }
function renderMessages() {
  const c = state.active, w = activeWorkspace();
  let html = `<section class="chat-content"><div class="chat-heading"><div><h1>${esc(c.title)}</h1><p>${isHistory(c) ? `${sourceLabel(c.source)} · ${c.messages.length} 条文字消息` : c.importedFrom ? `从 ${sourceLabel(c.importedFrom.source)} 历史副本继续` : 'Iris Unite 对话'}${w ? ` · ${esc(w.name)}` : ''}</p></div>${!isHistory(c) ? `<select id="conversation-workspace" class="conversation-workspace" aria-label="对话所属工作区" title="移动到工作区" ${state.busy.has(c.id) ? 'disabled' : ''}>${workspaceOptions(workspaceOf(c))}</select>` : ''}</div>`;
  if (!c.messages.length) html += '<div class="empty-state">输入一条消息，开始对话。</div>';
  if (state.chatTab === 'process') {
    const records = c.messages.filter(m => m.collaboration);
    html += `<div class="process-library"><h2>协作记录</h2>${records.length ? records.map(m => `<section class="process-round"><div class="process-round-heading"><strong>${esc(c.messages.find(u => u.role === 'user' && u.roundId === m.roundId)?.text || '对话')}</strong><span>${esc(m.collaboration.stageLabel)} · ${elapsed(m.collaboration)}</span></div>${processTimeline(m.collaboration)}</section>`).join('') : '<div class="empty-state">本次对话暂无协作记录。</div>'}</div>`;
    $('#content').innerHTML = html + '</section>'; return;
  }
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.role === 'user') html += `<div class="user-message"><div class="user-body"><div class="user-text">${esc(m.text)}</div><span class="timestamp">${formatTime(m.timestamp)}</span></div></div>`;
    else {
      const group = [m];
      if (m.roundId) while (i + 1 < c.messages.length && c.messages[i + 1].role === 'assistant' && c.messages[i + 1].roundId === m.roundId) group.push(c.messages[++i]);
      // 被新版取代的旧答案默认不显示，只留一个可展开的提示（§11.5：旧答案保留但不冒充当前结果）
      const current = group.filter(x => !x.supersededBy);
      const superseded = group.filter(x => x.supersededBy);
      const shown = current.length ? current : superseded.slice(-1);
      html += `<div class="reply-grid ${shown.length === 1 ? 'single' : ''}">${shown.map(replyCard).join('')}</div>`;
      if (superseded.length && current.length) html += `<div class="superseded-note">此项有 ${superseded.length} 个更早的回答版本（已保留在协作记录中）</div>`;
    }
  }
  $('#content').innerHTML = html + '</section>';
}
function renderChat() {
  state.view = 'chat'; closePopover(); const history = isHistory();
  $('#composer-area').classList.remove('hidden'); $('#composer').classList.toggle('hidden', !!history); $('.composer-footnote').classList.toggle('hidden', !!history); $('#history-notice').classList.toggle('hidden', !history);
  $('#workspace-title').textContent = activeWorkspace()?.name || '所有工作区'; $('#page-title').textContent = state.active?.title || '新对话';
  $('#export-button').disabled = !state.active; $('#rename-button').disabled = !state.active || history; const del = $('#delete-button'); if (del) del.disabled = !state.active || history;
  if (!state.active) $('#content').innerHTML = welcome(); else renderMessages();
  $('#chat-tabs').classList.remove('hidden'); syncTabs();
  renderModels(); renderSend(); renderSidebar(); renderRunStatus(); renderResumeHint();
}
/* 最近一轮给了实验建议却没执行时，在输入框上方明说一句并给出直达入口：
   否则用户会以为「再问一次」就是执行，结果是整套重跑一遍。
   只看最近一轮：更早的轮次已经被后来的结果覆盖。 */
function renderResumeHint() {
  const el = $('#resume-hint');
  if (!el) return;
  const latest = [...(state.active?.messages || [])].reverse().find(item => item.collaboration?.mode === 'research');
  const visible = state.view === 'chat' && !!latest
    && latest.collaboration.status === 'done'
    && !(latest.collaboration.experimentRuns || []).length
    && String(latest.text || '').trim().length > 0
    && !state.busy.has(state.active?.id) && !isHistory();
  el.classList.toggle('hidden', !visible);
  if (visible) el.dataset.message = latest.id;
  else delete el.dataset.message;
}
function prepareLibrary(title) { closePopover(); $('#composer-area').classList.add('hidden'); $('#chat-tabs').classList.add('hidden'); $('#workspace-title').textContent = selectedWorkspace()?.name || '所有工作区'; $('#page-title').textContent = title; $('#mode-badge').textContent = '本机记录'; $('#export-button').disabled = true; $('#rename-button').disabled = true; }
function renderWorkspaces() {
  state.view = 'workspaces'; prepareLibrary('工作区');
  $('#content').innerHTML = `<section class="library"><div class="library-title"><h1>工作区</h1><button class="secondary-button" data-action="add-workspace">${icon('plus')}添加工作区</button></div><p class="library-subtitle">已读取 DSH 与 Codex 的本机工作区，也可以添加一个文件夹。</p><div class="workspace-cards">${state.workspaces.map(w => `<button class="workspace-card" data-workspace="${esc(w.id)}">${icon('folder')}<div class="workspace-card-body"><strong>${esc(w.name)}</strong><p title="${esc(w.path)}">${esc(w.path || '尚未归入工作区的对话')}</p><small>${esc(w.sources.join(' · ') || 'Iris Unite')}${!w.available ? ' · 路径不可用' : ''}</small></div><span class="count">${w.conversationCount}</span></button>`).join('')}</div></section>`;
  renderSidebar();
}
function renderLibrary() {
  state.view = 'history'; const w = selectedWorkspace(); prepareLibrary(w?.name || '全部对话');
  const all = allConversations().filter(c => !w || workspaceOf(c) === w.id);
  const counts = { all: all.length, local: all.filter(c => c.source === 'local').length, dsh: all.filter(c => c.source === 'dsh').length, codex: all.filter(c => c.source === 'codex').length };
  const entries = all.filter(c => (state.filter === 'all' || c.source === state.filter) && (!state.query || `${c.title} ${c.cwd || ''}`.toLowerCase().includes(state.query.toLowerCase())));
  $('#content').innerHTML = `<section class="library"><div class="library-title"><h1>${esc(w?.name || '全部对话')}</h1><button class="secondary-button" data-action="new-chat">${icon('plus')}新建对话</button></div><p class="library-subtitle">${esc(w?.path || (w ? '尚未归入工作区的对话' : '来自 Iris Unite、DSH Desktop 与 Codex 的本机记录'))}</p><div class="library-controls"><div class="filter-tabs">${[['all', '全部'], ['local', 'Iris Unite'], ['dsh', 'DeepSeek'], ['codex', 'Codex']].map(([id, label]) => `<button data-filter="${id}" class="${state.filter === id ? 'active' : ''}">${label} ${counts[id]}</button>`).join('')}</div><label class="library-search">${icon('search')}<input id="library-query" value="${esc(state.query)}" placeholder="搜索对话" aria-label="搜索全部历史"></label></div>${state.historyErrors.length ? `<div class="library-errors">部分本机记录未能读取。<details><summary>查看详情</summary>${state.historyErrors.map(esc).join('<br>')}</details></div>` : ''}<div id="history-rows">${state.historyLoading ? `<div class="loading">${icon('refresh')}正在读取记录…</div>` : entries.length ? entries.map(c => `<button class="history-row" data-thread="${esc(c.id)}"><span class="history-row-body"><span class="history-row-title">${esc(c.title)}</span><span class="history-row-path">${esc(state.workspaces.find(w => w.id === workspaceOf(c))?.name || '未分组')}${c.importedFrom ? ' · 历史副本' : ''}</span></span><span class="source-label">${sourceLabel(c.source)}</span><span class="row-date">${formatDate(c.updatedAt)}</span>${icon('arrow-right')}</button>`).join('') : '<div class="library-empty">暂无匹配的对话</div>'}</div><div class="library-status">${entries.length} 条对话 · 原客户端记录只读查看</div></section>`;
  renderSidebar();
}
function renderCurrent() { if (state.view === 'workspaces') renderWorkspaces(); else if (state.view === 'history') renderLibrary(); else renderChat(); }
async function refreshHistory() {
  state.historyLoading = true; renderSidebar(); if (state.view !== 'chat') renderCurrent();
  try { const data = await window.duet.historyList(); state.history = data.items; state.historyErrors = data.errors; applyCatalog(data); }
  catch (e) { state.historyErrors = [e.message]; fail(e); }
  finally { state.historyLoading = false; renderSidebar(); if (state.view !== 'chat') renderCurrent(); }
}
async function refreshLocal() { state.local = await window.duet.list(); applyCatalog(await window.duet.workspaces()); renderSidebar(); }
function showWorkspace(id) { saveDraft(); state.navigation++; state.selectedWorkspace = id; localStorage.setItem('duet-workspace', id); state.filter = 'all'; state.query = ''; if (id !== 'all') state.expanded.add(id); renderLibrary(); closeMobileSidebar(); }
async function addWorkspace() {
  const result = await window.duet.addWorkspace(); if (!result) return;
  applyCatalog(result); state.selectedWorkspace = result.selectedId; state.expanded.add(result.selectedId); localStorage.setItem('duet-workspace', result.selectedId); newChat();
}
async function openThread(id) {
  saveDraft(); const navigation = ++state.navigation; closePopover(); state.view = 'chat'; $('#composer-area').classList.add('hidden'); $('#content').innerHTML = `<div class="loading">${icon('refresh')}正在打开对话…</div>`;
  try {
    const c = id.startsWith('codex:') || id.startsWith('dsh:') ? await window.duet.historyRead(id) : await window.duet.get(id);
    if (navigation !== state.navigation) return;
    state.active = c; state.chatTab = 'answer'; if (c.messages.some(m => m.status === 'streaming')) state.busy.add(c.id); state.selectedWorkspace = workspaceOf(c); state.expanded.add(state.selectedWorkspace); renderChat(); restoreDraft(); renderSend(); closeMobileSidebar(); $('#content').scrollTop = 0;
  } catch (e) { if (navigation === state.navigation) { renderChat(); fail(e); } }
}
function newChat() { saveDraft(); state.navigation++; state.active = null; state.chatTab = 'answer'; state.models = ['deepseek', 'gpt']; state.config = clone(state.settings.defaultModelConfig); renderChat(); restoreDraft(); renderSend(); closeMobileSidebar(); $('#content').scrollTop = 0; $('#prompt').focus(); }
async function toggleModel(provider) {
  if (isHistory() || state.busy.has(state.active?.id)) return;
  const current = state.active?.models || state.models;
  if (current.includes(provider) && current.length === 1) { toast('至少使用一个模型'); return; }
  if (!current.includes(provider) && current.length >= 6) { toast('最多同时启用六个模型'); return; }
  const next = current.includes(provider) ? current.filter(p => p !== provider) : [...current, provider];
  if (state.active) { const id = state.active.id; await window.duet.models(id, next); if (state.active?.id === id) state.active.models = next; }
  else state.models = next;
  renderModels();
}
let sending = false;
async function send() {
  if (state.busy.has(state.active?.id)) { await window.duet.stop(state.active.id); toast('正在停止…'); return; }
  if (sending || isHistory()) return;
  const text = $('#prompt').value.trim(); if (!text) { $('#prompt').focus(); return; }
  /* 输入框里写「执行实验：<方案>」也算明确指定：直接接着跑，不重跑前面的环节。
     没写清楚哪一个方案就照普通消息处理——不让程序替用户挑实验方向。 */
  const explicit = /^执行实验[：:]\s*([\s\S]+)$/.exec(text);
  if (explicit && state.active?.mode === 'research' && state.active?.messages?.length) {
    const latest = [...state.active.messages].reverse().find(item => item.collaboration?.mode === 'research'
      && item.collaboration.status === 'done' && !(item.collaboration.experimentRuns || []).length);
    const plan = explicit[1].trim();
    if (latest && plan.length >= 2) { $('#prompt').value = ''; state.drafts.delete(draftKey()); await runExperiment(latest.id, { text: plan }); return; }
  }
  sending = true; closePopover();
  try {
    await state.configQueue;
    if (!state.active) { const key = draftKey(); state.active = await window.duet.create({ models: state.models, modelConfig: config(), mode: state.mode, researchConfig: currentResearch(), workspaceId: state.selectedWorkspace === 'all' ? 'unassigned' : state.selectedWorkspace }); state.drafts.delete(key); }
    const id = state.active.id; state.busy.add(id); renderSend(); renderModels();
    const c = await window.duet.send(id, text);
    if (state.active?.id === id) { state.active = c; state.chatTab = 'answer'; $('#prompt').value = ''; state.drafts.delete(id); renderChat(); const pending = state.pendingEvents.splice(0); pending.forEach(handleEvent); $('#content').scrollTop = $('#content').scrollHeight; }
    await refreshLocal();
  } catch (e) { state.busy.delete(state.active?.id); renderSend(); renderModels(); fail(e); }
  finally { sending = false; }
}
function openSettings() {
  const s = state.settings; $('#use-dsh-key').checked = s.useDshKey; $('#deepseek-model').value = s.deepseekModel; $('#gpt-model').value = s.gptModel; $('#deepseek-key').value = ''; $('#clear-key').checked = false; $('#clear-key').closest('label').classList.toggle('hidden', !s.encryptedKey);
  $('#deepseek-setting-status').textContent = s.hasKey ? `已连接 · ${s.keySource}` : '尚未配置密钥'; $('#codex-setting-status').textContent = s.codexAvailable ? '已检测到本机 Codex CLI' : '未找到 Codex CLI'; $('#save-status').textContent = ''; renderConnections(); renderPricingList(); $('#settings-dialog').showModal();
}
function handleEvent(event) {
  if (event.type === 'done') { state.busy.delete(event.conversationId); renderSend(); renderModels(); refreshLocal().catch(fail); const select = $('#conversation-workspace'); if (select) select.disabled = false; }
  /* 没有打开的对话时直接返回：以前这里只比 id，state.active 为 null 且事件不带 conversationId
     时两边都是 undefined，会「相等」地继续往下走，然后在 state.active.messages 上抛错。 */
  if (!state.active || state.active.id !== event.conversationId) return;
  const m = state.active.messages.find(m => m.id === (event.messageId || event.message?.id));
  if (!m && event.type !== 'done') { if (sending) state.pendingEvents.push(event); return; }
  const nearBottom = $('#content').scrollHeight - $('#content').scrollTop - $('#content').clientHeight < 100;
  if (event.type === 'collaboration') {
    const e = event.event, run = m.collaboration;
    if (e.kind === 'stage') Object.assign(run, e.stage);
    if (e.kind === 'progress') Object.assign(run, { completedTasks: e.completedTasks, totalTasks: e.totalTasks });
    if (e.kind === 'artifact') { const i = run.artifacts.findIndex(a => a.id === e.artifact.id); if (i >= 0) run.artifacts[i] = e.artifact; else run.artifacts.push(e.artifact); }
    if (e.kind === 'artifact-delta') { const a = run.artifacts.find(a => a.id === e.artifactId); if (a) a.text += e.chunk; }
    if (e.kind === 'plan') { run.plan = e.plan; run.writer = e.writer; const p = run.participants.find(p => p.provider === e.writer); Object.assign(m, { provider: e.writer, model: p.model, effort: p.effort }); }
    if (e.kind === 'finished') Object.assign(run, { status: e.status, finishedAt: e.finishedAt, stageLabel: e.status === 'done' ? '已完成' : e.status === 'stopped' ? '已停止' : '协作未完成', error: e.error });
    if (e.kind === 'research-plan') run.researchPlan = e.plan;
    if (e.kind === 'research-selection') run.selection = e.selection;
    if (e.kind === 'research-scope') run.scope = e.scope;
    if (e.kind === 'research-evidence') { run.evidence = e.evidence; if (e.sanitized) run.evidenceSanitized = e.sanitized; }
    if (e.kind === 'knowledge') run.knowledge = e.stats;
    if (e.kind === 'integrity') { run.integrity = e.integrity; m.integrity = e.integrity; }
    if (e.kind === 'research-audit') run.audit = e.audit;
    if (e.kind === 'monitor') { (run.monitorLog || (run.monitorLog = [])).push({ ...e.decision, where: e.where }); }
    if (e.kind === 'budget') Object.assign(run, { callsUsed: e.callsUsed, callBudget: e.callBudget });
    if (e.kind === 'skipped') run.skippedStages = e.stages;
    if (e.kind === 'writer') Object.assign(m, { provider: e.writer, model: e.choice.model, effort: e.choice.effort });
    if (state.view === 'chat') {
      renderRunStatus();
      if (state.chatTab === 'process') scheduleTraceRender();
      else if (e.kind !== 'artifact-delta' || state.openProcesses.has(m.id)) scheduleReplyRender(m.id);
    }
  }
  if (event.type === 'delta') { m.text += event.chunk; const card = document.querySelector(`[data-reply="${CSS.escape(m.id)}"] .reply-body`); if (card) card.innerHTML = replyContent(m); }
  /* 科研模式的正文在核验通过前只以草稿形式存在：这里只更新字数提示，不写进正文。 */
  if (event.type === 'draft') {
    m.draftChars = event.chars;
    const status = document.querySelector(`[data-reply="${CSS.escape(m.id)}"] .reply-status`);
    if (status) status.textContent = `待核验 · ${event.chars} 字`;
    const body = document.querySelector(`[data-reply="${CSS.escape(m.id)}"] .reply-body`);
    if (body) body.innerHTML = replyContent(m);
  }
  if (event.type === 'reply-done') { const i = state.active.messages.findIndex(m => m.id === event.message.id); if (i >= 0) state.active.messages[i] = event.message; const card = document.querySelector(`[data-reply="${CSS.escape(event.message.id)}"]`); if (card) card.outerHTML = replyCard(event.message); }
  /* 每调用一次通道就推一次用量：运行中就能看着 token 与花费涨，不必等整轮结束。 */
  if (event.type === 'usage') {
    m.usage = event.usage;
    if (state.view === 'chat') { renderRunStatus(); if (state.chatTab === 'answer') scheduleReplyRender(m.id); }
  }
  if (nearBottom && state.view === 'chat') $('#content').scrollTop = $('#content').scrollHeight;
  if (event.type === 'done' && state.view === 'chat') renderRunStatus();
}
/* ── 花费估算 ────────────────────────────────────────────────────────
   单价由用户自己填（每百万 token），这里只做乘法：
   同一模型在不同套餐、不同时段的价格不一样，写死的价目表只会变成错账单。
   没填单价时显示「未设单价」，绝不拿一个推测数字冒充花费。
   主进程 core/pricing.cjs 里有一份等价实现（导出与账单核对用），改规则要两边一起改。 */
const COST_PER = 1000000;
const COST_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
function priceFor(provider, model) {
  const table = state.settings?.pricing || {};
  for (const key of [`${provider}:${model || ''}`, String(provider)]) {
    const entry = table[key];
    if (!entry) continue;
    const input = Number(entry.input) || 0, output = Number(entry.output) || 0;
    if (!input && !output) continue;
    return { input, output, currency: String(entry.currency || 'CNY').toUpperCase(), per: Number(entry.per) || COST_PER };
  }
  return null;
}
/** 把 usage.parts（按 provider:model 分账）折成一句金额。币种不同就分开写。 */
function costText(usage) {
  const parts = usage?.parts || {};
  const amounts = new Map();
  const unpriced = new Set();
  for (const [key, part] of Object.entries(parts)) {
    if (!part || (!part.input && !part.output)) continue;
    const [provider, ...rest] = String(key).split(':');
    const price = priceFor(provider, rest.join(':'));
    if (!price) { unpriced.add(provider); continue; }
    const amount = (part.input / price.per) * price.input + (part.output / price.per) * price.output;
    amounts.set(price.currency, (amounts.get(price.currency) || 0) + amount);
  }
  if (!amounts.size) return unpriced.size ? '未设单价' : '';
  return [...amounts].map(([currency, amount]) => `≈${COST_SYMBOL[currency] || ''}${amount >= 1 ? amount.toFixed(2) : amount.toFixed(4)}`).join(' + ');
}
function usageLabel(usage) {
  if (!usage?.reported) return '';
  const cost = costText(usage);
  return `${usage.total.toLocaleString()} tokens${cost ? ` · ${cost}` : ''}`;
}
const replyTimers = new Map();function scheduleReplyRender(id) {
  if (replyTimers.has(id)) return;
  replyTimers.set(id, setTimeout(() => {
    replyTimers.delete(id); if (state.view !== 'chat' || state.chatTab !== 'answer') return;
    const m = state.active?.messages.find(m => m.id === id), card = document.querySelector(`[data-reply="${CSS.escape(id)}"]`);
    if (m && card) { const bottom = $('#content').scrollHeight - $('#content').scrollTop - $('#content').clientHeight < 100; card.outerHTML = replyCard(m); if (bottom) $('#content').scrollTop = $('#content').scrollHeight; }
  }, 120));
}
function scheduleTraceRender() { if (scheduleTraceRender.timer) return; scheduleTraceRender.timer = setTimeout(() => { scheduleTraceRender.timer = null; if (state.view === 'chat' && state.chatTab === 'process' && state.active) renderMessages(); }, 150); }
window.duet.onEvent(handleEvent);
document.addEventListener('toggle', event => {
  const details = event.target; if (!details.matches('.process-details') || !details.isConnected) return;
  const id = details.dataset.process;
  if (details.open) { state.openProcesses.add(id); const m = state.active?.messages.find(m => m.id === id); if (m) details.querySelector('.process-expanded').innerHTML = processTimeline(m.collaboration); }
  else { state.openProcesses.delete(id); details.querySelector('.process-expanded').innerHTML = ''; }
}, true);
setInterval(() => {
  if (state.view !== 'chat') return;
  const m = state.active?.messages?.findLast(m => m.collaboration?.status === 'running'); if (!m) return;
  const clock = $('#run-status .run-elapsed'); if (clock) clock.textContent = elapsed(m.collaboration);
  const summary = document.querySelector(`[data-elapsed="${CSS.escape(m.id)}"]`); if (summary) summary.textContent = elapsed(m.collaboration);
}, 1000);
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!event.target.closest('#model-popover') && !button?.hasAttribute('data-model-options')) closePopover();
  const link = event.target.closest('.reply-body a[href], .artifact-body a[href]');
  if (link) { event.preventDefault(); try { await window.duet.openLink(link.getAttribute('href')); } catch (e) { fail(e); } return; }
  if (!button) return;
  try {
    if (button.dataset.window) return await window.duet.window(button.dataset.window);
    if (button.dataset.chatTab) { state.chatTab = button.dataset.chatTab; syncTabs(); if (state.active) renderMessages(); else $('#content').innerHTML = state.chatTab === 'answer' ? welcome() : '<section class="library"><h1>协作记录</h1><div class="library-empty">发起一次对话后，可在这里查看公开协作记录。</div></section>'; return; }
    if (button.classList.contains('dialog-close')) return button.closest('dialog').close();
    if (button.dataset.thread) return await openThread(button.dataset.thread);
    if (button.dataset.model) return await toggleModel(button.dataset.model);
    if (button.dataset.modelOptions) { const p = button.dataset.modelOptions; return state.popover === p ? closePopover() : renderPopover(p); }
    if (button.hasAttribute('data-close-popover')) return closePopover(true);
    if (button.hasAttribute('data-copy-code')) { const code = button.closest('.code-block')?.querySelector('code'); if (code) { await window.duet.copy(code.textContent); toast('代码已复制'); } return; }
    if (button.dataset.effort) { const p = state.popover; await updateConfig(p, { effort: button.dataset.effort }); renderPopover(p); return; }
    if (button.dataset.expand) { const id = button.dataset.expand; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); renderSidebar(); return; }
    if (button.dataset.more) { state.expandedChats.add(button.dataset.more); renderSidebar(); return; }
    if (button.dataset.workspace) return showWorkspace(button.dataset.workspace);
    if (button.dataset.filter) { state.filter = button.dataset.filter; renderLibrary(); return; }
    if (button.dataset.prompt) { $('#prompt').value = button.dataset.prompt; saveDraft(); resizePrompt(); renderSend(); $('#prompt').focus(); return; }
    if (button.dataset.action === 'workspaces') { saveDraft(); state.navigation++; renderWorkspaces(); return; }
    if (button.dataset.action === 'new-chat') return newChat();
    if (button.dataset.action === 'add-workspace') return await addWorkspace();
    if (button.dataset.copy) { const m = state.active?.messages.find(m => m.id === button.dataset.copy); if (m) { await window.duet.copy(m.text); toast('已复制'); } }
    if (button.dataset.exportResult) return await exportResult(button.dataset.exportResult, event.shiftKey === true);
    if (button.dataset.runExperiment) return openExperimentChoice(button.dataset.runExperiment);
    if (button.id === 'resume-run-button') { const target = $('#resume-hint')?.dataset.message; if (target) return openExperimentChoice(target); return; }
    if (button.dataset.planIndex) {
      const index = Number(button.dataset.planIndex);
      const option = experimentTarget?.options.find(item => item.index === index);
      if (option) { $('#experiment-choice-text').value = option.text; $('#experiment-choice-text').focus(); }
      return;
    }
    if (button.dataset.reveal) return await window.duet.reveal(button.dataset.reveal);
  } catch (e) { fail(e); }
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'power-slider') { const p = state.popover; if (p) await updateConfig(p, { effort: JSON.parse(event.target.dataset.efforts)[Number(event.target.value)] }); return; }
    if (event.target.id === 'provider-effort-select') { const p = state.popover; if (p) { await updateConfig(p, { effort: event.target.value }); renderPopover(p); } return; }
    if (event.target.id === 'workspace-select') return showWorkspace(event.target.value);
    if (event.target.id === 'provider-model-select') {
      const p = state.popover, model = state.catalog[p].find(m => m.id === event.target.value); if (!model) return;
      const previous = config()[p]; await updateConfig(p, { model: model.id, effort: model.efforts.includes(previous.effort) ? previous.effort : model.defaultEffort }); renderPopover(p);
    }
    if (event.target.id === 'conversation-workspace') {
      const id = state.active.id; const c = await window.duet.moveWorkspace(id, event.target.value); if (state.active?.id !== id) return;
      state.active = c; state.selectedWorkspace = c.workspaceId; state.expanded.add(c.workspaceId); await refreshLocal(); renderChat(); toast('已移动到工作区');
    }
  } catch (e) { fail(e); }
});
$('#new-chat').addEventListener('click', newChat);
$('#nav-history').addEventListener('click', () => showWorkspace('all'));
$('#nav-workspaces').addEventListener('click', () => { saveDraft(); state.navigation++; renderWorkspaces(); });
$('#add-workspace').addEventListener('click', () => addWorkspace().catch(fail));
$('#refresh-history').addEventListener('click', refreshHistory);
$('#settings-button').addEventListener('click', openSettings);
$('#send-button').addEventListener('click', () => send().catch(fail));
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send().catch(fail); } });
function resizePrompt() { const prompt = $('#prompt'); prompt.style.height = 'auto'; prompt.style.height = Math.min(192, Math.max(80, prompt.scrollHeight)) + 'px'; }
$('#prompt').addEventListener('input', () => { saveDraft(); resizePrompt(); renderSend(); });
document.addEventListener('keydown', e => {
  /* mac 上习惯用 Cmd：Ctrl+N 在 mac 上是「新建窗口」的系统约定，抢过来会让人错愕。 */
  /* 与 core/platform.cjs 的 primaryModifier 保持一致：mac 用 Cmd，其余用 Ctrl。 */
  const primary = platformInfo === 'darwin' ? e.metaKey : e.ctrlKey;
  if (primary && e.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { e.preventDefault(); newChat(); }
  if (primary && e.key.toLowerCase() === 'b' && !document.querySelector('dialog[open]')) { e.preventDefault(); toggleSidebar(); }
  if (e.key === 'Escape') { closePopover(true); if (document.body.classList.contains('sidebar-open')) setSidebar(false); }
});
$('#sidebar-search').addEventListener('input', e => {
  state.sidebarQuery = e.target.value; renderSidebar();
  clearTimeout(searchTimer);
  const q = state.sidebarQuery.trim();
  if (q.length < 2) { if (state.searchHits.size) { state.searchHits = new Map(); renderSidebar(); } return; }
  // 标题过滤是同步的，正文命中要问主进程；加个短延迟避免每敲一个字就扫一遍全部消息。
  searchTimer = setTimeout(async () => {
    try {
      const hits = await window.duet.search(q);
      state.searchHits = new Map(hits.map(h => [h.id, h]));
    } catch { state.searchHits = new Map(); }
    renderSidebar();
  }, 220);
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-retry]');
  if (!button) return;
  const id = state.active?.id;
  if (!id || state.busy.has(id)) return;
  button.disabled = true;
  try {
    const conversation = await window.duet.retry(id);
    state.active = conversation;
    state.busy.add(id);
    renderChat(); renderSend(); renderModels();
  } catch (e) { fail(e); button.disabled = false; }
});
document.addEventListener('input', e => { if (e.target.id === 'library-query') { const pos = e.target.selectionStart; state.query = e.target.value; renderLibrary(); $('#library-query').focus(); $('#library-query').setSelectionRange(pos, pos); } });
document.addEventListener('input', e => { if (e.target.id === 'power-slider') previewPower(e.target); });
const narrowSidebar = matchMedia('(max-width: 900px)');
function setSidebar(open) {
  if (narrowSidebar.matches) { document.body.classList.toggle('sidebar-open', open); $('.sidebar').inert = !open; }
  else { document.body.classList.toggle('sidebar-collapsed', !open); $('.sidebar').inert = false; }
  $('#expand-sidebar').setAttribute('aria-expanded', String(open));
  (open ? $('#collapse-sidebar') : $('#expand-sidebar')).focus({ preventScroll: true });
}
function toggleSidebar() { setSidebar(narrowSidebar.matches ? !document.body.classList.contains('sidebar-open') : document.body.classList.contains('sidebar-collapsed')); }
function closeMobileSidebar() { if (narrowSidebar.matches && document.body.classList.contains('sidebar-open')) setSidebar(false); }
function syncSidebar() { $('.sidebar').inert = narrowSidebar.matches && !document.body.classList.contains('sidebar-open'); }
$('#collapse-sidebar').addEventListener('click', () => setSidebar(false)); $('#expand-sidebar').addEventListener('click', () => setSidebar(true)); $('#sidebar-scrim').addEventListener('click', () => setSidebar(false));
narrowSidebar.addEventListener('change', syncSidebar); syncSidebar();
function syncTabs() { document.querySelectorAll('[data-chat-tab]').forEach(b => { const active = b.dataset.chatTab === state.chatTab; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); }
function renderTheme() { const preference = window.duetTheme.get(), label = { light: '浅色', dark: '深色', system: '跟随系统' }[preference]; $('#theme-button').innerHTML = icon({ light: 'sun', dark: 'moon', system: 'auto' }[preference]); $('#theme-button').title = `外观：${label}（点击切换）`; $('#theme-button').setAttribute('aria-label', `外观：${label}，点击切换`); }
$('#theme-button').addEventListener('click', () => { const modes = ['system','light','dark']; window.duetTheme.set(modes[(modes.indexOf(window.duetTheme.get()) + 1) % modes.length]); renderTheme(); });
$('#continue-button').addEventListener('click', async () => {
  if (!state.active || !isHistory()) return; const id = state.active.id; $('#continue-button').disabled = true;
  try { const c = await window.duet.continueHistory(id); state.active = c; state.selectedWorkspace = workspaceOf(c); state.expanded.add(state.selectedWorkspace); await refreshLocal(); renderChat(); restoreDraft(); $('#content').scrollTop = $('#content').scrollHeight; $('#prompt').focus(); toast('已建立对话副本'); }
  catch (e) { fail(e); } finally { $('#continue-button').disabled = false; }
});
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault(); try {
    state.settings = await window.duet.settings({ deepseekModel: $('#deepseek-model').value, gptModel: $('#gpt-model').value, apiKey: $('#deepseek-key').value, clearKey: $('#clear-key').checked, useDshKey: $('#use-dsh-key').checked, pricing: collectPricing() });
    if (!state.active) state.config = clone(state.settings.defaultModelConfig);
    $('#deepseek-key').value = ''; $('#settings-dialog').close(); renderModels(); renderSidebar(); toast('设置已保存');
  } catch { $('#save-status').textContent = '保存失败，请检查输入后重试'; }
});
$('#delete-button').addEventListener('click', async () => {
  const c = state.active;
  if (!c || isHistory()) return;
  if (state.busy.has(c.id)) { toast('请等待当前生成结束'); return; }
  // 删除是不可撤销的，必须让用户看到标题再确认。
  if (!window.confirm(`删除对话「${c.title}」？\n\n本地记录与本轮资料库会一起删除，无法撤销。原客户端（DSH / Codex）的历史不受影响。`)) return;
  try {
    await window.duet.deleteThread(c.id);
    state.local = state.local.filter(x => x.id !== c.id);
    state.active = null; state.view = 'history'; state.chatTab = 'answer';
    await refreshLocal();
    renderSidebar(); renderCurrent(); renderMessages(); renderModels(); renderSend();
    toast('对话已删除');
  } catch (e) { fail(e); }
});
/* 工具栏那颗按钮：科研轮次走一键导出，普通对话仍走原来的「导出对话」另存为。 */
$('#export-button').addEventListener('click', async event => {
  if (!state.active) return;
  try {
    const latest = [...(state.active.messages || [])].reverse().find(m => m.role === 'assistant' && String(m.text || '').trim());
    if (latest?.collaboration?.mode === 'research') { await exportResult(latest.id, event.shiftKey === true); return; }
    if (await window.duet.export(state.active.id)) toast('对话已导出');
  } catch (e) { fail(e); }
});
$('#rename-button').addEventListener('click', () => { if (state.active && !isHistory()) { $('#rename-input').value = state.active.title; $('#rename-dialog').showModal(); $('#rename-input').select(); } });$('#rename-form').addEventListener('submit', async e => { e.preventDefault(); try { state.active = await window.duet.rename(state.active.id, $('#rename-input').value); $('#rename-dialog').close(); await refreshLocal(); renderChat(); } catch (error) { fail(error); } });
$('#experiment-choice-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#experiment-choice-text').value.trim();
  if (text.length < 2) { $('#experiment-choice-status').textContent = '请写清要执行哪一个方案'; return; }
  const target = experimentTarget;
  if (!target) return;
  const option = target.options.find(item => item.text === text);
  $('#experiment-choice-dialog').close();
  await runExperiment(target.messageId, { text, index: option?.index ?? null });
});
async function init() {
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  renderTheme();
  try {
    const data = await window.duet.init(); state.settings = data.settings; state.catalog = data.modelCatalog; state.local = data.conversations; applyCatalog(data); state.config = clone(data.settings.defaultModelConfig); state.researchConfig = clone(data.settings.defaultResearchConfig);
    const remembered = localStorage.getItem('duet-workspace'); if (state.workspaces.some(w => w.id === remembered)) state.selectedWorkspace = remembered;
    const expanded = state.selectedWorkspace === 'all' ? state.workspaces[0]?.id : state.selectedWorkspace; if (expanded) state.expanded.add(expanded);
    renderChat(); await refreshHistory();
  } catch (e) { fail(e); }
}
init();

/* 界面偏好：正文字号与阅读宽度。只影响本机显示，不改动对话内容。 */
const displayPrefs = { font: localStorage.getItem('duet-font') || '14', width: localStorage.getItem('duet-width') || '860' };
function applyDisplayPrefs() {
  const font = Number(displayPrefs.font) || 14;
  const style = document.documentElement.style;
  style.setProperty('--text-base', font + 'px');
  style.setProperty('--line-body', (font + 10) + 'px');
  style.setProperty('--reading-width', (Number(displayPrefs.width) || 860) + 'px');
}
applyDisplayPrefs();
document.addEventListener('DOMContentLoaded', () => {
  const fontSelect = $('#ui-font'), widthSelect = $('#ui-width');
  if (fontSelect) {
    fontSelect.value = displayPrefs.font;
    fontSelect.addEventListener('change', () => { displayPrefs.font = fontSelect.value; localStorage.setItem('duet-font', displayPrefs.font); applyDisplayPrefs(); });
  }
  if (widthSelect) {
    widthSelect.value = displayPrefs.width;
    widthSelect.addEventListener('change', () => { displayPrefs.width = widthSelect.value; localStorage.setItem('duet-width', displayPrefs.width); applyDisplayPrefs(); });
  }
});
