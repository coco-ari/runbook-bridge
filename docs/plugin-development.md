# 新增定制插件

插件是随应用构建发布的可信源码模块。它可以拥有独立的配置结构、协议操作、编辑器和工作区，不必复用 Server/MySQL/Redis 的表单。当前不支持下载第三方代码、运行时安装或热插拔。

## 后端接入

1. 在 `src/plugins/<type>/definition.mjs` 定义 `type`、`normalizeConfiguration`、`connectionFields`、`connectionNestedFields`、`connectionAdapter`、`publicResource`、`capabilities` 和 `invoke`，并加入 `src/plugins/builtins.mjs`。
2. 规范化函数接收输入、旧配置及公共元数据 `base`，明确白名单输出业务字段。不要整体展开输入，也不要接收密码、令牌、私钥等秘密。`base` 的作用域、实例 ID、版本不可由业务字段覆盖。`publicResource` 仅返回用于资源摘要的非敏感字段。
3. `connectionFields` 决定连接编辑允许修改的根字段和连接指纹，嵌套对象通过 `connectionNestedFields` 限定子字段。改变这些字段会使旧连接会话失效。`policy`、`sources`、`actions`、`patterns`、`limits` 是公共 Agent 配置根字段；新增另一类权限字段需要同步更新配置范围与变更分类，不能把它混入连接字段。
4. 在同目录的 `connection.mjs` 提供配置评估、资源范围、依赖引用、凭据身份、验证摘要、变更分类和临时验证方法。现有三个插件的连接适配器就是参考实现；`src/plugin-connection-adapters.mjs` 保留兼容门面。
5. 实现运行时的 `status`、`connect`、`disconnect`、`closeAll`，按需要提供 `health`、`forceDisconnect` 和专属操作。在 `src/main.mjs` 组合运行时，通过 `PluginManager` 的 `runtimes` 映射注入。`invoke` 收到当前插件、能力、参数、运行时和调用选项，由插件自己解释业务操作。

`src/plugin-config-model.mjs` 负责公共配置模型；`WorkspaceStore` 负责目录、索引、版本冲突与原子持久化。二者支持注册表注入，生产默认使用内置注册表。业务代码使用正式模型 API；`workspaceInternals` 仅作为既有测试兼容入口。

创建及编辑保存事务位于 `src/plugin-configuration-service.mjs`，复用环境变更队列、凭据事务日志、回滚、上下文失效和审计。IPC 负责受信 Renderer 与 owner 身份，再调用服务。保存成功后的重连失败必须返回已提交结果与运行时警告，不能让用户误以为配置未保存并反复提交。

## 需要单独设计的边界

注册业务贡献不等于完成所有安全集成，也不授予 Agent 权限。以下边界保留显式接入，不能用自动反射或通用执行器绕过：

| 能力 | 接入与审查位置 |
| --- | --- |
| 新协议凭据 | `src/plugin-credential-vault.mjs` 的秘密字段白名单与绑定投影，以及 `src/credential-use-resolver.mjs`；保留旧类型绑定兼容性，验证换目标、重绑定和失败回滚 |
| 临时连接验证 | `src/plugin-validation-runtime.mjs`、`src/plugin-probe-manager.mjs`；仅验证当前表单，禁止替换正式连接 |
| 新依赖或路由 | `src/environment-connection-manager.mjs`、`src/route-manager.mjs`；当前隧道语义仍限定同环境 Server |
| Agent 能力 | `src/operation-gate.mjs` 的独立默认拒绝规则、`src/v2-service.mjs` 的作用域与审批流程、相应协议策略 |
| 新 MCP 工具 | `src/mcp-tool-contract.mjs`、`src/mcp-v2.mjs`、服务分发、README 与打包 MCP 冒烟 |
| 专属桌面 API | 独立 IPC 模块、`src/preload.cjs`、`renderer/v2/src/bridge/ai-ops-v2.ts`，复用受信 frame 和 owner 校验 |

能力声明用于描述和业务分发；`OperationGate` 才是 Agent 授权边界。测试会比较内置能力声明与安全规则，并确认第四种已注册插件仍不能自动取得 Agent 权限。新能力需要明确参数规范化、只读边界或一次性确认、上下文失效和审计测试。

## 前端接入

在 `renderer/v2/src/features/plugins/plugin-catalog.ts` 登记读模型名称，在 `plugin-ui-contributions.tsx` 登记 `Editor`、`ConnectionPanel`、`AgentAccess`。可以提供三个独立组件；现有内置插件共用的 `PluginEditorWorkspace` 和 `PluginKind` 只负责现有三类表单，不要通过扩大这个枚举把定制协议强塞进旧表单。

编辑器遵守公共的成功回调、保存状态和离开保护约定，配置内容由插件负责。`PluginEditorHost` 选择贡献组件，`WorkspaceDetail` 选择连接与 Agent 面板，新增组件不需要修改 AppShell 中的类型分支。

需要专属工作区时，在自己的功能目录提供 `workspace-contribution.tsx`，加入 `workspace-contributions.ts`。贡献包括组件、可打开条件、会话身份、最大会话数、选择切换和断线保留策略、进入与退出焦点目标。会话身份必须覆盖完整项目/环境/实例范围和使内容失效的配置版本。

`use-plugin-workspaces.ts` 与 `workspace-registry.ts` 统一处理删除事件、断线序号、选择协调、会话数量与草稿保留。Server 可跨选择保留多个工作区；MySQL 断线时只保留编辑草稿并推进连接代次；Redis 断线释放内容，快速重连不能复用旧游标。插件组件通过 `onDirtyChange` 上报草稿状态，且负责自身的未保存内容保护与资源释放。

## 契约与验收

插件生命周期 IPC 通道集中在 `src/plugin-ipc-contract.mjs`。沙箱 preload 保持显式静态映射；`test/plugin-ipc-contract.test.mjs` 执行真实 preload，逐项核对处理器、通道及请求/响应透传。公共契约改动仍须同步桥接类型；编辑保存已有 `PluginEditSaveResult` 的明确类型。

扩展验收示例均只用虚构配置和临时目录：

- `test/plugin-registry.test.mjs`：第四种队列插件的定制配置、真实存储重载与更新、公共摘要、连接指纹、专属操作、未知操作和权限拒绝。
- `test/plugin-ui-registry.test.mjs`：第四种插件独立编辑器和面板的实际渲染。
- `test/plugin-workspace-registry.test.mjs`：作用域隔离、选择切换、快速断重连、草稿保留与连续打开去重。
- `test/plugin-configuration-service.test.mjs`：版本冲突、凭据意图、事务回滚及提交后重连失败。

新增插件需要自己的协议与策略测试，再运行 `corepack pnpm run check`、`corepack pnpm test` 和受影响的 UI 冒烟。MCP 或打包变化还需构建与三个打包验证命令，具体步骤见 [验证指南](full-function-verification.md)。不要连接真实基础设施进行回归，也不要把实际凭据、日志或客户运维说明写入测试。
