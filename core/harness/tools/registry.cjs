/* 工具注册表：模型能做的每一件事都在这里登记，别处不许直接执行副作用。
 *
 * 为什么要有注册表而不是一堆散装函数：
 *   1. 提示词里的工具说明必须与实际可调用的能力一一对应。手写两份必然漂移，
 *      而漂移的后果是模型反复调用一个不存在的工具，直到迭代上限被烧光。
 *   2. 每个工具必须声明权限等级。科研 harness 里"读"和"跑任意代码"是两回事，
 *      权限写在注册处，才能在装配工具箱时按场景裁剪。
 *   3. 参数校验集中在一处。模型给错参数时，返回一句可读的纠正比抛异常有用。
 *
 * 约定：invoke 永不抛错，一律返回 { ok, ... }。模型需要看见失败原因才能自救；
 * 抛异常只会让整个循环结束，而一次参数写错不该让一轮科研报废。
 */

const PERMISSIONS = ['read', 'write', 'execute', 'network'];

class ToolError extends Error {
  constructor(message, { code = 'invalid', hint = '' } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/* 轻量参数校验：只支持实际会用到的 JSON Schema 子集。
   完整 JSON Schema 实现会把这一层变成另一个项目，而这里需要的只是"把明显写错的参数挡在**
   副作用发生之前**"。 */
function checkValue(name, spec, value, pathName) {
  const where = pathName || name;
  if (spec == null) return null;
  if (spec.type) {
    const type = spec.type;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const matches = type === 'integer'
      ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === 'array' ? Array.isArray(value)
      : type === 'object' ? (value && typeof value === 'object' && !Array.isArray(value))
      : actual === type;
    if (!matches) return `${where} 应为 ${type}，实际是 ${actual}`;
  }
  if (spec.enum && !spec.enum.includes(value)) return `${where} 只能是 ${spec.enum.join(' / ')}，实际是 ${JSON.stringify(value)}`;
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) return `${where} 不能小于 ${spec.minimum}`;
    if (typeof spec.maximum === 'number' && value > spec.maximum) return `${where} 不能大于 ${spec.maximum}`;
  }
  if (typeof value === 'string' && typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
    return `${where} 超过 ${spec.maxLength} 字（实际 ${value.length}）`;
  }
  return null;
}

function validateArgs(schema, args) {
  const problems = [];
  if (!schema || !schema.properties) return problems;
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const key of schema.required || []) {
    if (value[key] === undefined || value[key] === null || value[key] === '') problems.push(`缺少必填参数 ${key}`);
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (value[key] === undefined) continue;
    const problem = checkValue(key, spec, value[key]);
    if (problem) problems.push(problem);
  }
  const known = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(value)) {
    if (!known.has(key) && schema.additionalProperties === false) problems.push(`不认识的参数 ${key}`);
  }
  return problems;
}

/** 把工具 schema 渲染成提示词里的一段说明。模型据此决定调什么、怎么填参数。 */
function describeTools(specs) {
  if (!specs.length) return '';
  return specs.map(spec => {
    const params = Object.entries(spec.params?.properties || {}).map(([key, value]) => {
      const required = (spec.params?.required || []).includes(key);
      const shape = value.type || 'any';
      const extra = [
        value.enum ? `可选：${value.enum.join('|')}` : '',
        typeof value.maximum === 'number' ? `≤${value.maximum}` : '',
        typeof value.maximum === 'number' || typeof value.minimum === 'number' ? '' : '',
        value.description || ''
      ].filter(Boolean).join('，');
      return `    - ${key} (${shape}${required ? '，必填' : '，可选'})${extra ? '：' + extra : ''}`;
    }).join('\n');
    return `- ${spec.name}（${spec.permission}）：${spec.summary}${params ? '\n' + params : ''}`;
  }).join('\n');
}

function createRegistry() {
  const tools = new Map();

  function define(spec) {
    if (!spec || !spec.name) throw new Error('工具必须有 name');
    if (typeof spec.execute !== 'function') throw new Error(`工具 ${spec.name} 必须有 execute`);
    if (tools.has(spec.name)) throw new Error(`工具重名：${spec.name}`);
    const permission = spec.permission || 'read';
    if (!PERMISSIONS.includes(permission)) throw new Error(`工具 ${spec.name} 的权限必须是 ${PERMISSIONS.join('/')}`);
    tools.set(spec.name, {
      name: spec.name,
      summary: spec.summary || '',
      params: spec.params || { type: 'object', properties: {} },
      permission,
      /* 并行安全性由注册处声明，不由调用处猜。
         默认 true：现有工具要么只读工作区、要么写入即产生新的不可变产物，同批并发不会互相踩。
         显式写 false 的工具（起子进程、吃 GPU、抢占同一份可变状态）执行时会被单独放进屏障里跑。
         这是执行语义，不是给模型看的说明，所以 specs() 不暴露它。 */
      parallelSafe: spec.parallelSafe !== false,
      /* 要不要人点头，也由注册处声明。
         默认 false：绝大多数工具只读或只写本地产物，中途弹窗只会训练用户无脑点"允许"。
         显式写 true 的工具（花真钱、占真机器、跑不可回滚的东西）执行前必须先拿到允许，
         没有确认通道就当作拒绝——见 loop.cjs。同样是执行语义，specs() 也不暴露：
         模型不需要知道"会不会弹窗"，知道自己没被允许就够了。 */
      requiresConfirmation: spec.requiresConfirmation === true,
      execute: spec.execute
    });
    return spec.name;
  }

  function has(name) {
    return tools.has(name);
  }

  function get(name) {
    return tools.get(name) || null;
  }

  function specs({ allow } = {}) {
    const all = [...tools.values()];
    const visible = allow ? all.filter(spec => allow.includes(spec.name)) : all;
    /* parallelSafe 与 requiresConfirmation 都是执行语义，剔除后不再出现在提示词里：
       模型不需要知道调度细节与弹窗细节，它一旦看见这些字段，就会开始为"怎么并行"、
       "能不能绕过确认"写理由，那是调度器与确认闸的事。 */
    return visible.map(({ execute, parallelSafe, requiresConfirmation, ...rest }) => rest);
  }

  /**
   * 执行一个工具。
   * ctx 由调用方注入（工作区、信号、账本），工具本身不持有状态。
   */
  async function invoke(name, args, ctx = {}) {
    const spec = tools.get(name);
    if (!spec) {
      return {
        ok: false,
        error: `没有名为 ${name} 的工具`,
        hint: `可用工具：${[...tools.keys()].join('、')}`
      };
    }
    const problems = validateArgs(spec.params, args);
    if (problems.length) {
      return { ok: false, error: `参数不合法：${problems.join('；')}`, hint: '修正参数后重新调用同一个工具。' };
    }
    try {
      const value = await spec.execute(args || {}, ctx);
      return value && typeof value === 'object' && 'ok' in value ? value : { ok: true, result: value };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, error: error.message, hint: error.hint, code: error.code };
      return { ok: false, error: String(error && error.message ? error.message : error), hint: '换个思路，或换一个工具重试。' };
    }
  }

  return { define, has, get, specs, invoke };
}

module.exports = { createRegistry, describeTools, validateArgs, ToolError, PERMISSIONS };
