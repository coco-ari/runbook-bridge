# RunbookBridge

**让 AI 帮你排障，把连接与变更的控制权留在手中。**

RunbookBridge（Agent运维工作台）是面向个人开发者和运维人员的 Windows 本地工作台。通过 MCP，让 Codex 等 Agent 结合服务器、MySQL 和 Redis 的真实信息排查问题，减少手动翻日志、查数据和反复粘贴上下文。

当前代码包版本：`2.0.0-beta.1` · Windows 10/11 · [MIT 开源许可](LICENSE)

[下载稳定版](https://github.com/coco-ari/runbook-bridge/releases/latest) · [体验服务器工作区预发布版](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.1) · [反馈问题](https://github.com/coco-ari/runbook-bridge/issues)

## 选择下载版本

| 发布渠道 | 版本 | 适合谁 | Windows x64 安装包 |
| --- | --- | --- | --- |
| **稳定版 · Latest** | **1.0.46** | 日常使用现有 Server / MySQL / Redis 与 Agent 运维功能 | [直接下载安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v1.0.46/RunbookBridge-Setup-1.0.46.exe) · [发布说明](https://github.com/coco-ari/runbook-bridge/releases/tag/v1.0.46) |
| **预发布版 · Pre-release** | **2.0.0-beta.1** | 希望试用新一代人工服务器工作区并反馈问题 | [直接下载安装包](https://github.com/coco-ari/runbook-bridge/releases/download/v2.0.0-beta.1/RunbookBridge-Setup-2.0.0-beta.1.exe) · [发布说明](https://github.com/coco-ari/runbook-bridge/releases/tag/v2.0.0-beta.1) |

稳定版 1.0.46 对应提交 [49cfab4](https://github.com/coco-ari/runbook-bridge/commit/49cfab4397014b38217e2bae878bb0e3ec342eb6)，不包含下方的人工服务器工作区。2.0 是服务器工作区这一大版本，当前 beta 提供交互终端、目录树和文件上传，仍处于体验和验证阶段；通过现有回归测试不代表已达到稳定版标准。GitHub 的 Latest 下载入口始终保留给稳定版。

下载 .exe 即可安装，无需自行构建；Releases 中的 Source code 是源码压缩包，不是安装包。每个安装包同时提供 .sha256 校验文件，可用 PowerShell 的 Get-FileHash 命令计算 SHA-256 后对照。

两个渠道沿用相同应用身份和本地数据目录，预发布版会覆盖同一安装位置，不是独立并行安装版。试用前请退出应用并备份 %LOCALAPPDATA%\AIOpsTool；需要回到稳定版时退出应用并重新安装稳定版。不要同时运行两个版本，跨大版本降级的数据兼容性尚未保证。

## 核心能力

| 资源 | Agent 可以做什么 |
| --- | --- |
| **Server** | 查看系统、服务与容器状态，读取文件，搜索日志及 `.gz` / `.zip` 轮转归档 |
| **MySQL** | 搜索表与字段、查看结构，在固定数据库内执行策略允许的 `SELECT` / `EXPLAIN SELECT` |
| **Redis** | 在配置的 Key pattern 范围内扫描 Key、有界读取数据、查询 TTL；桌面工作区支持五种常用类型浏览、单 Key 删除，以及 String/JSON 新增编辑和过期设置 |

Redis 插件连接后可打开独立的 Redis 工作区，支持 String、Hash、List、Set、ZSet，并按冒号前缀显示 Key 目录树，叶子保留完整名称；Value 自动识别 JSON，提供高亮、折叠、换行和内容查找，截断 JSON 可查看已加载片段；树上方采用紧凑布局，搜索支持关键词包含及 `*` / `?` 通配符，一次提交自动分批查找并逐步展示，支持停止和继续；搜索框提供会话内历史补全，可勾选「精确匹配」；右键目录可一键按前缀搜索，更多目录操作收进工具菜单。详见 [Redis 工作区使用说明](docs/redis-workspace-design.md)。

MySQL 表格左侧竖栏提供「新增行」「复制行」「删除行」，新增与复制直接进入表格草稿，绿色表示新增、蓝色表示复制、黄色表示修改、红色表示删除；所有更改统一保存或取消，完整字段可从状态栏按钮打开侧栏编辑。Redis 左侧提供「新增 Key」，详情提供「编辑值」「删除 Key」；草稿仅保存在会话内，断线后需重新核对。桌面人工写入不会增加 Agent/MCP 权限，详见 [MySQL 数据编辑](docs/mysql-data-editing.md) 和 [Redis 工作区](docs/redis-workspace-design.md)。

按 **项目 → 环境 → 插件** 组织资源，统一管理环境运维说明、快捷提问和操作记录。记录按完整操作显示用户、Agent 或系统的具体动作、目标、结果及审批过程，支持历史搜索、参与方筛选和分页；详见[操作记录](docs/audit-history.md)。MySQL、Redis 可直连，也可通过同环境的 Server 建立 SSH 隧道。

第一栏可直接拖动项目行排序，插入线表示放置位置；也可选中项目后按 `Alt + ↑ / ↓` 调整。顺序保存在本机，重启后保留。搜索结果中拖动会同步调整完整列表的顺序，其他项目的相对顺序不变；配置已隔离的项目不能拖动或作为落点。

MySQL 连接后，在插件详情的「连接 / 修改配置」旁点击「打开工作区」，进入占满窗口内容区的数据库工作区；未连接时入口禁用。左侧可分页浏览数据表、搜索已加载的表名，搜索框支持一键清除；工作区使用与服务器一致的最大化 / 恢复分栏图标，表列表可完全收起并恢复，点击表默认打开数据预览并自动读取首批 20 行；最多打开 6 个表标签，各自保留数据、筛选、排序和滚动位置，切回不会重复查询。后台表只保留状态，不渲染结果表格；关闭标签即释放其数据。右侧可查看字段结构，或在表数据页填写 WHERE 条件，默认每批读取 20 行，可在查询设置中选择 20 / 50 / 100 行（受连接上限约束），执行后生效，并在向下滚动时继续加载；列头依次切换降序、升序和默认排序，排序在数据库中执行。每个表标签累计最多保留 1000 行或 4 MB，插件的更低读取限制仍然有效。分页优先使用主键稳定排序；数据变化时可重新执行刷新。SQL 编辑区与结果区可拖动调整，查询结果支持筛选、当前结果排序与行详情。拖动表到编辑区或点击表旁生成按钮可创建 SELECT 查询，已有 SQL 不会被覆盖。表格列头可拖入当前表的 WHERE 输入框，在光标处插入字段名，填写完条件后手动执行。编辑器提供本地基础语法诊断，以及表名、常用 FROM/JOIN 别名后的字段补全；用方向键选择、Enter/Tab 插入，Ctrl+Space 重新打开候选。补全只按需读取当前库表结构，复杂嵌套查询的作用域分析和数据库语义检查仍以执行时校验为准。服务器和数据库工作区统一使用紧凑布局，页头统一提供连接状态、浅色 / 深色 / 跟随系统主题、断开和关闭入口；关闭工作区会清除 SQL 与结果，数据库连接保持。「返回详情」保留当前会话，再次点击「继续工作区」可恢复查询现场。最多可打开 6 个独立 SQL 标签，分别保留语句和结果。在「SQL 查询」中执行单条只读 SELECT，结果显示耗时、返回条数和截断提示；插件设置的更低行数限制、字节上限和超时仍然生效。仅访问当前插件配置的数据库，SQL 编辑器只接受只读查询，不支持跨库查询或 View 查询。表预览和简单单表 SQL 结果可以直接双击单元格修改普通字段：要求 InnoDB、完整主键和数据库写入权限，支持原位编辑、行号拖选/取消和右键批量赋值，行详情只从右键菜单打开；已选行可生成并复制或导出 SELECT / INSERT / UPDATE / DELETE（仅生成文本，不自动执行），点击底栏「保存更改」即可提交；编辑前后列宽、行高及滚动位置保持不变，普通修改无二次保存确认，包含删除时统一确认一次。主键及生成列不可修改；并发冲突或约束失败时回滚本批更新，提交结果不确定时不自动重试。Agent/MCP 继续保持只读。详见 [MySQL 数据编辑](docs/mysql-data-editing.md)。SQL、结果和编辑草稿只保留在界面内存；断连保留编辑草稿供核对，重连必须重新加载。操作记录显示库表、修改字段、成功行数及结果，不保存业务原值、新值或 SQL 参数。

连接后，你可以这样提问：

> 检查测试环境的 API 服务，结合错误日志、MySQL 表结构和 Redis 缓存定位问题。先给出排查结论，不要修改配置或重启服务。

## 人工服务器工作区（2.0 预发布版）

连接 Server 后，在插件详情的操作区点击「打开工作区」，即可使用左侧目录树、右侧连续 SSH 终端和底部上传任务。已有工作区时点击「继续工作区」。目录软链接可按文件夹展开，文件软链接可只读预览；链接旁显示实际目标，循环和失效链接会明确标记。目录先显示基本内容，再后台补齐软链接目标；大目录采用有界并行读取，分页复用目录快照。连续目录浏览复用同一连接上的空闲 SFTP 通道（最多保留一个，空闲 30 秒后释放），每次仍校验目标路径，失败、取消或断线后重建。已读目录在工作区内缓存；点击路径右侧空白处可输入文件或目录的绝对路径，按 Enter 定位。输入路径、面包屑、上级目录、收藏和传输完成后的定位，都从根目录展开父级、滚动并高亮目标，保留已有分支。工具栏「定位终端当前目录」可定位当前活动终端的工作目录（Linux 常见 POSIX Shell）；单击文件只选中，双击打开只读预览并实时读取，路径失效时局部刷新。文件或目录可拖到当前终端，在光标处插入经过 Shell 引号转义的完整路径，按 Enter 才执行。也可从访达或资源管理器复制本地文件，点击目标文件夹后按 macOS 的 ⌘V / Windows 的 Ctrl+V，或直接把文件拖入目录树；拖到文件夹上传到该目录，拖到文件行使用其父目录，拖到空白处使用当前目录。粘贴和拖放只打开确认清单，点击「开始上传」才传输；每批 1 至 20 个普通文件，暂不支持整文件夹、截图和虚拟附件。选完文件后先显示清单，后台检查目标和校验文件并显示进度，全部检查完成后才允许上传；检查可取消。上传确认突出「本地完整文件路径 → 服务器目标目录」和文件大小，两端路径均可一键复制。目标目录在选择文件时固定，确认页支持移除文件，有效检查结果直接保留、无需整批重查，并重新确认剩余同名覆盖；检查过期或失败时需重新检查。传输任务持续显示各自固定目标、进度，完成后可定位文件。支持单文件最大 500 MiB、最多 2 个并行传输；复用 ssh2 的有界并发写入改善高延迟上传。中断后保持应用运行，重连并点击「继续上传」，校验源文件和已传内容后恢复原任务；每次中断保留 30 分钟，最多续传 3 次。详见 [续传与速度优化](docs/upload-resume-feasibility.md)。上传支持应用运行期间的暂停/继续，已结束任务可移除记录；目录树普通文件可通过「下载」保存到本机，上传与下载共用任务区。下载限单文件 500 MiB，首版不支持目录、符号链接和下载续传。详见 [桌面传输控制与文件下载](docs/desktop-file-transfers.md)。

「返回详情」保留当前终端和上传任务；「结束会话」只结束人工终端；「断开连接」结束该服务器上的会话并中断传输，可恢复的上传任务暂存于内存。关闭应用后不自动恢复会话或补发命令。客户端运行期间的意外断线会自动恢复原标签中的新终端，保留有界历史文字、显示真实重试状态，并允许停止单个终端的恢复；主动断开期间不重试，用户重新连接后恢复断开前活动的终端；正常退出、结束会话或停止恢复的标签保持结束。新会话不恢复旧命令或工作目录，详见 [终端自动重连](docs/terminal-auto-reconnect.md)。

服务器工作区页头提供 Linux CPU、内存与本地磁盘状态条，CPU 首次建立基线后约 1 秒补采，之后 CPU/内存每 5 秒、磁盘每 30 秒独立采样；点击磁盘可切换挂载点。隐藏工作区或最小化后暂停，重连后重新采样，失败保留带过期标识的旧值。采集使用现有 SSH 的独立只读通道，详见 [服务器工作区设计](docs/server-workspace-design.md#顶部资源状态条)。

终端支持新增、切换和关闭独立标签；文件预览支持同时打开多个文件并保留滚动位置。终端颜色使用标准 ANSI 输出，新建终端默认在初始化阶段静默设置 ls 分类配色和 ll 别名，完成后直接显示提示符，初始化命令不会出现在终端屏幕或回滚内容中（常见 POSIX Shell，自动识别 GNU/BSD ls）。「目录配色」可关闭新终端自动配置，也可手动填入当前会话设置后按 Enter 生效。切换标签、返回工作区不会重复配置，不修改服务器配置文件。

终端通过快捷键打开搜索（Windows/Linux：Ctrl+F；Mac：Command+F），可查找当前标签已加载的输出、切换匹配并区分大小写，断线后仍可搜索历史。目录工具栏星标可收藏常用路径，按项目、环境和服务器隔离，每台最多 20 个，本机保存并在重启后保留；点击收藏从根目录展开到目标并高亮，保留上层层级和已展开分支。

人工终端由你直接操作，按 SSH 登录账号的权限执行，打开会话后不逐条弹出命令确认。Agent 不能访问或接管这条终端，原有 MCP Shell 和文件变更仍按单次操作确认。设计与边界见 [服务器工作区说明](docs/server-workspace-design.md)。

## Server 工作区 Docker

工作区左侧增加 36px 图标资源栏，可在服务器文件与 Docker 容器之间切换，保留原有六个文件操作按钮。容器与终端共用右侧标签栏，支持 Compose 分组、概览、最近日志和可见时的资源采样。切换资源不结束终端或传输。

Docker 复用当前 SSH 连接；Server 编辑页可配置 Docker Socket，默认 `/var/run/docker.sock`。首版只读，不自动提权。Agent 新增 `server_docker_list_containers`、`server_docker_inspect_container`、`server_docker_read_logs`、`server_docker_container_stats` 四个工具，沿用环境上下文和权限检查。详见 [Docker 工作区设计与接口](docs/docker-workspace-design.md)。

## 快速开始

1. 日常使用安装 [稳定版](https://github.com/coco-ari/runbook-bridge/releases/latest)；体验人工服务器工作区选择上方的 2.0 预发布版。安装后保持桌面端运行。
2. 创建项目和环境，添加 Server、MySQL 或 Redis 插件，验证配置并主动连接。
3. 在环境的「运维说明」中记录服务职责、日志路径和注意事项，让 Agent 有据可查。
4. 为 Agent 客户端配置 MCP，然后描述你要排查的问题。

使用 Codex 时，在 PowerShell 中执行：

```powershell
$workbenchDir = "$env:LOCALAPPDATA\Programs\Agent运维工作台"
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- `
  "$workbenchDir\Agent运维工作台.exe" `
  "$workbenchDir\resources\app.asar\src\mcp-v2.mjs"
```

如果选择了其他安装目录，修改 `$workbenchDir`。注册后完全退出并重新打开 Codex；桌面应用需要继续运行。

## MCP 日志排查

动态日志可以有界读取，并返回增长标记和实际扫描范围；`server_read_file` 支持 `tail:true`。归档查询应分别设置压缩输入预算和解压预算，结果中的 `guidance` 会说明如何继续。普通文件、日志和配置按完整 UTF-8 字符分页；正文预算不足时会提示增大预算并保留数字游标重试。参数示例、错误处理和限制见 [MCP 日志读取与排障](docs/mcp-log-reading.md)。

## 操作边界

- **凭据加密保存**：应用管理的密码、私钥口令和代理凭据在本机加密保存，不返回给 Agent；主动使用云配置时，所选项目的凭据在客户端加密后上传，服务端不接收解密密钥。
- **连接由你发起**：Agent 只能使用当前环境中已连接的插件，不会自行建立首次连接。
- **Agent 读取优先，变更确认**：Agent 普通读取直接执行；上传、写入、移动、删除和服务控制逐次确认，任意 Shell 需要强确认。确认绑定具体参数，且只能使用一次；人工终端采用上文说明的会话级授权。

请使用低权限账号。日志、文件、配置和查询结果可能包含未脱敏的业务数据，使用前请确认 Agent 客户端的数据处理方式。更多边界见 [安全说明](SECURITY.md)。

## 从源码运行

需要 Windows、Node.js 22+ 和 Corepack。main 分支当前开发 2.0 预发布版；需要稳定源码时，克隆后执行 git checkout v1.0.46，再安装依赖。

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

开发与维护：[贡献指南](CONTRIBUTING.md) · [当前架构](docs/architecture.md) · [插件开发](docs/plugin-development.md) · [验证指南](docs/full-function-verification.md) · [版本记录](CHANGELOG.md)

### macOS 源码构建与 MCP

macOS 支持已合并到 `main`，后续 Windows 与 macOS 在主分支共同开发。Apple Silicon 与 Intel 已在 GitHub Actions 的 macOS 15 Runner 上通过完整 UI、包内功能及隔离安装/覆盖升级回归，与 Windows 共用业务和界面代码。上面的已发布下载链接仍是 Windows 安装包；通过三平台 CI 验证的测试安装包保存在对应运行的 installers 归档中；Mac 正式签名和公证分发尚未完成，验证结果及系统验收边界见 [macOS 适配方案](docs/macos-adaptation.md)。

在 Mac 安装 Node.js 22+、Corepack 和 Xcode Command Line Tools 后，使用仓库锁定依赖构建：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run install:electron-runtime
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui:all
corepack pnpm run dist:mac:arm64
```

Intel Mac 使用 `corepack pnpm run dist:mac:x64`，`dist:mac` 默认构建当前 Mac 的架构。两个架构都输出 DMG 与 ZIP。普通构建使用临时签名，供开发验收；正式分发必须完成 Developer ID 签名与 Apple 公证，参见 [测试与交付验证指南](docs/full-function-verification.md)。

安装后，macOS 的 MCP 注册命令为：

```sh
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- "/Applications/Agent运维工作台.app/Contents/MacOS/Agent运维工作台" "/Applications/Agent运维工作台.app/Contents/Resources/app.asar/src/mcp-v2.mjs"
codex mcp get agent-ops
```

macOS 数据保存在 `~/.ai-ops-tool`，密码由系统钥匙串加密。两个平台使用同一套项目/环境/插件格式，但 Windows 密文不能直接搬到 Mac 解密；可以使用[云配置仓库](docs/cloud-config.md)迁移项目和凭据，由目标设备重新加密保存。直接复制应用数据目录仍需重新填写凭据和本机私钥路径。自定义 `AI_OPS_DATA_DIR` 时，桌面与 MCP 必须使用同一个绝对路径。

“系统 VPN”要求先在操作系统连接 VPN，再填写实际网卡名称（例如 Mac 的 `utunN`）。工作台会验证目标 IP 的实际出口，验证失败就拒绝连接；旧配置和 MCP 的 `windowsVpn` 标识继续兼容。Mac 使用 Command 快捷键，仍支持原有 Ctrl 快捷键。最后一个窗口关闭时，应用退出并断开连接，与 Windows 保持一致。

## Codex 查询与排障效率

- 日志支持 ZIP/GZIP、多关键词和有界续查。返回 `nextCursor` 时保持其他参数一致继续，结合 `status`、`conclusion`、`coverage` 判断范围；`inconclusive` 不能解释成没有异常。目录短期复用，`refresh:true` 发起最新搜索。见 [日志读取与排障](docs/mcp-log-reading.md)。
- 日志输入默认 4 MiB、单页远程会话预算 20 秒；读取超时保留已完成结果及续查位置，文件发现阶段超时明确报错。日志正文默认按 32 KiB 分页（`maxResultBytes`），状态、遗漏原因与游标先于正文返回；归档只因本页剩余预算不足时自动保留到下一页，单文件超限时返回调整建议。
- MySQL Schema 默认先匹配表，未命中再查字段；可指定 `searchIn`、准确 `table`、`includeIndexes:true`。元数据缓存 60 秒，业务查询仍逐次执行和校验，`refresh:true` 可更新元数据。相同连接、配置和表集合的同时检查只合并在途请求，完成后不缓存；重连后必须重新检查。超时 `details.operation` 区分表检查、结构搜索与 SQL 执行。
- 变更待确认时，使用 `get_confirmation_status`（`waitMs` 最长 10 秒）查询当前会话状态。只有 `approved` 时原参数重试一次；`running/succeeded` 不要重发。
- `server_control_service` 只有在 systemctl 退出码为零时成功；非零或未取得退出码时返回 `SERVICE_CONTROL_FAILED`，确认状态与操作记录标记失败。先查询服务状态和日志，再决定是否重新确认重试；错误只返回操作、单元名和退出码，不附带远端正文。
- 已认证连接不会因为凭据摘要尚未读取而被误报为 Agent 不可用；明确的凭据缺失或不可读、资源未验证和断连仍会阻断。
- `open_environment` 返回桌面 `runtime`、`mcpRuntime` 和 MySQL 能力说明。相同版本号也能通过 `buildId`、`gitCommit`、`startedAt` 判断运行的是哪份构建。
- 查询按插件限制并发，并设全局排队与内存预算；压缩处理在本地工作线程执行。`READ_BUSY` 表示排队繁忙，先等待再重试。

职责拆分、资源预算与缓存边界见 [架构说明](docs/architecture.md)。


### MySQL 查询耗时诊断

mysql_query_readonly 的成功结果增加 timings：tableCheckMs 为基础表检查总耗时（包含等待），queryQueueMs 为业务查询排队耗时，queryMs 为业务执行耗时，totalMs 为本次总耗时。原 durationMs 字段保留兼容语义。

错误 details 包含本次失败操作的 timing（queueMs、executionMs、totalMs、executionStarted），以及业务查询的 timings、queryStarted。operation:table_check 且 queryStarted:false 表示业务 SQL 尚未执行，应先排查元数据访问、网络和连接恢复；业务执行超时才考虑执行计划和查询条件。READ_BUSY 表示排队超限，不代表连接断开。耗时仅使用数值，不包含 SQL、参数或数据库内容。

基础表检查仍逐次执行，只合并同一连接内尚未完成的同类检查；不会长期缓存检查结果或放宽 View、固定数据库、只读限制。
