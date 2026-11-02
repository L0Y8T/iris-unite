const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobScheduler, JOBS_DIR, JOB_FILE } = require('../core/harness/jobs.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-jobs-'));
}

/** 手动闸门：让测试精确控制任务何时结束，而不是靠 sleep 赌时序。 */
function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('任务立即返回句柄，后台跑完可 await 取结果', async () => {
  const events = [];
  const scheduler = new JobScheduler({ root: tempRoot(), onEvent: event => events.push(event.kind) });
  const job = scheduler.start({ kind: 'experiment', label: 'baseline', runner: async () => ({ metrics: { acc: 0.9 } }) });
  assert.equal(job.kind, 'experiment');
  assert.equal(job.label, 'baseline');
  assert.ok(['queued', 'running'].includes(job.status));

  const result = await scheduler.await(job.id);
  assert.deepEqual(result, { metrics: { acc: 0.9 } });
  assert.equal(scheduler.get(job.id).status, 'done');
  assert.ok(events.includes('job.queued'));
  assert.ok(events.includes('job.started'));
  assert.ok(events.includes('job.done'));
});

test('并发上限生效：超出部分排队，前一个结束才启动', async () => {
  const scheduler = new JobScheduler({ root: tempRoot(), limits: { maxConcurrent: 1 } });
  const first = gate();
  const started = [];
  const a = scheduler.start({ kind: 'experiment', runner: async () => { started.push('a'); await first.promise; return 'A'; } });
  const b = scheduler.start({ kind: 'experiment', runner: async () => { started.push('b'); return 'B'; } });

  await tick();
  assert.deepEqual(started, ['a'], '第二个必须排队');
  assert.equal(scheduler.get(b.id).status, 'queued');

  first.open();
  await scheduler.await(a.id);
  await scheduler.await(b.id);
  assert.deepEqual(started, ['a', 'b']);
  const stats = scheduler.stats();
  assert.equal(stats.done, 2);
  assert.equal(stats.maxConcurrent, 1);
});

test('停止运行中的任务：abort 传进 runner，状态落 stopped，await 抛错', async () => {
  const scheduler = new JobScheduler({ root: tempRoot() });
  let sawAbort = false;
  const job = scheduler.start({
    kind: 'experiment',
    runner: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('已停止')); });
      });
    }
  });
  await tick();
  assert.equal(scheduler.stop(job.id), true);
  await assert.rejects(scheduler.await(job.id), /已停止/);
  assert.equal(sawAbort, true);
  assert.equal(scheduler.get(job.id).status, 'stopped');
});

test('停止排队中的任务：不出队执行，直接落 stopped', async () => {
  const scheduler = new JobScheduler({ root: tempRoot(), limits: { maxConcurrent: 1 } });
  const blocker = gate();
  const a = scheduler.start({ kind: 'x', runner: async () => { await blocker.promise; } });
  let ran = false;
  const b = scheduler.start({ kind: 'x', runner: async () => { ran = true; } });
  await tick();
  assert.equal(scheduler.stop(b.id, '不用了'), true);
  assert.equal(scheduler.get(b.id).status, 'stopped');
  blocker.open();
  await scheduler.await(a.id);
  assert.equal(ran, false, '排队的任务被停掉后绝不能真的执行');
});

test('任务失败落 failed 并带上原因，不影响调度器继续工作', async () => {
  const scheduler = new JobScheduler({ root: tempRoot() });
  const bad = scheduler.start({ kind: 'experiment', runner: async () => { throw new Error('python 不存在'); } });
  await assert.rejects(scheduler.await(bad.id), /python 不存在/);
  const record = scheduler.get(bad.id);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /python 不存在/);

  const good = scheduler.start({ kind: 'experiment', runner: async () => 'ok' });
  assert.equal(await scheduler.await(good.id), 'ok');
});

test('心跳能区分“在思考”和“真卡住”', async () => {
  let clock = 1000;
  const scheduler = new JobScheduler({ root: tempRoot(), now: () => clock });
  const hold = gate();
  const job = scheduler.start({
    kind: 'experiment',
    runner: async ({ onEvent }) => { onEvent({ kind: 'line', text: 'epoch 1' }); await hold.promise; }
  });
  await tick();
  clock += 5000;
  assert.equal(scheduler.idleMs(job.id), 5000);
  // 一条事件把心跳推到现在：这正是 trial 期间不该被看门狗误杀的依据。
  const entry = scheduler.jobs.get(job.id);
  entry.snapshot.lastActivityAt = clock;
  assert.equal(scheduler.idleMs(job.id), 0);
  hold.open();
  await scheduler.await(job.id);
  assert.equal(scheduler.idleMs(job.id), 0, '结束后不再计时');
});

test('崩溃恢复：上次遗留的 running 被标为 interrupted，不会假装还在跑', () => {
  const root = tempRoot();
  const dir = path.join(root, JOBS_DIR, 'job-leftover');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, JOB_FILE), JSON.stringify({ id: 'job-leftover', kind: 'experiment', status: 'running', createdAt: 1, startedAt: 2 }), 'utf8');

  const events = [];
  const scheduler = new JobScheduler({ root, onEvent: event => events.push(event.kind) });
  const record = scheduler.get('job-leftover');
  assert.equal(record.status, 'interrupted');
  assert.match(record.error, /上次退出/);
  assert.ok(events.includes('job.interrupted'));

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, JOB_FILE), 'utf8'));
  assert.equal(persisted.status, 'interrupted', '恢复结果必须落盘，否则下次开机还会显示在跑');
});

test('排队上限拒绝而不是无限堆积', () => {
  const scheduler = new JobScheduler({ root: tempRoot(), limits: { maxConcurrent: 1, queueLimit: 2 } });
  const hold = gate();
  scheduler.start({ kind: 'x', runner: async () => { await hold.promise; } });
  scheduler.start({ kind: 'x', runner: async () => { await hold.promise; } });
  assert.throws(() => scheduler.start({ kind: 'x', runner: async () => {} }), /排队任务已达上限/);
  hold.open();
});

test('事件里带得上 job 快照，账本记下 queued/started/done', async () => {
  const root = tempRoot();
  const events = [];
  const appended = [];
  const ledger = { append: (type, fields) => appended.push({ type, fields }) };
  const scheduler = new JobScheduler({ root, onEvent: event => events.push(event), ledger });
  const job = scheduler.start({ kind: 'experiment', label: 'run-1', runner: async () => 'done' });
  await scheduler.await(job.id);
  const done = events.find(event => event.kind === 'job.done');
  assert.equal(done.job.id, job.id);
  assert.equal(done.job.label, 'run-1');
  assert.deepEqual(appended.map(item => item.type), ['job.queued', 'job.started', 'job.done']);
  assert.equal(appended[2].fields.jobId, job.id);
});

test('关闭调度器时停掉全部任务', async () => {
  const scheduler = new JobScheduler({ root: tempRoot() });
  const hold = gate();
  const job = scheduler.start({
    kind: 'x',
    // runner 必须响应 signal：调度器只负责发 abort，不会替任务强行结束。
    runner: async ({ signal }) => {
      await Promise.race([
        hold.promise,
        new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('已停止'))))
      ]);
    }
  });
  await tick();
  scheduler.close('收工');
  await assert.rejects(scheduler.await(job.id), /收工|已停止/);
  assert.equal(scheduler.get(job.id).status, 'stopped');
  hold.open();
});
