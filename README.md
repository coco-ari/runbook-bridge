# RunbookBridge（AI 运维工具）

面向个人使用的 Windows SSH 运维桌面工具。用户在桌面界面建立 SSH 连接，Codex 通过本地 MCP 复用该连接执行旧项目的部署、上传、日志下载和受限日志搜索；MCP 接口不会返回密码、私钥口令或代理密码。

> [!WARNING]
> 请使用无任意 `sudo` 的专用低权限 Linux 用户。危险命令策略只能减少明显误操作，不能让 `root` 会话变得安全。

## 为什么做这个工具

许多旧 Java 项目仍依赖 SSH、JAR 备份、启动脚本和文件日志，流程又很难完全标准化。本工具让用户在本地桌面端保管登录能力，由 Codex 读取项目 Markdown 后复用已经建立的 SSH 会话完成这些重复工作。用户随时断开连接即可撤销后续访问。

## 已实现功能

- 多项目创建和列表；
- 首次连接失败后重试同一个已创建项目，不会生成重复项目；
- 项目对话框与异步操作绑定，避免 A 项目的连接信息误写到 B 项目；
- 项目连接设置编辑，以及将项目安全移入 Windows 回收站；
- 每个项目任意新增、编辑、预览和删除 Markdown 文档；
- 编辑中的 Markdown 不受连接状态刷新影响，保存后会回读磁盘校验；
- 默认创建 `README.md`，并禁止误删入口文档；
- 新项目默认 `README.md` 包含 Codex MCP 轻量模式安装、验证和重启说明；
- 密码登录；
- 使用 Windows DPAPI 加密保存登录凭据，并支持一键连接与意外断线自动重连；
- 凭据与服务器、账号、认证方式及代理身份绑定，连接目标变化后强制重新输入；
- OpenSSH/PEM/PPK 私钥文件登录及私钥口令；
- Windows OpenSSH Agent Named Pipe；
- 直连、SOCKS5 和 HTTP CONNECT 代理；
- 首次主机指纹确认和后续固定指纹校验；
- 一条认证连接上的独立 exec/SFTP channel；
- 流式上传普通文件，先写 `.part` 再改名；
- 下载文件到项目自己的 `downloads` 目录；
- 结构化日志搜索：明确文件、字面量 AND/OR、前后文、扫描与结果截断说明、短期分页游标；
- 本地 Named Pipe Broker 和每用户随机认证令牌；
- stdio MCP：`list_projects`、`open_project`、`execute`、`execute_batch`、`upload`、`download`、`search_logs`；
- `execute_batch` 可顺序执行最多 10 条独立命令，每步单独检查、超时和审计，减少多步部署的 MCP 往返；
- 文档版本 + SSH 会话代次绑定的 `contextToken`；
- 同一 MCP 进程在文档和连接未变化时复用令牌，并返回签发时间、到期时间与剩余有效期；
- 只有 Codex 实际读取的文档版本才能签发操作令牌，文档截断时拒绝执行；
- 每项目默认开启危险命令拦截，并支持每行一条的自定义阻止短语；
- 被拦截命令不会发送到 SSH，审计只保存规则、工作目录和命令哈希；
- 断开或关闭桌面工具后立即拒绝新的服务器操作；
- SSH 被 VPN 切换、网络抖动或服务器重置时，按 1、2、5、10、30 秒退避自动重连；
- 服务器拒绝密码、私钥或私钥口令时停止自动重连，避免错误凭据持续尝试导致账号锁定；
- 用户主动断开、删除项目或退出程序时立即停止自动重连；
- 带 `schemaVersion` 的 JSON Lines 操作记录，关键 MCP 操作带 `operationId` 便于关联。

SSH 跳板机尚未实现；当前可用 SOCKS5 或 HTTP CONNECT 代理。

## 从源码运行

需要 Node.js 22 或更新版本，以及 pnpm。

```powershell
git clone https://github.com/coco-ari/runbook-bridge.git
cd runbook-bridge
corepack pnpm install
pnpm test
pnpm start
```

构建 Windows 安装程序：

```powershell
pnpm dist
```

构建产物位于 `dist`。

## 接入 Codex

安装完成后，把同一个桌面程序以轻量 Node 模式注册为本地 stdio MCP。把路径换成实际安装位置；第二个参数指向安装目录中的 `resources\\app.asar\\src\\mcp.mjs`：

```powershell
codex mcp add --env ELECTRON_RUN_AS_NODE=1 ai-ops -- "$env:LOCALAPPDATA\Programs\AI运维工具\AI运维工具.exe" "$env:LOCALAPPDATA\Programs\AI运维工具\resources\app.asar\src\mcp.mjs"
```

也可以在 ChatGPT 桌面应用的 MCP 设置中添加：

```text
类型：STDIO
命令：%LOCALAPPDATA%\Programs\AI运维工具\AI运维工具.exe
参数：安装目录下的 `resources\app.asar\src\mcp.mjs`
环境变量：`ELECTRON_RUN_AS_NODE=1`
```

验证：

```powershell
codex mcp list
```

使用顺序：

1. 启动“AI 运维工具”；
2. 创建项目并编辑 `README.md` 等部署文档；
3. 首次点击“连接”并输入密码或口令；
4. 勾选“记住登录凭据”后，后续可以一键连接，意外断线也会自动重连；
5. 在 Codex 中说“读取订单系统生产项目文档并执行部署”或“搜索订单号对应的日志”；
6. 用完后在桌面工具点击“断开”，或关闭工具。

MCP 在首次操作项目、令牌过期或文档变化后要求调用 `open_project`。文档与 SSH 连接都没有变化时，同一 MCP 进程可在返回的 `expiresAt` 前复用令牌；文档修改、SSH 断开或重新连接都会使旧 `contextToken` 失效。自动重连期间 MCP 暂时拒绝服务器操作；连接恢复后，Codex 必须重新读取项目文档并取得新令牌。对于需要密码或口令的项目，自动重连要求勾选“记住登录凭据”；服务器拒绝认证时自动重连会停止，用户需要点击“连接”并重新输入凭据。用户点击“断开”、删除项目或关闭桌面工具也会取消后续重连。

`search_logs` 从项目 Markdown 获取明确的服务器日志绝对路径，通过 SFTP 读取受限字节数并在本地执行字面量搜索，不在服务器运行任意 `grep`。单项目同时只允许一次、全局最多两次搜索，单次硬上限 32 MiB（默认 16 MiB）。默认从文件尾部扫描，返回值会明确给出 `startByte`、`truncated` 和 `lineNumberScope: scanned_snapshot`。它与 `execute`、`download` 一样受 Linux 低权限账号的文件权限约束，不额外维护重复的目录白名单。

项目“高级设置”中的危险命令拦截默认开启。内置规则会拒绝文件删除、提权、关机重启、用户和认证修改、磁盘操作、防火墙清空、包管理、外部下载及动态 Shell 等高风险命令。可以添加每行一条的自定义阻止短语；匹配时 Broker 返回 `COMMAND_BLOCKED`，命令不会到达服务器。

从 0.1.4 或更早版本升级时，旧凭据没有连接目标绑定信息，因此首次连接需要重新输入一次；成功后会按新格式加密保存。旧的 `--mcp` 注册方式仍可兼容，但会额外启动 Electron 辅助进程，建议按上面的命令重新注册。

## 数据位置

默认项目数据：

```text
%LOCALAPPDATA%\AIOpsTool\projects
```

结构示例：

```text
projects\order-prod\
├── project.yaml
├── credentials.enc.json
├── docs\
│   ├── README.md
│   └── DEPLOY.md
├── downloads\
└── audit\operations.jsonl
```

`project.yaml` 只保存服务器、用户名、认证类型、私钥路径、代理地址和主机指纹等非秘密配置。勾选“记住登录凭据”时，密码、私钥口令和代理密码作为一个整体通过 Electron `safeStorage` 调用 Windows DPAPI 加密，再写入 `credentials.enc.json`；不会以明文写入项目配置或 Markdown。

取消勾选后，已保存的加密凭据会被删除。私钥正文始终保留在用户原来的私钥文件中，不复制到项目目录。

## 安全边界

- Codex 连接期间拥有该 Linux 低权限账号本身能够完成的操作；
- 不要使用 `root`，也不要给项目账号开放任意 `sudo`；
- Markdown 是操作规范，不是服务器端权限控制；
- 命令拦截用于防止明显误操作，不是 Shell 沙箱；上传后运行自定义程序、脚本内部行为和其他间接方式无法仅靠黑名单可靠判断；
- 本地 MCP 继承当前 Windows 用户的文件读取权限；
- Windows DPAPI 主要防止其他 Windows 用户读取凭据；同一 Windows 登录会话中的恶意进程不属于该机制能够隔离的边界；
- 上传并运行任意 JAR，仍然等价于让该 JAR 以应用账号权限执行；
- 首次显示的服务器指纹必须与可信来源核对；
- 代理只建立 TCP 通道，最终服务器仍执行 SSH 主机指纹验证。

安全漏洞请不要提交公开 Issue，参见 [SECURITY.md](SECURITY.md)。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

版本变化和升级注意事项参见 [CHANGELOG.md](CHANGELOG.md)。0.3.0 的发布说明位于 [docs/releases/v0.3.0.md](docs/releases/v0.3.0.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。

## 测试

测试不需要真实生产服务器，会在本机启动临时 SSH、SFTP、SOCKS5 和 HTTP CONNECT 服务。

```powershell
pnpm test
```

当前测试覆盖：

- 明文凭据不落盘、Windows 密文保存与清除；
- Markdown 上下文哈希与失效；
- 上下文令牌复用、到期元数据与连接代次绑定；
- Named Pipe Broker；
- MCP 工具发现和 README 返回；
- Electron `--mcp` 启动入口；
- 密码和加密私钥 SSH 登录；
- 首次指纹确认；
- 命令执行与断开撤权；
- 意外断线自动重连，以及用户主动断开取消重试；
- SSH 认证失败后停止自动重连并等待用户更新凭据；
- 危险命令、组合命令、Shell 混淆与自定义短语拦截；
- 批量命令的顺序执行、遇错停止、继续执行和总输出限制；
- SFTP 上传下载；
- 日志文件校验、字面量搜索、上下文合并、截断元数据与游标分页；
- SOCKS5 和 HTTP CONNECT 隧道。
