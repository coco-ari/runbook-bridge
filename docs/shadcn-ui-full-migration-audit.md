# shadcn/ui + Radix UI 全量迁移现状审计

审计日期：2026-08-29

审计范围：新 React Renderer、旧 `renderer/v2/` UI、preload V2 合同、正式入口、测试与打包链路。
本报告承接阶段 0、1、2、2R；这些已完成阶段不重复执行。

> 说明：本文第 1–6 节是正式实施前冻结的审计快照。迁移已经完成，
> 最终入口、组件覆盖、删除清单与验收结果见
> docs/shadcn-ui-full-migration-report.md。

## 1. 审计时结论

- 新 Renderer 已固定为 React 19、TypeScript、Vite、Tailwind CSS v4、shadcn `radix-nova` 与 Radix UI；`shadcn info` 报告 `base: radix`，未采用 Base UI。
- 三栏 App Shell 已使用 `Resizable`、`Sidebar`、`ScrollArea`、`Accordion`、`Tabs` 等正式 shadcn/Radix 组件，并具备栏宽持久化、两栏折叠、skip link 与方向键导航基线。
- 当前新 Renderer 仍以模拟数据为主，不等同于业务迁移完成；项目、环境、插件、Runbook、快捷提问、审计、确认与连接流程尚未全部挂入正式壳层。
- `src/main.mjs` 仍加载旧 `renderer/v2/index.html`。这是正确的迁移中状态；业务、测试和打包门槛完成前不得提前切换。
- 旧 UI 的生产行为由约 6200 行 `app.js` 与 3130 行 `styles.css` 承载。删除前必须逐项迁移其业务合同，而不是只复刻截图。
- preload 暴露的 58 项 `window.aiOps.v2` API 已有严格 TypeScript 合同与同步测试；本次不修改 preload、IPC、V2 Service 或安全边界。

## 2. 组件覆盖矩阵

| 界面职责 | 当前组件 | 结论 | 本轮动作 |
| --- | --- | --- | --- |
| 三栏尺寸调整 | `ResizablePanelGroup`、`ResizablePanel`、`ResizableHandle` | 已采用正式 Radix | 保留键盘合同，补生产数据后的回归 |
| 项目栏 | `Sidebar`、`ScrollArea`、`ContextMenu`、`DropdownMenu`、`Tooltip` | 组件已覆盖，仍绑定 fixture | 接入真实只读数据及新增/重命名/排序/删除 |
| 环境与插件栏 | `Accordion`、`ScrollArea`、菜单组件 | 环境已覆盖；插件行仍有原生按钮 | 统一为 shadcn Button/Item 语义并接入业务 |
| 详情导航 | `Tabs` | 已采用 Radix，紧凑变体仍散落业务类名 | 固化高密度变体并挂载真实 feature |
| 命令面板 | `Command`、`Dialog` | 已覆盖 fixture 范围 | 改为真实作用域导航，不执行变更 |
| 新增/编辑表单 | `Dialog`、`Sheet`、`Field`、输入组件 | 当前多为模拟 surface | 迁移项目/环境/插件真实表单 |
| 强确认 | `AlertDialog` | 模拟覆盖 | 迁移删除、HostKey、TLS、认证类型等强确认 |
| 状态反馈 | 自定义 span + `Badge` | 状态语义存在但不统一 | 统一 `Badge`、`Alert`、`Skeleton`、`Sonner` |
| 空状态 | 裸 `div/section` | 未完全组件化 | 使用正式 `Empty`，保留语义与操作入口 |
| 事实与审计列表 | `Table` | 仅 fixture 示例 | 接入环境状态与审计分页结果 |
| 布尔设置 | 临时控件/Checkbox | 缺正式 Switch | 使用 Radix `Switch`，危险变更仍需确认 |
| 内容分组 | `Collapsible`、`Accordion` | 已覆盖 | 保留，只在真实层级需要时使用 |
| 通知 | `Sonner` | 已覆盖模拟操作 | 仅显示稳定、脱敏、可行动结果 |

本轮新增的官方 shadcn Radix-Nova 源文件为 `alert.tsx`、`card.tsx`、`switch.tsx` 与 `empty.tsx`。它们从官方 Radix registry 逐项引入，未运行 Base UI 初始化，也未覆盖已有定制 primitive。

## 3. 必须保留的交互与安全合同

- 项目 → 环境 → 插件的精确作用域；删除或切换时不得静默跳到另一作用域执行操作。
- 当前项删除、迟到请求、并发验证和事件推送均需 generation/correlation/freshness 防护。
- 两处分隔线支持指针和键盘调整，项目栏与详情栏可折叠，宽度与折叠状态持久化。
- skip link、方向键导航、焦点恢复、对话框焦点陷阱、Escape 与离开未保存表单保护。
- 凭据只通过既有安全 API 处理；不得进入 React state 的长期持久化、日志、测试快照、错误或报告。只有用户显式输入的非空替换值才可发送。
- 不自动连接，不自动信任 HostKey，不绕过确认，不扩大数据库、命令、文件或缓存策略。
- 后端返回的 Runbook、日志、错误与操作文本只按普通文本渲染，不解释为指令，不使用 `dangerouslySetInnerHTML`。

## 4. 精确文件级实施清单

### 4.1 设计体系与 App Shell

- `renderer/v2/src/styles/globals.css`
- `renderer/v2/src/components/ui/{alert,card,empty,switch,tabs,badge,button}.tsx`
- `renderer/v2/src/components/app-shell/{AppShell,GlobalCommand,StatusIndicator}.tsx`
- `renderer/v2/src/components/project-rail/ProjectRail.tsx`
- `renderer/v2/src/components/resource-pane/ResourcePane.tsx`
- `renderer/v2/src/components/detail-workspace/DetailWorkspace.tsx`
- `renderer/v2/src/state/layout-state.ts`

### 4.2 真实只读工作区

- `renderer/v2/src/features/workspace/{workspace-read-model,use-workspace-overview,use-environment-status,selection-reducer}.ts`
- `renderer/v2/src/features/projects/ProjectOverview.tsx`
- `renderer/v2/src/features/environments/EnvironmentOverview.tsx`
- `renderer/v2/src/features/plugins/PluginOverview.tsx`
- `test/renderer-read-model-contract.test.mjs`

### 4.3 业务功能

- `renderer/v2/src/features/projects/*`
- `renderer/v2/src/features/environments/*`
- `renderer/v2/src/features/plugins/*`
- `renderer/v2/src/features/connections/*`
- `renderer/v2/src/features/runbooks/*`
- `renderer/v2/src/features/quick-questions/*`
- `renderer/v2/src/features/audit/*`
- `renderer/v2/src/features/confirmations/*`
- 对应 `test/renderer-*-feature.test.mjs` 与状态模型测试

### 4.4 正式入口、测试与打包

- `renderer/v2/react.html` 最终迁移为唯一源入口 `renderer/v2/index.html`
- `renderer/v2/app.js`、`renderer/v2/styles.css` 在合同迁移与回归通过后删除
- `src/main.mjs`
- `package.json`
- `pnpm-lock.yaml`（仅依赖图实际变化时）
- `.gitignore`
- `scripts/ui-react-foundation-smoke.cjs`（升级为生产 React smoke）
- `scripts/ui-three-pane-smoke.cjs`（迁移合同后删除或替换）
- `scripts/verify-package.mjs`
- `scripts/packaged-ui-smoke.cjs`（新增）
- `scripts/install-upgrade-smoke.ps1`
- `.github/workflows/release.yml`
- 与旧 DOM 强绑定的 `test/renderer-*.test.mjs`，改为 React feature/state 合同测试

明确禁止修改：`src/preload.cjs`、`src/ipc-v2.mjs`、`src/v2-service.mjs`、凭据/确认/命令/数据库安全模块、版本、产品名、MCP 身份与兼容目录/管道标识。若实施发现必须修改其中任一项，应停止并单独提交影响说明。

## 5. 审计时基线

- `corepack pnpm run check:renderer:next`：通过
- `corepack pnpm run build:renderer:next`：通过；仅有已知的单 bundle 大于 500 kB 警告
- `corepack pnpm run test:ui:renderer-next`：通过
- React bridge/foundation/App Shell 合同：3/3 通过
- `corepack pnpm run check`：通过
- `corepack pnpm test`：485/485 通过
- `corepack pnpm run test:ui`：旧 UI smoke 通过

## 6. 正式切换硬门槛

只有同时满足以下条件才允许切换 `src/main.mjs`：

1. 旧 UI 的项目、环境、插件、Runbook、快捷提问、审计、确认、凭据、连接与删除合同均有 React 实现和聚焦测试。
2. 58 项 preload 类型同步仍通过，且没有新增绕过 bridge 的调用。
3. 三种窗口尺寸、浅色/深色、键盘、焦点、无页面级横向溢出均通过。
4. React 生产 smoke、完整 `check`、`test`、`test:ui` 全绿。
5. 构建产物只包含新 Renderer；包验证断言新资源存在且旧 `app.js/styles.css` 不存在。
6. 解包 UI smoke、packaged MCP smoke 与安装升级 smoke 通过。

切换后如果任一门槛失败，保留失败证据并修复，不以恢复旧 UI 作为隐式完成。
