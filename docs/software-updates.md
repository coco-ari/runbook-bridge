# 软件在线升级

Windows 安装版和 macOS 打包应用可以使用已绑定并解锁的云配置仓库作为软件更新来源。在设置的“关于”中选择一个仓库，检查新版本；Windows 下载后确认重启安装，Mac 下载并校验 DMG 后手动覆盖安装。应用启动后及每 15 分钟自动检查一次，不自动下载或安装；关闭应用后不检测。关联多个仓库时只使用选定来源，不合并各仓库返回的版本。解除选定仓库的绑定后，即使重启应用也不会自动切换到其他来源，必须重新选择。云配置的“更新项目”仍然只更新项目配置；软件升级有独立入口和状态。

客户端订阅选定软件源的版本变化，发现新版本和下载完成时，在“消息中心”紧凑浮层中展示。消息内可直接“下载新版本”，下载中显示进度，完成后 Windows 提供“立即更新”、Mac 提供“打开安装包”；项目侧栏底部也提供相应入口。系统通知点击后定位“关于”的软件更新区域。未完成的消息和角标持续保留，取消安装、查看消息或关闭浮层不会清除提醒；同一来源、平台、架构、版本与下载阶段的系统通知在本机持久化去重。已经发现版本后仍继续检查后续发布；开始下载后固定本次版本，下载完成后等待用户操作。Windows 安装继续检查未保存内容和活动任务，Mac 打开 DMG 不触发退出流程。

云服务提供公开 `GET /api/v1/updates/:platform/:arch/events` SSE 接口，只接受软件分发支持的平台和架构，且不接收 `Authorization`、`Cookie` 或 `Proxy-Authorization`。客户端仍要求 HTTPS，不携带任何仓库凭据。服务端在有订阅时每 5 秒读取受限发布路径中的版本清单，内容摘要变化后发送 `change` 事件；连接建立时发送 null revision，触发一次最新状态检查。事件只含清单摘要，客户端重新获取并验证清单，下载和安装校验保持原样。

管理员必须继续遵守“安装包先完整就绪，最后原子替换版本清单”的发布顺序；未配置发布目录时订阅返回 404，旧服务或推送不可用时保留每 15 分钟检查。客户端不会把推送中的摘要作为版本号、下载地址或安装指令。连接恢复与提醒详情见[云配置更新提醒](./cloud-config.md#更新提醒与推送)。

Windows 使用 NSIS 在线安装。macOS 使用独立 DMG 下载驱动，支持 arm64 和 x64，按当前程序架构选择安装包；在 Apple Silicon 上运行 x64 程序时继续下载 x64 包。Mac 手动更新通道可使用临时签名的未公证构建，无需 Apple 开发者账号，不使用 Squirrel.Mac 自动替换或自动重启。Developer ID 签名及公证的正式发布通道继续保留。源码运行不启用更新下载。

首次使用须人工安装包含此功能的客户端，并升级部署云服务。旧客户端不会自动获得原本不存在的更新能力；旧云服务没有 `/updates/` 接口，客户端会显示无法检查更新，需部署新服务和对应平台的发布文件。版本必须高于当前安装版本才会提示升级；本功能的开发不自动提高项目版本。

当前代码版本为 **2.0.8**，修复插件编辑会话失效并简化取消操作，见 [2.0.8 发布说明](releases/v2.0.8.md)。Mac 辅助更新自 2.0.6 起提供。Windows x64、Mac arm64 与 Mac x64 分别构建、验证和发布，实际可下载版本以选定云仓库各平台的清单为准；发布一个平台不会触发其他平台更新。本次不创建 GitHub Release，GitHub 公开下载仍为 2.0.0。2.0.2 已修复 Windows 旧更新器在客户端退出后等待隐藏安装向导的问题。原 GitHub 2.0.0 没有在线更新入口，需要先安装包含此功能的客户端。

## 用户操作与数据保留

1. 在“云同步”关联仓库并解锁。希望重启后继续检测时，可使用现有的本机记住密码功能。
2. 在“关于”的软件更新区域选择一个云仓库作为更新来源。来源必须使用 HTTPS。
3. 检查并查看新版本，选择下载。下载失败可重试，未完成或校验失败的文件不会安装。
4. 下载完成后主动选择安装并重启。请先完成或关闭正在执行的运维任务、传输及未提交的 SQL 事务，并保存编辑内容；应用沿用现有任务与退出保护。

检测与下载在后台进行，下载期间可以返回工作台。安装须点击“立即更新”并再次确认；2.0.2 及之后的客户端以静默模式运行 NSIS 更新安装，并要求安装成功后重新打开客户端。正常成功流程为退出客户端、替换文件、重新打开客户端一次，无需重启电脑。首次手动安装仍显示安装向导；Windows 权限或安全提示仍可能需要用户处理，不能保证所有系统都无需交互。单纯发布新版本、关闭客户端或完成下载都不会自动安装。

发起安装的参数来自当前正在运行的客户端。含更新功能的旧 2.0.0 和 2.0.1 即使下载了 2.0.2，仍可能在退出后等待隐藏的安装向导；新安装包无法提前修改旧进程的行为。遇到此问题须先完成或退出已启动的安装程序，再手动运行可信云仓库提供的 2.0.2 安装包，按向导完成修复安装。请勿反复启动多个安装程序。安装 2.0.2 后发起的后续在线升级才使用静默流程。

升级沿用当前安装目录和 `AIOpsTool` 数据目录，保留本机项目、连接配置、加密凭据和云仓库关联，不通过卸载删除应用数据。更新不会改变 SSH 指纹验证、Agent 操作审批或数据库访问范围。安装重启会结束桌面连接及 MCP Broker 会话；Agent 在桌面重新启动后重新获取上下文和连接。

## 准备发布文件

### Mac 手动覆盖安装

下载完成后，关于页、消息中心和侧栏显示“打开安装包”。点击后重新核验磁盘上的 DMG，再请求系统打开；这一步不退出工作台、不关闭连接，也不代表升级已经完成。消息中心打开成功后转到关于页展示安装步骤。“在 Finder 中显示”同样只定位本次校验通过的文件，不能传入其他路径。

1. 保存工作内容，结束 SQL 事务、传输及其他活动操作，通过应用菜单退出工作台，并关闭正在使用它的 Agent 客户端。
2. 将 DMG 中的“Agent运维工作台”拖到原安装位置，选择“替换”。通常为“应用程序”；自定义安装请保持原路径。若从 DMG 运行，请先复制到“应用程序”。
3. 从原安装位置启动新版，再重新打开 Agent 客户端。原项目、配置及加密凭据文件保留。临时签名变化可能使系统再次请求访问“AI 运维工具 Safe Storage”钥匙串；确认来源后，在系统窗口输入 Mac 登录密码并允许访问。请勿删除该条目，否则原凭据可能无法解密。拒绝授权后应重新启动并完成授权。

打开后继续保留待安装提醒；只有新版运行并检查到已是当前版本时才消失。本版不保存跨重启下载状态、不增加专用退出按钮、不自动替换应用。若仍启动旧版，请重新检查并下载；已交给系统的 DMG 会保留在系统临时目录，可继续从已打开的窗口安装。安装完成并推出磁盘映像后，可以删除定位到的 DMG。未交给系统的下载在取消或正常释放时清理，异常终止可能留下系统临时文件。

安装包使用临时文件流式下载，限制实际大小并校验 SHA-512，成功后才更名。打开或定位前再次校验；来源变化、旧下载标识、文件修改、符号链接和特殊文件均被拒绝。系统打开失败保留重试入口，完整性失败必须重新下载。当前架构清单返回 404 时显示“此来源暂未提供当前 Mac 架构的更新清单”，不作为“已是最新版”。

主进程给下载的 DMG 写入 `com.apple.quarantine` 隔离属性，不关闭 Gatekeeper 或移除隔离标记。未公证应用可能出现系统提示；确认可信来源后，按系统“隐私与安全性”的提示操作。损坏或恶意软件提示应联系发布管理员检查，不统一指导强行放行。参见 [Apple 的应用安全打开说明](https://support.apple.com/en-us/102445)。

### 构建和准备

GitHub Actions 的 `Cloud Windows package` 工作流会在主分支发布说明更新时构建，也可手动触发。它运行语法与类型检查、单元测试、Markdown 和消息中心专项、打包与安装覆盖验证，输出带提交信息的 `cloud-updates-win32-x64` 产物；常规 CI 的全套 UI 检查继续独立运行，专项通过不代表全套 CI 通过。部署前核对产物中的 `runtime.json` 提交、安装包哈希与清单。工作流只准备产物，发布管理员按下述顺序部署到云仓库。

先按发布约定同步 `package.json`、文档与变更记录中的正式版本，再构建和完成包验证。这里只支持不带预发布后缀的三段版本，例如 `2.0.2`；不要只修改清单版本去发布旧安装包。以下命令读取当前仓库的 `package.json` 版本，不自行修改版本，也不会上传或安装软件。

Windows 在仓库根目录执行：

```powershell
corepack pnpm run dist
node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/prepare-cloud-update.mjs --platform win32 --arch x64
```

默认从 `dist/Agent运维工作台 Setup <版本>.exe` 复制发布产物，原安装包保留。输出目录为 `artifacts/cloud-updates/win32/x64/`：

```text
latest.yml
RunbookBridge-<版本>-win32-x64.exe
RunbookBridge-<版本>-win32-x64.exe.blockmap   （构建产物存在时复制）
```

命令的 `--arch` 必须与构建产物一致。Windows 默认构建为当前构建环境的架构；不同架构的构建产物应存入各自输入目录，不可给同一安装包更换参数冒充其他架构。可用 `--input-dir` 指定构建目录，或 `--output-dir` 指定发布准备目录；输出仍按平台和架构分层。单个安装包最大 1 GiB。

macOS 在 Mac 或 macOS Runner 上构建。无 Apple 账号的手动安装通道使用以下命令，产物必须明确标注“临时签名、未经过 Apple 公证”：

```sh
AI_OPS_MAC_RELEASE=0 corepack pnpm run dist:mac:arm64
node scripts/prepare-cloud-update.mjs --platform darwin --arch arm64
AI_OPS_MAC_RELEASE=0 corepack pnpm run dist:mac:x64
node scripts/prepare-cloud-update.mjs --platform darwin --arch x64
```

macOS 输入文件为 `dist/RunbookBridge-<版本>-mac-<架构>.zip` 和同名 `.dmg`，两者都必须存在；输出位于 `artifacts/cloud-updates/darwin/<架构>/`，名称使用 `RunbookBridge-<版本>-darwin-<架构>.zip/.dmg` 和 `latest-mac.yml`。Intel 与 Apple Silicon 各用独立清单。

客户端只下载清单中的 DMG，ZIP 继续保留以兼容现有产物结构。手动触发 `.github/workflows/cloud-macos-package.yml`（Cloud macOS manual package），指定旧版源码提交 `previous_ref`，分别构建两种架构，运行检查、测试、更新 UI、包验证以及旧版到新版的隔离覆盖回归，验证版本确实提高、构建内容不同、项目及凭据可读、MCP 可重新接入，输出 `cloud-updates-darwin-<架构>-manual-unnotarized` 归档。该流程无需 Apple secrets，只准备产物，不部署云服务或创建 GitHub Release；Runner 上的自动回归不替代普通用户环境下的 Gatekeeper 和 Finder 交互验收。

跨版本自动回归设置 `AI_OPS_MAC_TEST_KEYCHAIN=1`，仅在 GitHub Runner 内创建临时钥匙串，预授权本次旧版和新版两个应用包，运行结束后恢复原始默认钥匙串及搜索列表并删除测试钥匙串。合成凭据仍经过真实 Electron `safeStorage` 加解密，原密文在覆盖前后必须保持不变。此预授权只隔离 CI 的系统交互，不改变客户端钥匙串权限，也不代表已验收用户手动允许或拒绝授权的交互。[Electron 官方说明](https://www.electronjs.org/docs/latest/api/safe-storage)解释了签名变化触发重复授权的原因。

系统仍可能要求人工授权，预授权不保证跨版本回归自动完成。2.0.6 的两个 Mac 架构在原生 CI 中曾停在新版首次读取凭据的系统授权窗口；之后使用归档候选包完成本地授权及覆盖升级复验，已启用两个 Mac 更新清单。arm64 原生运行，x64 在 Apple Silicon 上通过 Rosetta 运行，详见 [2.0.6 交付记录](releases/v2.0.6.md#2026-10-13-交付状态)。

若构建和包验证已通过、仅安装回归失败，可在修复测试环境后触发 `.github/workflows/cloud-macos-upgrade-verification.yml`，指定原构建的 `build_run_id` 与完整 `build_commit`。流程校验来源并下载同次运行的候选包和旧版基准包，使用原始安装包复验；只有升级回归通过才输出云仓库产物，不重新构建或改写安装包。临时钥匙串预置项必须匹配实际账户名 `AI 运维工具 Key` 及服务名 `AI 运维工具 Safe Storage`，否则应用会创建未预授权的新项。测试只授权两个构建的精确代码摘要，不操作用户真实钥匙串或凭据。

需要签名、公证的正式构建时，按 [测试与交付验证指南](./full-function-verification.md) 配置证书，使用 `AI_OPS_MAC_RELEASE=1`；缺少凭据仍明确失败，现有 Release 工作流不降级为未公证发布。

清单包含产品 `runbook-bridge`、平台、架构、正式版本、发布时间，以及标准 `files[].url/sha512/size` 字段。SHA-512 使用 Base64，文件大小和摘要从实际输出文件计算。准备脚本先完整写入安装包及可选 blockmap，最后原子替换清单；已有同版本同名文件若内容不同会拒绝覆盖。已经正式发布的版本应保持不可变，修改软件后发布更高版本。

## 云服务部署

升级分发与加密配置数据库分开存储。准备一个仅存放可公开下载软件的发布目录，例如 `/srv/runbook-cloud-releases`；部署管理员将 `artifacts/cloud-updates/` 内的 `win32/`、`darwin/` 目录放入该目录。目录应允许容器 UID 1000 读取，且只允许部署管理员写入。

部署新版本时，先把包和可选 blockmap 完整写入临时文件，完成后移动到最终名称；最后在同一文件系统内原子替换 `latest.yml` 或 `latest-mac.yml`。不要先上传最新清单，也不要覆盖已发布版本的文件。保留旧版包有利于已经开始下载的客户端完成下载。

```sh
export CLOUD_RELEASES_DIR=/srv/runbook-cloud-releases
export CLOUD_DOMAIN=config.example.com
export CLOUD_ADMIN_TOKEN_FILE=/srv/runbook-cloud-admin-token
docker compose -f services/cloud-config/compose.yaml up -d --build
```

两个现有 Compose 配置都把发布目录只读挂载到 `/releases`，并向服务传入 `CLOUD_RELEASES_DIR=/releases`。未设置宿主机的 `CLOUD_RELEASES_DIR` 时，软件分发保持关闭，原有配置同步继续工作。直接运行服务时，同名环境变量指向服务可以读取的发布目录。

HTTPS 配置沿用现有 Caddy，无需额外公开端口。内网 HTTP Compose 仍支持原有配置同步，但桌面软件更新要求 HTTPS；若现有仓库使用 HTTP，应先在云服务前部署可信的 HTTPS，再使用 HTTPS 仓库链接。不能关闭证书校验或用 HTTP 回退获取安装包。

分发接口只读且公开，不需要仓库密码或管理员 token：

```text
GET/HEAD /updates/win32/x64/latest.yml
GET/HEAD /updates/win32/x64/RunbookBridge-<版本>-win32-x64.exe
GET/HEAD /updates/darwin/arm64/latest-mac.yml
```

同样支持 Windows `arm64/ia32` 和 macOS `x64` 的独立目录。服务只接受固定平台、架构、清单名和安装包名，不列目录，拒绝符号链接、目录穿越及特殊文件。支持单个字节范围，拒绝多范围请求；客户端当前下载完整包。清单最多 64 KiB、包最多 1 GiB、blockmap 最多 16 MiB。

未配置发布目录返回 `404 CLOUD_UPDATES_UNCONFIGURED`；目录已配置但平台、架构或文件不存在时返回 `404 CLOUD_UPDATE_NOT_FOUND`。旧版服务可能返回 `404 CLOUD_NOT_FOUND`。升级接口没有上传或管理 API，普通仓库读写权限不包含软件发布权限；现有管理员 token 的用途仍然只是创建配置仓库。

## 来源与完整性边界

选定的软件源有权向本机提供可执行程序，应由可信部署管理员维护。更新请求由主进程发出，单独处理，不携带仓库访问 token、仓库密码或数据加密密钥。公开分发端点发现 `Authorization`、`Cookie` 或 `Proxy-Authorization` 会直接拒绝，不回显其中内容。配置快照无法修改本机选择的更新来源。

构建配置中的 `updates.invalid` 仅供 electron-builder 生成 `app-update.yml` 中的更新缓存及签名设置，不是可访问的软件源。Windows 使用绑定到所选 HTTPS 仓库的独立 provider，Mac 使用同样固定来源的 DMG 驱动；两者校验产品、平台、架构、版本及下载文件后才允许安装或打开，不会请求该占位域名，也不会回退到 GitHub 或其他仓库。

HTTPS 用于确认连接的云服务并保护传输，SHA-512 校验用于确认下载内容与清单一致。SHA-512 不是发布者数字签名，无法防止已被控制的分发服务器同时替换清单和安装包；应保护 HTTPS 证书、发布目录和发布主机。安装包签名可提供额外的发行者验证，不应移除已有签名校验。

## 验证

```powershell
node --test test/cloud-software-updates.test.mjs test/cloud-config.test.mjs test/cloud-config-boundaries.test.mjs
node --test test/software-update-mac-driver.test.mjs test/software-update.test.mjs test/update-notifications.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm exec electron scripts/ui-react-foundation-smoke.cjs --software-update-only
corepack pnpm exec electron scripts/ui-react-foundation-smoke.cjs --update-center-only
```

单元与 UI 测试使用临时合成产物、模拟系统打开和回环服务，不连接真实基础设施、不运行下载的安装包。Mac 原生隔离属性测试仅在 Mac 上运行。实际发布还应分别在 Apple Silicon、Intel Mac 使用两个不同版本验证：旧版发现新版、下载、DMG 打开、Finder 覆盖、新版启动、项目和凭据可读、MCP 重新接入、提醒消失；另外验证 Gatekeeper 首次启动、用户取消与失败恢复。Windows 继续验证 NSIS 从旧版升级至高版本。工作流存在或本机 Windows 测试通过不代表 Mac 验收通过。
