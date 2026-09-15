# macOS 适配方案与验收记录

## 目标与边界

`codex/macos-support` 已合入 `main`，后续在主分支共同开发。Windows 与 macOS 共用业务代码、React Renderer、IPC、MCP 和安全策略；不建立独立 Mac 界面，不删减 VPN、终端、数据库、文件传输或 Agent 功能。

“功能、界面 1:1”指相同数据、相同内容区尺寸下的信息结构、页面布局、主题、操作入口、状态反馈和业务结果一致。系统窗口边框、文件选择器、钥匙串授权框以及操作系统字体栅格化由平台提供；Mac 使用 Command 快捷键，同时保留已有 Ctrl 支持。以上系统差异不允许改变内容区布局或缺失操作。Windows 行为必须回归通过。

支持 Apple Silicon（arm64）及 Intel（x64），分别产出 DMG 和 ZIP；系统最低版本以当前锁定 Electron 运行时和实际验证结果为准，不凭构建成功宣称旧系统可用。当前开发主机为 Windows，Mac 真机/Runner 结果必须独立取得，不能用注入 `darwin` 的单元测试替代。

## 实施顺序

1. 固定共用界面与业务边界，补平台路径、包结构和 VPN 安全测试。
2. 实现 macOS VPN 路由验证，保留既有配置标识，消除非 Windows 未验证仍连接的路径。
3. 适配系统存储提示、MCP 注册文档、平台快捷键和桌面生命周期。
4. 增加 macOS 构建与签名、公证入口，统一安装包定位和冒烟检查。
5. 增加双架构 Mac CI、安装/覆盖升级测试、与 Windows 相同的完整 UI 验证。
6. 跑 Windows 回归和包检查；在 Mac 运行完整验收，记录证据及未完成项。

## 平台设计

### 数据、身份与本地通信

- 保留所有稳定身份：`com.local.aiopstool`、`Agent运维工作台`、`AI 运维工具`、`ai-ops-mcp`、`agent-ops`、`agent-ops-workbench` 和 Windows `AIOpsTool`/pipe 命名。
- Windows 数据目录保持 `%LOCALAPPDATA%\AIOpsTool`；macOS 继续使用源码已存在的 `~/.ai-ops-tool`，避免迁移试用用户的数据。`AI_OPS_DATA_DIR` 在桌面与 MCP 中使用同一规则。
- macOS 使用 Unix socket。验证权限、残留清理、长路径、启动/退出/重启、Token 轮换、未启动/未连接失败和作用域隔离。任何路径优化必须保持桌面和 MCP 端一致。
- 凭据继续由 Electron `safeStorage` 保存，macOS 使用 Keychain；拒绝授权或解密失败必须保持失败关闭，禁止明文回退。Windows 密文不承诺跨系统可解密，迁移配置后应重新录入凭据及本机私钥路径。

### VPN、SSH 与网络

- 持久化和 MCP 中的 `windowsVpn` 保留兼容名称；桌面统一描述为“系统 VPN”，根据用户填写的本机网卡名验证路由。它表示由用户先在系统连接的 VPN，应用不创建系统 VPN。
- Windows 保留 `Find-NetRoute` 校验；macOS 对解析后的单个 IP 用固定绝对路径 `/sbin/route`、固定 `get` 参数和明确地址族检查内核选路，精确匹配返回的网卡。随后绑定该网卡对应地址族的本地地址。
- 输入非法、网卡不存在、地址族不符、路由缺失/不符、命令超时或输出无法判定时均拒绝连接。不得仅绑定本地地址后声称通过路由验证；不支持的平台也应拒绝。
- Server 和 MySQL/Redis 共用验证器，代理、SSH 隧道、DNS 策略、TLS/Host Key 门禁继续沿用。网络切换与唤醒使现有上下文失效并触发现有重连流程。
- SSH Agent 保留显式 socket、`SSH_AUTH_SOCK` 和 Windows 默认管道的优先级；Mac 从 Finder 启动时须验证系统 Agent 可用性。真实 VPN 和系统 Agent 是系统验收项。

### 界面和生命周期

- 只使用 `renderer/v2/` 与生成后的同一 Renderer，禁止另建 Mac 页面；功能入口、样式和业务状态机保持一致。
- Mac 菜单提供原生编辑操作（复制、粘贴、撤销、全选）和退出，使 Command 快捷键在输入框及终端中正常工作；验证已有快捷键与菜单不冲突。
- 为保持“关闭工作台即断开连接”的现有生命周期，两个平台最后一个窗口关闭均退出；Dock 激活和第二实例仍恢复窗口。不能通过隐藏窗口意外留下运维连接。
- 主题、布局尺寸/拖拽/持久化、焦点、弹层、缩放、文件选择、剪贴板、终端键盘与输入法都必须在 Mac 验证。截图只用合成数据，在固定内容区尺寸下比对。

### 构建、原生依赖与 MCP

- 保留 `dist` 的 Windows 命令兼容性，增加显式 `dist:mac`、`dist:mac:arm64`、`dist:mac:x64`。继续使用已有 electron-builder，不增加生产依赖。
- 包定位器识别 Windows 可执行文件和 Mac `.app`/`Contents/MacOS/<binary>`，由 `Contents/Resources/app.asar` 定位 Mac 源码；路径含空格及中文必须通过。
- 包验证仍检查源码和 Renderer 哈希、源文件排除、全部 36 个 MCP 工具及真实本机协议驱动，不降低既有断言。
- `ELECTRON_RUN_AS_NODE=1` 是现有 MCP 启动契约，签名配置不得关闭对应 Fuse。文档使用实际安装的 `.app` 内可执行文件及 `mcp-v2.mjs` 路径。
- `ssh2` 可选原生加密扩展需要检查目标架构和 Electron ABI；不能把 Windows 的 `node_modules` 复制到 Mac。优先使用现有 JavaScript 回退并以包内真实 SSH 协议测试确认。
- 开发构建与可公开分发的签名构建区分记录。正式分发需一致 Developer ID 签名、Hardened Runtime、最小必要 entitlements、Apple 公证及 stapling；Apple 账户和证书仅放 CI secret，不进入源码。
- CI 分别构建 Windows、Mac arm64、Mac x64。发布先汇总所有平台验证后的产物，再由单个发布任务上传，避免多个任务创建同一 Release 的竞态。

## 验收矩阵

| 范围 | 自动验证与系统验收要求 |
| --- | --- |
| 项目、环境 | 新增/编辑/删除/排序、导航、运维说明、快捷提问、布局持久化 |
| 连接与插件 | Server/MySQL/Redis 新增、探针、编辑、凭据保存、连接/取消/重试、Host Key/TLS、网络恢复 |
| VPN | IPv4/IPv6、正确路由、错误出口、缺失网卡、断线、系统选路变化；Server 与数据库拒绝未验证连接 |
| 服务器工作区 | 终端输入/输出/尺寸/关闭、文件浏览/读取/上传审批/覆盖/取消和状态隔离 |
| 数据库工作区 | 多表标签、查询/分页/筛选/排序、补全/拖表、复制、MySQL 只读边界及 Redis 范围 |
| Agent | 36 个 MCP 工具、stdio、Broker 重启、短期上下文、断开拒绝、单次确认绑定、审计 |
| UI 一致性 | 六组完整 Electron smoke，浅/深色、固定内容区尺寸、Command/Ctrl、焦点/弹层、中文路径和输入法 |
| 本地安全 | Keychain 保存/重启解密/拒绝授权/升级解密、Socket/Token 权限与清理，不触碰真实用户数据 |
| 安装与升级 | DMG 挂载、拷贝安装、启动、退出、覆盖安装、数据/密文/布局保持、MCP 仍可用、移除应用保留数据 |
| 分发 | arm64/x64 原生运行、签名与公证校验、安装包哈希、干净 Mac 下载后 Gatekeeper 首启 |
| Windows 回归 | `check`、`test`、`test:ui:all`、`dist`、三个包检查；安装升级在隔离 Runner 执行 |

通用命令参见 [测试与交付验证指南](full-function-verification.md)。新增命令及 Mac 安装路径随实现同步到该指南和 README。

## 当前证据

应用代码已在 [三平台完整 CI（19fccbd）](https://github.com/coco-ari/runbook-bridge/actions/runs/34768302292) 通过验收：

| 平台 | 单元测试 | 六组 UI | 构建与三个包检查 | 隔离安装、覆盖升级和数据保留 |
| --- | --- | --- | --- | --- |
| Windows x64 | 804 通过，3 项平台专用测试跳过 | 通过 | 通过 | 通过 |
| macOS 15 / Apple Silicon | 807 通过，0 跳过 | 通过 | DMG/ZIP 及包检查通过 | 通过 |
| macOS 15 / Intel | 807 通过，0 跳过 | 通过 | DMG/ZIP 及包检查通过 | 通过 |

- 两种 Mac 均实际执行 Unix socket 权限、长路径、重复启动、重启清理及 `/sbin/route` 内核查询。VPN 错误出口、不可用路由和 IPv6 源地址范围均有拒绝测试。
- 包内测试验证 35 个 MCP 工具、74 个 preload API、真实本机模拟 SSH/MySQL/Redis 协议、作用域隔离与凭据不泄露。安装回归验证三类插件凭据在进程重启和同版本覆盖安装后可解密，主/备密文与配置保留，移除临时应用后数据仍在。Mac 在此过程中使用实际 Keychain。
- Windows 本地也已通过语法/类型、完整单元、六组 UI、`dist` 和三个包检查；新增服务器截图内容区校准已通过本地相关 UI 回归。
- Windows 与 Mac 共用 Renderer。CI 保留浅/深色、插件编辑、业务弹层、服务器和数据库等合成截图；服务器截图统一按内容区尺寸采集，并断言 PNG 尺寸一致。两端使用系统字体，中文笔画与字重视觉存在差异，不能将截图解读为逐像素相同。
- 已修正实际 Mac 草稿确认框延迟抢焦点问题、自动化 Command+A 编辑命令、临时提示遮挡点击，以及主线原有服务器虚拟列表 smoke 定位问题；没有减少功能或放宽安全策略。
- 当前产物为临时签名的开发测试包。仓库未配置 Apple 签名和公证 secrets，正式分发会明确失败；尚未发布 Mac Release。
- 自动化结果不替代真实 VPN 断线/出口切换、Finder 启动的系统 SSH Agent、中文输入法、用户拒绝钥匙串授权、不同版本签名升级及下载后的 Gatekeeper 首启验收。这些仍需具备相应环境后完成。
- 后续提交的结果见 [适配分支 CI](https://github.com/coco-ari/runbook-bridge/actions/workflows/ci.yml?query=branch%3Acodex%2Fmacos-support)。当前主线 CI 在全部验证通过后保存 installers 测试安装包，未发布正式 Release；截图归档不包含真实运维数据。

## 官方参考

- [Electron 应用包结构](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron 签名与公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder v26 macOS 配置](https://www.electron.build/v26/docs/mac/)
