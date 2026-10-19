# 发版清单

一次发布要做的全部动作，按顺序。**不要凭记忆发版**——这里的每条命令都对应一个会真的跑起来的检查。

> 当前状态：仓库还没有 `git`（`.git` 不存在）。第 0 步是初始化并推到 GitHub，否则后面的 CI 与分发都无从谈起。

## 0. 首次准备（只做一次）

```bash
git init
git add -A
git status          # ← 必看：下面这些路径不允许出现
```

`git status` 里**不能出现**：`settings.json`、`conversations.json`、`knowledge/`、`.local-data/`、`.test-data/`、`.verification-profile/`、`build/`、`release/`、`dist/`、`artifacts/`。出现了就停下，先修 `.gitignore`——这些里面有真实的对话、资料库与加密后的密钥。

然后：仓库设为 public → 推送 → 在 GitHub 上确认 Actions 页签出现了 `CI` workflow。

## 1. 改版本号（两处，必须同时改）

| 位置 | 当前值 | 说明 |
| --- | --- | --- |
| `package.json` → `version` | `0.6.0` | 权威版本，构建产物文件名用它 |
| `renderer/index.html` → `<div class="title-brand">Iris Unite <span>` | `0.6` | 界面标题栏显示，只写主次版本 |

两处不同步的话，安装包名字是 0.7.0、界面还写着 0.6。改完顺手把 `docs/CHANGELOG-<版本>.md` 建起来（或续写现有那份）。

## 2. 跑检查

分两批：先跑不花钱的，全绿再跑花钱的。

```bash
npm run prepare:ui                       # 图标字体与本地 Markdown 渲染器
npm test                                 # 210 项离线单测，fail 0 才算过
node --test tests/platform.test.cjs      # 三平台分支与路径扫描
npm run test:frontend                    # 界面 + axe（Linux 上要 xvfb-run）
node tests/dsh-visual-check.cjs          # 明暗两套 axe 0 违规
node tests/export-ui-check.cjs           # 一键导出
node tests/pricing-ui-check.cjs          # 花费估算
node tests/resume-flow-check.cjs         # 接着跑实验（真跑一次 env-smoke，约 30 s）
```

花钱的那些**只在准备正式发布时跑**（会真实调用模型）：

```bash
node tests/live-check.cjs                # 通道连通，2 次调用
node scripts/run-all-checks.cjs          # 全量验收；--skip-live 可跳过真实调用
```

`docs/verification.md` 里每一项都写清了「证明什么 / 消耗 / 耗时」，对不上就别继续。

## 3. 打包

```bash
npm run icons            # ① 先重建图标：icns/png 必须与 assets/iris.png 一致
npm run dist:win         # ② Windows：NSIS 安装器 + portable
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `Iris Unite Setup <版本>.exe` | NSIS 安装器，可选安装目录 |
| `Iris Unite <版本>.exe` | 免安装版，双击即用 |
| `*.blockmap` | 增量更新用，可以一并上传 |

macOS 与 Linux 的包**不能在这台 Windows 机器上产出**（builder 直接拒绝：`Build for macOS is supported only on macOS`）。两条路：

- 推一个 `v<版本>` 的 tag → CI 的 `package` 任务在 `macos-latest` / `ubuntu-latest` 上产出 `dmg` / `AppImage`，作为 artifact 下载；
- 或在 GitHub Actions 页面手动 `Run workflow`（`workflow_dispatch`）。

## 4. 本机部署（仅当你在这台机器上自用）

```powershell
# app.asar 必须与 build 一致；exe 若被占用会替换失败，先退出应用
Copy-Item 'build/IrisUnite-win32-x64/resources/app.asar' 'release/IrisUnite-win32-x64/resources/app.asar' -Force
Get-FileHash 'build/IrisUnite-win32-x64/resources/app.asar','release/IrisUnite-win32-x64/resources/app.asar' -Algorithm SHA256
```

部署后核对两条不变量：

| 不变量 | 期望 |
| --- | --- |
| `build` 与 `release` 的 `resources/app.asar` | 哈希一致 |
| `release/IrisUnite-win32-x64/Iris-data/conversations.json` | 哈希**不变**（这是真实用户数据，任何一次发版都不该改动它） |

## 5. 发布说明里必须写清的三件事

缺一件就会有人装不上，或者以为软件坏了：

1. **平台状态**：哪一栏是真机验证、哪一栏只是「代码已适配」。照抄 README「平台支持」表，别改写。
2. **未签名的处理方式**：Windows 点「更多信息 → 仍要运行」；macOS 去「系统设置 → 隐私与安全性 → 仍要打开」；Linux `chmod +x`。**并且说明** Win11 智能应用控制环境与受管设备可能直接跑不了。
3. **哪里要花钱**：模型调用按你填的单价估算；跑实验会在本机起 Python 进程。同时说明「不需要任何 API Key 也能检索文献」——很多人以为装完必须配密钥才能用。

## 6. 发布

```bash
git tag v0.6.0
git push origin main --tags
```

CI 会自动跑三平台测试；`package` 任务产出三个平台的安装包。下载 artifact 后人工核对一遍：文件名带版本号、`dist/` 里没有混进 `.map` 或 `tests/`。

## 7. 发完之后

- 在 README 的「平台支持」表里更新状态：如果有人在 mac / Linux 上真机跑通了，把「未真机验证」改掉，并注明是谁、什么版本、什么问题。
- 收到「打不开」的反馈时，先问三件事：什么系统版本、有没有出现拦截提示、是不是 Win11 智能应用控制。这三个能覆盖绝大多数安装失败。
- 新版本发布后，旧版本的 SmartScreen 信誉**不会继承**（未签名的情况下每一版都从零开始）。如果这种反馈变成常态，就是该上 Artifact Signing 的信号了。
