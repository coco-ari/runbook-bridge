# 软件在线升级

Windows 桌面可以使用已绑定并解锁的云配置仓库作为软件更新来源。在设置的“关于”中选择一个仓库，检查新版本，下载后选择安装并重启。应用启动后及每 15 分钟自动检查一次，不自动下载或安装；关闭应用后不检测。关联多个仓库时只使用选定来源，不合并各仓库返回的版本。解除选定仓库的绑定后，即使重启应用也不会自动切换到其他来源，必须重新选择。云配置的“更新项目”仍然只更新项目配置；软件升级有独立入口和状态。

当前在线安装支持 Windows NSIS 安装版。开发模式不会安装更新；macOS 暂不开放桌面在线安装，本仓库仅提供按架构准备 ZIP、DMG 和版本清单的发布能力。macOS 后续启用在线安装前，须完成 Developer ID 签名、公证及原生更新流程验证；不能用临时签名测试包作为正式更新包。该要求来自 [electron-builder 的自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)。

首次使用须人工安装包含此功能的客户端，并升级部署云服务。旧客户端不会自动获得原本不存在的更新能力；旧云服务没有 `/updates/` 接口，客户端会显示无法检查更新，需部署新服务和对应平台的发布文件。版本必须高于当前安装版本才会提示升级；本功能的开发不自动提高项目版本。

当前云仓库发布版本为 **2.0.3（Windows x64）**，本次不创建 GitHub Release，GitHub 公开下载仍为 2.0.0。2.0.3 修复 Redis 长 JSON 显示不全，包含此前本地构建的插件配置编辑优化，见 [2.0.3 发布说明](releases/v2.0.3.md)。2.0.2 已修复旧更新器在客户端退出后等待隐藏安装向导的问题。原 GitHub 2.0.0 没有在线更新入口，需要先安装包含此功能的客户端。

## 用户操作与数据保留

1. 在“云同步”关联仓库并解锁。希望重启后继续检测时，可使用现有的本机记住密码功能。
2. 在“关于”的软件更新区域选择一个云仓库作为更新来源。来源必须使用 HTTPS。
3. 检查并查看新版本，选择下载。下载失败可重试，未完成或校验失败的文件不会安装。
4. 下载完成后主动选择安装并重启。请先完成或关闭正在执行的运维任务、传输及未提交的 SQL 事务，并保存编辑内容；应用沿用现有任务与退出保护。

检测与下载在后台进行，下载期间可以返回工作台。安装须点击“重启并更新”并再次确认；2.0.2 及之后的客户端以静默模式运行 NSIS 更新安装，并要求安装成功后重新打开客户端。正常成功流程为退出客户端、替换文件、重新打开客户端一次，无需重启电脑。首次手动安装仍显示安装向导；Windows 权限或安全提示仍可能需要用户处理，不能保证所有系统都无需交互。单纯发布新版本、关闭客户端或完成下载都不会自动安装。

发起安装的参数来自当前正在运行的客户端。含更新功能的旧 2.0.0 和 2.0.1 即使下载了 2.0.2，仍可能在退出后等待隐藏的安装向导；新安装包无法提前修改旧进程的行为。遇到此问题须先完成或退出已启动的安装程序，再手动运行可信云仓库提供的 2.0.2 安装包，按向导完成修复安装。请勿反复启动多个安装程序。安装 2.0.2 后发起的后续在线升级才使用静默流程。

升级沿用当前安装目录和 `AIOpsTool` 数据目录，保留本机项目、连接配置、加密凭据和云仓库关联，不通过卸载删除应用数据。更新不会改变 SSH 指纹验证、Agent 操作审批或数据库访问范围。安装重启会结束桌面连接及 MCP Broker 会话；Agent 在桌面重新启动后重新获取上下文和连接。

## 准备发布文件

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

macOS 仅在 Mac 或 macOS Runner 上完成正式签名和公证构建后准备文件。先按 [测试与交付验证指南](./full-function-verification.md) 配置签名环境，再执行对应架构命令：

```sh
AI_OPS_MAC_RELEASE=1 corepack pnpm run dist:mac:arm64
node scripts/prepare-cloud-update.mjs --platform darwin --arch arm64
AI_OPS_MAC_RELEASE=1 corepack pnpm run dist:mac:x64
node scripts/prepare-cloud-update.mjs --platform darwin --arch x64
```

macOS 输入文件为 `dist/RunbookBridge-<版本>-mac-<架构>.zip` 和同名 `.dmg`，两者都必须存在；输出位于 `artifacts/cloud-updates/darwin/<架构>/`，名称使用 `RunbookBridge-<版本>-darwin-<架构>.zip/.dmg` 和 `latest-mac.yml`。Intel 与 Apple Silicon 各用独立清单。

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

构建配置中的 `updates.invalid` 仅供 electron-builder 生成 `app-update.yml` 中的更新缓存及签名设置，不是可访问的软件源。运行时使用绑定到所选 HTTPS 仓库的独立 provider，校验产品、平台、架构、版本及下载文件后才执行更新；不会请求该占位域名，也不会回退到 GitHub 或其他仓库。

HTTPS 用于确认连接的云服务并保护传输，SHA-512 校验用于确认下载内容与清单一致。SHA-512 不是发布者数字签名，无法防止已被控制的分发服务器同时替换清单和安装包；应保护 HTTPS 证书、发布目录和发布主机。安装包签名可提供额外的发行者验证，不应移除已有签名校验。

## 验证

```powershell
node --test test/cloud-software-updates.test.mjs test/cloud-config.test.mjs test/cloud-config-boundaries.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
```

测试只创建临时合成产物和回环 HTTP 服务，不连接真实云仓库、不下载真实更新、不运行安装包。实际发布还应在隔离 Windows 测试机器验证安装版从旧版升级至高版本，确认项目及凭据保留、Agent 重新连接和安装失败时的行为；macOS 在线安装不在本次支持范围。
