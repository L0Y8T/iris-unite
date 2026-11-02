# Iris Unite 1.0 harness 架构

> 版本 1.0.0 ｜ 本文是新架构的唯一真源。与 `docs/research-mode-design.md` 冲突时以本文为准，
> 但旧的阶段语义（16 个环节的职责）继续沿用，只改数据流与执行方式。

## 一、为什么改：三个可测的现状问题

这三条都是读代码得出的，不是印象。

| 问题 | 证据 | 后果 |
|---|---|---|
| 上下文全量广播 | `core/collaboration.cjs:41`、`core/research.cjs:506` 都把上一阶段全部产物 `JSON.stringify` 进 prompt；再接 24 万字符历史（`core/providers.cjs:54`） | token 随"阶段数 × 模型数"平方增长；预算模型只数调用次数（`core/budget.cjs`），成本完全在预算之外 |
| 模型只能说话，不能动手 | 连接层不提供工具调用协议；科研里唯一碰真实世界的是 `core/exec/*`，但它由编排代码直接调用，模型碰不到 | 十个环节产出的都是"文字意见"，没有一步能验证自己的结论 |
| 长任务阻塞 + 状态无终态 | 实验在 `research.cjs:608-627` 串行 `await`；`reply.status` 初始 `'streaming'`（`main.cjs:593`），只有成功/异常分支才改 | 单个实验超过 10 分钟会被自己的看门狗杀掉（`run.lastActivityAt` 在 trial 期间不更新）；崩溃后该对话永久无法重试 |

## 二、harness 六部件与模块映射

| 部件 | 解决的问题 | 模块 | 状态 |
|---|---|---|---|
| 循环驱动 | "调模型→执行→回灌→继续"的生命周期 | `core/harness/loop.cjs` | 已完成 |
| 工具层 | 把动作变成受控调用 | `core/harness/tools/registry.cjs`、`tools/index.cjs` | 已完成 |
| 调用协议 | 不依赖 provider tools 字段的动作请求 | `core/harness/protocol.cjs` | 已完成 |
| 共享工作区 | 产物落盘、摘要、按需读取 | `core/harness/workspace.cjs` | 已完成 |
| 上下文装配 | Inline & Spill | `core/harness/context.cjs` | 已完成 |
| 账本 | 可回放、可审计 | `core/harness/ledger.cjs` | 已完成 |
| 异步长任务 | 实验不再阻塞整轮 | `core/harness/jobs.cjs` | 已完成（内核）／预约接入 |
| 阶段门禁 | 每步产物必须可机判 | 复用 `exec/claims.cjs` + `verify_claims` 工具 | 已完成（数字门禁） |
| 编排 | 把计划节点跑成 agent 步骤 | `core/research.cjs` 的收口环节 | 已完成（收口）／其余节点沿用串行 |

## 三、数据流

改造前：

```
阶段 N 产物（内存对象）
      ↓ JSON.stringify 进每个参与者的 prompt
阶段 N+1（每个参与者各读一份全量）
      ↓
最终答案（中间产物随 conversations.json 一起膨胀）
```

改造后：

```
阶段 N 产物 ──写盘──> runs/<runId>/artifacts/<stage>/<artifactId>.md
                                │  索引：id / sha256 / 摘要 / 信号 / refs
                                ↓
阶段 N+1 装配上下文：摘要 + 句柄（Inline & Spill）
                                ↓
模型用 read_artifact / search_artifacts 按需取细节
                                ↓
循环到模型给出最终结果（账本记下每一步）
```

三条不变式：

1. **产物不可变**。要改就写新产物，用 `refs` 指向旧的。这是可审计的前提。
2. **摘要只在落盘时算一次**。重算会让同一产物在不同阶段摘要不同，账本对不上。
3. **账本只追加**。崩了也能读到崩前最后一毫秒。

运行目录会增长，所以启动时按创建顺序清理，保留最近 50 个（`pruneRuns`）；
正在运行的那个即使最旧也不会被删——它的账本与产物正在被写。

## 四、工具协议

不用各家 provider 的 `tools` 字段，理由是可核对的：四条通道里 GPT 走 `codex exec` 子进程
（`core/providers.cjs:129`），它自带工具与只读沙箱，无法按同一协议逐次调用；自定义连接只声明
`openai` / `anthropic` 两种文字协议（`core/connections.cjs:19`），加 tools 属跨版本 schema 变更。

协议形状：

````text
```tool
{"calls":[{"name":"read_artifact","args":{"id":"art-1f4c7d9e","offset":1200}}]}
```
````

- 不带 tool 块的正文 = 这一轮的交付内容。
- 解析器同时接受 `{calls:[…]}`、`{name,args}`、顶层数组三种写法，以及 `tool`/`arguments` 别名。
  模型漂移出格式时，照它写的执行比严词拒绝有用。
- 流式嗅探（`ToolSniffer`）保证最终答案逐字到达界面，而工具轮里的 JSON 不会漏给用户。
- 每轮最多 `maxSteps`（默认 8）次往返，最后一轮会显式下最后通牒。

**代价要写明**：GPT 通道无法逐工具调用，它对协议的表现是"一次调用做完一整段"。同一个编排层
因此有两种执行形态，这是接受的设计，不是遗漏。

## 五、工具的权限分级

| 权限 | 含义 | 现有工具 |
|---|---|---|
| `read` | 只读工作区或既有记录 | `read_artifact`、`list_artifacts`、`search_artifacts`、`check_integrity`、`verify_claims`、`list_templates`、`check_budget` |
| `write` | 写工作区，不触外部世界 | `write_note` |
| `execute` | 起子进程 | `run_experiment` |
| `network` | 出网 | `search_literature` |

**能力靠注入，不靠 import**：没注入 `runExperiment` 的调用方，`run_experiment` 根本不会出现在
它的工具清单里。模型不会去尝试一个注定失败的动作，提示词也不会为不存在的能力花 token。

## 六、与现有实现的兼容

三条原则：

1. **旧模块不动契约**。`core/collaboration.cjs` 与 `core/research.cjs` 的对外行为、事件序列、
   参数形状全部保持不变——`tests/collaboration.test.cjs`（调用序列、8 个 artifact、stageIndex 1..5）
   与 `tests/research.test.cjs`（预算门禁、引用剔除、三类失败不中止）继续作为门槛。
2. **新能力按 opt-in 接入**。harness 引擎先作为可选路径（配置开关），跑通并验收后再切换默认。
3. **`call` 适配器一行不改**。`loop.cjs` 用的就是 main.cjs 现有的
   `{provider, stage, messages, signal, onText, outputSchema}` 签名。

## 七、分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| M0 | 工作区、账本、上下文装配 | `tests/harness-core.test.cjs` 17 项 |
| M1 | 工具注册表、协议、循环、文件与核验工具 | `tests/harness-loop.test.cjs` 23 项 |
| M2 | 异步 job 调度（并发上限、排队、取消、心跳、崩溃恢复） | `tests/harness-jobs.test.cjs` 10 项 |
| M2b | 实验并行 + trial 心跳 + 产物落盘 | `tests/experiment-concurrency.test.cjs` 5 项、`tests/harness-workspace-integration.test.cjs` 4 项 |
| M3 | 收口环节跑在 loop 上；普通协作材料走装配 | `tests/harness-final-tools.test.cjs` 4 项、`tests/harness-collaboration.test.cjs` 4 项 |
| M4 | 前端：工具事件、装配摘要、产物指纹 | `frontend-check` + `dsh-visual-check`（axe 0 违规） |
| M5 | 文档、CHANGELOG、全量验收 | `npm run test:all -- --skip-live` 16 项全绿 |
| **1.1** | 重试、并行安全、门禁、账本导出、装配预算可配 | `npm test` 329 项 + 两次真实模型实证 |

已完成到 M5 与 1.1 前五条。

### 一条实测结论：装配预算决定工具循环的死活

真调 `deepseek-flash` 跑同一份 p1-review 配置，只改 `harness.assemble.itemInline`：

| | 6000（默认） | 2000 |
|---|---|---|
| 溢出项 | 0 | 4 |
| 模型工具调用 | 0 | **4 次 read_artifact，全成功、均 13ms** |
| harnessSteps | 1 | 2 |

**材料不溢出，模型就没有理由调工具，工具循环等于死代码。**
这解释了 1.0 上线后真实账本里 `tool.call` 一条都没有——不是循环坏了，是预算太大、材料太小。
所以 `harness.assemble` 必须可配：它不只是省钱开关，更是**工具循环的开关**。

### 为什么只给收口环节开工具

收口是唯一"必须读遍全部材料才能落笔"的节点，也是唯一可能引用实验数字的地方，
所以它最需要按需读取与 `verify_claims`。
中间环节（界定、分解、探索、筛选）的输入是结构化的、彼此独立的，接工具只会增加往返次数，
不改变结论质量。判定标准写在这里，是为了避免以后"顺手全接上"。

## 八、明确不做

| 不做 | 理由 |
|---|---|
| Router/Worker 双层常驻调度 | 那解决的是"人的注意力在多任务间被切碎"，Iris Unite 是单任务工作台，加一层调度只增加状态 |
| Trigger / Thread / Ticket / Mandate 领域模型 | 为多来源事件流的工单系统设计，复杂度全在授权与幂等上 |
| 存算分离 | 桌面单机没有"算力在云端"这个前提 |
| 用 provider 原生 tools 字段 | GPT 通道做不到，会造成两套并行协议 |
