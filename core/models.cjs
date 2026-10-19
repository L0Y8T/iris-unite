const fs = require('node:fs');
const path = require('node:path');
const { CODEX_HOME } = require('./history.cjs');
const { connectionEfforts } = require('./connections.cjs');
const EFFORTS = {
  default: ['默认', '使用服务端默认推理设置'],
  off: ['快速', '关闭深度思考，直接回答'], none: ['无', '直接回答'], minimal: ['最低', '最少推理'],
  low: ['轻量', '更快响应，适合简单任务'], medium: ['中等', '平衡响应速度与思考深度'], high: ['高', '更深入思考复杂问题'],
  xhigh: ['超高', '处理更复杂的规划与分析'], max: ['最高', '投入更多时间进行推理'], ultra: ['Ultra', '最高强度，可自动调用子代理']
};
const displayName = name => String(name).replace(/^gpt-/i, 'GPT-').replace(/-(Sol|Astra|Luna|Codex)(?=-|$)/ig, (_, word) => ' ' + word[0].toUpperCase() + word.slice(1).toLowerCase());
function modelCatalog(home = CODEX_HOME, connections = []) {
  let cache = {}, config = '';
  try { cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')); } catch { /* optional */ }
  try { config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* optional */ }
  const configured = /^model\s*=\s*"([^"\r\n]+)"/m.exec(config)?.[1];
  const configuredEffort = /^model_reasoning_effort\s*=\s*"([^"\r\n]+)"/m.exec(config)?.[1];
  const gpt = (cache.models || []).filter(m => !m.hidden && m.visibility !== 'hide').map(m => ({ id: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map(l => l.effort).filter(e => EFFORTS[e]), defaultEffort: m.default_reasoning_level || 'medium' })).filter(m => m.id);
  if (!gpt.length) gpt.push({ id: configured || '', name: configured || 'Codex 默认模型', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
  if (configured && !gpt.some(m => m.id === configured)) gpt.unshift({ id: configured, name: configured, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: configuredEffort || 'medium' });
  for (const m of gpt) m.name = displayName(m.name);
  const defaultModel = gpt.find(m => m.id === configured) || gpt[0];
  const result = { gpt, deepseek: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' }], defaultGptModel: defaultModel.id, defaultGptEffort: defaultModel.efforts.includes(configuredEffort) ? configuredEffort : defaultModel.defaultEffort, labels: EFFORTS, providers: ['deepseek','gpt'], providerNames: { deepseek: 'DeepSeek', gpt: 'GPT · Codex' } };
  for (const c of connections.filter(c => c.enabled)) { result.providers.push(c.id); result.providerNames[c.id] = c.name; result[c.id] = [{ id: c.model, name: c.name, efforts: connectionEfforts(c), defaultEffort: 'default' }]; }
  return result;
}
function defaults(settings, catalog) {
  const gptModel = settings.gptModel || catalog.defaultGptModel;
  const gpt = catalog.gpt.find(m => m.id === gptModel);
  const result = { deepseek: { model: settings.deepseekModel || 'deepseek-flash', effort: settings.deepseekEffort || 'high' }, gpt: { model: gptModel, effort: settings.gptEffort || gpt?.defaultEffort || catalog.defaultGptEffort } };
  for (const p of (catalog.providers || []).filter(p => !['gpt','deepseek'].includes(p))) result[p] = { model: catalog[p][0].id, effort: 'default' };
  return result;
}
function validateModelConfig(config, catalog) {
  const result = {};
  for (const provider of catalog.providers || ['deepseek', 'gpt']) {
    const choice = config?.[provider];
    if (!choice && !['gpt', 'deepseek'].includes(provider)) { result[provider] = { model: catalog[provider][0].id, effort: 'default' }; continue; }
    // 连接表单允许 150 字符的模型 ID，这里必须一致，否则会出现「存得进连接、选不上模型」。
    if (!choice || typeof choice.model !== 'string' || choice.model.length > 150 || /[\r\n\0]/.test(choice.model)) throw new Error('无效的模型配置');
    const model = catalog[provider].find(m => m.id === choice.model);
    if (!model && !['gpt','deepseek'].includes(provider)) throw new Error('所选模型 ID 与连接配置不一致，请重新选择');
    // Custom model names are supported; only known safe effort values may be passed.
    const supported = model?.efforts || (provider === 'deepseek' ? ['off', 'low', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh']);
    if (!supported.includes(choice.effort)) throw new Error('此模型不支持所选推理强度');
    result[provider] = { model: choice.model.trim(), effort: choice.effort };
  }
  return result;
}
module.exports = { modelCatalog, defaults, validateModelConfig };
