# 跨平台与公开发布改造方案

目标：Iris Unite 不止能在这台 Windows 机器上跑，还要能上传 GitHub、在其他设备上使用。

本文只写**改什么、为什么、按什么顺序**，以及**哪些结论有实测依据、哪些还没有**。

> 状态：**P0 已实施**（代码去绑定 + 三平台打包配置 + CI），实施记录见 `docs/CHANGELOG-0.6.md` §19。
> 仍然成立的前提：当前只在 Windows x64 上真机验证过；macOS / Linux 的分支有单测覆盖但没有真机验证。
> 撰写依据：本机实测（2026-10）+ 代码静态核查，命令与位置见各表格。

## 0. 结论先行

- 代码层可以改，**没有硬阻碍**。
- 主要工作量在三处：**去平台绑定**、**三平台打包**、**跨平台 CI**。
- 最大不确定不是技术，而是**没有 macOS / Linux 真机**：我只能验证 Windows，其他平台只能靠 CI 跑离线测试 + 使用者反馈。这一点必须写进 README，不能声称"已支持"。
- 三个外部成本无法用代码消除：macOS 签名与公证、Windows 代码签名、Linux 的 `libsecret` 依赖。

## 1. 实测到的平台绑定

| 位置 | 现状 | 影响 | 结论 |
| --- | --- | --- | --- |
| `main.cjs:44` 数据目录 | `app.getPath('appData')` | 已是跨平台 API（Win `%APPDATA%` / mac `~/Library/Application Support` / Linux `~/.config`） | 只需改正写死 `%APPDATA%` 的注释 |
| `core/exec/env.cjs:42` Python 探测 | `['python', 'py']` | macOS / Linux 常见只有 `python3`，没有 `python` 别名 → 找不到解释器 | **必修** |
| `core/exec/runner.cjs:25` 杀进程树 | Windows `taskkill /T /F`；其他平台 `SIGKILL` 父进程 | Linux/mac 上训练子进程会变孤儿 | **必修**（POSIX 进程组） |
| `main.cjs:688` 窗口 | `frame: false` 自绘标题栏；`assets/iris.ico` | macOS 丢红绿灯按钮；图标格式不够 | **必修** |
| `package.json:22` 打包 | 仅 `--platform=win32 --arch=x64` | 无法产出 mac / linux 包 | **必修** |
| `core/providers.cjs:12` Codex 路径 | 写死 `AppData/Local/OpenAI/Codex/bin` | 非 Windows 无效 | 降级为可选能力 |
| `core/history.cjs:6` DSH 路径 | 写死 `AppData/Local/Programs/DSH Desktop` | 非 Windows 无效（有 `DSH_HOME` 兜底） | 降级为可选能力 |
| `renderer/*` 字体栈 | `PingFang SC` / `Microsoft YaHei` | Linux 缺 CJK 字体时回退难看 | 补 `Noto Sans CJK SC` |
| `.gitignore` | 已排除 `build/ release/ artifacts/ .local-data/ .test-data/ .verification-profile/ node_modules/` | 基本够 | 补 `Iris-data/`、`.DS_Store`、`Thumbs.db` |
| 仓库 | **尚无 `.git`** | 初始化前需体检 | 见 §5 |

## 2. 运行时去绑定（P0）

### 2.1 Python 探测

- 候选顺序：`IRIS_PYTHON` → `python3` → `python` → `py -3`（Windows）
- 版本门槛保持 3.8+，实际建议 3.10+
- 全部候选失败时给出可操作提示：装 Python、或设置 `IRIS_PYTHON` 指向解释器
- 记录最终选中的解释器路径到运行记录（manifest 里已有 `env.pythonPath`）

### 2.2 进程树杀灭

- POSIX：`spawn(..., { detached: true })`，超时/取消时 `process.kill(-child.pid, 'SIGKILL')` 杀掉整个进程组
- Windows：保留 `taskkill /pid <pid> /T /F`
- 统一入口保持 `killTree(child)`，调用方不关心平台
- 验收：超时与取消两条路径在 Windows 实测已过（`tests/exec-run.test.cjs`）；POSIX 路径需 CI 覆盖

### 2.3 窗口与图标

| 平台 | 窗口 | 图标 |
| --- | --- | --- |
| Windows | 保持自绘标题栏 | `assets/iris.ico` |
| macOS | `titleBarStyle: 'hiddenInset'` + `trafficLightPosition`，保留系统红绿灯 | `assets/iris.icns` |
| Linux | 自绘标题栏，需实测最大化/拖拽 | `assets/iris.png`（256×256 起） |

快捷键：`Ctrl+N` → mac 上 `Cmd+N`；判定用 `process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'`。

### 2.4 本机集成降级

`Codex`（本机 CLI）与 `DSH`（本机历史）是**可选的增强**，不是核心路径：

- 按平台计算候选路径，全部不存在时把入口隐藏，并在设置页说明"本机未检测到"
- 不允许因为缺失而在启动或初始化阶段抛错
- `useDshKey` 默认复用行为在非 Windows 上应为关闭

## 3. 打包与分发（P0）

### 3.1 工具选择

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| 保留 `electron-packager` + 三平台脚本 | 改动小 | 只出免安装目录，没有安装器/dmg/AppImage |
| 换 `electron-builder`（建议） | 安装器、dmg、AppImage/deb、自动更新、签名配置 | 需要重写打包配置，首次产出需重新验证 |

建议换 `electron-builder`，理由：公开发布的目标用户不会习惯解压目录再找 exe。

### 3.2 产物矩阵

| 平台 | 目标 | 说明 |
| --- | --- | --- |
| Windows x64 | `nsis`（安装器）+ `portable` | 未签名会触发 SmartScreen |
| macOS arm64 / x64 | `dmg` | 未签名 + 未公证需右键打开 |
| Linux x64 | `AppImage` + `deb` | `deb` 需声明 `libsecret-1-0` 依赖 |

### 3.3 便携 Python（决策点）

执行平台当前强依赖本机 Python。两条路：

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| A. 要求用户自备 Python | README 写明版本要求 | 简单；但"装不上就跑不了实验"是最大劝退点 |
| B. 内置便携 Python（建议） | 随应用分发 `python-build-standalone`，首次用它建 venv | 体积 +30–50 MB；PSF 许可允许再分发；跨设备零依赖 |

## 4. 跨平台 CI（P1）

- GitHub Actions 矩阵：`windows-latest` / `macos-latest` / `ubuntu-latest`
- 每次跑 `npm test`（离线 163 项）+ `npm run test:all -- --skip-live`（跳过真实模型调用与打包验收）
- UI 类 harness 需要显示环境：Linux 用 `xvfb-run`，或统一改用 Electron offscreen 模式
- 产物上传：`build/` 目录作为 workflow artifact，不打进仓库

## 5. 仓库体检与发布配套（P1）

初始化 `git` **之前**必须确认以下内容不在待提交列表：

- `settings.json`（含加密后的 API Key）
- `conversations.json`、`knowledge/`（真实对话与资料库）
- `.verification-profile/`、`.test-data/`、`.local-data/`、`artifacts/`
- `build/`、`release/`（各约 250 MB，且含 `Iris-data/` 用户数据）

配套文件：

- `.gitattributes`（统一换行，避免 Windows 检出的 CRLF 污染 diff）
- `README.md` 增加英文摘要 + 平台支持矩阵 + **明确标注哪些平台未真机验证**
- `SECURITY.md`：威胁模型（密钥本机加密、实验代码执行边界、数字门禁只保证指回运行记录）
- `CONTRIBUTING.md`：如何在无 GPU 环境下跑测试

## 6. 跨设备能力适配（P2）

- 执行模板平台感知：NVIDIA → CUDA，Apple Silicon → MPS，其他 → CPU；模板的 `requires` 需要能表达这一点
- 沙箱 driver 泛化：Windows=WSL、macOS=`sandbox-exec`、Linux=`bubblewrap`/容器；接口沿用 `core/exec/driver.cjs`，按平台选择实现
- 深度学习模板：`digit-cnn` 仍是占位，需要 PyTorch 与数据下载策略；不同平台的有效 wheel 不同

## 7. 三个必须提前知道的硬约束

1. **无 macOS / Linux 真机**：只能真机验证 Windows。CI 能覆盖逻辑与部分 UI，但不能替代"在真机上点一遍"。README 必须如实写明。
2. **未签名产物会被系统拦**：macOS Gatekeeper、Windows SmartScreen 都会警告；消除需要付费证书（Apple 约 $99/年）。
3. **Linux 依赖系统库**：`safeStorage` 需要 `libsecret`，精简发行版要用户自行安装。

## 8. 执行顺序

1. P0 代码去绑定（Python 探测、进程组、窗口与图标、本机集成降级）
2. P0 三平台打包配置，产出可安装包
3. P1 CI 三平台先绿（这是唯一能替他机验证的手段）
4. P1 仓库体检、`.gitignore`/`.gitattributes`、README/SECURITY
5. P2 平台感知模板与沙箱 driver

## 9. 决策结果（2026-10）

| 编号 | 决策 | 结论与理由 |
| --- | --- | --- |
| D1 | 便携 Python | **选 A：要求自装**。B 案要 +30–50 MB，且三平台解释器包在 Windows 上无法验证；先走「自备 + 明确提示」，探测失败时把试过的候选全部列出来 |
| D2 | 打包工具 | **选 electron-builder**，但保留 packager 脚本不删。Windows 侧已实测产出 NSIS 安装器与 portable；mac / Linux 由 CI 产出 |
| D3 | 代码签名 | **暂不购买**。配置位留在 `build.mac.identity` 与 `build.win`；未签名的系统拦截处理方式写进 README |
| D4 | 英文 README | **做**。在首页加了 English summary，但完整文档仍是中文 |
| D5 | Linux 发行形态 | **AppImage + deb 都给**。deb 声明 `libsecret-1-0` 等依赖，AppImage 免安装 |

仍未决（需要真实条件才能推进）：mac / Linux 真机验证、便携 Python、GPU 感知模板与沙箱 driver（P2）。
