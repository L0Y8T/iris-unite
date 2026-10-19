# Iris Unite 项目完整说明与交接文档

版本 0.5.0　整理日期 2026 年 10 月 19 日　适用平台 Windows x64

Iris Unite 已完成多模型对话工作台的本地实现与 Windows 打包发布。它在一个窗口中提供 DeepSeek、经 Codex 调用的 GPT 和用户配置的其他模型，统一展示本机历史与工作区，并支持普通协作及三层科研流程。本说明覆盖需求、使用方法、实现结构、全部主要文件、数据与接口、构建部署、测试证据和后续维护，供项目所有者和接手开发者使用。

当前可直接使用桌面 Iris Unite 快捷方式。发布程序已采用 project 中的鸢尾花图标，保留旧版本地对话及设置，原客户端的历史继续按只读方式读取。模型能力、账户权限和网络可用性仍由各自服务决定。

| 项目项 | 当前值 |
| --- | --- |
| 正式名称 | Iris Unite |
| 版本与包名 | 0.5.0；iris-unite |
| 源码目录 | %USERPROFILE%\Desktop\Project\duet-desktop |
| 当前程序 | release\IrisUnite-win32-x64\IrisUnite.exe |
| 当前个人数据 | release\IrisUnite-win32-x64\Iris-data |
| 桌面入口 | %USERPROFILE%\Desktop\Iris Unite.lnk |
| 本文档存放位置 | %USERPROFILE%\Desktop\Project |

后文中“项目根目录”指上述 duet-desktop 源码目录；没有特别标注的相对路径均以该目录为起点。

2026 年 10 月 19 日本项目已整体从 `<原项目目录>` 迁移到 `%USERPROFILE%\Desktop\Project`：14 680 个文件、2 204 201 871 字节逐个比对 SHA-256 全部一致后才删除原目录，原址留有《项目已迁移.md》指向新位置。程序内部没有写死的绝对路径，数据目录按 exe 所在位置推算，桌面快捷方式已改指新路径。本文档中原先出现的旧路径已按新位置更新；`artifacts\v2` 至 `v5` 的历史报告保留当时的绝对路径，它们只是那次运行的记录，未作改写。

源码保留 duet-desktop 目录名，内部 duet IPC 名称和旧主题存储键也保留，以兼容既有路径及数据。

## 内容导航

1 项目目标与需求完成情况

2 启动与日常使用

3 模型连接与推理强度

4 普通对话的模型协作

5 科研模式的架构与预算

6 界面与交互设计

7 技术架构与执行生命周期

8 数据结构与安全边界

9 项目目录与全部主要文件索引

10 开发构建部署与回滚

11 测试结果与验证证据

12 已知限制故障处理与后续方向

附录 A 预加载接口与事件　附录 B 依赖与证据索引

## 1 项目目标与需求完成情况

### 1.1 软件定位

软件将模型调用、对话历史和工作区组织整合为一个 Electron 桌面工作台。DeepSeek 使用 API；GPT 使用本机已登录的 Codex CLI；其他模型通过用户保存的连接配置调用。当前实现复用本机配置和可读取的历史文件，不嵌入 DSH Desktop 或 Codex 原窗口，也不复制它们的整个运行环境。

用户最初提供的 DeepSeek 客户端为 %USERPROFILE%\AppData\Local\Programs\DSH Desktop。项目据此兼容其本机会话和压缩记录解析方式；DSH 用户数据默认在 %USERPROFILE%\.dsh，Codex 用户数据默认在 %USERPROFILE%\.codex。

### 1.2 需求与实现对应表

| 用户需求 | 当前实现与入口 |
| --- | --- |
| 同一窗口调用 DeepSeek 和 GPT | 统一聊天页；可单独启用或联合启用 |
| 查看原有对话和历史 | 全部对话、工作区树、来源筛选；原始记录只读 |
| 至少选择一个模型 | 前端与主进程均校验；普通对话最多六个参与模型 |
| 取消最后一个模型时提示 | 显示“至少使用一个模型”，2.5 秒后开始淡出，无需点击关闭 |
| 所有项目资料集中管理 | 应用、源码、素材、测试和备份位于桌面 Project 目录 |
| 桌面快捷方式 | Iris Unite.lnk 指向当前发布程序并使用鸢尾花图标 |
| 展示工作区和旗下对话 | 读取 DSH 与 Codex 工作区；可新增文件夹并移动本地对话 |
| 选择模型强度 | Power 拖动滑块、档位按钮和精确选择；能力按模型校验 |
| 不展开菜单也看见模型名称 | 输入区直接显示具体模型名称和当前强度 |
| 简约黑白界面 | 浅色、深色及跟随系统；DSH 风格导航与 Codex 风格模型控制 |
| 模型相互审阅并形成唯一答案 | 独立大纲、交叉审查、综合大纲、统筹分配、完整写作 |
| 默认隐藏过程并显示阶段 | 运行时显示真实阶段；公开协作记录可展开，正文保持一份最终答案 |
| 删除演示模式 | 正式界面没有演示模式；早期随附样例被隐藏且原数据保留 |
| 正式名称和图标 | 名称统一为 Iris Unite；使用用户提供的 Iris icon 素材 |
| 接入其他 AI | 设置中管理 OpenAI 兼容或 Claude Messages 连接 |
| 科研模式参考 5122 图片 | GPT 统筹、可配置的第二层并行任务、GPT 最终反证整合 |

### 1.3 演进与兼容

早期版本以 Duet 命名，实现了双模型调用和本机历史。后续逐步加入工作区、强度设置、五阶段协作和界面完善。0.5.0 完成 Iris Unite 品牌、多模型连接和科研架构。保留的备份目录记录了 v0.2、v0.3、v0.4 和 v0.5 修改前的状态；旧版 release\Duet-win32-x64 仍保留，作为回退依据。

## 2 启动与日常使用

### 2.1 启动入口

双击桌面 Iris Unite 快捷方式，或运行 %USERPROFILE%\Desktop\Project\打开 Iris Unite.cmd。也可直接启动项目根目录下 release\IrisUnite-win32-x64\IrisUnite.exe。旧入口 打开 Duet Demo.cmd 已改为启动新版，文件名仅为兼容保留。

当前发布形式是 Windows 解压目录，IrisUnite.exe 需要与 resources、locales、DLL、PAK 和其他 Electron 运行文件一起保留。复制到其他位置时应复制整个发布目录；它不是单文件安装包。

### 2.2 新建和发送

1. 点击“新会话”，根据需要先选工作区。
2. 在输入区选择“对话”或“科研模式”。
3. 普通对话中勾选参与模型，点击强度区域调整 Power；科研模式中点击“配置研究架构”。
4. 输入问题后按 Enter 发送；Shift 加 Enter 换行。
5. 观察当前阶段、任务完成数量及耗时。科研模式还显示实际调用次数。
6. 生成时发送按钮变为停止按钮，可取消当前轮次。

模型或模式设置按对话保存，修改只影响后续消息。正在运行的对话不能修改模型、强度、模式或所属工作区。连接配置的编辑与移除在有任务运行时被阻止，避免本轮调用中途切换凭据或地址。

### 2.3 工作区和历史

左侧显示工作区树及旗下对话，可搜索工作区名称和对话标题。“全部对话”提供来源筛选；“工作区”显示工作区卡片。点击加号选择本地文件夹可添加工作区；本地会话顶部的工作区选择框可移动会话。

原客户端的显式工作区分配优先于目录推断。目录匹配采用 Windows 大小写不敏感的规范化路径，并优先匹配更具体的嵌套目录。未归入工作区的会话显示在“未分组”。空工作区也会保留显示。

DSH 与 Codex 原始对话只读打开，不会在原文件中追加消息。点击“从这里继续”会在 Iris Unite 建立一份可编辑的本地副本，保留导入来源，并从该副本继续调用模型。刷新按钮重新扫描本机历史；历史数量会随原客户端新增会话而变化。

### 2.4 回答与过程记录

正文只展示所选写作者生成的一份最终回答。中间大纲、评审和提案保存在公开协作记录中，默认折叠，可通过“思考过程”或“协作记录”查看。这里的“思考过程”是模型公开生成的工作材料，不是模型内部思维链。

回答支持 Markdown、列表、表格、网页链接与代码复制。导出按钮可将对话正文保存为 Markdown 文件；它不把全部中间协作材料附加到正文。重命名按钮修改本地对话名称。

### 2.5 外观与快捷键

左下角外观按钮切换浅色、深色或跟随系统，偏好存放在 Chromium 本地存储。Ctrl 加 N 新建会话，Ctrl 加 B 切换侧栏。模型弹层支持 Escape 关闭并返回触发按钮，原生 Power 滑块支持方向键、Home 和 End。

## 3 模型连接与推理强度

### 3.1 内置 DeepSeek

DeepSeek 由主进程直接请求 https://api.deepseek.com/chat/completions。当前目录包含 DeepSeek Flash 和 DeepSeek V4 Pro 的选择项；默认模型 ID 为 deepseek-flash。强度为 off、low、high、max，分别映射快速、轻量、高、最高。off 关闭 thinking，其余档位启用 thinking 并发送 reasoning_effort。

凭据使用顺序为：Iris Unite 自定义加密密钥、DEEPSEEK_API_KEY 环境变量、允许复用时的 DSH .credentials.yaml。界面显示凭据来源和是否已配置，不显示密钥原文。默认模型名称可在设置中修改，实际可用性由 DeepSeek 账户和服务端决定。

### 3.2 内置 GPT 与 Codex

程序先通过 where.exe 查找 codex.exe，再查找本机 AppData\Local\OpenAI\Codex\bin 下的可执行文件。模型目录和强度能力来自 .codex\models_cache.json，默认值结合 config.toml；缓存缺失时回退到当前配置或 Codex 默认模型。

请求使用 codex exec，开启 ephemeral 与 JSON 输出，跳过 Git 仓库检查，使用 read-only 沙箱和 approval_policy="never"。模型和强度通过 --model 与 model_reasoning_effort 传入。需要严格结构化返回时，为每次调用生成独立 UUID schema 文件，结束后清理，避免并发写入同一 schema。

GPT 调用使用 Codex 的既有登录状态，不能仅凭一个下拉选项获得模型权限。启动前需在本机安装并登录 Codex；目录列出的模型仍可能因账户或服务状态而不可调用。

### 3.3 添加其他模型

进入“连接设置 → 其他 AI 模型 → 添加模型”，填写并保存连接，再点击“测试”。已保存的连接可启用、停用、编辑或移除。启用后，它会出现在普通对话参与模型选择和科研任务的模型选择中。

| 字段 | 含义和校验 |
| --- | --- |
| 显示名称 | 用户看到的模型名称，最长 60 字符 |
| 接口格式 | OpenAI 兼容，或 Claude 官方 Messages 格式 |
| API Base URL | 应包含服务所需版本路径；远程 HTTPS，本机可用 HTTP |
| 模型 ID | 服务商给出的完整 ID；连接表单最长 150 字符 |
| API Key | 密码框输入；本机加密保存；编辑留空保留 |
| 推理参数 | 默认不发送；可声明 reasoning_effort 或 output_config.effort |
| 输出 token 上限 | 256 至 65536，默认 8192 |
| 启用此模型 | 决定它是否进入可选目录 |
| 无需 API Key | 用于本地或自行管理鉴权的兼容服务 |
| 移除已保存密钥 | 清除该配置的加密密钥 |

OpenAI 兼容接口在 Base URL 后补 /chat/completions，使用 Bearer 鉴权。Claude 格式补 /messages，使用 x-api-key 和 anthropic-version；system 内容独立传递。已填写完整终点路径时不会重复追加。

连接可以用于兼容云端服务或本地服务，但当前不提供 OAuth、Azure 专用部署参数、任意自定义请求头或工具调用协议。应按服务文档确认模型 ID、接口格式和参数支持情况。API Key 不会随着界面初始化返回给渲染层；更换地址而未填写新密钥时，旧密钥被清除，避免发送到另一端点。

连接测试会发起一次真实短请求，45 秒超时，使用 default 强度并限制输出；会消耗服务额度。测试成功只说明该次基础请求可用，不代表该连接的所有推理档位均已验证。

### 3.4 Power 控件及能力声明

输入区的模型名称与强度分开操作：名称侧勾选启停，右侧打开强度弹层。“+” 打开参与模型列表。Power 原生拖动滑块、档位按钮和高级精确选项共享同一份模型配置，不用打开菜单就能看到当前模型和档位。

| 连接类型 | 可选择的推理档位 |
| --- | --- |
| GPT 内置 | 根据本机模型目录提供的 supported_reasoning_levels |
| DeepSeek 内置 | off、low、high、max |
| 其他模型 服务端默认 | 仅 default，滑块禁用，不假设额外能力 |
| 其他模型 OpenAI 推理参数 | default、low、medium、high、xhigh |
| 其他模型 Claude 推理参数 | default、low、medium、high、xhigh、max |

其他连接的强度列表来自用户明确声明的参数格式，不会自动探测服务端能力。default 不发送推理强度参数。若服务只支持部分档位，应选择其文档支持的值。连接名称不等于实际模型权限，改变显示名称不会切换服务端模型。

## 4 普通对话的模型协作

### 4.1 单模型

仅选择一个模型时直接生成完整答案，不额外调用其他模型或运行协作中间阶段。即使 GPT 已配置，在未勾选时也不会被普通对话暗中调用。

### 4.2 多模型五阶段

| 阶段 | 输入与任务 | 产物 |
| --- | --- | --- |
| 独立大纲 | 各模型独立处理用户问题和共享历史 | 每个模型一份初始大纲 |
| 交叉审查 | 读取全部大纲，严格指出其他模型的错误、遗漏与假设 | 发给其他参与者的公开评审 |
| 综合大纲 | 阅读各份大纲和收到的评审，修正并综合 | 每个模型一份修订大纲 |
| 统筹分配 | 读取全部材料，综合最终提案并选唯一写作者 | outline、writer、instructions、reason |
| 完整写作 | 写作者读取提案、修订大纲和评审 | 唯一完整答案 |

GPT 启用时承担统筹角色；未启用 GPT 时由当前参与列表中的第一个模型统筹。写作者必须在当前启用的模型中，结构化 schema 的 writer 枚举按本轮参与者构造。提案 JSON 无效、缺字段或选择了禁用模型时会停止，不把错误提案当成最终答案。

每个模型接收最近 40 条符合条件的对话文字，再附加当前阶段任务与协作资料。共享资料包含其他模型的公开成果，不包含其私有推理块。失败、未完成和停止的助手回答不会进入后续已完成回答上下文；用户消息仍按消息列表参与截取。当前问题存在于历史末尾和阶段说明中，当前实现没有为两处重复自动去重。

N 个模型的一次完整普通协作需要 3N 加 2 次模型调用；双模型通常为 8 次。普通协作目前没有科研模式那样的可配置调用次数上限，多模型和高强度会增加延迟与费用。

### 4.3 并行与失败处理

同一阶段的独立任务并行执行，阶段之间按依赖顺序推进。任何一个并行任务失败都会取消其余同阶段任务并停止后续阶段。停止按钮通过 AbortController 传递取消信号；Codex 子进程随之终止。单轮主流程设有 20 分钟超时。

## 5 科研模式的架构与预算

### 5.1 三层架构

科研模式参考 project\5122.jpg，在独立的配置中组织职责和模型。它与普通对话模型勾选分开保存，进入科研模式后输入区改为显示统筹、各研究任务及终审实际使用的模型和强度。

| 层次 | 默认配置 | 职责与可配置内容 |
| --- | --- | --- |
| 第一层 科研统筹 | GPT-6.1 Sol / medium | 分解问题、分配任务、规定筛选标准；可选 GPT 模型和支持的强度 |
| 第二层 任务一 | DeepSeek Flash / low | 发散技术路线；任务名、职责、模型、强度均可修改 |
| 第二层 任务二 | 已启用 Claude 连接优先，否则 GPT / high | 机制与创新性；可独立选择任何已启用模型 |
| 第三层 最终反证审查 | GPT-6.1 Sol / xhigh | 检验机制和证据，整合路线并输出科研答案；可选 GPT 模型和强度 |

默认优先使用本机目录中的 GPT-6.1 Sol；如不存在，则使用可用的 GPT 默认项及其支持强度。第二层支持 1 至 4 项任务，同一个模型可以承担不同任务，也可以每项使用不同模型。Claude 并非随软件附送的已开通服务：需要用户先添加并启用相应连接。默认选择 Claude 的实现依据是已启用连接名称或模型 ID 中的 Claude 或 Opus 标识。

### 5.2 执行阶段

1. 问题分解：统筹返回 objective、tasks 和 selectionCriteria。任务 ID 必须与用户配置逐一对应。
2. 并行研究：第二层按各自的模型与强度独立工作，输出技术路线、机制、创新性、关键证据需求及可证伪实验。
3. 候选筛选：统筹读取全部研究成果，返回 selectedIds、refineIds、feedback 和 reason。
4. 定向深化：允许且预算足够时，选中的任务读取其他任务成果和评审，完成一轮修订。没有执行时明确记录跳过。
5. 反证与整合：第三层 GPT 读取完整材料，检验证据、替代解释和反例，形成唯一完整答案。

任务 ID、筛选结果、重复项和输出结构均校验。refineIds 必须属于 selectedIds；统筹不能通过自行编造任务 ID 扩大调用范围。公开过程会记录阶段、任务名称、具体模型、强度、状态及时间。

### 5.3 调用预算

默认预算为 8 次调用；有效范围从“第二层任务数加 3”到 16。例如两项研究任务至少需要 5 次：问题分解一次、研究两次、筛选一次、终审一次。所有请求在开始前计数，失败请求也消耗一次预算。

筛选后先为最终审查预留一次调用，再决定可执行多少项深化。每个第二层任务最多追加一轮深化；配置的 16 次是允许的上限，并不意味着每次都会用满。追加深化被预算裁减时记录原因，未执行的阶段在界面标为跳过。关闭追加深化后流程只显示四个实际阶段。

调用次数预算不能保证金额、token 总量或耗时。一次高强度模型请求可能产生较大费用；本版没有跨模型 token 账本、实际账单读取或月度额度管理。

### 5.4 科研内容边界

提示要求区分已有证据、假设与建议实验，不虚构论文、DOI、检索结果或实验数据。当前科研模式不自动检索文献、不浏览网页、不运行实验，也不提供论文数据库连接。模型仍可能出错，关键结论和引用需要使用者核验。

独立研究阶段各任务先看到统筹计划与自己的任务，筛选者和终审者读取全部成果；被要求深化的任务再读取其他任务的成果。它不是持续广播的实时模型聊天室。

## 6 界面与交互设计

### 6.1 布局与视觉

整体采用 DSH Desktop 风格的左侧工作区树、顶部路径导航和右侧阅读区，结合 Codex 风格的模型名称、Power 控件及运行阶段。主阅读列和输入区对齐，保持黑白灰语义色、清晰层级和稳定留白。Windows 中文显示采用系统字体栈；图标为选取的 Tabler 描边图标及用户提供的鸢尾花品牌图标。

（0.5 时代的界面截图未随仓库提供；当前界面可用 `npm run test:frontend` 重新生成）

浅色、深色和跟随系统共用语义 token；样式按 tokens.css、styles.css、premium.css、iris.css、dsh.css 顺序叠加。新品牌的浅色和深色 SVG 随主题切换。选中状态使用勾选、边框与文字，不单靠颜色区分。

### 6.1.1 与 DeepSeek Desktop 的设计对齐

0.5.0 之后做了一次界面重排，把配色、字号与控件几何改成 DeepSeek Desktop 的 design-platform 体系，作为最后加载的 `renderer/dsh.css` 生效：

| 方面 | 现在的做法 |
| --- | --- |
| 中性色 | 冷灰“bluish”色阶：正文 #0f1115、次级 #61666b、侧栏 #f9fafb、深色画布 #151517、深色侧栏 #1b1b1c |
| 分隔线 | 0.5px 半透明线（4%/10%/12%/16% 黑），替代原来的 1px 灰实线 |
| 强调色 | 品牌近黑；蓝色只用于链接和当前标签页（浅色 #2563eb、深色 #679efe） |
| 正文 | 14px/24px；标题梯度压缩为 21/19/18/14，段距 16px，列表缩进 18px |
| 用户气泡 | #edf3fe 淡蓝底、22px 圆角、10px 16px 内边距 |
| 控件 | 胶囊形（999px）用于按钮、模型名、模式切换；输入框 8px 圆角配 0.5px 边框；弹层 20px 圆角配描边+大阴影 |
| 字体 | DeepSeek 字体栈（Segoe UI / PingFang SC / Microsoft YaHei） |
| 动效 | 200ms cubic-bezier(.4,0,.2,1) |

文字灰度比 DeepSeek Desktop 自己的第三级更暗，因为它的 #81858c 在白色上只有 3.7:1，达不到 WCAG AA；本项目三级文字都按最暗常用底色 #ebeef2 校准到 4.6:1 以上，层级改由字号和字重承担。

### 6.2 模型控制与反馈

模型控件采用名称、启用状态、强度触发区域分组。Power 弹层提供模型下拉框、原生 range、明确档位及高级选项，避免只显示抽象进度而看不清真正参数。模型名称始终留在输入区。

最后一个模型取消操作不会打开阻塞弹窗，而是显示 2.5 秒提示后用 300 毫秒淡出；早期真实界面验证记录为约 2530 毫秒开始淡出。普通错误提示使用更长显示时间。运行进度依据真实阶段事件与任务数量，不伪造百分比或预计完成时间。

### 6.3 可访问性和窗口尺寸

使用语义按钮、原生 dialog、表单 label、可见焦点、键盘滑块、aria-live 状态和跳转输入框链接。Markdown 表格可横向滚动并设置表头语义，代码块可复制，减少动画偏好可关闭非必要过渡。

桌面主窗口默认 1380×920，最小 940×660。渲染层另外测试过 1440、1024、768 和 320 像素宽度；窄布局用侧栏抽屉和控件换行。320 像素验证是渲染层适配检查，不表示原生 Windows 窗口允许缩到该宽度。

## 7 技术架构与执行生命周期

### 7.1 进程与模块分工

| 层次 | 入口 | 主要职责 |
| --- | --- | --- |
| Electron 主进程 | main.cjs | 窗口、配置、凭据、IPC 校验、运行调度、持久化 |
| 预加载桥 | preload.cjs | 向页面暴露有限的 window.duet 方法与事件订阅 |
| 渲染层 | renderer/index.html、app.js、iris-ui.js | 导航、历史显示、聊天、模型配置和科研配置 |
| 历史 Worker | core/history-worker.cjs | 扫描 DSH 与 Codex 并解码记录，避免阻塞界面 |
| 流程层 | core/collaboration.cjs、research.cjs | 阶段依赖、并行任务、结构校验、预算及公开产物 |
| 调用层 | core/providers.cjs、custom-provider.cjs | Codex CLI、DeepSeek HTTP、其他模型 HTTP |
| 数据与能力层 | store.cjs、models.cjs、connections.cjs、workspaces.cjs | 本地数据、模型能力、连接校验和工作区归属 |

页面没有 Node.js 集成，contextIsolation 和 sandbox 开启。所有模型请求和密钥解密在主进程完成；渲染层只通过预加载桥请求有限操作。主进程校验 IPC 来源必须是本窗口主 frame。

### 7.2 发送一轮消息的生命周期

1. 前端提交会话 ID 和消息文本；主进程校验非空、长度上限 50000、当前会话未运行，以及参与模型和凭据可用。
2. 保存用户消息和一条 streaming 助手占位消息，复制本轮上下文及配置快照。
3. 注册 AbortController、20 分钟计时器和运行状态后，先把占位返回给前端，再用 setImmediate 启动流程，避免早到事件覆盖初始数据。
4. 流程发出阶段、产物、预算等事件；仅最终写作内容进入正文 delta。
5. 阶段变化立即保存，连续文本增量通过约 500 毫秒节流保存。
6. 成功标记 done；用户停止或失败分别标记 stopped、error；清理计时器和运行状态并发出完成事件。

切换到其他会话不会取消后台正在运行的会话；running 以会话 ID 管理。单个会话同一时间只能生成一轮。历史 Worker 请求设有 120 秒读取超时；连接测试独立设有 45 秒超时。

### 7.3 历史解码和归属

Codex 读取 sessions 下 JSONL，会按当前 item_completed、旧 user_message/agent_message、response_item 的优先级选取文字消息，去重并过滤环境注入内容，排除子代理会话；session_index.jsonl 补充标题。工作区来自 .codex-global-state.json 中的项目、顺序与线程分配。

DSH 列表来自 .dsh\sessions 与会话投影缓存，工作区来自 storages\workspace.json。普通 JSONL 直接解析；.zstd 使用已安装 DSH 的 @deepseek-ai/dsh-session-persistence-jsonl 解码模块，只调用读取前缀的方法，不启动其服务或追加逻辑。因此 DSH 安装路径或内部模块变化可能影响压缩记录读取。

## 8 数据结构与安全边界

### 8.1 目录和存储规则

| 数据环境 | 存放位置 | 用途 |
| --- | --- | --- |
| 正式新版 | release\IrisUnite-win32-x64\Iris-data | 用户本地记录和设置 |
| 正式旧版 | release\Duet-win32-x64\Duet-data | 迁移前保留副本 |
| 源码开发 | .local-data | npm start 使用的数据 |
| 前端科研检查 | .test-data\v5-ui | 新版界面和科研测试隔离数据 |
| 早期界面检查 | .test-data\v3-ui | 真实普通协作回归资料 |
| 打包验收 | 可执行文件旁 .verification-profile | 独立测试配置；安装目录验收后已清理 |
| 渲染器状态 | 相应数据目录中的 chromium | 主题等 Chromium 本地存储与缓存 |

打包正常启动时优先使用已有 Iris-data；若没有但存在同目录 Duet-data 则兼容使用；两者都没有时建立 Iris-data。源码测试标志只在未打包环境启用，避免正式应用进入前端自动测试。

### 8.2 本地 JSON 结构

conversations.json 根结构包含 version、conversations 和 workspaces，目前存储版本为 3。会话保存 ID、标题、来源、模型列表、模型配置、工作区、cwd、时间、消息、模式、科研配置及可选导入来源。消息保存 role、text、status、provider、model、effort、roundId 和时间；助手消息还可包含 collaboration。

| 对象 | 主要字段 |
| --- | --- |
| modelConfig | provider ID 对应的 model 与 effort |
| researchConfig | orchestrator、reviewer、tasks、maxCalls、allowRefinement |
| 研究 task | id、title、brief、choice；choice 包含 provider、model、effort |
| collaboration | mode、status、stage、stages、participants、artifacts、writer、时间 |
| 普通协作 plan | outline、writer、instructions、reason |
| 科研运行扩展 | researchPlan、selection、callsUsed、callBudget、skippedStages |
| artifact | ID、阶段、来源、接收者或任务、公开文字、状态、时间、错误 |
| 自定义 connection | id、name、model、protocol、baseUrl、effortMode、enabled、allowNoKey、maxTokens、encryptedKey |

settings.json 保存默认模型、DeepSeek 凭据来源选项、自定义加密密钥及 connections。给界面的公开配置只包含是否有密钥等状态，不含 encryptedKey 或密钥原文。当前界面返回的 defaultResearchConfig 是根据当前模型目录计算的初始值；实际编辑后的科研设置随各对话保存。

JSON 使用临时文件写入后 rename 替换，减少写到一半破坏原文件的风险。无法解析已有 conversations.json 时抛错并保留原文件，不直接覆盖。重新打开应用时，未完成 streaming 消息恢复为 stopped，相应运行产物标为中断，不冒充完成结果。

### 8.3 密钥和内容保护

API Key 用 Electron safeStorage 在 Windows 本机加密，属于当前 Windows 用户环境。复制整个目录到其他电脑或其他 Windows 账户后，旧加密密钥可能无法解密，需要重新输入。DSH 自身凭据文件维持原存储方式，Iris Unite 只在被允许时读取。

远程自定义地址要求 HTTPS，localhost、127.0.0.1 和 IPv6 回环可使用 HTTP；地址中不允许账号、密码、查询参数或 fragment。HTTP 重定向被拒绝。自定义服务错误只显示名称与状态等简要信息，避免把服务原始响应和请求凭据写入界面或日志。

页面启用本地资源 CSP，connect-src 为 none；原始 HTML 经过转义，Markdown 用 DOMPurify 白名单净化。外部链接仅允许用户主动打开 HTTP 或 HTTPS，禁止任意新窗口和页面导航。该边界不意味着用户提供的模型输出天然可信，协作提示还要求把其他模型材料作为待审阅数据。

Codex 的文字任务禁止工具属于调用指令，同时配置 read-only 沙箱和禁止审批；本项目未实现独立的网络隔离或对第三方 CLI 的完整安全审计。向所选云端模型发送问题时，相应上下文与公开协作资料会到达该服务。本文档只记录字段和位置，不包含实际密钥或私人对话正文。

## 9 项目目录与全部主要文件索引

### 9.1 外层 project 文件夹

| 路径 | 作用 |
| --- | --- |
| duet-desktop | Iris Unite 应用源码、依赖、发布文件、备份和测试证据 |
| Iris icon | 用户提供的 ICO、PNG、SVG 及深色图标原素材 |
| 5122.jpg | 科研三层架构的原始参考图片 |
| 打开 Iris Unite.cmd | 当前发布程序的兼容启动脚本 |
| 打开 Duet Demo.cmd | 旧文件名入口，当前也启动 Iris Unite |
| .npm-cache | 构建下载与 npm 缓存，不是业务源码 |
| pelican-cycling.html | 同目录的独立鹈鹕骑行动画网页，不由 Iris Unite 加载 |

### 9.2 源码根目录与核心模块

| 文件 | 主要职责 |
| --- | --- |
| package.json | 包名、版本、依赖与启动测试打包脚本 |
| package-lock.json | 锁定完整依赖树，供 npm ci 重现安装 |
| main.cjs | Electron 主进程、数据目录、凭据、IPC、模型流程和导出 |
| preload.cjs | window.duet 有限接口桥接与事件订阅 |
| README.md | 日常使用、连接配置、科研模式与开发说明 |
| DESIGN.md | 当前设计规则及此前界面审计依据 |
| core/collaboration.cjs | 单模型和普通五阶段协作、提案校验、并行失败取消 |
| core/research.cjs | 科研默认值、任务配置、预算、阶段和终审 |
| core/providers.cjs | Codex 查找与子进程调用、DeepSeek 凭据和请求、SSE、共享上下文 |
| core/custom-provider.cjs | OpenAI 兼容与 Claude Messages 调用，公开文字提取 |
| core/connections.cjs | 连接 ID、地址与字段校验、密钥作用域和公开配置 |
| core/models.cjs | 本机模型目录、强度标签、默认配置与能力校验 |
| core/history.cjs | DSH 与 Codex 历史列表、解码、去重和过滤 |
| core/history-worker.cjs | 工作线程历史请求入口与结果回传 |
| core/workspaces.cjs | 项目读取、路径规范化、工作区 ID 与会话分配 |
| core/store.cjs | JSON 会话存储、模型数校验和中断恢复 |
| core/links.cjs | 允许打开的网页链接协议校验 |

### 9.3 渲染层和界面资源

| 文件 | 主要职责 |
| --- | --- |
| renderer/index.html | 页面结构、输入区、对话框、CSP 与资源加载顺序 |
| renderer/app.js | 会话状态、导航、聊天与过程渲染、Power 控件、发送及事件更新 |
| renderer/iris-ui.js | 其他模型管理、参与模型列表、科研模式和三层任务编辑 |
| renderer/theme.js | 提前应用主题、保存偏好和启动错误收集 |
| renderer/tokens.css | 语义色、字体、尺寸等设计 token |
| renderer/styles.css | 基础桌面布局、组件和响应规则 |
| renderer/premium.css | 既有产品界面层级、阅读与交互细化 |
| renderer/iris.css | Iris 品牌、模型分组、连接与科研配置样式 |
| renderer/dsh.css | DeepSeek Desktop 对齐层：冷灰配色、0.5px 分隔线、14px/24px 正文、压缩标题梯度、胶囊控件与 20px 弹层，最后加载 |
| renderer/icons.js | 由脚本生成的本地 Tabler SVG 子集 |
| renderer/vendor/marked.js | 本地 Markdown 解析库 |
| renderer/vendor/purify.js | 本地 DOMPurify 净化库 |
| renderer/vendor/licenses/tabler.txt | Tabler 图标许可证 |
| renderer/vendor/licenses/marked.txt | Marked 许可证 |
| renderer/vendor/licenses/dompurify.txt | DOMPurify 许可证 |
| scripts/prepare-ui.cjs | 生成 27 个所需图标并复制本地渲染库与许可 |
| assets/iris.ico | Windows 应用与快捷方式图标 |
| assets/iris.png | 鸢尾花 PNG 资源副本 |
| assets/iris.svg、iris-dark.svg | 界面的浅色与深色品牌图标 |
| assets/duet.ico、duet.png | 旧品牌遗留素材，当前品牌入口不使用 |

iris-ui.js 在 app.js 前加载，用于先定义辅助函数；表单绑定延迟到 DOMContentLoaded，避免访问尚未初始化的全局辅助变量。修改脚本顺序或把初始化移回顶层时应检查启动错误。

### 9.4 测试脚本完整索引

| 文件 | 验证范围 |
| --- | --- |
| tests/core.test.cjs | 存储、模型守卫、历史解析、工作区、强度、SSE 和恢复 |
| tests/collaboration.test.cjs | 五阶段互评、写作分配、失败停止、结构化约束与持久化 |
| tests/connections.test.cjs | 地址和密钥作用域、接口载荷、公开内容、缺密钥及无效强度 |
| tests/research.test.cjs | 三层默认配置、不同模型、预算、深化、非法任务与取消 |
| tests/frontend-check.cjs | 新版主题、键盘、Markdown、可访问性和各窗口状态 |
| tests/dsh-visual-check.cjs | DeepSeek 对齐层的只读视觉与可访问性验收：隔离 profile 内截图浅深主题 14 个状态、12 次 axe 审核、320/768 像素溢出检查和设计 token 断言；不向任何模型发请求 |
| tests/iris-ui-check.cjs | 连接 UI、本地兼容服务、科研任务配置与真实研究集成 |
| tests/packaged-check.cjs | 启动打包程序、历史 Worker、配置与研究回答重启恢复 |
| tests/ui-smoke.cjs | 早期 UI 全流程；包含真实双模型协作调用 |
| tests/history-check.cjs | 本机历史批量读取与消息数量检查 |
| tests/live-check.cjs | 原始 DeepSeek 与 GPT 短请求连通性检查 |

### 9.5 生成目录和发布文件

node_modules 是 npm 安装的运行及开发依赖；build 是打包输出；release 是供用户启动的部署目录；backups 是修改和部署前备份；artifacts 是 JSON 验证报告及截图。.local-data、.test-data 和 .verification-profile 是各环境数据，不是应用业务源码。

发布目录包含 IrisUnite.exe、resources/app.asar、locales、Chromium PAK 与快照、ICU 数据、FFmpeg、DirectX 与 Vulkan/SwiftShader DLL 及许可证。resources/app.asar 是主要程序归档；这些运行依赖不需要逐个修改。Iris-data 是随发布目录保存的用户数据，应在更新时单独保护。

本交接文档的制作源文件、结构清单及排版检查资料位于 artifacts/handoff-doc，不参与软件打包。目录中还保留 v2、v3、v4 的报告与截图，用于追溯旧版验收；不能把旧报告中的版本和模型数量当成当前运行状态。

## 10 开发构建部署与回滚

### 10.1 开发环境

开发需要可运行当前 Electron 工具链的 Node.js 与 npm；项目没有声明独立的 engines 版本约束，应以 lockfile、已安装依赖和 @electron/packager 的要求为准。发布目标固定为 win32 x64。GPT 路径另需本机 Codex CLI，DSH 历史读取另需原客户端对应文件。

在 PowerShell 切换到项目根目录后执行：

```powershell
Set-Location '%USERPROFILE%\Desktop\Project\duet-desktop'
npm ci
npm start
```

npm ci 依据锁文件安装依赖并可能联网。npm start 前自动运行 prepare:ui，从开发依赖中提取所用 Tabler 图标并复制本地 Markdown 库。源码启动使用 .local-data，不会默认使用正式版 Iris-data。

### 10.2 测试命令

```powershell
npm test
npm run test:frontend
node tests/dsh-visual-check.cjs
node tests/packaged-check.cjs
```

npm test 运行四个 *.test.cjs 测试文件中的 35 项逻辑测试，不需要真实云端模型请求。test:frontend 会用隔离数据进行界面检查，并包含真实 GPT、DeepSeek 科研调用和本地兼容服务，因此需要相应登录、密钥与网络，且可能产生费用。

dsh-visual-check 只做视觉与可访问性验收：在隔离 profile 中启动开发版，截图浅深主题的 14 个界面状态，跑 12 次 axe，检查 320 / 768 像素下不溢出，并断言设计 token 与正文梯度确实生效。它不发送任何模型请求，结果写入 `artifacts/dsh-ui-check.json` 与 `artifacts/dsh-*.png`。

packaged-check 默认检查 build\IrisUnite-win32-x64\IrisUnite.exe，可用 DUET_VERIFY_EXE 环境变量指定已安装路径。该验收复用此前保存的真实协作和科研结果验证重启恢复，自身不新发起云端模型调用。运行它之前须有 .test-data 中的对应完成记录。

### 10.3 打包

```powershell
npm run package
```

该命令生成 build\IrisUnite-win32-x64，包含 Windows exe、鸢尾花图标与 Iris Unite 的 ProductName、FileDescription 和 0.5.0 版本信息。打包忽略 build、backups、release、tests、artifacts、.local-data、.test-data、.verification-profile 和 README.md；开发依赖会被裁剪，所需 UI 库与许可已复制到 renderer/vendor。

不要把带 --overwrite 的打包命令直接指向含用户数据的 release。应先在 build 完成构建和验证，再部署程序文件；归档检查应确认没有测试记录、密钥、备份和截图进入 app.asar。

### 10.4 本次部署与数据保护

本次从 release\Duet-win32-x64\Duet-data 备份并复制至新版 Iris-data，共保留两条本地会话、六条消息。这些数字仅指 Iris Unite 旧版自己的本地数据，不包含仍从 DSH/Codex 原位置读取的会话。

conversations.json 与 settings.json 在原目录、备份和新目录之间完成 SHA-256 一致性校验。新程序归档与构建产物也完成哈希比对。桌面快捷方式指向新版 exe，图标指向 assets\iris.ico；两个 cmd 入口均使用实际 CRLF 换行和带引号路径。

主要升级前备份为 backups\before-iris-deployment-20261019-013948，包含旧 Duet-data、旧 app.asar、旧快捷方式与启动脚本。源码修改前备份为 backups\before-iris-v0.5-7d863995。部署结果和哈希详见 artifacts\v5-deployment.json。

### 10.5 后续更新和回滚步骤

1. 结束正在生成的任务并关闭正式应用，确认使用目标发布目录的进程退出。
2. 把 Iris-data 及当前 resources/app.asar 备份到新的唯一备份目录，并记录版本和文件哈希。
3. 在 build 生成并验证新版本，部署时逐文件使用精确相对目标，排除 Iris-data、Duet-data 和验证配置。
4. 检查包版本、资源与用户 JSON 哈希，使用隔离配置运行重启验收，再打开正式入口。
5. 如需回退，将程序文件恢复到匹配版本；用户数据恢复应使用对应备份，先保留当前数据，避免丢失升级后新增消息。

如仅需查看升级前状态，可使用保留的旧发布目录及其数据；它不会自动包含新版后来新增的对话。复制资源目录时避免把 resources 整个再次复制到已存在的 resources 下面造成 resources\resources 嵌套。当前没有自动更新、安装向导或版本回滚按钮。

## 11 测试结果与验证证据

### 11.1 逻辑测试

0.5.0 验收时 npm test 结果为 35 项通过、0 项失败。覆盖单模型、五阶段协作、第三方写作者、禁用 GPT 不调用、提案 JSON 校验、同级任务失败取消、用户停止、保存恢复、工作区归属、JSONL 去重、SSE 分片、强度载荷、连接密钥保护和科研预算。

这些测试验证流程和请求构造，不能代替对所有第三方账户、所有模型及全部服务端参数的真实测试。

### 11.2 界面与可访问性

artifacts\v5-frontend-test.json 记录整体通过，包含 20 次 axe 审核，记录的 violations 均为 0。审核对象包括浅深主题欢迎页、Power、工作区、设置、回答、协作记录、Markdown、运行与错误状态、新连接和科研配置，另检查了 320 像素渲染布局。

测试还验证了具体模型名称、滑块键盘操作与焦点返回、最后模型提示、安全 Markdown、过程默认折叠、工作区与历史、侧栏抽屉及启动和运行错误。自动审核无违规不代表已由所有辅助技术进行人工认证。

### 11.3 科研流程与接口验证

| 验证项 | 实际结果与范围 |
| --- | --- |
| DeepSeek 与 GPT 基础连通 | 早期 live-check 中分别真实请求成功 |
| 普通双模型协作 | 已有真实 8 次调用记录，完整执行五阶段并只生成一份答案 |
| 新增兼容模型 | 本地 HTTP SSE 测试服务，检查请求头、强度、保存和正文 |
| 密钥存储 | 假测试密钥在文件中不可明文检索；公开配置不含密钥 |
| 三层科研集成 | 总计 5 次调用，最终答案完成并保存；预算为 5 |
| 科研调用组成 | GPT 真实调用 3 次，DeepSeek 真实调用 1 次，本地兼容服务 1 次 |
| 第二层可选性 | 第二任务独立选择本地测试连接和 high 强度，传参和结果均检查 |
| 预算与阶段 | 拆解、并行研究、筛选、终审完成；深化阶段按预算跳过 |
| Claude Messages | 单元测试验证请求格式、鉴权、effort 和 thinking 过滤；未使用真实 Claude 账户验收 |

科研短测试为减少调用量，临时把统筹和终审设置为 low；生产默认值的 medium 和 xhigh 已另行检查。不能把测试中的 low 误认为当前默认架构。Local QA Model 是隔离本地测试服务，不是软件附带的正式云模型。

### 11.4 打包与发布验收

artifacts\v5-packaged-check.json 对实际 release 路径记录通过：ASAR 内的历史 Worker 可读取原记录，工作区正常，模型选择与强度、科研任务和模式、加密连接、主题及真实回答在重启后恢复。检查时检测到 64 条原客户端历史；该数字是当时的扫描快照。

artifacts\v5-package-contents.json 记录归档 129 个条目，所需新文件均存在，未含被排除的私人数据或测试目录，也未携带完整开发版 Tabler 图标包。最后发布还检查了 exe 版本与产品名、归档哈希、启动脚本及真实数据一致性，并打开了标题为 Iris Unite 的正式窗口。

## 12 已知限制故障处理与后续方向

### 12.1 当前限制

本版以本机文字对话为核心，不含语音、图片与文件附件理解、云端历史同步、远端只存云会话、Codex 归档会话、聊天删除与归档管理、向量记忆或全文索引数据库。共享上下文按最近 40 条消息截取，不是跨模型 token 预算裁剪，也没有长期记忆摘要。

科研模式不自动搜索或执行实验；多模型审阅降低不了所有事实错误。GPT 路径依赖本机 Codex 登录和目录，DSH 压缩历史依赖已安装解码模块。API 兼容不等于所有供应商能力自动适配；工具调用、图片、多模态块及复杂非文字返回当前不在主要支持范围。

其他连接的表单允许模型 ID 最长 150 字符，而普通模型配置校验最长 100 字符；建议实际填写不超过 100 字符。现有接口的强度声明没有按每个云模型自动精确探测，服务端拒绝时需要调整。此处为已识别的实现约束，文档整理未修改应用行为。

DeepSeek 内置流目前检查有无文字和服务错误，不像自定义连接那样显式识别 length 截断；长答案应留意服务端上限。程序失败后保留已有可见片段并标记失败或停止，不把它作为后续已完成助手上下文。

正式发布目前没有安装器、数字签名、自动更新和 Linux/macOS 构建验证。开发目录未建立项目级自动化发布流水线；当前以本地脚本和验证报告维护。通过测试的快照不能保证未来模型目录、原客户端内部格式或接口规则变化后仍无需调整。

### 12.2 常见故障定位

| 现象 | 检查或处理方式 |
| --- | --- |
| 无法启动或 exe 缺失 | 使用新版快捷方式；确认完整 release 目录和运行依赖齐全 |
| 提示未找到 Codex | 在本机安装并登录 Codex，检查 codex.exe 路径 |
| GPT 拒绝模型或强度 | 核对本机模型缓存、账户权限及所选档位，重启以刷新初始目录 |
| DeepSeek 没有密钥 | 检查自定义密钥、环境变量及是否允许复用 DSH 配置 |
| 401 或 402 或 429 | 分别核对鉴权、余额或限流；不要把原始密钥贴入日志 |
| 其他模型 404 或参数错误 | 核对 Base URL 版本路径、接口格式、模型 ID、推理参数和 token 字段 |
| 其他模型达到输出上限 | 提高连接的输出 token 上限，或缩短任务后重试 |
| 本地服务连接失败 | 检查服务已启动、端口和 /v1 路径，必要时启用无需密钥 |
| 历史缺少会话 | 点击刷新；确认本地文件存在，归档、云端和子代理会话不在当前范围 |
| DSH 压缩记录无法打开 | 确认 DSH 安装目录与其解码模块仍在，检查客户端更新影响 |
| 任务运行中不能改配置 | 等待完成或停止后再修改；当前运行使用独立快照 |
| 科研配置包含已停用模型 | 编辑第二层任务，重新选择启用的连接；可先切回普通模式 |
| 复制到另一账户后密钥失效 | 在新 Windows 用户环境重新输入密钥，保留原数据备份 |
| JSON 记录无法解析 | 备份原文件后检查格式或从匹配备份恢复，避免直接覆盖 |

### 12.3 后续可开展的工作

以下是维护方向，均未作为本版已实现功能交付：统一模型 ID 长度校验和精确能力声明；增加 token 与费用统计；加入用户明确控制的文献检索及引用核验；支持附件和更长上下文管理；建立连接导入导出、日志脱敏与诊断面板；增加安装器、签名和自动更新；扩展跨平台与更多原客户端格式回归。

优先修复已识别的字段边界并补充有针对性的测试，再扩展研究工具。引入自动检索或实验执行时，应分别设计证据来源、权限和失败恢复，避免仅通过提示声称完成这些动作。

## 附录 A 预加载接口与事件

### A1 window duet 方法

以下方法通过 preload 暴露，对应 IPC 通道前缀保留 duet。普通页面不能直接访问 ipcRenderer 或文件系统。参数和返回结构以 main.cjs 与 preload.cjs 为准。

| 方法 | 作用与主要输入 |
| --- | --- |
| init | 初始本地列表、公开设置、模型目录、工作区与归属 |
| list | 列出本地会话概要 |
| workspaces | 获取当前工作区目录与分配 |
| addWorkspace | 打开原生文件夹选择器并保存工作区 |
| moveWorkspace | 会话 ID、工作区 ID；保存本地归属 |
| create | 模型、模型配置、工作区、模式与科研配置；新建会话 |
| get | 会话 ID；读取完整本地会话 |
| models | 会话 ID、参与 provider 列表；校验 1 至 6 个 |
| modelConfig | 会话 ID、模型配置；按能力保存强度 |
| runConfig | 会话 ID、模式、科研配置；保存后续轮次配置 |
| saveConnection | 新建或更新连接；密钥只向主进程输入 |
| removeConnection | 连接 ID；移除配置 |
| testConnection | 连接 ID；执行已保存配置的短请求 |
| rename | 会话 ID、标题；最长 100 字符 |
| historyList | 扫描原客户端历史并刷新工作区归属 |
| historyRead | 历史 ID；只读解析完整文字 |
| continueHistory | 历史 ID；建立可继续的本地副本 |
| settings | 默认模型与 DeepSeek 密钥来源设置 |
| send | 会话 ID、文字；返回已保存占位并异步生成 |
| stop | 会话 ID；取消该会话当前轮次 |
| copy | 文本；写入系统剪贴板 |
| openLink | HTTP 或 HTTPS URL；由系统浏览器打开 |
| export | 会话 ID；原生保存对话 Markdown |
| window | minimize、maximize 或 close |
| onEvent | 订阅事件；返回取消订阅函数 |

### A2 主进程事件

主通道为 duet:event。collaboration 事件携带会话 ID、消息 ID 和以下 kind；delta 专用于最终正文，reply-done 回传完成消息，done 清理会话忙碌状态。

| kind | 携带内容 |
| --- | --- |
| stage | 阶段 ID、名称、序号、总数、任务进度 |
| progress | 当前阶段完成任务数与总数 |
| artifact | 一项公开产物的完整状态 |
| artifact-delta | 公开产物的文字增量 |
| plan | 普通协作的最终提案和写作者 |
| budget | 科研实际调用次数和预算 |
| research-plan | 科研目标、任务分解和筛选标准 |
| research-selection | 候选、深化任务、反馈与预算说明 |
| skipped | 科研跳过的阶段 |
| writer | 最终模型及其具体 choice |
| finished | 流程 done、stopped 或 error 及结束时间 |

## 附录 B 依赖与证据索引

### B1 直接依赖

下列为 package.json 声明；精确传递依赖以 package-lock.json 为准。

| 包 | 声明版本 | 用途 |
| --- | --- | --- |
| electron | 44.9.0 | Windows 桌面运行时 |
| @electron/packager | ^20.3.0 | Windows x64 打包 |
| @tabler/icons | ^3.49.0 | 开发时提取本地 SVG 图标 |
| axe-core | ^4.14.0 | 界面自动可访问性审核 |
| marked | ^18.1.1 | Markdown 解析 |
| dompurify | ^3.4.17 | HTML 白名单净化 |
| js-yaml | ^5.5.0 | 读取 DSH 凭据配置 |

项目 package.json 标记 private，许可证为 UNLICENSED；该标记表示项目本身未授予公开开源许可证。使用的第三方库和 Electron/Chromium 附带各自许可，不因项目私有而取消其许可义务。

### B2 主要证据与备份

| 路径 | 内容 |
| --- | --- |
| artifacts/v5-frontend-test.json | 最新界面、20 次 axe 与科研集成总报告 |
| artifacts/v5-research-integration.json | 五次科研调用、独立任务模型及预算结果 |
| artifacts/v5-packaged-check.json | 当前 release 的重启恢复验收 |
| artifacts/v5-package-contents.json | ASAR 资源与排除目录检查 |
| artifacts/v5-deployment.json | 正式部署、备份位置及数据和程序哈希 |
| artifacts/v3-ui-test.json | 真实双模型八次调用与提示淡出时间 |
| artifacts/history-check.json | 早期 61 条历史读取快照及错误数量 |
| artifacts/live-check.json | 早期两个内置模型短请求连通记录 |
| artifacts/v5-*.png | 最新主题、模型控制、科研与响应式截图 |
| backups/before-iris-deployment-20261019-013948 | 改名部署前的真实数据、旧归档和入口 |
| backups/before-iris-v0.5-7d863995 | 新品牌、多模型和科研修改前的源码 |
| backups/before-design-v0.4-f8e52fb9 | v0.4 界面修改前快照 |
| backups/before-v0.4-20261019-1dabdba9 | v0.4 部署前快照 |
| backups/before-v0.3-20261019-c76d5869 | v0.3 升级前快照 |
| backups/before-v0.2-20261018-2a07a21e | v0.2 升级前快照 |

早期历史检查读到 61 条、6748 条文字消息且无读取错误；最新打包验收读到 64 条。这些是不同时间点的扫描结果，不是丢失或增加的固定承诺，也不等于新版的两条本地会话数量。

### B3 接口文档位置

OpenAI Chat Completions API：

https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

Claude 推理强度：

https://platform.claude.com/docs/en/build-with-claude/effort

Claude Messages 流式协议：

https://platform.claude.com/docs/en/build-with-claude/streaming

本文记录的是 0.5.0 的实现和验收状态。后续更改模型 ID、接口参数、原客户端路径或发布方式时，应同步更新本说明、README、测试和部署记录。
