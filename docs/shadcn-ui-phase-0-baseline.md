# shadcn/ui 重构阶段 0 基线冻结报告

> 对应计划：`docs/shadcn-ui-full-rewrite-plan.md`
>
> 执行日期：2026-08-29
>
> 结论：通过。当前 UI 行为、截图、测试、preload API 和 Electron 安全边界已形成可比较基线；阶段 0 没有修改生产代码。

## 1. 执行范围与结果

本阶段只做只读审计、测试执行、隔离截图和文档记录，未修改 `src/`、`renderer/v2/`、`scripts/`、`test/`、`package.json` 或 `pnpm-lock.yaml`。

阶段 0 开始时的工作树为：

```text
## main...origin/main
?? .agents/
?? .codex/
?? PRODUCT.md
?? docs/shadcn-ui-full-rewrite-plan.md
```

其中 `.agents/`、`.codex/` 和 `PRODUCT.md` 是执行前已经存在的用户未跟踪内容，本阶段未读取后改写、未移动、未删除。重构计划文档也保持原样。

运行环境：

| 项目 | 基线值 |
| --- | --- |
| 操作系统 | Windows |
| Node.js | `v24.12.0` |
| pnpm | `11.21.0`，通过 Corepack |
| Electron | `^43.3.0` |
| 正式 Renderer | `renderer/v2/index.html` |
| 正式入口 | `src/main.mjs` |

## 2. 测试基线

| 命令 | 结果 | 基线摘要 |
| --- | --- | --- |
| `corepack pnpm run check` | 通过 | 所有当前 JavaScript/CJS 语法检查通过 |
| `corepack pnpm test` | 通过 | 482 项测试，482 通过，0 失败，0 取消，0 跳过，0 TODO |
| `corepack pnpm run test:ui` | 通过 | `Three-pane UI smoke passed` |

用于生成每一组截图的 UI smoke 也分别通过。截图和 smoke 使用 `scripts/ui-three-pane-smoke.cjs` 的临时数据根和模拟 IPC，没有连接真实基础设施。

### 2.1 阶段 0 失败项

无。

当前没有需要在进入阶段 1 前豁免的红灯，也没有需要与后续重构失败区分的既有测试失败。

## 3. 截图基线

截图未写入仓库。可比对副本保存在：

```text
C:\Users\taotao\.codex\visualizations\2026\08\29\01a04c5d-8f29-72e0-91ca-1500f14c2a1a\ui-baseline
```

原始临时输出保存在：

```text
C:\Users\taotao\AppData\Local\Temp\runbook-bridge-ui-baseline-2026-08-29
```

| 文件 | 冻结状态 |
| --- | --- |
| `projects.png` | 完整三栏、项目列表、全局确认入口、环境与插件树、插件详情 |
| `resources.png` | 项目栏和详情栏折叠、资源栏扩展、长资源列表与内部滚动 |
| `project.png` | 项目概览、环境与插件汇总、需要处理、重命名和删除 |
| `environment.png` | 环境概览、插件状态、环境资料、运维说明入口和环境 Tabs |
| `connection.png` | Server 插件连接事实、认证、地址、Host Key、路径和连接动作 |
| `configuration.png` | 插件只读配置、安全提示、显式编辑、重命名和删除 |
| `edit-form.png` | 插件编辑会话、凭据替换、数据库发现、高级设置和保存策略 |
| `quick-questions.png` | 快捷提问开场语、日期、问题输入、常见问题和复制流程 |
| `confirmation.png` | 全局确认队列、高风险 Shell、完整参数、强确认、拒绝和单次确认 |
| `audit.png` | 插件范围操作记录、搜索、筛选、状态和清理入口 |

### 3.1 当前视觉与布局事实

- 当前界面是深色、高密度桌面工作台，主要使用冷灰背景、紫色选中/强调色，以及绿、黄、红语义状态色。
- 页面由项目栏、环境与插件栏、详情工作区组成；项目栏和详情栏可折叠，两处分隔线可调整栏宽。
- 项目栏同时承载全局操作确认入口、项目状态、项目选择、排序和新增项目。
- 第二栏按环境组织插件，插件不会脱离环境成为全局列表；Server、MySQL、Redis 在环境内分组展示。
- 第三栏根据项目、环境、插件或全局确认选择切换详情，并在栏内滚动。
- 当前设计大量使用有描边的卡片和紫色轮廓；这属于视觉基线，不是新设计必须复制的结构。
- 资源较多时第二栏会明显变长，因此新 UI 必须保留独立滚动、明确作用域和固定/可发现的新增入口。
- 最小窗口基线由主窗口的 `960×640` 下限和 UI smoke 的 `960×720` 紧凑场景共同约束；阶段 2 还需补齐计划要求的精确 `960×640` 行为测试。

## 4. 冻结的三栏产品行为

以下是重构时必须以用户可观察行为保留的合同。新 UI 不需要复制旧 DOM、类名、卡片数量或具体像素，但不能丢失这些能力。

### 4.1 第一栏：项目

- 加载并显示项目列表，明确区分当前项目、连接状态和需要处理状态。
- 点击项目切换最高层作用域，并同步更新第二栏及第三栏选择。
- 支持新增、重命名、删除项目。
- 支持项目排序，并保留当前键盘排序能力。
- 提供项目栏折叠、展开和宽度调整。
- 显示全局操作确认入口及待确认数量。
- 项目切换只改变作用域，不隐式发起首次外部连接。

### 4.2 第二栏：环境与插件

- 只显示当前项目下的环境；支持新增、选择、重命名、删除和排序环境。
- 环境可展开并显示其 Server、MySQL、Redis 插件及状态。
- 点击环境在第三栏打开环境详情；点击插件在第三栏打开插件详情。
- 新增插件必须绑定一个明确环境，不得以无作用域的全局动作存在。
- 保留环境连接、断开、重试，以及单插件连接、断开、编辑和删除的现有语义。
- 保留 configured、disconnected、connecting、connected、partial、blocked、error 等状态的文字/图标反馈，不能只依赖颜色。
- 项目栏和详情栏折叠后，第二栏可获得更多宽度，并保持自身滚动和底部新增入口可用。

### 4.3 第三栏：详情工作区

| 当前选择 | 默认内容 | 当前可观察能力 |
| --- | --- | --- |
| 项目 | 项目概览 | 环境/插件汇总、需要处理、状态清单、重命名、删除 |
| 环境 | 环境概览 | 插件状态、资料、运维说明、操作记录、快捷提问、环境操作 |
| 插件 | 插件详情 | 连接事实、配置、Agent 权限、操作记录、连接/编辑/删除 |
| 全局确认 | 操作确认中心 | 筛选、参数核对、普通/强确认、拒绝、单次确认 |

当前 Tabs 基线：

- 项目：`项目信息`。
- 环境：`概览`、`运维说明`、`环境操作记录`、`快捷提问`。
- 插件：`插件详情`、`配置`、`Agent 权限`、`操作记录`。

Tabs 的文案和页面分组允许在新设计中调整，但其承载的功能不能消失。

### 4.4 编辑、连接和安全确认

- 插件新增按 Server、MySQL、Redis 类型展示专属字段，并经历检查/验证后才创建。
- 插件配置默认只读，编辑必须显式进入连接编辑会话；取消应丢弃未保存内容并按现有语义恢复连接。
- 密码等凭据默认保持不变，只有显式替换才提交新值；旧凭据迁移和瞬时查看仍需走现有确认。
- 支持验证进度、取消验证、Host Key/TLS 挑战、数据库发现，以及保存但不连接、保存并连接等现有策略。
- 连接由明确用户动作发起，并继续经过现有 connection intent、operation gate 和 confirmation binding。
- 高风险确认必须完整显示项目、环境、插件、能力和参数；Shell 强确认必须显示完整命令并要求额外核对。
- 确认只可单次使用；参数或目标状态改变后不得复用旧确认。

### 4.5 运维说明、快捷提问和审计

- 运维说明保留读取、编辑、取消、保存和 revision 冲突语义。
- 快捷提问保留开场语、日期、问题输入、常见问题、保存/删除和复制流程。
- 操作记录必须明确其项目、环境或插件作用域，保留加载、筛选、搜索和清理能力。
- 运维文本、远端输出、日志、配置和数据库内容继续作为不受信任的运维数据处理，不得被当作 UI 或 Agent 指令。

### 4.6 可访问性与窗口行为

- 保留 skip link、可见键盘焦点、键盘项目排序和主要操作的键盘可达性。
- Dialog、确认、表单错误和异步状态必须保持焦点与可感知反馈。
- 主窗口下限保持 `960×640`；常用基线为 `1280×820`，UI smoke 截图使用 `1280×900`。
- 紧凑窗口不出现页面级横向溢出；折叠和栏宽调整不能使主要操作永久不可达。

## 5. preload API 基线

`src/preload.cjs` 当前通过 `window.aiOps.v2` 暴露 58 个公共方法或事件订阅。阶段 1 默认完整冻结名称、参数和返回值；即使旧 Renderer 当前没有直接调用，也不得顺手删除。

```text
approveConfirmation
assessPlugin
beginPluginConnectionEdit
cancelEnvironment
cancelPluginConnectionEdit
cancelPluginProbe
cancelPluginValidation
clearAudit
confirmConnectionChallenge
confirmCredentialMigration
connectEnvironment
connectPlugin
copyQuickQuestion
createEnvironment
createPlugin
createProject
credentialStatus
deleteEnvironment
deletePlugin
deleteProject
deleteQuickQuestion
disconnectEnvironment
disconnectPlugin
environmentStatus
getQuickQuestionOpening
listAudit
listConfirmations
listEnvironments
listPluginDatabases
listPlugins
listProjects
listQuickQuestions
notifyNetworkChanged
onConfirmations
onEnvironmentStatus
onPluginProbeProgress
onPluginValidationProgress
onWorkspaceChanged
preparePluginConnectionEdit
probePluginDraft
readRunbook
rejectConfirmation
reorderEnvironments
requestConnectionIntent
retryEnvironment
revealCredential
savePluginConnectionEdit
saveQuickQuestion
saveQuickQuestionOpening
saveRunbook
updateEnvironment
updatePlugin
updatePluginAgentConfiguration
updatePluginConnection
updatePluginMetadata
updateProject
validatePluginDraft
workspaceOverview
```

旧 Renderer 在 `renderer/v2/app.js` 中直接使用其中 46 个。以下 12 个属于当前公共兼容面，但没有在该文件中直接调用：

```text
assessPlugin
cancelEnvironment
connectEnvironment
connectPlugin
disconnectEnvironment
disconnectPlugin
listPluginDatabases
listProjects
onPluginProbeProgress
retryEnvironment
updatePlugin
updatePluginConnection
```

这些方法可能由兼容流程、安装/升级验证或其他调用方依赖。任何退休都必须是独立的公共契约变更，并同步 IPC、文档、测试和 packaged smoke；不属于 UI 重构阶段 1。

### 5.1 页面到 API 族的基线映射

| UI 范围 | 当前 API 族 |
| --- | --- |
| 工作区加载与三栏导航 | `workspaceOverview`、`listEnvironments`、`listPlugins`、`environmentStatus`、`onWorkspaceChanged`、`onEnvironmentStatus` |
| 项目管理 | `createProject`、`updateProject`、`deleteProject`、`reorderEnvironments` |
| 环境管理 | `createEnvironment`、`updateEnvironment`、`deleteEnvironment` |
| 插件资料与 Agent 权限 | `updatePluginMetadata`、`updatePluginAgentConfiguration`、`deletePlugin` |
| 插件新增/编辑/验证 | `credentialStatus`、`revealCredential`、`confirmCredentialMigration`、`probePluginDraft`、`validatePluginDraft`、取消 API、连接编辑会话 API、`confirmConnectionChallenge`、`createPlugin` |
| 连接操作 | `requestConnectionIntent`、`environmentStatus`、`notifyNetworkChanged` |
| 运维说明 | `readRunbook`、`saveRunbook` |
| 快捷提问 | `getQuickQuestionOpening`、`saveQuickQuestionOpening`、`listQuickQuestions`、`saveQuickQuestion`、`deleteQuickQuestion`、`copyQuickQuestion` |
| 操作记录 | `listAudit`、`clearAudit` |
| 操作确认中心 | `listConfirmations`、`approveConfirmation`、`rejectConfirmation`、`onConfirmations` |

## 6. Electron、安全与打包基线

这些边界在 React/shadcn/ui 重构中不是视觉选择，必须保持：

| 合同 | 当前基线 |
| --- | --- |
| 主窗口 | `1280×820`，最小 `960×640` |
| 正式页面 | `src/main.mjs` 加载 `renderer/v2/index.html` |
| preload | `src/preload.cjs` |
| Renderer 隔离 | `contextIsolation: true` |
| Node 集成 | `nodeIntegration: false` |
| Chromium sandbox | `sandbox: true` |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` |
| 外部资产 | 不允许；生产 Renderer 必须使用本地构建文件 |
| Electron Builder | 当前包含 `renderer/v2/**/*`、`src/**/*`，并明确排除 `!src/mcp.mjs` |

阶段 1 不得修改 `src/main.mjs` 的正式加载点，不得放宽 CSP，不得开启 Node integration，不得移除 sandbox 或 context isolation，不得恢复 legacy renderer 或 `src/mcp.mjs`。

## 7. 已知技术债与迁移风险

以下不是阶段 0 失败，而是后续阶段需要主动控制的风险：

| 风险 | 当前事实 | 控制方式 |
| --- | --- | --- |
| 单体 Renderer | `renderer/v2/app.js` 约 6,219 行，包含 56 个 `render*` 函数和大量事件绑定 | 以 feature、bridge、state 和 UI primitive 拆分，不逐行翻译旧 DOM 状态机 |
| 单体样式 | `renderer/v2/styles.css` 约 3,130 行 | 用语义 token 和有限组件变体重建，不迁移覆盖链 |
| UI 契约耦合实现 | `test/ui-contract.test.mjs` 包含不少源代码字符串/正则断言 | 新旧 Renderer 并行期间保留旧断言；后续按阶段替换为用户可观察行为测试 |
| API 类型缺失 | preload 是运行时公共面，没有 Renderer 侧统一 TypeScript 合同 | 阶段 1 建立只描述公共面、不复制凭据数据的类型声明和薄封装 |
| 双 Renderer 过渡 | 阶段 1 至生产切换前会暂时存在旧正式 UI 和新独立入口 | 明确区分生产入口与试验入口；阶段 8 一次切换并删除旧实现，避免长期双状态机 |
| 最小尺寸差异 | 主窗口下限是 `960×640`，现有 smoke 的紧凑场景是 `960×720` | 阶段 2 增加精确 `960×640` shell 行为验证 |
| 视觉密度 | 资源多时第二栏信息量和滚动长度较大 | 阶段 2 使用层级、独立滚动、作用域内新增入口和可折叠环境控制密度 |

## 8. 阶段 1 精确文件级实施计划

阶段 1 的目标是建立可以在 Electron 中独立启动的 React Renderer 基础，不迁移业务页面、不切换正式 UI。以下文件清单是实施边界；实际执行阶段 1 前仍需再次记录工作树并确认依赖版本。

### 8.1 修改文件

| 文件 | 精确改动 | 不得发生 |
| --- | --- | --- |
| `.gitignore` | 新增 `renderer-build/`，用于忽略 Vite 生成目录 | 不改现有本地数据和密钥忽略规则 |
| `package.json` | 增加 React/React DOM 运行依赖；增加 TypeScript、Vite、React Vite 插件、Tailwind、类型包和最小 shadcn 依赖；增加 `build:renderer:next`、`check:renderer:next`、`test:ui:renderer-next` 脚本；让总 `check` 能检查新 TypeScript 基础 | 不改版本号、产品名、bin、MCP 身份、`start`、正式 `test:ui`、`dist` 或 Builder 正式文件清单 |
| `pnpm-lock.yaml` | 只由上述依赖图生成更新 | 不手工编辑，不做无关升级 |

### 8.2 新增构建与 shadcn 配置

| 文件 | 职责 |
| --- | --- |
| `renderer/v2/react.html` | 新 Renderer 独立 HTML 入口；保留同等严格 CSP，只含本地模块入口和 `#root`；不替换 `index.html` |
| `renderer/v2/vite.config.ts` | 以 `renderer/v2/react.html` 为输入，使用相对资产路径，输出到仓库根的 `renderer-build/v2/` |
| `renderer/v2/tsconfig.json` | Renderer 严格 TypeScript 配置、DOM 类型和 `@/*` 路径别名 |
| `renderer/v2/components.json` | shadcn/ui 的 Tailwind、CSS、别名、组件与工具目录配置 |

### 8.3 新增 React 基础源文件

| 文件 | 职责 |
| --- | --- |
| `renderer/v2/src/main.tsx` | React 根挂载；不包含业务请求和全局事件状态机 |
| `renderer/v2/src/app/App.tsx` | 只呈现基础启动页/诊断壳，用于验证主题和 preload 可达性；阶段 2 才实现三栏 App Shell |
| `renderer/v2/src/app/providers.tsx` | 根主题、错误边界和应用级上下文入口；不引入全局状态库 |
| `renderer/v2/src/bridge/ai-ops-v2.ts` | `window.aiOps.v2` 的严格类型、存在性检查和薄封装；不缓存凭据，不改变参数或返回值 |
| `renderer/v2/src/types/global.d.ts` | 声明 `Window.aiOps.v2`，与 58 项 preload 公共面保持同步 |
| `renderer/v2/src/lib/utils.ts` | shadcn class 合并工具，不放业务逻辑 |
| `renderer/v2/src/styles/globals.css` | Tailwind 入口、语义颜色 token、Segoe UI/等宽字体、focus-visible、reduced-motion、深浅主题基础 |
| `renderer/v2/src/components/ui/button.tsx` | 第一项最小 shadcn primitive，用于验证 variants、键盘焦点和 token |
| `renderer/v2/src/components/ui/tooltip.tsx` | 验证 Radix/shadcn portal、CSP 和焦点行为的最小覆盖；仅在启动 smoke 确实需要时加入 |

阶段 1 不创建 project、environment、plugin、confirmation 等业务 feature 文件；这些从阶段 2/3 开始按功能迁移。

### 8.4 新增验证文件

| 文件 | 精确验证内容 |
| --- | --- |
| `scripts/ui-react-foundation-smoke.cjs` | 使用隔离临时数据和模拟 IPC 创建与生产同安全参数的 BrowserWindow，加载 `renderer-build/v2/react.html`，验证本地资产、React 挂载、preload 可达、CSP、无外部请求和基础键盘焦点 |
| `test/renderer-bridge-contract.test.mjs` | 对比 `src/preload.cjs` 与 `global.d.ts`/bridge 的 58 项名称，防止漏项、擅自改名或额外暴露 |
| `test/renderer-foundation-contract.test.mjs` | 检查独立入口、严格 CSP、相对本地资产、输出目录和未切换正式 `loadFile()` |

### 8.5 阶段 1 明确保留不动的文件

| 文件 | 原因 |
| --- | --- |
| `src/main.mjs` | 正式 `loadFile()` 和安全窗口参数保持基线，阶段 1 不切换生产入口 |
| `src/preload.cjs` | 58 项公共 API 保持原样；只在 Renderer 侧补类型 |
| `src/ipc-v2.mjs`、`src/v2-service.mjs` | 不改变 IPC 或服务契约 |
| `renderer/v2/index.html` | 继续作为正式入口 |
| `renderer/v2/app.js`、`renderer/v2/styles.css` | 继续提供正式旧 UI，直到阶段 8 通过验收后删除 |
| `scripts/ui-three-pane-smoke.cjs` | 继续作为冻结的旧 UI 行为基线 |
| `test/ui-contract.test.mjs` | 继续守护正式旧 UI；不得为了新结构提前放宽 |
| Electron Builder `build.files` | 阶段 1 不把试验入口打进正式包，生产打包切换留到阶段 8 |

### 8.6 依赖引入规则

- shadcn/ui 组件是生成到仓库的源代码，不把组件网站或 CDN 引入 Renderer。
- 只增加阶段 1 真正使用的最小依赖；React、构建链、class 合并和一个图标家族各只选一套。
- 不增加全局状态库、表单库、数据请求库或动画库。
- 每个新增生产依赖都在阶段 1 交付报告中说明用途；锁文件只随依赖图变化。

### 8.7 阶段 1 验证命令与通过条件

建议迭代顺序：

```powershell
corepack pnpm run check:renderer:next
corepack pnpm run build:renderer:next
corepack pnpm run test:ui:renderer-next
node --test test/renderer-bridge-contract.test.mjs test/renderer-foundation-contract.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
```

只有同时满足以下条件才进入阶段 2：

1. 新 Renderer 从本地构建资产在 Electron 内挂载成功。
2. `window.aiOps.v2` 的 58 项公共面均有严格类型并通过同步测试。
3. CSP、sandbox、context isolation 和 Node integration 基线没有回退。
4. 正式 `src/main.mjs` 仍加载旧 `renderer/v2/index.html`，旧 UI smoke 仍通过。
5. 新旧两套测试均通过，完整 482 项既有测试没有回归。
6. `renderer-build/` 没有进入 Git diff 或正式安装包。
7. 没有凭据、真实基础设施地址、日志或本地应用数据进入源文件、测试输出或截图。

## 9. 阶段 0 完成检查

- [x] 记录开始工作树并保留用户已有修改。
- [x] `check`、完整测试和 UI smoke 全部通过。
- [x] 三栏及关键详情/编辑/确认页面已有截图基线。
- [x] 当前 UI 行为已整理为用户可观察合同。
- [x] 58 项 preload API 已冻结并区分当前直接使用面。
- [x] Electron 安全、CSP、窗口和打包边界已记录。
- [x] 失败项已明确为无。
- [x] 阶段 1 已拆分为具体文件和验证条件。
- [x] 阶段 0 未修改生产代码。
