# shadcn/ui 前端完整重构流程

> 状态：阶段 0–8 已完成；最终测试、双主题截图、打包和安装升级证据已写入[最终迁移报告](./shadcn-ui-full-migration-report.md)
>
> 适用范围：`renderer/v2/` 活跃桌面界面
>
> 最后更新：2026-08-30

## 1. 决策摘要

本次工作不是在现有 HTML/CSS/JavaScript 上逐个替换控件，而是完整重建 Electron Renderer。

目标技术栈为 React、TypeScript、Vite、Tailwind CSS 和 shadcn/ui。现有 Electron 主进程、preload、V2 IPC、Broker、存储、凭据、安全确认和插件运行时不因本次重构改变。

重构必须保留一个不可变的产品骨架：

```text
第一栏：项目
  └─ 可选择、可新增、可排序、可查看状态

第二栏：环境与插件
  ├─ 当前项目的环境列表
  ├─ 环境可选择、可新增
  └─ 环境内展示插件，插件可选择、可新增

第三栏：详情工作区
  ├─ 项目详情
  ├─ 环境详情
  ├─ 插件详情
  ├─ 配置与验证
  ├─ Agent 权限
  ├─ 运维说明
  ├─ 操作记录
  ├─ 快捷提问
  └─ 操作确认中心
```

除上述三栏信息架构、现有功能和安全边界外，页面内部结构、组件、样式、间距、视觉层级、状态组织和前端代码架构均允许重新设计。

## 2. 重构目标

### 2.1 产品目标

- 让用户始终知道当前处于哪个项目、环境和插件作用域。
- 让项目、环境和插件的新增、选择、状态识别和进入详情保持直接、稳定。
- 让连接、验证、保存、删除和危险确认的结果清晰可见。
- 在 960×640 的最小窗口内仍能完成核心操作，在常用桌面尺寸下保持高信息密度。
- 保持中文为主的专业开发与运维工具表达。
- 为未来增加插件类型和部署能力保留清晰的扩展位置，但不提前实现尚未交付的功能。

### 2.2 工程目标

- 用组件树和明确的状态模型替代集中式 DOM 查询、字符串模板和全局事件委托。
- 用语义化设计 token 和组件变体替代持续追加的 CSS 覆盖规则。
- 将页面导航状态、服务端数据状态、表单草稿状态和短暂交互状态分开管理。
- 保持 `window.aiOps.v2` 为 Renderer 唯一受信任的应用 API 边界。
- 保持 Electron `sandbox`、`contextIsolation`、禁用 Node integration 和脚本严格 CSP；样式按 `docs/shadcn-ui-radix-csp-decision.md` 允许 shadcn/Radix 运行时内联样式。
- 建立可以按用户行为测试的新 UI 契约，降低对具体 DOM 字符串和 CSS 选择器的依赖。

### 2.3 非目标

- 不重写 Electron 主进程、Broker、MCP 或插件运行时。
- 不修改 Project → Environment → Plugin 持久化模型。
- 不扩大 Agent 权限，不改变连接、确认、凭据和审计语义。
- 不增加第三方插件市场、部署功能或当前没有的产品能力。
- 不把工作台做成数据库 IDE、监控大屏或通用终端。
- 不照搬 shadcn/ui 示例站、普通 SaaS 后台模板或大面积卡片布局。

## 3. 不可变产品契约

### 3.1 第一栏：项目栏

第一栏永久表达最高层级的项目作用域。

必须保留：

- 显示项目列表。
- 点击项目后切换当前项目，并清理或更新下游环境、插件和详情选择。
- 新增项目入口。
- 项目连接状态或健康状态的可识别反馈。
- 项目排序，包括现有键盘排序能力；具体拖放视觉可以重做。
- 当前项目的明确选中态。
- 可折叠或调整宽度的桌面能力；具体交互可以重做。
- 全局操作确认入口及待确认数量。

允许改变：

- 项目行布局、图标、状态表达、展开动画和宽度。
- 新增按钮和项目管理入口的位置。
- 项目名称、摘要和状态的排版方式。
- 是否使用 shadcn/ui Sidebar 作为基础，只要最终支持当前双侧栏结构。

### 3.2 第二栏：环境与插件栏

第二栏永久表达当前项目下的资源层级。

必须保留：

- 显示当前项目的环境列表。
- 点击环境后在第三栏打开环境详情。
- 新增环境入口。
- 环境内展示其 Server、MySQL、Redis 插件。
- 点击插件后在第三栏打开插件详情。
- 在明确的环境作用域内新增插件。
- 显示环境和插件的配置、连接、错误、阻塞、连接中及部分成功状态。
- 环境和插件的重命名、删除及其现有约束。
- 环境连接、断开、重试以及单个插件操作的现有语义。
- 插件列表属于环境，不得跨环境混合或隐式切换作用域。

推荐交互：

- 环境使用可展开列表项，展开后显示插件。
- 同一时间默认只展开一个环境，降低第二栏的信息噪声。
- 环境行承担环境选择和环境级状态，插件行承担插件选择和插件级状态。
- 新增插件入口位于对应环境内部或紧邻该环境，不能成为无作用域的全局按钮。
- 插件状态使用图标、文字和颜色共同表达，不能只依赖颜色。

允许改变：

- 环境展开样式、插件分组方式和状态图标。
- 新增环境、新增插件和管理操作的具体入口。
- 内联编辑或第三栏编辑的选择，只要取消、保存和验证语义保持一致。
- 第二栏宽度、密度和折叠行为。

### 3.3 第三栏：详情工作区

第三栏根据当前选择渲染完整详情，不承担项目和环境列表导航。

选择与默认页面映射：

| 当前选择 | 第三栏默认页面 |
| --- | --- |
| 无项目 | 产品空状态和新建项目入口 |
| 项目 | 项目概览与基本信息 |
| 环境 | 环境概览 |
| 插件 | 插件详情 |
| 全局确认入口 | 操作确认中心 |

项目页面至少保留：

- 项目概览。
- 环境和插件汇总。
- 需要处理的状态。
- 项目基本信息、重命名和删除。
- 项目范围内的近期操作证据。

环境页面至少保留：

- 环境概览。
- 插件状态和需要处理的问题。
- 环境资料及基本信息。
- 运维说明查看与编辑。
- 环境操作记录。
- 快捷提问。
- 环境连接与断开操作。
- 环境重命名和删除。

插件页面至少保留：

- 插件详情及连接事实。
- 插件基本信息和重命名。
- 插件连接配置的只读展示与显式编辑。
- 新增插件的检查并添加流程。
- 插件专属验证和取消验证。
- 凭据保持、替换及旧凭据迁移提示。
- Agent 权限说明。
- 插件范围操作记录。
- 连接、断开和重试。
- 删除插件及依赖阻塞提示。

操作确认中心至少保留：

- 全局入口和待确认数量。
- 按请求逐项核对项目、环境、插件、能力和参数。
- 普通确认和强确认的区分。
- Shell 等高风险操作的完整内容核对。
- 单次确认、过期、执行结果及参数变化后重新确认。

允许改变：

- 页面标题、操作栏、Tabs、区块顺序和内容分组。
- 使用 Page、Section、Tabs、Accordion、Alert、Table 或列表的方式。
- 空状态、加载状态和错误状态的视觉形式。
- 详情栏的折叠、宽度和内部滚动方式。

## 4. 视觉与组件系统

### 4.1 设计方向

本产品被定义为高密度、视觉鲜明、适合长时间使用的桌面运维工具。好看且大胆是第一视觉原则，同时不能牺牲作用域识别、信息可读性、键盘效率和安全操作的确定性。

建议设计参数：

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 8`

视觉原则：

- 默认深色，支持浅色或跟随系统。
- 深色主题使用近黑分层表面和翠绿主强调色；当前项目、环境、插件、Tabs 与菜单选择项使用绿色文字或图标形成明确选中态。
- 浅色主题使用冷中性表面和紫色主强调色，保持与深色主题一致的层级、密度和交互语义。
- 成功、警告、危险和待确认颜色仅表达真实状态。
- 使用 8-12px 的一致圆角系统；按钮、输入、浮层和容器遵循固定规则。
- 保留 Segoe UI 或 Windows 系统字体，数字、端口、地址、路径和命令使用等宽字体。
- 允许使用更鲜明的选中面、边界、字重和交互层级塑造视觉个性，但状态色必须保持真实含义。
- 主要依靠间距、字重、背景层级和有目的的分隔组织信息。
- 不把每个内容区都装进 Card。
- 不使用 AI 紫色渐变、外发光、玻璃拟态、装饰性状态点或无任务意义的动画。
- 所有交互具有 hover、active、focus-visible、disabled、loading 和 error 状态。
- 动效必须遵守 `prefers-reduced-motion`。

### 4.2 shadcn/ui 使用边界

shadcn/ui 是基础组件源代码和可访问性交互基础，不是现成产品模板。

优先采用：

- Button、Button Group、Input、Input Group、Textarea、Select、Checkbox、Switch、Toggle Group。
- Field、Label、Alert、Badge、Tooltip、Popover、Dropdown Menu。
- Dialog、Alert Dialog。
- Tabs、Collapsible、Accordion。
- Sidebar、Scroll Area、Resizable、Separator。
- Item、Kbd、Progress、Table；仅在确有排序、筛选、列控制需求时增加 TanStack Table。
- Skeleton、Empty、Sonner Toast。

保持项目定制：

- 三栏 App Shell。
- 项目、环境和插件资源树。
- 连接状态与作用域状态表达。
- 插件配置和验证工作流。
- 操作确认中心。
- 审计记录呈现。
- 运维说明编辑器。

约束：

- 只使用一套主体设计系统，不混入 Fluent、Carbon、Material 或 Radix Themes 的成品组件。
- shadcn/ui 底层 primitives 可以使用，但组件视觉统一由本项目 token 控制。
- 图标只选一个家族，并统一尺寸与笔画。
- 业务交互只要已有合适的 shadcn/ui + Radix UI 组件就必须优先使用，不以原生 `button`、`input`、`select`、`textarea` 或 `dialog` 绕过统一组件层；原生 HTML 继续用于语义化结构和没有对应复合组件的基础布局。

### 4.3 建议 token

第一版 token 只定义语义，不在流程文档中锁定最终色值：

```text
background
surface
surface-raised
surface-hover
surface-selected
border
border-strong
text
text-muted
text-faint
primary
primary-foreground
success
warning
danger
info
focus-ring
```

主题必须一次性应用在应用根节点，不允许第三栏的不同页面自行切换主题体系。

## 5. 目标前端架构

### 5.1 技术栈

```text
Electron Renderer
├─ React
├─ TypeScript
├─ Vite
├─ Tailwind CSS
├─ shadcn/ui
└─ window.aiOps.v2
```

不默认增加全局状态库。先使用 React Context、`useReducer` 和局部状态；只有在实际证明跨层状态管理失控时再评估额外依赖。

### 5.2 推荐目录

```text
renderer/v2/
├─ index.html
├─ src/
│  ├─ app/
│  │  ├─ App.tsx
│  │  ├─ routes.ts
│  │  └─ providers.tsx
│  ├─ components/
│  │  ├─ ui/                 # shadcn/ui 源组件
│  │  ├─ app-shell/
│  │  ├─ project-rail/
│  │  ├─ resource-pane/
│  │  └─ detail-workspace/
│  ├─ features/
│  │  ├─ projects/
│  │  ├─ environments/
│  │  ├─ plugins/
│  │  ├─ runbooks/
│  │  ├─ audit/
│  │  ├─ quick-questions/
│  │  └─ confirmations/
│  ├─ bridge/                # window.aiOps.v2 类型与薄封装
│  ├─ state/
│  ├─ styles/
│  └─ main.tsx
├─ components.json
└─ vite.config.ts
```

目录可以在技术落地阶段微调，但必须保持 feature、UI primitive 和 Electron bridge 的职责分离。

### 5.3 状态分类

必须区分：

1. 导航状态：当前 projectId、environmentId、pluginInstanceId、第三栏页面。
2. 远端/主进程数据状态：项目、环境、插件、运行状态、审计、确认请求。
3. 表单状态：新增、编辑、校验、未保存更改和敏感字段替换。
4. 短暂 UI 状态：Popover、Dialog、Toast、栏宽和折叠状态。
5. 并发控制状态：revision、expectedRevision、进行中的 mutation 和冲突恢复。

不得把凭据值写入持久前端状态、日志、错误摘要或测试快照。

### 5.4 Electron 与构建边界

- preload 暴露的 API 名称、参数和返回值默认不变。
- 生产 Renderer 必须使用本地构建资产，不依赖开发服务器或外部 CDN。
- CSP 继续保持 `default-src 'self'` 和 `script-src 'self'`。仅 `style-src` 可按已记录的兼容性决策加入 `'unsafe-inline'`；脚本不得加入 `unsafe-inline` 或 `unsafe-eval`。
- `nodeIntegration` 保持关闭，`contextIsolation` 和 sandbox 保持开启。
- 生成的构建文件不手工编辑、不提交；`start`、`test:ui` 和 `dist` 在需要时先构建 Renderer。
- Electron Builder 只打包新的生产 Renderer 资产和必要源文件。
- 在完成新 Renderer 验收前，不修改正式 `loadFile()` 切换点。

## 6. 完整重构执行流程

### 阶段 0：冻结当前基线

> 实施状态：已完成。冻结结果见[阶段 0 基线](./shadcn-ui-phase-0-baseline.md)。

工作内容：

- 记录当前工作树状态，保留用户已有修改。
- 运行当前 `corepack pnpm run check`、`corepack pnpm test` 和 `corepack pnpm run test:ui`。
- 保存当前三栏、项目、环境、插件详情、插件编辑、快捷提问和确认中心的基线截图。
- 从现有 UI contract 和 smoke test 生成行为清单。
- 列出所有 preload API 及其调用页面。

通过条件：

- 当前失败项已记录并与重构引入的失败区分。
- 核心行为、截图和安全边界有可比对基线。

### 阶段 1：建立 React Renderer 基础

> 实施状态：已完成。阶段结果见[阶段 1 报告](./shadcn-ui-phase-1-report.md)。

工作内容：

- 接入 React、TypeScript、Vite、Tailwind CSS 和 shadcn/ui。
- 建立严格类型的 `window.aiOps.v2` bridge。
- 建立主题、token、字体、图标、focus 和 reduced-motion 基线。
- 建立独立的新 Renderer 入口，不立即替换生产入口。
- 更新开发、检查、UI 测试和打包脚本的 Renderer 构建步骤。
- 增加最小启动测试，验证 CSP、preload、sandbox 和本地资产加载。

通过条件：

- 新 Renderer 在 Electron 内运行，不使用外部网络资源。
- preload API 可调用，安全配置无回退。
- `check`、基础测试和最小 Electron smoke 通过。

### 阶段 2：实现三栏 App Shell

> 实施状态：已完成。阶段结果见[阶段 2 报告](./shadcn-ui-phase-2-report.md)。

工作内容：

- 实现项目栏、环境与插件栏、详情工作区。
- 实现两处分隔/调整宽度能力。
- 实现项目栏和详情栏折叠。
- 实现窗口最小尺寸下的明确布局降级。
- 实现键盘焦点、跳到主内容和栏宽持久化。
- 使用模拟数据覆盖无项目、空项目、多环境、多插件、长名称和异常状态。

通过条件：

- 三栏结构与本文件第 3 节一致。
- 960×640、1280×820 和更宽窗口无水平溢出。
- 长名称不会挤掉主要操作。
- 键盘可以完成项目选择、环境选择、插件选择和进入主内容。

### 阶段 2R：正式 shadcn/Radix 激进视觉重构（插入阶段）

> 实施状态：已完成。阶段结果见[阶段 2R 报告](./shadcn-ui-phase-2r-report.md)。

阶段 2R 历史上插入阶段 2 与原阶段 3 之间；其验收完成后，阶段 3 的暂停已经解除。

工作内容：

- 保留阶段 2 的三栏信息架构、选择语义、分隔线、折叠、栏宽持久化、skip link、键盘合同和模拟状态覆盖。
- 用 `style: radix-nova`、`base: radix` 和 Phosphor 图标明确固定 shadcn 基础，不隐式采用 Base UI。
- 使用正式 Sidebar、Resizable、ScrollArea、Tooltip、Dropdown Menu、Context Menu、Command、Accordion、Collapsible、Tabs、Dialog、Sheet、Alert Dialog、Field、Table、Skeleton 和 Sonner 源组件。
- 移除阶段 2 的临时 Resizable 与 ScrollArea 实现，不复制旧 UI 的页面结构、指标卡和整框列表视觉。
- 视觉参数提升为 `DESIGN_VARIANCE: 5`、`MOTION_INTENSITY: 3`、`VISUAL_DENSITY: 8`。
- 继续只使用 fixture，不调用任何 `window.aiOps.v2` API。

通过条件：

- `shadcn info` 明确报告 `base: radix`，组件源码不依赖 Base UI、Lucide、远程字体或 shadcn 运行时。
- 960×640、1280×820、1680×980 的浅色和深色截图均通过，无页面级或可见内部横向滚动条。
- 键盘、焦点、Dialog/Sheet、Command、Tabs、Accordion、分隔线、对比度和 reduced-motion 合同通过。
- React Renderer 对 `window.aiOps.v2` 的调用为 0，外部请求为 0，脚本 CSP 与 Electron 安全基线不变。
- 完整测试及旧 UI smoke 继续通过。

### 阶段 3：迁移只读导航与详情

> 实施状态：已完成。实现与最终回归证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 接入项目、环境、插件列表数据。
- 迁移项目概览、环境概览和插件详情。
- 迁移连接事实、健康状态、Agent 权限和只读配置展示。
- 实现 loading、empty、error、blocked、disconnected、connecting、partial 和 connected 状态。
- 接入项目、环境、插件选择后的第三栏路由。

通过条件：

- 选择作用域不会错配。
- 状态变化可以局部更新，不必重建整棵页面 DOM。
- 当前读取类 UI 行为回归通过。

### 阶段 4：迁移低风险编辑功能

> 实施状态：已完成。实现与最终回归证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 新增项目和环境。
- 项目、环境和插件重命名。
- 运维说明查看、编辑、取消和保存。
- 快捷提问、常见问题及复制流程。
- 操作记录筛选、刷新和范围表达。
- 明确处理 expectedRevision 冲突和重试。

通过条件：

- 表单具有标签、帮助、错误、加载和禁用状态。
- 未保存内容的离开策略与现有行为一致。
- 快捷提问的敏感内容限制和最终后台脱敏保持不变。

### 阶段 5：迁移插件新增、编辑与验证

> 实施状态：已完成。实现与最终回归证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 插件类型选择。
- Server、MySQL、Redis 专属表单。
- Direct、Windows VPN Guard 和同环境 Server Tunnel 配置。
- 插件检查并添加。
- 现有插件连接编辑会话。
- 临时验证、取消验证、TLS 决策和数据库发现。
- 凭据未修改、显式替换、旧凭据迁移和瞬时显示处理。
- 保存但不连接、保存并连接、保存并恢复连接等动作。

通过条件：

- 不出现草稿保存或恢复入口。
- 取消或离开会丢弃未保存新增/修改内容。
- 密码留空仍表示未修改，只有显式替换才提交新值。
- 连接编辑和验证使用原有会话、revision 和取消语义。
- 测试和错误摘要不包含凭据。

### 阶段 6：迁移连接与安全确认

> 实施状态：已完成。实现与最终回归证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 环境级和插件级连接、断开、重试。
- 部分成功、依赖阻塞、网络变化和重连状态。
- Host Key 挑战确认。
- 删除项目、环境和插件的约束与强确认。
- 全局操作确认中心。
- 标准确认、强确认、过期、拒绝和执行结果。

通过条件：

- 打开或选择项目、环境、插件不会自动发起首次连接。
- Agent 仍不能通过前端绕过连接和确认边界。
- 确认绑定的项目、环境、插件、能力和参数完整展示。
- 参数或目标状态变化后旧确认不能继续使用。
- Shell 强确认仍要求核对完整命令。

### 阶段 7：测试迁移与可访问性收口

> 实施状态：已完成。477/477 Node 测试、三层 Electron smoke、双主题截图、zoom 和可访问性证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 将适合的源代码字符串断言改为用户可观察行为断言。
- 保留必要的稳定 ID，但不为了旧测试复制旧 DOM 结构。
- 覆盖项目、环境、插件、详情 Tabs、表单、Dialog 和确认中心的键盘路径。
- 覆盖 960×640、1280×820 和宽屏布局。
- 检查焦点转移、Dialog 焦点闭环、错误关联、aria-live 和 skip link。
- 检查深色、浅色、高对比度、forced-colors 和 reduced-motion。
- 运行 `corepack pnpm run check`、`corepack pnpm test` 和覆盖 foundation、业务变更、插件操作三层路径的 `corepack pnpm run test:ui:all`。

通过条件：

- 所有功能回归和安全测试通过。
- UI smoke 覆盖新 Renderer 的核心用户路径。
- 没有仅为通过旧正则测试保留的无意义结构。

### 阶段 8：生产切换与旧代码删除

> 实施状态：已完成。生产入口、旧 Renderer 清理、`dist`、包验证、packaged MCP/UI smoke 和隔离安装升级回归均已通过，证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

工作内容：

- 将正式 Electron `loadFile()` 切换到新 Renderer 生产入口。
- 更新 Electron Builder 文件清单。
- 运行完整测试和打包验证。
- 执行 `corepack pnpm run dist`。
- 执行包验证和 packaged MCP smoke。
- 确认安装、覆盖升级、数据目录和 MCP 注册不受影响。
- 删除旧 `renderer/v2/app.js`、旧静态 HTML 结构和不再使用的 CSS。
- 删除旧测试中只约束旧实现细节的断言。

通过条件：

- 开发运行、UI smoke、完整测试、打包和安装升级验证全部通过。
- 生产包不包含两套 Renderer。
- 不存在旧全局 DOM 状态机和新 React 状态机同时运行的情况。
- 没有生成文件、真实基础设施信息或敏感数据进入提交。

## 7. 页面验收矩阵

| 范围 | 必须验收的主要行为 |
| --- | --- |
| 项目栏 | 新增、选择、排序、折叠、状态、确认中心入口 |
| 环境与插件栏 | 环境新增/选择/展开，插件显示/选择/新增，状态更新，栏宽调整 |
| 项目详情 | 概览、汇总、近期操作、重命名、删除 |
| 环境详情 | 概览、插件状态、资料、运维说明、记录、快捷提问、连接操作 |
| 插件详情 | 连接事实、只读配置、Agent 权限、记录、连接操作、删除 |
| 插件新增 | 类型选择、专属字段、验证、检查并添加、取消丢弃 |
| 插件编辑 | 编辑会话、验证、凭据保持/替换、保存策略、取消丢弃 |
| 操作确认 | 标准确认、强确认、拒绝、过期、执行结果、单次使用 |
| 全局状态 | loading、empty、error、blocked、disconnected、connecting、partial、connected |
| 可访问性 | 键盘、焦点、标签、错误关联、aria-live、reduced-motion、高对比度 |
| 桌面布局 | 960×640、1280×820、宽屏、长中文名称、无横向溢出 |

## 8. 安全与兼容性检查表

- [x] Renderer 不接触 Node API，只通过 preload 调用 V2 IPC。
- [x] CSP 的 `unsafe-inline` 只存在于 `style-src`；脚本没有 `unsafe-inline`、`unsafe-eval` 或外部来源。
- [x] 凭据、passphrase、Broker token 和解密值不进入状态快照、日志或错误。
- [x] 项目、环境和插件作用域不会被前端默认值静默扩大。
- [x] 连接只由用户明确发起，页面导航不触发首次出站连接。
- [x] 所有变更仍走现有 operation gate 和 confirmation binding。
- [x] 删除、Shell、文件变更和服务控制的确认语义未弱化。
- [x] MySQL 和 Redis 策略不因 UI 表单重构而扩大。
- [x] 产品名、应用名、CLI、MCP 名称、数据目录和 Broker pipe 兼容名称不改变。
- [x] 旧 `src/mcp.mjs` 和 legacy renderer 路径没有被恢复。

以上项目已由当前实现、静态/安全合同、Electron smoke、打包和安装升级回归共同验证；完整证据见[最终迁移报告](./shadcn-ui-full-migration-report.md)。

## 9. 完成定义

只有同时满足以下条件，完整重构才算完成：

1. 三栏产品骨架符合本文件定义。
2. 当前已交付功能均在新 Renderer 中可用，没有以“之后补齐”为由留下双实现。
3. React、TypeScript、Vite、Tailwind 和 shadcn/ui 成为唯一生产 Renderer 技术栈。
4. 旧 DOM 渲染器和旧 CSS 已删除。
5. preload/IPC、安全和数据模型没有未经批准的合同变化。
6. UI contract、完整测试和 Electron smoke 全部通过。
7. 打包、安装和覆盖升级验证通过。
8. 深色、浅色、最小窗口、键盘和核心可访问性完成验证。
9. 最终 diff 不包含生成文件、敏感数据或无关重构。

## 10. 历史分阶段执行提示

以下内容记录本次重构开始时采用的分阶段方法，供未来同类迁移参考；当前阶段 0–8 已经实施，不应据此重新从阶段 0 开始或覆盖现有工作区修改。

当时的执行原则是每次只授权一个阶段，并要求 Codex：

1. 开始前列出将修改的文件和保持不变的合同。
2. 先运行最窄相关测试，完成后运行该阶段要求的检查。
3. 报告实际完成、测试结果、遗留问题和下一阶段前置条件。
4. 未达到阶段通过条件时，不进入下一阶段。

当时的第一条实施指令为：

> 请按照 `docs/shadcn-ui-full-rewrite-plan.md` 执行阶段 0，仅冻结当前 UI 行为、截图、测试和 preload API 基线。不要修改生产代码。完成后提交基线报告、失败项和阶段 1 的精确文件级实施计划。

此后按阶段 1、2、2R、3–8 逐步实施。本次执行已经完成，实际测试、截图、打包和安装升级结果均已同步到[最终迁移报告](./shadcn-ui-full-migration-report.md)。
