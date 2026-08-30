# shadcn/ui 重构阶段 2 交付报告

> 对应计划：docs/shadcn-ui-full-rewrite-plan.md
>
> 阶段 0 基线：docs/shadcn-ui-phase-0-baseline.md
>
> 阶段 1 基础：docs/shadcn-ui-phase-1-report.md
>
> 执行日期：2026-08-29
>
> 结论：通过。独立 React Renderer 已具备可交互的三栏 App Shell；它仅使用模拟数据，未接入真实业务、变更类 API 或正式生产入口。

## 1. 交付范围

阶段 2 完成：

- 项目栏、环境与插件栏、详情工作区三栏布局。
- 项目栏与详情栏折叠、恢复和独立宽度档位。
- 全局操作确认入口位于项目栏顶部；新增项目和新增环境位于各自列表底部。
- 两处分隔线的指针调整、键盘调整和双击复位。
- 项目栏与详情栏宽度的 localStorage 持久化。
- 跳至主要内容的 skip link、可见焦点和 roving keyboard navigation。
- 项目、环境与插件的方向键、Home、End 导航。
- 三栏独立滚动，页面根节点不产生横向滚动。
- 无项目、空项目、多环境、多插件、长名称模拟场景。
- connected、disconnected、connecting、partial、blocked、error 六种状态。
- 960×640、1280×820 和 1680×980 三种 CSS viewport 自动验证与截图。

阶段 2 没有迁移项目、环境、插件、确认或操作记录等真实业务页面。所有新增、连接、诊断和页面入口均为明确标记的模拟交互。

## 2. 设计与交互结果

视觉参数固定为：

| 参数 | 值 | 落地方式 |
| --- | ---: | --- |
| DESIGN_VARIANCE | 3 | 低装饰、单一强调色、状态色只表达运行语义 |
| MOTION_INTENSITY | 2 | 仅短时状态过渡；遵循 reduced-motion |
| VISUAL_DENSITY | 8 | 紧凑行高、窄间距、三栏信息持续可见 |

界面使用本地 shadcn/ui 源组件、语义 token 和 Phosphor 单一图标家族。视觉返工移除了旧 UI 的整行分割、2×2 边框指标表、顶部孤立加号和整框告警列表，改用紧凑导航项、环境分组、语义 Badge、无外框指标带和上下文状态行。未使用营销页 Hero、渐变、发光、远程字体、远程图标或无意义动效。

### 2.1 三栏结构

    项目栏 | 环境与插件栏 | 详情工作区
            ^              ^
          分隔线 1       分隔线 2

- 项目栏负责 fixture 切换、项目选择、状态和顶部待确认入口；新增项目位于项目列表之后。
- 资源栏以圆角环境分组显示插件，支持环境展开和插件选择；新增环境位于环境列表之后。
- 详情工作区根据当前项目、环境或插件选择展示模拟摘要、状态和后续页面槽位。
- 项目栏折叠为 52 px 图标栏；详情栏折叠为 48 px 边栏。
- 在最小窗口宽度下，中间资源栏仍保留至少 240 px。

### 2.2 宽度调整和持久化

`renderer/v2/src/components/ui/resizable.tsx` 提供 CSP 安全的本地分隔线 primitive：

- 指针拖动按 28 px 步长切换离散宽度档位。
- ArrowLeft、ArrowRight、Home、End 可以调整或复位。
- 双击恢复默认宽度。
- `role="separator"`、方向和值域通过 ARIA 暴露。
- 布局存入 `runbook-bridge:app-shell-layout:v1`，非法或过期值会回退默认值。

### 2.3 可访问性

- skip link 会在详情栏折叠时先展开详情栏，再将焦点移到 `#detail-main`。
- 项目、环境和插件列表使用单一 tab stop 与方向键导航。
- 折叠、添加、展开和状态入口均有可读名称。
- 长名称使用视觉截断，同时通过 title 保留完整内容。
- 强制颜色模式保留选择态与状态指示；reduced-motion 禁用非必要过渡。

## 3. 模拟数据覆盖

| fixture / 数据 | 覆盖 |
| --- | --- |
| no-project | 无项目、空详情提示 |
| empty-project | 有项目、无环境和插件 |
| operations | 三个项目、多环境、多插件、待确认数量 |
| long-name records | 超长项目、环境、插件名称和截断 |
| status matrix | connected、disconnected、connecting、partial、blocked、error |

模拟数据使用通用占位信息，不包含真实基础设施地址、凭据、日志或本地应用数据。

## 4. 文件变更

### 4.1 阶段 1 文件上的修改

| 文件 | 阶段 2 变更 |
| --- | --- |
| renderer/v2/react.html | 独立入口标题调整为三栏工作台 |
| renderer/v2/src/app/App.tsx | foundation 诊断页替换为 AppShell；移除阶段 1 的只读 preload 演示调用 |
| renderer/v2/src/components/ui/button.tsx | 增加高密度 xs 和小图标尺寸 |
| renderer/v2/src/styles/globals.css | 三栏网格、宽度档位、滚动、折叠、响应式与强制颜色样式 |
| scripts/ui-react-foundation-smoke.cjs | 扩展为三尺寸 App Shell Electron smoke |
| test/renderer-foundation-contract.test.mjs | foundation 合同同步到 App Shell 边界 |

阶段 2 最终没有增加新的 npm 依赖；package.json 和 pnpm-lock.yaml 中的未提交变更仍只来自阶段 1 的 React、Vite、Tailwind 和 shadcn 基础。

### 4.2 新增源文件

| 文件 | 职责 |
| --- | --- |
| renderer/v2/src/components/app-shell/AppShell.tsx | 三栏组合、选择状态、折叠、skip link 和模拟通知 |
| renderer/v2/src/components/app-shell/StatusIndicator.tsx | 六种状态的统一视觉与文本表达 |
| renderer/v2/src/components/ui/badge.tsx | 本地 shadcn Badge 变体，用于确认数量、状态和模拟数据标签 |
| renderer/v2/src/components/project-rail/ProjectRail.tsx | 项目栏、fixture 入口和项目键盘导航 |
| renderer/v2/src/components/resource-pane/ResourcePane.tsx | 环境分组、插件列表和资源键盘导航 |
| renderer/v2/src/components/detail-workspace/DetailWorkspace.tsx | 详情栏折叠态、空态和模拟详情 |
| renderer/v2/src/components/ui/resizable.tsx | CSP 安全的本地分隔线 primitive |
| renderer/v2/src/components/ui/scroll-area.tsx | 原生滚动和可见焦点封装 |
| renderer/v2/src/fixtures/app-shell-fixtures.ts | 阶段 2 全部模拟场景与状态 |
| renderer/v2/src/hooks/use-roving-navigation.ts | 方向键、Home、End 的 roving focus |
| renderer/v2/src/state/layout-state.ts | 宽度档位、折叠状态和持久化校验 |

### 4.3 新增验证

| 文件 | 验证 |
| --- | --- |
| test/renderer-app-shell-contract.test.mjs | 三栏结构、fixture、CSP、持久化、键盘、溢出和 API 禁用合同 |
| scripts/ui-react-foundation-smoke.cjs | 三尺寸渲染、两分隔线、选择/折叠/恢复/持久化、skip link、0 API 调用、0 控制台错误和 0 外部请求 |

## 5. 安全与兼容性结果

| 合同 | 结果 |
| --- | --- |
| 正式 `src/main.mjs` loadFile() | 未修改，继续加载旧 UI |
| `src/preload.cjs`、`src/ipc-v2.mjs`、`src/v2-service.mjs` | 未修改 |
| contextIsolation、sandbox、nodeIntegration | 保持阶段 0/1 基线 |
| React App Shell 对 `window.aiOps.v2` 的调用 | 0 |
| 变更类 API | 0 |
| CSP 脚本 unsafe-inline、unsafe-eval、外部资源 | 0 |
| CSP 样式 unsafe-inline | 仅新 React Renderer 允许，用于 shadcn/Radix 兼容 |
| Electron smoke 外部请求 | 0 |
| 产品名、版本、CLI、MCP、数据目录、pipe 标识 | 未修改 |
| 旧 renderer/v2 正式 UI | 未修改 |
| `renderer-build/` | 继续被忽略，未纳入源文件 |

## 6. 三种尺寸验证与截图

Electron smoke 使用 `BrowserWindow.setContentSize()` 验证 CSS viewport，并断言 body、root 和 App Shell 的 `scrollWidth <= clientWidth`。

| CSS viewport | 结果 | 截图 |
| --- | --- | --- |
| 960×640 | 通过，无页面级横向溢出 | `app-shell-960x640.png` |
| 1280×820 | 通过，无页面级横向溢出 | `app-shell-1280x820.png` |
| 1680×980 | 通过，无页面级横向溢出 | `app-shell-1680x980.png` |

截图目录：

    C:\Users\taotao\.codex\visualizations\2026\08\29\01a04c5d-8f29-72e0-91ca-1500f14c2a1a\shadcn-phase-2-redesign\

Windows 显示缩放可能使 PNG 物理像素大于 CSS viewport；自动断言和文件名均以 CSS viewport 为准。

## 7. 测试结果

| 命令 | 结果 |
| --- | --- |
| corepack pnpm run check:renderer:next | 通过 |
| corepack pnpm run build:renderer:next | 通过 |
| node --test 三项 Renderer 合同测试 | 3/3 通过 |
| corepack pnpm run test:ui:renderer-next | 通过，React renderer App Shell smoke passed |
| corepack pnpm run check | 通过 |
| corepack pnpm test | 485/485 通过，0 失败、取消、跳过或 TODO |
| corepack pnpm run test:ui | 通过，Three-pane UI smoke passed |
| git diff --check | 通过；仅有既存 .gitignore LF/CRLF 提示 |

最终构建：

    renderer-build/v2/react.html                  0.72 kB
    renderer-build/v2/assets/react-*.css         29.24 kB
    renderer-build/v2/assets/react-*.js         312.43 kB
    gzip 后 JavaScript                          91.50 kB

## 8. 执行中发现并解决的问题

### 8.1 官方交互 primitive 与当前 CSP 的冲突

第一版尝试了 react-resizable-panels、Radix Scroll Area 和 Radix Tooltip。Electron smoke 发现这些运行时会写入内联 style，而独立入口当时保持 `style-src 'self'`，因此 Chromium 正确拒绝并产生 CSP 错误。

阶段 2 最初移除了这些未使用依赖，并使用本地离散分隔线和原生滚动 primitive。随后根据完整兼容 shadcn/Radix 的产品要求，新 React Renderer 的 `style-src` 明确加入 `'unsafe-inline'`，但 `script-src`、`connect-src`、sandbox、context isolation 和 node integration 基线保持不变。决策记录见 `docs/shadcn-ui-radix-csp-decision.md`。

### 8.2 smoke 选择器冲突

早期分隔线库生成的数据属性与测试标识重名，导致 smoke 选择到了错误节点。实现改为仓库自有、语义明确的 `data-panel` 与 `data-resizer` 合同后解决。

### 8.3 最小宽度下的信息密度

960×640 初次视觉审计后收紧了项目选择态、按钮尺寸、文字截断和详情列宽；中间栏最小宽度固定为 240 px。三尺寸最终截图均未出现页面级横向溢出。

### 8.4 第一版视觉仍继承旧 UI

第一版阶段 2 截图保留了旧 UI 的整行分割、2×2 指标表、矩形告警列表和顶部新增图标，信息架构正确但视觉语言仍显呆板。根据截图复审，完成第二轮视觉返工：

- 全局确认移到项目栏顶部。
- 新增项目和新增环境移到各自列表底部。
- 项目选择改为紧凑导航项和局部强调色。
- 环境与插件改为可展开的圆角分组，不再逐行铺满分割线。
- 详情页将页面入口前置为紧凑导航，指标和告警改为无外框数据组。
- 分隔线改为宽命中区、细视觉线和按需出现的拖动把手。

返工后重新生成并逐张检查浅色三尺寸截图，同时强制深色主题运行 smoke。两种主题均通过。

## 9. 最终失败项

无。

已解决的问题保留在第 8 节。阶段 3 可以使用需要运行时样式的 shadcn/Radix primitive，但必须继续通过脚本 CSP、外部请求和 Electron 安全 smoke。

## 10. 阶段 3 前置条件

阶段 3 可以开始，前置条件全部满足：

1. 三栏选择、折叠、宽度和键盘合同已冻结并有 smoke 覆盖。
2. 58 项 preload API 类型与同步测试继续通过。
3. 新 Renderer 仍是独立入口，正式应用未切换。
4. 阶段 3 只允许读取真实数据，不允许保存、删除、连接、断开、确认、执行、探测或凭据操作。
5. 真实数据必须保持 Project -> Environment -> Plugin 作用域，不得跨作用域回退选择。
6. 订阅刷新必须可取消，并在组件卸载或作用域变化时清理。
7. 加载、空、错误和 scope 失效状态必须有测试；不得把敏感运行数据写入 fixture、日志、截图或错误摘要。
8. 脚本 CSP、安全窗口参数、正式入口和旧 UI smoke 继续保持；样式遵循已记录的 shadcn/Radix 兼容性例外。

## 11. 阶段 3 精确文件级实施计划

### 11.1 修改文件

| 文件 | 精确变更 |
| --- | --- |
| renderer/v2/src/components/app-shell/AppShell.tsx | 从 fixture 内部状态切换为可注入的只读 workspace model；保留阶段 2 布局、选择、折叠和持久化合同 |
| renderer/v2/src/components/project-rail/ProjectRail.tsx | 接收真实项目只读列表、loading/error 状态和 scope 失效后的显式清空；移除生产路径的 fixture 切换器 |
| renderer/v2/src/components/resource-pane/ResourcePane.tsx | 接收所选项目下的环境与插件只读列表；不得自动连接或调用保存 API |
| renderer/v2/src/components/detail-workspace/DetailWorkspace.tsx | 将阶段 2 模拟详情替换为项目、环境、插件三个只读 overview 路由容器 |
| renderer/v2/src/styles/globals.css | 增加只读页面的紧凑 definition list、表格、loading、empty 和 error 样式，不改变三栏宽度合同 |
| scripts/ui-react-foundation-smoke.cjs | 增加只读 API mock、订阅刷新、loading/error、scope 失效和 0 mutation API 断言 |
| test/renderer-foundation-contract.test.mjs | 同步阶段 3 入口边界，继续断言正式入口、CSP 和安全参数不变 |
| test/renderer-app-shell-contract.test.mjs | 保留阶段 2 布局合同，并断言 fixture 不进入阶段 3 生产读取路径 |

### 11.2 新增文件

| 文件 | 精确职责 |
| --- | --- |
| renderer/v2/src/features/workspace/workspace-read-model.ts | 将 workspaceOverview、environmentStatus 等只读结果规范化为 Renderer model；不缓存凭据或操作输出 |
| renderer/v2/src/features/workspace/use-workspace-overview.ts | 调用 workspaceOverview，并订阅 onWorkspaceChanged；提供 loading/data/error/reload 和卸载清理 |
| renderer/v2/src/features/workspace/use-environment-status.ts | 仅为当前选中环境读取/订阅状态；作用域变化时取消旧订阅和忽略迟到结果 |
| renderer/v2/src/features/workspace/selection-reducer.ts | 在项目、环境或插件被删除后执行 fail-closed 选择失效，不跨项目自动替代 |
| renderer/v2/src/features/projects/ProjectOverview.tsx | 只读项目元数据、环境计数和状态摘要 |
| renderer/v2/src/features/environments/EnvironmentOverview.tsx | 只读环境状态、Runbook 来源摘要和插件计数，不渲染敏感正文 |
| renderer/v2/src/features/plugins/PluginOverview.tsx | 只读插件类型、连接状态、Agent access 和配置存在性摘要，不显示凭据值 |
| renderer/v2/src/components/ui/alert.tsx | 本地、CSP 安全的紧凑错误提示 primitive |
| renderer/v2/src/components/ui/badge.tsx | 本地、CSP 安全的紧凑语义标签 primitive |
| renderer/v2/src/components/ui/skeleton.tsx | reduced-motion 兼容的本地加载占位 primitive |
| test/renderer-read-model-contract.test.mjs | 只读 API allowlist、0 mutation 调用、作用域失效、订阅清理和敏感字段不渲染合同 |

### 11.3 阶段 3 允许的 API 边界

优先只使用：

- `workspaceOverview`
- `environmentStatus`
- `onWorkspaceChanged`
- `onEnvironmentStatus`

如果现有 overview 不能提供计划中已经存在的只读字段，可在阶段 3 开始前先根据 58 项同步合同确认 `listEnvironments`、`listPlugins` 是否需要使用；不得因此修改 preload、IPC 或 Service 合同。

阶段 3 明确禁止调用任何 create、save、delete、connect、disconnect、confirm、execute、probe、credential、reveal 或 clear 类 API。

### 11.4 阶段 3 验证门槛

完成后至少运行：

    corepack pnpm run check:renderer:next
    corepack pnpm run build:renderer:next
    node --test test/renderer-bridge-contract.test.mjs test/renderer-foundation-contract.test.mjs test/renderer-app-shell-contract.test.mjs test/renderer-read-model-contract.test.mjs
    corepack pnpm run test:ui:renderer-next
    corepack pnpm run check
    corepack pnpm test
    corepack pnpm run test:ui

并重新验证 960×640、1280×820、1680×980 无页面级横向溢出。
