/* 受控实验模板表：这一版"能执行什么"全部写在这里，模型只能填参数，不能改代码。
 *
 * 为什么这样限：本机没有任何隔离层（Windows 家庭版、无 WSL、无容器），
 * 让模型写自由 Python 直接跑，等于让它以用户权限操作整台机器。
 * 所以第一批只开放审核过的固定脚本 + 白名单参数；driver 接口留好，
 * 之后接 WSL2 容器时再加自由代码模板。
 *
 * 纯数据 + 纯函数：不读文件、不起进程、不发网络。
 */
const path = require('node:path');

const SCRIPT_DIR = path.join(__dirname, 'scripts');

/** 参数类型只有四种：后端据此校验、前端据此渲染控件。 */
const PARAM_TYPES = Object.freeze(['enum', 'number', 'integer', 'boolean', 'string']);

const TEMPLATES = Object.freeze([
  {
    id: 'env-smoke',
    version: 1,
    name: '执行环境自检',
    description: '只依赖 numpy，几秒内完成一次确定性矩阵运算并落盘指标。用来确认执行链路（隔离环境 → 进程 → 产物 → 运行记录）是通的，也能验证超时与取消。',
    script: 'env-smoke.py',
    driver: 'template-python',
    requires: { packages: ['numpy>=2.0'], gpu: false },
    params: [
      { id: 'dim', type: 'integer', min: 16, max: 2048, default: 256, label: '矩阵维度' },
      { id: 'seed', type: 'integer', min: 0, max: 4294967295, default: 42, label: '随机种子' },
      { id: 'sleepSec', type: 'number', min: 0, max: 600, step: 0.5, default: 0, label: '等待秒数（测超时用）' }
    ],
    artifacts: ['metrics.json', 'summary.txt'],
    metrics: ['run.seconds', 'run.matrix_trace', 'run.checksum', 'env.numpy'],
    timeoutSec: { default: 120, min: 5, max: 600 }
  },
  {
    id: 'tabular-baseline',
    version: 1,
    name: '表格分类基线',
    description: '在 sklearn 自带的小数据集上训练线性 / 森林 / 小 MLP，产出真实准确率、macro-F1 与混淆矩阵图。不需要 GPU，不下载外部数据。',
    script: 'tabular-baseline.py',
    driver: 'template-python',
    requires: { packages: ['numpy>=2.0', 'scikit-learn>=1.5', 'matplotlib>=3.8'], gpu: false },
    params: [
      { id: 'dataset', type: 'enum', values: ['digits', 'wine', 'breast_cancer', 'iris'], default: 'digits', label: '数据集' },
      { id: 'model', type: 'enum', values: ['logreg', 'random_forest', 'mlp'], default: 'logreg', label: '模型' },
      { id: 'testSize', type: 'number', min: 0.1, max: 0.5, step: 0.05, default: 0.2, label: '测试集比例' },
      { id: 'seed', type: 'integer', min: 0, max: 4294967295, default: 42, label: '随机种子' }
    ],
    /* 必须产出的产物；缺一个就判定本次运行不完整，不允许进答案。 */
    artifacts: ['metrics.json', 'confusion-matrix.png'],
    metrics: ['test.accuracy', 'test.macro_f1', 'test.n_samples', 'train.seconds'],
    timeoutSec: { default: 600, min: 30, max: 3600 }
  },
  {
    id: 'digit-cnn',
    version: 1,
    name: '小型 CNN 训练（需 PyTorch）',
    description: '在 MNIST 上训一个小卷积网络，产出准确率、loss 曲线与训练耗时。首次执行需要装 PyTorch（约 200 MB CPU 版），未安装时不会自动下载。',
    script: 'digit-cnn.py',
    driver: 'template-python',
    requires: { packages: ['numpy>=2.0', 'torch>=2.2', 'matplotlib>=3.8'], gpu: 'optional' },
    params: [
      { id: 'epochs', type: 'integer', min: 1, max: 20, default: 2, label: '训练轮数' },
      { id: 'batchSize', type: 'integer', min: 16, max: 512, default: 128, label: '批大小' },
      { id: 'limitTrain', type: 'integer', min: 1000, max: 60000, default: 12000, label: '训练样本上限' },
      { id: 'seed', type: 'integer', min: 0, max: 4294967295, default: 42, label: '随机种子' }
    ],
    artifacts: ['metrics.json', 'loss-curve.png'],
    metrics: ['test.accuracy', 'test.loss', 'train.seconds', 'env.device'],
    timeoutSec: { default: 1200, min: 60, max: 7200 },
    /* 未实现：脚本与依赖下载都不做，模板表里保留位置但不允许启动。 */
    unimplemented: '需要先补齐 PyTorch 依赖安装与 MNIST 下载策略，见 docs/research-mode-design.md §19'
  }
]);

/* 环境按依赖清单指纹复用：同样的依赖必然得到同一个 venv 路径。 */
function envKey(packages) {
  const list = [...new Set(packages.map(p => String(p).trim()).filter(Boolean))].sort();
  return require('node:crypto').createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}

function templateById(id) {
  const found = TEMPLATES.find(t => t.id === id);
  if (!found) throw new Error(`未知的实验模板：${id}`);
  return found;
}

/** 只保留模板声明过的参数，逐个按类型校验，越界一律报错而不是夹值。 */
function validateParams(id, input = {}) {
  const template = templateById(id);
  if (template.unimplemented) throw new Error(`${template.name} 尚未实现：${template.unimplemented}`);
  const source = input && typeof input === 'object' ? input : {};
  const unknown = Object.keys(source).filter(key => !template.params.some(p => p.id === key));
  if (unknown.length) throw new Error(`模板 ${template.id} 不认识参数：${unknown.join('、')}`);
  const out = {};
  for (const spec of template.params) {
    const raw = source[spec.id];
    const value = raw === undefined || raw === null || raw === '' ? spec.default : raw;
    if (spec.type === 'enum') {
      if (!spec.values.includes(value)) throw new Error(`参数 ${spec.label || spec.id} 只能是 ${spec.values.join(' / ')}，收到 ${value}`);
    } else if (spec.type === 'number' || spec.type === 'integer') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`参数 ${spec.label || spec.id} 必须是数字`);
      if (spec.type === 'integer' && !Number.isInteger(number)) throw new Error(`参数 ${spec.label || spec.id} 必须是整数`);
      if (spec.min !== undefined && number < spec.min) throw new Error(`参数 ${spec.label || spec.id} 不能小于 ${spec.min}`);
      if (spec.max !== undefined && number > spec.max) throw new Error(`参数 ${spec.label || spec.id} 不能大于 ${spec.max}`);
      out[spec.id] = number;
      continue;
    } else if (spec.type === 'boolean') {
      out[spec.id] = value === true || value === 'true';
      continue;
    } else if (spec.type === 'string') {
      const text = String(value).trim();
      if (!text) throw new Error(`参数 ${spec.label || spec.id} 不能为空`);
      if (text.length > (spec.maxLength || 200)) throw new Error(`参数 ${spec.label || spec.id} 过长`);
      out[spec.id] = text;
      continue;
    } else {
      throw new Error(`参数类型未支持：${spec.type}`);
    }
    out[spec.id] = value;
  }
  return out;
}

/** 把参数翻译成 CLI 参数。number 用逗号分隔的小数点无关格式，避免区域设置影响。 */
function buildArgs(id, params) {
  const template = templateById(id);
  const validated = validateParams(id, params);
  const args = [];
  for (const spec of template.params) {
    const value = validated[spec.id];
    const cli = '--' + spec.id.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    args.push(cli, String(value));
  }
  return { args, params: validated, script: path.join(SCRIPT_DIR, template.script) };
}

/** 超时夹到模板声明的范围，缺省用模板默认值。 */
function resolveTimeout(id, requestedSec) {
  const template = templateById(id);
  const range = template.timeoutSec || { default: 600, min: 30, max: 3600 };
  const value = Number(requestedSec);
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

module.exports = {
  TEMPLATES,
  PARAM_TYPES,
  SCRIPT_DIR,
  templateById,
  validateParams,
  buildArgs,
  resolveTimeout,
  envKey
};
