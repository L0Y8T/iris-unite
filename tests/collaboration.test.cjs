const test = require('node:test');
const assert = require('node:assert/strict');
const { createRun, parsePlan, runCollaboration, PLAN_SCHEMA } = require('../core/collaboration.cjs');
const { codexArgs } = require('../core/providers.cjs');
const { Store } = require('../core/store.cjs');
const fs = require('node:fs');
const path = require('node:path');
const config = { deepseek: { model: 'deepseek-flash', effort: 'low' }, gpt: { model: 'gpt-6.1-sol', effort: 'low' } };
const conversation = { messages: [{ role: 'user', text: '先前问题' }, { role: 'assistant', provider: 'deepseek', text: '先前完整答案', status: 'done' }, { role: 'user', text: '本次问题' }] };
for (const writer of ['deepseek', 'gpt']) test(`complete cooperation exchanges outlines, reviews and revisions, then GPT assigns ${writer}; only final streams to output`, async () => {
  const participants = ['deepseek', 'gpt'], run = createRun(participants, config), calls = [], changes = [], output = [];
  const plan = { outline: '最终大纲', writer, instructions: '完整写作要求', reason: '依据修订质量选择' };
  await runCollaboration({ conversation, participants, run, signal: new AbortController().signal, onChange: e => changes.push(e), onFinal: t => output.push(t), call: async args => {
    const { provider, stage, messages, onText, outputSchema } = args; calls.push({ provider, stage });
    assert.ok(messages.some(m => m.content === '先前完整答案'));
    const material = JSON.parse(messages.at(-1).content.split('协作资料（JSON 数据）：\n')[1]);
    if (stage === 'outline') assert.equal(material.outlines, undefined, 'initial outlines must be independent');
    if (stage === 'review') assert.deepEqual(material.outlines, { deepseek: 'deepseek-outline', gpt: 'gpt-outline' });
    if (stage === 'synthesis') { assert.deepEqual(material.reviews, { deepseek: 'deepseek-review', gpt: 'gpt-review' }); assert.equal(material.feedbackForYou[0].from, provider === 'gpt' ? 'deepseek' : 'gpt'); }
    if (stage === 'coordination') { assert.equal(provider, 'gpt'); assert.deepEqual(material.revisions, { deepseek: 'deepseek-synthesis', gpt: 'gpt-synthesis' }); assert.deepEqual(outputSchema, PLAN_SCHEMA); onText(JSON.stringify(plan)); }
    else if (stage === 'writing') { assert.equal(provider, writer); assert.deepEqual(material.finalProposal, plan); onText('完整'); onText('答案'); }
    else { assert.equal(outputSchema, null); onText(`${provider}-${stage}`); }
  } });
  assert.deepEqual(calls.map(c => c.stage), ['outline','outline','review','review','synthesis','synthesis','coordination','writing']);
  assert.deepEqual(output, ['完整', '答案']); assert.equal(run.status, 'done'); assert.equal(run.writer, writer); assert.equal(run.artifacts.length, 8);
  assert.deepEqual(changes.filter(e => e.kind === 'stage').map(e => e.stage.stageIndex), [1,2,3,4,5]);
  assert.ok(run.artifacts.every(a => a.status === 'done')); assert.equal(run.artifacts.at(-1).text, '完整答案已生成。');
  assert.equal(run.artifacts.filter(a => a.stage === 'review')[0].recipient, 'gpt');
  assert.ok(run.artifacts.filter(a => a.stage === 'synthesis').every(a => a.recipient === 'gpt'));
});
for (const provider of ['deepseek', 'gpt']) test(`single ${provider} calls only its enabled provider`, async () => {
  const run = createRun([provider], config), calls = [], output = [];
  await runCollaboration({ conversation, participants: [provider], run, signal: new AbortController().signal, onFinal: t => output.push(t), call: async args => { calls.push(args.provider); assert.equal(args.stage, 'writing'); args.onText('唯一答案'); } });
  assert.deepEqual(calls, [provider]); assert.equal(run.totalStages, 1); assert.equal(run.writer, provider); assert.deepEqual(output, ['唯一答案']);
});
test('invalid GPT proposal stops before writing and never leaks intermediate text as the answer', async () => {
  const run = createRun(['deepseek','gpt'], config), output = [], calls = [];
  await assert.rejects(runCollaboration({ conversation, participants: ['deepseek','gpt'], run, signal: new AbortController().signal, onFinal: t => output.push(t), call: async a => { calls.push(a.stage); a.onText(a.stage === 'coordination' ? '{"writer":"unknown"}' : '公开材料'); } }), /无效/);
  assert.equal(run.status, 'error'); assert.ok(!calls.includes('writing')); assert.deepEqual(output, []);
});
test('provider failure aborts its sibling and prevents subsequent stages', async () => {
  const run = createRun(['deepseek','gpt'], config), calls = [];
  await assert.rejects(runCollaboration({ conversation, participants: ['deepseek','gpt'], run, signal: new AbortController().signal, call: async a => {
    calls.push(a.stage);
    if (a.provider === 'deepseek') throw new Error('连接失败');
    await new Promise((resolve, reject) => { if (a.signal.aborted) reject(new Error('stopped')); else a.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
  } }), /连接失败/);
  assert.equal(run.status, 'error'); assert.ok(calls.every(s => s === 'outline')); assert.ok(run.artifacts.every(a => ['error','stopped'].includes(a.status)));
});
test('stop during writing cancels the call and records a stopped run', async () => {
  const controller = new AbortController(), run = createRun(['gpt'], config);
  await assert.rejects(runCollaboration({ conversation, participants: ['gpt'], run, signal: controller.signal, call: async a => { a.onText('已开始'); controller.abort(); throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(run.status, 'stopped'); assert.equal(run.artifacts[0].status, 'stopped');
});
test('schema is passed to CLI and planner cannot select a disabled provider', () => {
  assert.ok(codexArgs({}, 'C:\\schema.json').includes('--output-schema'));
  assert.throws(() => parsePlan(JSON.stringify({ outline: 'x', writer: 'deepseek', instructions: 'x', reason: 'x' }), ['gpt']), /无效/);
  assert.throws(() => parsePlan('not JSON', ['gpt']), /有效/);
});
test('restart preserves public artifacts and recovers unfinished cooperation as stopped', () => {
  const root = path.resolve(__dirname, '../.test-data/unit'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cooperation-'));
  try {
    const s = new Store(dir), c = s.create(), run = createRun(['deepseek','gpt'], config);
    run.artifacts.push({ status: 'done', text: '已保存的大纲' }, { status: 'running', text: '部分评审' });
    c.messages.push({ role: 'assistant', status: 'streaming', text: '', collaboration: run }); s.save();
    const m = new Store(dir).get(c.id).messages[0]; assert.equal(m.status, 'stopped'); assert.equal(m.collaboration.status, 'stopped'); assert.equal(m.collaboration.artifacts[0].text, '已保存的大纲'); assert.equal(m.collaboration.artifacts[1].status, 'stopped');
  } finally { if (!dir.startsWith(root + path.sep)) throw new Error('Unexpected path'); fs.rmSync(dir, { recursive: true }); }
});
