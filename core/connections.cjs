const { randomUUID } = require('node:crypto');
const presets = require('./presets.cjs');
const isCustomProvider = id => typeof id === 'string' && /^model_[a-f0-9-]{36}$/.test(id);

/** 只允许 HTTPS；本机回环允许 HTTP。地址里不许夹带账号、密钥、查询串或锚点。 */
function endpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请输入有效的 API 地址'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API 地址须使用 HTTPS，本机服务可使用 HTTP；请勿在地址中放入密钥');
  return url.href.replace(/\/+$/, '');
}

function validateConnection(input, previous, encrypt) {
  if (!input || typeof input !== 'object') throw new Error('无效的模型连接');
  const name = String(input.name || '').trim();
  const model = String(input.model || '').trim();
  // 模型 ID 上限与模型配置校验保持同一个数字（150），否则会出现「存得进连接、选不上模型」。
  if (!name || name.length > 60 || !model || model.length > 150 || /[\r\n\0]/.test(model)) throw new Error('请填写显示名称和有效的模型 ID（最多 150 字符）');
  const protocol = input.protocol === 'anthropic' ? 'anthropic' : input.protocol === 'openai' ? 'openai' : null;
  if (!protocol) throw new Error('请选择受支持的接口格式');
  const effortMode = ['none', 'openai', 'anthropic'].includes(input.effortMode) ? input.effortMode : 'none';
  if (effortMode !== 'none' && effortMode !== protocol) throw new Error('推理参数与接口格式不匹配');
  const maxTokens = Number(input.maxTokens || 8192);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 65536) throw new Error('输出 token 上限须在 256–65536 之间');
  const presetId = typeof input.preset === 'string' && presets.preset(input.preset) ? input.preset : null;
  const next = {
    id: previous?.id || 'model_' + randomUUID(),
    name, model, protocol,
    baseUrl: endpoint(input.baseUrl),
    effortMode,
    enabled: input.enabled !== false,
    allowNoKey: input.allowNoKey === true,
    maxTokens,
    preset: presetId
  };
  if (previous?.encryptedKey) next.encryptedKey = previous.encryptedKey;
  if (input.clearKey) delete next.encryptedKey;
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    if (input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new Error('无效的 API Key');
    next.encryptedKey = encrypt(input.apiKey.trim());
  }
  // 密钥只对录入时的那个端点有效：换了地址又没给新密钥，就清掉旧密钥。
  if (previous && previous.baseUrl !== next.baseUrl && !input.apiKey?.trim()) delete next.encryptedKey;
  return next;
}

function publicConnection(c) {
  const { encryptedKey, ...safe } = c;
  return { ...safe, hasKey: !!encryptedKey };
}

/** 推理档位由用户显式声明的参数形态决定，不自动探测服务端能力。 */
function connectionEfforts(c) {
  return c.effortMode === 'none' ? ['default'] : c.effortMode === 'anthropic' ? ['default', 'low', 'medium', 'high', 'xhigh', 'max'] : ['default', 'low', 'medium', 'high', 'xhigh'];
}

function requestURL(c) {
  const suffix = c.protocol === 'anthropic' ? '/messages' : '/chat/completions';
  return c.baseUrl.endsWith(suffix) ? c.baseUrl : c.baseUrl + suffix;
}

/** 拉取模型列表用的地址：两种协议都提供 /models。 */
function modelsURL(c) {
  const base = String(c.baseUrl || '').replace(/\/(chat\/completions|messages)$/, '').replace(/\/+$/, '');
  return base + '/models';
}

/** 鉴权头：Claude 用 x-api-key，其余用 Bearer；本地无密钥服务不带鉴权。 */
function authHeaders(c, key) {
  if (c.protocol === 'anthropic') return { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * 解析服务端返回的模型列表。不同实现差异很大，这里只做宽容提取：
 * OpenAI 风格是 { data: [{ id }] }，Anthropic 是 { data: [{ id }] }，也有直接给数组的。
 * 拿不到就返回空数组，由界面提示手填。
 */
function parseModelList(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = list
    .map(item => (typeof item === 'string' ? item : item?.id || item?.name || item?.model))
    .filter(id => typeof id === 'string' && id.trim() && id.length <= 150)
    .map(id => id.trim());
  return [...new Set(ids)].sort();
}

module.exports = { isCustomProvider, endpoint, validateConnection, publicConnection, connectionEfforts, requestURL, modelsURL, authHeaders, parseModelList };
