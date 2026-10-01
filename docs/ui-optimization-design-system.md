# UI 优化评估附录：设计系统与公共组件

评估日期：2026-10-01。定位：开发与运维人员长时间使用的桌面工作台。本文只评估设计系统，不扩大权限、确认、凭据、数据库或远程操作能力。评估时产品源码未修改；路径和行号对应评估基线。

## 结论与保留原则

现有设计系统已经具备合理的基础：系统中文字体、13 px 常规 UI 字号、12 px 辅助字号、32/28 px 控件、分层背景、绿色主操作色、危险实心按钮独立颜色、深浅/系统主题、焦点基础样式、高对比模式与减少动效规则。无需为了品牌审美更换色系、字体库、图标库或引入依赖。

确定需要解决的问题集中在信息对比度与交互反馈：浅色警告/信息徽标文字、可操作的淡色行号、低对比输入边界与滚动滑块、淡化焦点环，以及命令输入和标签内容的焦点样式缺失。主按钮浅色主题使用白字本身合理，不能从单帧截图推断颜色错误。

## 成熟软件参照及适用边界

- [VS Code 工作台布局](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_basic-layout)：资源导航、内容、终端/输出拥有稳定位置，布局可恢复。借鉴稳定工作区域和内容优先，不要求复制其六区布局或全部功能。
- [VS Code 编辑器动作](https://code.visualstudio.com/api/ux-guidelines/editor-actions)：紧凑图标动作配合工具提示，图标保持一致。借鉴动作语义与位置，不为模拟 VS Code 而替换现有 Phosphor。
- [JetBrains 字体规范](https://plugins.jetbrains.com/docs/intellij/typography.html)：普通界面字号为 13，辅助字号相对主字号变化，编辑器与 UI 字体分开。支持现有紧凑定位；不能据此声称 13 px 对所有用户都最合适，仍需 Windows 缩放验证。
- [JetBrains 图标规范](https://plugins.jetbrains.com/docs/intellij/icons.html)：优先复用图标，同一产品体系区分普通、紧凑和主题状态。借鉴语义映射与少数尺寸档位，不照搬其专属颜色。
- [Carbon 颜色与层级](https://www.carbondesignsystem.com/building-blocks/foundations/color/guidelines)：背景、字段、边界、文字具有不同语义 token，装饰分隔与可识别字段边界不必使用同一颜色。借鉴职责拆分；不要求套用 Carbon 灰色或改变现有绿色。
- [WCAG 2.2 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)与[非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：现有 12/13 px 文字属于普通文字，目标为至少 4.5:1；识别操作控件、状态所必需的视觉部分目标为至少 3:1。装饰线、不可操作禁用控件有适用边界，不能把全部边框判为不合格。

## 实算方法与结果

先在内存中使用 Oklch → Oklab → 线性 sRGB → 编码 sRGB 转换，发现浅色 warning/info 超出 sRGB 范围，未把这些未经显示映射的数值作为最终结论。随后用本机 Electron 43.3.0 / Chromium 150 的独立隐藏 data URL 页面加载 `globals.css` 中实际 `:root` token，在 sRGB canvas 中绘制、读取 8 位颜色；透明背景使用产品实际的 `color-mix(in oklab, …, transparent)` 合成，再计算 WCAG 相对亮度。页面使用新建临时数据根，无真实连接、应用数据、截图内容或运维数据。

亮度算法：每个 sRGB 分量归一化为 c；c ≤ 0.04045 时取 c/12.92，否则取 ((c+0.055)/1.055)^2.4。相对亮度为 0.2126R + 0.7152G + 0.0722B；对比度为 (较亮亮度+0.05)/(较暗亮度+0.05)。[W3C CSS Color 4 转换参考](https://www.w3.org/TR/css-color-4/#color-conversion-code)。表中数值展示四位小数，canvas 有 8 位量化误差，不能把临界值四舍五入成通过；后续应留余量并以真实控件背景复核。

| 组合 | 浅色 | 深色 | 判断 |
| --- | ---: | ---: | --- |
| foreground / background | 16.3992 | 17.2716 | 保留 |
| muted-foreground / background | 5.9641 | 7.5876 | 保留 |
| muted-foreground / surface-raised | 5.1616 | 6.6833 | 保留 |
| primary-foreground / primary | 5.4580 | 10.3896 | 保留；浅色白字并非缺陷 |
| danger-foreground / danger-solid | 5.3597 | 6.2229 | 保留实心危险按钮配色 |
| text-faint / background | 3.7790 | 4.1382 | 普通有意义文字不足 |
| text-faint / surface-inset | 3.5145 | 4.0576 | 可操作行号不足 |
| warning / background | 3.9756 | 10.9101 | 浅色普通警告文字不足 |
| warning / warning 10% + card | 3.7020 | 8.5418 | 浅色 warning 徽标不足 |
| info / info 10% + card | 4.2720 | 6.5420 | 浅色 info 徽标不足 |
| primary(success) / primary 10% + surface-inset | 4.2095 | 8.9308 | 浅色 inset 上 success 徽标不足 |
| destructive(danger) / destructive 10% + surface-inset | 4.0286 | 5.8986 | 浅色 inset 上 danger 徽标不足 |
| input / surface | 1.5578 | 1.5299 | 作为唯一识别边界或滑块时不足 |
| input / surface-inset | 1.3862 | 1.5655 | 同上 |
| border / background | 1.4180 | 1.3453 | 装饰分隔线不据此加深 |
| ring 60% + surface / surface | 2.5781 | 4.2594 | 浅色仅有此焦点环时不足 |
| foreground 60% / surface-inset | 4.4257 | 6.4545 | 浅色 Tabs 非激活文字可能临界不足，宜使用明确文字 token |

浅色实测颜色包括 background rgb(242,245,249)、surface rgb(248,250,252)、surface-inset rgb(233,237,242)、primary rgb(8,117,83)、warning rgb(167,109,0)、info rgb(0,115,182)、text-faint rgb(120,125,135)。深色 text-faint 为 rgb(114,114,126)。

## 编号建议、必要性与验收

### D01 必改：让状态文字独立满足对比度

证据：`renderer/v2/src/styles/globals.css:152` 的 success 直接别名主色；`:153` 的浅色 warning；`:154` 的 danger；`:157` 的 info；`renderer/v2/src/components/ui/badge.tsx:14` 至 `:17` 使用同一状态色做文字与 10% 背景。实际可见警告文字见 `renderer/v2/src/components/app-shell/GlobalCommand.tsx:121`。以上对比度不足是 token/透明背景计算结果，不来自截图猜测。

实施策略：保持主色、实心按钮、背景层级不变；在浅色主题给 success 设独立的同色相文字色，并适度降低 warning/info/danger 的文字亮度。允许用独立状态文字 token 与原有弱背景 token 配对，或在保证文字实算达标后调整现有语义 token。不要把文字/图标/实心按钮/弱底色全部绑定到一个新深色；不要把 badge 全改为实心块。深色已经达标的状态颜色不为形式统一而修改。

验收：普通文字及状态 badge 在 background、card、surface、surface-inset 的实际复合背景均 ≥ 4.5:1；通过/警告/失败仍有文本或图标含义，颜色不成为唯一信息；默认与悬停/选中状态均检查。主按钮及实心危险按钮仍保持现有主色关系。

### D02 必改：淡色 token 不用于可操作的信息文字

证据：`renderer/v2/src/styles/globals.css:151`、`:194` 定义 text-faint；`renderer/v2/src/features/database/MysqlQueryResults.tsx:267` 将它用于行号选择按钮，`:229` 用于表头行号。13/12 px 文字不是大字例外，两个主题均不足 4.5:1。

实施策略：提升 text-faint 在其实际表层背景的可读性，或让行号改用满足阈值的次级文字 token。保留 muted-foreground 与正文的层次；无需让所有辅助信息变成正文色。

验收：未选中、选中、悬停行号在真实结果表背景上 ≥ 4.5:1，仍可区分行号与数据；图标行号选择可键盘访问；禁用状态不强行按普通文字要求提亮。

### D03 必改：补齐焦点可见性与必要强度

证据：`renderer/v2/src/components/ui/button.tsx:10` 为 outline-none + ring-ring/60；浅色环与表层仅约 2.58:1。`renderer/v2/src/components/ui/command.tsx:79` 的输入有 outline-hidden，`:77` slot 为 command-input；`renderer/v2/src/components/ui/input-group.tsx:17` 的父级焦点选择器只匹配 input-group-control。`renderer/v2/src/components/ui/tabs.tsx:89` 的可聚焦内容直接 outline-none。

运行态验证：用现有构建 CSS `index-r45KJ94o.css` 与源码原样 class/slot 创建独立合成 DOM，隐藏 Electron 开启焦点仿真后，CommandInput 与 TabsContent 都匹配 `:focus-visible`，但 computed outline-style 为 none、box-shadow 为 none；CommandInput 父 InputGroup 也无 box-shadow。该结果验证 CSS 链路，后续还应在实际 React 控件中验收 Radix 的 Tab/方向键交互。

实施策略：公共交互控件的键盘焦点使用足够强的 ring/outline；优先提高焦点环自身浓度，不增加常驻发光或阴影。InputGroup 将命令输入纳入统一焦点选择器；TabsContent 提供内侧焦点指示，避免被 overflow 容器裁切。保留 focus-visible，不让鼠标每次点击都产生强焦点框。

验收：在两个主题下用键盘遍历按钮、输入、选择、checkbox、switch、toggle、command、tabPanel、scroll viewport、resize separator；焦点至少有一条足够辨识的视觉指示。浅色只有环承担焦点提示时 ≥ 3:1；CommandInput 与 TabsContent computed outline/ring 非空且肉眼可见；强制颜色模式仍有系统 Highlight 焦点，不被固定页头/脚覆盖。

### D04 必改：区分操作边界与装饰分隔

证据：`renderer/v2/src/styles/globals.css:143`、`:185` 的 input；`renderer/v2/src/components/ui/input.tsx:11`、`textarea.tsx:10`、`select.tsx:45`、`checkbox.tsx:17`、`input-group.tsx:17`、`toggle-group.tsx:15` 用其识别可编辑/可切换范围。该边界在表层约 1.5:1，且暗色输入填充也只是 input/30。

实施策略：新增或明确 `control-border` 等操作控件边界 token，单独提高它与所在表层的辨识度。保留 `border` 的细弱卡片、工具栏、表格装饰线；保留 `input` 作为当前暗色弱填充，不通过全局加亮 input 把表单背景同步变亮。Switch 的关闭状态和 checkbox 的未选中状态要具体检查，避免把关闭误认成禁用。

验收：启用的空输入框、textarea、select、checkbox 的必要边界在实际正常背景 ≥ 3:1；若已有其它充分识别手段，按控件实际结构判断。各状态边界一致且不显得常驻聚焦；禁用控件仍有禁用语义和原因，不套用同样强度。卡片/表格装饰分隔线不随之全局加深。

实施复审补充（修复前实测）：2026-10-01 在真实云配置项目开关上模拟 Chromium `forced-colors: active`，checked/unchecked 两态的滑块和轨道背景均为 `rgb(0, 0, 0)`，滑块填充对比度 1:1，边框宽度 0；滑块虽然移动，用户无法辨认位置。轨道和焦点边界为系统 Highlight，已达 14.371:1，无需重做。该结果属于 D04 的状态辨识验收，不新增功能或优化编号。

必要修复：仅在强制颜色媒体条件下，为现有滑块增加 1 px 系统 ButtonText 轮廓；保留普通深浅主题、尺寸、位置、键盘操作与禁用规则。验收必须操作真实 Switch，检查原生 Space 切换、两态滑块位置、有效轮廓至少 3:1和焦点可见；同时检查真实输入框及确认勾选框。Chromium 媒体模拟是代表场景证据，不等同于覆盖全部 Windows 高对比配色和辅助技术组合。

### D05 值得改：让滚动位置更容易发现

证据：`renderer/v2/src/styles/globals.css:213` 的原生滚动条和 `renderer/v2/src/components/ui/scroll-area.tsx:68` 的自定义滑块均使用 input，约 1.5:1；自定义轨道宽度为 10 px（`:61`），尺寸本身不需要扩大。`command.tsx:100` 隐藏命令列表滚动条。`sidebar.tsx:376` 也含 no-scrollbar，但实际 ProjectRail 使用独立 ScrollArea（`components/project-rail/ProjectRail.tsx:429`），不能据公共默认 class 宣称项目列表没有滚动条。

实施策略：为滚动滑块设与弱填充分开的语义颜色；按滚动位置、hover/拖动提供克制反馈。长命令列表宜保留可辨识的滚动提示。不要扩大全部滚动轨道、恢复外层页面滚动或删除所有 no-scrollbar。

验收：长项目/插件/命令/结果列表可以看出还有内容和当前位置；两个主题下滑块可辨识；鼠标滚轮、拖动、键盘 PageUp/PageDown、横向结果滚动仍可用；工作台不出现多余双滚动条。

### D06 值得改：明确公共图标的语义规则

证据：公共 UI 统一使用 Phosphor，普通控件默认 16 px；`button.tsx:10`、`select.tsx:45`、`tabs.tsx:69` 已约束尺寸。`accordion.tsx:51`、`checkbox.tsx:26`、`command.tsx:85`、`dropdown-menu.tsx:109`、`dialog.tsx:75` 等内部图标没有显式 aria-hidden。已核对本地 Phosphor IconBase：默认提供 currentColor 和 regular 权重，并不自动写 aria-hidden。应用状态指示器已明确隐藏装饰图标（`components/app-shell/StatusIndicator.tsx:96`）。

实施策略：继续使用一个图标库；普通动作 16 px，紧凑局部 14/15 px，空状态或主标题 20 px，状态实心权重仅用于已连接、通知等真实语义。带文字的装饰图标、展开箭头、勾选指示、关闭按钮内部图标明确 aria-hidden；图标按钮的动作名由 button 的 aria-label/sr-only 提供。不要用全局隐藏所有 SVG 的方式损害必要图形的名称，不为尺寸小差异逐项返工。

验收：公共 icon-only 按钮仍有唯一明确名称；辅助技术不重复朗读装饰图形；同一动作在菜单/工具栏/列表保持一致图标含义，危险动作不只靠颜色；普通动作不意外混用大量 fill/duotone 权重。

### D07 保留：字体、密度、间距与背景基础

证据：`globals.css:52`、`:53` 有中文系统字体与独立等宽字体；`:54` 至 `:59` 定义字号；`:120` 至 `:126` 定义尺寸；`:215` 为数字提供 tabular-nums；`:128` 至 `:150`、`:170` 至 `:192` 提供表层和状态底色。Button 的 default/sm 都为 32 px（`button.tsx:22`、`:23`），属于允许的 API 别名，不是必须拆出的缺陷。

保持：13 px 常规、12 px 次要信息、14 px 区块标题、32/28 px 操作密度与小圆角。新增界面优先使用现有 token，避免散落 10/11 px 有意义文字。不要统一放大卡片间距、增加大标题或把资源表格改成大卡片。

验收：Windows 100%、125%、150%、200% 缩放下中文/路径/数字不裁切；低宽工作区仍可操作。若用户实际需要更大字号，再评估可缩放字号；当前没有证据要求新增全局密度设置或字体依赖。

### D08 保留并验证：主题、减少动效、高对比模式

证据：`app/theme-provider.tsx:37` 监听系统主题，`:44` 在布局阶段应用主题，`:48` 同步存储变化；`state/theme-state.ts:19` 的读取有容错，`:53` 写 data-theme。`globals.css:118`、`:169` 同步 color-scheme；`:259` 有 forced-colors，`:277` 有 reduced-motion。`app/providers.tsx:47` 的 Toast 使用解析后的主题，`:54` 实际 tooltip 延迟为 350 ms，不能因 TooltipProvider 的默认 0 ms 误判即时弹出。

保持：主题持久化与系统跟随、现有减少动效/强制颜色覆盖、短时控件过渡。不增加装饰动效。spinner/progress 在 reduced-motion 下保留文字进度语义。

验收：深/浅/系统切换与重启一致；减少动效时脉冲、旋转、展开过渡不持续运行；高对比主题中字段边界、勾选、开关、选中项与焦点可见。已存在 foundation 的强制颜色及可操作项目行对比度验证；补缺失真实控件场景，不只用源码正则证明可见性。

### D09 待验证：Popover、Sheet 和长内容的边界

证据：`popover.tsx:31` 默认 w-72，没有统一可用高度/宽度限制；`sheet.tsx:67` 限制整体宽高，但滚动由业务内容决定。Dialog/AlertDialog 已有 max-height、overflow-y-auto、overscroll-contain 与任意长串折行（`dialog.tsx:62`、`alert-dialog.tsx:59`），值得保留。

判断：不能单凭公共组件缺少限制，就断言所有现有浮层会溢出；实际调用方可能已经限定高度。针对常用目录、磁盘列表、SQL 设置、云版本、记录编辑等浮层做窄窗/短窗/长内容验证，确实溢出才追加边界与内部滚动。修复不得把操作按钮滚出视野或让背景跟随滚动。

## 全部公共组件逐项判定

判定是针对设计系统基础实现，不等于对每个业务调用作完整无障碍保证；细项 ID 指向上文必要性和验收。

| 文件（均在 renderer/v2/src/components/ui/） | 判定 | 源码证据、理由与处理 |
| --- | --- | --- |
| accordion.tsx | 值得改 | :45 有焦点替代、:66 有展开动画且全局 reduced-motion；:51 装饰箭头需明确隐藏，沿用 D03/D06 |
| alert-dialog.tsx | 保留 | :59 有视口高度、滚动、折行、标题/描述的 Radix 语义；Action/Cancel 复用 Button；随 D03 的焦点修复受益 |
| alert.tsx | 值得改 | :31 危险提示有 alert 语义，:7 长文本可折行；错误文字/背景随 D01 校准，不改布局 |
| badge.tsx | 必改 | :14–17 同色文字与透明弱背景在浅色主题不稳定达标；执行 D01 |
| button.tsx | 必改 | :14/15 实心配色保留；:10 浅色 ring/60 为唯一焦点提示且不足；执行 D03，保留尺寸 |
| button-group.tsx | 保留 | :8 焦点提升 z-index 避免邻控件遮挡，:34 有 group 语义；不增加外层装饰 |
| calendar.tsx | 待验证 | :34 使用28 px日期格，:171 跟随日期焦点；执行 D03；高缩放、range 选中/禁用和本地化由真实调用验证，不扩大现有日历功能 |
| card.tsx | 保留 | :15 内容/底色/间距 token，:41 14 px标题；细弱轮廓用于分组，不作为字段边界一起加深 |
| checkbox.tsx | 必改 | :17 未选中边界与浅色焦点不足；执行 D03/D04；:26 勾选图标执行 D06，保留点击区域扩展 |
| collapsible.tsx | 保留 | :13、:24 是标准 Radix 封装，不复制控制状态；触发器的业务名称/样式在调用处验收 |
| command.tsx | 必改 | :77/79 与 InputGroup 焦点选择器不匹配，已运行态证实；执行 D03；:100 长列表可加滚动提示 D05；默认英文文案被 GlobalCommand 中文覆盖，不误判现状 |
| context-menu.tsx | 值得改 | :91 有聚焦底色和危险状态，:150/180 有勾选及 Radix语义；执行 D01/D06，保留右键与键盘菜单结构 |
| dialog.tsx | 保留 | :62 视口/滚动/长串处理完备，:77 关闭 sr-only 名称；内部装饰图标执行 D06，不重做弹窗结构 |
| disabled-reason.tsx | 保留 | :5 禁用原因同时提供可聚焦包装与tooltip；验证原因和按钮名称组合，保留禁用说明能力 |
| dropdown-menu.tsx | 值得改 | :46 有可用高度、:76 有焦点背景和危险语义、:109 勾选；执行 D01/D06，无需重做菜单体系 |
| empty.tsx | 保留 | :10、:22、:89 限制内容宽度并集中动作；空态字号仍可读，保留业务引导结构；图标按 D06 |
| field.tsx | 保留 | :8/27 使用 fieldset/legend，:104 复用 Label，:215 错误有 alert；保持标签与错误关联由调用方提供 |
| input.tsx | 必改 | :11 透明填充/中文字号合理；必要边界与键盘焦点执行 D03/D04 |
| input-group.tsx | 必改 | :17 合成控件已有统一焦点意图但漏 command-input；执行 D03/D04；装饰 addon 点击聚焦不能当独立动作按钮 |
| item.tsx | 保留 | :112 min-w-0、:131/150 截断、:53 asChild 可提供真实动作元素；不要所有静态条目都加点击/hover语义 |
| kbd.tsx | 保留 | :7 使用 kbd 标签，:9 紧凑排布，tooltip中特殊颜色有意保持反色；不替换为普通 badge |
| label.tsx | 保留 | :13 复用 Radix Label；htmlFor/控制名称归业务字段，不全局生成猜测名称 |
| popover.tsx | 待验证 | :31 固定宽度、默认不限制长内容；执行 D09 后只修真实溢出，:60 已有 h2 标题语义 |
| progress.tsx | 保留 | :14/17 复用 Radix Progress、区分未知 value，:21 动效受全局规则；保留非动画文字进度信息 |
| resizable.tsx | 保留 | :33 使用具有 separator 语义的库组件，:36 有焦点ring与扩展命中区；AppShell :996 提供说明和键盘快捷键；无需再引入分栏库 |
| scroll-area.tsx | 值得改 | :34 有焦点替代、:43/44 正确区分横竖；:68 滑块颜色执行 D05，焦点随 D03；不改双向滚动契约 |
| select.tsx | 必改 | :45 必要字段边界和焦点执行 D03/D04；:193 统一选择控件应保留；内部箭头/勾选按 D06 |
| separator.tsx | 保留 | :9 默认 decorative，:18 使用弱边框用于分组；不得为了非文字阈值把装饰线一起加深 |
| sheet.tsx | 待验证 | :67 已限制视口，:82 有关闭名称；长业务内容滚动及固定操作脚需 D09 验证；图标按 D06 |
| sidebar.tsx | 保留 | :472/670 有焦点、active、truncate，:535 隐藏时卸载tooltip避免布局测量；实际项目列表有 ScrollArea。小动作 hit-target 与高缩放实际使用待验证，不盲目改全部sidebar |
| skeleton.tsx | 保留 | :7 脉冲受全局 reduced-motion，使用弱 muted 色符合加载占位；业务 loading 状态朗读不由骨架图形承担 |
| sonner.tsx | 保留 | :27 与popover token一致，AppProviders传解析主题；通知图标按 D06，先验证Sonner既有live-region后再加ARIA避免重复朗读 |
| switch.tsx | 必改 | :6/7 语义库与 thumb 移动保留；必要关闭态边界/焦点执行 D03/D04；不统一加大开关尺寸 |
| table.tsx | 保留 | :11/22/32/68/81 真正 table 语义，:9 支持横向滚动，:58 只给 interactive 行hover；高级SQL结果能力由专属表格实现 |
| tabs.tsx | 必改 | :89 标签内容焦点缺失已运行态证实；:69 foreground/60 在浅色inset临界不足，改用明确次级文字 token；保留各业务导航variant |
| textarea.tsx | 必改 | :10 自适应内容和字段尺寸保留；必要边界/焦点执行 D03/D04，不一律禁用用户调整高度 |
| toggle-group.tsx | 必改 | :10 有on-state下划线与语义，:15 必要边界不足；执行 D03/D04，保留尺寸档位和键盘选择 |
| tooltip.tsx | 保留 | :45 反色文本可读，:43 持续定位已有实际目的，实际Provider延迟350 ms；不增加新定位库；长描述内容是否可折行按D09验证 |

## 建议实施顺序与验证责任

1. 先完成 D01、D02 的文字 token 校准，保留主按钮/危险实心按钮/背景。
2. 用独立操作边界 token 实施 D04；自定义与原生滚动滑块实施 D05，不加深装饰线。
3. 实施 D03 的公共焦点强度、CommandInput 父级关联、TabsContent 内侧焦点；真实 UI smoke 加键盘状态和有效样式/对比度断言，不能只改匹配 class 的源码正则。
4. 在公共组件内部执行 D06 的装饰图标语义；业务图标语义由组件清单的逐项审查负责。
5. D07/D08 保留并做主题、缩放、减少动效和forced-colors验收。D09 在真实溢出证实后修，不把待验证项提前声称为必要改动。

适用验证：设计系统/Renderer修改执行相关 focused tests、`corepack pnpm run check`、`corepack pnpm test` 与 `corepack pnpm run test:ui`。涉及各专属工作区的最终体验，由对应数据库、服务器、Redis及业务smoke补充。本文评估本身只写文档，检查 `git diff --check` 和路径；不连接真实基础设施。
