# UI 优化评估附录：导航、资源管理与辅助功能

评审日期：2026-10-01。范围：当前 `renderer/v2/src/` 的应用外壳、项目栏、环境与插件栏、详情区，以及 projects、environments、connections、plugins、runbooks、quick-questions、confirmations、audit、settings、cloud-config。本文是正式功能评估附录，保留优化前基线、确定方案和实施前的复审补充；实施结果及最终验证记录见 [主方案](ui-optimization-plan.md)。

## 证据与判断边界

开始评审时 `git status --short --branch` 为 `## main...origin/main`，工作树干净。本次读取源码、附近测试和官方产品文档，没有读取真实基础设施、应用凭据或业务数据。源码行号对应评审时的版本；除 `src/`、`test/` 外，源码路径相对 `renderer/v2/src/`，同一单元格仅写文件名时沿用前述功能目录。布局尺寸为拟改方案值，实施前后应通过模拟数据截图核对；现有用户保存的栏宽不应被覆盖。

分类：**必须修改**表示已证实的信息可信度或交互正确性问题；**值得修改**表示已有明确用户收益、可小范围落实的改进；**保留**表示现有设计与业务契约适配；**待验证**表示收益或代价尚未证实，不纳入确定实施清单。P0 优先处理确认内容可信度，P1 处理范围感知与核心导航，P2 处理密度、文案与局部效率。

本工具的中心任务是定位明确范围内的资源、连接并排查、审查 Agent 变更。当前“项目 → 环境 → 插件”架构成立，适合继续演进。已有可调三栏、全局搜索、快捷键、环境类型标识、独立工作区、会话保留、诊断、精确确认和操作时间线。成熟软件参考用于确定局部交互原则，不作为全面重绘或新增后台能力的理由。

## 官方参考及适用范围

| 参考 | 已核验的内容 | 本项目适用范围 |
| --- | --- | --- |
| [VS Code 用户界面](https://code.visualstudio.com/docs/editing/getting-started/userinterface) | 工作区布局、命令面板、快速定位、布局显隐 | 导航与工作内容的空间分配、入口可发现性；保留当前独立工作区 |
| [VS Code 面包屑](https://code.visualstudio.com/docs/editing/editingevolved#_breadcrumbs) | 路径定位及父级、同级导航 | 评估详情范围路径是否需要增加交互 |
| [DataGrip 连接与会话](https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html) | 连接配置与运行会话分开表达 | 配置完整、在线连接与工作区三种状态的文字区别；保持页面导航只读，连接由用户或 Agent 显式发起 |
| [IBM Carbon 按钮](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines) | 按钮层级、尺寸、图标语义与操作分组 | 页内主操作和辅助操作、少量图标统一 |
| [IBM Carbon 通知](https://carbondesignsystem.com/components/notification/usage/) | 状态语义、可处理错误、简洁通知 | 正常状态降噪、异常与处理入口突出 |
| [IBM Carbon 数据表](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) | 按内容与任务选择行密度、列表工具栏 | 项目状态、审计筛选、云项目列表的密度 |
| [IBM Carbon 文本输入](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines) | 只读、禁用、错误、加载状态的区别 | 插件名称及配置表单的可读性和状态说明 |
| [Red Hat PatternFly 资源树](https://www.patternfly.org/components/tree-view/design-guidelines/) | 展开、节点选择、图标、动作、紧凑层级展示 | 环境与插件栏的展开职责、视觉密度 |

## 各模块当前状态盘点

| 模块 | 正常状态 | 异常状态 | 加载状态 | 禁用与保护 | 主要证据 |
| --- | --- | --- | --- | --- | --- |
| 应用外壳与详情区 | 三栏、范围标题、状态、生产/测试徽标、按所选对象提供页签 | 工作区读取失败可重试；范围消失时拒绝继续导航 | 顶部“正在刷新”、概览骨架 | 草稿离开保护、窄窗折叠、隐藏视图 inert | `components/app-shell/AppShell.tsx:140,186,771,930,965`；`components/detail-workspace/WorkspaceDetail.tsx:443,464,536` |
| 项目栏 | 名称/描述搜索、拖动与键盘排序、右键和更多菜单、底部工具 | 隔离项目、读取失败并说明旧摘要 | 列表骨架 | 隔离项目不能扩大可执行范围；窄窗展开受限 | `components/project-rail/ProjectRail.tsx:299,362,419,458,523,628` |
| 环境与插件栏 | 多环境展开、插件类型图标、状态、当前范围连接动作 | 摘要刷新失败保留旧值并提示、分范围重试 | 环境摘要和插件骨架 | 连接动作要求已选择环境且详细数据已就绪 | `components/resource-pane/ResourcePane.tsx:265,352,402,424,437,699,768` |
| 项目概览与管理 | 数量摘要、环境状态、最近活动、创建/改名/删除 | 字段错误、隔离项目、最近活动失败 | 概览与活动骨架 | 删除要求输入完整项目名；繁忙时保护弹窗 | `features/projects/ProjectOverview.tsx:124,145,161,190`；`ProjectMutationSurfaces.tsx:173,245,274` |
| 环境详情与管理 | 连接摘要、插件列表、环境类型配置、排序 | 旧数据与读取失败提示；删除影响说明 | 详情骨架 | 删除资格判断、忙时锁定、范围限定 | `features/environments/EnvironmentOverview.tsx:34,43,71`；`EnvironmentMutationSurfaces.tsx:110,183,228,266,354` |
| 连接控制 | 环境批量和单插件连接/断开/重试、配置和工作区入口 | 诊断与下一步、依赖状态、主机指纹挑战 | 进行中图标与取消/重试状态 | 连接动作依状态计算；开工作区要求连接就绪或保留会话 | `features/connections/EnvironmentConnectionPanel.tsx:141,155,203`；`PluginConnectionPanel.tsx:241,247,269,287`；`ConnectionRowAction.tsx:122,130` |
| 插件配置与权限 | 分组表单、高级设置折叠、检查连接、TLS 探测、保存选项、能力策略表 | 字段错误、保存失败、验证失败、凭据迁移提示 | 准备骨架与验证进度 | 草稿保护、单插件事务、忙时 inert、主机指纹确认 | `features/plugins/PluginEditorWorkspace.tsx:394,409,675,746,755,790`；`PluginAgentAccess.tsx:197,214,285` |
| 运维说明 | 阅读/编辑切换、长度显示、保存/放弃、空态引导 | 超限、保存失败、修订冲突保留草稿 | 阅读骨架 | 未修改/超限/加载/保存期间禁用保存；放弃需确认 | `features/runbooks/RunbookFeature.tsx:101,209,225,277,289,338` |
| 快捷提问 | 问题输入、日期、最终复制内容预览、常见问题、通用开场词 | 敏感内容提示、复制失败、读取失败、修订冲突 | 两类资料分别骨架与刷新 | 敏感问题禁止保存，复制后台脱敏；编辑离开保护 | `features/quick-questions/QuickQuestionsFeature.tsx:673,705,720,780,806,828,863,930` |
| 操作确认 | 范围筛选、风险、参数、单次授权、过期计时、执行反馈 | 队列错误、过期、执行失败 | 队列骨架、刷新按钮 | 强确认勾选、繁忙按钮保护、当前精确范围 | `features/confirmations/ConfirmationsFeature.tsx:514,533,560,568,576,638,720,747` |
| 操作记录 | 搜索、参与方/类型/结果/时间筛选、时间线、分页、更新提示 | 读取失败、无匹配、未知结果说明 | 骨架与分页读取状态 | 清除需确认且严格按环境/插件范围；重复请求协调 | `features/audit/AuditFeature.tsx:75,105,196,207,220,227`；`AuditOperationList.tsx:18,41` |
| 应用设置与 Agent 接入 | 外观、接入、云同步、关于四项；接入状态与操作指引 | 打开仓库失败、接入失败及处理方式 | 接入检测、云数据加载 | 安装或云操作期间防止离开；恢复焦点 | `features/settings/SettingsPage.tsx:11,27,40,58,64`；`CodexIntegrationPanel.tsx:84,98,103,130` |
| 云同步 | 仓库选择、项目搜索/筛选、单项上传/更新、批量显隐、检测、历史和备份 | 仓库锁定、诊断、失败保留本地/备份、不可读备份计数 | 顶部读取、检测、历史和备份读取状态 | 覆盖计划和字段变化复核、受保护凭据、自选项目、版本恢复确认 | `features/cloud-config/CloudConfigPanel.tsx:58,79,84,87,95,103`；`CloudConfigProvider.tsx:146`；`CloudProjectManagement.tsx:43,60`；`CloudBackups.tsx:30` |

## 确定改进项

### N01 · 必须修改 · P0 · 长命令的“完整核对”必须成立

交叉复审补充：原私钥脱敏表达式从 BEGIN 吃到命令尾，闭合 END 后的普通命令也被隐藏；服务层会传完整原始命令，因此不能将这种展示声明为完整。只替换同标签闭合 PEM 块，保留其后的普通命令；仍未闭合的块继续保守隐藏到末尾，并禁止勾选/批准。完整性检查不暴露密钥，不改变批准参数。工作目录合法省略时始终显示“使用服务器默认工作目录（未指定）”，不推测具体 home 路径，便于核对默认语义。验收补闭合块加尾部、多个块、未闭合、END 标签不匹配及缺省目录。

- 证据：`features/confirmations/ConfirmationsFeature.tsx:124` 的 `safeText` 静默截取前 4,000 字符；`:229` 将结果标为“完整命令”；`:739` 要求勾选已核对完整命令。`src/server-operations.mjs:432` 接受至 16,384 字符，`src/v2-service.mjs:279` 提供原命令，`src/confirmation-manager.mjs:65` 保留展示元数据。使用纯合成 5,016 字符输入复核，显示 4,000 字符，末尾标记不可见。
- 用户影响与必要性：展示内容与授权内容不一致，用户可能无法审查尾部操作。属于已确认的确认可信度问题。
- 拟改方案：Shell 使用独立完整命令展示，保留现有敏感信息隐藏规则，按原有命令上限完整显示可审查内容；提供有界、可滚动、可键盘聚焦的代码区，并明确敏感片段已隐藏。其他普通摘要继续保持长度上限。需要截断时明确声明展示不完整并阻止进入“完整核对后授权”的路径。
- 验收：合成 4,001、5,016、16,384 字符命令尾部可见；敏感字段仍隐藏；展示文本不进入日志/快照；强确认、参数绑定和单次批准不变。增加有意义的长命令展示测试，复用 `test/renderer-confirmations-feature.test.mjs` 与 UI smoke。
- 参考：[IBM Carbon 文本输入的只读与状态说明](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines)。本项必要性来自本仓库数据契约。

### N02 · 值得修改 · P1 · 底部待确认入口明确当前环境范围

- 证据：`components/project-rail/ProjectRail.tsx:628,630,635` 将入口放在“全局工具”并称“操作确认中心”；`features/confirmations/confirmation-count-model.ts:18,24` 只计当前项目/环境；`components/app-shell/AppShell.tsx:761,785` 未选环境时只提示先选环境。
- 用户影响与必要性：用户可能把“0 项”当成全应用没有待确认操作。问题是范围表达，现有范围限制应保留。
- 拟改方案：展开状态写“当前环境待确认”，Tooltip/无障碍名称包含明确环境；无环境时显示“选择环境查看确认”，不宣称 0 项。折叠图标保留 ShieldWarning 和范围说明。沿用现有入口路由，不新建全局批准能力。
- 验收：未选环境、当前环境 0 项/多项、切换环境、过期、折叠栏均明确范围；不同环境请求不会进入当前批准路径。
- 参考：[IBM Carbon 通知](https://carbondesignsystem.com/components/notification/usage/)，参考状态信息与对应对象的明确关联。

### N03 · 必须修改 · P1 · 待确认读取失败不能显示确定的 0 项

交叉复审补充：确认页顶部数量和空态也必须遵守同一规则。首次读取失败不能同时显示成功色“0 项待处理”和“当前没有待确认操作”；应展示数量不可用、读取失败和重试。保留旧条目时明确“上次读取”；有效订阅恢复后清除队列读取错误。验收覆盖初读失败、旧记录保留与订阅恢复，不能只测底栏计数。

- 证据：`features/confirmations/use-confirmation-count.ts:39,49,53` 在 API 获取失败、结果失败或 Promise 拒绝时都返回 `count:0, loading:false`；状态类型 `:20` 未区分错误与空队列。
- 用户影响与必要性：失败和成功读取后的空状态无法区分，容易误认为没有待处理请求。该问题不涉及扩大读取范围。
- 拟改方案：在计数状态增加读取失败/未知状态，底部显示“待确认不可用”并在当前入口直接重新读取；确认页提供自己的读取失败说明、失败空态和“重新读取”按钮，未知筛选数量写“未知”。确认页保留同范围上次成功快照时注明“上次读取”，不借用上一环境计数。
- 验收：成功空队列显示 0；失败显示未知并可重试；恢复后显示实际数值；环境切换和订阅失效不串范围。
- 参考：[IBM Carbon 通知](https://carbondesignsystem.com/components/notification/usage/)，参考错误信息和下一步处理。

### N04 · 值得修改 · P1 · 让现有全局搜索被看见

- 证据：`components/app-shell/AppShell.tsx:144,1110` 仅传命令面板开关；`components/app-shell/GlobalCommand.tsx:76` 由 Ctrl/Cmd+K 打开。项目栏可见输入只搜索项目，见 `components/project-rail/ProjectRail.tsx:362,371`。
- 用户影响与必要性：鼠标用户不知道环境和插件也能快速搜索。能力已实现，补入口成本小。
- 拟改方案：在三栏导航上方设置明确的“搜索资源”按钮，显示平台快捷键；保留项目列表局部过滤。紧凑状态使用带 Tooltip 的 MagnifyingGlass 图标。按钮调用现有 GlobalCommand，延续关闭弹窗后导航与草稿保护。
- 验收：鼠标、键盘、项目栏折叠均可发现；搜索项目/环境/插件与部分读取失败提示正常；其他弹窗开启时不夺取焦点。
- 参考：[VS Code 命令面板](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_command-palette)。参考统一快速定位入口，不照搬命令全集。

### N05 · 值得修改 · P2 · 搜索结果沿用插件类型图标

- 证据：`components/app-shell/GlobalCommand.tsx:182` 的所有插件都用 Stack；`components/resource-pane/ResourcePane.tsx:88` 已区分 Server、MySQL、Redis 图标。
- 用户影响与必要性：同名资源搜索时视觉辨识弱，且与导航树语义不一致。
- 拟改方案：复用当前插件图标映射或已有注册贡献，不创建新图标库；项目 FolderSimple、环境 TreeStructure 保留，未知插件保留通用图标。
- 验收：三种已知插件和未知类型图标正确，显示名称、范围与键盘搜索语义不受影响；装饰图标对辅助技术隐藏。
- 参考：[Red Hat PatternFly 资源树的图标语义](https://www.patternfly.org/components/tree-view/design-guidelines/)。

### N06 · 值得修改 · P1 · 环境选择和展开插件分开

- 证据：`components/resource-pane/ResourcePane.tsx:265` 使用 AccordionTrigger；`:270` 隐藏展开箭头；`:275` 同一点击还切换环境详情。
- 用户影响与必要性：浏览另一环境插件时会同时切换详情，操作意图耦合。已有多展开与选中同步可保留。
- 拟改方案：给环境行独立可见的 CaretRight/CaretDown 展开按钮，名称负责选择环境；展开按钮使用准确 `aria-expanded`、`aria-controls` 和“展开/收起某环境”名称。使用现有展开状态协调，不重写整个资源模型。
- 验收：展开/收起不改变选中详情或触发远程连接；名称选择不隐式反转展开；插件定位仍自动揭示父级；展开时 `aria-controls` 指向实际内容，折叠时可按现有 Radix 契约省略该属性；键盘、菜单交接、排序与草稿导航通过既有测试。
- 参考：[Red Hat PatternFly 资源树](https://www.patternfly.org/components/tree-view/design-guidelines/)，参考独立展开控件和可选节点。

### N07 · 值得修改 · P1 · 配置完成数量与连接状态写清楚

- 证据：`components/resource-pane/ResourcePane.tsx:309` 显示“x/y 已就绪”；`features/projects/ProjectOverview.tsx:165,175` 列名“插件”对应裸 x/y，数值来自 `readyPluginCount`。同页面已另外显示运行连接状态。
- 用户影响与必要性：“就绪”容易被理解为在线，裸分数缺乏计数维度。
- 拟改方案：环境行写“配置完成 x/y”，项目表头写“配置完成”，窄布局也沿用该表达。连接状态继续用“已连接/未连接/部分可用”。数字、API 字段和状态判断不改。
- 验收：全部完成但未连接、部分配置、零插件三种样例能一眼区分；表格、窄列表、Tooltip 和辅助名称表达一致。
- 参考：[DataGrip 连接配置与运行会话](https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html)。

### N08 · 值得修改 · P1 · 正常插件详情减少重复状态

- 证据：`components/detail-workspace/WorkspaceDetail.tsx:448` 已显示运行状态；`features/connections/PluginConnectionPanel.tsx:104,241,242` 又显示“插件已连接”与“已连接”；`:313` 再显示配置完整；导航 `ResourcePane.tsx:495` 已提供配置状态。
- 用户影响与必要性：健康状态重复占据视线和高度，配置参数、工作区入口及真实异常反而不突出。
- 拟改方案：顶栏保留运行状态；连接卡固定标题“连接控制”，正常时用简短状态说明和动作行，移除同义徽标；配置完整时不追加绿色重复徽标，待完善/未知仍提示。异常、依赖、指纹挑战与恢复事项持续显著。连接中进度留在控制区，避免只看导航才知状态。
- 验收：连接正常、未连接、连接中、部分可用、错误、恢复未完成全部可辨认；没有移除异常说明或下一步；单插件详情健康信息高度下降且操作入口完整。
- 参考：[IBM Carbon 通知](https://carbondesignsystem.com/components/notification/usage/)，参考按必要性配置状态强调程度。

### N09 · 值得修改 · P1 · 新布局默认给详情更多空间

- 证据：`components/app-shell/AppShell.tsx:966,998,1029` 默认项目 224px、资源 32%、详情 48%；资源随窗宽增长，即使列表内容无需额外宽度也会占较大比例。
- 用户影响与必要性：三栏是管理视图，详情常有参数表、权限和审计，在中等屏幕上容易被导航挤压。现有独立工作区已经承担深度操作，不新增专注模式。
- 拟改方案：按主方案，新/无有效记录布局采用 224px 项目栏、320px 资源栏、其余给详情；320px 为核对现有类型、名称、状态和操作后选定的首轮实施值，仍须截图验收。窄窗继续执行现有最小值和项目折叠；已有有效布局原样恢复，拖动后仍保存用户栏宽。
- 验收：模拟数据在 1280、1400、1920px，以及现有窄窗边界无横向页面溢出；长名称可查看，状态/连接按钮不挤掉名称；用户保存与双击恢复行为正确。
- 参考：[VS Code 布局](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_basic-layout)，参考导航辅助工作内容的空间分配。本项目尺寸由截图验收决定。

#### N09 实施复审：窗口缩窄的临时折叠不能污染用户布局

- 实测证据（2026-10-01，METRICS 合成夹具）：第一次 800 CSS px 时项目/资源/详情实际宽度为 178.83/299.58/319.59px，详情 DOM 未折叠；第二轮 800px 时变为 178.20/571.80/48px，详情 DOM 已折叠，但保存的 `detailCollapsed` 仍为 `false`。保存比例从约 23.382/33.402/43.216 变为 31.315/63.675/5.01，已把 48px 临时折叠写入布局。恢复 1440px 后仍为 300/1090/48px；当前服务器选择与连接未变，返回后“继续工作区”入口因详情折叠而不存在。不是采样失败、连接许可改变或按钮命名问题。
- 原因与必要性：复审修复前 `components/app-shell/use-app-shell-layout.ts:118` 的详情尺寸回调在延迟 RAF 执行时才读取窗口宽度，且没有恢复期间的抑制保护；旧窄窗回调可以在宽窗提交折叠状态。修复前 `:139` 的布局回调也把所有宽窗的非用户尺寸调整写入稳定比例与保存记录。自动布局调整不代表用户选择了关闭详情；专业工作区缩放后失去返回入口违反本项已有“窄窗恢复、用户保存”验收，必须在 N09 原范围内修复。
- 最小方案：在原布局 hook 内区分用户保存偏好与实际临时折叠显示；只把真实拖动/键盘调整及显式折叠操作保存为用户意图。窗口变化与恢复期间统一隔离延迟尺寸回调，回调绑定产生时的窗口与恢复代次；恢复宽窗时按上次用户导航像素宽度与折叠偏好投影显示，明确展开原本未被用户折叠的详情。投影不重写保存百分比，避免面板临时最小宽度成为下次宽窗的导航宽度。用户显式折叠保持折叠，不由测试或恢复逻辑无条件展开。保留有效已保存百分比、224/320px 新默认值、编辑器临时展开与恢复语义，详情分隔线双击仍明确保存 48% 重置；不改采样或专业工作区连接。
- 验收补充：当前 METRICS 专项在浅/深色宽窄循环及 800→1440px 后，真实详情与同一服务器入口恢复可见、导航像素恢复到往返前的用户宽度；整个非用户缩放过程保存记录原样不变，暂停后重开仍恢复同一工作区。基础 UI 继续验证实际拖动、分隔线键盘调整、原生 Enter 手动项目/详情折叠及保存恢复；显式折叠后再缩窄/放大仍保持用户选择，原生双击详情分隔线保存展开偏好与 48% 比例。不能自动点击“展开详情”或放宽入口检查掩盖恢复缺陷。
- 编辑器边界：临时“拓宽编辑区”遇到窄窗自动折叠时，恢复宽窗仍恢复临时 70% 编辑区与项目折叠显示；若用户已明确折叠详情，则继续尊重该偏好。退出拓宽时恢复三栏显示，整个临时切换及缩放不改写用户保存记录。
- 恢复时序复测：指标专项进入宽窄循环前的既有文件栏测试，实际执行 1/1.25/1.5 倍缩放，再从 960 CSS px 恢复 1440px。2026-10-01 首次恢复诊断中，空保存记录下三栏先显示 350.23/500.36/587.41px，条件等待后仍停在 176/240/1022px，未恢复 224/320px；存储为空，排除了保存记录污染。面板库的 `setLayout` 使用上次采样的组尺寸和约束，后续 ResizeObserver 还会再次按像素投影。恢复必须在 React 约束更新、上一轮绘制与面板库尺寸采样之后再写显示比例；延迟解除抑制本身不足以保证恢复时序。采用受同一窗口与代次保护的后续帧恢复，继续用真实 224/320px 与不变保存记录验收，不强制测试布局或放宽最小宽度。

### N10 · 值得修改 · P2 · 资源导航压缩容器装饰，保留可操作面积

实施复审补充：仓库外合成截图 `optimized-all/scenario-environment-overview-dark-1280x820.png` 显示，用户保存的约 240px 资源栏中，选中环境的“部分可用”徽标与“重试”实际重叠，环境名称也被挤压。当前选择按钮继承公共 Button 的不收缩默认值，内部固定环境图标与状态徽标占宽；“部分可用”文字还超出徽标 72px 上限。仅检查按钮外框不重叠不足以覆盖内部内容溢出。这是现有 N10 的窄栏裁剪验收缺口，不调整已保存布局或新增功能。修复限定资源栏 CSS：选择区域明确可收缩并约束子内容边界；资源栏窄于 280px 时隐藏重复的通用环境图标，运行状态使用现有可辨认形状与完整 Tooltip/辅助文字，较宽时恢复完整状态文字；生产/测试文字徽标继续保留 12px 字号。保持环境行约 48px、独立展开 32px、实际动作 28px。验收须覆盖约 240px 保存布局、生产/测试、部分可用/连接中/失败，以及状态实际文字边界与相邻动作区域；不得只用外框几何或加大默认宽度掩盖重叠。

- 证据：`components/resource-pane/ResourcePane.tsx:245` 每环境独立带圆角边框，`:268` 环境头最小 56px，`:446` 插件行最小 48px，`:476` 每个图标又有独立边框底色。
- 用户影响与必要性：层级用容器和图标外框重复表达，多个环境时需要更多滚动。
- 拟改方案：保留现有卡片/Accordion 结构，仅减弱环境容器边框、收小外间距；环境头约 48px、插件行约 40px，图标去除重复外框并保留类型图形。名称主信息、配置次信息、状态和当前范围动作仍保留。沿用现有 28/32px 按钮点击区域。
- 验收：默认窗高可见资源行增加；长名称、警告状态、连接中、两类读取失败均不裁剪；环境边界通过名称、缩进和间距仍清晰；键盘焦点可见。
- 参考：[Red Hat PatternFly 紧凑资源树](https://www.patternfly.org/components/tree-view/design-guidelines/)、[IBM Carbon 行密度](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)。

### N11 · 值得修改 · P1 · 生产/测试标识覆盖环境导航与连接编辑

- 证据：`components/detail-workspace/WorkspaceDetail.tsx:449` 和项目概览 `ProjectOverview.tsx:173` 已有 EnvironmentTypeBadge；环境导航头 `ResourcePane.tsx:298` 与编辑范围头 `PluginEditorWorkspace.tsx:369` 仅给名称，编辑视图替换了正常详情头。
- 用户影响与必要性：名称并非总包含生产/测试；选资源和修改连接时也需要相同环境身份提示。
- 拟改方案：复用 EnvironmentTypeBadge，在环境导航的名称附近及插件连接编辑范围头显示已有类型；未标注保持现有无徽标行为，绝不从名称猜类型。小栏宽可使用短文案“生产/测试”，Tooltip 和辅助名称给完整含义；状态色和环境类型色保持不同语义。
- 验收：生产、测试、未标注、长环境名和窄栏都能定位；编辑后回详情一致；环境类型数据范围不串项目。
- 参考：[IBM Carbon 通知的警告语义](https://carbondesignsystem.com/components/notification/usage/)。本项基于已存在的环境类型信息，不新增分级规则。

### N12 · 值得修改 · P2 · 插件编辑的健康状态减少无效标签

- 证据：`features/plugins/PluginEditorWorkspace.tsx:385` 干净草稿显示“独立编辑工作区”，修改后显示“未保存”。视图标题、返回与拓宽按钮已说明当前操作。
- 用户影响与必要性：“独立编辑工作区”表达实现结构，未帮助判断是否需要保存。
- 拟改方案：只保留“未保存”草稿提示，干净时不显示该徽标；保存/验证中继续显示实际进行中状态。标题、范围、编辑说明及关闭保护保留。
- 验收：进入编辑、修改、保存、失败、取消后徽标与脏状态一致；关闭和切换不会丢失草稿。
- 参考：[IBM Carbon 通知](https://carbondesignsystem.com/components/notification/usage/)，参考聚焦用户当前状态。

### N13 · 值得修改 · P2 · 连接编辑中的名称用只读与可执行说明

- 证据：`features/plugins/PluginEditorWorkspace.tsx:437` 编辑时禁用名称，`:450` 解释为“名称属于独立元数据，不会混入连接配置编辑事务”；`features/plugins/PluginMetadataDialog.tsx:111` 已存在“修改插件名称”。
- 用户影响与必要性：禁用字段难以选择复制，说明告诉用户内部实现但没有给改名路径。
- 拟改方案：创建时继续可填；编辑时使用只读而非禁用，说明“名称在插件详情的更多操作中修改”，沿用现有独立改名事务，不把改名塞入连接保存。需要直接跳转时也沿用离开草稿保护。
- 验收：名称可读、可选择复制、编辑态不能修改；创建自动命名正常；没有新增混合事务或绕过草稿检查。
- 参考：[IBM Carbon 只读与禁用输入](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines)。

### N14 · 值得修改 · P2 · 运维说明文案表达协作结果

- 证据：`features/runbooks/RunbookFeature.tsx:267` 描述保存时使用配置修订号。
- 用户影响与必要性：修订号是内部机制，用户真正需要知道保存位置、冲突与草稿结果。
- 拟改方案：改为“说明保存在当前环境；保存前会检查是否已被其他窗口更新，避免覆盖新内容”。保留字节容量显示、冲突保留草稿和重新读取行为。
- 验收：当前范围说明准确，未出现扩大授权的暗示；原冲突、超限、放弃确认测试仍通过。
- 参考：[IBM Carbon 通知文案](https://carbondesignsystem.com/components/notification/usage/)，参考简洁表达状态及下一步。

### N15 · 值得修改 · P2 · 审计提供一次清空筛选

- 证据：`features/audit/AuditFeature.tsx:207` 提供搜索和四个筛选；只有刚确认操作模式 `:198` 有“查看全部记录”重置入口。普通组合筛选需要逐个恢复。
- 用户影响与必要性：查找后返回完整历史需要多次操作，易遗留筛选导致误认没有记录。
- 拟改方案：存在非默认条件时显示低强调“清空筛选”，重置查询、参与方、类型、结果、时间、聚焦请求，同时恢复 Redis 扫描为默认隐藏。筛选变化继续走现有请求协调和范围保护。
- 验收：组合条件、无匹配、聚焦请求、加载中、范围切换下重置正确；不展示其他环境历史；不会抢走输入焦点或发出陈旧结果。
- 参考：[IBM Carbon 数据表工具栏](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)。

### N16 · 值得修改 · P2 · 清除审计记录作为低频管理动作

- 证据：`features/audit/AuditFeature.tsx:201,202` 把刷新与清除放在同一主工具组，清除对审计阅读并非高频动作。
- 用户影响与必要性：管理动作与阅读动作同级，增加视觉和误触负担。现有二次确认成立。
- 拟改方案：刷新继续直达；清除移至带明确标签/Tooltip 的“操作记录管理”更多菜单，菜单中写“清除插件记录/清除环境记录”，确认对话框再明确当前范围和本机记录；保留已有确认对话框和忙时锁定，不改变后端能力。
- 验收：键盘可打开菜单、清除前能核对范围、取消保留记录、繁忙不能重复清除；不改变审计保留规则。
- 参考：[IBM Carbon 按钮分组与强调层级](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines)。

### N17 · 值得修改 · P2 · 云项目工具栏的批量显隐合并入口

- 证据：`features/cloud-config/CloudConfigPanel.tsx:87` 一行包含搜索、筛选、显示筛选结果、隐藏筛选结果、检测更新和更新整个仓库；两个显隐按钮常驻且文案较长，`:96` 各项目已有 Switch。
- 用户影响与必要性：常见搜索/检测/更新与低频批量显隐竞争空间，中等窗宽多次换行。
- 拟改方案：保留单项目 Switch；把“显示筛选结果/隐藏筛选结果”收进“批量显示”菜单，菜单文本包含本次筛选数量，禁用逻辑保留；搜索、筛选、检测与更新保持直接可达。
- 验收：所有/已显示/已隐藏/有更新/已删除筛选下数量与作用对象一致；0 项和已删除时明确禁用；批量显隐仅改变本机显示，不触发同步；宽窄工具栏无溢出。
- 参考：[IBM Carbon 按钮操作分组](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines)、[数据表工具栏](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)。

## 明确保留项

以下条目的验收目标是改进后持续成立，不安排无收益重绘。

| 编号与分类 | 来源 | 用户影响、必要性与方案 | 验收条件 | 合适官方参考 |
| --- | --- | --- | --- | --- |
| N18 · 保留 · 范围架构与按对象页签 | `components/detail-workspace/detail-navigation.ts:21,25,33,40`；`WorkspaceDetail.tsx:624` | 项目概览、环境说明、插件权限分工符合操作范围；继续按所选对象提供功能，未知类型默认保守 | 范围切换无串数据、未知插件没有越权能力、修改页签经过草稿保护 | [DataGrip 连接与会话](https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html) |
| N19 · 保留 · 可调布局、独立工作区与会话管理 | `components/app-shell/AppShell.tsx:965,1097`；`features/plugins/WorkspaceNavigation.tsx:43,67` | 已有拓宽、三栏恢复、独立操作区、已打开会话切换/关闭；足以支持深度工作 | 拖动与键盘分隔线可操作，返回恢复浏览位置；草稿/运行任务离开保护有效 | [VS Code 布局](https://code.visualstudio.com/docs/editing/getting-started/userinterface) |
| N20 · 保留 · 基础按钮尺度、焦点机制与图标系统 | `components/ui/button.tsx:10,21,59`；`styles/globals.css:277` | 28/32px 桌面控件、focus-visible、禁用原因和全局减弱动画已具备；沿用 Phosphor、状态形状和文字。焦点强度和缺口另按 D03 修复 | 模拟键盘、减弱动画、强制颜色、禁用原因均仍可用；不为每个文字按钮添加装饰图标 | [IBM Carbon 按钮](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines) |
| N21 · 保留 · 项目搜索与排序 | `components/project-rail/ProjectRail.tsx:362,419,523` | 名称/描述过滤、拖动和 Alt+上下排序满足日常定位；右键与更多菜单提供可发现的管理入口 | 无匹配、列表失败、隔离、排序失败和键盘排序都清晰；保留本机顺序语义 | [VS Code Explorer](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_explorer-view) |
| N22 · 保留 · 项目摘要与最近活动 | `features/projects/ProjectOverview.tsx:124,145,161,190`；`ProjectRecentActivity.tsx:102,133` | 少量数量摘要、环境列表与最近六项操作比空洞总览图表更实用；保留窄列表/宽表格 | 零环境、隔离、活动读取失败和旧值提示准确；不添加无任务依据的图表 | [IBM Carbon 数据表](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) |
| N23 · 保留 · 项目创建、改名与删除 | `features/projects/ProjectMutationSurfaces.tsx:173,245,274,334` | 字段、输入完整名称删除、云端删除关联和繁忙保护明确；保留现有对话框 | 错误靠近字段、关闭后恢复焦点、部分云删除失败不丢本地项目 | [IBM Carbon 文本输入](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines) |
| N24 · 保留 · 环境类型、改名、排序、删除评估 | `features/environments/EnvironmentMutationSurfaces.tsx:110,228,266,354` | 已提供生产/测试/未标注与删除影响；沿用元数据，不从名称猜环境类型 | 创建/设置显示一致；删除限制和排序失败有清晰结果；不改连接或授权范围 | [IBM Carbon 状态与警告](https://carbondesignsystem.com/components/notification/usage/) |
| N25 · 保留 · 连接控制、依赖与诊断 | `features/connections/EnvironmentConnectionPanel.tsx:155,203`；`EnvironmentPluginRow.tsx:29,35,38`；`ConnectionRowAction.tsx:122` | 名称看详情、连接按钮连资源、工作区按钮操作，职责清楚；保留依赖、重试和取消 | 连接/断开/取消/重试按实际状态计算；旧摘要标注；刷新不隐式连接；错误可处理 | [DataGrip 连接配置与会话](https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html) |
| N26 · 保留 · 服务器指纹确认 | `features/connections/RuntimeHostKeyDialog.tsx:158,171,177`；`HostKeyChallengeDescription.tsx:16,35` | 确认范围、指纹与可信渠道说明是实际授权信息，必要内容保留 | 长指纹不裁剪、键盘可复核、拒绝/信任/繁忙/失效均正确，信任不扩到其他目标 | [IBM Carbon 对风险的说明](https://carbondesignsystem.com/components/notification/usage/) |
| N27 · 保留 · 插件配置分组和高级连接折叠 | `features/plugins/PluginEditorWorkspace.tsx:410,499,675,688` | 主机、认证、数据库与高级路径分组适配不同插件；高级摘要让常用表单不拥挤 | 字段错误可定位；跳板/隧道/TLS 原行为不变；展开高级设置后没有隐藏必要字段 | [DataGrip 连接配置](https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html) |
| N28 · 保留 · 检查进度和保存后连接选项 | `features/plugins/PluginEditorWorkspace.tsx:746,765,790,823,840`；`PluginValidationProgress.tsx:53` | 检查、添加但不连接、保存并连接、保存并恢复各有明确副作用；分裂按钮比多个同级主按钮合理 | 检查可取消；选择结果准确；主机挑战、验证失败、恢复部分失败有反馈；保存不会隐式扩大连接范围 | [IBM Carbon 按钮分组](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines) |
| N29 · 保留 · Agent 能力边界与资源上限 | `features/plugins/PluginOverview.tsx:98`；`PluginAgentAccess.tsx:197,214,285,299` | 策略能力表配资源上限，可读/确认/拒绝分别表达；这些边界说明有助授权判断 | 用户不能从 UI 绕过固定数据库、Redis 模式和后端策略；错误与超时单位清楚；权限保存不主动连接 | [IBM Carbon 数据表](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) |
| N30 · 保留 · 凭据查看和旧凭据迁移的现有保护 | `features/plugins/StoredCredentialViewer.tsx:86,98,103`；`CredentialMigrationNotice.tsx:112,153` | 本机查看与重新绑定属于明确交互，持续独立于运维结果；保留范围说明和关闭清理 | 展示内容不复制进日志、审计、截图和文档；迁移需用户复核，失败无隐式重绑定 | [IBM Carbon 文本输入](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines) |
| N31 · 保留 · 运维说明纯文本、容量与冲突草稿 | `features/runbooks/RunbookFeature.tsx:209,269,297,323,338` | 当前文本阅读与编辑足以支持说明；冲突保留草稿与容量上限有实际价值 | 任意运维文字作为数据显示；冲突不覆盖草稿；超限无法保存，放弃需确认；长文可读可滚动 | [IBM Carbon 文本输入状态](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines) |
| N32 · 保留 · 快捷提问输入、日期、复制与完整预览 | `features/quick-questions/QuickQuestionsFeature.tsx:705,720,730,780,806` | 用户明确知道复制而非直接执行；可选日期、敏感提示、最终文本预览合理 | 敏感问题不能保存；后台最终脱敏；复制失败有处理方式；预览不包含应用凭据 | [IBM Carbon 按钮的具体动作表达](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines) |
| N33 · 保留 · 常见问题与通用开场词的范围区别 | `features/quick-questions/QuickQuestionsFeature.tsx:572,633,828,863,904,930` | 通用开场词与当前环境问题库已明确区分；追加而非覆盖有 Tooltip 说明，编辑/删除均显式 | 列表读取、空态、修订冲突、追加、删除确认与编辑离开保护通过；长问题可在预览复核 | [IBM Carbon 数据列表与操作](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) |
| N34 · 保留 · 精确单次确认与执行结果闭环 | `features/confirmations/ConfirmationsFeature.tsx:527,568,595,655,720,747` | 风险、参数、期限、拒绝、强确认和“已授权等待执行”是核心能力；完整命令缺陷由 N01 修正 | 参数集合/状态前置条件和一次性批准保持；过期不能执行；反馈可定位对应审计，不把授权当成功 | [IBM Carbon 状态通知](https://carbondesignsystem.com/components/notification/usage/) |
| N35 · 保留 · 审计搜索、服务端筛选、时间线与分页 | `features/audit/AuditFeature.tsx:105,141,212,224`；`AuditOperationList.tsx:18,41,51` | 已有全历史服务端筛选、聚合过程、更新提示和按需读取；大列表已有 content-visibility | 异常/无匹配/未知结果有区别；加载更多不重复；新记录不打断用户查旧记录；敏感内容不上界面摘要 | [IBM Carbon 数据表](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) |
| N36 · 保留 · 四类应用设置与主题 | `features/settings/SettingsPage.tsx:11,40,58,64` | 分类少且明确，暂不需要设置搜索或重做层级；主题即时生效、版本与兼容说明可用 | 忙时不丢操作；返回正确恢复焦点；浅/深/系统主题正确；关于版本来自包 metadata | [VS Code 配置界面](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_settings)，仅参考应用级设置边界 |
| N37 · 保留 · Agent 接入的状态优先和高级说明折叠 | `features/settings/CodexIntegrationPanel.tsx:84,98,103,115,130,139` | 首屏说明接入状态与下一步，修复与手动配置放后面；适配首次用户与故障用户 | 检测/安装/复制有真实状态，失败可处理；安装繁忙保护；配置片段不含应用管理凭据 | [IBM Carbon 状态与操作层级](https://carbondesignsystem.com/components/notification/usage/) |
| N38 · 保留 · 云仓库选择、解锁、单项目同步与状态 | `features/cloud-config/CloudConfigPanel.tsx:63,79,84,87,96,103,115`；`CloudProjectActions.tsx:36,38` | 仓库和本机/云端作用区别明确；搜索/状态筛选、方向明确按钮、锁定理由和解绑提示必要 | 未解锁不同步；检查不下载；显示切换不上传；解绑保留本地；密码/令牌不上评审截图 | [IBM Carbon 文本输入与状态](https://www.carbondesignsystem.com/building-blocks/core/components/text-input/guidelines) |
| N39 · 保留 · 云覆盖计划、字段变化、版本与本机备份 | `features/cloud-config/CloudConfigProvider.tsx:146`；`CloudFieldDiff.tsx:7,11,17`；`CloudProjectManagement.tsx:43,60`；`CloudBackups.tsx:30` | 已有覆盖复核、字段变化、敏感内容只提示变化、版本恢复、本机备份、不可读备份反馈，完整性较好 | 覆盖前自动备份；所选项目与计划绑定；字段省略明确；云恢复/本机恢复结果区分；未读取完全不假报空态 | [IBM Carbon 状态与可操作通知](https://carbondesignsystem.com/components/notification/usage/) |

## 待验证项目

| 编号与分类 | 来源与当前事实 | 用户影响与待验证必要性 | 验证/拟改方向 | 成立与验收条件 | 参考 |
| --- | --- | --- | --- | --- | --- |
| N40 · 待验证 · 工作区内全局搜索 | `components/app-shell/AppShell.tsx:1101` 在独立工作区禁用 GlobalCommand；已有 `features/plugins/WorkspaceNavigation.tsx:67` 会话切换器 | 跳转便利可能受影响，但终端/SQL 编辑器可能使用同一快捷键，导航还涉及草稿与任务保护；不能直接移除 disabled | 检查 Server/MySQL/Redis 的快捷键和 leave guard，再决定可见导航入口或不同快捷键；先落实 N04 | 切换不关闭会话、不丢草稿、不干扰终端编辑和事务；未通过之前不列确定优化 | [VS Code 快速定位与键盘访问](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_command-palette) |
| N41 · 待验证 · 资源筛选与密度设置 | `components/resource-pane/ResourcePane.tsx:765` 完整映射当前项目环境；`WorkspaceNavigation.tsx:45` 完整显示保留会话 | 大量资源才需要搜索/筛选/虚拟化和会话搜索；目前有全局搜索，不能推断普通项目难用 | 以 5/20/100 环境、各 3/10 插件模拟测耗时、滚动和定位；先落实局部降密度 N10 | 只有实际定位效率或性能不足才新增当前项目过滤/密度选项；不加入未经用户验证的复杂设置 | [Red Hat PatternFly 搜索资源树](https://www.patternfly.org/components/tree-view/design-guidelines/) |
| N42 · 待验证 · 可点击范围面包屑 | `components/detail-workspace/WorkspaceDetail.tsx:445` 当前路径为纯文字，已有两栏父级导航 | 能提高父级返回速度，但已有侧栏已能导航，收益需要比较；当前截断有完整 Tooltip | 验证常见“插件 → 环境”与长路径场景；必要时父级可点击并经过已有 requestNavigation | 支持键盘、长路径与草稿检查；点击不触发远程连接；实际减少回退步骤才实施 | [VS Code 面包屑](https://code.visualstudio.com/docs/editing/editingevolved#_breadcrumbs) |
| N43 · 待验证 · 运维说明格式化预览 | `features/runbooks/RunbookFeature.tsx:325,331` 当前使用纯文本 pre | Markdown 高亮、目录和对比可能方便长文，但格式需求未被证实，引入解析亦增加实现面 | 使用合成多级说明比较纯文本阅读与可选预览，先保留当前文本契约 | 需要真实格式需求；运维正文不执行 HTML/指令；无新生产依赖的必要性不能成立 | [VS Code 文档导航](https://code.visualstudio.com/docs/editing/editingevolved#_breadcrumbs)，仅参考长内容定位 |
| N44 · 待验证 · 审计保存筛选、导出与自选时间 | `features/audit/AuditFeature.tsx:215` 已有全部/24小时/7天/30天 | 属于扩展功能，不是既有设计缺陷；默认排查已覆盖多数情形 | 收集实际复盘/交接需要，优先验证 N15 清空筛选是否足够 | 明确范围、输出脱敏、历史完整性和文件权限契约后另列任务；本轮不把未实现扩展宣称成必需 | [IBM Carbon 数据表](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) |

## 分阶段实施输入

第一阶段确定且适合小范围实施：N01、N02、N03、N04、N05、N06、N07、N08、N11、N12、N13、N14。优先确认内容与计数可信度，再处理导航意图、可发现入口和重复状态。每项保持现有桥接契约、授权范围、离开草稿保护和真实错误语义。

第二阶段布局和列表体验：N09、N10、N15、N16、N17。需使用统一合成数据覆盖宽窄窗、正常/异常/加载/禁用状态；截图确认后再固定具体宽度和行高。N40–N44 先验证必要性，未成立不实施。

确定项不需要架构大重写、新图标库、生产依赖或数据迁移。颜色继续由现有语义令牌控制：primary 表示主操作/选择，success 表示执行或连接成功，warning 表示风险/生产类型/受限，danger 表示失败或破坏性确认。环境类型必须附文字，不让颜色独自承担意义。健康信息降低重复强调，真实风险、错误和下一步保持清晰。

验证入口：针对所改模块运行相应 `test/renderer-*.test.mjs`，随后 `corepack pnpm run check`、`corepack pnpm test`、`corepack pnpm run test:ui:all`。文档单独更新时执行 `git diff --check` 并核对引用路径与命令；实施状态及最终实测结果统一记录在主方案。
