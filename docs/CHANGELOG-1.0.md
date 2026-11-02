# Iris Unite 1.0.0 变更说明

1.0 不是功能堆叠，而是把「多模型对话」改造成「多模型 agent harness」：
模型从只能说话，变成能读产物、能跑实验、能自己核验数字。
架构与取舍见 `docs/harness/architecture.md`。

## 一句话

上下文从「每阶段把全部产物 JSON 塞进每个参与者的 prompt」改成「摘要 + 句柄，按需读取」；
收口环节可以调用工具；实验并行跑；产物落盘且可校验；运行有账本。

## 新增：harness 层（`core/harness/`）

| 模块 | 作用 |
|---|---|
| `workspace.cjs` | 一次运行一个目录：产物不可变落盘、sha256、摘要、按字符偏移续读 |
| `ledger.cjs` | 只追加 JSONL 账本，记录每次调用、工具、产物；崩溃后能读到崩前最后一条 |
| `context.cjs` | Inline & Spill 装配：短材料内联，长材料只给首尾 + 续读句柄，超预算按占用降级 |
| `protocol.cjs` | 工具调用文本协议 + 流式嗅探（工具轮的 JSON 不漏给用户） |
| `tools/` | 工具注册表与 10 个工具（读/列/搜产物、写笔记、完整性校验、数字核验、模板、预算、跑实验、检索） |
| `loop.cjs` | agent 循环：调模型 → 解析工具请求 → 执行 → 回灌 → 继续，带迭代上限与最后通牒 |
| `jobs.cjs` | 异步任务调度：并发上限、排队、单独取消、心跳、崩溃恢复标记 interrupted |

## 改变：两个流程都走装配

- **普通协作**：`review` / `synthesis` / `coordination` 收到的材料由「整份 JSON」改为摊平后的独立项。
  长材料溢出后给出可直接照抄的续读句柄 `read_artifact id=art-xxxxxxxx offset=1200`。
- **科研收口**：`research-final` 走 agent 循环，模型可以先 `list_artifacts` 看有哪些材料，
  再按需 `read_artifact` 读细节，而不是被全量材料淹没。
  事件流新增 `context`（装配摘要）与 `tool`（工具调用）。

两条路径都是**注入工作区才启用**：不注入时行为与 0.6 完全一致，
所以既有调用方与既有测试零影响。

## 修复

| 问题 | 原来 | 现在 |
|---|---|---|
| 长实验被误杀 | `run.lastActivityAt` 只在 trial 结束与模型返回时刷新，单个 trial 超过 10 分钟会被停滞看门狗判成卡死然后 abort | 执行器每产出一条事件就回调心跳（`onActivity`），进行中的实验不再被当成停滞 |
| 实验串行 | 多个 trial 逐个 `await`，墙钟时间线性叠加 | 批内并行、批间串行（默认并发 2，可配 1–4）；预算检查仍在每批开始前，结果顺序仍按设计顺序（E 编号不受影响） |
| 中间产物随对话膨胀 | `artifacts[].text` 存全文进 `conversations.json`，每次保存整份重写 | 产物同时落盘到 `runs/<runId>/`，artifact 上带回 `artifactId` / `file` / `sha256` |
| sha256 只记不验 | `manifest.validate` 只检查字段非空 | 工作区提供 `verifyArtifacts()`，逐条重算比对；模型也能通过 `check_integrity` 工具自查 |

## 界面

- 过程面板顶部显示「上下文装配 N 字符（预算 M）：内联 x 项、溢出 y 项」。
- 显示工具调用次数与每次的名字/成败。
- 已落盘的产物在条目底部显示 `产物 art-xxxxxxxx · N 字 · sha 前 8 位`。

## 配置

| 键 | 含义 | 默认 |
|---|---|---|
| `experiments.concurrency` | 同时跑几个 trial，1 即旧的串行行为（排障开关） | 2（上限 4） |
| `harness.tools` | 收口环节是否启用工具循环 | 开（缺省即开；显式 `false` 退回 0.6 全量材料） |

## 升级注意

- 新增数据目录 `<数据根>/runs/`：每次运行一个子目录。删掉它不会影响任何既有数据，只会丢掉按需读取能力。
- `conversations.json` 结构未变（仍是 version 3），旧记录直接可用。
- 版本号从 0.6.0 升到 1.0.0；`tests/packaged-check.cjs` 里写死的 `0.6.0` 指的是已发布的旧安装包，
  重新打包后应一并更新。

## 验证

- 单元测试 272 项全通过（0.6 是 208 项，新增 64 项覆盖 harness 各层）。
- `npm run test:all -- --skip-live` 16 项全通过，含 Electron 端到端、真跑 Python、axe 可访问性 0 违规。
