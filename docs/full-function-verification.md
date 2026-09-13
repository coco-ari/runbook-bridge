# 测试与交付验证指南

本文列出可复跑的检查入口和结果记录要求，不代表某个提交或安装包已经通过验证。每次交付以当前源码、当前构建和实际命令结果为准，不复用旧报告中的测试数、截图或安装包哈希。

## 环境与数据边界

- 使用 Windows 10/11、Node.js 22+ 和 `package.json` 中固定的 pnpm 版本，通过 Corepack 运行。
- 测试使用临时数据目录、合成数据、模拟运行时或本机协议测试服务，不连接真实基础设施，不读取用户的生产配置和凭据。
- Electron UI 组按顺序执行，避免原生窗口抢焦点影响鼠标、键盘和弹层验证。
- `pnpm start` 只用于人工桌面验证，不属于隔离自动测试，不应为了验收连接真实生产资源。
- 安装、覆盖升级和卸载会修改当前用户的注册信息及快捷方式，只能在没有既有安装的隔离账户或一次性 Windows Runner 中执行。

## 日常检查

先检查工作区，保留与本次任务无关的修改：

```powershell
git status --short --branch
corepack enable
corepack pnpm install --frozen-lockfile
```

首次安装未取得 Electron 运行时的环境，可运行仓库提供的安装入口：

```powershell
corepack pnpm run install:electron-runtime
```

迭代时先选择 `test/` 下对应功能测试。例如修改确认门禁时：

```powershell
node --test test/operation-gate.test.mjs
```

行为变更完成后运行：

```powershell
corepack pnpm run check
corepack pnpm test
git diff --check
```

`check` 自动枚举 `src/`、`scripts/` 和 `test/` 下的 `.mjs/.cjs` 文件进行语法检查，再执行 Renderer TypeScript 检查。文档独立修改无需完整应用测试，但必须检查空白错误、相对链接、所述源码路径和命令是否仍有效。

## Electron 界面检查

修改 Renderer、preload/IPC、连接编辑流程、操作确认或快捷提问时至少执行 `corepack pnpm run test:ui`，并执行受影响的业务组。跨功能、完整回归和发布前运行：

```powershell
corepack pnpm run test:ui:all
```

| 命令 | 主要验证范围 |
| --- | --- |
| `corepack pnpm run test:ui` | 正式 React 壳层、只读数据、导航、主题、布局持久化、键盘、可访问性、CSP |
| `corepack pnpm run test:ui:business` | 项目、环境、运维说明和快捷提问变更，失败重试与编辑保护 |
| `corepack pnpm run test:ui:plugins` | 插件新增、编辑、连接、Host Key、安全确认及取消流程 |
| `corepack pnpm run test:ui:server-workspace` | 服务器终端、文件浏览与传输，以及服务器、数据库、Redis 之间的工作区往返 |
| `corepack pnpm run test:ui:database` | MySQL 多表标签、默认 20 行预览、字段拖入筛选、受限权限下系统剪贴板、关闭清理、语法提示、拖表生成 SQL、别名字段补全、筛选排序与滚动分页、结果边界和迟到响应隔离 |
| `corepack pnpm run test:ui:plugin-matrix` | 插件表单与真实探针、编辑会话、凭据解析器的组合，取消、重试和删除重建 |

`test:ui:all` 串行执行上表六组；这些入口均先构建 Renderer。不要修改生产策略来迁就 smoke，也不要用无条件成功的 mock 或源码正则替代实际行为检查。

## 构建与包验证

修改打包配置或 MCP 分发内容、准备交付安装包时，在源码和相关 UI 检查完成后运行：

```powershell
corepack pnpm run dist
node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"
```

包检查分别校验源码/Renderer 产物与包排除规则、正式 MCP 工具和依赖运行时、隔离工作区下的真实桌面启动与重启。打包 UI 测试还启动本机 SSH、MySQL、Redis 协议服务，穿过 preload、IPC、凭据加密与真实网络驱动验证插件生命周期；它不等同于对所有远端服务端版本和网络组合的验证。

如果源码在打包后继续修改，必须重新构建并对新包验证。不得以旧包结果代替当前源码验证，也不得手工修改 `renderer-build/` 或包内文件来消除失败。

## 安装升级与 CI

以下命令仅在前述隔离 Windows 账户或一次性 Runner 中运行：

```powershell
$installer = Get-ChildItem -LiteralPath dist -Filter "Agent运维工作台 Setup *.exe" | Select-Object -First 1
if (-not $installer) { throw "Windows installer was not produced." }
node scripts/install-upgrade-regression.cjs $installer.FullName
```

构建目录有多个版本安装包时，应使用本次构建的明确安装包路径，不任意选取旧版本。常规 [CI](../.github/workflows/ci.yml) 执行检查、Node 测试和完整 UI smoke；[Release 工作流](../.github/workflows/release.yml) 额外核对 Tag 与包版本、构建并验证包、运行隔离安装升级回归后发布。工作流存在或本地等价命令通过，不代表远端 CI 已实际运行成功。

## 结果记录

交付说明记录当前提交/工作区范围、运行环境、实际执行的命令、失败及未覆盖项。发生失败时修复后重跑受影响路径；不能通过删断言、跳过安全测试或修改生产超时来掩盖失败。

确认变更没有削弱凭据隔离、首次连接控制、精确作用域、单次审批、主机指纹/TLS、MySQL/Redis 只读策略及审计保护。公有工具契约变化需要同步工具 Schema、服务、运行时、文档和打包 smoke。

本机测试不证明企业 VPN、生产证书、系统 SSH Agent、全部代理链或远程基础设施已经验证。未运行的安装、升级、远端 CI 或人工检查必须明确标为未运行。安装包哈希、运行日志和截图属于对应交付产物，保留在忽略的产物目录或发布附件，不作为源码文档中的长期成功声明；不得包含真实凭据、客户数据或生产环境内容。

## macOS 构建、包检查与分发

完整要求和未验证项见 [macOS 适配方案](macos-adaptation.md)。在 Mac 上运行相同的 `check`、`test`、`test:ui:all`，然后按本机架构构建并验证。以下以 Apple Silicon 为例：

```sh
corepack pnpm run dist:mac:arm64
node scripts/verify-package.mjs "dist/mac-arm64/Agent运维工作台.app"
node scripts/packaged-mcp-smoke.mjs "dist/mac-arm64/Agent运维工作台.app"
node scripts/packaged-ui-smoke.cjs "dist/mac-arm64/Agent运维工作台.app"
VERSION=$(node -p "require('./package.json').version")
node scripts/install-upgrade-regression.cjs "dist/RunbookBridge-${VERSION}-mac-arm64.dmg"
```

Intel 使用 `dist:mac:x64`，应用目录为 `dist/mac/Agent运维工作台.app`，DMG 后缀为 `mac-x64.dmg`。包检查也接受 `.app/Contents/MacOS/Agent运维工作台` 的绝对路径。

安装回归只能在隔离 Mac 账户或一次性 Runner 运行。它把 DMG 只读挂载到临时目录，用 ditto 复制应用，验证初装、同版本覆盖后的配置/凭据/界面和 MCP，移除临时应用后确认数据保留。它不会写入真实 `/Applications`，也不证明跨版本迁移和用户下载后的 Gatekeeper 行为。

普通 `dist:mac*` 是临时签名的开发包，并明确关闭该测试包的 Hardened Runtime。正式分发设置 `AI_OPS_MAC_RELEASE=1`，提供 `CSC_LINK`/`CSC_KEY_PASSWORD`（Developer ID 证书）和 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；也可使用 electron-builder 支持的 API Key 或钥匙串配置。正式构建强制签名、公证，使用 Hardened Runtime 及 JIT entitlement；缺少配置就失败，不降级成测试包。证书和密码只存 CI secrets。当前 Release 工作流采用 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD` 和上述三个 Apple secrets。

正式包还需要验证：

```sh
codesign --verify --deep --strict "dist/mac-arm64/Agent运维工作台.app"
xcrun stapler validate "dist/mac-arm64/Agent运维工作台.app"
spctl --assess --type execute --verbose "dist/mac-arm64/Agent运维工作台.app"
```

CI 原生运行 Windows x64、Mac arm64、Mac x64。Mac 增加包及安装回归；Release 在三平台检查全部通过后由单个任务发布附件和 SHA-256。实际 Mac VPN 出口切换、Finder 启动的 SSH Agent、钥匙串拒绝授权与签名升级、中文输入法、下载后的首次启动仍须系统验收；不得以 mock 或 workflow 文件存在代替通过证据。
