const { app, BrowserWindow, Menu, ipcMain, safeStorage, dialog, clipboard, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { Store, validateModels } = require('./core/store.cjs');
const providers = require('./core/providers.cjs');
const { loadWorkspaceCatalog, workspaceId, UNASSIGNED } = require('./core/workspaces.cjs');
const models = require('./core/models.cjs');
const platform = require('./core/platform.cjs');
const { createRun, runCollaboration } = require('./core/collaboration.cjs');
const { externalURL } = require('./core/links.cjs');
const connections = require('./core/connections.cjs');
const { runCustom, listModels } = require('./core/custom-provider.cjs');
const research = require('./core/research.cjs');
const retrieval = require('./core/retrieval.cjs');
const citation = require('./core/citation.cjs');
const { KnowledgeBase } = require('./core/knowledge.cjs');
const exporter = require('./core/export.cjs');
const { createMonitor, DEFAULT_LIMITS } = require('./core/monitor.cjs');
const presets = require('./core/presets.cjs');
const profiles = require('./core/profiles.cjs');
const planner = require('./core/plan.cjs');
const execTemplates = require('./core/exec/templates.cjs');
const execEnv = require('./core/exec/env.cjs');
const execRunner = require('./core/exec/runner.cjs');
const execManifests = require('./core/exec/manifest.cjs');
const execClaims = require('./core/exec/claims.cjs');
const execBudget = require('./core/exec/budget.cjs');
const execDrivers = require('./core/exec/driver.cjs');

app.setName('Iris Unite');
const smoke = !app.isPackaged && process.argv.includes('--smoke-test');
const frontendTest = !app.isPackaged && process.argv.includes('--frontend-test');

/* 数据目录。
 * 过去个人记录放在程序目录（exe 旁边的 Iris-data），换程序或误删发布目录就会连对话一起丢。
 * 现在正式版放到 %APPDATA%\IrisUnite，程序目录只放程序；测试与验证档仍然用隔离目录，
 * 互不污染。开发版留在源码目录下的 .local-data（已 gitignore）。
 */
function resolveDataRoot() {
  /* 验收脚本与便携部署需要把数据目录指到别处；只有显式设置时才生效，正常启动完全不受影响。 */
  if (process.env.IRIS_DATA_ROOT) return path.resolve(process.env.IRIS_DATA_ROOT);
  if (frontendTest) return path.join(__dirname, '.test-data/v5-ui');
  if (smoke) return path.join(__dirname, '.test-data/v3-ui');
  if (process.argv.includes('--verification-profile')) return path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, '.verification-profile');
  if (!app.isPackaged) return path.join(__dirname, '.local-data');
  return path.join(app.getPath('appData'), 'IrisUnite');
}
const dataRoot = resolveDataRoot();

/* 图标按平台优先选（mac 只认 icns、Linux 认 png）；全缺时返回 undefined，
   交给 Electron 用默认图标——不能因为少一个资源文件就让启动失败。 */
function platformAssets() {
  const candidates = platform.iconCandidates(process.platform, path.join(__dirname, 'assets'));
  return { icon: candidates.find(candidate => fs.existsSync(candidate)) };
}

/* 一键导出的落盘目录：优先系统下载目录，取不到就退到应用数据目录里，不弹对话框。
   IRIS_EXPORT_DIR 供验收脚本与「下载目录不可写」的环境指定别处。 */
function exportDir() {
  if (process.env.IRIS_EXPORT_DIR) return path.resolve(process.env.IRIS_EXPORT_DIR);
  try {
    const downloads = app.getPath('downloads');
    if (downloads) return downloads;
  } catch { /* 精简环境下可能没有下载目录 */ }
  return path.join(dataRoot, 'exports');
}

/** 同名文件不覆盖：追加 -2、-3，避免第二次一键导出把上一次的成果冲掉。 */
function uniqueFilePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

/** 首次在新数据目录启动时，把程序目录里的旧个人数据搬过来；原目录内容不删。 */
function migrateLegacyData() {
  if (!app.isPackaged) return null;
  // 验收档用隔离数据，不该把正式数据搬进来。
  if (process.argv.includes('--verification-profile')) return null;
  if (fs.existsSync(path.join(dataRoot, 'conversations.json'))) return null;
  const beside = path.dirname(process.execPath);
  const source = [path.join(beside, 'Iris-data'), path.join(beside, 'Duet-data')].find(dir => fs.existsSync(path.join(dir, 'conversations.json')));
  if (!source) return null;
  fs.mkdirSync(dataRoot, { recursive: true });
  for (const name of ['conversations.json', 'settings.json', 'coordinator-schema.json']) {
    const from = path.join(source, name);
    if (fs.existsSync(from) && !fs.existsSync(path.join(dataRoot, name))) fs.copyFileSync(from, path.join(dataRoot, name));
  }
  const note = { from: source, at: Date.now(), note: '首次启动时从程序目录迁移个人数据；原目录内容未删除，可自行清理。' };
  fs.writeFileSync(path.join(dataRoot, 'migrated-from.json'), JSON.stringify(note, null, 2));
  return note;
}
const migration = migrateLegacyData();
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', path.join(dataRoot, 'chromium'));
app.setAppUserModelId('local.tibo.irisunite');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let win, worker, store;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
let settings = { deepseekModel: 'deepseek-flash', gptModel: '', useDshKey: true };
const settingsFile = path.join(dataRoot, 'settings.json');
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* defaults */ }
delete settings.mode;
settings.connections ||= [];
let modelCatalog = models.modelCatalog(undefined, settings.connections);
const histories = new Map(), requests = new Map(), running = new Map();
const decrypt = encoded => safeStorage.decryptString(Buffer.from(encoded, 'base64'));
const sendEvent = payload => {
  if (process.env.IRIS_DEBUG_EVENTS) console.log('[event]', payload?.type, payload?.event?.type || '');
  if (win && !win.isDestroyed()) win.webContents.send('duet:event', payload);
};

/* ── 实验运行的状态与索引 ───────────────────────────────────────────
   运行中状态只在内存；每次运行的完整记录落在 run 目录的 manifest.json，
   索引文件只存摘要（列表用），最多 300 条。 */
const execRunning = new Map();
/* 本次会话里真的导出过的文件：只有这些允许被「打开所在文件夹」。 */
const exportedFiles = new Set();
const execDir = (...parts) => path.join(dataRoot, 'exec', ...parts);
const execIndexFile = () => execDir('runs-index.json');
function readExecIndex() {
  try { const raw = JSON.parse(fs.readFileSync(execIndexFile(), 'utf8')); return Array.isArray(raw) ? raw : []; } catch { return []; }
}
function upsertExecIndex(manifest) {
  try {
    const list = readExecIndex().filter(item => item.runId !== manifest.runId);
    list.unshift(execManifests.summarize(manifest, { logTail: 0 }));
    fs.mkdirSync(execDir(), { recursive: true });
    fs.writeFileSync(execIndexFile(), JSON.stringify(list.slice(0, 300), null, 1), 'utf8');
  } catch { /* 索引写失败不影响本次运行本身 */ }
}
function loadExecManifest(runId) {
  try { return JSON.parse(fs.readFileSync(execDir('runs', path.basename(String(runId)), 'manifest.json'), 'utf8')); } catch { return null; }
}
function listExecEnvs() {
  try { return fs.readdirSync(execDir('envs')); } catch { return []; }
}
/** 单价的规范化：只留正数单价与已知币种，0 视为没填。 */
function normalizePricing(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const currencies = ['CNY', 'USD', 'EUR', 'GBP', 'JPY'];
  for (const [key, value] of Object.entries(input)) {
    if (!/^[\w.:-]{1,140}$/.test(key)) continue;
    const inputPrice = Number(value?.input);
    const outputPrice = Number(value?.output);
    const hasInput = Number.isFinite(inputPrice) && inputPrice > 0;
    const hasOutput = Number.isFinite(outputPrice) && outputPrice > 0;
    if (!hasInput && !hasOutput) continue;
    const currency = currencies.includes(String(value?.currency || '').toUpperCase()) ? String(value.currency).toUpperCase() : 'CNY';
    out[key] = { input: hasInput ? inputPrice : 0, output: hasOutput ? outputPrice : 0, currency };
  }
  return out;
}

function publicSettings() {
  let credential = { source: '未配置', key: '' };
  try { credential = providers.deepseekKey(settings, decrypt); } catch { /* encrypted key unavailable */ }
  return {
    deepseekModel: settings.deepseekModel,
    gptModel: settings.gptModel,
    useDshKey: settings.useDshKey,
    hasKey: !!credential.key,
    keySource: credential.source,
    codexAvailable: !!providers.findCodex(),
    encryptedKey: !!settings.encryptedKey,
    defaultModelConfig: models.defaults(settings, modelCatalog),
    connections: settings.connections.map(connections.publicConnection),
    pricing: settings.pricing || {},
    defaultResearchConfig: research.defaults(modelCatalog),
    presets: presets.list(),
    retrievalSources: retrieval.SOURCES,
    monitorLimits: DEFAULT_LIMITS,
    dataLocation: dataRoot,
    migratedFrom: migration,
    usability: {
      // 供界面直接告诉用户「还差什么才能跑」：不要让人对着报错猜。
      codex: !!providers.findCodex(),
      deepseek: !!credential.key,
      connections: settings.connections.filter(c => c.enabled && (c.allowNoKey || c.encryptedKey)).length
    }
  };
}
function saveSettings(next) { const temporary = settingsFile + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(next, null, 2)); fs.renameSync(temporary, settingsFile); settings = next; modelCatalog = models.modelCatalog(undefined, settings.connections); }
function ensureAvailable(ids) { for (const id of ids) if (!modelCatalog.providers.includes(id)) throw new Error('所选模型已停用或移除，请在模型面板重新选择'); }
function assertReady(ids, snapshot) {
  ensureAvailable(ids);
  for (const id of new Set(ids)) {
    if (id === 'gpt' && !providers.findCodex()) throw new Error('未找到 Codex CLI，请先连接 GPT');
    if (id === 'deepseek' && !providers.deepseekKey(snapshot, decrypt).key) throw new Error('DeepSeek 尚未配置密钥');
    const connection = snapshot.connections?.find(c => c.id === id);
    if (connection && !connection.allowNoKey && !connection.encryptedKey) throw new Error(`${connection.name} 尚未配置 API Key，请在设置中填写`);
  }
}
function workspaceCatalog() { return loadWorkspaceCatalog([...store.list(), ...histories.values()], store.data.workspaces); }
function historyRequest(action, item) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('读取历史超时，请重试。')); }, 120000);
    requests.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, item });
  });
}
function register(name, handler) {
  ipcMain.handle(name, async (event, args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('不受信任的调用');
    return handler(args);
  });
}
function setupIPC() {
  register('duet:init', () => ({ conversations: store.list(), settings: publicSettings(), modelCatalog, ...workspaceCatalog() }));
  register('duet:list', () => store.list());
  register('duet:workspaces', () => workspaceCatalog());
  register('duet:workspace-add', async () => {
    const result = await dialog.showOpenDialog(win, { title: '选择工作区文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    const id = workspaceId(folder);
    if (!store.data.workspaces.some(w => workspaceId(w.path) === id)) { store.data.workspaces.push({ path: folder, name: path.basename(folder) }); store.save(); }
    return { selectedId: id, ...workspaceCatalog() };
  });
  register('duet:create', options => {
    const id = options?.workspaceId || UNASSIGNED;
    const workspace = workspaceCatalog().workspaces.find(w => w.id === id);
    if (!workspace) throw new Error('工作区不存在，请刷新后重试');
    const selected = validateModels(options?.models || ['deepseek', 'gpt']); ensureAvailable(selected);
    return store.create({ models: selected, modelConfig: models.validateModelConfig(options?.modelConfig || models.defaults(settings, modelCatalog), modelCatalog), workspaceId: id, cwd: workspace.path, mode: options?.mode === 'research' ? 'research' : 'standard', researchConfig: research.validateConfig(options?.researchConfig || research.defaults(modelCatalog), modelCatalog) });
  });
  register('duet:get', id => store.get(id));
  register('duet:models', ({ id, models: selected }) => { if (running.has(id)) throw new Error('请等待当前回答完成后再切换模型'); validateModels(selected); ensureAvailable(selected.filter(p=>!store.get(id).models.includes(p))); return store.updateModels(id, selected); });
  register('duet:model-config', ({ id, modelConfig }) => { if (running.has(id)) throw new Error('请等待当前回答完成后再调整强度'); const c = store.get(id); c.modelConfig = models.validateModelConfig(modelConfig, modelCatalog); store.save(); return c; });
  register('duet:run-config', ({ id, mode, researchConfig }) => { if (running.has(id)) throw new Error('请等待当前回答完成后再切换模式'); const c = store.get(id), nextMode = mode === 'research' ? 'research' : 'standard'; const proposed = researchConfig || c.researchConfig || research.defaults(modelCatalog); const nextConfig = nextMode === 'research' ? research.validateConfig(proposed, modelCatalog) : proposed; c.mode = nextMode; c.researchConfig = nextConfig; store.save(); return c; });
  register('duet:connection-save', input => {
    if (running.size) throw new Error('请等待正在运行的任务完成后再修改模型连接');
    const previous = input.id ? settings.connections.find(c => c.id === input.id) : null;
    if (input.id && !previous) throw new Error('模型连接不存在');
    const next = connections.validateConnection(input, previous, key => { if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密存储不可用'); return safeStorage.encryptString(key).toString('base64'); });
    saveSettings({ ...settings, connections: previous ? settings.connections.map(c => c.id === next.id ? next : c) : [...settings.connections, next] });
    return { settings: publicSettings(), modelCatalog };
  });
  register('duet:connection-remove', id => { if (running.size) throw new Error('请等待任务完成后再移除连接'); saveSettings({ ...settings, connections: settings.connections.filter(c => c.id !== id) }); return { settings: publicSettings(), modelCatalog }; });
  register('duet:connection-test', async id => {
    const connection = settings.connections.find(c => c.id === id); if (!connection) throw new Error('请先保存模型连接');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000); let result = '';
    try { await runCustom({ connection: { ...connection, maxTokens: Math.min(connection.maxTokens, 4096) }, choice: { model: connection.model, effort: 'default' }, key: connection.encryptedKey ? decrypt(connection.encryptedKey) : '', messages: [{ role: 'user', content: '连接测试。请只回复 OK。' }], signal: controller.signal, onText: text => result += text }); return { success: true, received: result.length }; } finally { clearTimeout(timer); }
  });
  register('duet:workspace-move', ({ id, workspaceId }) => {
    if (running.has(id)) throw new Error('请等待当前回答完成后再移动对话');
    const w = workspaceCatalog().workspaces.find(w => w.id === workspaceId); if (!w) throw new Error('工作区不存在');
    const c = store.get(id); c.workspaceId = w.id; c.cwd = w.path; store.save(); return c;
  });
  register('duet:rename', ({ id, title }) => {
    const c = store.get(id); c.title = String(title).trim().slice(0, 100) || '未命名对话'; store.save(); return c;
  });
  register('duet:history-list', async () => {
    const result = await historyRequest('list'); histories.clear();
    for (const item of result.items) histories.set(item.id, item);
    const catalog = workspaceCatalog();
    return { ...result, items: result.items.map(({ file, ...item }) => item), ...catalog, errors: [...result.errors, ...catalog.errors] };
  });
  register('duet:history-read', async id => {
    const item = histories.get(id); if (!item) throw new Error('会话不存在，请刷新历史列表');
    const { file, ...result } = await historyRequest('read', item); return result;
  });
  register('duet:continue', async id => {
    const item = histories.get(id); if (!item) throw new Error('会话不存在，请刷新后重试');
    const original = await historyRequest('read', item);
    return store.create({ title: original.title, models: original.models, cwd: original.cwd || '', workspaceId: workspaceCatalog().assignments[id] || UNASSIGNED, modelConfig: models.defaults(settings, modelCatalog), importedFrom: { source: original.source, id: original.originalId }, messages: original.messages.map(m => ({ ...m, id: randomUUID(), status: 'done', imported: true })) });
  });
  register('duet:settings', args => {
    if (!args || typeof args !== 'object') throw new Error('无效设置');
    const next = { ...settings, deepseekModel: String(args.deepseekModel || 'deepseek-flash').trim().slice(0, 100), gptModel: String(args.gptModel || '').trim().slice(0, 100), useDshKey: args.useDshKey !== false };
    /* 单价是用户自己填的，界面传什么就存什么（0 与空等价，直接丢掉，避免伪装成「免费」）。 */
    if (args.pricing !== undefined) next.pricing = normalizePricing(args.pricing);
    if (args.clearKey) delete next.encryptedKey;
    if (typeof args.apiKey === 'string' && args.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密存储不可用，请使用 DSH 配置或环境变量。');
      next.encryptedKey = safeStorage.encryptString(args.apiKey.trim()).toString('base64');
    }
    saveSettings(next); return publicSettings();
  });
  register('duet:delete', id => {
    if (running.has(id)) throw new Error('请等待当前生成结束再删除对话');
    const removed = store.remove(id);
    KnowledgeBase.remove({ conversationId: id, dir: dataRoot });
    return { id: removed.id, title: removed.title };
  });
  register('duet:search', query => store.search(query));
  /* Profile 元信息：界面据此渲染档位选择器与环节列表，规则只从 core/profiles.cjs 来。 */
  register('duet:profiles', () => ({
    ids: profiles.PROFILE_IDS,
    implemented: profiles.IMPLEMENTED_PROFILES,
    info: profiles.PROFILE_IDS.map(id => ({
      id,
      name: profiles.PROFILE_INFO[id].name,
      outputRole: profiles.PROFILE_INFO[id].outputRole,
      retrievalRequired: profiles.PROFILE_INFO[id].retrievalRequired,
      refinementAllowed: profiles.PROFILE_INFO[id].refinementAllowed,
      tasks: profiles.PROFILE_INFO[id].tasks,
      roles: profiles.PROFILE_ROLES[id],
      stages: profiles.stagesOf(id, { allowRefinement: true }).map(stageId => ({
        id: stageId,
        label: profiles.STAGE_META[stageId].label,
        type: profiles.STAGE_META[stageId].type,
        role: profiles.STAGE_META[stageId].role
      })),
      roleLabels: Object.fromEntries(profiles.activeRoles(id).map(role => [role, profiles.STAGE_META[profiles.ROLE_STAGE[role]]?.label || role]))
    })),
    tiers: profiles.TIER_IDS,
    policy: { maxCallsCap: profiles.POLICY.maxCallsCap, wallClock: [profiles.POLICY.minWallClockSec, profiles.POLICY.maxWallClockSec], chapters: profiles.POLICY.teachingChapters }
  }));
  /* 计划预览：编译配置态计划 + 就绪检查 + 生效态覆盖，全部是纯计算，不发请求。 */
  register('duet:plan', input => {
    let raw;
    if (input?.config) raw = input.config;
    else if (input?.id) raw = store.get(input.id).researchConfig;
    else raw = research.defaults(modelCatalog);
    let migration = null;
    try {
      const migrated = profiles.migrateConfig(raw);
      migration = migrated.report;
      const compiled = planner.compileConfigPlan(migrated.config);
      const readiness = planner.readiness(compiled, modelCatalog);
      // 本期还没有源凭据体系，所有已配置源先按 ok 处理；接入 §13.6 后由凭据与熔断状态填充。
      const capabilities = { sources: Object.fromEntries((migrated.config.retrieval.sources || []).map(id => [id, 'ok'])) };
      const effective = planner.deriveEffectivePlan(compiled, capabilities);
      return {
        ok: readiness.ok,
        planVersion: compiled.planVersion,
        profile: compiled.profile,
        profileName: compiled.profileName,
        tier: compiled.tier,
        baseCalls: compiled.baseCalls,
        maxCalls: compiled.maxCalls,
        maxOptionalCalls: compiled.maxOptionalCalls,
        reserve: compiled.reserve,
        wallClockSec: compiled.wallClockSec,
        stages: compiled.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, required: n.required, fanOut: n.fanOut, condition: n.condition })),
        disabledCapabilities: compiled.disabledCapabilities,
        effective,
        readiness,
        migration
      };
    } catch (e) {
      return { ok: false, error: e.message, migration };
    }
  });
  register('duet:knowledge', id => {
    store.get(id);
    const kb = KnowledgeBase.load({ conversationId: id, dir: dataRoot });
    return { stats: kb.stats(), records: kb.all().map(({ abstract, ...rest }) => ({ ...rest, abstractLength: (abstract || '').length })) };
  });

  /* ── 实验执行 ──────────────────────────────────────────────────────
     受控执行：模板脚本随程序分发，模型/用户只能填参数。
     每次运行都落一份 manifest 到 run 目录，索引另存一份供列表使用。 */
  /* 事件通道自检：确认「主进程发出 → 渲染进程收到」这一段是通的。 */
  register('duet:event-ping', () => {
    const at = Date.now();
    sendEvent({ type: 'ping', at });
    return { at, url: win?.webContents?.getURL() || null, webContentsId: win?.webContents?.id ?? null, destroyed: win?.isDestroyed?.() ?? true };
  });
  register('duet:exec-templates', async () => {    let python = null;
    let pythonError = null;
    try { python = await execEnv.detectPython(); } catch (e) { pythonError = e.message; }
    const envs = listExecEnvs();
    return {
      python,
      pythonError,
      templates: execTemplates.TEMPLATES.map(template => ({
        id: template.id,
        version: template.version,
        name: template.name,
        description: template.description,
        params: template.params,
        requires: template.requires,
        artifacts: template.artifacts,
        metrics: template.metrics,
        timeoutSec: template.timeoutSec,
        driver: template.driver || 'template-python',
        unimplemented: template.unimplemented || null,
        envReady: envs.includes(execTemplates.envKey(template.requires.packages))
      })),
      running: [...execRunning.keys()].map(runId => ({ runId, ...execRunning.get(runId) }))
    };
  });

  register('duet:exec-prepare', async input => {
    const template = execTemplates.templateById(input?.templateId);
    if (template.unimplemented) throw new Error(`${template.name} 尚未实现：${template.unimplemented}`);
    const driver = execDrivers.resolve(template);
    const env = await driver.prepare({ template, dataRoot, onLog: line => sendEvent({ type: 'exec-prepare', templateId: template.id, line }) });
    return { envDir: env.envDir, fingerprint: env.fingerprint, pythonVersion: env.pythonVersion || null, created: env.created, driver: driver.id };
  });

  register('duet:exec-run', async input => {
    /* 执行预算是独立的一本账：模型调用预算管不到这里，这里也不占模型预算。 */
    const budget = execBudget.evaluateBudget({ runs: readExecIndex(), conversationId: input?.conversationId || null });
    if (!budget.ok) throw new Error('执行预算不足：' + budget.reason);
    const template = execTemplates.templateById(input?.templateId);
    if (template.unimplemented) throw new Error(`${template.name} 尚未实现：${template.unimplemented}`);
    const params = execTemplates.validateParams(template.id, input?.params || {});
    const driver = execDrivers.resolve(template);
    const env = await driver.prepare({ template, dataRoot, onLog: line => sendEvent({ type: 'exec-prepare', templateId: template.id, line }) });
    const controller = new AbortController();
    let resolveRunId = () => {};
    const runIdReady = new Promise(resolve => { resolveRunId = resolve; });
    let knownRunId = null;
    const done = driver.run({
      template,
      params,
      dataRoot,
      env,
      timeoutSec: input?.timeoutSec,
      signal: controller.signal,
      conversationId: input?.conversationId || null,
      onEvent: event => {
        if (!knownRunId && event.runId) {
          knownRunId = event.runId;
          execRunning.set(event.runId, { templateId: template.id, conversationId: input?.conversationId || null, startedAt: Date.now(), controller });
          resolveRunId(event.runId);
        }
        sendEvent({ type: 'exec-event', event });
      }
    });
    done.then(({ manifest }) => {
      execRunning.delete(manifest.runId);
      upsertExecIndex(manifest);
      sendEvent({ type: 'exec-event', event: { type: 'finished', runId: manifest.runId, status: manifest.status } });
    }).catch(error => {
      if (knownRunId) {
        execRunning.delete(knownRunId);
        sendEvent({ type: 'exec-event', event: { type: 'finished', runId: knownRunId, status: 'failed', error: String(error?.message || error) } });
      }
    });
    const runId = await runIdReady;
    return { runId, fingerprint: env.fingerprint };
  });

  /* 执行预算独立于模型调用预算：这里只回答“还能跑几次/多久”。 */
  register('duet:exec-budget', input => execBudget.evaluateBudget({ runs: readExecIndex(), conversationId: input?.conversationId || null }));

  register('duet:exec-cancel', runId => {
    const entry = execRunning.get(runId);
    if (!entry) throw new Error('这条运行已经结束或不存在');
    entry.controller?.abort?.();
    return { runId, cancelled: true };
  });

  register('duet:exec-list', input => {
    const all = readExecIndex();
    const conversationId = input?.conversationId;
    const scoped = conversationId ? all.filter(item => item.conversationId === conversationId) : all;
    return { runs: scoped.slice(0, 100), all: all.length, running: [...execRunning.keys()] };
  });

  register('duet:exec-get', runId => {
    const safe = path.basename(String(runId || ''));
    if (!safe.startsWith('run-')) throw new Error('无效的运行 ID');
    const dir = path.join(dataRoot, 'exec', 'runs', safe);
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error('找不到这条运行记录');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { manifest, view: execManifests.summarize(manifest, { logTail: 200 }), dir };
  });

  register('duet:exec-open', input => {
    const safeRun = path.basename(String(input?.runId || ''));
    if (!safeRun.startsWith('run-')) throw new Error('无效的运行 ID');
    const artifactDir = path.join(dataRoot, 'exec', 'runs', safeRun, 'artifacts');
    if (input?.name) {
      const target = path.resolve(artifactDir, String(input.name));
      if (!target.startsWith(path.resolve(artifactDir) + path.sep)) throw new Error('产物路径越界');
      if (!fs.existsSync(target)) throw new Error('产物不存在');
      shell.showItemInFolder(target);
      return { opened: target };
    }
    if (!fs.existsSync(artifactDir)) throw new Error('产物目录不存在');
    shell.showItemInFolder(artifactDir);
    return { opened: artifactDir };
  });

  /* 给科研流程用：可引用运行清单 + 正文数字核验。 */
  register('duet:exec-verify', input => {
    const conversationId = input?.conversationId;
    const runs = readExecIndex()
      .filter(item => (conversationId ? item.conversationId === conversationId : true) && item.status === 'done')
      .map(item => loadExecManifest(item.runId))
      .filter(Boolean);
    const reference = execClaims.referenceBlock(runs);
    const result = input?.text ? execClaims.verify(String(input.text), runs) : null;
    return { runs: runs.map(r => ({ runId: r.runId, label: r.label || null, template: r.template?.id, metrics: execManifests.metricTable(r) })), reference, result };
  });

  register('duet:model-list', async input => {
    if (!input || typeof input !== 'object') throw new Error('无效的请求');
    const saved = input.id ? settings.connections.find(c => c.id === input.id) : null;
    const protocol = input.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const targetBase = connections.endpoint(input.baseUrl || saved?.baseUrl || '');
    const draft = { baseUrl: targetBase, protocol, allowNoKey: input.allowNoKey === true || saved?.allowNoKey === true };
    /* 密钥只对录入时的那个端点有效（§12.2）：草稿改了地址或协议，就不得回退使用同 ID 已保存的密钥。
       以前这里按 id 取旧密钥，等于把密钥发到了新目标。 */
    const sameTarget = !!saved && saved.baseUrl === targetBase && saved.protocol === protocol;
    const explicit = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : '';
    const reused = !explicit && sameTarget && !!saved.encryptedKey;
    const key = explicit || (reused ? decrypt(saved.encryptedKey) : '');
    const ids = await listModels({ connection: draft, key });
    return { models: ids, count: ids.length, keySource: explicit ? 'input' : reused ? 'saved' : 'none' };
  });
  /* 重新生成：不删旧答案、不新增用户消息（§11.5）。
     新回答作为一条独立消息挂在同一个问题后面，只有它成功后才把旧答案标为被取代；
     失败时旧答案保持可见，用户不会因为一次失败丢掉上一轮结果。 */
  register('duet:retry', async id => {
    if (running.has(id)) throw new Error('当前对话正在生成回答');
    const conversation = store.get(id);
    const lastUserIndex = (() => {
      for (let i = conversation.messages.length - 1; i >= 0; i--) if (conversation.messages[i].role === 'user') return i;
      return -1;
    })();
    if (lastUserIndex < 0) throw new Error('这条对话还没有可以重试的问题');
    const lastUser = conversation.messages[lastUserIndex];
    const previous = conversation.messages.slice(lastUserIndex + 1).filter(m => m.role === 'assistant' && !m.supersededBy).at(-1) || null;
    if (previous?.status === 'streaming') throw new Error('当前对话正在生成回答');
    return sendTurn(id, lastUser.text.trim(), { appendUser: false, retryOf: previous?.id || null });
  });
  register('duet:send', async ({ id, text, resumeFrom, planText, planIndex, planTitle }) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('请输入 1–50000 字的消息');
    return sendTurn(id, text.trim(), {
      resumeFrom: typeof resumeFrom === 'string' ? resumeFrom : null,
      choice: { text: typeof planText === 'string' ? planText : '', index: Number.isInteger(planIndex) ? planIndex : null, title: typeof planTitle === 'string' ? planTitle : null }
    });
  });
  /**
 * 跑一轮对话。send 与 retry 共用。
 * appendUser=false 时（重新生成）不追加新的用户消息，而是复用最后那条问题，
 * 只是给它换一个新的 roundId，让新回答与它配对。
 * resumeFrom 指向某一轮科研结果：沿用它的界定/证据/资料库，只执行实验与整合；
 * 此时 choice 必须写明执行哪一个方案，缺了就拒绝——不让程序自己挑一个方向。
 */
async function sendTurn(id, text, { appendUser = true, retryOf = null, resumeFrom = null, choice = null } = {}) {
    if (running.has(id)) throw new Error('当前对话正在生成回答');
    const c = store.get(id); validateModels(c.models);
    const selectedConfig = models.validateModelConfig(c.modelConfig || models.defaults(settings, modelCatalog), modelCatalog);
    const snapshot = { ...settings, deepseekModel: selectedConfig.deepseek.model, deepseekEffort: selectedConfig.deepseek.effort, gptModel: selectedConfig.gpt.model, gptEffort: selectedConfig.gpt.effort };
    const baseResearchConfig = c.mode === 'research' ? research.validateConfig(c.researchConfig || research.defaults(modelCatalog), modelCatalog) : null;
    /* 沿用上一轮：只派生这一轮要跑的配置，不回写到对话配置里，
       否则后面每次追问都会莫名其妙地变成「只跑实验」。 */
    let researchConfig = baseResearchConfig;
    if (baseResearchConfig && resumeFrom) {
      const source = c.messages.find(m => m.id === resumeFrom);
      if (!source) throw new Error('找不到要沿用结果的那一轮');
      researchConfig = research.validateConfig(research.withResume(baseResearchConfig, source.collaboration, choice), modelCatalog);
    }
    // 本期未实现的档位在发请求前就拒绝：不要让用户等到跑完一半才发现。
    if (researchConfig) research.assertRunnable(researchConfig);
    // 配置迁移（v2/v3→v4）结果回写，避免每轮都重新迁移、也避免界面读到旧形状。
    if (baseResearchConfig && Number(c.researchConfig?.version) !== 4) { c.researchConfig = baseResearchConfig; store.save(); }
    // 科研模式下参与通道取自每个环节各自的模型选择，不再写死 GPT。
    const participants = researchConfig
      ? [...new Set([...Object.values(researchConfig.choices).filter(Boolean).map(v => v.provider), ...researchConfig.tasks.map(t => t.choice.provider)])]
      : [...c.models];
    // 普通协作固定是 3N+2 次调用。给个明确上限，免得开到六个模型还不知道要花多少次。
    if (!researchConfig && participants.length > 1) {
      const expected = participants.length * 3 + 2;
      const limit = Number(settings.collaborationCallLimit) > 0 ? Number(settings.collaborationCallLimit) : 24;
      if (expected > limit) throw new Error(`本轮多模型协作需要 ${expected} 次模型调用，超过上限 ${limit} 次。请减少参与模型，或在设置里提高上限。`);
    }
    assertReady(participants, snapshot);
    const controller = new AbortController();
    const roundId = randomUUID();
    let user;
    if (appendUser) {
      user = { id: randomUUID(), role: 'user', text: text.trim(), timestamp: Date.now(), roundId };
      c.messages.push(user);
    } else {
      // 重新生成：复用最后那条用户消息，不新增。roundId 换新，回答才配得上。
      user = [...c.messages].reverse().find(m => m.role === 'user');
      if (!user) throw new Error('这条对话还没有可以重试的问题');
      user.roundId = roundId;
    }
    c.updatedAt = Date.now();
    if (c.title === '新的对话') c.title = text.trim().replace(/\s+/g, ' ').slice(0, 32);
    const context = JSON.parse(JSON.stringify(c));
    const collaboration = researchConfig ? research.createRun(researchConfig) : createRun(participants, selectedConfig);
    const reply = { id: randomUUID(), role: 'assistant', kind: 'answer', provider: collaboration.writer, text: '', status: 'streaming', roundId, timestamp: Date.now(), collaboration, ...(retryOf ? { attemptOf: retryOf } : {}) };
    if (reply.provider) Object.assign(reply, researchConfig ? researchConfig.choices.final : selectedConfig[reply.provider]);
    c.messages.push(reply); store.save();
    const timer = setTimeout(() => controller.abort(), 1200000);
    running.set(id, { controller, timer });
    /* 资料库：只在启用检索时加载，供检索、证据提取与最终核验共用。 */
    const knowledge = researchConfig?.retrieval?.enabled ? KnowledgeBase.load({ conversationId: id, dir: dataRoot }) : null;
    /* 本对话已完成的实验运行（完整运行记录，不只是索引摘要）。
       只有状态为 done 的运行才会进这里——失败的运行不能给答案提供数字。 */
    const researchRuns = researchConfig
      ? readExecIndex()
        .filter(item => item.conversationId === id && item.status === 'done')
        .map(item => loadExecManifest(item.runId))
        .filter(manifest => manifest && manifest.status === 'done')
      : [];
    /* 监控：只读内存快照，不发请求、不调用模型，所以很便宜。 */
    let monitor = null;
    if (researchConfig && researchConfig.monitor.enabled) {
      try { monitor = createMonitor({ limits: { ...DEFAULT_LIMITS, ...(researchConfig.monitor.limits || {}) } }); } catch { monitor = null; }
    }
    /* 用量统计：只统计通道真实返回的 token，不估算、不编造。parts 按通道分账，供按单价计价。 */
    const usage = { calls: 0, input: 0, output: 0, total: 0, reported: 0, parts: {} };
    /* 停滞看门狗：调用在飞行中时阶段边界观察不到它，必须用墙钟单独盯。
       只做一件事——长时间没有任何增量就停掉本轮，并把现场写进记录。 */
    let watchdog;
    if (researchConfig) {
      const stallMs = Number(DEFAULT_LIMITS.stallMs) || 600000;
      watchdog = setInterval(() => {
        if (controller.signal.aborted || !running.has(id)) return;
        const idle = Date.now() - (collaboration.lastActivityAt || collaboration.startedAt);
        if (idle < stallMs) return;
        const reason = `连续 ${Math.round(idle / 60000)} 分钟没有任何新内容`;
        collaboration.monitorStop = { at: Date.now(), silentMs: idle, reason };
        sendEvent({ type: 'collaboration', conversationId: id, messageId: reply.id, event: { kind: 'monitor', where: '停滞看门狗', decision: { at: Date.now(), kind: 'stall', severity: 'critical', action: 'abort', reason, detail: { silentMs: idle, stage: collaboration.stage } } } });
        controller.abort();
      }, 30000);
      if (watchdog.unref) watchdog.unref();
    }
    // Return the placeholder first so no stage events race the renderer's IPC reply.
    setImmediate(async () => {
      let persistTimer;
      const persist = immediate => {
        if (immediate) { clearTimeout(persistTimer); persistTimer = null; store.save(); }
        else if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; store.save(); }, 500);
      };
      try {
        const execute = researchConfig ? research.runResearch : runCollaboration;
        const result = await execute({
          conversation: context, participants, config: researchConfig, run: collaboration, signal: controller.signal,
          ...(researchConfig ? {
            // 真实检索：不加任何密钥，走公开学术接口。联系人邮箱用于 OpenAlex 的礼貌池，可选。
            retrieve: ({ query, sources, limit, yearFrom, signal }) => retrieval.search({ query, sources, limit, yearFrom, signal, contact: settings.retrievalContact || process.env.IRIS_RETRIEVAL_CONTACT || undefined }),
            knowledge,
            citation,
            monitor,
            /* 本对话已完成的实验运行：既用于给模型提供可引用的事实，也用于发布前核对数字。
               没有运行记录时 referenceBlock 会明确写出"不得出现实验数字"。 */
            experimentRuns: researchRuns,
            experimentReference: runs => execClaims.referenceBlock(runs),
            verifyExperiments: (text, runs) => {
              const report = execClaims.verify(String(text || ''), runs);
              const redacted = execClaims.redact(String(text || ''), report);
              return { ...report, text: redacted.text, removed: redacted.removed, note: report.note || redacted.note };
            },
            /* 实验族在流程内部执行：与研究环节同源，不是独立功能的远程调用。 */
            experimentTools: {
              templates: () => execTemplates.TEMPLATES
                .filter(template => !template.unimplemented)
                .map(template => ({ id: template.id, name: template.name, metrics: template.metrics, params: template.params })),
              checkBudget: () => execBudget.evaluateBudget({ runs: readExecIndex(), conversationId: id }),
              run: async ({ templateId, params, signal, label }) => {
                const template = execTemplates.templateById(templateId);
                const driver = execDrivers.resolve(template);
                const env = await driver.prepare({ template, dataRoot, onLog: line => sendEvent({ type: 'exec-prepare', templateId: template.id, line }) });
                const { manifest } = await driver.run({
                  template, params, dataRoot, env, signal, conversationId: id,
                  onEvent: event => sendEvent({ type: 'exec-event', event: { ...event, label } })
                });
                /* label 是 trial 的展示名，不能占用 manifest.label——那个字段是 E 编号的位置，
                   由 claims.labelRuns 按时间顺序分配，否则模型写的 [E1] 会对不上。 */
                const labelled = { ...manifest, trialLabel: label || null };
                upsertExecIndex(labelled);
                return labelled;
              }
            }
          } : {}),
          call: async ({ provider, choice, messages, signal, onText, outputSchema }) => {
            const selected = choice || selectedConfig[provider];
            const scoped = { ...snapshot, ...(provider === 'gpt' ? { gptModel: selected.model, gptEffort: selected.effort } : provider === 'deepseek' ? { deepseekModel: selected.model, deepseekEffort: selected.effort } : {}) };
            const args = { conversation: context, settings: scoped, signal, onText, messages, cwd: c.cwd && fs.existsSync(c.cwd) ? c.cwd : dataRoot };
            usage.calls += 1;
            /* 用量按 `provider:model` 分开记：一轮科研会同时用到好几个通道，
               只有分开记才谈得上按各自单价算钱（合计 token 无法反推单价）。 */
            const usageKey = `${provider}:${selected?.model || ''}`;
            const countUsage = u => {
              usage.input += u.input || 0; usage.output += u.output || 0; usage.total += u.total || 0; usage.reported += 1;
              const part = usage.parts[usageKey] || (usage.parts[usageKey] = { input: 0, output: 0 });
              part.input += u.input || 0; part.output += u.output || 0;
              /* 实时推给界面：运行中就能看到 token 与花费在涨，不用等整轮结束。 */
              sendEvent({ type: 'usage', conversationId: id, messageId: reply.id, usage: { ...usage } });
            };
            if (provider === 'deepseek') return providers.runDeepseek({ ...args, key: providers.deepseekKey(scoped, decrypt).key, onUsage: countUsage });
            if (provider !== 'gpt') { const connection = snapshot.connections.find(c => c.id === provider); return runCustom({ ...args, connection, choice: selected, key: connection.encryptedKey ? decrypt(connection.encryptedKey) : '' }); }
            const schemaFile = outputSchema ? path.join(dataRoot, 'schema-' + randomUUID() + '.json') : undefined;
            if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(outputSchema));
            try { return await providers.runCodex({ ...args, outputSchemaPath: schemaFile }); } finally { if (schemaFile) try { fs.unlinkSync(schemaFile); } catch { /* cancelled process */ } }
          },
          onChange: event => {
            if (event.kind === 'plan') Object.assign(reply, { provider: event.writer, ...selectedConfig[event.writer] });
            if (event.kind === 'writer') Object.assign(reply, { provider: event.writer, ...event.choice });
            sendEvent({ type: 'collaboration', conversationId: id, messageId: reply.id, event });
            persist(event.kind !== 'artifact-delta');
          },
          onFinal: chunk => {
            if (controller.signal.aborted) return;
            /* 科研模式：核验通过前的正文只进草稿，不进最终答案（§14.6）。
               正文区在整轮结束前保持空，避免未核验文本被阅读、复制或导出。 */
            if (researchConfig) {
              reply.draftText = (reply.draftText || '') + chunk;
              persist(false);
              sendEvent({ type: 'draft', conversationId: id, messageId: reply.id, chars: reply.draftText.length });
              return;
            }
            reply.text += chunk; persist(false);
            sendEvent({ type: 'delta', conversationId: id, messageId: reply.id, chunk });
          }
        });
        // 科研模式：最终正文用「引用核验后」的版本替换流式过程中那份。
        if (result?.finalText) { reply.text = result.finalText; reply.integrity = result.integrity || null; reply.experiments = result.experiments || null; reply.experimentFamily = result.experimentFamily || null; delete reply.draftText; }
        if (usage.calls) reply.usage = { ...usage };
        reply.status = controller.signal.aborted ? 'stopped' : 'done';
      } catch (e) {
        reply.status = controller.signal.aborted ? 'stopped' : 'error';
        reply.error = controller.signal.aborted ? '已停止生成' : e.message;
      } finally {
        clearTimeout(persistTimer); clearTimeout(timer); if (watchdog) clearInterval(watchdog); running.delete(id);
        // 只有新回答成功，旧答案才标为被取代；失败时旧答案继续可见（§11.5）。
        if (retryOf && reply.status === 'done') {
          const previous = c.messages.find(m => m.id === retryOf);
          if (previous) previous.supersededBy = reply.id;
        }
        c.updatedAt = Date.now(); store.save();
        sendEvent({ type: 'reply-done', conversationId: id, message: reply });
        sendEvent({ type: 'done', conversationId: id });
      }
    });
    return c;
  }
  register('duet:stop', id => { running.get(id)?.controller.abort(); return true; });
  register('duet:copy', text => { clipboard.writeText(String(text)); return true; });
  register('duet:open-link', url => shell.openExternal(externalURL(url)));
  register('duet:export', async id => {
    const c = id.startsWith('codex:') || id.startsWith('dsh:') ? await historyRequest('read', histories.get(id)) : store.get(id);
    const result = await dialog.showSaveDialog(win, { title: '导出对话', defaultPath: c.title.replace(/[<>:"/\\|?*]/g, '_') + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled) return false;
    const body = `# ${c.title}\n\n` + c.messages.map(m => `## ${m.role === 'user' ? '你' : m.kind === 'answer' ? '完整答案' : modelCatalog.providerNames[m.provider] || m.provider || 'Iris Unite'}\n\n${m.text}${m.error ? '\n\n' + m.error : ''}`).join('\n\n---\n\n');
    await fs.promises.writeFile(result.filePath, body, 'utf8'); return true;
  });
  /* 一键导出结果：把这一轮的全部产出（结论、核验、实验运行、资料库、阶段记录）落成一份 Markdown。
     quick 不弹对话框直接写到下载目录；save 才让用户挑位置。
     外部历史会话（codex:/dsh:）没有本地协作记录，明确拒绝而不是导出一份空壳。 */
  register('duet:export-result', async input => {
    const id = String(input?.id || '');
    const mode = input?.mode === 'save' ? 'save' : 'quick';
    if (!id) throw new Error('缺少对话标识');
    if (id.startsWith('codex:') || id.startsWith('dsh:')) return { ok: false, reason: 'external' };
    const c = store.get(id);
    if (!c) throw new Error('找不到这条对话');
    const wanted = String(input?.messageId || '');
    const message = wanted
      ? c.messages.find(item => item.id === wanted || item.roundId === wanted)
      : [...c.messages].reverse().find(item => item.role === 'assistant' && String(item.text || '').trim());
    if (!message) return { ok: false, reason: 'empty' };
    const manifests = readExecIndex()
      .filter(item => item.conversationId === id)
      .map(item => loadExecManifest(item.runId))
      .filter(Boolean);
    let records = [];
    try { records = KnowledgeBase.load({ conversationId: id, dir: dataRoot }).all(); } catch { records = []; }
    /* 只有科研轮次才谈得上「研究结果」；普通对话导的是整份对话记录，文件名也照实写。 */
    const researchRound = message.collaboration?.mode === 'research';
    const body = researchRound
      ? exporter.researchReport({ conversation: c, message, manifests, records })
      : exporter.conversationMarkdown(c);
    const name = exporter.suggestFileName({ conversation: c, message });
    let filePath;
    if (mode === 'save') {
      const picked = await dialog.showSaveDialog(win, { title: '导出研究结果', defaultPath: path.join(exportDir(), name), filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      filePath = picked.filePath;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } else {
      const dir = exportDir();
      fs.mkdirSync(dir, { recursive: true });
      filePath = uniqueFilePath(dir, name);
    }
    await fs.promises.writeFile(filePath, body, 'utf8');
    exportedFiles.add(path.resolve(filePath));
    return { ok: true, filePath, name: path.basename(filePath), bytes: Buffer.byteLength(body, 'utf8'), mode };
  });
  /* 只允许定位本次真的导出过的文件：renderer 传来的路径不能被当成任意文件探测器。 */
  register('duet:reveal', target => {
    const value = path.resolve(String(target || ''));
    if (!exportedFiles.has(value)) throw new Error('这个文件不是本次导出的，无法定位');
    if (!fs.existsSync(value)) throw new Error('文件不存在');
    shell.showItemInFolder(value);
    return true;
  });
  register('duet:window', action => {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
  });
}
app.whenReady().then(async () => {
  if (!singleInstance) return;
  store = new Store(dataRoot);
  worker = new Worker(path.join(__dirname, 'core/history-worker.cjs'));
  worker.on('message', ({ id, result, error }) => {
    const r = requests.get(id); if (!r) return; clearTimeout(r.timer); requests.delete(id);
    error ? r.reject(new Error(error)) : r.resolve(result);
  });
  worker.on('error', e => {
    for (const r of requests.values()) { clearTimeout(r.timer); r.reject(new Error('历史读取进程异常：' + e.message)); } requests.clear();
  });
  setupIPC();
  await createWindow();
  if (smoke || frontendTest) {
    try { await require(frontendTest ? './tests/frontend-check.cjs' : './tests/ui-smoke.cjs').run(win, __dirname, frontendTest ? store : undefined); app.exit(0); }
    catch (e) { for (const item of running.values()) item.controller.abort(); try { store.save(); } catch {} console.error(e.stack); app.exit(1); }
  }
});

/**
 * 建窗口并按平台处理菜单。
 * macOS 上有两件不能省的事：
 *   1. 保留系统红绿灯（hiddenInset），否则用户没法关窗口；
 *   2. 必须留 Edit 菜单——没有菜单时 Cmd+C / Cmd+V / Cmd+Z 全部失效，这是 macOS 的规矩。
 * 其他平台继续用一个自绘标题栏 + 无菜单的紧凑窗口。
 */
async function createWindow() {
  /* 图标只查一次：platformAssets 会挨个 existsSync，写两遍就是双倍盘查询。 */
  const assets = platformAssets();
  win = new BrowserWindow({
    title: 'Iris Unite', width: 1380, height: 920, minWidth: 940, minHeight: 660,
    ...platform.windowOptions(),
    backgroundColor: '#ffffff', ...(assets.icon ? { icon: assets.icon } : {}), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, offscreen: frontendTest, backgroundThrottling: !frontendTest }
  });
  if (platform.needsApplicationMenu()) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  } else {
    win.removeMenu();
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { win = null; });
  await win.loadFile(path.join(__dirname, 'renderer/index.html'));
  /* 加载期间用户可能已经关掉窗口：此时 win 已被 closed 处理器置空，不能再 show。 */
  if (win && !win.isDestroyed() && !smoke && !frontendTest) win.show();
  return win;
}
/* macOS 的惯例是关窗不退出程序；点 Dock 图标再开一个窗口。其他平台关窗即退出。 */
app.on('window-all-closed', () => { if (platform.quitOnWindowClose()) app.quit(); });
app.on('activate', () => { if (!win && store) createWindow().catch(error => console.error(error)); });
app.on('before-quit', () => {
  for (const r of running.values()) { clearTimeout(r.timer); r.controller.abort(); }
  try { store?.save(); } catch { /* Existing on-disk record remains available. */ }
  worker?.terminate();
});
