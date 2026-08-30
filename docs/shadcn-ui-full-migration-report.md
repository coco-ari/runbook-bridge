# shadcn/ui + Radix UI 全量前端迁移报告

全量迁移与弹层专项治理完成日期：2026-08-30。

本文保留迁移阶段的历史结果。后续插件生命周期修复及最终交付验证见 [全功能检查记录](./full-function-verification.md)，其中的最新结果优先。

适用仓库：`runbook-bridge`

状态：本轮弹层专项治理已完成。正式入口切换与旧 Renderer 删除沿用上一轮已完成结果，未重做迁移；当前源码通过512项测试、深浅双主题三层Electron、192张截图及新Windows安装包/包内MCP/UI验证。逐弹层评估见 [弹层专项治理](./shadcn-ui-overlay-governance.md)。

> CI结论仅表示仓库工作流已接入、本地等价命令通过；不声称本次会话触发过远端GitHub Actions。包验证不是安装/升级回归，本轮没有重新执行安装/升级测试。

## 1. 已完成迁移的稳定结论

- 桌面 UI 已统一为 React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui + Radix UI。
- 在 `renderer/v2` 目录执行 `shadcn info`，结果为 `style: radix-nova`、`base: radix`；当前共有 37 个正式 UI primitive，没有采用 Base UI。
- 项目、环境、插件三栏信息架构保留，但 App Shell、资源导航、详情工作区、视觉层级和交互组件均已重新实现，没有继续运行旧 `app.js` DOM 状态机或复用旧 `styles.css` 视觉体系。
- Electron 正式加载 `renderer-build/v2/index.html`；`renderer/v2/index.html` 是唯一 Renderer 源入口，生成目录不手工编辑或提交。
- 安装包只包含哈希后的 React Renderer 产物，不包含 `renderer/v2` 源码或旧 UI。
- preload 的 58 项 `window.aiOps.v2` 合同保持不变；没有修改 IPC、V2 Service、凭据、命令、数据库或确认安全边界。
- 版本 `1.0.46`、产品名、应用名、CLI、MCP 身份、数据目录与 Broker pipe 均未改变。

## 2. shadcn/Radix 组件与依赖

### 2.1 组件库存

`renderer/v2/src/components/ui` 当前包含 37 个 primitive：

`accordion`、`alert`、`alert-dialog`、`badge`、`button`、`button-group`、`calendar`、`card`、`checkbox`、`collapsible`、`command`、`context-menu`、`dialog`、`dropdown-menu`、`empty`、`field`、`input`、`input-group`、`item`、`kbd`、`label`、`popover`、`progress`、`resizable`、`scroll-area`、`select`、`separator`、`sheet`、`sidebar`、`skeleton`、`sonner`、`switch`、`table`、`tabs`、`textarea`、`toggle-group`、`tooltip`。

关键声明依赖为 React `^19.2.8`、Radix 汇总包 `^1.6.7`、cmdk `^1.1.1`、react-resizable-panels `^4.12.3`、Sonner `^2.0.8`、Phosphor Icons `^2.1.10`、Tailwind CSS `^4.3.3`、Vite `^8.2.2` 和 TypeScript `^7.0.2`。正式 shadcn Date Picker 由 `Popover + Calendar` 组合，并新增 `react-day-picker` `^10.0.1` 与 `date-fns` `^4.4.0`；`@base-ui/react` 不存在于依赖图。

本轮弹层治理不新增或升级包，但不是依赖元数据零变更：正式键盘验收发现 `react-resizable-panels@4.12.3` 的第二处分隔线 ARIA 使用了错误的局部索引。增加 `patches/react-resizable-panels@4.12.3.patch`，仅修 ESM/CJS 两处为按主栏 ID 查找全局约束索引；`pnpm-workspace.yaml` 的 `patchedDependencies` 与 `pnpm-lock.yaml` 登记可复现补丁，`.gitattributes` 增加 `/patches/*.patch text eol=lf` 防止 Windows 换行转换改变补丁哈希。新增 `test/renderer-resizable-aria.test.mjs` 已4/4通过。仍使用 shadcn Resizable，不自建原生 handle；完整验证见第 9.2 节。

### 2.2 覆盖矩阵

| 界面职责 | 正式 shadcn/Radix 组件 | 最终用途 |
| --- | --- | --- |
| 三栏工作台 | ResizablePanelGroup、ResizablePanel、ResizableHandle | 两处分隔线、键盘调整、双击复位、项目栏和详情栏折叠、宽度持久化 |
| 第一栏项目导航 | Sidebar、ScrollArea、Tooltip、DropdownMenu、ContextMenu、Badge、Empty | 项目选择、新增、重命名、排序、删除、确认中心入口与状态展示 |
| 第二栏环境与插件 | Accordion、ItemGroup/Item、ScrollArea、DropdownMenu、ContextMenu、Button、Badge、Alert、Skeleton、Empty | 环境与插件选择、新增、重命名、排序、删除、分范围错误恢复和状态展示 |
| 全局导航 | Command、Dialog、Kbd | Ctrl/Cmd+K 搜索项目、环境和插件；Ctrl/Cmd+N 新建项目 |
| 详情工作区 | Tabs、ScrollArea、Collapsible、Card、Item、Table、Separator、Alert、Button、Tooltip | 项目、环境、插件概览与业务功能；内容宽度 Tabs、溢出箭头、键盘导航与当前项自动显露 |
| 项目与环境表单 | 紧凑 Dialog、独立 AlertDialog、Field、Input | 新增与短重命名保留 Dialog；删除菜单直达 AlertDialog，不经过设置或堆叠弹层 |
| 插件配置 | 第三栏工作区内 Field、Input、InputGroup、Select、Switch、Collapsible、ScrollArea、Progress；安全确认保留 AlertDialog | PluginEditorWorkspace 承载 Server/MySQL/Redis 长编辑流程，固定头尾、拓宽/恢复、折叠不卸载、草稿保护；不再使用编辑 Sheet |
| 连接控制 | Button、ButtonGroup、Alert、Badge、Skeleton、AlertDialog | 环境级和插件级连接、断开、重试、取消及依赖处理；Runtime Host Key 三个组件拥有者、四个实际入口共用错误留场、busy、Escape 拒绝与回焦的 RuntimeHostKeyDialog |
| Agent 权限 | Field、Switch、Table、Alert | 能力开关、资源限制、超时、配置错误与保存状态 |
| Runbook 与快捷提问 | Card、Field、Textarea、AlertDialog、Popover、Calendar、Button | Runbook 与问题/开场词在页面原位编辑；问题编辑不使用 Dialog/Collapsible，删除与放弃仍使用 AlertDialog；revision 绑定和日期选择/复制保持 |
| 审计与确认 | Table、ItemGroup/Item、Checkbox、ToggleGroup、AlertDialog、ScrollArea、Badge | 容器宽度响应式紧凑/表格布局、范围过滤、强确认、执行反馈和清除审计 |
| 状态与反馈 | Badge、Alert、Skeleton、Sonner、Empty、Button | 加载、空态、成功、警告，以及项目/环境/插件/运行状态分范围错误、缓存来源说明和原位重试 |

业务 feature 不直接导入 Radix primitive，也没有原生 `button`、`input`、`select`、`textarea` 或 `dialog` 绕过 shadcn 组件层。

## 3. 功能覆盖与证据边界

逐界面的 shadcn/Radix 组合、bridge 读写分类、Node/Electron 测试和截图状态见 [界面覆盖与证据矩阵](./shadcn-ui-surface-coverage.md)。该矩阵明确区分源码/Node contract、Electron 实际执行与视觉证据；没有独立 E2E 或最终截图的分支会标记为待补证，不用页面可见性替代 mutation 证明。

### 3.1 本轮实际执行的 Electron E2E

深色和浅色均使用相同Renderer产物，分别完整运行以下三层：

| Smoke | 实际覆盖 | 每主题结果 |
| --- | --- | --- |
| Foundation | 三栏、只读详情、菜单/Command交接、短Dialog、工作区离开保护、键盘/ARIA、两处分隔线和布局持久化、缩放与可访问性 | 23只读、0 mutation、0外部请求、0 Renderer/window/a11y错误 |
| Business | 项目create/update/conflict、环境create/update、Runbook保存、问题create/update/delete、opening冲突/重试、Audit清空失败/重试 | 13次精确mutation尝试，0禁止调用/外部请求/Renderer错误 |
| Plugin | 插件新增、Server三种保存策略、会话取消失败/重试、连接/确认、四入口Host Key错误/拒绝/信任重试、晚到挑战和Tooltip交接 | 97次精确scope-bound mutation，含32次Tooltip键盘挑战；0禁止调用/外部请求/Renderer错误，不记录凭据 |

项目/环境删除的Electron测试只走打开、受阻与取消，实际delete API始终禁止；不能把确认截图当作真实删除执行。

### 3.2 Node覆盖和E2E边界

默认与显式串行均512/512通过，覆盖Renderer状态/桥接、IPC/Service、安全和后端合同。以下仍主要由Node合同覆盖，没有声称每个分支都有独立Electron mutation E2E：

- 项目/环境实际删除、排序。
- 插件元数据与Agent权限保存、插件删除、MySQL/VPN/Tunnel专属分支、数据库发现、TLS、凭据迁移及独立验证/探测取消。
- Quick Question copy、Runbook迟到读取/部分冲突分支、确认拒绝/过期/跨范围隔离等。

完整边界见 [界面覆盖与证据矩阵](./shadcn-ui-surface-coverage.md)。

## 4. 键盘、布局与可访问性合同

下列合同已在本轮双主题Foundation与相关Business/Plugin路径验证；不将未执行的独立分支混入结论。

- skip link 聚焦唯一 `main` landmark；详情折叠时先展开再聚焦，目标使用 inset focus ring 提供明确的键盘焦点反馈。
- 项目与资源导航使用 roving tab stop；Tabs 支持方向键、Home、激活和焦点转移。
- 详情 Tabs 使用 Radix Tabs 与 shadcn Button 溢出控制；只有当前项使用翠绿填充，所有标签按内容对齐，窄栏下通过前后箭头和自动滚动保持当前项可见。
- 两处分隔线支持键盘调整，栏宽自动适应、Tab 导航时自动 resize/scroll，并在 reload 后恢复布局。
- Ctrl/Cmd+K 打开 Command；Ctrl/Cmd+N 新建项目。
- 保留的 Dialog 与 AlertDialog 已验证 initial focus、正反向焦点闭环及 Escape 关闭后的焦点恢复；插件编辑工作区明确非模态，可以键盘到达前两栏。Sheet 仅保留为共享 Sidebar 的响应式能力，不再承载长业务编辑。
- 960×640 下额外验证 125% 和 150% zoom，浮层、主要操作和三栏均没有越出 viewport。
- forced-colors 下当前项和当前 Tab 保留可见边界；prefers-reduced-motion 下动画、过渡与详情标签自动滚动均降为即时行为。
- 深色与浅色均验证选中项和详情正文对比度；状态同时使用文字、图标和语义色，不只依赖颜色。
- 960×640、1280×820、1680×980 均无页面级横向溢出。
- Audit 在窄详情栏使用 `ItemGroup/Item`，空间足够时切换为 `Table`；确认中心的参数明细同样按容器宽度在紧凑列表与表格之间切换，不依赖整窗宽度猜测。
- 项目列表、环境/插件列表和运行状态读取失败均保留各自 scope；有缓存时继续展示上次成功摘要并标明来源，无缓存时显示明确错误，均提供原位重试，不再把失败渲染成空数据。

## 5. 视觉体系与本轮截图

- `DESIGN_VARIANCE: 5`、`MOTION_INTENSITY: 3`、`VISUAL_DENSITY: 8`。
- 深色采用近黑分层表面与翠绿主色，选中控件用绿色文字/图标；浅色为冷中性表面与紫色主色。
- 保持三栏信息架构，不添加营销布局、背景发光、远程字体/图片或无意义动效。

截图根目录：`C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final`。实际192张，深浅色各96张；每主题Foundation35、Business33、Plugin28。两主题均对应 `index-DcdlPIOn.js` / `index-B74dzzo9.css`，不是旧版本截图。

每主题实际目视Foundation18、Business13、Plugin12张，合计86张重点图；未发现阻塞性遮挡、重叠或裁切。其余图由几何/行为断言覆盖，不声称全部192张逐张人工审阅。少数自然显示的Sonner未遮挡主要操作。

| 第三栏新增插件 | 深色 | 浅色 |
| --- | --- | --- |
| 960×640 | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/dark/workspace-plugin-create-dark-960x640.png) | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/light/workspace-plugin-create-light-960x640.png) |
| 1280×820 | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/dark/workspace-plugin-create-dark-1280x820.png) | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/light/workspace-plugin-create-light-1280x820.png) |
| 1920×1080 | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/dark/workspace-plugin-create-dark-1920x1080.png) | [截图](C:/Users/taotao/.codex/visualizations/2026/08/30/runbook-bridge-overlay-final/light/workspace-plugin-create-light-1920x1080.png) |

现有插件编辑同样有三尺寸双主题截图，模式为 `plugin-existing-plugin-editor-1-{theme}-{size}.png`；开场词/问题原位编辑还分别截取编辑区与底部操作区，错误留场、四入口Host Key和强确认均有独立证据。Shell宽屏尺寸为1680×980，编辑工作区宽屏为1920×1080。

上一轮94张截图保留为历史对照，位于同日期下的 `runbook-bridge-final-{dark|light}-v3`、`runbook-bridge-business-final-{dark|light}-v3` 和 `runbook-bridge-plugin-final-{dark|light}-v3`，分别28/8/11张每主题。旧Sheet与文本编辑Dialog已被替换，不用于本轮交付。

## 6. 正式入口与旧实现清理

### 6.1 正式入口

- `renderer/v2/index.html`：唯一 React 源入口和 CSP。
- `renderer/v2/vite.config.ts`：输出 `renderer-build/v2/index.html` 与哈希 JS/CSS。
- `src/main.mjs`：正式 `loadFile()` 指向 `renderer-build/v2/index.html`。
- `package.json`：`start`、三层 UI smoke 和 `dist` 自动构建 Renderer；打包包含 `renderer-build/v2` 并排除 `renderer/v2` 源码。

### 6.2 Git 中删除的旧实现

- `renderer/v2/app.js`
- `renderer/v2/styles.css`
- `renderer/v2/connection-view-model.js`
- `renderer/v2/plugin-catalog.js`
- `renderer/v2/quick-questions.js`
- `scripts/ui-three-pane-smoke.cjs`
- `test/renderer-resilience.test.mjs`
- `test/renderer-diagnostic-state.test.mjs`
- `test/connection-view-model.test.mjs`
- `test/quick-questions-renderer.test.mjs`

`test/ui-contract.test.mjs` 已重写为 React/shadcn/Radix 生产入口、安全与 tombstone 合同。

### 6.3 最终确认不存在的临时或兼容路径

以下路径是迁移期间的临时设计或 tombstone，最终确认不存在；它们并非全部曾是 Git tracked deletion：

- `renderer/v2/react.html`
- `renderer/v2/src/components/app-shell/MockActionSurfaces.tsx`
- `renderer/v2/src/components/detail-workspace/DetailWorkspace.tsx`
- `renderer/v2/src/fixtures/app-shell-fixtures.ts`
- `src/mcp.mjs`

阶段 1 保留的 `check:renderer:next`、`build:renderer:next` 和 `test:ui:renderer-next` 只是阶段报告/测试兼容别名，不代表还存在第二套 Renderer。

## 7. 测试与文件组织

- `renderer/v2/src/components/ui/*.tsx`：正式 shadcn Radix-Nova primitive 与有限项目变体。
- `renderer/v2/src/components/app-shell`、`project-rail`、`resource-pane`、`detail-workspace`：正式三栏壳层和统一 FeatureToolbar。
- `renderer/v2/src/features/workspace`、`projects`、`environments`、`plugins`、`connections`、`runbooks`、`quick-questions`、`audit`、`confirmations`：业务 feature 与纯状态模型。
- `renderer/v2/src/bridge`、`state`、`hooks`、`styles`：58 API 类型桥、布局持久化、键盘导航和主题 token。
- `scripts/ui-react-foundation-smoke.cjs`：正式 React 壳层、只读、三尺寸、双主题、zoom 与 a11y smoke。
- `scripts/ui-react-business-smoke.cjs`：低风险业务变更 smoke。
- `scripts/ui-react-plugin-operations-smoke.cjs`：插件新增、编辑、连接、Host Key 与确认 smoke。
- `scripts/packaged-ui-smoke.cjs`：打包后正式 EXE UI smoke。
- `test/renderer-*.test.mjs`：bridge、入口、导航、读模型、业务状态、表单关联、安全和三层 smoke 接线合同。

CI 与 Release workflow 已接入 `test:ui:all`；本报告只确认配置和本地等价命令通过，不声称已触发远端 workflow。

## 8. 安全、CSP 与静态扫描

本轮安全不变量保持不变，最终源码静态扫描及深浅双主题运行检查均已重新通过：

- Electron 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- CSP 保持 `default-src 'self'`、`script-src 'self'`、`connect-src 'none'`；脚本没有 `unsafe-inline` 或 `unsafe-eval`。
- 为 Radix 定位和尺寸兼容，仅 `style-src` 包含一次已批准的 `'unsafe-inline'`。
- Renderer 不直接使用 `ipcRenderer`、`contextBridge` 或 Node API；`window.aiOps` 只在严格类型 bridge 内访问。
- `src/preload.cjs`、`src/ipc-v2.mjs`、`src/v2-service.mjs` 与安全策略模块未修改。
- 业务源码原生交互控件扫描、业务源码直接 Radix import 扫描以及外部网络/`dangerouslySetInnerHTML` 扫描均为 0 匹配。三条 `rg` 命令退出码为 1，这是“无匹配”的预期结果，不是失败。
- 三层 Electron smoke 均使用隔离数据根与 mock，不连接真实基础设施；外部请求为 0。

## 9. 验证结果

### 9.1 迁移历史边界

正式入口切换与旧UI删除在上一轮完成。当时477/477、94张截图、三层smoke和Windows包验证通过；这些数字不作为本轮当前结果。

上一轮还执行过安装/升级回归：二次安装、隔离凭据与vault/YAML保持、卸载后AppData保留。本轮没有重新执行安装/升级回归；下面的新包结构/MCP/UI验证不等同于安装升级验证。

### 9.2 本轮弹层专项治理：已完成

- 插件新增/连接配置进入第三栏独立工作区；开场词/常见问题改Card/Field原位编辑。
- 项目/环境设置改紧凑Dialog，删除改菜单直达AlertDialog；短任务和安全决策保留适当模态。
- 三个Runtime Host Key组件拥有者、四个实际入口统一错误留场、busy、拒绝/信任、回焦与晚到挑战排队；不改变精确scope/revision/plan绑定。
- 全局命令、菜单、dirty guard、编辑会话取消和数据刷新使用统一生命周期。共享busy焦点接入13处Content，Runtime/Audit另有同等处理。
- Accordion动态内容、编辑footer、Tooltip观察生命周期和Resizable第二分隔线ARIA缺陷已修复。精确文件清单与逐项设计理由见 [弹层专项治理](./shadcn-ui-overlay-governance.md)。

统一产物：`index-DcdlPIOn.js` / `index-B74dzzo9.css`；JS1,059.66 kB（gzip293.75 kB），CSS147.97 kB（gzip21.98 kB）。

| 验证 | 本轮最终结果 |
| --- | --- |
| `corepack pnpm run check` | PASS；打包后再次运行通过 |
| `corepack pnpm test` | PASS：512/512，0 skip；打包后再次运行通过 |
| `corepack pnpm exec node --test --test-concurrency=1 test/*.test.mjs` | PASS：512/512，参数在文件列表前 |
| `corepack pnpm install --frozen-lockfile` | PASS：Already up to date |
| Resizable补丁回归/LF属性 | PASS：4/4，补丁哈希与LF规则一致 |
| 深浅双主题 `test:ui:all` | 每主题F23只读/0 mutation、B13精确mutation、G97精确scope-bound mutation；全部PASS，无诊断插桩 |
| Renderer/外部请求/禁止调用 | 双主题三层均0；Foundation额外0 window/a11y错误 |
| 键盘、缩放、ARIA与布局持久化 | PASS；无页面级横溢，两处分隔线方向/范围/存储/reload正确 |
| 截图与视觉复核 | 192张生成，86张重点逐张复核；三尺寸双主题无阻塞视觉问题 |
| 静态源码扫描 | 原生业务交互控件、业务直接Radix import、外部网络/危险HTML三项均0匹配 |
| `corepack pnpm run dist` | PASS：新生成 `Agent运维工作台 Setup 1.0.46.exe`，115,886,985 bytes |
| `verify-package.mjs` | PASS：1个哈希JS、1个哈希CSS；不包含Renderer源码/旧UI |
| `packaged-mcp-smoke.mjs` | PASS：35个结构化工具，archive runtime可用 |
| `packaged-ui-smoke.cjs` | PASS：58项preload API、空隔离工作区、0外部请求 |
| `git diff --check` 与生成物检查 | PASS；只有既有Git CRLF warning，无空白错误；生成目录无新增Git可见文件 |
| 安全后端与身份 | 指定后端安全文件diff为空，preload/IPC/Service/安全策略/版本与身份不变 |

包验证命令依次使用 `dist/win-unpacked/Agent运维工作台.exe`。本轮未连接真实基础设施，未将凭据、日志、真实数据或截图生成物加入仓库。

## 10. 失败项、覆盖限制与非阻断警告

当前最终验证失败项：无。并不表示全部业务分支都有独立Electron E2E；第3.2节和覆盖矩阵继续保留实际删除、专属凭据/TLS等分支的证据边界。

迭代记录保留如下：

- 默认Node曾出现SSH瞬态reconnecting等待失败；隔离16/16、最终默认和显式串行512/512均通过，未修改后端掩盖失败。
- Tooltip ResizeObserver、Accordion裁切、分隔线ARIA与焦点交接缺陷已修复并经双主题正式回归。几何与blur/refocus采样改为真实事件分帧，未过滤错误或放宽断言。
- 早期508被误称串行已纠正；最终串行只认第9.2节参数位置正确的512运行结果。
- 本轮包验证不包含重新安装/升级；上一轮安装升级结果仅作历史记录。

以下警告非阻断且未隐藏：

1. Vite单个JavaScript chunk超过500 kB；当前JS1,059.66 kB（gzip293.75 kB）。
2. Electron Builder使用默认Electron图标。
3. 打包出现duplicate dependency references；新包结构、MCP及UI验证均通过。

后续可独立安排代码分块和正式品牌图标；本次不以额外架构调整扩大弹层治理范围。
