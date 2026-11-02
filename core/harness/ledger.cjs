/* 运行账本：只追加的 JSONL，一行一个事实。
 *
 * 为什么是 JSONL 而不是一个 JSON 大数组：账本要在崩溃之后还能读到崩溃前最后一毫秒
 * 发生了什么。大数组必须整份重写，进程被杀就丢掉全部；追加写最多丢半行，且能按行
 * 截断修复。这个区别在"长跑几十分钟的实验 + 随时可能被看门狗杀掉"的场景里是决定性的。
 *
 * 为什么落文件而不是留内存：现有预算账本 core/budget.cjs 是纯内存、无 IO（该文件第 9 行
 * 自述），进程一死就失忆；而 docs/research-mode-design.md 要求把派发账本持久化后再调用
 * 适配器。harness 这一层补的就是这条持久化，且顺带把每次调用的输入字符数、工具调用、
 * 产物写入都记进来，使一轮运行可以事后完整回放。
 *
 * 行格式：
 *   {"seq":1,"at":1762000000000,"type":"run.start","...":...}
 * seq 单调递增且从 1 开始：回放按 seq 排序，不依赖文件系统时间精度。
 * verify() 用它检查账本有没有被截断或篡改。
 */
const fs = require('node:fs');
const path = require('node:path');

const FLUSH_BYTES = 64 * 1024;

class Ledger {
  constructor(file) {
    this.file = file;
    this.seq = 0;
    this.pending = 0;
    this.fd = null;
    this.closed = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 已有账本时接着它的 seq 往下写，绝不复用编号——复用会让两道 run 的记录混成一条序列。
    if (fs.existsSync(file)) {
      const existing = this.read();
      this.seq = existing.entries.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0);
    }
  }

  /** 追加一条事实。返回写入的记录（含 seq 与 at），调用方可直接回显给界面。 */
  append(type, fields = {}) {
    if (this.closed) throw new Error('账本已关闭');
    if (!type || typeof type !== 'string') throw new Error('账本记录必须有 type');
    const entry = { seq: ++this.seq, at: Date.now(), type, ...fields };
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.file, line, { encoding: 'utf8' });
    this.pending += line.length;
    if (this.pending >= FLUSH_BYTES) this.flush();
    return entry;
  }

  /** 强制落盘。Node 的 appendFileSync 已经是同步写，这里只是重置计数器，保留显式语义。 */
  flush() {
    this.pending = 0;
  }

  /**
   * 读回全部记录。
   * 容错优先：坏行不抛错，记进 corrupt 数组并继续——账本的价值在于"能读到崩溃前的部分"，
   * 一行写坏不该让整轮记录作废。
   */
  read() {
    if (!fs.existsSync(this.file)) return { entries: [], corrupt: [] };
    const raw = fs.readFileSync(this.file, 'utf8');
    const entries = [];
    const corrupt = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && value.type) entries.push(value);
        else corrupt.push(text.slice(0, 200));
      } catch {
        corrupt.push(text.slice(0, 200));
      }
    }
    entries.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    return { entries, corrupt };
  }

  /** 最近 n 条记录，新的在后。用于摘要与界面上的"刚刚发生了什么"。 */
  tail(n = 20) {
    const { entries } = this.read();
    return entries.slice(Math.max(0, entries.length - Math.max(1, n)));
  }

  /** 按类型筛选。 */
  where(type) {
    return this.read().entries.filter(entry => entry.type === type);
  }

  /**
   * 账本自检：seq 必须从 1 连续递增，且至少有一条 run.start。
   * 不连续说明被判为损坏——可能是两道 run 写进同一个文件，也可能有人手工改过。
   */
  verify() {
    const { entries, corrupt } = this.read();
    const problems = [];
    if (corrupt.length) problems.push(`有 ${corrupt.length} 行无法解析`);
    const expected = entries.length;
    if (expected && Number(entries[0].seq) !== 1) problems.push(`首条 seq 是 ${entries[0].seq}，应为 1`);
    for (let i = 1; i < entries.length; i += 1) {
      if (Number(entries[i].seq) !== Number(entries[i - 1].seq) + 1) {
        problems.push(`第 ${i + 1} 条 seq 断开：${entries[i - 1].seq} → ${entries[i].seq}`);
        break;
      }
    }
    if (entries.length && !entries.some(entry => entry.type === 'run.start')) problems.push('缺少 run.start');
    return { ok: problems.length === 0, entries: expected, corrupt: corrupt.length, problems };
  }

  /** 关闭账本。之后 append 会抛错，避免"看着在记、其实没记"。 */
  close() {
    this.flush();
    this.closed = true;
  }
}

function openLedger(file) {
  return new Ledger(file);
}

module.exports = { Ledger, openLedger, FLUSH_BYTES };
