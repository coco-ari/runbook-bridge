# 项目栏一致布局

更新日期：2026-08-30。展开和折叠共用同一套项目列表；新增项目、新增环境改用中性描边按钮，并删除项目栏顶部的折叠箭头。后续修复紧凑搜索文字裁切，以及环境卡片无法保持收起的问题。

## 搜索与环境卡片修复

- 搜索框的共享表单字体重置覆盖了原有字号，导致实际使用 16px。原生搜索框还预留清除控件空间，128px 项目栏内文字实际可用宽度小于外部输入框宽度。局部明确 12px 字号与 14px 图标，不影响其他表单，不通过缩短提示文字掩盖问题。
- 环境展开状态不能由每次摘要或运行状态刷新强制重设。普通刷新只移除已不存在的环境，保留手动展开/收起；项目切换或外部定位新的环境/插件时再展开相应环境。
- 项目身份先到、环境列表稍后可用时，只在首次可用时初始化选中环境或第一项；同一份可用环境列表后续刷新不重复初始化。
- 标题点击保留原生展开/收起行为，同时选择该环境详情；选中了环境内的插件不等于已经在环境详情中。从插件或其他范围点击环境标题，会经过现有未保存编辑保护并进入环境详情。已经位于该环境详情时，仅切换卡片展开状态，不重置当前页签；查看环境详情的菜单入口保留。

## 视觉与交互

- 两态项目行均为 36px 高、2px 间距，名称左对齐、单行省略，状态在右侧独立的 12px 槽位。收窄只减少名称可见宽度，不再切换图标、双行元信息或行高。
- 两态保持相同的标题、操作确认、搜索框、项目分组标题和列表起点，复用原有 DOM 节点；搜索文本与筛选结果跨折叠保留。列表选择、顺序和滚动不因模式改变而重建。
- “项目 / 数量”固定在搜索框与滚动列表之间，不再随列表滚动而在顶部露出半行。搜索后留 12px、标题行高 24px、标题下留 8px，标题左右 16px 与项目名称对齐；展开与折叠使用同一布局。
- 完整名称、环境数量、隔离说明与状态在 Tooltip 和可访问名称中保留；未连接使用静态 7px 空心圆。悬停、键盘聚焦或打开更多菜单时，右侧状态原位让给更多操作按钮；右键菜单保留。
- 新增项目、新增环境均为 40px 高的中性描边按钮，去掉绿色实底及绿色图标底块；两态样式和左侧内容位置一致。新增项目的 Ctrl+N 提示保留在 Tooltip，环境数量使用中性徽标。
- 顶部不再有展开/折叠箭头。保留 Ctrl+B / Cmd+B、第一条分隔线拖动、聚焦后 Enter/方向键，以及双击恢复 224px。分隔线新增悬停和读屏说明；小于 720px 时提示放大窗口。
- 保留 roving 键盘导航、快捷键输入框/弹窗避让、项目隔离与原有工作区范围。没有修改后端、IPC、凭据、安全策略、确认绑定或真实连接流程。

## 宽度与持久化

沿用已经验证的尺寸算法，不给拖动附加动画或改写布局偏好：

- 折叠宽度 128 CSS px，显示模式依据实际像素和 130px 判断阈值。
- 展开最小 176px，分隔线双击目标 224px。小于 720px 的窗口锁定项目栏为 128px，第二栏最小 184px，保留详情栏最小 320px。
- 主动调整与被动窗口压缩分别处理；窄窗不能覆盖正常窗口下保存的展开/折叠意图。窗口缩小再恢复、刷新和进程重启后恢复原有偏好。
- 插件编辑器的临时扩展不写入项目栏折叠偏好；退出后恢复布局。

## 修改范围

- `renderer/v2/src/components/project-rail/ProjectRail.tsx`
- `renderer/v2/src/components/resource-pane/ResourcePane.tsx`
- `renderer/v2/src/components/resource-pane/environment-expansion.ts` 及对应状态回归测试
- `renderer/v2/src/components/app-shell/AppShell.tsx`（分隔线说明）
- 导航、App Shell、分隔线契约测试，以及 `scripts/ui-react-foundation-smoke.cjs`
- `scripts/packaged-ui-smoke.cjs` 及其契约测试
- `scripts/ui-react-plugin-operations-smoke.cjs`（保留菜单进入环境详情的覆盖；标题进入环境详情由 foundation smoke 覆盖）

保留原工作树其他改动；不改产品身份、版本、依赖或布局存储键。生成 Renderer 和软件包仅由构建命令生成，不手工修改或提交。

## 验证

```powershell
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run dist
node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"
```

界面测试使用合成数据或隔离临时空工作区，不连接真实基础设施，不复制截图中的用户项目数据。打包 smoke 使用实际帧捕获后再测量，避免隐藏窗口暂停绘制导致的旧几何数据；不修改生产后台节流、DPR 或 CSP。

### 此前验证结果（环境标题导航修复前）

- `check`、528 项自动测试和最终 17 项相关契约检查通过。
- 在旧构建上实际复现两处问题：搜索文字宽 64px、原生文本区域仅 55px；展开中的环境标题无法当次收起并意外改变详情。失败证据分别保存为 `old-search-regression.log`、`old-environment-regression.log`。
- 最终深色完整界面回归通过（36 次模拟只读调用）；浅色本轮专项通过（19 次模拟只读调用）。均无变更调用、外部请求、Renderer、窗口或无障碍错误。
- 通过 CDP 读取原生搜索框内部文本区域，而非仅测量外框。在 100%、125%、150% 缩放下，12px 搜索文字实测 48px，可用宽度约 60–60.67px；文字完整且不与图标重叠。
- 环境标题连续鼠标点击、Enter、Space 均可开关。非选中已展开环境也能当次收起；收起插件所属环境后保留插件详情和可见导航焦点，运行状态/摘要更新不会重新展开。外部定位环境/新插件、项目切换、首次异步载入均通过。
- 两态相同 DOM、纵向位置、36px 行高、搜索筛选、低强调新增按钮，以及 640/800/1280px 的拖动、键盘、刷新和宽度恢复检查继续通过。
- 插件操作完整回归通过：97 个精确范围的合成变更调用，保存、取消、未保存编辑保护、主机密钥和 Tooltip/确认框焦点交接均通过；未记录凭据。
- Windows x64 安装包生成成功；包内 JS/CSS 与本地生成 Renderer 哈希一致，未打包源 Renderer 或遗留入口。MCP smoke 的 35 个结构化工具和归档运行时通过。
- 实际软件包检查通过：253px → 128px → 253px，关闭并重启进程后恢复 128px，随后展开到 176px；搜索实测 12px 字号、48px 文字宽、约 59.51px 原生可用宽度。真实输入/清空、输入框内快捷键避让、同一输入节点、分隔线焦点、ARIA、58 个 preload API、CSP、临时空工作区及零外部请求均通过。

### 此前安装包和对照图（安装包已由本轮构建替代）

- 安装包：`dist/Agent运维工作台 Setup 1.0.46.exe`，115,887,202 字节，生成于 2026-08-30 22:33。
- SHA-256：`8E9303F73CC483D69D41B4FB04F25DC487379961FB5B918FCC4393DA87E457E3`。
- 本地构建未作 Authenticode 签名，未自动安装或覆盖用户数据。直接运行需保留完整的 `dist/win-unpacked/` 目录。
- [展开效果（深色）](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-search-environment/app-shell-project-expanded-clean-dark-1280x820.png)
- [折叠与搜索效果（深色）](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-search-environment/app-shell-project-collapsed-clean-dark-1280x820.png)
- [环境收起后保留插件详情（深色）](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-search-environment/environment-collapsed-dark-960x640.png)

对照图使用同一模拟项目顺序和选中范围，仅移开分隔线焦点后捕获真实页面。原始带焦点检查截图同时保留；两套截图都包含深浅主题。没有编辑或重绘截图。

证据目录：`C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-search-environment/`。

## 本轮项目标题留白修复

“项目 / 数量”从列表滚动区域移到搜索与列表之间的固定区域，解决搜索、标题和首项挤在一起，以及滚动时标题只露半行的问题。不改变项目行高、项目顺序、搜索、选择或折叠状态。

- `check` 和 528 项测试通过。共享工作区最新源码的深色完整 UI 回归通过（41 次模拟只读调用）；本轮浅色专项通过（24 次模拟只读调用）。均无变更调用、外部请求或 Renderer 错误。
- 15 项合成列表在展开和 128px 收窄两态下实测一致：搜索底部 137px，标题 149–173px，列表起点 181px；即上留白 12px、标题高 24px、下留白 8px。标题与项目名称均从左侧 16px 开始。
- 原生滚轮使列表从 0 滚到 170px，标题与底栏矩形完全不变；最后一项底部 579px，列表及底栏边界为 583px，没有遮挡。场景结束还原原始合成数据和窗口状态。
- 深色实测图复用同一 JS/CSS 构建的完整回归输出并人工核对，浅色图及几何日志在本轮重新生成。搜索缩放、环境标题返回详情及展开/收起回归保持通过。
- 保留同一工作区并行完成的环境标题导航与新建项目弹窗修改；本轮不修改凭据、安全策略或后端契约。

证据目录：`C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-heading/`。实测数据见 `heading-geometry-light.json` 和 `ui-light.log`。

- [项目标题展开效果](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-heading/project-heading-expanded-dark-top-960x640.png)
- [项目标题收窄效果](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-heading/project-heading-compact-dark-top-960x640.png)
- [收窄并滚到底部](C:/Users/taotao/.codex/visualizations/2026/08/30/01a0529b-8336-77e3-8334-8dae20522463/project-rail-heading/project-heading-compact-dark-bottom-960x640.png)

### 本轮安装包

- `dist/Agent运维工作台 Setup 1.0.46.exe`，115,887,550 字节，生成于 2026-08-30 22:48:03。
- SHA-256：`3CAEC04480EE035BEDC3B1CE539BA58E2AD936B9389A56C5B49FE6A1D39E806E`。
- `dist`、包内容验证、35 个结构化工具的 packaged MCP smoke 和实际 packaged UI smoke 全部通过。包内 JS/CSS 与本次实测相同，仍为 `index-BhunBhm3.js` / `index-C8raIrFS.css`。
- 实际软件包验证覆盖 58 个 preload API、临时空工作区、零外部请求、253px → 128px → 253px、重启恢复 128px 和再次展开 176px；搜索文字 48px、原生文本可用宽度约 59.51px，完整显示。
- 本地安装包未作 Authenticode 签名，未自动安装或操作用户数据。构建产物保持忽略状态，未进入源码 diff。
