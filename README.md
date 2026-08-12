# RunbookBridge（AI 运维工具）

面向个人使用的 Windows SSH 运维桌面工具。用户在桌面界面建立 SSH 连接，Codex 通过本地 MCP 复用该连接执行旧项目的部署、上传和日志下载操作；MCP 接口不会返回密码、私钥口令或代理密码。

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
- 使用 Windows DPAPI 加密保存登录凭据，并支持断开后的一键重连；
- 凭据与服务器、账号、认证方式及代理身份绑定，连接目标变化后强制重新输入；
- OpenSSH/PEM/PPK 私钥文件登录及私钥口令；
- Windows OpenSSH Agent Named Pipe；
- 直连、SOCKS5 和 HTTP CONNECT 代理；
- 首次主机指纹确认和后续固定指纹校验；
- 一条认证连接上的独立 exec/SFTP channel；
- 流式上传普通文件，先写 `.part` 再改名；
- 下载文件到项目自己的 `downloads` 目录；
- 本地 Named Pipe Broker 和每用户随机认证令牌；
- stdio MCP：`list_projects`、`open_project`、`execute`、`upload`、`download`；
- 文档版本 + SSH 会话代次绑定的 `contextToken`；
- 只有 Codex 实际读取的文档版本才能签发操作令牌，文档截断时拒绝执行；
- 每项目默认开启危险命令拦截，并支持每行一条的自定义阻止短语；
- 被拦截命令不会发送到 SSH，审计只保存规则、工作目录和命令哈希；
- 断开或关闭桌面工具后立即拒绝新的服务器操作；
- SSH 被网络或服务器重置时安全清理会话，不弹主进程异常；
- JSON Lines 操作记录。

SSH 跳板机暂未进入 0.1.x；当前可用 SOCKS5 或 HTTP CONNECT 代理。跳板机作为后续版本能力保留在设计文档中。

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
3. 首次点击“连接”并输入密码或口令；勾选“记住登录凭据”后，后续可以一键重连；
4. 在 Codex 中说“读取订单系统生产项目文档并执行部署”；
5. 用完后在桌面工具点击“断开”，或关闭工具。

MCP 在执行任何服务器操作前都要求调用 `open_project`。文档修改、SSH 断开或重新连接都会使旧 `contextToken` 失效。

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
- Named Pipe Broker；
- MCP 工具发现和 README 返回；
- Electron `--mcp` 启动入口；
- 密码和加密私钥 SSH 登录；
- 首次指纹确认；
- 命令执行与断开撤权；
- 危险命令、组合命令、Shell 混淆与自定义短语拦截；
- SFTP 上传下载；
- SOCKS5 和 HTTP CONNECT 隧道。
