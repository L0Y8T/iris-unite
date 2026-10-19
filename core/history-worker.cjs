const { parentPort } = require('node:worker_threads');
const history = require('./history.cjs');
parentPort.on('message', async ({ id, action, item }) => {
  try {
    const result = action === 'list' ? await Promise.all([history.listCodex(), history.listDsh()]).then(parts => ({ items: parts.flatMap(p => p.items).sort((a, b) => b.updatedAt - a.updatedAt), errors: parts.flatMap(p => p.errors) })) : await history.readHistory(item);
    parentPort.postMessage({ id, result });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
