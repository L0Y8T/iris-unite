/* 执行 driver：这一层是"怎么跑"与"跑什么"的分界。
 *
 * 为什么要它：受控模板（E1）与将来的 WSL2 容器（E2）、远程容器（E3）跑的是同一批
 * 模板、同一套运行记录、同一个界面，区别只有"在哪儿跑、用什么隔离"。把差异收进
 * driver，运行期、IPC、界面都只认接口，加 E2 时不用改它们。
 *
 * driver 接口：
 *   id / name / description               标识与说明
 *   isolation / network                   隔离与网络的**实际情况**，必须如实写（界面会显示）
 *   supports(template) => boolean         这个模板该不该由我跑
 *   prepare({template, dataRoot, onLog})  准备执行环境，返回任意上下文（环境句柄）
 *   run({template, params, dataRoot, env, timeoutSec, signal, onEvent, conversationId})
 *                                        返回 { manifest, runDir }
 *
 * 纯装配，不实现具体执行逻辑。
 */
const templates = require('./templates.cjs');
const { ensureEnv } = require('./env.cjs');
const { runExperiment } = require('./runner.cjs');

const templatePython = {
  id: 'template-python',
  name: '受控模板 · 本机 Python',
  description: '跑随程序分发的模板脚本：参数白名单、独立 venv、超时与取消会杀掉整棵进程树。',
  isolation: 'none',
  network: 'allowed',
  supports: template => !template.driver || template.driver === 'template-python',
  prepare: ({ template, dataRoot, onLog }) => ensureEnv({ packages: template.requires.packages, rootDir: dataRoot, onLog }),
  run: ({ template, params, dataRoot, env, timeoutSec, signal, onEvent, conversationId }) => runExperiment({
    templateId: template.id,
    params,
    dataRoot,
    env,
    timeoutSec,
    signal,
    onEvent,
    conversationId
  })
};

/* E2 的容器 driver 会加进来；现在只有本地受控模板一种。 */
const DRIVERS = Object.freeze([templatePython]);

function resolve(template) {
  const driver = DRIVERS.find(candidate => candidate.supports(template));
  if (!driver) {
    throw new Error(`模板「${template?.name || template?.id}」需要的执行环境（${template?.driver || 'template-python'}）本期尚未提供`);
  }
  return driver;
}

/** 给界面用的 driver 清单：隔离与网络状况如实标出，不美化。 */
function describe() {
  return DRIVERS.map(driver => ({
    id: driver.id,
    name: driver.name,
    description: driver.description,
    isolation: driver.isolation,
    network: driver.network
  }));
}

module.exports = { DRIVERS, resolve, describe };
