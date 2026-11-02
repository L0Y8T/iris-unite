const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ToolSniffer, parseToolCalls, stripToolBlocks, renderToolResults, extractToolBlock, renderProtocol
} = require('../core/harness/protocol.cjs');
const { createRegistry, validateArgs, describeTools } = require('../core/harness/tools/registry.cjs');
const { createToolbox } = require('../core/harness/tools/index.cjs');
const { runAgentLoop, planBatches } = require('../core/harness/loop.cjs');
const { openWorkspace } = require('../core/harness/workspace.cjs');
const ids = require('../core/harness/ids.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-loop-'));
}

function makeWorkspace(root) {
  return openWorkspace({ root, runId: ids.newRunId(), ledger: false });
}

const fence = calls => '```tool\n' + JSON.stringify(calls) + '\n```';

/* ---------- 协议解析 ---------- */

test('协议解析接受三种常见写法，并拒绝无法纠正的结构', () => {
  assert.deepEqual(parseToolCalls(fence({ calls: [{ name: 'list_artifacts', args: {} }] })).calls,
    [{ name: 'list_artifacts', args: {} }]);
  assert.deepEqual(parseToolCalls(fence({ name: 'list_artifacts', args: {} })).calls,
    [{ name: 'list_artifacts', args: {} }], '单个 name 对象也要认');
  assert.deepEqual(parseToolCalls(fence([{ name: 'list_artifacts', args: {} }])).calls,
    [{ name: 'list_artifacts', args: {} }], '顶层数组也要认');
  assert.deepEqual(parseToolCalls(fence({ calls: [{ tool: 'list_artifacts', arguments: '{"a":1}' }] })).calls,
    [{ name: 'list_artifacts', args: { a: 1 } }], 'tool + arguments 的别名要认，字符串 args 要解');

  assert.equal(parseToolCalls('就是一段普通正文').calls.length, 0);
  assert.match(parseToolCalls('```tool\n不是 JSON\n```').error, /不是合法 JSON/);
  assert.match(parseToolCalls(fence({ calls: [{ args: {} }] })).error, /缺 name/);
  assert.match(parseToolCalls(fence({ calls: [] })).error, /空数组/);
});

test('夹具之外的正文原样保留，tool 块被剔除', () => {
  const text = '我先看看有什么材料。\n\n' + fence({ calls: [{ name: 'x', args: {} }] });
  assert.equal(stripToolBlocks(text), '我先看看有什么材料。');
  assert.equal(extractToolBlock(text), '{"calls":[{"name":"x","args":{}}]}');
  assert.equal(extractToolBlock('没有块'), null);
});

test('工具结果回灌：成功带内容，失败带修正建议', () => {
  const rendered = renderToolResults([
    { name: 'read_artifact', args: { id: 'art-1' }, result: { ok: true, result: { text: '正文' } } },
    { name: 'oops', args: {}, result: { ok: false, error: '没有这个工具', hint: '可用工具：a、b' } }
  ]);
  assert.match(rendered, /\[1\] read_artifact/);
  assert.match(rendered, /正文/);
  assert.match(rendered, /\[2\] oops.*失败：没有这个工具/s);
  assert.match(rendered, /修正建议：可用工具：a、b/);
});

test('流式嗅探不把 tool 块漏给用户，但保留块之前的思考', () => {
  const seen = [];
  const sniffer = new ToolSniffer({ onText: chunk => seen.push(chunk) });
  // 刻意把围栏切在 chunk 中间，模拟真实的 SSE 分片。
  for (const chunk of ['我先', '看看', '有什么。\n\n``', '`tool\n{"calls":[{', '"name":"list_artifacts","args":{}}]}\n```']) sniffer.feed(chunk);
  const tail = sniffer.finish();
  const streamed = seen.join('');
  assert.equal(tail.sawTool, true);
  assert.equal(streamed, '我先看看有什么。\n\n', '围栏之前的正文要透传');
  assert.ok(!streamed.includes('```tool'), '围栏本身不得透传');
  assert.match(tail.text, /list_artifacts/);
});

test('流式嗅探对纯正文逐字透传，一个字都不丢', () => {
  const seen = [];
  const sniffer = new ToolSniffer({ onText: chunk => seen.push(chunk) });
  for (const chunk of ['最终', '答案', '是', '这样。']) sniffer.feed(chunk);
  sniffer.finish();
  assert.equal(seen.join(''), '最终答案是 这样。'.replace(' ', ''));
});

test('协议说明把工具清单与轮数上限都写进去', () => {
  const text = renderProtocol({ tools: [{ name: 'read_artifact', permission: 'read', summary: '读产物' }], maxSteps: 5 });
  assert.match(text, /最多 5 轮/);
  assert.match(text, /read_artifact（read）：读产物/);
  assert.match(text, /```tool/);
});

/* ---------- 注册表 ---------- */

test('注册表：参数校验挡住越界与未知字段，执行器不被调用', async () => {
  const registry = createRegistry();
  let called = 0;
  registry.define({
    name: 'demo',
    summary: '演示',
    params: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false },
    async execute() { called += 1; return { ok: true, result: 'done' }; }
  });
  assert.match((await registry.invoke('demo', {})).error, /缺少必填参数 n/);
  assert.match((await registry.invoke('demo', { n: 9 })).error, /不能大于 3/);
  assert.match((await registry.invoke('demo', { n: 1.5 })).error, /应为 integer/);
  assert.match((await registry.invoke('demo', { n: 1, mode: 'c' })).error, /只能是 a \/ b/);
  assert.match((await registry.invoke('demo', { n: 1, extra: true })).error, /不认识的参数 extra/);
  assert.equal(called, 0, '参数不合法时绝不能执行');
  assert.equal((await registry.invoke('demo', { n: 2 })).ok, true);
  assert.equal(called, 1);
});

test('注册表：重名、非法权限、缺执行器都当场拒绝', () => {
  const registry = createRegistry();
  registry.define({ name: 'a', execute: async () => ({ ok: true }) });
  assert.throws(() => registry.define({ name: 'a', execute: async () => ({ ok: true }) }), /重名/);
  assert.throws(() => registry.define({ name: 'b', permission: 'root', execute: async () => ({ ok: true }) }), /权限/);
  assert.throws(() => registry.define({ name: 'c' }), /execute/);
});

test('validateArgs 对空 schema 无要求，describeTools 渲染出可读清单', () => {
  assert.deepEqual(validateArgs(null, {}), []);
  const text = describeTools([{ name: 't', summary: '说明', permission: 'read', params: { type: 'object', properties: { q: { type: 'string', description: '检索词' } }, required: ['q'] } }]);
  assert.match(text, /- t（read）：说明/);
  assert.match(text, /q \(string，必填\)：检索词/);
});

/* ---------- 工具箱 ---------- */

test('文件工具：读产物、按阶段列出、按关键词搜索、写笔记后能读回', async () => {
  const ws = makeWorkspace(tempRoot());
  const long = '## 结论\n\n第一段讲方法。\n\n' + '填充内容。'.repeat(300) + '\n\n## 局限\n\n样本少。';
  const written = ws.writeArtifact({ stage: 'research-explore', title: '探索一', text: long });
  const box = createToolbox({ workspace: ws });

  const listed = await box.invoke('list_artifacts', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.result.length, 1);
  assert.equal(listed.result[0].id, written.id);

  const page = await box.invoke('read_artifact', { id: written.id, limit: 50 });
  assert.equal(page.ok, true);
  assert.equal(page.result.text.length, 50);
  assert.match(page.result.note, /继续读用 offset=50/);

  const found = await box.invoke('search_artifacts', { query: '局限' });
  assert.ok(found.result.hits.length >= 1);
  assert.equal(found.result.hits[0].id, written.id);

  const note = await box.invoke('write_note', { title: '我的小结', text: '要点一', stage: 'research-plan' });
  assert.equal(note.ok, true);
  assert.equal(ws.readArtifact(note.result.id).text, '要点一');

  assert.equal((await box.invoke('read_artifact', { id: 'art-00000000' })).ok, false);
  assert.match((await box.invoke('read_artifact', { id: 'art-00000000' })).error, /找不到产物/);
});

test('能力边界即工具边界：没注入执行器就没有 run_experiment', () => {
  const ws = makeWorkspace(tempRoot());
  assert.equal(createToolbox({ workspace: ws }).has('run_experiment'), false);
  const withExec = createToolbox({
    workspace: ws,
    capabilities: { runExperiment: async () => ({ runId: 'r1', status: 'done', metrics: { return_mean: 500 } }) }
  });
  assert.equal(withExec.has('run_experiment'), true);
  assert.equal(withExec.has('list_templates'), false, '只注入了 runExperiment，就不该凭空冒出 list_templates');
});

/* ---------- 循环 ---------- */

test('没有工具时退化为单次调用，正文原样返回并流式透传', async () => {
  const seen = [];
  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'writing',
    messages: [{ role: 'user', content: '写点东西' }],
    call: async ({ onText }) => { onText('答'); onText('案'); },
    toolbox: null,
    onText: chunk => seen.push(chunk)
  });
  assert.equal(result.text, '答案');
  assert.equal(result.stoppedReason, 'no-tools');
  assert.equal(seen.join(''), '答案');
});

test('工具循环：先读产物再作答，工具结果确实回灌进了下一轮', async () => {
  const ws = makeWorkspace(tempRoot());
  const artifact = ws.writeArtifact({ stage: 'research-explore', title: '探索', text: '关键数字是 42。' });
  const box = createToolbox({ workspace: ws });
  const turns = [];
  const events = [];

  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'research-final',
    messages: [{ role: 'user', content: '总结一下' }],
    toolbox: box,
    onEvent: event => events.push(event),
    call: async ({ messages, onText }) => {
      turns.push(messages.length);
      if (turns.length === 1) onText(fence({ calls: [{ name: 'read_artifact', args: { id: artifact.id } }] }));
      else onText('看到关键数字是 42。');
    }
  });

  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.text, '看到关键数字是 42。');
  assert.equal(result.steps, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read_artifact');
  assert.equal(result.toolCalls[0].ok, true);
  assert.deepEqual(turns, [1, 3], '第二轮应带上 assistant + 工具结果两条消息');
  assert.ok(events.some(event => event.kind === 'tool' && event.name === 'read_artifact'));
});

test('工具执行失败不终止循环，而是把失败原因回灌让模型换路子', async () => {
  const ws = makeWorkspace(tempRoot());
  const box = createToolbox({ workspace: ws });
  let round = 0;
  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: box,
    call: async ({ messages, onText }) => {
      round += 1;
      if (round === 1) onText(fence({ calls: [{ name: 'read_artifact', args: { id: 'art-00000000' } }] }));
      else {
        assert.match(messages.at(-1).content, /找不到产物/, '失败原因必须回灌');
        onText('换个方式完成了。');
      }
    }
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.text, '换个方式完成了。');
});

test('协议写错时回灌纠错而不是直接失败', async () => {
  let round = 0;
  const ws = makeWorkspace(tempRoot());
  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: createToolbox({ workspace: ws }),
    call: async ({ messages, onText }) => {
      round += 1;
      if (round === 1) onText('```tool\n不是JSON\n```');
      else {
        assert.match(messages.at(-1).content, /格式有误/);
        onText('好了。');
      }
    }
  });
  assert.equal(result.text, '好了。');
  assert.equal(result.steps, 2);
});

test('额度用尽：最后一轮明确下通牒，且不再执行工具', async () => {
  const ws = makeWorkspace(tempRoot());
  const box = createToolbox({ workspace: ws });
  const seenNotices = [];
  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: box,
    limits: { maxSteps: 2 },
    call: async ({ messages, onText }) => {
      seenNotices.push(messages.some(message => String(message.content).includes('最后通牒')));
      onText(fence({ calls: [{ name: 'list_artifacts', args: {} }] }));
    }
  });
  assert.equal(result.stoppedReason, 'max-steps');
  assert.deepEqual(seenNotices, [false, true], '第二轮必须带上最后通牒');
  assert.match(result.text, /没有产出正文|额度/, `实际：${result.text}`);
});

test('单个工具结果超限会被截断，并留下续读线索', async () => {
  const ws = makeWorkspace(tempRoot());
  const huge = 'Z'.repeat(50000);
  const artifact = ws.writeArtifact({ stage: 'log', title: '大日志', text: huge });
  let second = '';
  let round = 0;
  await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: createToolbox({ workspace: ws }),
    limits: { resultChars: 1000 },
    call: async ({ messages, onText }) => {
      round += 1;
      if (round === 1) onText(fence({ calls: [{ name: 'read_artifact', args: { id: artifact.id, limit: 40000 } }] }));
      else { second = messages.at(-1).content; onText('done'); }
    }
  });
  assert.match(second, /工具结果已截断/);
  assert.ok(second.length < 50000, '回灌内容必须被压住');
});

test('循环遵守取消：signal 中断后抛错，不把半截结果当答案', async () => {
  const controller = new AbortController();
  const ws = makeWorkspace(tempRoot());
  await assert.rejects(runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: createToolbox({ workspace: ws }),
    signal: controller.signal,
    call: async ({ onText }) => { controller.abort(); onText('半截'); }
  }), /已停止生成/);
});

test('buffer 模式不流式输出，只在最后一次性给出最终文本', async () => {
  const seen = [];
  const ws = makeWorkspace(tempRoot());
  await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: createToolbox({ workspace: ws }),
    streamMode: 'buffer',
    onText: chunk => seen.push(chunk),
    call: async ({ onText }) => onText('最终正文')
  });
  assert.deepEqual(seen, ['最终正文'], 'buffer 模式下中途不应有任何输出');
});

/* ---------- 并行安全屏障 ---------- */

/* 造一个能控制耗时的工具箱：每个工具都往 log 里打开始/结束，并统计同时在跑的数量峰值。
   unsafe 里的工具声明 parallelSafe:false，其余走注册表默认（安全）。 */
function scriptedToolbox({ delays, unsafe = [] }) {
  const log = [];
  const state = { running: 0, peak: 0 };
  const registry = createRegistry();
  for (const [name, ms] of Object.entries(delays)) {
    registry.define({
      name,
      parallelSafe: !unsafe.includes(name),
      params: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        state.running += 1;
        state.peak = Math.max(state.peak, state.running);
        log.push(`start:${name}`);
        await new Promise(resolve => setTimeout(resolve, ms));
        state.running -= 1;
        log.push(`end:${name}`);
        return { ok: true, result: `R-${name}` };
      }
    });
  }
  return {
    log,
    state,
    box: {
      specs: () => registry.specs(),
      invoke: (name, args, ctx) => registry.invoke(name, args, ctx),
      get: name => registry.get(name)
    }
  };
}

/* 跑一轮循环：第一轮把 names 全部作为一次请求的并发调用，第二轮收尾并截住回灌内容。 */
async function runOneBurst(box, names) {
  let replayed = '';
  let round = 0;
  const result = await runAgentLoop({
    provider: 'deepseek', stage: 'x',
    messages: [{ role: 'user', content: 'go' }],
    toolbox: box,
    call: async ({ messages, onText }) => {
      round += 1;
      if (round === 1) onText(fence({ calls: names.map(name => ({ name, args: {} })) }));
      else { replayed = messages.at(-1).content; onText('done'); }
    }
  });
  return { result, replayed };
}

const orderOf = (text, markers) => markers.map(marker => text.indexOf(marker));
const assertAllPresent = (indexes, markers) => {
  indexes.forEach((index, i) => assert.ok(index >= 0, `回灌里找不到 ${markers[i]}`));
};
const assertAscending = (indexes, markers) => {
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i] > indexes[i - 1], `顺序错了：${markers[i - 1]} 应排在 ${markers[i]} 之前`);
  }
};

test('并行屏障：中间那个 parallelSafe:false 独占，前后两批各自并发并等它', async () => {
  const { box, log, state } = scriptedToolbox({
    delays: { a: 25, b: 25, solo: 25, c: 5, d: 5 },
    unsafe: ['solo']
  });
  const { result, replayed } = await runOneBurst(box, ['a', 'b', 'solo', 'c', 'd']);

  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.toolCalls.length, 5);
  assert.equal(result.toolCalls.every(call => call.ok), true);

  /* 前两个：都开始了才可能有人结束 → 确实并发。 */
  assert.ok(log.indexOf('start:a') < log.indexOf('end:a'));
  assert.ok(log.indexOf('start:b') < log.indexOf('end:a'), 'a 与 b 必须在同一批里并发');
  assert.ok(log.indexOf('start:a') < log.indexOf('end:b'), 'a 与 b 必须在同一批里并发');

  /* 屏障：solo 必须等 a、b 都结束之后才开始。 */
  assert.ok(log.indexOf('start:solo') > log.indexOf('end:a'), 'solo 不能在 a 结束前开跑');
  assert.ok(log.indexOf('start:solo') > log.indexOf('end:b'), 'solo 不能在 b 结束前开跑');

  /* 后一批：必须等 solo 结束之后才开始。 */
  assert.ok(log.indexOf('start:c') > log.indexOf('end:solo'), 'solo 后面的调用必须等它结束');
  assert.ok(log.indexOf('start:d') > log.indexOf('end:solo'), 'solo 后面的调用必须等它结束');
  assert.ok(log.indexOf('start:d') < log.indexOf('end:c'), 'c 与 d 属于同一批，应当并发');

  assert.equal(state.peak, 2, '同批最多两个并发，solo 期间不允许有别人在跑');

  /* 回灌顺序 = 调用顺序，与完成先后无关。 */
  const markers = ['R-a', 'R-b', 'R-solo', 'R-c', 'R-d'];
  const indexes = orderOf(replayed, markers);
  assertAllPresent(indexes, markers);
  assertAscending(indexes, markers);
});

test('并行屏障：全部安全时结果确实并发跑，且完成顺序不会打乱回灌顺序', async () => {
  /* 耗时递减：完成顺序会是 fast → mid → slow，与调用顺序相反，正好用来验证回灌排序。 */
  const { box, state } = scriptedToolbox({ delays: { slow: 40, mid: 20, fast: 2 } });
  const { result, replayed } = await runOneBurst(box, ['slow', 'mid', 'fast']);

  assert.equal(result.toolCalls.length, 3);
  assert.equal(state.peak, 3, '三个安全工具应当同时开跑');
  assert.deepEqual(result.toolCalls.map(call => call.name), ['fast', 'mid', 'slow'],
    '完成顺序按耗时来，说明确实是并发');

  const markers = ['R-slow', 'R-mid', 'R-fast'];
  const indexes = orderOf(replayed, markers);
  assertAllPresent(indexes, markers);
  assertAscending(indexes, markers);
  assert.match(replayed, /\[1\] slow/);
  assert.match(replayed, /\[3\] fast/);
});

test('并行屏障：分组规则本身（连续安全成批、不安全独占）', () => {
  const calls = ['x', 'y', 'solo', 'solo2', 'z'].map(name => ({ name, args: {} }));
  const batches = planBatches(calls, name => !name.startsWith('solo'));
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.map(batch => batch.concurrent), [true, false, false, true]);
  assert.deepEqual(batches.map(batch => batch.entries.map(entry => entry.index)),
    [[0, 1], [2], [3], [4]], '批次必须记住原始下标，否则回灌排序无从还原');

  assert.deepEqual(planBatches([], () => true), []);
  const allSafe = planBatches(calls, () => true);
  assert.equal(allSafe.length, 1, '全安全时只需要一批');
  assert.deepEqual(allSafe[0].entries.map(entry => entry.index), [0, 1, 2, 3, 4]);
});

test('并行安全声明：注册处默认 true，run_experiment 显式 false，specs() 不外泄这个字段', () => {
  const registry = createRegistry();
  registry.define({ name: 'plain', execute: async () => ({ ok: true }) });
  registry.define({ name: 'guarded', parallelSafe: false, execute: async () => ({ ok: true }) });
  assert.equal(registry.get('plain').parallelSafe, true, '默认必须安全，否则现有工具全被降级成串行');
  assert.equal(registry.get('guarded').parallelSafe, false);
  for (const spec of registry.specs()) {
    assert.ok(!('parallelSafe' in spec), `specs() 不该把执行语义泄露给模型：${spec.name}`);
    assert.ok(!('execute' in spec), 'specs() 也不该带执行器');
  }

  /* 真工具箱：只有 run_experiment 是不安全的。 */
  const ws = makeWorkspace(tempRoot());
  const box = createToolbox({
    workspace: ws,
    capabilities: { runExperiment: async () => ({ runId: 'r1', status: 'done', metrics: { m: 1 } }) }
  });
  assert.equal(box.get('run_experiment').parallelSafe, false, '跑实验会抢 GPU 与运行目录，不能并跑');
  assert.equal(box.get('read_artifact').parallelSafe, true);
  assert.equal(box.get('write_note').parallelSafe, true);
  assert.ok(box.specs().every(spec => !('parallelSafe' in spec)));
});
