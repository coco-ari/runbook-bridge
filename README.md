# Agent 运维工作台

面向个人运维场景的 Windows 本地 Agent 运维工具。桌面应用统一管理项目、环境、服务器、MySQL、Redis、连接状态和加密凭据；Codex 等 Agent 通过本地 MCP 使用结构化运维能力。

当前正式版本：`1.0.42`

## 设计目标

- 读取优先：普通服务器文件、目录、日志、系统状态和数据库只读查询可以直接执行。
- 变更确认：上传、写入、移动、删除、服务控制和任意 Shell 必须由用户在桌面端逐次确认。
- 凭据本地保管：Agent 不接触密码、私钥口令、代理密码和数据库密码。
- 环境隔离：项目下的每个环境拥有独立的运维手册、插件、连接状态和审计记录。
- 精准上下文：环境 `README.md` 是给 Agent 使用的服务器手册，不是文件读取白名单。

## 核心能力

### 项目、环境与插件

数据模型为 `Project → Environment → Plugin`：

- 一个项目可以包含多个环境，例如生产、测试、灰度。
- 每个环境可以配置多个 Server、MySQL 和 Redis 插件。
- 一个 MySQL 插件固定连接一个数据库；一个 Redis 插件固定一个 logical DB。
- MySQL、Redis 可以直连，也可以复用同环境 Server 插件建立 SSH 隧道。
- 打开项目或环境不会自动联网；用户必须在桌面端主动连接。
- 环境允许部分连接成功，Agent 只能使用状态为 `connected` 的插件。

### 配置、验证与连接

- 插件详情默认只读。基本信息和 Agent 策略使用独立轻量编辑，不会断开现有网络连接。
- 点击“修改连接配置”后，应用会先显示影响范围，等待正在进行的操作结束，再断开受影响连接并进入受保护的编辑会话。
- Server 使用 SSH 专属验证，MySQL 使用数据库发现与固定库验证，Redis 使用 Logical DB 验证；TLS 另有显式探测。所有验证只使用当前草稿，不改变正式连接或 Agent context。
- “保存配置”只提交配置和凭据；“保存并恢复连接”在提交成功后按进入编辑前的连接集合恢复。配置保存成功但连接失败时，无需再次保存。
- 正式连接只读取已提交配置和 active 凭据。MySQL 只修改数据库、Redis 只修改 Logical DB 时会沿用同一账号的已保存凭据。
- 密码控件显示“已保存 · 未修改”“未设置 · 未修改”或“将替换”。空密码、未填写密码和未点击“更换密码”都表示保持原凭据，不会清空旧密码。
- 新插件或未完成编辑只有明确点击“保存草稿”后才会跨重启保留。持久草稿不参与正式连接、Connect All 或 Agent 操作。

### Server

- 查看系统负载、内存、文件系统、服务、Journal 和容器信息。
- 对任意绝对路径执行 `stat`、目录列举、文件查找、分页读取和文本搜索。
- 下载普通文件到项目本地下载目录。
- 不要求预先配置日志或配置文件数据源；旧版 `sourceId/fileId` 工具继续兼容。
- 不跟随符号链接目录，不读取设备、FIFO、Socket 等特殊文件。
- 文件查找、搜索和读取均有深度、数量、字节数、并发与超时上限，Agent 应根据服务器负载主动缩小范围。

### MySQL

- 列出当前插件数据库中的基础表。
- 查看表结构。
- 执行单条 `SELECT` 和 `EXPLAIN SELECT`。
- 固定目标数据库，禁止 `USE`、跨库、多语句、View、锁定读、文件输出、危险函数、DDL 和数据写入。
- SQL 由后端 AST 解析器进行 fail-closed 校验，无法确认安全的语句直接拒绝。

### Redis

- 在用户登记的 Key pattern 范围内执行有界 `SCAN`。
- 读取 String、Hash 单字段和集合元数据。
- 查询 TTL。
- 禁止写入、`KEYS`、`EVAL`、`MONITOR` 和 Agent 切库。

## Agent 安全模型

权限由应用内置能力表决定，不接受 Agent 自报风险，也不依赖可被修改的提示词。

| 操作类型 | 默认策略 | 示例 |
| --- | --- | --- |
| Server 普通读取 | 自动允许 | 状态、目录、查找、读取、搜索、下载 |
| MySQL 只读 | 自动允许 | 表结构、`SELECT`、`EXPLAIN SELECT` |
| Redis 有界读取 | 自动允许 | `SCAN`、读取、TTL |
| Server 文件变更 | 每次确认 | 上传、创建、覆盖、移动、重命名、删除 |
| 服务控制 | 每次确认 | start、stop、restart、reload、enable、disable |
| 任意 Shell | 强确认 | 显示完整命令并要求二次确认 |
| 未知能力 | 拒绝 | 未登记或无法分类的调用 |

确认令牌绑定项目、环境、插件、能力、完整参数和目标状态，只能使用一次。参数、本地上传文件或远端目标在确认后发生变化，必须重新确认。

本工具只约束通过自身发起的操作，不能限制同一账号从其他 SSH、数据库客户端或服务器入口执行的行为。

## MCP 工具

正式版提供 34 个结构化工具。

| 分类 | 工具 |
| --- | --- |
| 环境 | `list_projects`、`list_environments`、`open_environment`、`add_plugin` |
| Server 状态 | `server_system_snapshot`、`server_service_inspect`、`server_journal_query`、`server_container_inspect` |
| Server 文件 | `server_stat`、`server_list_directory`、`server_find_files`、`server_read_file`、`server_search_files`、`server_download_file` |
| Server 变更 | `server_upload_file`、`server_write_file`、`server_move_path`、`server_delete_path`、`server_control_service`、`server_execute_shell` |
| 兼容工具 | `server_list_actions`、`server_run_action`、`server_list_sources`、`server_list_files`、`server_read_log`、`server_search_logs`、`server_read_config` |
| MySQL | `mysql_list_tables`、`mysql_describe_table`、`mysql_query_readonly`、`mysql_explain` |
| Redis | `redis_scan`、`redis_read`、`redis_ttl` |

每次开始操作环境时，Agent 必须先调用 `open_environment`，读取最新运维手册、插件目录、连接状态和短期 `contextToken`。环境手册、插件配置或安全相关状态变化后，旧令牌自动失效。

Agent 调用不会建立首次连接。插件未连接时，应在桌面应用中点击“连接环境”或单独连接目标插件。

Agent 的“连接并继续”也必须由用户明确触发；连接成功后会重新获取最新 context 并重新评估请求，不会直接重放旧 tool call 或旧审批。写入、删除、重启等危险操作仍需独立确认。

## 安装与升级

从 [GitHub Releases](https://github.com/coco-ari/runbook-bridge/releases) 下载最新 Windows 安装包并运行。支持覆盖安装升级和自选安装目录。

应用数据默认保存在：

```text
%LOCALAPPDATA%\AIOpsTool\
├── credentials\
│   ├── plugins.enc.json
│   ├── plugins.enc.backup.json
│   ├── plugin-drafts.enc.json
│   └── plugin-drafts.enc.backup.json
├── runtime\
│   └── plugin-draft-promotions\
└── projects\<projectId>\
    ├── project.yaml
    ├── workspace.yaml
    ├── environments\<environmentId>\
    │   ├── environment.yaml
    │   ├── README.md
    │   ├── plugins\<pluginInstanceId>.yaml
    │   └── plugin-drafts\<draftId>.json
    ├── downloads\<environmentId>\<pluginInstanceId>\
    └── audit\operations-v3.jsonl
```

密码、私钥口令和代理密码通过 Electron `safeStorage` 与 Windows DPAPI 加密保存，不写入 YAML、README、草稿 sidecar 或审计日志。active vault 和 draft vault 相互隔离并各自维护加密备份；草稿提升通过恢复 journal 提交。软件升级、覆盖安装、卸载后重装、删除项目、删除插件和删除草稿都不会由应用主动永久删除凭据文件。旧凭据不可读时，应用保留原密文字节并阻止普通保存覆盖。

请勿手工删除 `%LOCALAPPDATA%\AIOpsTool`。Windows 用户账户被删除、DPAPI 主密钥损坏或数据目录被外部清理时，加密凭据可能无法恢复。

## 配置 Codex MCP

安装后执行：

```powershell
codex mcp add --env ELECTRON_RUN_AS_NODE=1 agent-ops -- `
  "$env:LOCALAPPDATA\Programs\Agent运维工作台\Agent运维工作台.exe" `
  "$env:LOCALAPPDATA\Programs\Agent运维工作台\resources\app.asar\src\mcp-v2.mjs"
```

如果安装时选择了其他目录，请替换为实际可执行文件路径。配置完成后完全退出并重新打开 Codex，使其重新加载 MCP 工具列表。

桌面应用必须处于运行状态，本地 Named Pipe Broker 才会接受 MCP 调用。MCP 进程以 Electron Node 模式启动，不会额外打开桌面窗口。

## 使用流程

1. 在桌面应用中新建项目和环境。
2. 为环境添加 Server、MySQL 或 Redis 插件并填写连接信息；未完成时可明确保存为草稿。
3. 在连接编辑器中执行插件专属验证，然后选择“保存配置”或“保存并恢复连接”。
4. 在环境 `README.md` 中维护真实、准确的服务器手册。
5. 点击“连接环境”或单独连接插件，确认目标插件显示为已连接；待处理插件不会阻止其它独立分支连接。
6. 在 Codex 中描述运维目标，Agent 会先打开环境，再调用对应结构化工具。
7. 普通读取直接执行；危险操作在桌面端显示参数并等待确认。
8. 在项目“最近操作”中检查用户、Agent 和系统审计记录。

## 环境 README 模板

环境手册越精确，Agent 定位日志、配置、服务和发布目标越快。推荐使用以下结构：

```markdown
# 系统名称 - 环境名称

## 环境说明
- 用途：测试 / 生产
- 时区：Asia/Shanghai
- 负责人：

## 服务器职责
- 应用服务器：运行 API、定时任务
- 数据库服务器：MySQL 8.x
- 缓存服务器：Redis 6.x

## 应用
### API 服务
- systemd unit：example-api.service
- 安装目录：/opt/example/api
- JAR：/opt/example/api/example-api.jar
- 工作目录：/opt/example/api
- 配置文件：/opt/example/api/application-prod.yml
- 普通日志：/var/log/example/api.log
- 启动日志：/opt/example/api/logs/start.log
- 健康检查：http://127.0.0.1:8080/actuator/health

## 中间件
- Nginx 主配置：/etc/nginx/nginx.conf
- Nginx 站点配置：/etc/nginx/conf.d/example.conf
- Redis 配置：/etc/redis/redis.conf
- MySQL 配置：/etc/mysql/my.cnf

## 发布流程
1. 检查磁盘、内存和当前服务状态。
2. 上传制品到临时路径。
3. 备份当前制品。
4. 原子替换制品。
5. 重启服务并执行健康检查。

## 回滚流程
1. 停止或重启前确认当前制品和备份路径。
2. 恢复上一版本制品。
3. 重启服务并检查日志与健康状态。

## 禁止事项与注意事项
- 生产环境发布窗口：
- 不允许操作的服务或目录：
- 大日志读取限制：优先尾部抽样，不扫描或下载超大文件
```

README 用于导航和决策，不限制 Server 普通文件读取范围。密码、Token、私钥、DSN 等秘密信息不要写入 README。

## 常见问题

### MCP 返回 `Transport closed`

安装或升级会终止旧 MCP 子进程。完全退出并重新打开 Codex，不需要重新录入项目密码。若工具数量仍不是 34 个，再检查 MCP 注册路径是否指向当前安装目录。

### MCP 提示插件未连接

Agent 不会替用户建立首次连接。打开桌面应用，在目标环境点击“连接环境”，然后让 Agent 重新调用 `open_environment`。

### 升级后密码是否保留

会保留。安装器配置为不删除应用数据，应用的软件清理、项目删除和插件删除流程也不会清除加密凭据。不要手动清理 `%LOCALAPPDATA%\AIOpsTool`。

编辑已有插件时，密码输入框为空表示“未修改”。只有点击“更换密码”并输入新值后才会替换；只改 MySQL 数据库或 Redis Logical DB 不需要重新输入同一账号的密码。

### 为什么读取仍然有上限

读取不会因内容敏感而拒绝，但深度、文件数量、扫描字节、单次返回大小和超时仍有边界，用于避免误扫整台服务器、阻塞特殊文件或读取超大日志影响线上服务。

### 为什么 SQL 被拒绝

只允许当前 MySQL 插件固定数据库中的单条只读查询。跨库、多语句、写入、锁定读、文件函数、延时函数或解析器无法确认安全的语法都会拒绝。

## 本地开发

需要 Node.js 22+ 和 pnpm 11：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run test:ui
pnpm start
```

构建 Windows NSIS 安装包：

```powershell
pnpm run dist
```

验证打包后的应用与 MCP：

```powershell
node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"
```

推送 `v*` Tag 后，[Release 工作流](.github/workflows/release.yml) 会在 Windows Runner 上安装依赖、执行测试、构建安装包、验证 MCP，并创建 GitHub Release。

## 架构与测试

- [技术设计](docs/agent-ops-v1-technical-design.md)
- [插件数据源架构](docs/plugin-data-source-architecture.md)
- [交互原型](docs/ai-ops-plugin-environment-prototype.html)
- [版本变更记录](CHANGELOG.md)

自动化测试覆盖凭据保留、旧版迁移、环境连接依赖、网络重连、上下文失效、Server 任意路径读取、危险操作确认、MySQL AST 策略、SFTP 异常、下载上传以及 Electron UI 工作流。

## License

[MIT](LICENSE)
