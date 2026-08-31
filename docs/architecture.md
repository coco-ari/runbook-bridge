# 当前架构与维护边界

本文描述仓库现行实现。用户功能和 MCP 工具见 [README](../README.md)，验证步骤见 [验证指南](full-function-verification.md)。历史规划、原型和迁移报告由 Git 历史保留，不作为当前行为契约。

## 运行入口

| 层次 | 入口与职责 |
| --- | --- |
| Electron 主进程 | `src/main.mjs` 组合本地 Broker、存储、凭据、运行时、连接管理器和 IPC，并管理应用生命周期 |
| 桌面界面 | `renderer/v2/index.html` 与 `renderer/v2/src/` 是唯一 React、TypeScript、Vite 源入口；构建结果为 `renderer-build/v2/` |
| 桌面 API | `src/preload.cjs` 提供显式桥接；`src/ipc-v2.mjs` 校验并分发桌面请求 |
| MCP | `src/mcp-v2.mjs` 提供工具 Schema，经 `src/broker-client.mjs` 和 `src/broker-server.mjs` 访问运行中的桌面应用 |
| 共享服务 | `src/v2-service.mjs` 处理作用域、上下文、能力策略、确认和运行时调用 |
| 插件运行时 | Server、MySQL、Redis 的连接与操作分别由对应 runtime 和 operation 模块实现 |

Electron 只加载构建后的 `renderer-build/v2/index.html`。生成目录不手工修改、不提交；安装包排除 Renderer 源码和已退役的 `src/mcp.mjs`。源码中的 `v2` 是仍在使用的接口和数据模型标识，不是待删的历史副本。

## 数据、连接与凭据

持久化模型为 `Project → Environment → Plugin`，由 `src/workspace-store.mjs` 管理。每个环境拥有独立运维说明；Server、MySQL、Redis 是同级插件。MySQL 固定一个数据库，Redis 固定一个 Logical DB；数据库插件的 SSH 隧道只能复用同环境 Server。

`src/environment-connection-manager.mjs` 管理环境连接意图和依赖，`src/route-manager.mjs` 管理连接路由。打开项目、切换页面、读取 MCP 上下文都不会建立首次连接。环境允许部分连接成功；失败的插件不能使已连接的独立插件失去可用性。应用重启或用户主动断开后，不从持久化状态恢复自动连接意图。

新增插件使用临时探针，修改连接配置使用受保护的编辑会话。验证只针对当前表单，不替换正式连接或 Agent 上下文；正式连接使用已提交配置和 active 凭据。未保存的表单不跨页面或重启保留。主要边界分别在 `src/plugin-probe-manager.mjs`、`src/plugin-edit-session-manager.mjs`、`src/plugin-validation-runtime.mjs` 和 `src/credential-use-resolver.mjs`。

应用管理的秘密由 `src/plugin-credential-vault.mjs` 配合 Electron `safeStorage` / Windows DPAPI 加密，不写入工作区 YAML、运维说明、日志或 MCP 结果。配置与凭据提交由 `src/plugin-config-transaction.mjs` 协调，工作区变更由 `src/workspace-mutation-coordinator.mjs` 协调。旧凭据不可读时必须保留原密文；不能用空值覆盖它来掩盖错误。

## 安全契约

- Agent 必须先通过 `open_environment` 获取当前环境的短期上下文。`src/context-manager.mjs` 校验精确的项目、环境、插件与状态；配置和相关安全状态变化会使旧上下文失效。
- `src/operation-gate.mjs` 与 `src/confirmation-manager.mjs` 决定能力是否允许。未知或无法分类的操作拒绝，不能由 Agent 声明风险等级来自行放行。
- Server 普通文件、目录、日志、状态读取和下载有界自动允许，可以使用绝对路径。运维说明和 `resourceHints` 用于导航，不是文件读取白名单；`sourceId/fileId` 是仍有调用方的兼容形式。
- 上传、写入、移动、删除和服务控制必须逐次确认；任意 Shell 必须强确认。一次性批准绑定作用域、能力与完整规范化参数。文件变更还绑定已实现的 stat/hash/目标状态前置条件；服务控制和 Shell 不快照实时远端状态。
- `src/server-operations.mjs`、`src/log-search.mjs` 和 `src/log-archive.mjs` 限制读取深度、数量、字节、并发和超时。不读取特殊文件，不遍历符号链接目录；归档搜索在内存中有界展开。
- `src/mysql-policy.mjs` 对固定数据库内单条 `SELECT` / `EXPLAIN SELECT` 作 fail-closed 校验；跨库、写入和不能确认安全的语法拒绝。Redis 访问限定在登记 pattern 内，不能执行任意命令或由 Agent 切库。
- 用户请求读取的远端文件、配置、日志、数据库行及命令输出可能包含未脱敏的敏感业务内容。它们是非可信数据，不是指令或授权；不能复制到仓库、测试夹具、日志或公开报告。应用管理的密码、私钥口令和 Token 始终不得返回给 Agent。
- Renderer 保持 sandbox、context isolation、禁用 Node integration 和显式 preload。样式 CSP 的限定例外见 [CSP 决策](shadcn-ui-radix-csp-decision.md)；非可信文本不得作为 HTML 执行。

## 仍在使用的兼容层

`src/project-store.mjs` 和 `src/credential-store.mjs` 仍参与旧项目和凭据迁移。`src/plugin-draft-store.mjs`、`src/plugin-draft-credential-vault.mjs`、`src/plugin-draft-promotion-journal.mjs` 仍用于恢复旧版本未完成的提交事务，当前 UI/API 不提供持久草稿功能。

启动必须先恢复配置与草稿提交事务，再进行旧项目和凭据迁移。不能只因文件名含 `legacy`、`draft` 或版本标识就删除这些路径，也不能在代码清理中删除用户的遗留数据或加密凭据。对应回归在 `test/credential-store.test.mjs`、`test/workspace-store.test.mjs`、`test/plugin-draft.test.mjs` 和 `test/backend-resilience.test.mjs`。

已移除的旧 MCP、旧 Renderer、旧连接管理器和持久草稿服务入口不应重建；包排除规则与缺失断言继续保留。它们防止退役入口被重新发布。

## 界面维护

活动界面使用 React、TypeScript、Tailwind CSS、shadcn/ui 和 Radix UI。业务功能按 `renderer/v2/src/features/` 分组，共用 `components/ui/`；共享类型位于 `renderer/v2/src/bridge/`，必须与 preload/IPC 合同保持一致。

长编辑任务位于详情工作区，短编辑和安全确认使用对话框。保持未保存修改保护、焦点恢复、对话框焦点约束和作用域切换后的过期响应隔离。导航栏折叠不重建列表或丢弃搜索；窄窗口和临时编辑布局不覆盖用户正常窗口下的持久化偏好。

主题偏好是本机 UI 状态，支持 `light`、`dark`、`system`，存储不可用或值非法时有安全回退。主题切换不新增 IPC、不影响业务连接；通知与页面使用同一实际主题。原生 Windows 标题栏不保证跟随手动主题。

### Resizable 依赖补丁

`react-resizable-panels@4.12.3` 的 Separator 把相邻两栏数组的局部索引用于整个 Group 的约束数组，导致第二处分隔线的 ARIA 最小值、最大值和当前值不一致。仓库保留 `patches/react-resizable-panels@4.12.3.patch`，只修复发布 ESM/CJS 中的索引表达式，改为按主栏 ID 查找全局约束索引，不改尺寸、键盘或持久化算法。

`pnpm-workspace.yaml` 登记精确版本与补丁路径，`pnpm-lock.yaml` 保存补丁哈希，`.gitattributes` 的 `/patches/*.patch text eol=lf` 保证 Windows 检出后哈希稳定。`test/renderer-resizable-aria.test.mjs` 校验补丁范围、安装结果和三/四栏索引；Electron foundation smoke 验证实际 ARIA、键盘方向、持久化和刷新。

升级或移除补丁前，需核对上游实现并复跑这些检查。不能通过伪造 ARIA 属性、跳过断言或改用无测试的分隔线消除失败。

## 稳定名称

| 用途 | 名称 |
| --- | --- |
| 仓库与包 | `runbook-bridge` |
| 安装产品 | `Agent运维工作台` |
| Electron 应用与窗口 | `AI 运维工具` |
| CLI | `ai-ops-mcp` |
| Codex MCP 别名 | `agent-ops` |
| MCP 协议 Server | `agent-ops-workbench` |
| 兼容数据目录 | `AIOpsTool` |
| Broker pipe 前缀 | `ai-ops-tool-*` |

这些名称属于不同集成层，不能作为清理顺带统一。更名必须设计安装升级、数据目录、MCP 注册与管道协调的兼容迁移，并具备相应回归。
