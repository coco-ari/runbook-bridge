# 弹层专项治理：评估、设计与验证

日期：2026-08-30。状态：本轮已完成；重构、全量测试、深浅双主题 Electron 和新 Windows 安装包验证均通过。

## 1. 范围与现状

本次在已完成的 React + shadcn/ui + Radix UI 生产 Renderer 上继续工作，保留工作区已有修改，不重做迁移阶段。审计范围包含业务 Dialog/Sheet、AlertDialog、Command、Popover、菜单、Tooltip 和 Sonner，以及它们之间的焦点、草稿和异步操作交接。

三栏信息架构保持：项目 → 环境与插件 → 当前工作区。控件继续使用仓库内的 shadcn/Radix 组件；非弹层不是改回原生浏览器控件，也不是把 Dialog 简单设置为 `modal={false}`。

不修改 preload、IPC、Service、远程运行时、安全策略、正式生产入口、版本、产品名和 MCP 身份。不新增或升级依赖；验收发现 `react-resizable-panels@4.12.3` 的第二处分隔线 ARIA 上游索引缺陷，增加可审计 pnpm 补丁及锁文件记录，不等于依赖元数据零变更。测试只使用隔离目录和模拟数据。

重构前审计确认的主要问题（本轮已修复并完成双主题回归）：

- 插件新增/连接配置是长任务，却使用 680px 模态 Sheet，遮蔽项目和环境上下文。
- 项目/环境设置仅一个名称字段，却占据整高 Sheet；删除菜单还先进入设置，再叠加删除确认。
- 开场词和常见问题编辑与列表、复制预览紧密相关，当前 Dialog 打断反复编辑。
- 插件取消会话失败被转换为正常 resolve；非弹层导航不能把它误判为允许离开。拒绝编辑影响时也必须在取消成功后才清除 prepare token。
- 全局 dirty guard 尚未覆盖插件工作区与问题编辑；部分详情 Tab 切换直接更新状态。必须统一处理离开、忙态和草稿重置。
- 项目/环境提交成功由 controller 与 AppShell 各发布一次 Sonner，存在重复通知。

## 2. 逐项评估与设计决定

频率是依据任务性质作出的设计判断，不是遥测统计。判断顺序：是否需要长时间编辑/参照上下文 → 是否值得中断 → 风险和返回成本 → 最小合理承载方式。

| 入口/弹层 | 合理性评估 | 最终设计与理由 |
| --- | --- | --- |
| 新增项目 | 两字段、独立短任务；完成后选择新项目 | 保留紧凑 Dialog，创建前处理当前未保存工作；不占满第三栏 |
| 项目设置 | 一个名称字段不适合整高 Sheet | 改紧凑重命名 Dialog；保留当前第三栏上下文 |
| 删除项目 | 不可逆、有准确名称和范围确认 | 菜单直达独立 AlertDialog；不经过设置，不叠两层 |
| 新增环境 | 单字段，但必须明确所属项目 | 保留紧凑 Dialog，显示所属项目；提交仍绑定 revision |
| 环境设置 | 一个名称字段，Sheet 过重 | 改紧凑重命名 Dialog；删除从中分离 |
| 删除环境 | 有插件/连接等前置约束 | 独立 AlertDialog；展示限制，校验不通过不可提交 |
| 新增插件 | 类型、连接、认证、传输、TLS、验证形成长任务 | 第三栏独立编辑工作区，固定头尾、正文滚动，不使用 Portal/遮罩/focus trap |
| 编辑插件连接配置 | 需要环境上下文、编辑会话和恢复处理 | 与新增共用第三栏工作区；锁定进入时的 scope、plugin/revision 快照 |
| 插件名称修改 | 单字段，与连接编辑协议不同 | 保留短 Dialog；不启动连接编辑会话 |
| 删除插件 | 不可逆、可能影响依赖插件 | 保留 AlertDialog，准确显示范围和依赖，错误留场 |
| 编辑 Agent 开场词 | 最多 500 字、需对照预览，影响所有环境 | 改页面原位 Card + Field + Textarea 编辑，不使用 Dialog 或 Collapsible；明确全局影响，保存/取消/恢复默认在编辑区内 |
| 新增/编辑常见问题 | 最多 1200 字、频繁重复、需列表和预览 | 页面原位编辑；同一时间一个文本编辑任务，保留过期修订提示与草稿 |
| 删除常见问题 | 不可撤销的数据删除 | 保留独立 AlertDialog；不在提示或日志复制问题正文 |
| 日期选择 | 小范围、锚定字段的临时选择 | 保留 Popover + Calendar，选择后回到字段 |
| 操作记录清空 | 持久数据批量删除 | 保留 AlertDialog；范围准确，错误在确认内可见，提交中禁止重复关闭 |
| 操作确认中心 | 需要对照参数、有效期和影响范围 | 继续第三栏页面内审核，不额外增加通用确认弹窗；单次批准协议不变 |
| 插件编辑影响确认 | 开始编辑可能断开既有连接 | 保留 AlertDialog；只在实际存在影响时出现，拒绝必须安全取消 preparation |
| 编辑器 Host Key 信任 | 首次信任安全决策，必须明确响应 | 保留 AlertDialog，显示准确挑战，不自动信任 |
| 连接行 Host Key 信任 | 从第二栏连接触发的安全决策 | 保留 AlertDialog，与插件/环境连接页共用 RuntimeHostKeyDialog；失败在确认内留场，忙态禁止重入和关闭，空闲时 Escape 等价拒绝，关闭后回到触发入口；晚到挑战等待当前弹层关闭，多挑战按顺序显示 |
| 插件连接页 Host Key 信任 | 当前插件的明确安全决策 | 共用 RuntimeHostKeyDialog 的错误、忙态、拒绝与回焦合同；不改变挑战、revision 或审批绑定 |
| 环境连接页 Host Key 信任 | 环境连接中指定插件的安全决策 | 共用 RuntimeHostKeyDialog，仍绑定被挑战插件；不因起点不同降低校验或扩大范围 |
| TLS 降级重试 | 会降低传输保护，不能作为普通自动恢复 | 保留明确 AlertDialog；仅同意后修改草稿/重试 |
| 手动关闭 TLS | 虽只改变草稿，仍改变保护等级 | 保留简短明确确认，不以本次治理为由移除风险确认 |
| 强制替换凭据 | 会影响现有凭据绑定 | 保留 AlertDialog；精确参数和显式 force 合同不变 |
| 旧凭据重新绑定 | 需要确认已有密文属于当前作用域 | 保留 AlertDialog；不读取/展示明文，不扩大绑定范围 |
| 认证方式切换 | 本地草稿变化，不应无条件打断 | 无临时凭据时直接切换并显示字段说明；有临时凭据将被清除时保留短确认 |
| 放弃插件草稿 | 会丢失输入且须恢复会话 | 保留 AlertDialog；取消会话失败留在工作区并允许重试，不先卸载 |
| 放弃 Runbook/Agent/问题草稿 | 用户切换任务导致不可恢复输入丢失 | 共用准确命名的 dirty guard；保存中阻止导航，确认后实际清除草稿 |
| Ctrl+K 全局命令 | 临时跨区定位，不是业务编辑页 | 保留 CommandDialog；其他模态活动时不抢焦点，关闭后再进入目标任务 |
| 项目/环境右键与更多菜单 | 短暂次级动作入口 | 保留 ContextMenu/DropdownMenu，只承载动作，不塞长表单 |
| 详情/保存策略菜单 | 当前对象的短选择 | 保留 DropdownMenu，保存策略不更名、不暗改默认连接行为 |
| Select 选项 | 字段选值，不是独立业务流程 | 保留 Radix Select；完整键盘/关闭焦点合同 |
| Tooltip | 辅助解释，不应变成长文阅读器 | 保留短提示；常见问题全文用原位预览，不放 1200 字 tooltip |
| Sonner | 短结果反馈适合非阻断提示 | 保留；项目/环境成功只发布一次；持续失败继续使用页面 Alert |
| Sidebar 小屏 Sheet | 共享组件的响应式能力，不是当前桌面业务表单 | 保留基础组件；本次目标三种窗口均使用三栏，不为删除弹层而删共享原语 |

## 3. 非弹层工作流合同

### 插件工作区

- 第三栏进入独立工作模式，不与浏览详情 Tabs 混在一起；头部有返回、准确项目/环境、创建/编辑标题和拓宽入口。
- 栏内使用 shadcn Field、Input、Select、Collapsible、Alert、ScrollArea、ButtonGroup。尺寸按第三栏容器宽度适配，不能以窗口宽度假定表单宽度。
- 保存默认仍为“添加/保存但不连接”；“并连接”“恢复原连接集合”只能明确选择。原校验、expectedRevision、确认、凭据处理协议不变。
- 项目/环境/插件切换、全局命令、进入另一编辑任务都必须经过同一导航保护。提交、准备、校验期间不能切走；脏草稿先确认，随后等待会话安全取消成功再导航。
- 工作模式保存 scope 和插件快照，不跟随后台列表对象刷新重启编辑。不把草稿、密钥或输入凭据写到 localStorage。
- 返回恢复原入口，已删除入口退回当前资源/详情标题；保存成功选择返回的准确插件。第三栏折叠只隐藏编辑器，不卸载或丢草稿。
- 编辑工作区没有模态焦点环，键盘可以到达前两栏；安全 AlertDialog 仍有 focus trap。Escape 优先关闭 Select/菜单/确认，不能静默丢草稿。

### 问题原位编辑

- 全局开场词和当前环境问题在各自原位置进入编辑态；保持上下文、字数和校验反馈。
- 一次只编辑一个文本任务，切换/取消未保存输入有明确保护；保存中禁止离开。
- 外部刷新保持草稿，不悄悄覆盖；revision 冲突仍要求重新确认，不静默覆盖他人修改。
- 与第三栏 Tab 和范围切换共用离开保护。问题正文、敏感内容和凭据不进入日志或截图夹具。

## 4. 精确实施文件清单

清单在实施前建立，运行中发现的必要修复按原因追加；下列文件不包含无关后端或生成目录修改。

### 生产 Renderer 源码

- `renderer/v2/src/components/ui/accordion.tsx`：最终插件截图发现环境列表新增项目后被首次测量高度裁切；移除内容容器的固定测量高度，只保留 Radix 展开/收起动画的测量变量。补动态增项后的内容边界回归，不改变环境折叠或导航合同。
- `renderer/v2/src/components/app-shell/AppShell.tsx`：工作模式、快照、导航保护、焦点、删除直达。项目/详情 Panel 的 `onResize` 保留 requestAnimationFrame；Group `onLayoutChanged` 的 RAF 实验未解决 RO 且影响栏宽持久化，已撤销，不属于最终采用方案。保留完整 ResizeObserver 和键盘栏宽持久化断言。
- `renderer/v2/src/components/app-shell/GlobalCommand.tsx`：模态互斥、命令关闭后执行。
- `renderer/v2/src/components/ui/command.tsx`：透传 Radix `onCloseAutoFocus`，在命令弹层真正结束后交接焦点/动作，避免定时器猜测动画时长。
- `renderer/v2/src/components/detail-workspace/WorkspaceDetail.tsx`：问题 dirty/saving 接线、Tab 保护接口。
- `renderer/v2/src/components/project-rail/ProjectRail.tsx`、`renderer/v2/src/components/resource-pane/ResourcePane.tsx`：最终业务测试发现更多菜单同步打开 Dialog 会竞争焦点和 `aria-hidden`；与详情菜单一样，在 Radix 关闭完成后交接任务。保持全部动作、范围与标签不变。
- 新增 `renderer/v2/src/hooks/use-menu-handoff.ts`：已由项目栏、资源栏和详情菜单共用；集中 Radix 关闭后执行与过期动作取消的合同，卸载、重开、scope/revision 变化或新浮层出现时不执行旧动作，不以定时器猜测关闭动画时长。
- 新增 `renderer/v2/src/hooks/use-busy-dialog-focus.ts`：在布局提交和 Portal 挂载时维持当前可见模态的忙态焦点，不用延迟回调抢占后续弹层。接入项目/环境各三个面板，以及插件名称、删除、旧凭据迁移、编辑安全确认、异步放弃草稿、公共 dirty guard、常见问题删除，共 13 处 Content；Runtime Host Key 与 Audit 保留各自对应的忙态处理，TLS/auth 同步本地确认不虚设 busy。
- 新增 `renderer/v2/src/components/detail-workspace/detail-work-mode.ts`：无凭据持久化的工作模式/范围合同。
- 新增 `renderer/v2/src/lib/workspace-focus.ts`：延迟焦点交接避让活动模态，防止旧工作区回调破坏安全确认的焦点环。
- `renderer/v2/src/features/plugins/PluginEditorSheet.tsx` 迁名为 `PluginEditorWorkspace.tsx`：第三栏表单、响应式固定头尾、离开确认、焦点；取消会话等操作错误放入固定 footer，避免长表单滚动后看不到失败原因。
- `renderer/v2/src/features/plugins/use-plugin-editor.ts`：明确取消成功/失败、保留失败重试 token/session、避免重复关闭。
- `renderer/v2/src/features/workspace/use-environment-plugins.ts`、`use-workspace-overview.ts`：回归测试发现保存后选择新插件时会读到刷新前快照；刷新请求同步标记 loading，成功读到准确范围后才落定选择，防止新建成功却退回环境页。
- `renderer/v2/src/features/environments/DirtyLeaveGuard.tsx`：问题草稿、错误留场和忙态。
- `renderer/v2/src/features/quick-questions/QuickQuestionsFeature.tsx`：原位开场词/问题编辑、表单反馈和草稿保护；全文 Tooltip 改短操作说明，删除成功后回焦幸存入口。
- `renderer/v2/src/features/projects/ProjectMutationSurfaces.tsx`、`renderer/v2/src/features/environments/EnvironmentMutationSurfaces.tsx`：紧凑重命名和独立删除。
- `renderer/v2/src/features/projects/use-project-mutations.ts`、`renderer/v2/src/features/environments/use-environment-mutations.ts`：移除重复成功通知，保留写入后刷新失败 warning。
- `renderer/v2/src/features/audit/AuditFeature.tsx`：保留清空确认，补齐失败/忙态的留场反馈；清空成功后不尝试停留在已禁用的清空按钮，回退至可用刷新入口或详情工作区。
- `renderer/v2/src/features/plugins/PluginEditorConfirmations.tsx`、`CredentialMigrationNotice.tsx`：只针对审计发现的确认忙态/错误留场问题调整，不能改变安全决策。
- `renderer/v2/src/features/plugins/PluginMetadataDialog.tsx`、`PluginDeleteDialog.tsx`：补齐菜单触发器消失后的焦点回退和提交防重入；保留短命名/危险删除的模态类型。
- 新增 `renderer/v2/src/features/connections/RuntimeHostKeyDialog.tsx`；接入三个组件拥有者 `ConnectionRowAction.tsx`、`PluginConnectionPanel.tsx`、`EnvironmentConnectionPanel.tsx`，覆盖四个实际入口：插件详情、环境详情、环境行、插件行。共用弹层内错误、忙态、拒绝/回焦表现；同文件以 MutationObserver 与同步 reservation 排队晚到/同时到达的挑战，等待已有弹层 Portal 关闭移除，不轮询、不猜动画时间；组件卸载或挑战替换时释放请求。不改 `use-connection-intent.ts`、挑战 ID/revision/plan 绑定或信任协议。
- `renderer/v2/src/features/connections/ConnectionRowAction.tsx`：压力诊断把剩余 ResizeObserver 错误前的最后尺寸回调定位到连接按钮 Tooltip 的 Floating/Popper 观察。改为受控 Tooltip，在 operation/challenge 期间立即卸载 Content，操作启动同步关闭并清掉旧打开态；保留 Trigger/Button DOM、aria-label 和回焦 ref，不改变连接意图与挑战协议。

### 测试、截图和文档

- `scripts/ui-react-foundation-smoke.cjs`：非模态新增入口、零变更、尺寸/键盘/安全基线；项目/环境短表单与受阻删除、菜单/命令关闭后交接和稳定 footer 回焦。
- `test/renderer-foundation-contract.test.mjs`：动态资源增项后 Accordion 不得继续使用首次测量的固定高度；动画仍使用 Radix 测量变量，并保持 fresh paint 后才读取几何的验证顺序。
- `scripts/ui-react-business-smoke.cjs`：短 Dialog、直达删除、问题原位编辑、revision/草稿/焦点/通知；Audit 清空失败留场、相同范围重试、忙态与成功回焦。双主题均通过 13 次精确 mutation 尝试。
- `scripts/ui-react-plugin-operations-smoke.cjs`：第三栏新增/编辑、精确 API 参数、取消失败留场、忙态拦截、返回/选择；Runtime Host Key 三个组件拥有者的四个实际入口，覆盖拒绝/信任失败/重试，单/双晚到挑战排队。原 65 次行为加 32 次 Tooltip 键盘交接已提升为无诊断插桩的默认 97 次精确回归，检查 idle Tooltip 可见、挑战期间 Content 为 0 且拒绝不信任；双主题正式运行均已通过。
- `test/renderer-app-shell-contract.test.mjs`、`renderer-plugin-feature-contract.test.mjs`、`renderer-plugin-operations-smoke-contract.test.mjs`、`renderer-business-smoke-contract.test.mjs`、`renderer-production-shell-contract.test.mjs`、`renderer-project-mutations.test.mjs`、`renderer-environment-mutations.test.mjs`、`renderer-quick-questions-feature.test.mjs`、`renderer-field-accessibility.test.mjs`、`renderer-audit-feature.test.mjs`：更新有意改变的承载方式，保留行为/安全断言。
- `test/ui-contract.test.mjs`：生产 Shell 使用新的工作区编辑器名称，保留 CSP/IPC/三栏合同。
- 新增 `test/renderer-workspace-mode.test.mjs`：工作模式 scope、取消结果、导航/草稿边界，以及菜单交接控制器关闭后执行、过期动作取消和多处接线合同；共享 busy 焦点的可见模态、顶部焦点边界和 13 处接线合同。
- `test/renderer-read-model-contract.test.mjs`：刷新同步失效和待选择目标不得由旧快照提前否定的合同。
- `test/renderer-connection-feature-contract.test.mjs`：Runtime Host Key 三个组件拥有者、四个实际入口共用保留型安全确认，同时保持精确审批和范围合同；执行独立协调器单测，覆盖同帧 reservation、关闭过渡、卸载/替换请求清理和观察器释放；新增连接行 Tooltip 在操作/挑战期间关闭并卸载内容、保留按钮与回焦合同；插件 smoke 补齐错误留场、拒绝/重试/回焦及真实 Portal 排队。
- 本文、`docs/shadcn-ui-surface-coverage.md`、`docs/shadcn-ui-full-migration-report.md`：最终结果、剩余合理弹层、截图/失败项。

### 验收发现的必要依赖补丁扩展

正式 Foundation 验证中，第一处分隔线按 RIGHT 从 16.244 变为 21.244 并成功持久化；第二处分隔线却报告 `aria-valuenow=25.773`、`aria-valuemin=32.767`、`aria-valuemax=23.543`。已定位 `react-resizable-panels@4.12.3` 的 Separator 把相邻两栏局部数组的首项索引（恒为 0）用于整个 Group 的约束数组，导致第二处分隔线 ARIA 范围错误。本次增加以下限定文件，不替换 shadcn Resizable、不自建原生 handle、不调整后端：

- `patches/react-resizable-panels@4.12.3.patch`：通过 `pnpm patch` 的仓库外临时目录生成，仅修复上游 ESM/CJS 两个分发文件对应索引，改为按当前主栏 ID 在 `derivedPanelConstraints` 全局数组查找。
- `pnpm-workspace.yaml`：在 `patchedDependencies` 登记精确版本与补丁路径；不新增包或升级版本。
- `pnpm-lock.yaml`：登记补丁哈希与解析结果，确保安装可复现。
- `.gitattributes`：增加 `/patches/*.patch text eol=lf`，防止 Windows checkout 转换换行后改变补丁哈希。
- `test/renderer-resizable-aria.test.mjs`：已新增三/四栏全局索引、ARIA 范围、补丁哈希/LF 规则与保留 shadcn 委托的回归，4/4 通过。

这是由真实键盘/ARIA 失败触发的最小范围扩展。补丁后双主题 Foundation 均通过两个分隔线的 ARIA、方向、持久化和 reload；专门回归 4/4，全量默认及显式串行均 512/512。Group `onLayoutChanged` RAF 实验已撤销，仅两个 Panel `onResize` 保留 RAF。

如实施发现必须增加其他源文件，先在此清单补充原因；不趁机变更其他后端文件。

## 5. 验证方案

1. 修改点的窄测试与 TypeScript 检查。
2. `corepack pnpm run check`、`corepack pnpm test`、`corepack pnpm run test:ui:all`。
3. 960×640、1280×820、1920×1080 深浅色工作区截图；检查表单/footer可达、无页面级横向溢出、可见范围和保留弹层焦点。
4. 证明 mock/fixture 范围内调用、无外部请求、CSP 与 preload API 基线不变；非模态不是扩大 API 能力。
5. `corepack pnpm run dist`、`node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"`、`node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"`、`node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"`。
6. `git diff --check`，确认没有生成物/敏感数据进入 diff，不把尚未运行的验证写成通过。

## 6. 设计依据

将长编辑任务放回工作区是结合本项目三栏结构作出的设计判断，不是 shadcn 对业务架构的强制规定。Dialog 本身会使背景不可交互；短任务与高风险响应适合模态，反复/长任务更适合页面流程。参考 [shadcn Radix Dialog](https://ui.shadcn.com/docs/components/radix/dialog)、[Radix Alert Dialog](https://www.radix-ui.com/primitives/docs/components/alert-dialog)、[Carbon Modal 使用指南](https://carbondesignsystem.com/components/modal/usage/)。

## 7. 实施和验证结果

### 7.1 已完成的重构

- 插件新增与连接配置编辑使用第三栏 `PluginEditorWorkspace`：固定头尾、栏内滚动、拓宽/恢复、折叠不卸载、快照范围、返回原入口和保存后选择准确插件。
- 开场词与常见问题使用 Card/Field 原位表单，不使用编辑 Dialog 或 Collapsible；字数限制、全局影响、修订冲突、脏草稿和保存中导航保护保留。
- 项目/环境设置改紧凑 Dialog，删除从设置分离为菜单直达 AlertDialog；删除不嵌套模态，成功反馈不重复。
- Runtime Host Key 由三个组件拥有者统一承载四个实际入口；错误在确认内可见，busy 时禁止重入和关闭，空闲 Escape 按拒绝处理。晚到和同帧挑战按顺序展示，不自动信任、不抢占已有模态。
- 菜单、Command、工作区与安全弹层使用统一关闭/回焦合同；保留模态提交后控件全 disabled 时，焦点仍留在当前对话框而不是 body。
- 常见问题全文保留在原位预览，不进入 Tooltip；问题删除、Audit 清空和资源刷新后均回到幸存可用入口。
- 动态 Accordion 不再持续固定首次测量高度；操作失败进入插件编辑器固定 footer。Resizable 上游索引补丁保持两个分隔线的真实 ARIA 与键盘行为。

这些结论对应下列已实际执行的路径；没有将每个 Node 合同分支都声称为独立 Electron E2E，覆盖限制见第 7.4 节。

### 7.2 当前验证结果

统一 Renderer：`index-DcdlPIOn.js` / `index-B74dzzo9.css`。双主题使用同一产物，无诊断插桩。

| 验证 | 结果 |
| --- | --- |
| `corepack pnpm run check` | PASS |
| `corepack pnpm test` | PASS：512/512、0 skip；打包后再次运行通过 |
| `corepack pnpm exec node --test --test-concurrency=1 test/*.test.mjs` | PASS：512/512，20,597 ms；参数位于文件列表前 |
| `corepack pnpm install --frozen-lockfile` | PASS：Already up to date；补丁 LF 属性通过 |
| Resizable 专门回归 | PASS：4/4，含三/四栏全局索引、补丁哈希、LF 与 shadcn 委托 |
| 深色/浅色 Foundation | 每主题 PASS：23 只读、0 mutation、0 外部请求、0 Renderer/window/a11y 错误 |
| 深色/浅色 Business | 每主题 PASS：13 次精确 mutation 尝试，0 禁止调用/外部请求/Renderer 错误 |
| 深色/浅色 Plugin | 每主题 PASS：97 次精确 scope-bound mutation，0 禁止调用/外部请求/Renderer 错误；32 次 Tooltip 键盘挑战全部通过 |
| 键盘、焦点、缩放与布局 | 双主题 PASS：两处分隔线 ARIA/方向/持久化/reload，模态初焦/忙态/回焦，125%/150% zoom、forced-colors、reduced-motion、无页面级横溢 |
| Windows dist | PASS：新生成 `Agent运维工作台 Setup 1.0.46.exe`，115,886,985 bytes |
| 包结构、packaged MCP、packaged UI | 全部PASS：1个JS/1个CSS、35个MCP工具/archive runtime、58项preload/空隔离工作区/0外部请求 |
| 文档/源码空白与生成物检查 | PASS；仅既有Git CRLF warning，无空白错误；生成目录无新增Git可见文件，安全后端diff为空 |

截图根目录：`C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final`。实际共 192 张：`dark` 和 `light` 各 96 张，每主题 Foundation 35、Business 33、Plugin 28。浅色生成于 18:30:42–18:38:37，深色生成于 18:39:10–18:42:48。

Foundation 包含三种 Shell 尺寸、20 张详情页、9 张合理保留弹层和3张第三栏插件新增；Business 覆盖短表单、冲突、删除取消、原位长文本和 Audit 失败；Plugin 覆盖新增、编辑、取消失败、保存菜单、四入口 Host Key 失败和强确认。Shell 宽屏为1680×980，编辑工作区宽屏为1920×1080，另外均覆盖960×640与1280×820。

已逐张目视每主题 Foundation/Business/Plugin 各18/13/12张，合计86张重点图；未发现阻塞性视觉问题，不把未打开的其余截图声称为人工审阅。

上一轮477/477与94张截图仅保留为迁移历史，本轮不使用旧 Sheet/编辑 Dialog 图片充当当前证据。

### 7.3 已解决问题与迭代记录

| 问题 | 修复及最终证据 |
| --- | --- |
| 回焦失效、菜单与 Dialog 争抢焦点、busy 后焦点落 body | 生命周期交接、逻辑目标解析、活动模态检查和共享 busy 焦点；双主题 F/B/G 通过 |
| 取消编辑失败却离开、新插件被旧列表快照取消选中 | 保留 session/token/草稿，失败留场；读取刷新同步失效并等待准确范围；双主题 G 通过 |
| 运行 Host Key 错误被背景遮住、晚到或同时到达挑战叠层 | 共用 RuntimeHostKeyDialog、DOM 观察加同步占位队列；四入口拒绝/失败/重试/回焦及单/双延迟挑战通过 |
| Accordion 动态内容裁切、缩窗后 footer 不可达 | 去除持续测量定高、继承根布局高度、错误固定在 footer；三尺寸及双主题截图/几何通过 |
| Tooltip 触发 ResizeObserver loop | 操作或挑战期间受控关闭并卸载 Content，保留原按钮/回焦目标；正式双主题 G97 无错误，不过滤 RO |
| 第二分隔线 ARIA min 大于 max | 精确 pnpm 补丁改全局索引；4/4 回归及双主题键盘/持久化通过 |
| smoke 同帧读取旧几何、blur/refocus 被 React 批处理 | 真实事件分帧、fresh paint 后采样，保留原断言；非生产代码规避，双主题正式运行通过 |

Node 迭代曾发生 SSH 瞬态 reconnecting 等待失败；隔离测试16/16通过，最新默认与真正串行均512/512通过。保留该间歇失败历史，未修改后端掩盖问题。早期508被误称串行的记录已纠正；最终串行只认上表参数位置正确的512结果。

### 7.4 覆盖限制与非阻断警告

- 新Windows安装包与包结构、packaged MCP/UI验证通过，但本轮没有重新执行安装/升级回归；上一轮安装升级结论仅作历史。
- 项目/环境删除的 Electron 路径只测试直接打开、受阻与取消，实际 delete API 禁止；不能把确认截图当作删除执行证明。
- 插件元数据/Agent 权限保存、插件删除、数据库发现、凭据迁移、TLS 等分支仍主要由 Node 合同覆盖。保留安全弹层并不代表每个分支都做过独立 mutation E2E。
- 所有测试使用 mock 和隔离目录，不连接真实基础设施，也不把业务敏感内容写入截图。
- Vite单chunk超过500 kB、默认Electron图标及duplicate dependency references警告保留；当前JS1,059.66 kB（gzip293.75）、CSS147.97 kB（gzip21.98），新包各项验证均通过。
