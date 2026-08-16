# Agent 运维工作台

Windows 本地、插件优先的 Agent 运维入口。一个业务项目包含多个用户命名的环境，每个环境拥有独立的 `README.md` 和 Server、MySQL、Redis 插件。桌面应用保管凭据和连接，Agent 只能通过本地 MCP 使用经过策略校验的结构化能力。

> 请给 Server 插件使用无任意 `sudo` 的专用低权限账号，给 MySQL 使用只授予目标数据库的只读账号，给 Redis 使用只读 ACL 账号。插件策略不能约束同一账号从其他入口拥有的权限。

## V1 功能

- `Project → Environment → Plugin`：环境名称完全由用户定义，运维说明和插件严格按稳定环境 ID 隔离。
- Server、MySQL、Redis 是平级插件；Server 不是项目主轴，但可被同环境数据库插件复用为 SSH 隧道。
- 一个 MySQL 插件固定一个数据库；一个 Redis 插件固定一个 logical DB。
- 打开项目或切换环境不会联网。用户在环境顶部点击“连接环境”，系统按依赖图先连接 Server，再连接引用它的数据库插件；Direct/VPN 插件可并行连接。
- 部分连接成功时，成功插件可继续供 Agent 使用，失败插件单独不可用。
- 只有本次程序运行期间用户主动连接、且未手动断开的环境会响应网络变化自动重连；程序重启后一律保持未连接。
- 地址族支持 IPv4 优先（默认）、仅 IPv4、IPv6 优先、仅 IPv6。优先模式只在 DNS/TCP 网络层失败时切换地址族，不会因认证、主机指纹或 TLS 身份错误切换。
- 支持 Direct、Windows VPN 路由守卫、SOCKS5、HTTP CONNECT 和同环境 Server SSH 隧道；不会自动回退公网直连。
- 密码、私钥口令、代理密码和 TLS 私密材料通过 Electron `safeStorage`/Windows DPAPI 加密保存，不写入 YAML 或 README。
- 操作记录按项目写入 JSON Lines，包含环境和插件作用域，不记录密码、SQL 参数或结果内容。

## Agent 安全模型

MCP 不提供任意 Shell、任意数据库连接、原始 Redis 命令或连接按钮：

- Server：Agent 只能传内置 `actionId + 结构化参数`；日志和配置先从已登记 `sourceId` 枚举出短期 `fileId`，再进行有界读取、字面量搜索或下载。
- MySQL：只提供表清单、基础表结构、`SELECT` 和 `EXPLAIN SELECT`。后端使用 AST fail-closed 校验，固定目标数据库，禁止多语句、`USE`、跨库、View、锁定读、文件输出、危险函数和全部写入。
- Redis：只提供已登记 Key pattern 下的 `SCAN`、安全读取和 TTL；禁止写入、`KEYS`、`EVAL`、`MONITOR` 和 Agent 切库。
- 每个环境先调用 `open_environment`，获取当前 README、插件目录和短期 `contextToken`。README、环境或目标插件策略变化后，旧上下文失效并要求 Agent 重新读取。
- 策略支持“自动允许 / 每次确认 / 禁止”。每次确认绑定项目、环境、插件、能力和完整结构化参数，只能使用一次。
- Agent 调用永远不会建立首次连接或偷偷重试失败插件；目标插件必须已经由用户连接并处于 `connected`。

## 从旧版迁移

首次启动 V1 时，每个旧 `project.yaml` 会旁路生成 `workspace.yaml`、一个稳定 ID 为 `default` 的“默认环境”、一个 `server-primary` Server 插件和环境独立的 `README.md`。旧文件不会被覆盖或删除，因此可以回退。

可解密且绑定仍匹配的旧凭据会重新加密写入插件凭据库；失败时仅要求重新输入凭据，不影响非秘密配置和文档。迁移是幂等的，不会自动猜测或创建 MySQL/Redis 插件。

## 运行和构建

需要 Node.js 22+ 和 pnpm：

```powershell
corepack pnpm install
pnpm check
pnpm test
pnpm test:ui
pnpm start
```

构建 Windows 安装程序：

```powershell
pnpm dist
```

## 接入 Agent MCP

安装后使用 Electron 的 Node 模式启动轻量 MCP，不会创建第二个桌面窗口：

```powershell
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- `
  "$env:LOCALAPPDATA\Programs\Agent运维工作台\Agent运维工作台.exe" `
  "$env:LOCALAPPDATA\Programs\Agent运维工作台\resources\app.asar\src\mcp-v2.mjs"
```

桌面应用必须运行，Named Pipe Broker 才会接受 MCP 调用。MCP 的固定工具描述会在会话初始化时提供给 Agent；项目、README、插件和运行状态不会在每轮对话自动全部发送，只有 Agent 主动调用 `open_environment` 或其他分页工具时才返回有界结果。

## 数据结构

```text
%LOCALAPPDATA%\AIOpsTool\
├── credentials\plugins.enc.json
└── projects\<projectId>\
    ├── project.yaml                 # 旧版，迁移后保留
    ├── workspace.yaml               # V1 项目与环境顺序
    ├── environments\<environmentId>\
    │   ├── environment.yaml
    │   ├── README.md
    │   └── plugins\<pluginInstanceId>.yaml
    ├── downloads\
    └── audit\operations-v3.jsonl
```

完整架构、安全约束、状态机和验收场景见 [技术设计](docs/agent-ops-v1-technical-design.md)。

## 测试范围

自动化测试覆盖旧版兼容、V2 数据迁移、凭据绑定、环境依赖连接、部分成功、上下文失效、MySQL AST 拒绝语料、Server 固定 action、MCP 无任意 Shell 契约，以及 1280×720 Electron UI 工作流。生产部署前仍应在独立的测试账号、测试数据库和目标网络中完成连接、权限与故障恢复验证。

本项目采用 [MIT License](LICENSE)。
