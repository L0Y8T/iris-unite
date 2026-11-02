# Iris Unite 1.1.0 变更说明

1.0 把「多模型对话」改造成「多模型 agent harness」。1.1 补的是**失败处理完备度**——
四条任务全部指向同一件事：让系统在出错、花冤枉钱、长材料时不像 1.0 那样脆。

架构见 `docs/harness/architecture.md`。

## 一句话

模型调用会重试、工具并行有显式安全声明、花钱的执行要人点头、阶段有准入检查、
账本能导出分析；装配预算从写死变成可配置，并且**装配预算直接决定工具循环是否被使用**。

## 新增

| 模块 | 作用 |
|---|---|
| `core/llm-retry.cjs` | 判定 + 退避单独成文件（`main.cjs` 依赖 electron，`node --test` 加载不了它）。退避 `[1s, 2s, 4s]`，只重试 429 / 5xx / 网络抖动 |
| `core/harness/gates.cjs` | 阶段准入门禁：`defineGate` / `runGates` / `DEFAULT_GATES`，四条机械检查 |
| `core/harness/ledger-report.cjs` | 账本摘要 + CLI：`node core/harness/ledger-report.cjs <runDir>` |
| `core/harness/compaction.cjs` | 历史压缩：`compact()` 纯函数 + `historyFor()` 适配；先取未截断的全量消息再压 |

## 改变

**模型调用**：`providers.cjs` 与 `custom-provider.cjs` 的 throw 改为挂 `status` / `code` 属性，
重试按属性判定而不是解析中文消息。重试对上层透明（`usage.calls` 只加一次），
已经吐出正文的尝试不再重试（宁可报错，不交付叠字稿）。

**工具执行**：`registry.define` 增加 `parallelSafe`（默认 true），`run_experiment` 标 false；
`loop.cjs` 改成分组屏障——连续的安全调用并发，不安全调用单独跑并形成屏障。
回灌顺序仍等于模型给出的调用顺序。

**花钱的动作要人点头**：`registry.define` 增加 `requiresConfirmation`（默认 false），
只有 `run_experiment` 标 true。`loop.cjs` 在 `toolbox.invoke` 之前调 `confirm`，
**没注入 confirm 即当作拒绝**（安全默认）；拒绝不抛错、回灌「用户拒绝了这次执行」、
循环继续到 final。`main.cjs` 用原生 `dialog.showMessageBox`，5 分钟超时与窗口关闭都按拒绝。

**历史压缩**：`history = contextFor(conversation)` 改为 `summarize ? historyFor(...) : contextFor(...)`。
`historyFor` **先取未截断的全量消息再压**——先 `contextFor` 再压等于永远不超预算，
压缩就成了空转（和「材料太小、装配预算等于没设」是同一课）。
压缩发生时发 `{ kind:'compaction' }` 事件、记账本、挂 `run.compaction`；摘要用 `deepseek + off`。

**装配预算**：`config.harness.assemble` 可覆盖 `total` / `itemInline` / `itemHead` / `itemTail`，
非法值忽略退回默认。这是 1.1 最重要的一处，因为——

## 实测发现：装配预算决定工具循环的死活

真调 `deepseek-flash` 跑 p1-review 档（不开检索与实验），同一份配置只改 `itemInline`：

| | 默认 6000 | 设为 2000 |
|---|---|---|
| 装配结果 | 8 项全内联、14448 字符 | 4 项溢出、10368 字符 |
| 模型工具调用 | **0 次** | **4 次 `read_artifact`，全成功、均 13ms** |
| 账本类型 | `artifact.write` + `loop.final` | 外加 `tool.call` × 4 + `loop.tools` × 1 |
| harnessSteps | 1 | 2 |

**材料不溢出，模型就没有任何理由调工具，工具循环等于死代码。**
这解释了 1.0 上线后真实账本里 `tool.call` 一条都没有——不是循环坏了，
是预算太大、材料太小。四次 `read_artifact` 落在同一个 step，也顺带验证了并行安全分类生效。

## 修复

| 问题 | 说明 |
|---|---|
| 收口循环不记账本 | 1.0 的 `requestWithTools` 没把账本传给 `runAgentLoop`，工具往返与收尾全都不留痕。查账本会得出「工具从未被调用」的错误结论。现在接上 `workspace.appendLedger`，记账失败不阻断循环 |
| `run_experiment` 必失败 | `tools/index.cjs` 传的键是 `template`，`main.cjs` 的 `experimentTools.run` 解构的是 `templateId`，真机路径上 `templateById(undefined)` 会抛「未知的实验模板：undefined」。单元测试用假执行器发现不了。已改为 `templateId`，并把 `tests/tool-confirm.test.cjs` 的假执行器与断言一起对齐 |
| `retry-check` 的失败场景失效 | 假服务器原来返回 500 验「重跑失败、旧答案保留」；500 现在是可重试错误，重试发来的下一次请求被当成新的正常请求返回 200，「失败」变「成功」。改成 401（不可重试） |

## 配置

| 键 | 含义 | 默认 |
|---|---|---|
| `harness.tools` | 收口是否走 agent 循环 | 开（显式 `false` 退回 1.0 全量材料） |
| `harness.gates` | 是否启用阶段准入门禁 | **关**（灰度，显式 true 才启用） |
| `harness.assemble.total` | 装配总预算（字符） | 120000 |
| `harness.assemble.itemInline` | 单项全文内联上限 | 6000 |
| `harness.assemble.itemHead` / `itemTail` | 溢出项保留的首尾长度 | 1200 / 400 |

`run_experiment` 的确认闸无需配置，默认对 `run_experiment` 生效；不注入 `confirm` 通道时一律拒绝。

## 验证

- `npm test` **354 项全过**（1.0 基线 274 → 1.1 新增 80 项）
- `npm run test:all -- --skip-live` **16 项全过**
- 真实模型实证两次（装配预算对比），数字见上表
- 真材料压缩实测（`scripts/compaction-real-check.cjs`）：
  造 250000 字（50 条）→ 压掉 84846 字（17 条 → 1 条摘要）→ 剩 165154 字，
  占用降到预算的 68.8%，最近 6 条原文保留，标记格式可识别

## 已知缺口

- `harness.gates` 默认关闭，当前对真实运行零影响，要用得显式打开
- `tool.call` 不记账 `chars`，账本导出里工具「总字符」一列恒为 0
- **确认闸与压缩尚未在真实对话里触发过**：确认闸需要真跑一次 `run_experiment`（要开实验档），
  压缩需要真实对话历史超过 24 万字符。两者目前只有测试与脚本级证据
- 摘要用 `deepseek + off` 直接走 providers，不经过 `call` 适配器，因此这次 token 不计入 usage
