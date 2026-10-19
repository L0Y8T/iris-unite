# 验收矩阵

一页说清：**有哪些验收、各自证明什么、怎么跑、花不花钱**。测试代码在 `tests/`，一键入口在 `scripts/run-all-checks.cjs`。

```powershell
npm run test:all                  # 全部 20 项，约 10–15 分钟，会真实调用模型
npm run test:all -- --skip-live   # 跳过真实模型调用，约 4 分钟，离线可重复
npm run test:all -- --only=retry,exec-gate
```

报告写到 `artifacts/verification-report.json`（每项结果、用时、是否消耗额度）。

## 判据

一项算通过必须同时满足：

1. 进程退出码为 0；
2. 声明了 `"passed": true` 的脚本，输出里真的出现该字段；
3. 输出里没有 `FAILED:`（防止「退出码 0 但内部失败」）。

## 全部项目

| # | 项目 | 命令 | 证明什么 | 消耗 | 约耗时 |
| --- | --- | --- | --- | --- | --- |
| 1 | 单元测试（211 项） | `npm test` | 预算账本、计划编译、档位规则、引用与数字核验、检索解析、监控、执行模板与参数校验、一键导出、花费估算、沿用上一轮只跑实验（含「必须点名方案」）、三平台分支 | 无 | 70–90 s |
| 1.5 | 仓库卫生 | `node scripts/check-repo-hygiene.cjs` | 根目录只有白名单文件；仓库里没有证书、私钥、凭据与临时调试脚本（`ci-log.cjs` 那次事故的守门人） | 无 | 2 s |
| 2 | 本机历史读取 | `node tests/history-check.cjs` | 能读出 Codex / DSH 历史，且读取过程中不修改原文件 | 无 | 9 s |
| 2.5 | 三平台分支与路径 | `node tests/platform.test.cjs` | Python 候选顺序、Codex/DSH 路径、图标格式、窗口选项、快捷键、关窗行为在 win32/darwin/linux 三种取值下都正确；并静态扫描仓库里不许再有写死的 Windows 路径与 Ctrl 判断 | 无 | 3 s |
| 2.6 | 平台注入到渲染进程 | `node tests/runtime-probe.cjs` | sandbox preload 真的把 `process.platform` 交给了页面（拿不到时 mac 会静默退化成自绘按钮 + Ctrl 快捷键，而 Windows 上看不出异常）；同时核对 `window.duet` 暴露的方法数、窗口控制通道可用、无页面异常 | 无（隔离数据目录） | 2–15 s |
| 3 | 模型通道连通 | `node tests/live-check.cjs` | DeepSeek 与 GPT(Codex) 各发一次短请求，确认通道可用 | **真实 2 次** | 16 s |
| 4 | 重新生成与旧答案保留 | `node tests/retry-check.cjs` | 失败重跑不丢旧答案；成功才把旧答案标为被取代；生成中不允许重跑 | 无（本地假模型） | 6–8 s |
| 5 | 科研 草稿→核验→发布 | `node tests/research-run-check.cjs` | 整轮结束前正文为空（草稿期），核验与自检完成后才发布 | 无（本地假模型） | 6 s |
| 6 | 档位选择与计划预览 | `node tests/research-ui-check.cjs` | 三档可选、教学档禁用并标注、预览给出环节数与基准调用、保存为 v4 | 无 | 6 s |
| 7 | 计划/档位接口 | `node tests/plan-ipc-check.cjs` | `duet:plan` / `duet:profiles` 的返回结构；非法 Tier 被拒 | 无 | 2 s |
| 8 | 实验面板 | `node tests/exec-ui-check.cjs` | 选模板→真跑一次→指标/日志/产物/历史还原 | 无（真跑 Python） | 4–7 s |
| 9 | 实验→答案→数字门禁 | `node tests/exec-gate-check.cjs` | 真实运行数字 + `[E1]` 通过门禁；编造数字被标 `〔未核对〕`；提示词确实教过 `[E1]` 写法 | 无（真跑 Python + 假模型） | 5 s |
| 9.5 | 实验族流程闭环（真训练） | `node tests/experiment-flow-check.cjs` | 研究流程自己设计实验、真跑 2 次 sklearn 训练、按指标分析、数字门禁通过。**不在 `test:all` 里**，单独跑 | 真实训练 + 假模型 | 30–60 s |
| 9.6 | 一键导出结果 | `node tests/export-ui-check.cjs` | 隔离数据目录起真进程：点「导出结果」不弹对话框→文件落地→段落/结论/E 编号/资料库/哈希逐项对上→按钮变「打开所在文件夹」→再导一次不覆盖同名文件 | 无（隔离数据、假运行记录） | 15–25 s |
| 9.7 | 导出功能在打包产物里可用 | `IRIS_EXE=build/IrisUnite-win32-x64/IrisUnite.exe node tests/export-ui-check.cjs` | 交付出去的 exe 本身带一键导出，不只是源码能跑。**不在 `test:all` 里**，单独跑 | 无 | 15–25 s |
| 9.8 | 花费估算：单价→金额 | `node tests/pricing-ui-check.cjs` | 没填单价时显示「未设单价」而不是猜一个数；在设置里填 2 元 / 8 元后，15,000 tokens 立刻显示 ≈¥0.0480；单价真的落进 settings.json | 无（隔离数据） | 12–18 s |
| 9.9 | 接着跑实验，不重跑前序 | `node tests/resume-flow-check.cjs` | 第一轮给了实验建议但没跑实验；点「执行实验」只打开方案对话框（不出请求），不写方案被挡下，写下方案后才执行：**只**调用 3 次模型（设计/分析/整合），前序阶段一次都没碰，实验真跑出 runId，方案原样进了设计输入，沿用标记不写回对话配置 | 无（假模型 + 真跑 env-smoke） | 30–45 s |
| 10 | 界面与可访问性 | `node tests/dsh-visual-check.cjs` | 逐个关键界面截图；明暗两套 axe 审核 0 违规；设计 token 真的落地 | 无 | 20–30 s |
| 11 | 应用内建 UI 冒烟 | `npm run test:ui` | 原生滑块拖动与键盘、toast 淡出、双模型真实协作 8 个产物、中间材料默认收起、侧栏折叠、紧凑窗口 | **真实 8 次** | 60–90 s |
| 12 | 应用内建前端验收 | `npm run test:frontend` | 主题切换、键盘、Markdown、对比度采样、各窗口状态 | 无（本地） | 16–18 s |
| 13 | 打包产物 build | `node tests/packaged-check.cjs`（`DUET_VERIFY_EXE` 指向 build） | 打包版重启后恢复模型/工作区/科研配置/密钥；打包版能真跑实验（脚本需先物化，asar 内路径 Python 读不到） | **真实 8 次** | 50–55 s |
| 14 | 打包产物 release | 同上（指向 release） | 交付目标本身可运行 | **真实 8 次** | 12–55 s |

## 不在一键里的脚本

| 脚本 | 原因 |
| --- | --- |
| `tests/iris-ui-check.cjs` | 0.5 时代「五阶段 GPT 统筹」的联调脚本，断言写死 `callsUsed === 5`、`artifacts.length === 5`、终审 provider 为 `gpt`，与 0.6.0 的十环节/三档不符；文件头已标注默认不执行。要恢复需按 0.6.0 重写 |
| `tests/ui-run-shots.cjs` | 诊断脚本：把一条 16 环节的运行态塞进隔离窗口，按给定宽度量阶段条是否溢出并截图。不是断言，是排障工具（`node tests/ui-run-shots.cjs 1440 1024 900`） |
| `tests/sidebar-shot.cjs` | 诊断脚本：拿真实数据的**只读副本**给侧边栏拍照，看「还有 N 个对话」的折叠效果 |
| `tests/stage-preview-check.cjs` | 诊断脚本：逐个宽度检查答案里各阶段产出的展开/收起与预览文本，用于排查渲染问题 |

## 跑之前要知道的

- `--skip-live` 会跳过四项真实消耗额度的检查：**模型通道连通**、**应用内建 UI 冒烟**、**打包产物验收 build / release**。其余项用本地假模型服务或纯本地计算。
- 表里有两项不在 `test:all` 里：**实验族流程闭环（9.5）** 与 **打包产物里的导出（9.7）**，需要时单独跑。
- 第 8、9 项会**真实起 Python 进程**；首次运行要按依赖清单建 venv（装 numpy / scikit-learn / matplotlib，需要联网，约 30–60 秒），之后按指纹复用。
- 第 13、14 项会启动打包后的 `IrisUnite.exe`。若上一次跑崩了留下进程，先清掉，否则 exe 被占用会导致后面部署失败：
  ```powershell
  Get-Process IrisUnite | Where-Object { $_.Path -like '*duet-desktop\release\*' } | Stop-Process -Force
  ```
- 所有 UI 类脚本都用 CDP 驱动独立 Electron 实例，串行执行（共用同一 `.verification-profile`，不能并行）。
