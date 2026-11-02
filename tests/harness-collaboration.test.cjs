/* 普通多模型协作接入装配层的验收。
 *
 * 0.6 的做法：每个阶段把上一阶段的全部材料 JSON.stringify 进每个参与者的 prompt。
 * 1.0 的做法：材料摊平成独立项，长项溢出留句柄，产物同时落盘。
 *
 * 两件事同时验：注入工作区走新路径，不注入时行为一个字都不变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRun, runCollaboration, PLAN_SCHEMA } = require('../core/collaboration.cjs');
const { openWorkspace } = require('../core/harness/workspace.cjs');
const ids = require('../core/harness/ids.cjs');

const config = { deepseek: { model: 'deepseek-flash', effort: 'low' }, gpt: { model: 'gpt-6.1-sol', effort: 'low' } };
const conversation = { messages: [{ role: 'user', text: '本次问题' }] };
const plan = { outline: '最终大纲', writer: 'gpt', instructions: '完整写作要求', reason: '依据修订质量选择' };

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-collab-'));
}

/** 跑一轮双模型协作，返回每阶段收到的 prompt 与全部事件。 */
async function runOnce({ workspace }) {
  const participants = ['deepseek', 'gpt'];
  const run = createRun(participants, config);
  const prompts = [];
  const calls = [];
  await runCollaboration({
    conversation, participants, run, signal: new AbortController().signal, workspace,
    call: async args => {
      const { provider, stage, messages, onText, outputSchema } = args;
      calls.push({ provider, stage });
      prompts.push({ stage, content: messages.at(-1).content });
      if (stage === 'coordination') { assert.deepEqual(outputSchema, PLAN_SCHEMA); return onText(JSON.stringify(plan)); }
      if (stage === 'writing') return onText('完整答案正文。');
      return onText(`${provider}-${stage}-内容`);
    }
  });
  return { run, prompts, calls };
}

test('注入工作区：材料摊平成装配文本，不再整份 JSON 塞进 prompt', async () => {
  const workspace = openWorkspace({ root: tempRoot(), runId: ids.newRunId() });
  const { run, prompts } = await runOnce({ workspace });

  const review = prompts.find(item => item.stage === 'review');
  assert.match(review.content, /【材料】/);
  assert.match(review.content, /\[M1\]/);
  assert.ok(!review.content.includes('协作资料（JSON 数据）'), '新路径不该再出现 JSON 段');
  assert.ok(!review.content.includes('{"outlines"'), '不该把 outlines 对象整份序列化进去');
  // 摊平后应看得到"哪个模型的大纲"这一层信息，而不是一个裸的 key。
  assert.match(review.content, /outlines · deepseek|outlines · gpt/);

  assert.equal(run.status, 'done');
  assert.equal(run.writer, 'gpt');
});

test('注入工作区：每个阶段的产物都落盘并带回 art- id', async () => {
  const workspace = openWorkspace({ root: tempRoot(), runId: ids.newRunId() });
  const { run } = await runOnce({ workspace });

  const records = workspace.listArtifacts();
  assert.equal(records.length, 8, `双模型五阶段应有 8 条产物，实际 ${records.length}`);
  const withIds = run.artifacts.filter(artifact => artifact.artifactId);
  assert.equal(withIds.length, 8);
  for (const artifact of withIds) {
    assert.ok(ids.isArtifactId(artifact.artifactId));
    assert.ok(fs.existsSync(path.join(workspace.dir, artifact.file)));
  }
  assert.deepEqual(workspace.verifyArtifacts(), { ok: true, checked: 8, problems: [] });

  const finals = workspace.listArtifacts({ kind: 'final' });
  assert.equal(finals.length, 1, '最终答案单独落盘一份');
  assert.equal(workspace.readArtifact(finals[0].id).text, '完整答案正文。');
});

test('不注入工作区：材料仍是 0.6 的 JSON 格式，一个字节都不变', async () => {
  const { run, prompts } = await runOnce({ workspace: null });
  const review = prompts.find(item => item.stage === 'review');
  assert.match(review.content, /协作资料（JSON 数据）：/);
  const material = JSON.parse(review.content.split('协作资料（JSON 数据）：\n')[1]);
  assert.deepEqual(material.outlines, { deepseek: 'deepseek-outline-内容', gpt: 'gpt-outline-内容' });

  assert.ok(run.artifacts.every(artifact => artifact.file === undefined));
  assert.ok(run.artifacts.every(artifact => artifact.artifactId === undefined));
});

test('长材料溢出后给出续读句柄，短材料仍然全文内联', async () => {
  const workspace = openWorkspace({ root: tempRoot(), runId: ids.newRunId() });
  const participants = ['deepseek', 'gpt'];
  const run = createRun(participants, config);
  const huge = '长材料开头。' + '论'.repeat(9000) + '长材料结尾。';
  const prompts = [];
  await runCollaboration({
    conversation, participants, run, signal: new AbortController().signal, workspace,
    call: async ({ provider, stage, messages, onText, outputSchema }) => {
      prompts.push({ stage, content: messages.at(-1).content });
      if (stage === 'outline') return onText(huge);
      if (stage === 'coordination') return onText(JSON.stringify(plan));
      if (stage === 'writing') return onText('答案。');
      return onText(`${provider}-${stage}`);
    }
  });

  const review = prompts.find(item => item.stage === 'review');
  assert.match(review.content, /read_artifact id=art-[0-9a-f]{8} offset=\d+/, '超长材料必须带续读句柄');
  assert.ok(!review.content.includes(huge), '超长材料不该整段出现');
  assert.match(review.content, /\[M1\] reviewer/, '短材料仍应全文内联');
});
