# shadcn/ui 激进重构阶段 2R 交付报告

> 对应计划：`docs/shadcn-ui-full-rewrite-plan.md`
>
> 前置阶段：`docs/shadcn-ui-phase-2-report.md`
>
> 执行日期：2026-08-29
>
> 结论：通过。新 React Renderer 已使用正式 shadcn/Radix 组件彻底重建三栏 App Shell，并继续保持模拟数据、0 业务 API 调用、独立入口和旧 UI 正式运行。

## 1. Radix 基础确认

开始和结束时均从 `renderer/v2/` 运行：

```text
corepack pnpm dlx shadcn@latest info
```

最终关键信息：

```text
framework     Vite
tailwind      v4
style         radix-nova
base          radix
iconLibrary   phosphor
```

`renderer/v2/components.json` 已显式固定 `style: radix-nova`、`iconLibrary: phosphor`、`rsc: false`。项目没有 `@base-ui/react`、Lucide、Next Themes、远程字体或 shadcn 运行时依赖。

## 2. 组件清单和使用位置

| 正式 shadcn/Radix 组件 | 阶段 2R 用途 |
| --- | --- |
| Sidebar | 第一栏结构、项目菜单、数量和折叠内容 |
| Resizable | 三栏 Panel Group、两处分隔线、键盘调整和双击复位 |
| ScrollArea | 项目、资源和详情三栏的独立纵向滚动 |
| Tooltip | 图标按钮、折叠入口和命令入口的可访问提示 |
| DropdownMenu | 项目和环境的显式更多操作 |
| ContextMenu | 项目、环境和插件的右键操作面 |
| Command | Ctrl+K 项目、环境、插件和快速操作搜索 |
| Accordion | 第二栏单环境展开和插件树 |
| Collapsible | 详情页模拟边界说明 |
| Tabs | 概览、配置、Agent 权限、操作记录层级 |
| Dialog | 新增项目和新增环境模拟表单 |
| Sheet | 明确环境作用域内的新增插件模拟表单 |
| AlertDialog | 全局操作确认中心演示 |
| Field | Dialog 和 Sheet 的标签、说明和字段组合 |
| Table | 范围事实和需要处理列表 |
| Skeleton | 后续只读操作记录的加载位置 |
| Sonner | 模拟操作完成反馈 |

同时使用 Button、Badge、Checkbox、Input、Input Group、Label、Select、Separator 和 Textarea。所有组件源文件均位于 `renderer/v2/src/components/ui/`，并按本项目 token、Phosphor 图标和高密度桌面布局做了有界定制，没有无差别覆盖已有 Button 和 Badge 定制。

## 3. 依赖变更

阶段 2R 相对阶段 2 增加：

| 依赖 | 版本 | 原因 |
| --- | --- | --- |
| `radix-ui` | `^1.6.7` | shadcn 当前 Radix 统一 primitive 包 |
| `react-resizable-panels` | `^4.12.3` | 正式 Resizable Panel Group |
| `cmdk` | `^1.1.1` | Command palette |
| `sonner` | `^2.0.8` | Toast 反馈 |

移除直接的 `@radix-ui/react-slot` 依赖，Slot 改由统一 `radix-ui` 提供。`pnpm-lock.yaml` 已同步。没有增加 shadcn CLI 运行时依赖。

## 4. 视觉和布局结果

阶段 2R 参数：

| 参数 | 值 |
| --- | ---: |
| DESIGN_VARIANCE | 5 |
| MOTION_INTENSITY | 3 |
| VISUAL_DENSITY | 8 |

视觉不再复刻旧 UI：

- 项目栏使用 Sidebar 导航语义、局部选中面和按需更多操作，不使用旧式整行框线列表。
- 环境栏使用 Accordion 资源树，插件保留明确环境作用域，环境与插件都有 Context Menu。
- 详情栏使用线性 Tabs、紧凑 Table 和 Collapsible，不再使用旧 2×2 指标卡和整框告警卡。
- 详情视图选择器后续由文档式 line Tabs 替换为正式 shadcn/Radix segmented Tabs：使用紧凑容器、填充选中面和绿色选中文字，同时保留 `tablist`、方向键与 `tabpanel` 合同。
- 新增项目位于项目列表末尾；新增环境位于环境列表末尾；新增插件位于对应环境内部。
- 全局确认保持在项目列表上方。
- 浅色主题继续使用冷中性色；深色主题改为近黑四级表面和单一翠绿主色。当前项目、环境、插件、Tabs、Command 与选择菜单的选中文字和图标统一为翠绿，错误、阻塞、警告和连接中仍保留各自语义色。
- 深色配色参考用户提供的 Skills Manager 截图，但不复制其品牌、内容或页面结构；没有渐变、发光、玻璃效果、营销页 Card Grid 或远程资产。
- 深色主题在 React 挂载前同步，避免 ScrollArea 首帧继承浅色文字；自动对比度断言要求主要正文不低于 4.5:1。

正式 Panel Group 保存精确百分比，不再使用阶段 2 的离散宽度档位。项目栏折叠为 52 px，详情栏折叠为 48 px；状态仍保存在 `runbook-bridge:app-shell-layout:v1`，并兼容读取阶段 2 的旧折叠字段。

## 5. 截图

截图目录：

```text
C:\Users\taotao\.codex\visualizations\2026\08\29\01a04c5d-8f29-72e0-91ca-1500f14c2a1a\shadcn-phase-2r\
```

| CSS viewport | 浅色 | 深色 |
| --- | --- | --- |
| 960×640 | `app-shell-light-960x640.png` | `app-shell-dark-960x640.png` |
| 1280×820 | `app-shell-light-1280x820.png` | `app-shell-dark-1280x820.png` |
| 1680×980 | `app-shell-light-1680x980.png` | `app-shell-dark-1680x980.png` |

Windows 显示缩放会使 PNG 物理像素高于 CSS viewport；文件名和自动断言使用 CSS viewport。六张截图均已逐张检查，无页面级横向溢出或可见内部横向滚动条。

深色翠绿配色修订截图位于：

```text
C:\Users\taotao\.codex\visualizations\2026\08\29\01a04c5d-8f29-72e0-91ca-1500f14c2a1a\shadcn-phase-2r-emerald\
```

该目录中的 960×640、1280×820 和 1680×980 三张深色截图取代上表原深色基线。截图场景同时选中项目、插件与详情 Tab，用于验证三类选中内容均为翠绿色。

详情 segmented Tabs 修订截图位于：

```text
C:\Users\taotao\.codex\visualizations\2026\08\29\01a04c5d-8f29-72e0-91ca-1500f14c2a1a\shadcn-segmented-tabs\
```

## 6. 键盘和可访问性结果

| 合同 | 结果 |
| --- | --- |
| 项目 ArrowUp、ArrowDown、Home、End | 通过 |
| 环境与插件跨 Accordion roving focus | 通过；在捕获阶段处理后阻止 Radix 二次覆盖焦点 |
| Resizable 分隔线 Arrow、Home、End | 通过 |
| Ctrl+B 项目栏折叠 | 由受控 SidebarProvider 提供 |
| Ctrl+K Command | 通过；可见搜索按钮与快捷键共用受控状态 |
| Skip link | 通过；详情折叠时先展开，再聚焦 `#detail-main` |
| Dialog/Sheet/AlertDialog | 通过；Portal、焦点入口、关闭和字段标签已 smoke |
| Tabs | 4 个 tab、1 个选中 tab，使用 Radix 键盘语义 |
| 可见无名称按钮 | 0 |
| 主要正文对比度 | 浅色和深色均不低于 4.5:1 |
| 强制颜色和 reduced motion | CSS 合同存在并通过源合同测试 |

状态不是只靠颜色表达，六种状态均同时提供 Phosphor 图标、可读名称和状态属性。

## 7. CSP、外部请求和 0 API 调用证明

独立 Electron smoke 验证：

| 证明项 | 结果 |
| --- | --- |
| `default-src 'self'` | 通过 |
| `script-src 'self'` | 通过，无 `unsafe-inline`、`unsafe-eval` |
| `style-src 'self' 'unsafe-inline'` | 通过，仅存在一次授权的 `unsafe-inline` |
| `connect-src 'none'` | 通过 |
| 运行时 style 属性和 style block | 通过，用于 Radix 定位和尺寸 |
| 加载资源 | 全部为本地 `file:` |
| 外部请求 | 0 |
| `window.require`、`window.process` | 均不存在 |
| preload API 名称 | 58 项仍存在并与严格类型同步 |
| `workspaceOverview` 调用 | 0 |
| React App Shell 源码中的 `window.aiOps` | 0 |
| create、save、delete、connect、confirm 等调用 | 0 |

smoke 使用真实 preload 加载 58 项 API，同时为 `workspaceOverview` 安装计数 handler；最终计数为 0。源合同还对 App Shell、组件组合和 fixture 路径执行静态禁止调用检查。

## 8. 测试结果

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm run check:renderer:next` | 通过 |
| `corepack pnpm run build:renderer:next` | 通过 |
| 三项 Renderer 合同测试 | 3/3 通过 |
| `corepack pnpm run test:ui:renderer-next` | 通过 |
| 浅色独立 Electron smoke | 通过 |
| 深色独立 Electron smoke | 通过 |
| `corepack pnpm run check` | 通过 |
| `corepack pnpm test` | 485/485 通过，0 失败 |
| `corepack pnpm run test:ui` | 通过，旧正式 UI smoke 继续通过 |

最终构建约为：HTML 0.72 kB、CSS 100.09 kB、JavaScript 603.16 kB，JavaScript gzip 后约 173.93 kB。

## 9. 失败项和已知警告

没有测试失败项。

Vite 报告单个 JavaScript chunk 超过 500 kB 的非阻塞警告。阶段 2R 没有为了压缩 mock Shell 引入路由拆包；在阶段 3 形成真实只读 feature 边界后，可按页面和重型 overlay 评估动态导入。该警告不影响本地加载、CSP、外部请求或当前交互。

## 10. 保持不变的边界

- `src/main.mjs` 正式 `loadFile()` 未修改，旧 `renderer/v2/index.html` 继续作为正式 UI。
- `src/preload.cjs`、`src/ipc-v2.mjs`、`src/v2-service.mjs` 和所有运行时 Service 未修改。
- Electron `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 未修改。
- CSP 决策未扩大到脚本，样式例外仍只属于新 React Renderer。
- 版本、产品名、应用名、CLI、MCP 身份、数据目录和 Broker pipe 未修改。
- 没有接入真实项目、环境、插件或运维数据。

## 11. 后续只读真实数据阶段文件级计划

### 11.1 修改文件

| 文件 | 精确变更 |
| --- | --- |
| `renderer/v2/src/components/app-shell/AppShell.tsx` | 注入只读 workspace controller；保留 Panel Group、选择、折叠、skip link、Command 和 overlay 合同 |
| `renderer/v2/src/components/project-rail/ProjectRail.tsx` | 接收项目 loading/data/error；真实路径移除 fixture Select，保留测试 fixture adapter |
| `renderer/v2/src/components/resource-pane/ResourcePane.tsx` | 只展示当前项目下的环境和插件；作用域失效时清空，不跨项目自动替代 |
| `renderer/v2/src/components/detail-workspace/DetailWorkspace.tsx` | 将模拟 Overview 分派到项目、环境、插件只读 feature；保留 Tabs 和空状态 |
| `renderer/v2/src/app/providers.tsx` | 加入只读 workspace context，不加入 mutation dispatcher |
| `renderer/v2/src/bridge/ai-ops-v2.ts` | 仅增加已有读取方法的窄封装和结果解析；不修改 58 项公开类型 |
| `scripts/ui-react-foundation-smoke.cjs` | 加入只读 API mock、loading/error、订阅清理、迟到结果和 0 mutation 断言 |
| `test/renderer-app-shell-contract.test.mjs` | 保留 2R 视觉和布局合同，禁止 fixture 进入真实读取路径 |
| `test/renderer-foundation-contract.test.mjs` | 继续冻结正式入口、Radix、CSP 和 Electron 安全参数 |

### 11.2 新增文件

| 文件 | 精确职责 |
| --- | --- |
| `renderer/v2/src/features/workspace/workspace-read-model.ts` | 将 workspace overview 规范化为不含凭据和运维正文的只读 Renderer model |
| `renderer/v2/src/features/workspace/use-workspace-overview.ts` | 调用 `workspaceOverview`，订阅 `onWorkspaceChanged`，提供 loading/data/error/reload 和卸载清理 |
| `renderer/v2/src/features/workspace/use-environment-status.ts` | 只读取当前环境状态；作用域变化后忽略迟到结果并清理订阅 |
| `renderer/v2/src/features/workspace/selection-reducer.ts` | fail-closed 处理被删除或失效的 project、environment、plugin 选择 |
| `renderer/v2/src/features/projects/ProjectOverview.tsx` | 项目元数据、环境数量和状态摘要 |
| `renderer/v2/src/features/environments/EnvironmentOverview.tsx` | 环境状态、Runbook 来源摘要和插件计数，不渲染敏感正文 |
| `renderer/v2/src/features/plugins/PluginOverview.tsx` | 插件类型、连接事实、Agent access 和配置存在性，不显示凭据值 |
| `test/renderer-read-model-contract.test.mjs` | 只读 API allowlist、0 mutation、作用域失效、订阅清理和敏感字段禁止渲染 |

阶段 3 只允许优先使用 `workspaceOverview`、`environmentStatus`、`onWorkspaceChanged` 和 `onEnvironmentStatus`。不得调用 create、update、save、delete、connect、disconnect、confirm、execute、probe、credential、reveal 或 clear 类 API，也不得修改 preload、IPC 或 Service 合同。
