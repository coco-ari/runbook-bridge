# macOS 源码构建与 MCP

macOS 支持已合并到 `main`，与 Windows 共用业务和界面代码。历史适配批次在 Apple Silicon 和 Intel Runner 上有验证记录，但不能据此视为当前版本已在 Mac 验收通过。当前公开下载仅提供 Windows 安装包；Mac 签名、公证及首次下载启动验收尚未完成。构建和已知边界见 [macOS 适配方案](macos-adaptation.md)。

当前 Mac CI 的终端命令审计回归仍未通过，需要继续定位；本次 Windows Beta 不作为 Mac 验收结果。

普通 CI 继续检查三平台，成功运行的测试安装包位于对应 Actions 的 installers 归档中；开发测试包不作为 Mac 正式分发包。

在 Mac 安装 Node.js 22+、Corepack 和 Xcode Command Line Tools 后，使用仓库锁定依赖构建：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run install:electron-runtime
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui:all
corepack pnpm run dist:mac:arm64
```

Intel Mac 使用 `corepack pnpm run dist:mac:x64`，`dist:mac` 默认构建当前 Mac 的架构。两个架构都输出 DMG 与 ZIP。普通构建使用临时签名，供开发验收；正式分发必须完成 Developer ID 签名与 Apple 公证，参见 [测试与交付验证指南](full-function-verification.md)。

安装后，macOS 的 MCP 注册命令为：

```sh
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- "/Applications/Agent运维工作台.app/Contents/MacOS/Agent运维工作台" "/Applications/Agent运维工作台.app/Contents/Resources/app.asar/src/mcp-v2.mjs"
codex mcp get agent-ops
```

macOS 数据保存在 `~/.ai-ops-tool`，密码由系统钥匙串加密。两个平台使用同一套项目/环境/插件格式，但 Windows 密文不能直接搬到 Mac 解密；可以使用[云配置仓库](cloud-config.md)迁移项目和凭据，由目标设备重新加密保存。直接复制应用数据目录仍需重新填写凭据和本机私钥路径。自定义 `AI_OPS_DATA_DIR` 时，桌面与 MCP 必须使用同一个绝对路径。

“系统 VPN”要求先在操作系统连接 VPN，再填写实际网卡名称（例如 Mac 的 `utunN`）。工作台会验证目标 IP 的实际出口，验证失败就拒绝连接；旧配置和 MCP 的 `windowsVpn` 标识继续兼容。Mac 使用 Command 快捷键，仍支持原有 Ctrl 快捷键。最后一个窗口关闭时，应用退出并断开连接，与 Windows 保持一致。
