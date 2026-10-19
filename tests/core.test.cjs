const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, validateModels } = require('../core/store.cjs');
const { parseCodex } = require('../core/history.cjs');
const { contextFor, consumeSSE } = require('../core/providers.cjs');
const { deepseekRequest, codexArgs, runDeepseek } = require('../core/providers.cjs');
const { loadWorkspaceCatalog, workspaceId } = require('../core/workspaces.cjs');
const { modelCatalog, validateModelConfig } = require('../core/models.cjs');
const { externalURL } = require('../core/links.cjs');
const testRoot = path.resolve(__dirname, '../.test-data/unit');
fs.mkdirSync(testRoot, { recursive: true });
const temporary = prefix => fs.mkdtempSync(path.join(testRoot, prefix));
test('only explicit web URLs may be opened outside the app', () => {
  assert.equal(externalURL('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', 'ms-settings:', '../relative', null]) assert.throws(() => externalURL(value));
});
function cleanup(dir) {
  if (!path.resolve(dir).startsWith(testRoot + path.sep)) throw new Error('Refusing cleanup outside test directory');
  fs.rmSync(dir, { recursive: true });
}

test('no UI or IPC caller can select zero models, and changes persist', () => {
  const dir = temporary('duet-store-');
  try {
    const s = new Store(dir), c = s.create();
    assert.throws(() => s.updateModels(c.id, []), /至少使用一个模型/);
    assert.deepEqual(s.get(c.id).models, ['deepseek', 'gpt']);
    s.updateModels(c.id, ['gpt']);
    assert.deepEqual(new Store(dir).get(c.id).models, ['gpt']);
    assert.throws(() => validateModels(['unexpected']), /至少使用一个模型/);
  } finally { cleanup(dir); }
});
test('unfinished responses recover as stopped without destroying saved messages', () => {
  const dir = temporary('duet-recovery-');
  try {
    const s = new Store(dir), c = s.create();
    c.messages.push({ role: 'user', text: 'test' }, { role: 'assistant', text: 'partial answer', status: 'streaming' }); s.save();
    const restored = new Store(dir).get(c.id);
    assert.equal(restored.messages[0].text, 'test'); assert.equal(restored.messages[1].status, 'stopped'); assert.equal(restored.messages[1].text, 'partial answer');
  } finally { cleanup(dir); }
});
test('both models share completed answers and exclude failed or unfinished responses', () => {
  const conversation = { messages: [{ role: 'user', text: 'question' }, { role: 'assistant', provider: 'deepseek', text: 'DS answer', status: 'done' }, { role: 'assistant', provider: 'gpt', text: 'GPT answer', status: 'done' }, { role: 'assistant', provider: 'gpt', text: 'failed', status: 'error' }, { role: 'user', text: 'followup' }] };
  assert.deepEqual(contextFor(conversation, 'gpt').map(m => m.content), ['question', 'DS answer', 'GPT answer', 'followup']);
  assert.deepEqual(contextFor(conversation, 'deepseek'), contextFor(conversation, 'gpt'));
});
test('Codex current JSONL history deduplicates items and excludes injected environment', () => {
  const lines = [
    { type: 'session_meta', payload: { id: 'test', cwd: 'C:/demo', timestamp: '2026-10-18T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'env', content: [{ type: 'text', text: '<environment_context>internal</environment_context>' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', text: 'world' } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a', content: [{ type: 'output_text', text: 'world' }] } }
  ].map(JSON.stringify);
  const c = parseCodex([...lines, '{torn'], 'test.jsonl');
  assert.deepEqual(c.messages.map(m => m.text), ['hello', 'world']);
  assert.equal(c.source, 'codex');
});
test('legacy Codex history is readable', () => {
  const lines = [{ type: 'event_msg', payload: { type: 'user_message', message: 'q' } }, { type: 'event_msg', payload: { type: 'agent_message', message: 'a' } }].map(JSON.stringify);
  assert.deepEqual(parseCodex(lines, 'legacy.jsonl').messages.map(m => m.text), ['q', 'a']);
});
test('SSE survives split UTF-8 characters, CRLF, and final line without newline', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"}}]}');
  async function* body() { for (let i = 0; i < bytes.length; i += 2) yield bytes.slice(i, i + 2); }
  const results = []; await consumeSSE(body(), e => results.push(e.choices[0].delta.content));
  assert.deepEqual(results, ['你好', '世界']);
});

test('native workspace membership wins over cwd, with case-insensitive path deduplication and nested folder matching', () => {
  const dir = temporary('workspace-');
  try {
    const codexHome = path.join(dir, 'codex'), dshHome = path.join(dir, 'dsh'); fs.mkdirSync(codexHome); fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: 'Project', rootPaths: ['C:\\Projects\\App'] } }, 'thread-project-assignments': { native: { projectId: 'p' } }, 'projectless-thread-ids': ['loose'] }));
    fs.writeFileSync(path.join(dshHome, 'storages/workspace.json'), JSON.stringify({ tables: { workspaces: { shared: { path: 'c:/projects/app/', title: 'same', sessionIds: ['session-a'] }, nested: { path: 'C:\\Projects\\App\\Sub', title: 'Sub', sessionIds: [] } } } }));
    const conversations = [{ id: 'codex:native', cwd: 'C:\\Other' }, { id: 'dsh:session-a', cwd: 'C:\\Other' }, { id: 'codex:loose', cwd: 'C:\\Projects\\App' }, { id: 'local:nested', cwd: 'c:/projects/APP/sub/src' }];
    const result = loadWorkspaceCatalog(conversations, [], { codexHome, dshHome });
    assert.equal(result.workspaces.length, 3);
    assert.equal(result.assignments['codex:native'], workspaceId('C:\\Projects\\App'));
    assert.equal(result.assignments['dsh:session-a'], result.assignments['codex:native']);
    assert.equal(result.assignments['codex:loose'], 'unassigned');
    assert.equal(result.assignments['local:nested'], workspaceId('C:\\Projects\\App\\Sub'));
    assert.deepEqual(result.workspaces.find(w => w.name === 'Project').sources, ['Codex', 'DSH']);
  } finally { cleanup(dir); }
});
test('empty workspaces remain visible and custom workspace metadata persists with conversations', () => {
  const dir = temporary('workspace-store-');
  try {
    const s = new Store(dir); s.data.workspaces.push({ path: 'C:\\Empty', name: 'Empty' });
    const c = s.create({ workspaceId: workspaceId('C:\\Empty'), cwd: 'C:\\Empty', modelConfig: { gpt: { model: 'test', effort: 'high' } } });
    const restored = new Store(dir);
    assert.equal(restored.data.workspaces.length, 1); assert.equal(restored.get(c.id).modelConfig.gpt.effort, 'high');
    const catalog = loadWorkspaceCatalog([], restored.data.workspaces, { codexHome: path.join(dir, 'missing'), dshHome: path.join(dir, 'missing') });
    assert.equal(catalog.workspaces.find(w => w.name === 'Empty').conversationCount, 0);
  } finally { cleanup(dir); }
});
test('strength is sent as API and CLI parameters, including switching DeepSeek thinking off', () => {
  const c = { messages: [{ role: 'user', text: 'hi' }] };
  for (const effort of ['low', 'high', 'max']) { const body = deepseekRequest(c, { deepseekEffort: effort }); assert.equal(body.reasoning_effort, effort); assert.equal(body.thinking.type, 'enabled'); }
  const off = deepseekRequest(c, { deepseekEffort: 'off' }); assert.equal(off.thinking.type, 'disabled'); assert.equal(off.reasoning_effort, undefined);
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(codexArgs({ gptModel: 'test-model', gptEffort: e }).includes(`model_reasoning_effort="${e}"`));
  assert.throws(() => codexArgs({ gptEffort: 'high;execute' }), /无效/);
});
test('model strength validation follows the model capability list', () => {
  const catalog = { gpt: [{ id: 'limited', efforts: ['low', 'high'] }], deepseek: [{ id: 'deepseek-flash', efforts: ['off', 'low', 'high', 'max'] }] };
  const c = { gpt: { model: 'limited', effort: 'high' }, deepseek: { model: 'deepseek-flash', effort: 'max' } };
  assert.equal(validateModelConfig(c, catalog).gpt.effort, 'high');
  assert.throws(() => validateModelConfig({ ...c, gpt: { model: 'limited', effort: 'xhigh' } }, catalog), /不支持/);
});
test('DeepSeek stream uses the requested strength and never displays reasoning content', async () => {
  let body, answer = '';
  const fixture = 'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n';
  await runDeepseek({ conversation: { messages: [] }, settings: { deepseekEffort: 'max' }, key: 'test-only', signal: new AbortController().signal, onText: t => answer += t, fetchImpl: async (url, options) => { body = JSON.parse(options.body); return new Response(fixture); } });
  assert.equal(body.reasoning_effort, 'max'); assert.equal(answer, 'answer');
});
test('v0.1 sample is hidden without deleting stored messages; real conversations remain', () => {
  const dir = temporary('migration-');
  try {
    fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify({ version: 1, conversations: [{ id: 'sample', messages: [{ role: 'user', text: '功能验证（演示）：双模型桌面工作台' }, { role: 'assistant', text: 'sample', demo: true }] }, { id: 'real', messages: [{ role: 'assistant', text: 'real' }] }] }));
    const s = new Store(dir); assert.deepEqual(s.list().map(c => c.id), ['real']); assert.equal(s.get('sample').messages.length, 2); assert.deepEqual(s.data.workspaces, []);
  } finally { cleanup(dir); }
});
