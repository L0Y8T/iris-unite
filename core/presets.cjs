/* 主流 AI 服务商预设。
 *
 * 目的：用户不该需要背 baseUrl。选一个服务商，地址、接口格式、推理参数形态
 * 自动填好，只剩「模型 ID」和「API Key」要填；模型 ID 也可以点按钮从服务端拉取。
 *
 * 关于准确性的边界：下面这些地址是各服务商公开文档里的 OpenAI 兼容入口。
 * 服务商可能改路径或改模型 ID，所以界面上始终允许手改，并明确提示
 * 「地址与模型 ID 以服务商文档为准」。不要把这些预设当成能力探测——
 * 能不能用某个模型，最终由服务端返回决定。
 */

const PRESETS = [
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', effortMode: 'openai',
    modelHint: 'gpt-5.1', note: '官方 OpenAI 接口；推理强度按 reasoning_effort 传递。'
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic', effortMode: 'anthropic',
    modelHint: 'claude-sonnet-4-5', note: '官方 Messages 接口；需要账户具备对应模型权限。'
  },
  {
    id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', effortMode: 'none',
    modelHint: 'gemini-2.5-pro', note: '走 Gemini 的 OpenAI 兼容入口；推理参数形态由服务端决定，默认不发送。'
  },
  {
    id: 'deepseek-api', name: 'DeepSeek 开放平台', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'deepseek-chat', note: '用于在 DeepSeek 内置通道之外单独配置一把密钥或多模型。'
  },
  {
    id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', effortMode: 'openai',
    modelHint: 'anthropic/claude-sonnet-4.5', note: '一个 Key 聚合大量模型，模型 ID 带供应商前缀。'
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'kimi-k2-0905-preview', note: '月之暗面官方接口。'
  },
  {
    id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', effortMode: 'none',
    modelHint: 'glm-4.6', note: '智谱开放平台。'
  },
  {
    id: 'dashscope', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'qwen3-max', note: 'DashScope 的 OpenAI 兼容模式。'
  },
  {
    id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'deepseek-ai/DeepSeek-V3.2-Exp', note: '国内聚合平台，模型 ID 带组织前缀。'
  },
  {
    id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'llama-3.3-70b-versatile', note: '低延迟推理服务。'
  },
  {
    id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'mistral-large-latest', note: '官方 OpenAI 兼容接口。'
  },
  {
    id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'qwen3:14b', note: '本机推理，通常不需要 API Key；模型 ID 用 ollama list 里的名字。', allowNoKey: true
  },
  {
    id: 'lmstudio', name: 'LM Studio（本机）', baseUrl: 'http://localhost:1234/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'local-model', note: '本机推理服务，通常在设置里开启 OpenAI 兼容服务器。', allowNoKey: true
  },
  {
    id: 'vllm', name: 'vLLM / 自建服务（本机）', baseUrl: 'http://localhost:8000/v1', protocol: 'openai', effortMode: 'none',
    modelHint: 'your-model-name', note: '自建 OpenAI 兼容服务，允许 HTTP 回环地址。', allowNoKey: true
  },
  {
    id: 'custom', name: '自定义（OpenAI 兼容或 Claude 格式）', baseUrl: '', protocol: 'openai', effortMode: 'none',
    modelHint: '', note: '任何遵循 OpenAI Chat Completions 或 Anthropic Messages 的服务。'
  }
];

const byId = new Map(PRESETS.map(p => [p.id, p]));

/** 根据预设补全表单字段；未知 id 返回 null（界面按自定义处理）。 */
function preset(id) {
  const found = byId.get(String(id || ''));
  if (!found) return null;
  return { ...found };
}

/** 预设清单，供界面渲染下拉框；不含内部提示字段以外的敏感信息。 */
function list() {
  return PRESETS.map(({ id, name, baseUrl, protocol, effortMode, modelHint, note, allowNoKey }) => ({
    id, name, baseUrl, protocol, effortMode, modelHint, note, allowNoKey: allowNoKey === true
  }));
}

/** 判断一个连接是否来自某个预设（地址与协议都对得上才算）。 */
function detect(connection) {
  if (!connection) return null;
  const url = String(connection.baseUrl || '').replace(/\/+$/, '').toLowerCase();
  const found = PRESETS.find(p => p.baseUrl && p.baseUrl.replace(/\/+$/, '').toLowerCase() === url && p.protocol === connection.protocol);
  return found ? found.id : null;
}

module.exports = { PRESETS, preset, list, detect };
