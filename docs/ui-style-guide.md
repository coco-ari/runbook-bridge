# 工作台界面规范

适用于 renderer/v2/src 的全部界面：项目、环境、插件详情与编辑、权限、操作确认、操作记录、运维说明、快捷问题、云配置，以及服务器、Redis、MySQL、Docker 工作区。

## 字体与尺寸

- 正文、导航、目录名称使用 text-sm（13px / 20px），辅助信息使用 text-xs（12px / 18px）。
- 页面、弹窗标题使用 text-base（16px / 24px）和 600 字重；卡片、分组标题使用 text-section（14px / 20px）和 500 字重。
- 普通文字使用 --font-sans，技术内容使用 --font-mono。配置摘要中的地址、路径和结构化内容可使用等宽字体，中文标签使用界面字体。
- 常规控件高度 32px，紧凑工具栏控件高度 28px；目录行高 32px，嵌套缩进 18px。服务器虚拟列表的 rowHeight 必须与 --tree-row-height 保持一致。
- 工作区顶栏 56px，工具栏及文档标签栏 36px，底栏 24px；低于 620px 高的窗口使用 48px 顶栏并隐藏底栏。
- 控件圆角 6px（rounded-md），卡片、菜单圆角 10px（rounded-lg），弹窗圆角 12px（rounded-xl）。
- 间距优先使用 4、8、12、16、24px；控件内图标为 16px。

## 颜色和状态

- 深浅主题共用绿色强调色的语义，浅色采用更深的绿色保证可读性。
- 所有背景、文字、边框和选中态通过 globals.css 的语义变量取得，不在功能页面另建基础色板。
- 目录选中态使用 surface-selected 背景、primary 强调线和中等字重。
- 连接状态使用 StatusIndicator，需特殊文案时传入 label；状态必须同时有文字或可访问名称。
- 错误、警告和信息通过 danger、warning、info 表达。错误提示使用 Alert，工作区横向提示使用 WorkspaceNotice。
- 默认、悬停、选中、禁用、键盘焦点需成套实现。尊重减少动态效果和强制颜色设置。

## 组件使用

- 使用公共 Button、Input、Textarea、Checkbox、Select；简单下拉字段可使用 SelectControl 和 SelectItem。SelectControl 采用字符串值，业务侧显式转换数字。
- SelectItem 的值不得为空；“最新版本”等业务空值在控件边界映射为明确的选项值。
- 空状态使用 Empty 系列组件，连接状态使用 StatusIndicator，弹窗使用 Dialog 或 AlertDialog。
- 文档标签和工作区框架样式集中于 components/workspace/workspace-layout-controls.css；页面导航与文档标签用途不同，分别使用公共 Tabs 导航变体和工作区标签规范。
- 工作区图标操作使用 WorkspaceIconButton，提示内容通过公共 Tooltip 展示。
- 基础字体继承、通用边框规则必须位于 @layer base，避免覆盖 Tailwind utilities。业务 CSS 仅负责具体布局或明确的组件细节，不通过全局 !important 修复层叠问题。

## 允许的功能差异

- xterm 保留自己的字符网格、14px 字体和与终端主题一致的背景；不能用界面字号改变终端行列计算。
- SQL、JSON 的语法色、文件类型色及终端 ANSI 色具有内容语义，可保留专用颜色。
- 编辑器行号、缩进和内容滚动由对应编辑器管理；其他区域统一细滚动条。
- 虚拟目录不添加影响定位和拖动的布局动画。
- 状态数字与紧凑数据表允许专用列宽，多行资源项允许更高行高。

## 验证

运行 corepack pnpm run check、corepack pnpm test、corepack pnpm run test:ui:all。

scripts/workspace-style-ui.cjs 随基础及工作区界面测试验证真实浏览器中的字号、字重、等宽字体、控件高度、圆角和边框层叠，覆盖深浅色及不同工作区容器。操作流程继续由各功能界面测试覆盖。截图使用模拟数据并保存于仓库之外。
