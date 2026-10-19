# 发版清单

一次发布要做的全部动作，按顺序。**不要凭记忆发版**——这里的每条命令都对应一个会真的跑起来的检查。

> 当前状态：仓库还没有 `git`（`.git` 不存在）。第 0 步是初始化并推到 GitHub，否则后面的 CI 与分发都无从谈起。

## 0. 首次准备（已完成，留档备查）

本地已经初始化并提交好了（`main` 分支，首个提交 `chore: 初始化仓库（Iris Unite 0.6.0）`，120 个文件）。
之后要重建仓库时照这个来：

```bash
git init
git add -A
git status          # ← 必看：下面这些路径不允许出现
```

`git status` 里**不能出现**：`settings.json`、`conversations.json`、`knowledge/`、`.local-data/`、`.test-data/`、`.verification-profile/`、`build/`、`release/`、`dist/`、`artifacts/`、`docs/backups/`。出现了就停下，先修 `.gitignore`——这些里面有真实的对话、资料库与加密后的密钥。

提交前跑一遍扫描（凭据、本机用户目录、私钥、第三方项目名），确认 `findings` 与 `forbidden` 都是空的：

```bash
git diff --cached --name-only   # 逐个过一眼，120 个文件不该有陌生面孔
```

## 0.1 仓库（已完成）

仓库已在 https://github.com/L0Y8T/iris-unite（public，默认分支 `main`），首个推送包含 119 个文件。
`origin` 已指向 `https://github.com/L0Y8T/iris-unite.git`，`main` 跟踪 `origin/main`。

凭据走本机 Git Credential Manager，**不要把 token 写进 remote URL 或任何文件**。换机器时重新授权一次即可：

```bash
git push -u origin main     # 首次会弹浏览器授权
```

清空重来时（本地仓库已存在，不要重复 init）：

```bash
git remote set-url origin https://github.com/L0Y8T/iris-unite.git
git push -u origin main
```

### 推上去之后要核对的四件事

1. **文件数与顶层结构**：仓库首页应该只有 119 个文件，顶层是 `.github/ assets/ core/ docs/ renderer/ scripts/ tests/` 加几个根文件；看不到 `build/`、`release/`、`dist/`、`node_modules/`、`.test-data/`。
2. **Actions 跑起来了**：`CI` 应在推送后自动排队。连续推送会取消上一次（workflow 里配了 `concurrency`），以最后一次为准。
3. **`package.json` 的仓库字段**：已填 `repository` / `homepage` / `bugs`，指向 `L0Y8T/iris-unite`。
4. **仓库描述与 topics**：在仓库首页右侧编辑，建议 `electron`、`research`、`llm`、`reproducibility`、`citation-verification`——这些直接影响能不能被搜到。

## 1. 改版本号（两处，必须同时改）

| 位置 | 当前值 | 说明 |
| --- | --- | --- |
| `package.json` → `version` | `0.6.0` | 权威版本，构建产物文件名用它 |
| `renderer/index.html` → `<div class="title-brand">Iris Unite <span>` | `0.6` | 界面标题栏显示，只写主次版本 |

两处不同步的话，安装包名字是 0.7.0、界面还写着 0.6。改完顺手把 `docs/CHANGELOG-<版本>.md` 建起来（或续写现有那份）。

## 1.5 仓库卫生检查

```bash
node scripts/check-repo-hygiene.cjs
```

挡住的是「临时脚本被 `git add -A` 顺手带上」这类事故——这不是假设：抓 CI 日志用的 `ci-log.cjs` 就这样进过一次仓库，
而且它还会读本机 git 凭据。检查项：

- 根目录只允许白名单文件（`main.cjs`、`preload.cjs`、`package.json`、`package-lock.json`、`README.md`、`LICENSE`、`DESIGN.md`、`.gitignore`、`.gitattributes`）与白名单目录；
- 根目录出现 `patch-/fix-/audit-/ci-` 这类调试脚本名前缀即报错；
- 证书与密钥文件（`.p12/.pfx/.pem/.cer/.crt/.key/.keystore/.mobileprovision`）一律报错；
- 内容扫描：私钥块、证书块、`ghp_` / `sk-` 开头的凭据、`git credential fill` 这类读取本机凭据的代码。

CI 的每个平台任务都会先跑这一步（不依赖 `npm ci`，两秒内结束），`npm run test:all` 里也有。

### 发布后验证「别人 clone 能用」

```bash
node scripts/verify-fresh-clone.cjs
```

全新克隆到临时目录 → `npm ci` → 单元测试 → 平台检查 → 文件完整性。约 2 分钟（大头是下载 Electron）。
这一步不能进 CI 常规流程（太慢），但每次发布后值得手动跑一次——它验证的是「别人拿到手能不能用」，
而不是「我这台机器还能不能跑」。

## 2. 跑检查

分两批：先跑不花钱的，全绿再跑花钱的。

```bash
npm run prepare:ui                       # 图标字体与本地 Markdown 渲染器
npm test                                 # 211 项离线单测，fail 0 才算过
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

## 8. 要不要买签名证书

只在这里讨论，不放在 README 首页——读者需要知道「装了会弹警告、怎么点过去」，不需要知道采购决策。

| 路线 | 成本 | 用户看到什么 |
| --- | --- | --- |
| 不签名（当前） | 0 | 每个平台首次安装批准一次；Win11 智能应用控制环境与受管设备可能完全跑不了 |
| Windows Artifact Signing（原 Trusted Signing） | $9.99/月起，需身份验证 | 显示已验证的发布者名，但**首次下载仍可能警告**——SmartScreen 按下载量累积信誉，EV 证书已不再自动绕过 |
| Apple Developer Program + 公证 | $99/年，公证必须在 macOS 上做 | macOS 双击即开、无警告 |
| Microsoft Store（Windows） | 0，需商店账号与审核 | 无任何警告（微软重签名） |

配置位已留好：`package.json` 的 `build.mac.identity`（填证书名）与 `build.win`（`certificateSubjectName` / `azureSignOptions`）。
证书与私钥**绝不能进仓库**；CI 里用仓库 Secret 注入（当前未配置）。
