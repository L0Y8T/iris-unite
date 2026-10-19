# 0.6.0 变更说明

0.5.0 是一个双模型对话工作台，带一个固定三层架构的科研模式。0.6.0 把它改造成能公开发布的科研工具。本文只写**实际改了什么、怎么验证的、还有什么没做**。

> 本轮（M0+M1）新增的部分见第 9、10 节：重试与发布的正确性修复、三档 Profile 与计划驱动的运行器。

## 1. 科研流程：从检索开始

新增三个前置环节，并把校验拆成独立环节：

| 环节 | 类型 | 说明 |
| --- | --- | --- |
| 研究界定 | 模型 | 产出研究问题、检索式、纳入/排除标准 |
| 资料检索 | 本地 | 真实调用 OpenAlex / Crossref / arXiv / PubMed，建立资料库 |
| 证据提取 | 模型 | 只从资料库抽取结论、证据强度与缺口，无效引用键被剔除 |
| 问题分解 | 模型 | 原「统筹」环节 |
| 并行研究 | 模型 | 1–4 项任务，各自独立选模型 |
| 候选筛选 | 模型 | 原「筛选」环节，新增指出缺乏证据的结论 |
| 定向深化 | 模型 | 预算不足时跳过并写明原因 |
| 反证与整合 | 模型 | 原「终审」环节 |
| 引用核验 | 本地 | 逐个核对引用，无法核验的当场移除 |
| 终审自检 | 本地 | 预算、证据覆盖、编造痕迹；可选加一次模型复核 |

调用预算上下限从 4–16 改为「任务数+5」–24。检索与两个校验环节不消耗预算。

## 2. 每个环节的模型都可选

- 统筹（问题分解）与终审（反证与整合）不再锁死 GPT，任何启用的通道都能用。校验函数不再有 `onlyGpt` 参数。
- 配置结构升到 `version: 3`：`choices.{scope,evidence,plan,screen,final,audit}` + `tasks[].choice`。
- 0.5.0 的旧配置（`orchestrator` / `reviewer`）在读取时自动升级，用户的原有选择不丢。

## 3. 接入市面主流服务

- 新增 15 个服务商预设（`core/presets.cjs`），选中即填好地址、接口格式与推理参数形态。
- 新增「拉取模型列表」：GET `{baseUrl}/models`，兼容 OpenAI / Anthropic / 裸数组三种返回形态，失败也不影响手填。
- 模型 ID 长度校验统一为 150 字符（原来连接表单 150、模型配置 100，导致「存得进连接、选不上模型」）。
- 错误提示按状态码给出可执行原因（401 密钥、402 余额、403 权限、404 地址或模型 ID、429 限流）。

## 4. 引用可核验（新增 `core/citation.cjs`）

- 提取三类引用：`[S3]` 式引用键、DOI、arXiv 号，并把作者-年份式引用单独统计为可疑项。
- 与资料库逐条比对：DOI 归一化后精确匹配、arXiv 去版本号后匹配、引用键按 S 编号匹配。
- 未通过核验的引用被改写为「未核实引用」，答案正文用改写后的版本替换流式过程中那份。
- 自带 `selfTest()`：先验证检查器自身在固定样例上判断正确，避免「检查报了坏消息，先怀疑检查」。
- 1 MB 对抗性输入（纯括号、17 万个引用记号）实测不回溯爆炸。

## 5. 运行监控（新增 `core/monitor.cjs`）

纯内存、无 IO、无定时器，由调用方 tick 驱动。规则：停滞、重复产物、反复失败、预算提醒、无进展判完成。破坏性动作两次确认才执行；一条异常在状态未变时不重复刷屏。

停滞看门狗单独用墙钟跑在主进程：调用在飞行中时阶段边界观察不到它，只能靠定时检查最近一次增量时间。

## 6. 顺带修掉的问题

| 问题 | 处理 |
| --- | --- |
| 个人数据存在程序目录 | 正式版迁到 `%APPDATA%\IrisUnite`，首次启动自动迁移并留 `migrated-from.json` |
| 不能删除对话 | 新增 `duet:delete` + 工具栏删除按钮（带标题确认） |
| 不能重新生成 | 新增 `duet:retry`，删掉上一轮后重跑同一问题 |
| 侧栏搜索只搜标题 | 新增 `duet:search`，正文命中也会出现在结果里 |
| DeepSeek 内置通道不识别输出截断 | 检测 `finish_reason === 'length'` 并报错 |
| 共享上下文按 40 条截断 | 改为按字符预算（默认 24 万字符），避免长消息撑爆 |
| 普通协作无调用上限 | 3N+2 次预计调用超过上限（默认 24）直接拒绝并说明 |
| 没有用量统计 | 累计通道真实返回的 token，显示在答案页脚（不估算、不编造） |
| 图标 CC BY 署名缺失 | `LICENSE`、README、打包内 `renderer/vendor/licenses/iris-icon.txt` 三处补上 |
| 无许可证 | 加 MIT `LICENSE`，`package.json` 改为 `"license": "MIT"` |
| 交接文档在 gitignore 里 | 移到 `docs/handoff-0.5.md`，`.gitignore` 不再忽略 `docs/` |

## 7. 验证证据

| 项 | 结果 |
| --- | --- |
| `npm test` | 77 项通过（原 35 项 + 新增 retrieval 14 / citation 14 / monitor 11 + 重写的 research 测试） |
| 真实检索 | 一次真实请求：927 ms，4 条记录，4 个真实 DOI，0 错误 |
| 重新生成功能 | `node tests/retry-check.cjs`：本地假模型服务，3 次请求，重跑后仍是 1 条用户消息 + 1 条回答，生成中重跑被拒绝 |
| arXiv 熔断 | 4 条检索式实测：修前 106.5 秒（4 次全部失败），修后 29.7 秒（失败 2 次后跳过），记录数不变 |
| 界面验收 | `node tests/dsh-visual-check.cjs`：17 张截图、15 次 axe 审核全部 0 违规，320/768 像素不溢出，科研配置与连接对话框均覆盖 |
| 架构图 | `npm run diagram` 从 `core/research.cjs` 的 `STAGES` 生成，改代码重跑即可同步 |

## 8. 没做的

- 引用核验只在「引用是否指得回真实记录」这一层，**不判断文献是否支持该结论**；语义级核对需要人工或多模型对抗，本版没做。
- 作者-年份式引用无法机械核验，只统计不清除。
- 检索不覆盖付费数据库、专利库与全文 PDF；用接口返回的摘要，不是全文。
- 没有安装器、代码签名、自动更新。
- 科研模式不执行实验、不运行代码。
- `monitor.cjs` 的 `retry-cheaper`（降强度重试）目前只记录建议，没有自动降低强度重发——降级需要知道模型支持的强度集合，而这一信息在主进程的 catalog 里，不在流程层。

## 9. M0：重试与发布的正确性

| 问题 | 修法 | 验收 |
| --- | --- | --- |
| 重新生成会删掉上一版答案 | 旧答案保留并标 `supersededBy`，只有新答案成功才标记；失败时旧答案继续可见 | `tests/retry-check.cjs`：成功=3 条消息（1 问 2 答）、失败=4 条且上一版仍 `done`、生成中重跑被拒 |
| 未核验文本直接进正文 | 科研模式的最终正文先写 `draftText`，界面只显示「待核验 · N 字」；核验与自检完成后才发布 | `tests/research-run-check.cjs`：整轮结束前正文长度恒为 0，结束后才出现 |
| 列模型时复用旧密钥 | 端点或协议变了就不再用同一连接已保存的密钥，响应带 `keySource` | 代码审查 + `duet:model-list` 返回值 |
| 「没核验」被说成「已移除 0 处引用」 | 三态分开：未核验 / 核验通过 / 移除 N 处 | 同上，`tests/research-run-check.cjs` 断言未启用检索时自检项为 false 且写明原因 |

## 10. M1：三档 Profile 与计划驱动

- 新增 `core/profiles.cjs`：三档（速查/综述/教学）、角色→环节映射、预算公式、v2/v3→v4 确定性迁移。
- 新增 `core/plan.cjs`：`compileConfigPlan`（纯计算，`planVersion` 由配置哈希决定）、`activeNodes` 条件求值、`deriveEffectivePlan`（外部能力只影响覆盖度，不改计划版本）、`readiness`。
- 新增 `core/budget.cjs`：调用账本，占位在发出前，失败照样计数，为收口保留额度，可选环节要过 `canStartOptional`。
- 运行器 `core/research.cjs` 改为计划驱动：跑哪些环节由 `activeNodes` 决定，不再出现散落的 `if (config.retrieval.enabled)`；新增 `research-summarize` 环节让速查档真正闭环；预算检查走账本。
- 配置结构升到 `version: 4`（档位 + `choices` + `tasks` + `budget` + `retrieval` + `evidence` + `teaching` + `mech` + `output`），旧配置读取时自动迁移且不改用户预算数值。
- 界面：档位三选一、档位下方常驻**计划预览**（环节数、基准/上限/保留、检索覆盖、就绪问题）、切档位时预算收到「该档基准 + 一次可选深化」、教学档按钮标「尚未实现」并禁用（运行期还有 `assertRunnable` 兜底）。

验收证据：

| 项 | 结果 |
| --- | --- |
| `npm test` | 111 项通过，新增速查档全流程（3 次调用）、预算不足不启动深化、教学档运行期拒绝 |
| `node tests/research-ui-check.cjs` | 三档按钮、教学档禁用、综述预览「10 个环节 / 7 个模型环节 / 基准 7 次」、速查预览「6 个环节 / 基准 3 次」、保存后配置为 v4 且 `final=null` |
| `node tests/plan-ipc-check.cjs` | 三档可查、P0 计划 6 环节 3 次调用、非法 Tier 被拒 |
| `node tests/research-run-check.cjs` | 综述档整轮 6 次调用、预算 8、草稿期正文为空、未启用检索时引用如实标注无法核验 |
| `node tests/packaged-check.cjs` | `build/` 与 `release/` 均通过；重启后 v4 科研配置与任务模型仍在 |
| `node tests/dsh-visual-check.cjs` | 15 次 axe 审核 0 违规（含新档位面板与计划预览） |

## 11. E1 实验执行：从推演工具到执行平台

方向变更：原先把"执行"列为本期排除项，用户明确要执行平台功能，于是把执行能力改成**分阶段交付**，边界从"不做"换成"先只跑可审查的模板"。详见 `docs/research-mode-design.md` §19。

新增 `core/exec/`：

| 文件 | 责任 |
| --- | --- |
| `templates.cjs` | 模板表（脚本、依赖清单、参数 schema、产物与指标声明、超时区间）；参数校验越界即报错 |
| `env.cjs` | 按依赖指纹建独立 venv 并复用；不碰系统 Python |
| `runner.cjs` | 起进程、日志截断、超时与取消杀进程树、产物 SHA-256 |
| `manifest.cjs` | 运行记录结构与校验（完成态必须退出码 0 + 指标可解析 + 产物齐全） |
| `claims.cjs` | 数字溯源：`[E1]` 标记 + 正文数字必须能指回该运行的指标 |
| `scripts/*.py` | `env-smoke`（环境自检）、`tabular-baseline`（真实分类实验）、`digit-cnn`（占位未实现） |

界面：侧栏「实验执行」→ 选模板 → 填参数 → 运行，右侧实时日志、指标表、产物按钮，下方运行历史可点开还原。未实现的模板在界面上禁用并在运行期拒绝。

顺带修掉两个真缺陷：

| 缺陷 | 影响 | 修法 |
| --- | --- | --- |
| `handleEvent` 在 `state.active` 为 null 时继续执行 | 欢迎页收到任何不带 conversationId 的全局事件就抛 TypeError | 先判断 `!state.active` 直接返回 |
| preload 的事件回调没有异常保护 | 渲染侧一个错误会让那次事件静默丢失，且难以定位 | 回调加 try/catch，并暴露 `__eventProbe`（到达计数 / 投递计数 / 最后错误） |

验收证据：

| 项 | 结果 |
| --- | --- |
| `npm test` | 133 项通过（新增 exec 逻辑 17 项 + 真实执行 5 项） |
| 真实实验 | digits + 随机森林：测试集准确率 **0.9639**、macro-F1 **0.9634**、训练 0.518 s、35.2 s 全流程（含建 venv）；产物混淆矩阵与 metrics.json 均带 SHA-256 |
| 超时/取消 | 30 s 任务在 5 s 上限处被杀（6.4 s 返回）、abort 后 1.9 s 收敛为 cancelled |
| 环境复用 | 第二次执行命中同一指纹，不再重建 venv |
| 界面 | `tests/exec-ui-check.cjs`：3 个模板（未实现那个被禁用）、真跑一次显示指标与日志、历史可点开还原 |
| 可访问性 | `dsh-visual-check` 新增实验面板明暗两套截图，axe 0 违规 |

## 12. E1.5：实验数字门禁、执行预算与 driver 层

**数字门禁**：科研答案里的实验数字必须指回本对话已完成的运行记录。

- 最终环节拿到可引用运行清单（`E1 | 模板 | 参数 | 指标`）；没有完成运行时明确写「不得出现实验数字」。
- 发布前机械核验（不消耗模型预算）：不存在的 `[E9]` 标记被删除；指标里找不到的数字改写成 `〔未核对：…〕`；结果进 `reply.experiments` 与自检项「实验数字可核对」。
- 百分数与小数互认，整数要求精确相等；`F1`/`top-1`/`E1` 这类词内数字不误判。
- 答案页脚新增徽章：`实验数字已核对 N 项` 或 `〔未核对〕实验数字 M 处`。

**执行预算**（`core/exec/budget.cjs`）：本对话 20 次 / 今日 50 次 / 今日 7200 秒，与模型调用预算互不占用；超限在启动前拒绝并说明是哪一项到顶。

**driver 层**：执行器抽成可插拔接口（`core/exec/driver.cjs`），模板用 `driver` 字段声明执行方式；本期只有 `template-python`（`isolation: none`、`network: allowed`，界面照实写）。E2 接入只需新增一个 driver 文件，运行期/IPC/界面/运行记录都不用改。要求未提供的 driver 时明确拒绝，不会偷偷退回本机执行。

验收证据：

| 项 | 结果 |
| --- | --- |
| `npm test` | 146 项通过（门禁与预算 8 项、科研门禁集成 3 项、driver 2 项） |
| `node tests/exec-gate-check.cjs` | 真执行 + 假模型服务：真实数字 `11.200641 [E1]` 门禁通过并绑定 1 处；编造数字 `999.999999 [E1]` 被拦，正文变成 `〔未核对：999.999999〕` |
| `node tests/exec-ui-check.cjs` | 面板正常运行并显示执行预算 |

## 13. 还没做的（E1.5 之后）

- **实验还没作为计划节点出现**：`experiment-run` 不在计划图里，跑实验仍是独立动作（先跑、再问）。真正的"研究过程中自动安排实验"需要新增节点类型与条件。
- **没有自由代码执行**：模型不能自己写 Python。需要 WSL2 容器（E2），要先以管理员身份装 WSL2 并重启。
- **无 OS 隔离、无网络关闭、无资源硬限额**：E1 靠"代码可审查 + 参数有界"控制风险，不是沙箱。
- 训练能力只到 sklearn 级别；`digit-cnn` 模板占位未实现（需要 PyTorch 与 MNIST 下载策略）。




## 14. 实验族接入研究流程（不再是独立功能）

按用户要求把实验从「独立面板」改成**研究流程内的一个环节族**：研究任务自己设计实验、生成执行方案、真跑训练、按指标调参，实验族与其它环节同源（同一个计划、同一份运行记录、同一套门禁）。

| 环节 | 类型 | 作用 |
| --- | --- | --- |
| 实验设计 | 模型 | 判断是否需要实验；给出可证伪假设、主指标、基线参数、搜索空间、停止条件 |
| 实验程序 | 本地 | 把规格编译成受控模板的调用参数；模板不存在、指标没声明、参数越界一律拦下并记原因 |
| 训练与评估 | exec | 按 trial 真跑训练（独立 venv、超时杀进程树），每条运行写 manifest 与产物 SHA-256 |
| 结果分析 | 模型 | 读真实指标，判断是否继续调参、给出下一轮基线；受 maxRounds 裁剪 |
| 实验记录 | 本地 | 汇总全部运行的指标与边界，供整合与核验使用 |

关键设计：

- **执行不占模型预算**：实验族只多花「设计 1 次 + 每轮分析 1 次」的模型调用，训练走执行预算（本对话 20 次 / 今日 50 次 / 今日 7200 秒）。
- **模型说什么不算数**：模板、参数、指标都要过本地校验；跑不了的方案直接拦下并在答案里说明，绝不硬跑。
- **失败不连坐**：某次训练失败不中止整轮研究，自检里如实记失败数；预算不足时停止后续 trial 并写明原因。
- **数字仍然可核对**：本轮跑出来的运行会累积进发布前核验，答案里的数字必须与运行记录一致。

验收证据：

| 项 | 结果 |
| --- | --- |
| `npm test` | 163 项通过（新增实验纯逻辑 8 项、流程编排 6 项） |
| `node tests/experiment-flow-check.cjs` | 真训练闭环：8 次模型调用、2 次真实 sklearn 运行、最优 test.accuracy=**0.9722**、数字门禁 **gateOk=true** |
| `tests/research-experiment.test.cjs` | 调参轮次受 maxTrials 限制、判断不需要实验时零运行、训练失败不中止、预算不足即停、非法方案被拦下 |
| `tests/dsh-visual-check.cjs` | 新的「自动实验」面板明暗两套 axe 0 违规 |

顺带修掉一个真缺陷：trial 的展示名曾被写进 `manifest.label`，而该字段是 E 编号（`[E1]`）的位置，导致模型写的引用对不上、门禁误判。现在展示名放 `trialLabel`，编号只由核验器按时间分配给 `E\d+` 形式的既有值。

## 15. 还没做的

- **自由代码执行**：模型仍不能自己写任意 Python。需要 WSL2 发行版（`wsl -l -v` 目前没有发行版）；driver 层已就位，装好后加一个 driver 即可接入同一流程。
- **深度学习模板**：`digit-cnn` 仍是占位（需要 PyTorch 与 MNIST 下载策略），当前可跑的实验是 sklearn 级别。

## 16. 一键导出结果

新增 `core/export.cjs` 与 IPC `duet:export-result`：点一下按钮，把这一轮科研的全部产出落成一份自包含 Markdown，不弹对话框、不再问路径。

**导出内容**（有记录才写，缺哪段整段省略，不用占位文字凑版式）

| 段落 | 来源 | 说明 |
| --- | --- | --- |
| 结论 | 答案正文 | 正文自带的 `##` 整体降两级，避免和导出章节平级打乱结构 |
| 核验 | `run.integrity` / `run.experiments` | 文献引用与实验数字分别给结论，未核验的编号逐条列出 |
| 实验运行 | `run.experimentRuns` + run manifest | 编号表 + 逐次运行记录（参数、指标、产物 SHA-256、环境指纹） |
| 研究界定 / 证据提取 / 任务分解 / 候选筛选 | 各阶段结构化产出 | 模型给的原文保留，不重写 |
| 资料库 | `KnowledgeBase` | 逐条列出键、来源、年份、标题、标识；统计来自本轮 stats |
| 终审自检 | `run.audit` | 检查项表格 + 模型复核结论 |
| 阶段产出记录 | `run.artifacts` | 每阶段状态、模型、字数、耗时 |
| 复现信息 | run manifest | runId 与产物哈希前缀，同机可回溯 |
| 本轮模型分配 / 元数据 | `run.participants` / 消息 | 角色→通道→模型→力度，以及对话/消息/轮次编号 |

**三条硬规则**

1. **E 编号与答案对齐**：编号只给成功运行，按 `startedAt` 升序——和核验端 `core/exec/claims.cjs` 的规则完全一致，否则导出表里的 E3 会和正文里的 `[E3]` 指向两条不同的运行。失败尝试保留在表里但标「未编号」。
2. **不泄漏**：只写记录里真实存在的字段；`env` 里剔除路径类键（`*path`/`dir`/`home`…）与凭据类键（`apiKey`/`token`…），只留版本号与指纹；产物只给哈希前缀和文件名，不写本机绝对路径。
3. **不覆盖**：同名文件自动加 `-2`、`-3`，第二次导出不会把上一次的成果冲掉。

**入口**：答案下方的「导出结果」（按住 Shift 另存为）；工具栏导出按钮在科研轮次上走同一条路径，普通对话仍是原来的「导出对话」另存为。导出成功后那颗按钮就地变成「打开所在文件夹」，不重渲染整个对话——重渲染会把用户正在看的滚动位置顶掉。

**顺手补的环境变量**（验收与便携部署用，正常启动完全不受影响）：`IRIS_DATA_ROOT` 指定数据目录，`IRIS_EXPORT_DIR` 指定一键导出的落盘目录。

**验证**：`tests/export.test.cjs`（12 项，纯函数：段落完整性、E 编号规则、省略规则、标题降级、泄漏扫描、文件名清洗）+ `tests/export-ui-check.cjs`（隔离数据目录起真进程，点按钮→文件落地→内容断言→按钮变「打开所在文件夹」→再导一次不覆盖）。真实数据回放：一条带实验的科研轮导出 64 KB，E1–E4 与正文一致，4 份运行记录的参数/指标/产物哈希齐全，无路径与密钥泄漏。

## 17. 花费估算与界面修复

### 17.1 token 旁边多了一个金额

新增 `core/pricing.cjs` 与设置里的「花费估算」：填每个通道的输入价 / 输出价（每百万 token），回复卡片底部就从 `15,000 tokens` 变成 `15,000 tokens · ≈¥0.0480`，运行中的状态条也会实时往上走。

**不内置任何价目表**。同一模型在不同套餐、不同时段、不同地域的单价都不一样（Codex 走订阅时甚至没有 per-token 账单），写死一份价格会直接变成一份错账单。所以：

- 单价由用户自己填，可精确到 `provider:model`，也可只填 `provider` 一级；
- 没填就不出金额，显示「未设单价」——不拿推测值冒充花费；
- 一轮里同时用了多个通道时，用量按 `provider:model` 分开记账，货币不同绝不合并（人民币和美元加在一起没有意义），分别给出并点名谁还没设单价。

改动落在：`main.cjs`（用量分账 + 每次调用推一次 `usage` 事件 + `normalizePricing` 校验）、`renderer/app.js`（`costText` / `usageLabel`）、`renderer/iris-ui.js`（`renderPricingList` / `collectPricing`）。

### 17.2 阶段列表把整页撑出了横向滚动条

**现象**：跑科研流程时，进度条那一行只剩左边十来个环节，右边的「14 反证与整合 / 15 引用核验 / 16 终审自检」被裁掉，整个页面还多出一条横向滚动条。

**根因**（量出来的，不是猜的）：`premium.css` 里 `.stage-flow li { flex: 1 }` 配 `white-space: nowrap`，16 个环节硬挤在一行。1440px 窗口下容器只有 808px，内容宽 1302px，溢出 494px，`documentElement.scrollWidth > clientWidth` 成立。1200 / 1024 / 900 / 783 四种宽度都溢出。

**修法**：阶段格改成 `flex: 0 1 auto` + `.stage-flow { flex-wrap: wrap }`，环节多就换行；再补一条 2px 进度条（`role="progressbar"`，`aria-valuenow` 用已完成环节数），给「还剩多少」一个不用数格子的直觉。修复后同样四种宽度：容器 736–820px，`scrollWidth` 与容器一致，整页横向滚动消失。

### 17.3 侧栏不再把 64 个对话全铺开

每个工作区默认只铺前 6 条对话，多出来的折成一行「还有 N 个对话」；搜索命中时不折叠——正在找的东西不能被藏。

### 17.4 验证

- `tests/pricing.test.cjs`（9 项）：无单价不出金额、`provider:model` 优先、0 等于没填、多币种不合并、部分未设单价时照给金额并点名、自定义计量单位、无用量不算钱、小额显示到四位小数。
- `tests/pricing-ui-check.cjs`：隔离数据起真进程，先断言「15,000 tokens · 未设单价」，在设置里填 2 / 8 后断言「≈¥0.0480」，并核对 `settings.json` 里真的存住了 `{ input: 2, output: 8, currency: 'CNY' }`。
- `tests/ui-run-shots.cjs`（诊断工具）：把 16 环节的运行态塞进隔离窗口，在 1440 / 1200 / 1024 / 900 / 783 五种宽度下量 `scrollWidth`，修复前后有据可查。
- 回归：`npm test` 193 项全过；`npm run test:frontend` 明暗两套 axe 0 违规（"running" 场景 33 项通过）；`tests/dsh-visual-check.cjs` passed。

### 17.5 一个容易再踩的坑：CSP 会让 markup 里的 inline style 静默失效

进度条最初写成 `<span style="width:31%">`，量出来永远是满格。排查过程本身就是证据：

- `fill.getAttribute('style')` 读到 `width:31%`，DOM 是对的；
- `getComputedStyle(fill).width` 却是父容器的整宽；
- 用 CSSOM 设 `fill.style.width = '50px'` 立刻生效（50px），可同样的值写回 inline 属性又变回满宽。

根因在 `renderer/index.html` 的 CSP：`style-src 'self'`。从 markup 解析出来的 `style` 属性会被直接丢弃，而 JS 通过 CSSOM 修改样式不受这条限制——同一个值，两条路径两种结果。

所以进度条改成**按环节分段**：每个环节一个 `<i>`，状态全用 class 表达（`done` / `active` / `skipped`）。这样既绕开了 CSP，又多了一层信息：一段就是一格，和阶段条一一对应，当前环节是蓝的。

扫了一遍 `renderer/*.js`，除这一处外没有别的 markup inline style。

## 18. 接着跑实验：不再把第一遍重来一次

**现象**：一轮科研的答案里列出了「验证实验设计与优先级」，程序一个实验都没跑。用户按建议回复「就跑这个」时，整条流程从研究界定重新开始——十来次调用、十个环节，出来的还是同一份结论，只是多了一个新版本。

**根因（两条，都是代码里写死的）**：

1. 实验族只在 `experiments.enabled` 为真时进入计划。旧对话是 v3 配置迁移来的，实验默认关闭，于是答案里只剩「拟议实验」的文字。
2. 运行器没有「沿用」这个概念：`runResearch` 永远从 `research-scope` 开始。

**改法**：

| 位置 | 改动 |
| --- | --- |
| `core/research.cjs` | 新增 `withResume(config, run)`：把上一轮的界定/证据/任务分解/筛选/推演成果打成 `config.resume`，并强制打开实验；数据不全时明确拒绝，不用半截数据编实验 |
| `core/plan.cjs` | `activeNodes` 在沿用模式下跳过前 8 个环节（标 `carry-over`），`required` 一并放宽，`planVersion` 跟着变 |
| `core/profiles.cjs` | `baseCalls` 从「整轮」降到 `1 次整合 + 审计 + 实验` |
| `main.cjs` | `duet:send` 接受 `resumeFrom`；派生配置**不回写**对话配置，否则后续追问会莫名其妙都变成「只跑实验」 |
| `renderer/app.js` | 答案下方出现「执行实验」，只在跑完且没跑过实验的轮次出现；先确认再跑，并说明会复用哪些、花几次调用 |

**量出来的效果**（`tests/resume-flow-check.cjs`，假模型 + 真跑 env-smoke）：

| | 第一轮（完整研究） | 第二轮（接着跑实验） |
| --- | --- | --- |
| 模型调用 | 5 次 | **3 次**（实验设计 / 结果分析 / 整合） |
| 前序阶段 | 界定 → 分解 → 并行 → 筛选 → 整合 | **一个都没跑** |
| 实验 | 无 | 真跑 1 次，运行记录带 runId，答案引用 `[E1]` |
| 对话配置 | — | 沿用标记没有写回，第三轮追问仍是完整研究 |

### 18.1 必须点名执行哪一个方案

一轮科研的答案里常常列着好几个候选方向（「是否稳定」「是否跨任务」「是否依赖分解」）。程序自己挑一个去跑，等于替用户做了实验设计决定——所以现在**没有明确方案就不执行**。

| 触发方式 | 行为 |
| --- | --- |
| 点「执行实验」（答案下方或输入框上方提示条） | 打开「执行哪一个实验方案」对话框，不出请求 |
| 对话框里不写方案就确认 | 被挡下，提示「请写清要执行哪一个方案」，一个请求都不发 |
| 对话框里写下/选中一条 | 才执行；方案原样进实验设计的输入（`requestedPlan`） |
| 输入框直接写 `执行实验：<方案>` | 同样直接执行，不重跑前序 |

对话框会先从答案里认「实验建议」段落下的编号条目当候选（`experimentOptionsFrom`），点一下填进文本框——**只是预填**，用户仍要确认或改写。答案里没有编号方案时只留一个空文本框。

设计提示词同步加了一条硬规则：拿到 `requestedPlan` 就必须照它设计 hypothesis / baseline / searchSpace，不得换成别的方向；模板确实跑不出来时 `needed=false` 并写清是哪一步做不到。

主进程侧也守住底线：`withResume(config, run, choice)` 的 `choice.text` 少于 2 个字直接抛错，不会退化成「默认跑第一个」。

**顺带修掉两个真缺陷**：

1. `research-explore` 与 `research-screen` 缺 `hasNode` 守卫——这两个环节原本无条件执行，任何不含它们的计划（速查档、将来裁剪过的计划）都会照样多跑。
2. 证据提取从未写进运行记录（只在前端内存里），重开窗口或导出里的「证据提取」段是空的；现在提取结束时落盘 `run.evidence`。

## 19. 跨平台适配（macOS / Linux）

目标：不只在这台 Windows 机器上跑，也要能在 GitHub 上被别处的人装上。**先说清边界**：这台开发机只有 Windows，
下面所有 mac / Linux 的分支都是「代码写了 + 单测覆盖了」，不是「我跑过了」。真机验证靠 CI 与使用者反馈。

### 19.1 集中平台判断（新增 `core/platform.cjs`）

原来平台判断散在接受不了注入的地方（`process.platform === 'darwin'` 直接写死在分支里），在这台机器上根本测不到 mac 分支。
现在全部收进 `core/platform.cjs`，每个函数都接受 `platform` 参数，于是三个平台的分支都能在 Windows 上跑单测。

| 函数 | 管什么 | 为什么必须分开 |
| --- | --- | --- |
| `pythonCandidates` | Python 候选顺序 | mac / Linux 只有 `python3`；`py` 只有 Windows 有 |
| `codexRoots` / `codexBinaryName` | 本机 Codex CLI 搜索 | 原来写死 `AppData/Local/OpenAI/Codex` |
| `dshInstallCandidates` | DSH Desktop 安装目录 | 原来写死 `AppData/Local/Programs/DSH Desktop` |
| `iconCandidates` | 图标格式优先级 | mac 只认 `.icns`，Linux 认 `.png` |
| `windowOptions` | 窗口外观 | mac 必须保留系统红绿灯 |
| `primaryModifier` / `shortcutLabel` | 快捷键 | mac 是 ⌘，不是 Ctrl |
| `quitOnWindowClose` / `needsApplicationMenu` | 生命周期 | mac 关窗不退出，且必须有 Edit 菜单 |

验收：`tests/platform.test.cjs` 9 项，其中一项是「仓库里不许再出现写死的 Windows 路径或 Ctrl 判断」的静态扫描。

### 19.2 运行时去绑定

| 项 | 原来 | 现在 |
| --- | --- | --- |
| Python 探测 | `[IRIS_PYTHON, python, py]` | 按平台排；全部失败时错误里列出试过的每个候选与它的输出 |
| 训练进程清理 | 非 Windows 只 `SIGKILL` 父进程（子进程会变孤儿继续算） | POSIX 上 `detached: true` 建独立进程组，超时/取消按 `-pid` 整组杀 |
| 图标 | `assets/iris.ico` 写死 | 按平台选；新增 `scripts/make-icons.cjs` 从 PNG 生成 `.icns`（16–1024 七档） |
| 窗口 | `frame: false` 一律自绘 | mac 用 `hiddenInset` + 红绿灯位置，其他平台不变 |
| 字体 | 只列 PingFang / 雅黑 | 补 Noto Sans CJK / 思源黑体 / 文泉驿，Linux 才不是一屏豆腐块 |

写这一块时发现两个只在 mac 上才炸的坑，顺手补了：

1. **没有应用菜单，Cmd+C / Cmd+V / Cmd+Z 全部失效**。这不是少个菜单的问题，是复制粘贴直接不能用。现在 mac 上装 `appMenu / editMenu / viewMenu / windowMenu`，其他平台继续无菜单。
2. **关掉窗口就退出**在 mac 上是错的。现在 `window-all-closed` 在 mac 上不退出，`activate` 时重建窗口——为此把窗口创建抽成了 `createWindow()`。

### 19.3 三平台打包

换成 `electron-builder`（原来的 `electron-packager` 链路保留，不打断现有部署）：

| 平台 | 目标 | 本机是否能产出 |
| --- | --- | --- |
| Windows x64 | `nsis` 安装器 + `portable` | **是**，实测产出 107.1 MB / 106.9 MB，portable 版跑通了导出验收 |
| macOS arm64 / x64 | `dmg` + `zip` | 否，交给 CI 的 `macos-latest` |
| Linux x64 | `AppImage` + `deb` | 否，交给 CI 的 `ubuntu-latest`；deb 声明了 `libsecret-1-0` 等依赖 |

**本机实测的边界**（两条命令都真的跑过，不是推测）：

- `npx electron-builder --linux --dir` 在 Windows 上能产出 `dist/linux-unpacked/`（含 `chrome-sandbox` 与 `app.asar`），说明 Linux 的配置与文件白名单成立；
- `npx electron-builder --mac --dir` 直接被拒：`Build for macOS is supported only on macOS`。mac 产物只能由 macOS 或 CI 产出，这是工具链限制、不是配置问题。

三平台产物都**未签名**：Windows 会弹 SmartScreen，macOS 被 Gatekeeper 拦一次。签名要买证书，这笔钱不该替用户决定，
配置位留在 `package.json` 的 `build.mac.identity` 与 `build.win`。

### 19.4 CI 与仓库配套

- `.github/workflows/ci.yml`：`windows-latest` / `macos-latest` / `ubuntu-latest` 三平台矩阵，跑单测 + 平台分支 + 界面 axe 回归（Linux 用 `xvfb-run`）；打包任务只在 tag 或手动触发时跑，产物作为 artifact 上传。
- `.gitignore` 补齐 `dist/`、`Iris-data/`、`.DS_Store`、`Thumbs.db` 等；`.gitattributes` 固定文本文件为 LF、二进制不做转换——否则 Windows 检出 CRLF 会把整个仓库的 diff 弄脏。
- README 增加英文摘要、平台支持矩阵、各平台差异表、未签名产物的处理方式，并在矩阵里明确标注哪一栏是「真机验证过」、哪一栏是「代码已适配」。

### 19.5 公开前的整仓复查

整理仓库准备公开时做的一轮全量检查，实际修掉的问题：

| 问题 | 位置 | 修法 |
| --- | --- | --- |
| **按目标平台拼路径却用了 `path.join`** | `core/platform.cjs` | `path.join` 用**运行平台**的分隔符，在 Linux 上算 win32 路径会得到 `C:\Users\me/AppData/...` 这种混合串。改成按目标平台显式选分隔符，函数才真正与运行平台无关（这条会让 `tests/platform.test.cjs` 在 CI 的 Linux 任务上失败） |
| 图标资源查两遍 | `main.cjs` | `platformAssets()` 在同一个对象字面量里调了两次，等于六次 `existsSync`；改成先取一次 |
| 窗口关闭后仍去 `show()` | `main.cjs` | `loadFile` 期间窗口可能已被关掉（`win` 被置空），补 `win && !win.isDestroyed()` 守卫 |
| 死状态 | `renderer/app.js` | `state.lastExport` 赋值后没人读，删掉 |
| 本机用户名进公开仓库 | `docs/handoff-0.5.md` | 10 处 `C:\Users\<用户名>` 换成 `%USERPROFILE%`，第三方项目名一并去掉 |
| 旧稿与备份目录会被提交 | `docs/backups/` | 加进 `.gitignore`——版本库本身就是历史 |
| 死链 | `docs/handoff-0.5.md` | 指向仓库外、已不存在的截图，改成说明文字 |
| 旧品牌图标无人引用 | `assets/duet.ico`、`duet.png` | 删除 |
| 诊断脚本未登记 | `tests/stage-preview-check.cjs` | 补进 `docs/verification.md` 的「不在一键里」表 |

另外把一次性的探针转成了正式检查 `tests/runtime-probe.cjs`：它断言 sandbox preload 真的把 `process.platform` 交给了页面。
这条没法用单测证明，但拿不到时 mac 上会静默退化成「自绘窗口按钮 + Ctrl 快捷键」，而 Windows 上看不出任何异常——正是最容易漏掉的那类缺口。

整仓扫描结果（84 个 JS 文件）：语法 0 错、IPC 通道 43 对 43 一致、`$('#id')` 引用与动态生成的都核对过、无残留调试输出、无跨平台大小写冲突。

### 19.7 CI 第一次跑就抓到的真 bug

仓库推上去、三平台 CI 第一次跑，**三个平台的单元测试全红**——而这台机器上 `npm test` 是 210/210 通过。

失败现象：从第 200 个测试开始报 `Promise resolution is still pending but the event loop has already resolved`，
`failureType: cancelledByParent`，后面十几条连带取消。

**根因**（`core/retrieval.cjs` 的 `requestText`）：超时定时器写了 `timer.unref()`。unref 的定时器不维持事件循环——
在 Electron 主进程里很安全（IPC 与窗口一直有活），但在测试进程里，如果此刻没有别的待办，Node 判定事件循环已空，
定时器不触发，`await` 就永久挂住，测试运行器看到「promise 未 settle 而循环已空」直接判失败。

本地为什么过：开发机是 Node 24（对 unref 定时器 + pending promise 的判定更宽松），CI 是 Node 22。**代码本身与平台无关，是 Node 版本差异。**

修了三处：

1. **超时改成竞速兜底**：`Promise.race([fetch, timeoutGuard])`，定时器直接赢得这一路。
   之前只靠 `AbortController` 通知，真正能否打断取决于 fetch 实现是否响应 signal——第三方适配器、自造 mock、某些运行时都可能不响应。
2. **去掉 `timer.unref()`**：超时定时器必须能维持事件循环到触发为止。代价可忽略——请求一结束就 `clearTimeout`。
3. **测试的 mock 先查 `signal.aborted`**：真实 fetch 在信号已中止时会立刻 reject，mock 也必须这样，否则信号在注册监听前中止就会永久挂住。

另外补了一条测试 `fetch 完全不响应 abort 时，检索仍按时收口`，直接覆盖这条路径。
验证：Node 22（`npx node@22 --test`）与 Node 24 都是 211/211 通过——**两个版本都跑过**，不再靠「我这儿是好的」。

### 19.8 第二个 CI 才暴露的问题：测试偷偷依赖宿主环境

单元测试全绿之后，界面回归在三个平台齐刷刷红在同一个断言上：

```
AssertionError: assert.ok(initial.workspaces.length > 1)
at tests/frontend-check.cjs:38
```

**根因**：工作区列表 = 自定义工作区 + 本机 Codex / DSH 的工作区文件 + 「未分组」。这台开发机上真的装了 Codex 与 DSH，
它们的 `~/.codex/.codex-global-state.json`、`~/.dsh/storages/workspace.json` 被读进来，于是工作区有十几个；
CI 的干净环境里那些文件不存在，只剩「未分组」一个，断言直接不成立。

**这类 bug 的共性**：测试写成了「检查当前环境」，而不是「先造出要检查的环境」。本地永远绿，换台机器就红，而且红得莫名其妙。

**修法**：`frontend-check.cjs` 在调 `duet:init` 之前，往隔离数据目录里显式写入两个自定义工作区（`测试工作区 A/B`），
让这条断言在任何机器上都成立。顺带把这条注释写进代码，避免以后又有人把它当成「环境刚好如此」。

**这里还有一次假修复，值得单独记**：第一次只写了 store 就算完，本地跑还是绿的——因为本地 `.test-data/v5-ui` 里
躺着历史测试数据，界面自己就渲染出好几个工作区。真正的修法是写完盘之后让前端重新拉一次（`applyCatalog`），
否则页面用的还是启动时读到的旧列表。验证方式改成**先删掉 `.test-data` 再跑**，模拟 CI 的干净环境——这才是能证明修复有效的方式。

教训：一条「本地绿、CI 红」的测试，修完之后必须在**干净环境**里再跑一遍，否则你修的是「让本地继续绿」。

两个 CI 才暴露的问题（19.7 的超时挂死、19.8 的环境依赖）都不是平台适配的锅，是**只在异于开发机的环境里才显形**的那类缺陷——
这正是三平台 CI 存在的意义：它替代不了真机点一遍，但能替代「我这儿是好的」。

### 19.9 CI 从红到绿：五次修复

仓库推上去之后，三平台 CI 连跑五轮才全绿。每一轮红的原因都不一样，而且**没有一个能在这台机器上复现**——
这正是当初决定加 CI 的理由。

| 轮次 | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 三个平台单元测试齐红，`Promise resolution is still pending` | `core/retrieval.cjs` 的超时定时器用了 `unref()`，测试进程里事件循环空掉后定时器不触发 | 超时改成 `Promise.race` 竞速兜底，去掉 `unref`（见 19.7） |
| 2 | 界面回归红在 `workspaces.length > 1` | 工作区列表会读本机 Codex / DSH 的工作区文件，CI 干净环境里只剩「未分组」 | 测试自己写入两个工作区（见 19.8） |
| 3 | Windows/macOS 红在 `ENOENT .test-data/v3-ui/conversations.json` | 测试读 `npm run test:ui` 的历史产物，而 CI 不跑那个（它花真钱） | 自己造一条 8 产出、5 阶段的协作记录 |
| 4 | Ubuntu 直接 FATAL：`The SUID sandbox helper binary was found, but is not configured correctly` | CI 容器里 `chrome-sandbox` 没有 root:4755 | workflow 里设 `ELECTRON_DISABLE_SANDBOX=1`（桌面 Linux 正常安装不受影响） |
| 5 | macOS 红在「一键导出与花费估算」 | 15 个 harness 都写死 `node_modules/electron/dist/electron.exe`；macOS 上是 `Electron.app/Contents/MacOS/Electron` | 统一用 `require('electron')` 返回的二进制路径，抽到 `tests/lib/electron-binary.cjs` |

**第 5 条最值得记**：这不是「某个平台上的小毛病」，而是**测试自己不认识别的平台**。
同一个错误在 15 个文件里各写了一遍，所以任何一次跨平台跑都会撞上——CI 只暴露了它一次，修的时候要一次改全。

最终状态：`windows-latest` / `macos-latest` / `ubuntu-latest` 三个任务全绿，包含单元测试、平台分支检查、界面与 axe 回归、一键导出、花费估算。

### 19.6 没做的（不是遗漏，是没条件做）

- **便携 Python 内置**（方案 D1 的 B 案）：要随包分发 `python-build-standalone`（+30–50 MB），且三平台的解释器包在 Windows 上没法验证。当前走「用户自备 Python + 明确提示」。
- **代码签名**（D3）：需要付费证书。
- **mac / Linux 真机验证**：没有这两台机器。CI 能覆盖逻辑与部分界面，但「在真机上点一遍」这件事只能等使用者反馈。
- **P2 能力适配**（GPU 感知模板、沙箱 driver 泛化、深度学习模板）：依赖真实的多平台算力环境，暂不做。
