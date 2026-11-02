/* 运行工作区：一次 run 的全部产物落在一个目录里，模型按需读取。
 *
 * 为什么需要它（这是整个 harness 改造的地基）：
 * 现在的上下文传递是"把上一阶段的全部产物 JSON.stringify 塞进 prompt"——
 * 普通协作在 core/collaboration.cjs 第 41 行，科研在 core/research.cjs 第 506 行。
 * 后果有两个，都可测：
 *   1. token 随阶段数与模型数平方增长，且历史 24 万字符才是真正的大头；
 *   2. 产物只活在这一轮内存里，artifacts[] 存的是全文，随 conversations.json 一起膨胀
 *      （store.cjs 是单个大 JSON，每次保存整份重写）。
 *
 * 工作区把产物变成文件，于是三件事同时成立：
 *   - 上下文可以只放摘要 + 句柄，模型需要细节时按需读取；
 *   - 崩溃后产物还在盘上，可以续跑、可以事后审计；
 *   - 产物有了 sha256 与不可变性，成为可引用的证据。
 *
 * 目录结构：
 *   <root>/runs/<runId>/
 *     run.json           元数据（状态、阶段、参与者、预算）
 *     ledger.jsonl       账本（见 ledger.cjs）
 *     index.json         产物索引，id → 元数据
 *     artifacts/<stage>/<artifactId>.md
 *
 * 两条硬规则：
 *   - 产物一旦写入不可变：要改就写新产物，用 refs 指向旧的。可审计的前提。
 *   - 摘要只在落盘时算一次，装配时直接用；重算会让同一产物在不同阶段摘要不同。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { newArtifactId, isArtifactId, safeSegment } = require('./ids.cjs');
const { openLedger } = require('./ledger.cjs');

const RUN_FILE = 'run.json';
const INDEX_FILE = 'index.json';
const LEDGER_FILE = 'ledger.jsonl';
const ARTIFACTS_DIR = 'artifacts';
const INDEX_VERSION = 1;

/** 产物全文的 sha256。读取时可重算比对，用来发现"盘上被改过"。 */
function sha256(text) {
  return createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function writeJsonAtomic(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

/** 压缩空白但不破坏行结构：装配进 prompt 时行仍然可读。 */
function tidy(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * 给产物做"可装配摘要"：标题 + 头部正文 + 结构信号。
 *
 * 为什么不用模型摘要：这里每写一个产物就要一份摘要，调模型会让成本翻倍且引入不确定性；
 * 而装配时真正需要的是"这段东西讲什么、有多长、里面有哪些可引用的编号"。
 * 结构信号（小节标题、实验编号、JSON 顶层键）交给模型做链式召回的判断依据。
 */
function summarize(text, maxChars = 600) {
  const body = tidy(text);
  if (!body) return { title: '(空)', summary: '(空)', signals: [] };

  const lines = body.split('\n');
  const heading = lines.find(line => /^#{1,3}\s+\S/.test(line));
  const firstText = lines.find(line => line.trim() && !/^```/.test(line.trim()));
  const title = (heading ? heading.replace(/^#{1,3}\s+/, '') : (firstText || '')).trim().slice(0, 80) || '(无标题)';

  // 信号：小节标题最多 6 个、实验编号、疑似 JSON 的顶层键。
  const sections = lines
    .filter(line => /^#{1,4}\s+\S/.test(line))
    .map(line => line.replace(/^#{1,4}\s+/, '').trim())
    .filter(name => name && name !== title)
    .slice(0, 6);
  const experimentIds = [...new Set((body.match(/\[E\d+(?:\s*,\s*E\d+)*\]/g) || []).map(mark => mark.replace(/[[\]]/g, '')))].slice(0, 12);
  let keys = [];
  const maybeJson = body.trim();
  if (maybeJson.startsWith('{') && maybeJson.endsWith('}')) {
    try {
      const parsed = JSON.parse(maybeJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) keys = Object.keys(parsed).slice(0, 12);
    } catch { keys = []; }
  }

  const printable = body.length > maxChars ? body.slice(0, maxChars) + '…' : body;
  return {
    title,
    summary: printable,
    signals: [
      ...(sections.length ? [{ kind: 'sections', values: sections }] : []),
      ...(experimentIds.length ? [{ kind: 'experiments', values: experimentIds }] : []),
      ...(keys.length ? [{ kind: 'keys', values: keys }] : [])
    ]
  };
}

class RunWorkspace {
  constructor({ root, runId, meta = {}, ledger = true }) {
    if (!root) throw new Error('工作区需要 root');
    if (!runId) throw new Error('工作区需要 runId');
    this.root = path.resolve(root);
    this.runId = runId;
    this.dir = path.join(this.root, 'runs', runId);
    this.artifactsDir = path.join(this.dir, ARTIFACTS_DIR);
    this.indexFile = path.join(this.dir, INDEX_FILE);
    this.runFile = path.join(this.dir, RUN_FILE);
    this.ledgerFile = path.join(this.dir, LEDGER_FILE);
    this.useLedger = ledger;
    this.ledger = null;
    this.index = null;
    this.meta = null;
    this._initialMeta = meta;
  }

  /** 建目录、落 run.json、开账本。重复调用是安全的（幂等）。 */
  ensure() {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    if (!fs.existsSync(this.runFile)) {
      writeJsonAtomic(this.runFile, {
        version: 1,
        runId: this.runId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        ...this._initialMeta
      });
    }
    this.meta = JSON.parse(fs.readFileSync(this.runFile, 'utf8'));
    if (!fs.existsSync(this.indexFile)) writeJsonAtomic(this.indexFile, { version: INDEX_VERSION, runId: this.runId, artifacts: [] });
    this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    if (!Array.isArray(this.index.artifacts)) this.index.artifacts = [];
    if (this.useLedger && !this.ledger) this.ledger = openLedger(this.ledgerFile);
    return this;
  }

  /** 把元数据合并写回 run.json。阶段推进、状态变化都走这里。 */
  setMeta(patch = {}) {
    this.ensure();
    this.meta = { ...this.meta, ...patch, updatedAt: Date.now() };
    writeJsonAtomic(this.runFile, this.meta);
    return this.meta;
  }

  getMeta() {
    if (!this.meta) this.ensure();
    return { ...this.meta };
  }

  appendLedger(type, fields) {
    if (!this.useLedger) return null;
    if (!this.ledger) this.ensure();
    return this.ledger.append(type, { runId: this.runId, ...fields });
  }

  /**
   * 写一个产物。
   * 入参：{ stage, provider, title, kind, text, refs, meta }
   *   kind: note（中间材料，默认）| final（可交付正文）| data（结构化结果）| log（原始输出）
   *   refs: 本产物引用到的其它 artifactId，供链式召回
   * 返回落盘后的完整 record（已含 sha256、摘要与相对路径）。
   */
  writeArtifact(input = {}) {
    this.ensure();
    const text = String(input.text == null ? '' : input.text);
    const stage = safeSegment(input.stage || 'misc');
    const id = input.id && isArtifactId(input.id) ? input.id : newArtifactId();
    if (this.index.artifacts.some(record => record.id === id)) throw new Error(`产物 id 已存在：${id}`);
    const summary = summarize(text, input.summaryChars || 600);
    const record = {
      id,
      runId: this.runId,
      stage,
      provider: input.provider || null,
      title: String(input.title || summary.title).slice(0, 120),
      kind: input.kind || 'note',
      /* 相对 run 目录的路径：换机器、换数据根之后仍然可解析，不存绝对路径。 */
      file: `${ARTIFACTS_DIR}/${stage}/${id}.md`,
      chars: text.length,
      sha256: sha256(text),
      summary: summary.summary,
      signals: summary.signals,
      refs: Array.isArray(input.refs) ? input.refs.filter(isArtifactId) : [],
      createdAt: Date.now(),
      meta: input.meta && typeof input.meta === 'object' ? input.meta : {}
    };
    const absolute = path.join(this.dir, record.file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, 'utf8');
    this.index.artifacts.push(record);
    writeJsonAtomic(this.indexFile, this.index);
    this.appendLedger('artifact.write', { artifactId: id, stage, kind: record.kind, chars: record.chars, sha256: record.sha256 });
    return { ...record };
  }

  /** 产物元数据；不存在返回 null（读取路径常用容错，不抛错）。 */
  getArtifact(id) {
    this.ensure();
    const record = this.index.artifacts.find(item => item.id === id);
    return record ? { ...record } : null;
  }

  /**
   * 按需读取产物正文。
   * offset / limit 都以字符计：模型读到头部之后，从 offset 接着读，就是 Inline & Spill 的续读。
   * next 为 null 表示已到结尾，否则是下一次应传的 offset。
   */
  readArtifact(id, { offset = 0, limit = 0 } = {}) {
    const record = this.getArtifact(id);
    if (!record) throw new Error(`找不到产物：${id}`);
    const absolute = path.join(this.dir, record.file);
    if (!fs.existsSync(absolute)) throw new Error(`产物文件已丢失：${record.file}`);
    const full = fs.readFileSync(absolute, 'utf8');
    const start = Math.max(0, Math.min(Number(offset) || 0, full.length));
    const take = Number(limit) > 0 ? Number(limit) : full.length - start;
    const end = Math.min(full.length, start + take);
    return {
      record: { ...record },
      text: full.slice(start, end),
      offset: start,
      end,
      total: full.length,
      next: end < full.length ? end : null
    };
  }

  /** 列出产物；可按 stage / kind 过滤，默认按写入顺序。 */
  listArtifacts({ stage, kind, limit = 0 } = {}) {
    this.ensure();
    let items = this.index.artifacts;
    if (stage) items = items.filter(item => item.stage === stage);
    if (kind) items = items.filter(item => item.kind === kind);
    if (limit > 0) items = items.slice(-limit);
    return items.map(item => ({ ...item }));
  }

  /**
   * 完整性自检：逐条重算 sha256 与盘上文件比对。
   * 现有 exec/manifest.cjs 的 validateManifest 只检查 sha256 字段非空、从不重算
   * （manifest.cjs:80），等于证据链有一环没闭合；这里把它补上。
   */
  verifyArtifacts() {
    this.ensure();
    const problems = [];
    for (const record of this.index.artifacts) {
      const absolute = path.join(this.dir, record.file);
      if (!fs.existsSync(absolute)) { problems.push(`${record.id} 文件缺失`); continue; }
      const actual = sha256(fs.readFileSync(absolute, 'utf8'));
      if (actual !== record.sha256) problems.push(`${record.id} 内容被改动（记录 ${record.sha256.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
    }
    return { ok: problems.length === 0, checked: this.index.artifacts.length, problems };
  }

  close() {
    if (this.ledger) this.ledger.close();
    this.ledger = null;
  }
}

/** 打开（或新建）一个 run 工作区。 */
function openWorkspace({ root, runId, meta, ledger = true }) {
  return new RunWorkspace({ root, runId, meta, ledger }).ensure();
}

/** 列出数据根下所有 run，按创建时间从旧到新。崩溃恢复与面板都用它。 */
function listRuns({ root }) {
  const dir = path.join(path.resolve(root), 'runs');
  if (!fs.existsSync(dir)) return [];
  const runs = [];
  for (const name of fs.readdirSync(dir)) {
    const runFile = path.join(dir, name, RUN_FILE);
    if (!fs.existsSync(runFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      runs.push({ runId: name, dir: path.join(dir, name), ...meta });
    } catch {
      runs.push({ runId: name, dir: path.join(dir, name), status: 'unreadable' });
    }
  }
  return runs.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

/**
 * 只保留最近 keep 个 run 目录。
 *
 * 为什么需要它：每发一轮消息就会新建一个 run 目录。不管的话，跑几百轮之后
 * 数据根里会堆几千份产物文件——用户既不会去删，也不该被迫去删。
 * 保留策略按创建时间（runId 里的时间戳）先进先出，正在运行的那个永远在最后，不会被删。
 */
function pruneRuns({ root, keep = 50 }) {
  const runs = listRuns({ root });
  if (runs.length <= keep) return { removed: [], kept: runs.length };
  const removed = [];
  for (const run of runs.slice(0, runs.length - Math.max(1, keep))) {
    /* 还在跑的 run 不能删：它的账本与产物正在被写。 */
    if (run.status === 'running') continue;
    try {
      fs.rmSync(run.dir, { recursive: true, force: true });
      removed.push(run.runId);
    } catch { /* 删不掉就留着，清理失败不该影响任何功能 */ }
  }
  return { removed, kept: runs.length - removed.length };
}

module.exports = {
  RunWorkspace, openWorkspace, listRuns, pruneRuns,
  summarize, sha256, tidy,
  RUN_FILE, INDEX_FILE, LEDGER_FILE, ARTIFACTS_DIR
};
