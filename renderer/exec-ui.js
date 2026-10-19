/* 实验执行界面：模板 → 参数 → 运行 → 日志 / 指标 / 产物 / 历史。
 *
 * 这一层只做展示与调用，执行规则全部在主进程（core/exec/）。
 * 界面上刻意不出现"自由写代码"入口：本期只跑随程序分发的模板脚本。
 */
const execState = { templates: [], selectedId: null, runningRunId: null, logLines: [], view: null };

function fmtMetric(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return value.toLocaleString();
    return String(Number(value.toPrecision(6)));
  }
  return String(value ?? '');
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(1) + ' s';
}

function execTemplate() {
  return execState.templates.find(t => t.id === execState.selectedId) || execState.templates[0] || null;
}

function renderExecBudget(budget) {
  const box = $('#exec-budget');
  if (!box) return;
  if (!budget) { box.textContent = ''; return; }
  const parts = budget.checks.map(c => `${c.label} ${c.used}/${c.limit}`).join(' · ');
  box.className = budget.ok ? 'exec-env-status' : 'exec-env-status bad';
  /* 没有打开的对话时，这次运行不属于任何对话，科研流程不会引用它——这一点必须说清楚。 */
  const scope = state.active?.id ? '' : '　当前没有打开的对话：这次运行不会被科研流程引用';
  box.textContent = (budget.ok ? '执行预算剩余 ' + budget.remainingRuns + ' 次 · ' : '执行预算不足：' + budget.reason + ' · ') + parts + scope;
}

function renderExecEnvStatus(info) {
  const box = $('#exec-env-status');
  if (!box) return;
  if (info.pythonError) {
    box.className = 'exec-env-status bad';
    box.textContent = '没有可用的 Python：' + info.pythonError;
    return;
  }
  const running = info.running || [];
  box.className = 'exec-env-status';
  const parts = ['Python ' + String(info.python?.version || '').replace(/^Python\s*/, '')];
  parts.push(running.length ? `运行中 ${running.length} 个` : '空闲');
  /* 执行方式如实写出来：没有隔离、允许联网，这两点不能藏。 */
  const template = execTemplate();
  const driver = (info.drivers || []).find(d => d.id === (template?.driver || 'template-python'));
  if (driver) parts.push(`执行方式 ${driver.name}（隔离：${driver.isolation === 'none' ? '无 OS 隔离' : driver.isolation}，网络：${driver.network === 'allowed' ? '允许' : '禁止'}）`);
  box.textContent = parts.join(' · ');
}

function renderExecTemplates() {
  const select = $('#exec-template');
  if (!select) return;
  select.innerHTML = execState.templates
    .map(t => `<option value="${esc(t.id)}" ${t.unimplemented ? 'disabled' : ''}>${esc(t.name)}${t.unimplemented ? '（未实现）' : ''}</option>`)
    .join('');
  if (execState.selectedId) select.value = execState.selectedId;
}

function renderExecParams() {
  const template = execTemplate();
  const host = $('#exec-params');
  if (!host) return;
  if (!template) { host.innerHTML = ''; return; }
  $('#exec-template-desc').textContent = template.description + (template.unimplemented ? `　未实现：${template.unimplemented}` : '');
  host.innerHTML = template.params.map(spec => {
    const id = 'exec-param-' + spec.id;
    let control;
    if (spec.type === 'enum') {
      control = `<select id="${id}" data-exec-param="${esc(spec.id)}">${spec.values.map(v => `<option value="${esc(v)}" ${v === spec.default ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    } else if (spec.type === 'boolean') {
      control = `<input id="${id}" type="checkbox" data-exec-param="${esc(spec.id)}" ${spec.default ? 'checked' : ''}>`;
    } else if (spec.type === 'integer' || spec.type === 'number') {
      const step = spec.step ?? (spec.type === 'integer' ? 1 : 'any');
      control = `<input id="${id}" type="number" data-exec-param="${esc(spec.id)}" value="${esc(spec.default)}" min="${spec.min}" max="${spec.max}" step="${step}">`;
    } else {
      control = `<input id="${id}" type="text" data-exec-param="${esc(spec.id)}" value="${esc(spec.default)}" maxlength="${spec.maxLength || 200}">`;
    }
    return `<label class="exec-param">${esc(spec.label || spec.id)}${control}</label>`;
  }).join('') + `<p class="exec-requires">依赖 ${template.requires.packages.map(esc).join('、')}${template.requires.gpu ? '（GPU 可选）' : ''}${template.envReady ? ' · 环境已就绪' : ' · 首次运行会先建隔离环境'}</p>`;
  $('#exec-run').disabled = !!template.unimplemented || !!execState.runningRunId;
}

function collectExecParams() {
  const params = {};
  for (const input of document.querySelectorAll('[data-exec-param]')) {
    const key = input.dataset.execParam;
    if (input.type === 'checkbox') params[key] = input.checked;
    else if (input.type === 'number') params[key] = input.value === '' ? undefined : Number(input.value);
    else params[key] = input.value;
  }
  return params;
}

function appendExecLog(stream, line) {
  execState.logLines.push({ stream, line });
  if (execState.logLines.length > 400) execState.logLines = execState.logLines.slice(-400);
  const box = $('#exec-log');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = execState.logLines.map(item => item.stream === 'stderr' ? `<span class="exec-log-err">${esc(item.line)}</span>` : esc(item.line)).join('\n');
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('#exec-log-meta').textContent = execState.logLines.length + ' 行';
}

function renderExecMetrics(view) {
  const host = $('#exec-metrics');
  if (!host) return;
  const metrics = view?.metrics || {};
  const keys = Object.keys(metrics);
  if (!keys.length) { host.innerHTML = '<span class="exec-muted">还没有运行结果。</span>'; return; }
  host.innerHTML = `<table class="exec-metric-table"><tbody>${keys.map(key => `<tr><th>${esc(key)}</th><td>${esc(fmtMetric(metrics[key]))}</td></tr>`).join('')}</tbody></table>`;
  const artifacts = view.artifacts || [];
  $('#exec-artifacts').innerHTML = artifacts.length
    ? '产物：' + artifacts.map(a => `<button type="button" class="exec-artifact" data-exec-open="${esc(a.name)}">${esc(a.name)}<small>${Math.round(a.bytes / 1024)} KB</small></button>`).join(' ')
    : '';
}

function execStatusText(view) {
  if (!view) return '';
  const map = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消', timeout: '超时终止' };
  return map[view.status] || view.status;
}

function renderExecHistory(runs) {
  const host = $('#exec-history');
  if (!host) return;
  if (!runs.length) { host.innerHTML = '<span class="exec-muted">还没有运行记录。</span>'; return; }
  host.innerHTML = runs.map(run => {
    const key = Object.entries(run.metrics || {}).slice(0, 2).map(([k, v]) => `${k.split('.').pop()} ${fmtMetric(v)}`).join(' · ');
    return `<button type="button" class="exec-history-row ${run.status}" data-exec-run="${esc(run.runId)}">
      <span class="exec-history-name">${esc(run.template?.name || run.template?.id || '未知模板')}</span>
      <span class="exec-history-status">${esc(execStatusText(run))}</span>
      <span class="exec-history-metrics">${esc(key || run.error || '')}</span>
      <span class="exec-history-time">${esc(fmtDuration(run.durationMs))}</span>
    </button>`;
  }).join('');
}

async function loadExecHistory() {
  const conversationId = state.active?.id || undefined;
  const { runs } = await window.duet.execList({ conversationId });
  renderExecHistory(runs);
  return runs;
}

async function openExecDialog() {
  try {
    closePopover();
    $('#exec-error').textContent = '';
    const info = await window.duet.execTemplates();
    execState.templates = info.templates;
    execState.selectedId = execState.selectedId || (info.templates.find(t => !t.unimplemented)?.id ?? info.templates[0]?.id);
    renderExecEnvStatus(info);
    renderExecTemplates();
    renderExecParams();
    $('#exec-dialog').showModal();
    await loadExecHistory();
    try { renderExecBudget(await window.duet.execBudget({ conversationId: state.active?.id || null })); } catch { /* 预算显示失败不影响运行 */ }
  } catch (e) { fail(e); }
}

async function showExecRun(runId) {
  const { manifest, view } = await window.duet.execGet(runId);
  execState.view = view;
  execState.logLines = (manifest.logs?.stdout || []).map(line => ({ stream: 'stdout', line }))
    .concat((manifest.logs?.stderr || []).map(line => ({ stream: 'stderr', line })));
  const box = $('#exec-log');
  if (box) box.innerHTML = execState.logLines.map(item => item.stream === 'stderr' ? `<span class="exec-log-err">${esc(item.line)}</span>` : esc(item.line)).join('\n');
  $('#exec-log-meta').textContent = execState.logLines.length + ' 行';
  $('#exec-run-status').textContent = `${execStatusText(view)}${view.error ? '：' + view.error : ''}`;
  renderExecMetrics(view);
}

async function startExecRun() {
  const template = execTemplate();
  if (!template) return;
  const button = $('#exec-run');
  button.disabled = true;
  $('#exec-error').textContent = '';
  execState.logLines = [];
  $('#exec-log').textContent = '';
  $('#exec-metrics').innerHTML = '<span class="exec-muted">运行中…</span>';
  $('#exec-artifacts').innerHTML = '';
  $('#exec-run-status').textContent = '准备环境…';
  try {
    const { runId } = await window.duet.execRun({
      templateId: template.id,
      params: collectExecParams(),
      conversationId: state.active?.id || null
    });
    execState.runningRunId = runId;
    $('#exec-cancel').disabled = false;
    $('#exec-run-status').textContent = '运行中';
    appendExecLog('stdout', `[运行 ${runId}]`);
  } catch (e) {
    $('#exec-error').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('#exec-run-status').textContent = '';
    button.disabled = false;
  }
}

function onExecEvent(payload) {
  if (payload.type === 'exec-prepare') {
    appendExecLog('stdout', '[环境] ' + payload.line);
    return;
  }
  if (payload.type !== 'exec-event') return;
  const event = payload.event;
  if (event.type === 'log') {
    appendExecLog(event.stream, event.line);
    return;
  }
  if (event.type === 'status') {
    const label = execStatusText({ status: event.status });
    $('#exec-run-status').textContent = label + (event.error ? '：' + event.error : '');
    if (event.metrics) renderExecMetrics({ metrics: event.metrics, artifacts: event.artifacts || [] });
    return;
  }
  if (event.type === 'finished') {
    execState.runningRunId = null;
    $('#exec-cancel').disabled = true;
    $('#exec-run').disabled = false;
    $('#exec-run-status').textContent = execStatusText({ status: event.status }) + (event.error ? '：' + event.error : '');
    if (event.runId) showExecRun(event.runId).catch(() => {});
    loadExecHistory().catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const entry = $('#exec-button');
  if (entry) entry.addEventListener('click', () => openExecDialog());
  $('#exec-template')?.addEventListener('change', event => {
    execState.selectedId = event.target.value;
    renderExecParams();
  });
  $('#exec-run')?.addEventListener('click', () => startExecRun().catch(fail));
  $('#exec-cancel')?.addEventListener('click', async () => {
    if (!execState.runningRunId) return;
    try { await window.duet.execCancel(execState.runningRunId); } catch (e) { fail(e); }
  });
  $('#exec-history')?.addEventListener('click', event => {
    const row = event.target.closest('[data-exec-run]');
    if (row) showExecRun(row.dataset.execRun).catch(fail);
  });
  $('#exec-artifacts')?.addEventListener('click', event => {
    const button = event.target.closest('[data-exec-open]');
    if (!button) return;
    const runId = execState.view?.runId;
    if (!runId) return;
    window.duet.execOpen({ runId, name: button.dataset.execOpen }).catch(fail);
  });
  if (window.duet?.onEvent) window.duet.onEvent(onExecEvent);
});
