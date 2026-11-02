/* 异步 job 调度：长任务在后台跑，前台继续推进。
 *
 * 为什么需要它（两个具体损失）：
 *   1. 实验在 core/research.cjs:608-627 是串行 `for…of await`，一个 trial 跑十分钟，
 *      整条流水线就停十分钟，而且 trial 期间 `run.lastActivityAt` 不更新
 *      （只在 research.cjs:495/518 与 trial 之后 626 更新），于是这个 run 会被自己的
 *      10 分钟看门狗（main.cjs:617-630）判成停滞然后 abort。这是误杀，不是超时。
 *   2. 多个 trial 之间没有并行，也没有"发起后先去做别的"的能力。
 *
 * 这个模块提供三件事：
 *   - start() 立即返回 job 句柄，任务在后台跑；
 *   - 每个 job 有独立 AbortController，stop() 只影响它自己；
 *   - 心跳（idleMs）让外部能区分"模型在思考"与"真的卡住了"，看门狗不再靠猜。
 *
 * 持久化：每个 job 一个目录 <root>/jobs/<jobId>/job.json，状态变化即落盘。
 * 启动时把上次遗留的 running 标成 interrupted——这是"崩溃后不装没事"的最小要求。
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const JOBS_DIR = 'jobs';
const JOB_FILE = 'job.json';
const DEFAULT_LIMITS = {
  /* 同跑上限。实验是 CPU 密集型，2 个已经能吃掉多数笔记本的核。 */
  maxConcurrent: 2,
  /* 排队上限：超出直接拒绝，而不是无限堆着让用户以为已经跑起来了。 */
  queueLimit: 32
};
const STATUS = ['queued', 'running', 'done', 'failed', 'stopped', 'interrupted'];

function newJobId() {
  return `job-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

class JobScheduler {
  constructor({ root, limits = {}, onEvent = () => {}, ledger = null, now = () => Date.now() }) {
    if (!root) throw new Error('调度器需要 root');
    this.root = path.join(path.resolve(root), JOBS_DIR);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.onEvent = onEvent;
    this.ledger = ledger;
    this.now = now;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.closed = false;
    fs.mkdirSync(this.root, { recursive: true });
    this.recover();
  }

  /** 启动时把上次遗留的 running 标为 interrupted。不这样做，界面会永远显示"进行中"。 */
  recover() {
    for (const name of fs.readdirSync(this.root)) {
      const file = path.join(this.root, name, JOB_FILE);
      if (!fs.existsSync(file)) continue;
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { continue; }
      if (snapshot.status !== 'running' && snapshot.status !== 'queued') continue;
      snapshot.status = 'interrupted';
      snapshot.finishedAt = this.now();
      snapshot.error = '应用上次退出时这个任务仍在运行，已标记为中断。';
      this._persist(snapshot);
      this.jobs.set(snapshot.id, { snapshot, controller: null, promise: null, resolve: null, settle: null });
      this._emit({ kind: 'job.interrupted', job: snapshot });
    }
  }

  _dir(id) {
    return path.join(this.root, id);
  }

  _persist(snapshot) {
    const dir = this._dir(snapshot.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, JOB_FILE);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  _emit(event) {
    try { this.onEvent(event); }
    catch { /* 界面侧的回调异常不该影响调度 */ }
  }

  _log(type, fields) {
    if (!this.ledger) return;
    try { this.ledger.append(type, fields); }
    catch { /* 账本写失败不能让任务失败 */ }
  }

  /**
   * 起一个后台任务。
   *   runner({ signal, onEvent, job }) -> Promise<result>
   * 立即返回 job 快照（状态可能是 queued，也可能是 running）。
   */
  start({ kind = 'task', label = '', meta = {}, runner }) {
    if (this.closed) throw new Error('调度器已关闭');
    if (typeof runner !== 'function') throw new Error('任务需要 runner 函数');
    const live = [...this.jobs.values()].filter(entry => entry.snapshot.status === 'running' || entry.snapshot.status === 'queued').length;
    if (live >= this.limits.queueLimit) throw new Error(`排队任务已达上限 ${this.limits.queueLimit}，请等待现有任务完成`);

    const id = newJobId();
    const snapshot = {
      id,
      kind,
      label: String(label || '').slice(0, 120),
      status: 'queued',
      meta,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      lastActivityAt: this.now(),
      error: null,
      result: null
    };
    const controller = new AbortController();
    const entry = { snapshot, controller, promise: null, resolve: null, reject: null, runner };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    /* 队列里的 promise 若不接住会触发 unhandledRejection；调用方用 await() 取真实结果。 */
    entry.promise.catch(() => {});
    this.jobs.set(id, entry);
    this._persist(snapshot);
    this._emit({ kind: 'job.queued', job: { ...snapshot } });
    this._log('job.queued', { jobId: id, jobKind: kind, label: snapshot.label });
    this.queue.push(id);
    this._pump();
    return { ...snapshot };
  }

  _pump() {
    while (this.running < this.limits.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const entry = this.jobs.get(id);
      if (!entry || entry.snapshot.status !== 'queued') continue;
      this._launch(entry);
    }
  }

  _launch(entry) {
    const { snapshot, controller } = entry;
    snapshot.status = 'running';
    snapshot.startedAt = this.now();
    snapshot.lastActivityAt = snapshot.startedAt;
    this.running += 1;
    this._persist(snapshot);
    this._emit({ kind: 'job.started', job: { ...snapshot } });
    this._log('job.started', { jobId: snapshot.id, jobKind: snapshot.kind });

    const onEvent = event => {
      snapshot.lastActivityAt = this.now();
      this._emit({ kind: 'job.event', job: { ...snapshot }, event });
    };

    Promise.resolve()
      .then(() => entry.runner({ signal: controller.signal, onEvent, job: { ...snapshot } }))
      .then(result => this._finish(entry, 'done', result, null))
      .catch(error => {
        const aborted = controller.signal.aborted;
        this._finish(entry, aborted ? 'stopped' : 'failed', null, aborted ? '已停止' : String(error && error.message ? error.message : error));
      });
  }

  _finish(entry, status, result, error) {
    const { snapshot } = entry;
    if (snapshot.status === 'done' || snapshot.status === 'failed' || snapshot.status === 'stopped') return;
    snapshot.status = status;
    snapshot.finishedAt = this.now();
    snapshot.error = error || null;
    snapshot.result = result === undefined ? null : result;
    this.running = Math.max(0, this.running - 1);
    this._persist(snapshot);
    this._emit({ kind: `job.${status}`, job: { ...snapshot } });
    this._log(`job.${status}`, {
      jobId: snapshot.id, jobKind: snapshot.kind,
      ms: snapshot.finishedAt - (snapshot.startedAt || snapshot.createdAt),
      error: error || undefined
    });
    if (status === 'done') entry.resolve(result);
    else entry.reject(new Error(error || status));
    this._pump();
  }

  /** 停止一个任务。越早停越好：排队中的直接出队，运行中的走 abort。 */
  stop(id, reason = '用户停止') {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    if (entry.snapshot.status === 'queued') {
      this.queue = this.queue.filter(item => item !== id);
      entry.controller.abort();
      this._finish(entry, 'stopped', null, reason);
      return true;
    }
    if (entry.snapshot.status === 'running') {
      entry.controller.abort();
      return true;
    }
    return false;
  }

  stopAll(reason = '整轮停止') {
    for (const id of [...this.jobs.keys()]) this.stop(id, reason);
  }

  get(id) {
    const entry = this.jobs.get(id);
    return entry ? { ...entry.snapshot } : null;
  }

  list({ kind, active } = {}) {
    let items = [...this.jobs.values()].map(entry => ({ ...entry.snapshot }));
    if (kind) items = items.filter(item => item.kind === kind);
    if (active) items = items.filter(item => item.status === 'running' || item.status === 'queued');
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 等待某个任务结束。任务已结束时立即返回/抛出。 */
  await(id) {
    const entry = this.jobs.get(id);
    if (!entry) return Promise.reject(new Error(`找不到任务 ${id}`));
    return entry.promise;
  }

  /**
   * 心跳：距上一次活动过了多少毫秒。看门狗用它区分"在思考"和"真卡住"，
   * 这是修 research.cjs 里 trial 期间不更新 lastActivityAt 那个误杀的抓手。
   */
  idleMs(id) {
    const entry = this.jobs.get(id);
    if (!entry) return null;
    if (entry.snapshot.status !== 'running') return 0;
    return this.now() - entry.snapshot.lastActivityAt;
  }

  stats() {
    const all = this.list();
    return {
      total: all.length,
      running: all.filter(item => item.status === 'running').length,
      queued: all.filter(item => item.status === 'queued').length,
      done: all.filter(item => item.status === 'done').length,
      failed: all.filter(item => item.status === 'failed').length,
      stopped: all.filter(item => item.status === 'stopped').length,
      interrupted: all.filter(item => item.status === 'interrupted').length,
      maxConcurrent: this.limits.maxConcurrent
    };
  }

  close(reason = '关闭') {
    this.stopAll(reason);
    this.closed = true;
  }
}

module.exports = { JobScheduler, newJobId, DEFAULT_LIMITS, STATUS, JOBS_DIR, JOB_FILE };
