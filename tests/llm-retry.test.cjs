/* 模型通道失败重试的验收：离线、不花钱、不起窗口。
 *
 * 盯四件事：
 * 1. 只重试「等一会儿可能就好」的错误（429 / 5xx / 网络抖动），其余一次都不试；
 * 2. 退避是 1s→2s→4s，第三次失败后抛**原错误对象**，不包装；
 * 3. 每个退避等待都听 signal：abort 时立刻停，不等完当前那段；
 * 4. provider 抛出的错误带得上状态码/错误码——重试判定靠属性，不靠解析中文消息。
 *
 *   node --test tests/llm-retry.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const llmRetry = require('../core/llm-retry.cjs');
const providers = require('../core/providers.cjs');
const { runCustom } = require('../core/custom-provider.cjs');

const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const netError = (code, message = 'fetch failed') => Object.assign(new Error(message), { cause: { code } });

/* 假 sleep：只记录被要求的间隔，不真等。真实等待在「abort 立刻停」那条里测。 */
function recorder() {
  const waits = [];
  const signals = [];
  return { waits, signals, sleep: (ms, signal) => { waits.push(ms); signals.push(signal); return Promise.resolve(); } };
}

test('5xx 重试三次后抛原错误，共四次尝试', async () => {
  let attempts = 0;
  const boom = httpError(500, 'DeepSeek 请求失败（500）');
  await assert.rejects(
    llmRetry.withRetry(async () => { attempts += 1; throw boom; }, { sleep: recorder().sleep }),
    error => error === boom // 同一个对象，不是包出来的新错误
  );
  assert.equal(attempts, 4, '首次 + 3 次重试');
});

test('退避序列是 1s → 2s → 4s', async () => {
  const { waits, sleep } = recorder();
  await assert.rejects(llmRetry.withRetry(async () => { throw httpError(503); }, { sleep }));
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(llmRetry.BACKOFF_MS, [1000, 2000, 4000], '数组长度就是重试次数');
});

test('429 第二次就成功，只退避一次', async () => {
  const { waits, sleep } = recorder();
  const events = [];
  let attempts = 0;
  const result = await llmRetry.withRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw httpError(429, '请求过于频繁');
    return 'ok';
  }, { sleep, onRetry: info => events.push(info) });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(events.length, 1);
});

test('401/400/402/403 一次都不重试', async () => {
  for (const status of [400, 401, 402, 403]) {
    const { waits, sleep } = recorder();
    let attempts = 0;
    const boom = httpError(status);
    await assert.rejects(llmRetry.withRetry(async () => { attempts += 1; throw boom; }, { sleep }), error => error === boom);
    assert.equal(attempts, 1, `HTTP ${status} 不该重试`);
    assert.deepEqual(waits, [], `HTTP ${status} 不该退避`);
  }
});

test('内容被截断不重试', async () => {
  const { waits, sleep } = recorder();
  let attempts = 0;
  const boom = new Error('DeepSeek 输出达到上限被截断，请缩短任务或改用支持更长输出的模型。');
  await assert.rejects(llmRetry.withRetry(async () => { attempts += 1; throw boom; }, { sleep }), error => error === boom);
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});

test('signal 已 abort 时立刻停，不退避也不再试一次', async () => {
  const controller = new AbortController();
  controller.abort();
  const { waits, sleep } = recorder();
  let attempts = 0;
  const boom = httpError(429);
  await assert.rejects(
    llmRetry.withRetry(async () => { attempts += 1; throw boom; }, { sleep, signal: controller.signal }),
    error => error === boom
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, [], 'abort 之后不许再进退避');
});

test('退避等待途中 abort：立刻返回，不等完这段', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const started = Date.now();
  const task = llmRetry.withRetry(async () => { attempts += 1; throw httpError(503); }, { signal: controller.signal, backoff: [5000] });
  const aborter = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(task); } finally { clearTimeout(aborter); }
  const elapsed = Date.now() - started;
  assert.equal(attempts, 1, 'abort 后不该再发起第二次尝试');
  assert.ok(elapsed < 1500, `应当立刻停止，实际等了 ${elapsed}ms`);
});

test('每次重试都回调一次，带第几次、原因与间隔', async () => {
  const events = [];
  await assert.rejects(llmRetry.withRetry(async () => { throw httpError(502); }, { sleep: recorder().sleep, onRetry: info => events.push(info) }));
  assert.deepEqual(events.map(e => e.attempt), [1, 2, 3]);
  assert.deepEqual(events.map(e => e.waitMs), [1000, 2000, 4000]);
  for (const event of events) assert.equal(event.reason, 'HTTP 502');
});

test('网络错误码可重试：ECONNRESET / UND_ERR_*', async () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    const { waits, sleep } = recorder();
    let attempts = 0;
    const result = await llmRetry.withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw netError(code);
      return code;
    }, { sleep });
    assert.equal(result, code);
    assert.equal(attempts, 2, `${code} 应当重试一次`);
    assert.deepEqual(waits, [1000]);
  }
});

test('ECONNREFUSED 等不在白名单的错误码不重试', async () => {
  const { waits, sleep } = recorder();
  let attempts = 0;
  const boom = netError('ECONNREFUSED');
  await assert.rejects(llmRetry.withRetry(async () => { attempts += 1; throw boom; }, { sleep }), error => error === boom);
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});

test('已经输出过正文就不再重试（避免正文叠字）', async () => {
  const { waits, sleep } = recorder();
  let attempts = 0;
  let emitted = false;
  const boom = httpError(500);
  await assert.rejects(
    llmRetry.withRetry(async () => { attempts += 1; emitted = true; throw boom; }, { sleep, canRetry: () => !emitted }),
    error => error === boom
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});

test('注入的 sleep 收到 signal，abort 能传下去', async () => {
  const controller = new AbortController();
  const { signals, sleep } = recorder();
  await assert.rejects(llmRetry.withRetry(async () => { throw httpError(500); }, { sleep, signal: controller.signal, backoff: [1000] }));
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);
});

test('DeepSeek 非 ok 响应把状态码挂在错误上', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    providers.runDeepseek({ conversation: { messages: [] }, settings: { deepseekEffort: 'off' }, key: 'k', signal: new AbortController().signal, onText: () => {}, messages: [{ role: 'user', content: 'hi' }], fetchImpl }),
    error => error.status === 429 && /429/.test(error.message)
  );
});

test('custom-provider 非 ok 响应把状态码挂在错误上', async () => {
  const connection = { id: 'c1', name: '本地模型', enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', effortMode: 'none', maxTokens: 1024, allowNoKey: true };
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    runCustom({ connection, choice: { model: 'm', effort: 'default' }, key: '', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onText: () => {}, fetchImpl }),
    error => error.status === 503 && /503/.test(error.message)
  );
});

test('custom-provider 网络异常把错误码挂在错误上，并据此判定可重试', async () => {
  const connection = { id: 'c1', name: '本地模型', enabled: true, protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', effortMode: 'none', maxTokens: 1024, allowNoKey: true };
  const fetchImpl = async () => { throw netError('ECONNRESET'); };
  await assert.rejects(
    runCustom({ connection, choice: { model: 'm', effort: 'default' }, key: '', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onText: () => {}, fetchImpl }),
    error => {
      assert.equal(error.code, 'ECONNRESET');
      assert.match(error.message, /ECONNRESET/, '消息里仍要让人看懂是连不上');
      assert.equal(llmRetry.isRetryable(error), true, 'ECONNRESET 应当被判为可重试');
      return true;
    }
  );
});
