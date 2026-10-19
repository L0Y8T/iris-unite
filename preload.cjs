const { contextBridge, ipcRenderer } = require('electron');
/* 事件通道探针：只统计到达 preload 的事件数，用于定位「主进程发了但界面没更新」。 */
let eventCount = 0;
let eventError = null;
let eventDelivered = 0;
ipcRenderer.on('duet:event', () => { eventCount += 1; });
contextBridge.exposeInMainWorld('__eventProbe', { count: () => eventCount, error: () => eventError, delivered: () => eventDelivered });
contextBridge.exposeInMainWorld('duet', {
  /* 界面按平台调整：mac 上隐藏自绘窗口按钮（有系统红绿灯）、快捷键改用 Cmd。 */
  platform: process.platform,
  init: () => ipcRenderer.invoke('duet:init'),
  list: () => ipcRenderer.invoke('duet:list'),
  workspaces: () => ipcRenderer.invoke('duet:workspaces'),
  addWorkspace: () => ipcRenderer.invoke('duet:workspace-add'),
  moveWorkspace: (id, workspaceId) => ipcRenderer.invoke('duet:workspace-move', { id, workspaceId }),
  create: options => ipcRenderer.invoke('duet:create', options),
  get: id => ipcRenderer.invoke('duet:get', id),
  models: (id, models) => ipcRenderer.invoke('duet:models', { id, models }),
  modelConfig: (id, modelConfig) => ipcRenderer.invoke('duet:model-config', { id, modelConfig }),
  runConfig: (id, mode, researchConfig) => ipcRenderer.invoke('duet:run-config', { id, mode, researchConfig }),
  saveConnection: input => ipcRenderer.invoke('duet:connection-save', input),
  removeConnection: id => ipcRenderer.invoke('duet:connection-remove', id),
  testConnection: id => ipcRenderer.invoke('duet:connection-test', id),
  modelList: input => ipcRenderer.invoke('duet:model-list', input),
  search: query => ipcRenderer.invoke('duet:search', query),
  deleteThread: id => ipcRenderer.invoke('duet:delete', id),
  retry: id => ipcRenderer.invoke('duet:retry', id),
  knowledge: id => ipcRenderer.invoke('duet:knowledge', id),
  profiles: () => ipcRenderer.invoke('duet:profiles'),
  plan: input => ipcRenderer.invoke('duet:plan', input),
  eventPing: () => ipcRenderer.invoke('duet:event-ping'),
  execTemplates: () => ipcRenderer.invoke('duet:exec-templates'),
  execPrepare: input => ipcRenderer.invoke('duet:exec-prepare', input),
  execRun: input => ipcRenderer.invoke('duet:exec-run', input),
  execBudget: input => ipcRenderer.invoke('duet:exec-budget', input),
  execCancel: runId => ipcRenderer.invoke('duet:exec-cancel', runId),
  execList: input => ipcRenderer.invoke('duet:exec-list', input),
  execGet: runId => ipcRenderer.invoke('duet:exec-get', runId),
  execOpen: input => ipcRenderer.invoke('duet:exec-open', input),
  execVerify: input => ipcRenderer.invoke('duet:exec-verify', input),
  rename: (id, title) => ipcRenderer.invoke('duet:rename', { id, title }),
  historyList: () => ipcRenderer.invoke('duet:history-list'),
  historyRead: id => ipcRenderer.invoke('duet:history-read', id),
  continueHistory: id => ipcRenderer.invoke('duet:continue', id),
  settings: options => ipcRenderer.invoke('duet:settings', options),
  send: (id, text, options) => ipcRenderer.invoke('duet:send', { id, text, ...(options && typeof options === 'object' ? options : {}) }),
  /* 执行实验必须带明确方案：planText 是用户点名的那一条，缺了主进程会拒绝。 */
  runExperiment: (id, messageId, plan) => ipcRenderer.invoke('duet:send', {
    id,
    text: `按上一轮的方案执行实验：${String(plan?.text || '').trim()}`,
    resumeFrom: messageId,
    planText: String(plan?.text || '').trim(),
    planIndex: Number.isInteger(plan?.index) ? plan.index : null,
    planTitle: typeof plan?.title === 'string' ? plan.title : null
  }),
  stop: id => ipcRenderer.invoke('duet:stop', id),
  copy: text => ipcRenderer.invoke('duet:copy', text),
  openLink: url => ipcRenderer.invoke('duet:open-link', url),
  export: id => ipcRenderer.invoke('duet:export', id),
  exportResult: input => ipcRenderer.invoke('duet:export-result', input),
  reveal: target => ipcRenderer.invoke('duet:reveal', target),
  window: action => ipcRenderer.invoke('duet:window', action),
  /* 订阅主进程事件。回调来自页面世界，必须捕获它抛出的异常——
     否则一个渲染错误会让后续所有事件静默丢失（那正是我们要避免的）。 */
  onEvent: callback => {
    const fn = (_, event) => {
      try { callback(event); eventDelivered += 1; } catch (e) { eventError = String((e && e.message) || e); }
    };
    ipcRenderer.on('duet:event', fn);
    return () => ipcRenderer.removeListener('duet:event', fn);
  }
});
