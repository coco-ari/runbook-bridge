# shadcn/ui + Radix UI 界面覆盖与证据矩阵

审计日期：2026-08-30

适用仓库：`runbook-bridge`

关联文档：

- [完整迁移计划](./shadcn-ui-full-rewrite-plan.md)
- [阶段 0 基线](./shadcn-ui-phase-0-baseline.md)
- [全量迁移报告](./shadcn-ui-full-migration-report.md)
- [弹层专项治理](./shadcn-ui-overlay-governance.md)

## 1. 文档目的与证据规则

本文件回答四个不同问题，避免把“源码里有组件”“Node contract 通过”“Electron 真实点击通过”和“有截图”混为一个结论：

1. 每个正式业务界面由哪些 shadcn/ui + Radix UI primitive 组成。
2. 该界面是否只读、会触发变更、订阅事件，还是只修改本机界面状态。
3. 哪些路径已有 Node/Electron 验证，哪些仍只有源码合同。
4. 哪些页面与 overlay 已有深浅双主题稳定截图，哪些业务分支仍待独立 Electron mutation 证明。

本轮弹层治理已完成。正式入口切换与旧UI删除沿用上一轮结果，未重做迁移。本矩阵对应统一产物 `index-DcdlPIOn.js` / `index-B74dzzo9.css`：check、默认与显式串行512/512、冻结安装、深浅双主题F/B/G及新Windows包结构/MCP/UI验证均通过。旧477/477、94张截图不作为本轮证据。

### 1.1 Bridge 分类

| 标记 | 含义 |
| --- | --- |
| `R` | 只读 bridge 调用，不改变工作区或运行状态 |
| `M` | mutation、连接意图、编辑 session、确认或其他有状态操作 |
| `E` | preload 推送事件订阅 |
| `L` | 只写浏览器本地界面状态，例如栏宽、折叠、项目显示顺序 |
| `P` | 组件只消费父级已加载的 props/callback，本身不直接调用 bridge |

`P` 不代表没有数据合同；它表示 API 所有权位于上层 hook/controller，便于业务组件保持可测试和可组合。

### 1.2 测试与截图标记

| 标记 | 含义 |
| --- | --- |
| `F` | `scripts/ui-react-foundation-smoke.cjs`；正式 React 壳层与只读路径 |
| `B` | `scripts/ui-react-business-smoke.cjs`；低风险业务 mutation 主路径 |
| `G` | `scripts/ui-react-plugin-operations-smoke.cjs`；插件新增、编辑、连接与确认主路径 |
| `N:<文件>` | 对应 Node 状态模型、组件合同或 smoke 接线合同 |
| `V:<场景>` | 本轮 dark/light 页面截图，见第2节；只证明视觉状态 |
| `O:<场景>` | 本轮 dark/light 合理保留弹层截图；不自动证明 mutation 执行 |
| `待补证` | 没有独立 Electron 路径或独立最终截图；不等同于功能缺失 |

## 2. 本轮双主题视觉证据

根目录：`C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final`，下分 `dark` 和 `light`。目录实际共192张，每主题96张＝Foundation35＋Business33＋Plugin28，均由当前统一产物生成。

| 场景/标记 | 文件模式 | 尺寸 |
| --- | --- | --- |
| `V:shell` | `app-shell-{theme}-*.png` | 960×640、1280×820、1680×980 |
| `V:project/environment/environment-connection` | `scenario-{project-overview\|environment-overview\|environment-connection}-{theme}-*.png` | 960×640、1280×820 |
| `V:runbook/quick-questions/audit/confirmations` | `scenario-{runbook\|quick-questions\|audit\|confirmations}-{theme}-*.png` | 960×640、1280×820 |
| `V:plugin/plugin-connection/plugin-agent` | `scenario-{plugin-overview\|plugin-connection\|plugin-agent-access}-{theme}-*.png` | 960×640、1280×820 |
| `V:plugin-create` | `workspace-plugin-create-{theme}-*.png` | 960×640、1280×820、1920×1080 |
| 插件新增/编辑/取消失败 | `plugin-{new-plugin-*\|existing-plugin-editor-*\|cancel-failure-retains-draft}-{theme}-*.png` | 960×640、1280×820、1920×1080 |
| 开场词/问题原位编辑及冲突 | `business-quick-*-{theme}-{size}-{editor\|actions}.png` | 960×640、1280×820、1920×1080 |
| `O:global-command/date-picker/project/environment/plugin-unsaved` | `overlay-*-{theme}-1280x820.png` | 1280×820；共9张/主题 |
| 短表单/删除取消/Audit失败 | `business-{create-*,*-settings,*-delete-cancel,project-revision-conflict,quick-question-delete,audit-clear-error}-{theme}-1280x820.png` | 1280×820 |
| Host Key失败、保存菜单、强确认 | `plugin-{*-host-key-failure,*save-menu*,runtime-host-key-confirmation,strong-confirmation-*}-{theme}-1280x820.png` | 1280×820 |

实际逐张审阅每主题Foundation18、Business13、Plugin12张，共86张重点图；没有把192张全部声称为人工审阅。三尺寸编辑footer、长名称、错误留场、危险确认、按钮与范围均未发现阻塞性视觉问题。少数自然出现的Sonner不遮挡主要操作。

上一轮94张截图仅保留历史对照，目录见全量迁移报告第5节；旧插件/设置Sheet和长文本Dialog不充当本轮证据。

## 3. 壳层、导航与跨界面合同

| 正式界面/源码 | shadcn/Radix 组合 | Bridge 分类与 API | Node 证据 | Electron 证据 | 截图证据 |
| --- | --- | --- | --- | --- | --- |
| 生产入口、Provider、主题、Toast；`renderer/v2/src/main.tsx`、`app/providers.tsx` | TooltipProvider、Sonner、Alert；全局 token 由 Tailwind/CSS 提供 | `P`；入口不直接访问 bridge，feature hooks 从严格 bridge 取数 | `N:renderer-production-shell-contract.test.mjs`、`N:ui-contract.test.mjs` | `F` PASS（本轮双主题） | `V:shell` |
| 三栏壳层、折叠、两处分隔线、栏宽持久化；`components/app-shell/AppShell.tsx`、`patches/react-resizable-panels@4.12.3.patch` | ResizablePanelGroup、ResizablePanel、ResizableHandle；限定修复上游 Separator 全局索引 | `L`；布局持久化；详情数据来自 workspace hooks | `N:renderer-app-shell-contract.test.mjs`、`N:renderer-navigation-accessibility.test.mjs`；`N:renderer-resizable-aria.test.mjs` 4/4 | `F` 双主题PASS：两处分隔线ARIA/方向/持久化/reload | `V:shell`、`V:plugin-create`；双主题 |
| 项目栏、项目搜索、上下文菜单；`components/project-rail/ProjectRail.tsx` | Sidebar、ScrollArea、InputGroup、Tooltip、DropdownMenu、ContextMenu、Alert、Button、Badge、Empty、Kbd | `P`；项目数据/操作由上层传入；显示顺序为 `L`；读取失败保留已有摘要并原位重试 | `N:renderer-navigation-accessibility.test.mjs`、`N:renderer-project-mutations.test.mjs`、`N:renderer-read-model-contract.test.mjs` | `F` PASS（本轮双主题）：选择、roving focus、Command、新建入口 | `V:shell`、`V:project` |
| 环境与插件资源栏；`components/resource-pane/ResourcePane.tsx` | Accordion、ItemGroup/Item、ScrollArea、ContextMenu、DropdownMenu、Alert、Button、Badge、Skeleton、Empty | `P`；上层使用 `R:listPlugins/environmentStatus` 与 `E:onEnvironmentStatus/onWorkspaceChanged`；插件列表/运行状态错误按环境 scope 隔离，显示缓存来源并原位重试 | `N:renderer-navigation-accessibility.test.mjs`、`N:renderer-read-model-contract.test.mjs` | `F` PASS（本轮双主题）：环境/插件选择、状态订阅、折叠与焦点 | `V:shell`、`V:environment`、`V:plugin` |
| 全局搜索；`components/app-shell/GlobalCommand.tsx` | CommandDialog、CommandInput、CommandList、CommandGroup、CommandItem | `P`；只检索已加载模型 | `N:renderer-navigation-accessibility.test.mjs` | `F` PASS（本轮双主题）：Ctrl/Cmd+K、唯一结果、Escape 恢复 | `V:shell`；`O:global-command` |
| 详情标题栏、面包屑、功能导航；`components/detail-workspace/WorkspaceDetail.tsx` | Tabs、ScrollArea、DropdownMenu、Tooltip、Alert、Badge、Empty、Button | `P`；按选中 scope 组合 feature | `N:renderer-detail-navigation.test.mjs`、`N:renderer-field-accessibility.test.mjs`、`N:renderer-production-shell-contract.test.mjs` | `F` PASS（本轮双主题）：Radix Tabs 方向键合同、内容宽度对齐、前后溢出按钮、当前项自动显露和跨栏焦点 | 所有 `V:*` 详情场景 |
| 全局状态、加载、空态、错误与反馈 | Badge、Alert、Skeleton、Empty、Sonner、Button | `P/R/E`；项目、环境、插件和运行状态错误保持精确 scope；有缓存时继续显示上次成功摘要并标明来源，无缓存时显示明确错误和重试；稳定提示不复制敏感内容 | `N:renderer-app-shell-contract.test.mjs`、`N:renderer-read-model-contract.test.mjs`、各 feature contract | `F/B/G` 主路径 PASS（本轮双主题） | 由各 `V:*` 场景覆盖；瞬时 Toast 未单列截图 |

## 4. 项目与环境业务界面

| 正式界面/源码 | shadcn/Radix 组合 | Bridge 分类与 API | Node 证据 | Electron 证据 | 截图证据 |
| --- | --- | --- | --- | --- | --- |
| 项目概览；`features/projects/ProjectOverview.tsx` | Card、Table、Item、Alert、Badge、Button、Skeleton、Empty | `P`；消费 `R:workspaceOverview` 结果 | `N:renderer-read-model-contract.test.mjs` | `F` PASS（本轮双主题） | `V:project` |
| 项目近期活动；`features/projects/ProjectRecentActivity.tsx` | Card、Item、Alert、Badge、Button、Skeleton、Empty | `R:listAudit({ projectId })` | `N:renderer-audit-feature.test.mjs`、`N:renderer-read-model-contract.test.mjs` | `F` 仅覆盖项目页面集成；无独立 mutation | `V:project` |
| 新增项目；`features/projects/ProjectMutationSurfaces.tsx` | Dialog、Field、Input、Button、ScrollArea | `M:createProject` | `N:renderer-project-mutations.test.mjs`、`N:renderer-field-accessibility.test.mjs` | `B` PASS（本轮双主题）：精确 create payload | `O:create-project` |
| 项目设置/重命名/revision 冲突；同上 | 紧凑 Dialog、Field、Input、Alert、Button；删除独立 | `M:updateProject` | `N:renderer-project-mutations.test.mjs` | `B` 双主题PASS：重命名、revision冲突、精确payload、busy和回焦 | `O:project-settings`、`O:project-revision-conflict` |
| 项目显示顺序；`features/projects/ProjectOrderController.tsx` | 由项目栏 ContextMenu/DropdownMenu 触发 | `L`；不调用工作区 mutation | `N:renderer-project-mutations.test.mjs` | 无独立 E2E，待补证 | 待补证 |
| 删除项目；`features/projects/ProjectMutationSurfaces.tsx` | 菜单直达独立 AlertDialog、Alert、Button | `M:deleteProject` | `N:renderer-project-mutations.test.mjs` | `F/B` 双主题PASS：直达/取消且0 delete调用；实际删除mutation E2E仍待补证 | `O:delete-project`、`business-project-delete-cancel-*` |
| 环境概览；`features/environments/EnvironmentOverview.tsx` | Card、Table、Item、Alert、Badge、Button、Skeleton、Empty | `P`；消费 workspace/read model | `N:renderer-read-model-contract.test.mjs` | `F` PASS（本轮双主题） | `V:environment` |
| 新增环境；`features/environments/EnvironmentMutationSurfaces.tsx` | Dialog、Field、Input、Item、Button、ScrollArea | `M:createEnvironment` | `N:renderer-environment-mutations.test.mjs`、`N:renderer-field-accessibility.test.mjs` | `B` PASS（本轮双主题）：精确 create payload | `O:create-environment` |
| 环境设置/重命名/离开保护；同上及 `DirtyLeaveGuard.tsx` | 紧凑 Dialog、Field、Input、Alert、Button；dirty guard 使用 AlertDialog | `M:updateEnvironment`；未保存离开在确认前不发 mutation | `N:renderer-environment-mutations.test.mjs`、`N:renderer-workspace-mode.test.mjs` | `B` 双主题PASS：精确update、短Dialog和统一离开保护 | `O:environment-settings` |
| 环境排序；`features/environments/EnvironmentOrderController.tsx` | 由资源栏 ContextMenu/DropdownMenu 触发 | `M:reorderEnvironments` | `N:renderer-environment-mutations.test.mjs` | 无独立 E2E，待补证 | 待补证 |
| 删除环境；`features/environments/EnvironmentMutationSurfaces.tsx` | 菜单直达独立 AlertDialog、Alert、Button | `M:deleteEnvironment` | `N:renderer-environment-mutations.test.mjs` | `F/B` 双主题PASS：直达/受阻/取消且0 delete调用；实际删除mutation E2E仍待补证 | `O:environment-delete`、`business-environment-delete-cancel-*` |
| 环境连接详情；`features/connections/EnvironmentConnectionPanel.tsx`、`ConnectionRowAction.tsx` | Alert、AlertDialog、Item、Table、Button/ButtonGroup、Badge、Tooltip | `R:environmentStatus`；`M:requestConnectionIntent/confirmConnectionChallenge` | `N:renderer-connection-feature-contract.test.mjs` | `F` 只读视图及 `G` 环境详情/环境行的Host Key拒绝、信任失败/重试、回焦与范围绑定通过 | `V:environment-connection` |

## 5. 插件业务界面

| 正式界面/源码 | shadcn/Radix 组合 | Bridge 分类与 API | Node 证据 | Electron 证据 | 截图证据 |
| --- | --- | --- | --- | --- | --- |
| 插件概览与操作入口；`features/plugins/PluginOverview.tsx` | Card、Table、Alert、Badge、Button/ButtonGroup、DropdownMenu、Separator、Skeleton、Empty | `P`；操作由上层 callback 分发 | `N:renderer-plugin-feature-contract.test.mjs` | `F` PASS（本轮双主题） | `V:plugin` |
| 插件连接详情；`features/connections/PluginConnectionPanel.tsx`、`ConnectionRowAction.tsx` | Alert、AlertDialog、Item、Table、Button/ButtonGroup、Badge、Tooltip | `R:environmentStatus`；`M:requestConnectionIntent/confirmConnectionChallenge` | `N:renderer-connection-feature-contract.test.mjs` | `G` PASS（本轮双主题）：连接、断开、取消；scope-bound | `V:plugin-connection` |
| 插件元数据；`features/plugins/PluginMetadataDialog.tsx` | Dialog、Field、Input、Button | `M:updatePluginMetadata` | `N:renderer-plugin-feature-contract.test.mjs` | `G` 验证短Dialog与晚到Host Key互斥及取消；元数据保存mutation仍待补证 | 无独立元数据截图 |
| Agent 权限；`features/plugins/PluginAgentAccess.tsx` | Card、Table、Item、Field、Input、Button/ButtonGroup、Alert、Badge | `M:updatePluginAgentConfiguration` | `N:renderer-plugin-feature-contract.test.mjs`、`N:renderer-field-accessibility.test.mjs` | `F` 只读视图 PASS（本轮双主题）；保存 mutation 待补证 | `V:plugin-agent` |
| 新增插件；`features/plugins/PluginEditorWorkspace.tsx`、`use-plugin-editor.ts` | 第三栏非模态工作区；Field、Input、Select、Collapsible、ScrollArea、DropdownMenu、Progress、Button/ButtonGroup、Skeleton；安全决策用 AlertDialog | `M:createPlugin`；可能继续 `M:requestConnectionIntent` | `N:renderer-plugin-feature-contract.test.mjs`、`N:renderer-workspace-mode.test.mjs` | `G` 双主题PASS：Redis两种保存策略、非模态工作区、三尺寸、脏草稿与忙态导航 | `V:plugin-create`、`plugin-new-plugin-*` |
| 编辑插件基础 session；同上及 `components/detail-workspace/detail-work-mode.ts` | 第三栏非模态工作区、Field、Input、Select、Collapsible、ScrollArea；离开/影响确认用 AlertDialog | `R:credentialStatus`；`M:preparePluginConnectionEdit/beginPluginConnectionEdit/cancelPluginConnectionEdit` | `N:renderer-plugin-feature-contract.test.mjs`、`N:renderer-workspace-mode.test.mjs` | `G` 双主题PASS：三种Server策略、session取消失败留场/重试、折叠保留、返回和精确选择 | `plugin-existing-plugin-editor-{1\|2\|3}-*`、`plugin-cancel-failure-retains-draft-*` |
| Server/MySQL/Redis 专属字段、VPN Guard、Tunnel、TLS 字段 | 工作区内 Field、Input、Select、Collapsible、Alert、Badge | 通过插件 draft/session API；不绕过 credential/store 边界 | `N:renderer-plugin-feature-contract.test.mjs` | `G` Server/Redis主路径PASS；MySQL、VPN、Tunnel、TLS unsupported专属分支仍为Node合同 | Server/Redis工作区三尺寸双主题；其余专属分支待补证 |
| 验证、探测、进度与取消；`PluginValidationProgress.tsx`、`use-plugin-editor.ts` | Alert、Progress、Badge、Button | `M:validatePluginDraft/probePluginDraft/cancelPluginValidation/cancelPluginProbe`；`E:onPluginValidationProgress/onPluginProbeProgress` | `N:renderer-plugin-feature-contract.test.mjs` | `G` 覆盖保存前主流程；独立进度/取消状态未单独截图 | 待补证 |
| 数据库发现 | Select、Skeleton、Alert | `R:listPluginDatabases`，绑定当前 edit session/scope | `N:renderer-plugin-feature-contract.test.mjs` | 无独立 E2E，待补证 | 待补证 |
| Host Key、TLS 与编辑确认；`PluginEditorConfirmations.tsx`、`HostKeyChallengeDescription.tsx` | AlertDialog、Alert、Button | `M:confirmConnectionChallenge` 或 editor confirmation；保持一次性、精确 scope | `N:renderer-connection-feature-contract.test.mjs`、`N:renderer-plugin-feature-contract.test.mjs` | 编辑器内部Host Key/TLS安全分支为Node合同；运行连接Host Key的独立E2E见下一行 | 编辑器独立Host Key/TLS截图待补证 |
| 运行连接 Host Key；`RuntimeHostKeyDialog.tsx`，由 ConnectionRowAction、PluginConnectionPanel、EnvironmentConnectionPanel 三个组件拥有者共用，覆盖插件详情/环境详情/环境行/插件行四个实际入口 | AlertDialog、Alert、Button；错误留场、busy 防重入、空闲 Escape 拒绝、关闭回焦；晚到/同帧挑战以 DOM 观察与 reservation 排队 | `P`；依旧由原连接 controller 执行精确 challenge/revision/plan 的确认；排队本身不调用 API | `N:renderer-connection-feature-contract.test.mjs`；协调器行为与清理单测 | `G` 双主题PASS：四入口错误/忙态/拒绝/信任重试/回焦，单/双晚到挑战排队，32次Tooltip挑战 | 四张`plugin-*-host-key-failure-*`及`O:runtime-host-key-confirmation` |
| 凭据状态、显式替换与旧凭据迁移；`CredentialMigrationNotice.tsx`、editor | AlertDialog、Alert、Field、Input、Button | `R:credentialStatus`；`M:confirmCredentialMigration`；敏感值不进入工作区/日志/截图 | `N:renderer-plugin-feature-contract.test.mjs` | 无独立凭据 mutation E2E，待补证 | 待补证；不得用真实凭据生成截图 |
| 三种保存策略与编辑取消；editor | DropdownMenu、Button/ButtonGroup、AlertDialog | `M:savePluginConnectionEdit/cancelPluginConnectionEdit` | `N:renderer-plugin-feature-contract.test.mjs` | `G` PASS（本轮双主题）：保持断开、连接当前配置、恢复编辑前连接集 | `O:save-menu-connect-current`、`O:save-menu-restore-pre-edit-set` |
| 插件删除；`features/plugins/PluginDeleteDialog.tsx` | AlertDialog、Alert、ItemGroup/Item、ScrollArea | `M:deletePlugin` | `N:renderer-plugin-feature-contract.test.mjs` | 无删除 mutation E2E，待补证 | 待补证 |

## 6. Runbook、快捷提问、审计与确认

快捷提问日期字段使用正式 shadcn Date Picker 组合：Radix `Popover` 承载 `Calendar`，由 `react-day-picker` `^10.0.1` 与 `date-fns` `^4.4.0` 提供日历和日期处理；业务界面不再退回原生 `input[type=date]`。

| 正式界面/源码 | shadcn/Radix 组合 | Bridge 分类与 API | Node 证据 | Electron 证据 | 截图证据 |
| --- | --- | --- | --- | --- | --- |
| 环境 Runbook；`features/runbooks/RunbookFeature.tsx` | Textarea、Alert、Badge、Button/ButtonGroup、ScrollArea、Skeleton、Empty | `R:readRunbook/listEnvironments`；`M:saveRunbook`，绑定 revision | `N:renderer-runbook-feature.test.mjs` | `B` PASS（本轮双主题）：保存主路径；迟到读取/脏草稿/revision 冲突为 Node 合同 | `V:runbook`；页面内保存，无保存overlay |
| 快捷提问 opening 与列表；`features/quick-questions/QuickQuestionsFeature.tsx` | Card、Item、Field、Textarea、Tooltip、Skeleton、Empty；原位编辑不使用 Dialog/Collapsible | `R:getQuickQuestionOpening/listQuickQuestions`；`E:onWorkspaceChanged` | `N:renderer-quick-questions-feature.test.mjs` | `F/B` 双主题PASS：原位编辑、全局opening影响提示及修订冲突 | `V:quick-questions`、`business-quick-opening-*` |
| 快捷提问新增/编辑/删除/复制；同上 | Card/Field 原位表单、Textarea、Button/ButtonGroup；删除/放弃仍用 AlertDialog；日期用 Popover/Calendar | `M:saveQuickQuestionOpening/saveQuickQuestion/deleteQuickQuestion/copyQuickQuestion` | `N:renderer-quick-questions-feature.test.mjs`、`N:renderer-workspace-mode.test.mjs` | `B` 双主题PASS：原位新增/编辑/删除、dirty Tab/范围切换、忙态及revision草稿保留；copy独立E2E待补证 | `business-quick-question-{create\|edit}-*`原位表单及`business-quick-question-delete-*`确认 |
| Audit 列表、搜索与过滤；`features/audit/AuditFeature.tsx` | Table、ItemGroup/Item、InputGroup、Select、Button/ButtonGroup、Badge、ScrollArea、Skeleton、Empty | `R:listAudit` | `N:renderer-audit-feature.test.mjs` | `F` PASS（本轮双主题）：窄详情栏使用紧凑 Item 列表，容器达到 `@lg/audit` 后切换 Table | `V:audit`（960 紧凑/1280 表格） |
| Audit 清除；同上 | AlertDialog、Alert、Button；忙态禁止关闭，错误留场，成功回焦可用入口 | `M:clearAudit` | `N:renderer-audit-feature.test.mjs` | `B` 双主题PASS：精确范围失败/重试、忙态焦点/防重入及成功回焦 | `business-audit-clear-error-*`双主题 |
| 操作确认中心；`features/confirmations/ConfirmationsFeature.tsx` | Card、ItemGroup/Item、Table、Checkbox、ToggleGroup、Field、Button/ButtonGroup、Alert、Badge、ScrollArea、Skeleton、Empty | `R:listConfirmations`；`M:approveConfirmation/rejectConfirmation`；`E:onConfirmations/onWorkspaceChanged` | `N:renderer-confirmations-feature.test.mjs` | `G` PASS（本轮双主题）：标准/强确认 approve；参数在窄容器使用 Item 列表、宽容器使用 Table；拒绝/过期/跨 scope 为 Node 合同 | `V:confirmations`；`O:strong-confirmation-gated`、`O:strong-confirmation-ready` |
| 待确认数量与全局入口；`features/confirmations/use-confirmation-count.ts` | Badge、Button | `R:listConfirmations`；`E:onConfirmations` | `N:renderer-confirmations-feature.test.mjs` | `F` PASS（本轮双主题） | `V:shell`、`V:confirmations` |

## 7. 当前 Electron 与测试证据

### 7.1 实际执行范围

| Smoke | 双主题实际路径 | 每主题数量与边界 |
| --- | --- | --- |
| `F` | 壳层、只读详情、Command、短Dialog、dirty guard、键盘/缩放/主题/ARIA/持久化 | 23次只读，0 mutation、0外部请求、0 Renderer/window/a11y错误 |
| `B` | 项目create/update/conflict、环境create/update、Runbook保存、问题create/update/delete、opening保存冲突/重试、Audit清空失败/重试 | 13次精确mutation尝试，0禁止调用/外部请求/Renderer错误；项目/环境delete仅取消，实际API禁止 |
| `G` | 插件创建、三种编辑保存策略、会话失败恢复、连接/确认；四入口Host Key；晚到挑战；Tooltip交接 | 97次精确scope-bound mutation，0禁止调用/外部请求/Renderer错误，不记录凭据 |

`G` 的97次由41次插件/工作区/确认操作、21次Runtime Host Key治理调用、3次晚到挑战请求和32次Tooltip键盘挑战组成。Host Key确认仅在明确同意后发送，失败重试保持同一精确payload；拒绝/Escape不信任。截图数量不是调用数量。

### 7.2 全量验证与补丁

| 验证 | 结果 |
| --- | --- |
| `corepack pnpm run check` | PASS |
| `corepack pnpm test` | PASS：512/512、0 skip；打包后再次运行通过 |
| `corepack pnpm exec node --test --test-concurrency=1 test/*.test.mjs` | PASS：512/512，20,597 ms |
| `corepack pnpm install --frozen-lockfile` | PASS，补丁LF属性通过 |
| Resizable专门回归 | 4/4；精确ESM/CJS全局索引补丁、哈希/LF规则、保留shadcn委托 |
| 深浅双主题三层Electron | `F/B/G`全部PASS，使用同一JS/CSS，无诊断插桩 |
| Windows dist | PASS：新生成Setup1.0.46，115,886,985 bytes |
| 包结构 / packaged MCP/UI | 全部PASS：1个JS/1个CSS、35个MCP工具与archive、58项preload/空隔离工作区/0外部请求 |
| 空白、生成目录与安全后端 | diff check通过，仅既有CRLF warning；生成目录无新增Git可见文件，安全后端diff为空 |

`react-resizable-panels@4.12.3` 补丁只修Separator按主栏ID查找全局约束索引，未新增/升级依赖或改用原生handle；`pnpm-workspace.yaml`、`pnpm-lock.yaml`及`.gitattributes`保存可复现登记。双主题两个分隔线的ARIA、方向、持久化及reload均通过。Group `onLayoutChanged` RAF实验已撤销，仅Panel resize保留RAF。

### 7.3 历史记录与当前结果区分

上一轮477/477、94张截图及旧包验证只作为迁移历史。当前采用512测试与192张截图，不沿用旧Sheet/文本编辑Dialog图。迭代中SSH瞬态reconnecting曾失败；隔离16/16及最终默认/真正串行512/512通过，未修改后端。早期508被误称串行的记录已纠正；最终命令以参数在文件列表前的512运行结果为准。

焦点交接、晚到挑战、Accordion裁切、Tooltip ResizeObserver和分隔线ARIA问题已经修复并完成双主题回归。几何与blur/refocus夹具按真实事件帧采样，未过滤错误或放宽断言。

## 8. 58 API、静态扫描与安全边界

### 8.1 Bridge 合同

- `renderer/v2/src/bridge/ai-ops-v2.ts` 保持 58 项 `window.aiOps.v2` 的严格类型与同步合同。
- 当前业务界面只直接调用其所需子集；其余兼容 API 仍服务 preload/IPC 公共合同。某个 API 没有当前 UI 入口不等于迁移遗漏，不能为了“覆盖率”删除或重命名。
- 读、写、连接 intent、编辑 session、事件订阅分别由 feature hook/controller 拥有；视图组件通过 props/callback 消费，避免跨 scope 隐式调用。
- 项目、环境和插件 mutation 始终携带显式 scope/revision；确认、Host Key 和插件编辑保持一次性 token/session 边界。

### 8.2 静态扫描基线与复跑命令

本轮最终源码重新执行以下三条扫描，均为0匹配；`rg`退出码1是“无匹配”的正常结果：

```powershell
rg -n '<(button|input|select|textarea|dialog)\b' renderer/v2/src -g '!**/components/ui/**'
rg -n 'from ["''](?:@radix-ui|radix-ui)' renderer/v2/src -g '!**/components/ui/**'
rg -n 'dangerouslySetInnerHTML|\bfetch\s*\(|https?://' renderer/v2/src renderer/v2/index.html -g '!**/components/ui/**'
```

目标不变：业务源码不得直接使用原生交互控件，不得绕过 `components/ui` 直接导入 Radix，不得增加 `dangerouslySetInnerHTML`、Renderer `fetch()` 或远程 URL。本轮三项扫描已通过。

### 8.3 必须持续保持的安全边界

- `src/main.mjs`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- `renderer/v2/index.html`：`default-src 'self'`、`script-src 'self'`、`connect-src 'none'`；仅 `style-src` 为 Radix 定位保留已批准的 `'unsafe-inline'`。
- Renderer 只有 `renderer/v2/src/bridge/ai-ops-v2.ts` 访问 `window.aiOps.v2`；业务 feature 不直接使用 `ipcRenderer`、`contextBridge` 或 Node API。
- 凭据、Broker token、Host Key 敏感内容和解密值不得进入工作区文件、日志、错误、fixture、截图或报告。
- 三层 Electron smoke 使用隔离数据根与 mock；任何新增证据都必须继续证明 0 外部请求且不连接真实基础设施。
- UI 重构不得弱化连接 scope、确认绑定、短期环境 context、命令/MySQL 策略、审计或 fail-closed 行为。

## 9. 真实覆盖限制与非阻断警告

1. Windows打包及三项包验证已通过，但本轮未重新执行安装/升级回归；包结构/MCP/UI验证不等同于安装升级测试。
2. 项目/环境实际删除与排序、插件元数据/Agent权限保存、插件删除、Quick Question copy、数据库发现、凭据迁移和TLS等专属分支主要由Node合同覆盖。项目/环境删除的Electron路径只有直达、约束与取消；元数据Dialog有互斥/取消测试，但没有保存mutation证明。
3. 192张截图记录当前代表场景，不覆盖每个Toast、进度、异常或安全确认分支；人工重点审阅86张，不声称全部逐张审阅。
4. 三层smoke只使用mock和隔离目录，不连接真实基础设施。真实基础设施的端到端部署行为不在本次UI验收范围。
5. 58项preload API包含公共兼容方法，当前UI未直接调用不能作为删除合同的依据。
6. Vite单chunk超过500 kB为非阻断警告。当前JS1,059.66 kB（gzip293.75）、CSS147.97 kB（gzip21.98）；默认Electron图标和重复依赖引用警告保留，新包结构/MCP/UI均通过。
