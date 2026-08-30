# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 主要用户是独立维护系统的个人开发者或运维人员。
- 他们在 Windows 桌面端管理运维作用域和连接，并通过 Codex 等 Agent 调查和处理系统问题。
- 最高频任务是故障排查，尤其是结合服务器日志、MySQL、Redis 等中间件证据定位问题。
- 项目部署是已确认的未来使用场景，当前版本尚未提供完整部署能力。

## Product Purpose

Agent运维工作台是一个面向个人运维的 Windows 本地工作台。它统一管理项目、环境、Server、MySQL、Redis、连接状态、运维说明和加密凭据，并通过本地 MCP 向 Codex 等 Agent 提供结构化、受控的运维能力。

产品成功意味着用户能够在一个明确的项目和环境作用域内，让 Agent 快速组合日志、服务器状态和数据库、中间件证据完成故障排查，同时不向 Agent 暴露凭据，也不放弃连接和危险变更的最终控制权。

未来方向是在相同的安全与确认边界内增加项目部署能力，并扩展 Server、MySQL、Redis 之外的插件类型；这些方向不代表当前已经交付。

## Positioning

让个人在不把凭据和最终控制权交给 Agent 的前提下，通过 Codex 安全操作 Server、MySQL 和 Redis。

这一定位由以下真实机制支撑：

- 以 `Project → Environment → Plugin` 组织运维上下文和资源边界。
- 通过本地 MCP 和桌面 Broker 协作，凭据仅由本地 Electron 主进程使用。
- 普通读取优先直接执行；上传、写入、移动、删除、服务控制和 Shell 等变更需要桌面端逐次确认。
- Agent 只能使用当前环境中已连接且获准的插件；未知或无法安全分类的操作默认拒绝。
- 环境运维说明提供长期稳定的导航和约束，但不是服务器文件读取白名单。

## Operating Context

典型工作流如下：

1. 用户在桌面应用中创建项目和环境。
2. 用户添加并验证 Server、MySQL 或 Redis 插件，在环境运维说明中维护服务职责、日志位置和操作约束。
3. 用户明确连接环境或目标插件；打开项目或切换页面不会自动联网。
4. 用户在 Codex 中描述排障目标，Agent 打开环境并获取最新的运维说明、插件目录、连接状态和短期上下文。
5. Agent 组合日志、系统状态、MySQL 和 Redis 等证据推进排查；安全读取直接执行，危险操作返回桌面确认中心。
6. 用户在桌面端核对目标和完整参数后允许或拒绝一次性操作，并通过操作记录复核结果。

桌面应用必须保持运行，本地 Named Pipe Broker 才接受 MCP 调用。产品数据和凭据保存在当前 Windows 用户的本地数据目录，不依赖云账号。界面以中文为主。快捷提问功能可将全局 Agent 开场词、当前项目、当前环境和业务问题组合后复制给 Agent。

## Capabilities and Constraints

- 当前内置插件为 Server、MySQL 和 Redis；未来可以扩展其他插件，但当前不提供第三方插件市场或动态安装。
- Server 支持有界的系统状态、服务、Journal、容器、文件、目录和日志读取，以及经过确认的文件变更、服务控制和 Shell。
- MySQL 插件固定连接一个数据库，只允许策略批准的单条 `SELECT` 或 `EXPLAIN SELECT`。
- Redis 插件固定一个 Logical DB，只允许登记 Key pattern 内的有界读取和 TTL 查询。
- 环境允许部分连接成功；某个资源失败不应阻断其他仍安全可用的独立资源。
- 用户必须主动建立首次连接。应用重启、从未连接或用户主动断开的环境不会被 Agent 自动连接。
- 凭据通过 Electron `safeStorage` 和 Windows DPAPI 本地加密，不写入工作区 YAML、运维说明、错误信息或审计日志，也不返回给 Agent。
- 确认绑定项目、环境、插件、能力、完整参数和相关目标状态，只能使用一次；确认后内容或状态变化必须重新确认。
- 远端读取有深度、数量、字节、并发和超时边界；不跟随符号链接目录，不读取设备、FIFO、Socket 等特殊文件。
- 当前产品是 Windows Electron 桌面应用；Impeccable 的平台分类使用 `web`，因为活动界面由 HTML、CSS 和原生 JavaScript 实现。
- Renderer 保持 Electron sandbox、context isolation、禁用 Node integration 和严格 CSP 等既有安全边界。
- 当前没有必须遵守的特定无障碍标准或已确认的特殊用户需求；这不取消已有键盘操作、焦点可见性和 reduced-motion 等基础质量要求。
- 项目部署是未来能力；在正式交付前不得把它描述为当前可用功能。

## Brand Commitments

- 中文是产品界面的长期主语言，核心术语保留为项目、环境、插件、Server、MySQL、Redis、运维说明、操作确认、操作记录和 Agent。
- 视觉定位是专业开发与运维工具：克制、高信息密度、适合长时间使用，让证据可读性、状态区分和操作边界优先于主题化表达；避免娱乐软件式的强隐喻、大片装饰色、夸张材质和无任务意义的动效。
- 不同集成层的稳定身份必须保留：仓库和包名 `runbook-bridge`、安装产品名 `Agent运维工作台`、Electron 应用和窗口名 `AI 运维工具`、CLI `ai-ops-mcp`、Codex MCP 别名 `agent-ops`、MCP Server 名 `agent-ops-workbench`、兼容数据目录 `AIOpsTool`。
- 产品文案应直接说明操作、作用域、风险、结果和修复方法，不把安全边界包装成模糊口号。
- 当前没有正式 Logo、专用字体或完整品牌资产；不得把内联图标或 `RB` 空状态字标描述为已经确认的品牌系统。

## Evidence on Hand

- 产品能力、安全模型、使用流程和本地数据说明：`README.md`。
- 产品身份、技术元数据、依赖和打包约束：`package.json` 与 `AGENTS.md`。
- 当前真实桌面界面、中文文案和交互状态：`renderer/v2/src/`；`renderer/v2/index.html` 是唯一源码入口，`renderer-build/v2/` 是自动生成并打包的生产产物。
- 已落地的系统边界与工作流设计：`docs/agent-ops-v1-technical-design.md` 和 `docs/plugin-data-source-architecture.md`。
- 行为、安全策略、凭据保护、MCP 合同和 Electron UI 回归证据：`test/*.test.mjs`、`scripts/ui-react-foundation-smoke.cjs` 与 `scripts/packaged-ui-smoke.cjs`。
- 当前没有已确认的客户案例、用户评价、使用指标、竞品比较、价格声明或正式品牌素材；未来设计和文案不得虚构这些证据。

## Product Principles

1. 人始终拥有首次连接和危险变更的最终控制权。
2. 故障排查应能快速组合日志、服务器、数据库和中间件证据，而不是迫使用户在多个工具间反复搬运上下文。
3. 凭据留在本机，Agent 只获得完成当前任务所需的结构化、短期能力。
4. 项目、环境和插件作用域必须精确；不确定、越界或无法安全分类的情况默认拒绝。
5. 新的部署能力和插件类型必须继承现有的确认、隔离、凭据和审计边界。
