# 专业工作区 UI 评估附录

评估日期：2026-10-01。覆盖服务器工作区、文件与目录、SSH 终端、搜索、分屏、传输、资源指标、Docker、MySQL、Redis，以及共享工作区控件。优化前评估以源码和现有测试脚本的静态检查为主；实施结果及真实 Electron 合成夹具验证见[主方案](ui-optimization-plan.md)。本轮未连接真实基础设施，未据此声称完成真实设备可用性测试。源码行号是评估时的位置，实施后可能变化。

当前工作区已经采用成熟工具常见的资源列表、文档标签、可调整分栏和就地操作。多数能力应保留。需要处理的是少数状态表达、键盘效率和编辑体验的具体差距；没有证据的审美偏好不列为必改，也不要求照搬成熟软件的全部能力。

## 参照范围

| 官方参照 | 本次借鉴的具体机制 | 适用边界 |
| --- | --- | --- |
| [VS Code 终端](https://code.visualstudio.com/docs/terminal/basics) | 标签、分屏、内容查找、多个可发现的操作入口 | 不据此扩展当前远端命令权限 |
| [VS Code 文件差异审查](https://code.visualstudio.com/docs/sourcecontrol/staging-commits) | 前后对照、变更导航、收起未修改区域 | 仅改善确认时的信息呈现，不替换确认绑定和远端校验 |
| [DBeaver SQL 编辑器](https://dbeaver.com/docs/dbeaver/SQL-Editor/) 与 [事务模式](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/) | 编辑与结果分区、事务状态、提交与回滚关系 | 保留本应用现有自动事务默认值，不照搬其他工具的默认策略 |
| [DBeaver 数据编辑器](https://dbeaver.com/docs/dbeaver/Data-Editor/) | 数据表格、筛选、行查看与编辑操作分组 | 不增加新的数据库权限或不受限查询 |
| [Redis Insight](https://redis.io/docs/latest/develop/tools/insight/) | Key 列表与树、数据格式化及可读内容展示 | 保留固定 DB、登记范围和内容预算，不复制其批量删除等能力 |
| [Docker Desktop 容器视图](https://docs.docker.com/desktop/use-desktop/container/) | 容器分组与筛选、概览/日志/资源分区、日志查找 | 当前 Docker 工作区保持读取范围；不添加容器启停、删除或 Exec |
| [W3C 键盘交互](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)、[树](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)、[交互表格](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) | Tab 在组件间移动、方向键在组件内移动、可辨识且可恢复的焦点 | 作为交互依据；不把静态检查等同于完整无障碍认证 |

## 必须修改

### W01：统一工作区连接状态，避免重连期间显示静态断线结论

- 证据：`renderer/v2/src/features/server-workspace/ServerWorkspace.tsx:394` 已区分连接、重连、需要处理和断开；`renderer/v2/src/features/database/MysqlDatabaseWorkspace.tsx:90`、`:101` 以及 `renderer/v2/src/features/redis/RedisWorkspace.tsx:190`、`:204` 使用 `connected` 二分状态。共享连接按钮又在 `renderer/v2/src/components/workspace/WorkspaceControls.tsx:30` 区分取消、等待确认和连接中。
- 影响与必要性：用户已经点击重连或等待主机密钥确认时，标题/横幅与按钮可能表达不同的阶段。远端操作工具需要准确表达当前能否读取、能否编辑和应等待还是处理。
- 拟方案：复用现有连接阶段及 `StatusIndicator`，提炼一个纯展示映射；明确连接中、正在取消、等待确认、需要处理、已连接、已断开。阶段提示与“SQL/标签/草稿保留”说明分别组织，连接中不继续用“连接已断开”作为唯一标题。保持操作按钮原有状态机及取消逻辑。
- 验收：服务器、MySQL、Redis 在连接中、主机密钥确认、取消中、连接失败、主动断开和恢复连接时，标题、横幅、按钮语义一致；断线旧结果提示和草稿仍保留；不会因展示映射触发自动连接。
- 参照：[VS Code 终端](https://code.visualstudio.com/docs/terminal/basics) 对会话状态提供可识别提示。这里的统一方案是针对本仓库实际状态结构的设计判断。

### W02：服务器目录树采用单一 Tab 入口并补全虚拟树语义

- 证据：`renderer/v2/src/features/server-workspace/ServerFileTree.tsx:745` 仅挂载视窗附近条目，`:838` 树容器可 Tab 聚焦，`:880` 每个已挂载条目又都设为 `tabIndex={0}`，目前只有 `aria-level`、选择和展开属性。现有方向键导航在 `:892` 附近。Redis 在 `renderer/v2/src/features/redis/RedisKeyBrowser.tsx:156`、`:159` 已有兄弟位置、集合大小及活动项 Tab 入口。
- 影响与必要性：Tab 会经过多条目录记录和行内按钮，退出树的按键次数随可见条目增加；虚拟化使屏幕阅读器无法从实际 DOM 推导完整层级与兄弟位置。已存在方向键支持，仍需把焦点模型完成。
- 拟方案：保留方向键与虚拟滚动，选中/最后聚焦节点为唯一树条目 Tab 入口，其他节点设为 -1；没有条目时保留容器入口。目录刷新、折叠、分页和定位后恢复合理焦点。为已加载逻辑树补充 `aria-posinset` 与 `aria-setsize`，集合不完整时不要将已加载数量冒充远端总量；未知总数可用相应未知语义。行内下载仍能通过明确键盘路径或上下文菜单到达。
- 验收：普通目录条目只有一次Tab入口，再次Tab离开条目导航；分批加载、上一批、错误重试等少量独立动作保留直接Tab，避免把必要操作藏起来。方向键/Home/End、Enter、定位、刷新、复制路径、上传粘贴、下载和右键操作均可使用；离开并回来恢复活动节点；跨虚拟视窗和折叠父目录不把焦点丢到body；断线不能激活远端读取。
- 参照：[W3C 键盘交互](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) 与 [虚拟树语义](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)。

### W03：MySQL 结果数据区采用单一 Tab 入口

- 证据：`renderer/v2/src/features/database/MysqlQueryResults.tsx:273` 每个单元格都可 Tab 聚焦；`:276` 到 `:285` 的方向键与复制主要在存在编辑控制器时生效；滚动区在 `:223` 也有独立入口。列宽分隔条已在 `:234` 实现键盘操作，必须保留。
- 影响与必要性：宽表、长结果集会产生大量 Tab 停靠点；复审还确认每行 Checkbox 与行号按钮各有默认 Tab 入口，仅减少单元格停靠仍会剩下每行两个入口。只读结果与可编辑结果的焦点体验不一致。这不是缺少表格键盘支持，而是现有支持的入口与退出成本偏高。
- 拟方案：活动单元格采用 roving tabindex；每行 Checkbox 与行号仍可鼠标操作，改为 `tabIndex=-1`，活动单元格空格勾选/取消当前行，锁定状态不修改勾选。读写两种结果都支持方向键、Home/End、Ctrl/⌘+Home/End 和 Ctrl/⌘+C；Enter 查看或编辑、F2 编辑。通过实际 aria-description/提示说明空格与 Enter 的路径。编辑输入、IME 和 Shift+空格不被网格接管；多行弹窗沿用现有逻辑。表头全选、排序、列宽调整与编辑工具栏保留直接 Tab，不仓促更改整张表的 ARIA 角色。
- 入口边界：单入口适用于普通数据单元格及其重复行选择/行号；激活后的输入框、少量草稿行恢复/删除动作继续独立可达，不能把“减少重复停靠”解释为移除这些操作的键盘路径。
- 验收：100 行、多列结果实际 DOM 只有一个数据单元格 `tabIndex=0`，其余单元格及每行 Checkbox/行号为 -1，Tab 可直接离开数据区；方向键和首尾快捷键将目标滚动可见；Space 能切换行勾选，忙碌/待核实锁定时不改变选择和值；筛选、换页、追加读取与行详情关闭后单入口及合理焦点保持；Ctrl/⌘+C 复制完整值；嵌套输入、IME、Shift+空格不误切单元格；新增/复制/删除/批量操作与列宽快捷键不退化。
- 参照：[W3C 键盘交互](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) 和 [交互表格](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)。

## 值得修改

### W04：把 MySQL 的 Agent 只读范围解释清楚

- 证据：`renderer/v2/src/features/database/MysqlDatabaseWorkspace.tsx:90` 标题显示“Agent 只读”，`:261` 的空态说明支持增删改；`renderer/v2/src/features/database/MysqlSqlConfirmation.tsx:14` 已明确手动写入需要确认。
- 影响：新用户可能将 Agent 权限标记理解为整个数据库工作区只读，也可能误以为 Agent 能使用桌面的写入能力。
- 拟方案：保留徽章的简短展示，增加可聚焦的说明：“Agent 查询只读；此工作区的手动修改需确认”。在写入相关帮助或确认文案中使用相同边界，不增加常驻长段落。
- 验收：鼠标和键盘均可读取说明；不改变数据库固定范围、MCP 策略或手动确认；标题在 960×640 仍可用。
- 参照：[DBeaver 事务模式](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/) 将写入状态与提交方式明确表达；本项的 Agent/人工区分来自本应用架构。

### W05：远端文件确认改为有界的多处变更审查

- 证据：`renderer/v2/src/features/server-workspace/file-editor-model.ts:10` 到 `:16` 计算首尾变化包络；`renderer/v2/src/features/server-workspace/ServerFileEditor.tsx:129` 明确说明高亮可能包含未改动行；`:130` 显示完整保存前/后文件；`renderer/v2/src/features/server-workspace/RemoteTextCode.tsx:26` 仅支持一个高亮范围。
- 影响：修改位于文件头尾时，大量中间未改行也被高亮，用户核对实际变更耗时增加。当前文案没有谎称最小 diff，应保留这种诚实降级。
- 有界实施方案：第一阶段复用 `RemoteTextCode`，将单区间扩展为多个变更区间，添加变更处数、上一处/下一处、当前变更编号及新增/删除行数；仍展示完整原文。差异模型先剥离共同首尾，预算为前后合计20,000行及250,000个动态规划单元；大文件或预算耗尽继续退回当前包络，并明确写“范围对照”，不显示伪精确增删统计。空文件按0行计数，不改写 BOM、原换行或任何字面值。优先无新增依赖实现。第二阶段才考虑折叠未变更上下文和内联/并排切换，不能以未完成第二阶段阻止第一阶段交付。
- 验收：单处修改、多处相隔修改、插入、删除、空文件、CRLF/LF、BOM、中文、重复行都显示正确；达到计算上限及时降级且不冻结；导航只移动视图不改变待保存内容；保存确认仍绑定同一个精确内容及远端前置条件；恢复版本逻辑保持。
- 参照：[VS Code 差异审查](https://code.visualstudio.com/docs/sourcecontrol/staging-commits)。

### W06：Redis 查看和编辑复用现有编辑器能力

- 证据：`renderer/v2/src/features/redis/RedisValueViewer.tsx:35` 到 `:42` 已提供查找、换行、JSON 折叠与 CodeMirror；`renderer/v2/src/features/redis/RedisValueEditor.tsx:48` 到 `:54` 有 JSON 高亮和查找；`renderer/v2/src/features/redis/RedisWriteEditor.tsx:14` 有 JSON 校验，但 `:23` 编辑为普通 textarea。
- 影响：从查看进入编辑后失去语法颜色、查找与结构定位，长 JSON 的排错成本明显增加。不能把此问题写成“缺少 JSON 校验”。
- 拟方案：复用现有 CodeMirror 依赖与高亮配置，通过明确的只读/可编辑参数和回调支持草稿编辑；可编辑模式增加行号、撤销/重做、搜索、Ctrl/⌘+S 和字节预算拦截。JSON“格式化”作为显式按钮，只在合法 JSON 时改变本地草稿；不在打开或切换格式时静默格式化。查看模式仍禁止编辑和文档变更。
- 验收：现有文本/JSON/十六进制查看、中文输入法、复制、折叠、查找和主题不退化；编辑改动只更新本地草稿，撤销/重做与字节限制有效；不完整文本和非文本仍只能查看；忙碌/未知结果时保持锁定；JSON 校验、TTL、保留原过期时间和确认流程保持。
- 参照：[Redis Insight 的格式化与可读内容展示](https://redis.io/docs/latest/develop/tools/insight/) 与 [VS Code 基础编辑](https://code.visualstudio.com/docs/editing/codebasics)。

### W07：SQL 工具条通过分组和说明强化主次关系

- 证据：`renderer/v2/src/features/database/MysqlSqlEditor.tsx:167` 到 `:176` 同时排列执行、范围菜单、停止、事务模式、提交、回滚与复制；提交/回滚在无活动事务时禁用。`renderer/v2/src/features/database/mysql-database-workspace.css:835` 明确采用固定按钮布局；`scripts/database-sql-ui.cjs:176` 到 `:180` 已验证 960×640 按钮完整可见。
- 影响：默认自动事务下仍有两个长期禁用操作；持续 SQL 操作时需要反复辨别哪些动作适用。现有固定布局避免位置跳动，应保留。
- 确定方案：保留事务默认值和稳定按钮位置；将执行/停止、事务模式/提交/回滚、复制分成可辨认组，保持执行为唯一主要操作。对提交/回滚展示明确禁用原因“没有待提交事务”或“当前模式自动提交”。既有960×640验证已证明按钮可见，当前没有必要把事务操作放入菜单；仅在后续真实溢出被证明时再评估该候选，活动事务和待核实状态始终可见。
- 验收：自动事务、逐条提交、手动事务、执行中、未提交、待核实状态下主动作含义明确；按钮不会随状态跳动；所有既有快捷键和执行范围仍可用；960×640、侧栏拖宽与长提示状态均无关键控件裁切。
- 参照：[DBeaver SQL 编辑器](https://dbeaver.com/docs/dbeaver/SQL-Editor/) 与 [事务模式](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/)。

### W08：Docker 日志补齐清除、键盘查找和匹配强调

- 证据：`renderer/v2/src/features/server-workspace/ServerDockerContainer.tsx:25` 到 `:26` 对已加载日志进行包含筛选；`:57` 有搜索和匹配行数；`:60` 用普通 pre 显示内容。当前没有此面板的 Ctrl/⌘+F 定位处理和明确清除按钮。
- 影响：日志查找已经存在，但与终端、MySQL 和 Redis 的查找入口及清除体验不一致；用户需要从筛出的整行里再次寻找词的位置。
- 拟方案：复用现有搜索框，添加清除按钮和输入焦点恢复；Ctrl/⌘+F 仅在当前日志面板内聚焦此搜索框，Escape 清除或退出；以文本节点拆分方式强调匹配词，禁止将日志送入 HTML。保持当前“筛选已加载日志”语义、手动刷新、时间范围与行数预算，不加入流式后台抓取或跨容器读取。
- 验收：中文、大小写、特殊字符和长行可搜索；匹配强调与匹配行数一致；清除恢复全部已加载日志；终端/文件/Redis 的快捷键不被截获；复制筛选结果/全部已加载的原文精确；截断提示保持。
- 参照：[Docker Desktop 日志查找](https://docs.docker.com/desktop/use-desktop/container/)。

### W09：服务器指标弹层明确服务器范围

- 证据：`renderer/v2/src/features/server-workspace/ServerMetrics.tsx:117`、`:122`、`:123`、`:124` 使用“本地磁盘”；指标实际来自当前服务器 scope；`test/server-workspace-metrics.test.mjs:346` 验证使用 `df -P -k -l`，确实只采集服务器本地文件系统。
- 影响：桌面工具同时管理本机与远端，“本地磁盘”可能被理解为 Windows 工作台电脑。技术筛选含义正确，但主语不充分。
- 拟方案：改为“服务器磁盘”或“服务器本地磁盘”，补一句“当前服务器的本地文件系统；不含网络挂载”。同步可访问名称、Tooltip 和测试选择器；保留采样来源和限制。
- 验收：CPU/内存/磁盘范围一眼一致；当前服务器标识不丢失；每 5 秒/30 秒采样、不可见暂停、旧数据提示与容量单位保持。
- 参照：[Docker Desktop 资源分区](https://docs.docker.com/desktop/use-desktop/container/) 的对象范围表达；这是本应用远端上下文中的措辞优化，不新增监控能力。

#### W09 实测复审：缩放后的窄头部保留服务器身份和完整百分比

- 实测证据（2026-10-01，临时模拟服务器）：`scripts/workspace-metrics-ui.cjs` 在浅色 800 CSS px 下读到头部高度 56px、服务器名称文本宽度 0、标题容器宽度 65px。磁盘单元范围为 x=332.78～392.20，而百分比为 x=388.97～414.86，侵入 x=404.20 开始的后续操作；头部自身 `scrollWidth` 没有溢出，不能据此证明子内容完整。仓库外 `server-metrics-failed-light-800.png` 也显示遮挡；`server-metrics-light-960.png` 中服务器名称同样消失，首行仅剩环境与连接徽标。800 CSS px 可由系统或应用缩放产生，物理窗口最小宽度 960 不能替代此验收。
- 原因与必要性：`server-workspace.css:211`、`:249` 的标题最低宽度 100/65px 小于两个身份/状态徽标的合计宽度，允许 `h1` 缩到零；`:212`、`:222` 允许指标组及磁盘单元压缩，但标签和数值并不会随单元边界等比例收缩。远端工作区必须同时让用户认出服务器、环境和当前资源占用，不能以隐藏名称或裁切百分比换取表面不溢出。
- 最小方案：保留 56px 头部和字号；为名称保留至少 64px 可见区域，并保留完整名称提示。1300px 以下将返回、工作区管理和应用设置这三个已有可访问名称和完整提示的入口收为 32px 图标，复用公共 Button 的 `aria-description`/Tooltip，不要求它透传原生 DOM `title`；工作区数量继续写在完整提示与可访问名称中。现有 1440px 截图中带容量的指标约占 450px，加上已测按钮宽度及名称区域可知，若图标化仍与容量共用 1150px 阈值，1151px 会再次挤压标题；因此先压缩入口文字，再按原 1150px 阈值收起容量，1300px 的具体边界由下一次真实几何验收确认。连接配置、关闭、连接/重连/取消及其禁用状态仍在原处，连接动作文字保留。指标组与磁盘单元不压缩到内容以下；900px 以下只缩小既有间距和横向留白、进一步省略挂载路径，并把连接徽标文字转为保留完整提示与读屏文本的状态图标，生产/测试身份仍完整可见。采样、值、阈值、磁盘范围与暂停规则不变。
- 验收补充：浅/深色 1440、1301、1300、1151、1150、960、900、800 CSS px 检查实际名称文本 Range 的可见宽度大于零，名称区域至少 64px，并且不侵入身份徽标或指标；所有 CPU/内存/磁盘百分比和旧值前缀均在各自单元内；每个头部操作中心可命中、名称可读，图标入口仍有完整提示；长挂载路径不挤压百分比。不能仅检查父容器尺寸或取消原采样/写入次数断言。
- 参照：[VS Code 标题栏布局控件](https://code.visualstudio.com/docs/configure/custom-layout#_customize-layout-control) 使用带悬停说明的紧凑图标保留布局入口。本应用将这一成熟模式用于已有导航/设置入口，响应式阈值由上述真实几何证据决定；不照搬新菜单或新增密度设置。字体和操作尺寸遵守 D07。

### W10：终端查找提供可发现的点击入口

- 证据：`renderer/v2/src/features/server-workspace/ServerTerminal.tsx:491` 到 `:498` 有作用域明确的 Ctrl/⌘+F；`:503` 到 `:508` 的工具条有复制、粘贴、目录配色、会话控制；`renderer/v2/src/features/server-workspace/TerminalSearch.tsx:64` 默认隐藏，只有快捷键调用其 open。
- 影响：熟悉快捷键的用户已可查找，但新用户和主要使用鼠标的用户难以发现此能力。
- 拟方案：在现有工具条增加紧凑查找图标，并在终端上下文菜单提供“查找内容”；同一动作调用现有 open。Tooltip 显示快捷键及“已加载终端内容”。保留当前终端作用域、选择词自动填入、大小写选项和 Enter/Shift+Enter 导航。
- 验收：点击和快捷键均打开当前终端搜索，不改变 Shell 输入；断线保留历史时仍可搜索；隐藏窗格不响应；Esc 回到当前终端；搜索配色与 ANSI 语义色均保持。
- 参照：[VS Code 终端查找](https://code.visualstudio.com/docs/terminal/basics) 与 [W3C 功能应可发现](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)。

#### W10 实施复审：查找焦点应在上下文菜单完成关闭后交接

- 实测证据（2026-10-01，CONVENIENCE 合成夹具的优化前专项诊断）：菜单选择通过原有 DOM 模型输入执行，记录 `inputMode: dom-menu-selection`、`trusted: false`、`targetMatches: true`，不声称原生鼠标集成。等待菜单彻底卸载及两个动画帧后，`menuPresent: false`、`searchPresent: true`，但 `searchFocused: false`、`activeTag: TEXTAREA`、`activeIsTerminal: true`、`activeWithinPanel: true`；搜索框可见而焦点回到终端。诊断只记录固定控件名、布尔值和选区/几何数字，没有记录搜索词或终端内容。
- 原因与必要性：复审前 `ServerTerminal.tsx:533` 的查找菜单 `onSelect` 立即调用原 `searchRef.open`，`TerminalSearch.tsx:41` 随后用动画帧聚焦并全选输入；`ServerTerminal.tsx:532` 的菜单 `onCloseAutoFocus` 又无条件恢复终端焦点。两个异步聚焦没有明确先后，可能让用户的关键词输入回到 Shell，违反本项既有“聚焦查找、不改变 Shell 输入”验收。
- 最小方案：复用已有 `useMenuHandoff`，查找菜单选择只登记原 `open` 动作，菜单完成关闭及焦点恢复后再执行。动作绑定项目/环境/插件、终端标签及当前可见/激活代次，卸载、隐藏、切换标签、重开菜单或出现新浮层时作废。复制、粘贴及 Escape 关闭仍恢复当前终端；检索、已加载缓冲、选择词、搜索配色、权限和远端读取均保持原契约，不修改 `TerminalSearch` 检索逻辑。
- 验收补充：菜单完全关闭后，实际搜索输入拥有焦点和完整选区；原生 Ctrl/⌘+F 分别从搜索输入和匹配按钮进入，严格验证事件目标、`isTrusted=true` 及受控处理，原关键词不变；菜单和快捷键操作不新增 Shell 写入。保留匹配数量、主题、断线历史、标签隔离和关闭返回终端的原断言，不通过重新聚焦或模拟菜单关闭掩盖产品问题。

### W12：Docker 非运行状态采用一致中文标签

- 证据：`renderer/v2/src/features/server-workspace/ServerDockerTree.tsx:49` 把 running 翻译为“运行中”，其他状态直接显示后端字符串；`:39` 筛选却使用“未运行”。概览 `renderer/v2/src/features/server-workspace/ServerDockerContainer.tsx:53` 同样直接显示 state。
- 影响：中文 UI 中相同状态的列表、筛选、概览用词不同，尤其 paused/restarting/exited 不应一概被理解为停止。
- 拟方案：有限的纯展示映射：运行中、已退出、已暂停、重启中、已创建等，Tooltip 保留原始 Docker 状态供运维核对，未知状态原样展示。只对名称规范化，不将复杂生命周期合并为连接状态色。
- 验收：列表和概览同一状态一致；筛选仍按原 state 计算；未知状态不隐藏；运行与健康检查分别表达，不新增生命周期控制。
- 参照：[Docker Desktop 容器列表与对象概览](https://docs.docker.com/desktop/use-desktop/container/)。

## 保留：功能、组件、图标与交互盘点

### W11：保留共享图标的公共 Tooltip 和禁用原因提示

- 复核证据：`renderer/v2/src/components/ui/button.tsx:43` 从 props 提取 title，`:55` 将其作为 aria-description，`:59` 对 disabled+title 使用 `DisabledReason`，`:60` 将 title 转为公共 Tooltip，实际没有把它透传为原生 DOM title。`renderer/v2/src/components/ui/disabled-reason.tsx:5` 已为禁用原因提供可聚焦包装。
- 复用链：`renderer/v2/src/components/workspace/WorkspaceControls.tsx:16` 的 `WorkspaceIconButton` 和 `renderer/v2/src/components/workspace/WorkspaceLayoutControls.tsx:34` 的 `WorkspacePanelToggle` 都调用这个公共 Button。其键盘/悬停提示能力已经存在，原先“只使用原生 title”的判断不成立。
- 分类与动作：改为保留，取消 W11 的确定实施。不要再添加一层 Tooltip 或禁用包装，以免叠加触发器和焦点入口。没有 title 的具体孤立图标，仅在逐项验证发现缺少可发现说明时补齐，不能扩展为共享控件整体重做。
- 保留验收：普通图标悬停/聚焦可查看说明；需要解释的禁用动作可读取原因；现有 aria-label、aria-description、Popover/Dialog/Menu 触发器与焦点不退化。
- 参照：[W3C 禁用控件可发现性与键盘说明](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)。现有公共实现已经采用对应机制。

以下各项未发现必须整体重做的证据。动作、图标和约束按功能组列出；标为“保留并改 Wxx”的条目只实施对应小项，不代表重做整个模块。

| 功能/组件 | 已有按钮、图标和交互 | 评估与准确证据 |
| --- | --- | --- |
| 共享标题与导航 | 返回箭头、工作区切换、连接配置、设置、重连/断开/取消连接、关闭 X；返回保留工作区，关闭说明清理影响 | 保留结构并改 W01；图标提示按 W11 保留。`WorkspaceControls.tsx:19`、`:30`、`:33`；服务器 `ServerWorkspace.tsx:394`、`:444`；MySQL `MysqlDatabaseWorkspace.tsx:106`；Redis `RedisWorkspace.tsx:265` |
| 共享标签/布局 | 最大化/恢复 ArrowsOut/ArrowsIn；CaretUp/Down 收起/展开 SQL 编辑器；aria-controls、aria-expanded | 保留。`components/workspace/WorkspaceLayoutControls.tsx:18`、`:33`；多个工作区实际复用，避免另建三套尺寸和图标规范 |
| 共享反馈 | SpinnerGap、慢响应等待秒数、status/alert、截断摘要、Tooltip 原文、错误详情按钮/弹窗与诊断 | 保留。`components/workspace/OperationFeedback.tsx:13`、`:22`、`:29` 到 `:33`；已有处理建议入口，不把截断消息写成没有详情 |
| 服务器资源轨道 | HardDrives 文件图标、自有 Docker SVG；点击切资源，方向键/Home/End 聚焦、Tooltip | 保留。`server-workspace/ServerResourceRail.tsx:11` 到 `:26`；仅两个资源，无需强行增加文字导航占据宽度 |
| 目录工具条 | TreeStructure/ListBullets 切换树/详情，CaretUpDown 收起全部，Eye/EyeSlash 点文件，Crosshair 定位当前文件/终端目录，刷新旋转图标、UploadSimple 上传、Star 常用目录 | 保留并改 W02；图标提示按 W11 保留。`server-workspace/ServerFileTree.tsx:779` 到 `:788`；动作具 title 和 aria-label，公共 Button 转为 Tooltip，禁用随连接/繁忙状态变化 |
| 路径导航与收藏 | ArrowUp 上级、路径面包屑、PencilSimple 编辑绝对路径、“转到”、Star 收藏/取消收藏、X 移除收藏 | 保留。`ServerFileTree.tsx:791` 到 `:801`；`DirectoryBookmarks.tsx:47` 到 `:56`；完整路径可读取、收藏在既有 scope 下，不把 Runbook 变成文件允许列表 |
| 目录内容与分批读取 | 目录/文件/链接图标与展开箭头、循环/不可用链接提示、名称/大小/时间排序、仅筛选已加载文件、行内 DownloadSimple、加载更多/下一批/上一批/重试 | 保留并改 W02。`ServerFileTree.tsx:803`、`:838`、`:858`、`:880`、`:910` 到 `:912`；保留虚拟滚动与读取上限，无法读取对象不伪装为空目录 |
| 文件菜单/属性/变更 | 复制名称/路径、下载、属性、刷新所在目录、新建目录、重命名、危险删除；检查/修改名称/确认；属性刷新 | 保留。`ServerFileMenu.tsx:162` 到 `:171`、`:176`、`:199` 到 `:203`；危险动作含精确目标和不可撤销说明，不减少确认步骤 |
| 文件路径定位 | 可点击完整路径、Tooltip、断线 aria-disabled、定位目录树 | 保留。`ServerFilePath.tsx:8` 到 `:9`；文件内容和终端路径关联已有，不列为新增缺失功能 |
| 文件预览/日志跟随 | FileText、只读标记、编辑、头部、末尾、Play/Pause 跟随/暂停、刷新、关闭、继续读取；内容搜索和上下匹配箭头 | 保留。`ServerFilePreviews.tsx:52`、`:145` 到 `:153`；只搜索已加载文本、滚动离开末尾暂停、隐藏期间暂停、截断预算说明都合理 |
| 文件编辑与恢复 | FloppyDisk 检查并保存、结束编辑、重新读取、ArrowCounterClockwise 恢复上次版本、检查保存结果、草稿保护；CodeMirror 行号、查找/替换、Ctrl/⌘+S | 保留并改 W05。`ServerFileEditor.tsx:115` 到 `:133`；`RemoteTextCode.tsx:18` 到 `:24`；保留 BOM/换行和混合换行只读约束 |
| 服务器文档标签 | TerminalWindow/File/Docker 类型图标、关闭 X、新增 Plus、未保存点、同名文件父路径；点击切换、方向键/Home/End/Delete、双击/F2 重命名、拖拽/Alt+方向键排序 | 保留。`WorkspaceTabs.tsx:24` 到 `:39`；`ServerTerminalTabs.tsx:114` 到 `:137`；终端 8 个、容器 6 个等既有上限不提高 |
| 分屏与大小调整 | Square 单栏、Columns 左右、Rows 上下、交换左右/上下箭头；拖动分隔条、方向键调比例、Home/双击均分、当前窗格标记 | 保留。`WorkspaceSplitMenu.tsx:7` 到 `:38`；`WorkspaceSplitHandle.tsx:4` 到 `:19`；`ServerTerminalTabs.tsx:121` 到 `:128`；只在窗格宽度/焦点实测证明有问题时再调默认比例 |
| 终端会话与剪贴板 | TerminalWindow 状态、Copy 复制、ClipboardText 粘贴、Stop 结束/停止恢复、Plus 打开、重连、关闭 X；多行粘贴预览确认、命令审计提示 | 保留并改 W10。`ServerTerminal.tsx:491` 到 `:511`、`:532`、`:541` 到 `:563`；不把复制快捷键替换为 Shell Ctrl+C，不取消多行确认 |
| 终端颜色与文字 | 14px 等宽字体及中日韩回退；light/dark ANSI 16 色、选择背景、光标；目录配色开关、Linux/BSD 选择、填入命令 | 保留语义色和现有会话约束。`ServerTerminal.tsx:21` 到 `:32`、`:313` 到 `:318`、`:546` 到 `:555`；不得为了主题统一把红色错误、蓝色目录等映射为品牌绿 |
| 终端搜索 | Ctrl/⌘+F、Aa 区分大小写、上下匹配箭头、匹配计数、Esc 关闭；选中词自动带入、1000+ 匹配上限、深浅主题强调 | 保留并改 W10。`TerminalSearch.tsx:23` 到 `:40`、`:64` 到 `:80`；只检索当前已加载终端缓冲，不新增远端搜索 |
| 上传准备与冲突 | 本地→目标路线、类型图标、Copy 路径、ArrowRight、同名 warning Badge、单文件/批次覆盖/跳过/保留两份、X 移除、覆盖确认 Checkbox、校验进度、重新检查/选择、开始/继续上传 | 保留。`ServerUploadDialog.tsx:55` 到 `:83`；路径可完整换行，续传校验和忙碌阻止关闭已有，不能只留一个含糊“确定”按钮 |
| 上传/下载任务栏 | ArrowsDownUp 折叠、汇总进度、Upload/Download 区分、CheckCircle 完成、Trash 清结束记录、上传按钮；Pause 暂停、继续上传、X 取消/移记录、MapPin 远端定位/本地位置、重新下载 | 保留。`ServerWorkspace.tsx:431` 到 `:440`；`TransferProgress.tsx:15` 到 `:28`；已有总进度、速度、ETA、排队/校验/暂停/中断/错误状态，不能列为功能缺失 |
| 资源指标 | CPU、内存、磁盘数值；80/90 阈值 warning/danger；旧值/暂停/不支持占位；磁盘 CaretDown 弹层、挂载选择、采样时间 | 保留并改 W09。`ServerMetrics.tsx:47`、`:55`、`:93` 到 `:131`；`server-workspace.css:212` 到 `:237`；已有旧值和不可见暂停，无需为了美观添加高频动态图表 |
| Docker 列表 | Docker 图标、刷新、容器/镜像/Compose 搜索、全部/运行中/未运行筛选、Compose 展开/折叠、状态文本、数量、采样时间、错误和截断提示 | 保留并改 W12。`ServerDockerTree.tsx:36` 到 `:54`；不默认新增批量生命周期动作 |
| Docker 概览/日志/资源 | 概览/日志/资源切换、容器短 ID、刷新；时间范围、200/500/2000 行、复制筛选/已加载全部；名称/镜像/健康/退出码/时间/端口/挂载；CPU/内存/网络/磁盘/进程 | 保留并改 W08/W12。`ServerDockerContainer.tsx:37` 到 `:67`；日志手动刷新、资源可见时每 5 秒采样、旧结果和截断说明已有 |
| MySQL 数据表侧栏 | Database 标识、刷新、MagnifyingGlass 表名搜索、清除 X、已加载数量、Table/视图类型、Code 生成 SELECT/拖表生成 SQL、更多表/上限/空态 | 保留。`MysqlDatabaseWorkspace.tsx:202` 到 `:216`；搜索只覆盖已加载表已有说明，不应包装成完整数据库搜索 |
| MySQL 文档与表结构 | Code SQL 标签、Table 表标签、新建 Plus、关闭 X、事务点/警告、可调侧栏/编辑器；Table 数据/ListBullets 结构、刷新结构、字段/类型/NULL/默认/额外属性 | 保留。`MysqlDatabaseWorkspace.tsx:223` 到 `:249`；`MysqlTableDocument.tsx:13` 到 `:29`、`:67` 到 `:70` |
| SQL 输入与执行 | 高亮、行号、补全、语法检查、行列位置、UTF-8、拖表/字段；Play 执行当前/选区/脚本、Stop 停止、事务模式、Check 提交、回滚、Copy；Ctrl/⌘+Enter/Shift 执行、Ctrl+Space 补全 | 保留并改 W07。`MysqlSqlEditor.tsx:65` 到 `:105`、`:167` 到 `:177`、`:184` 到 `:227`；不把基础语法检查当作数据库权限验证 |
| SQL 确认/多结果/事务摘要 | 环境标记、目标库、语句/写入数、无 WHERE 危险提示、脚本原文、取消/确认；逐语句状态与行号/耗时/影响行、核对未知结果；事务摘要折叠、修改数量、时间/空闲状态 | 保留。`MysqlSqlConfirmation.tsx:13` 到 `:20`；`MysqlSqlExecutionResults.tsx:21` 到 `:33`；`MysqlTransactionSummary.tsx:23` 到 `:39`；安全提示应有语义依据，不泛化为常驻危险色 |
| MySQL 表数据读取 | WHERE 输入、Code 查询设置/SQL、每批行数、Play 执行、字段拖入、服务端排序、读取更多、旧数据提示 | 保留。`MysqlTableBrowser.tsx:129` 到 `:141`；区别于结果里的本地已加载筛选，不把二者合并成无法判断的搜索框 |
| MySQL 结果表格 | 本地筛选/清除、重名列/截断/审计失败提示、列排序/拖动/适配宽度、行勾选、单元格完整复制、结果计数/耗时/字节、分页与加载更多 | 保留并改 W03。`MysqlQueryResults.tsx:162` 到 `:203`、`:232` 到 `:244`、`:273` 到 `:292`、`:331` 到 `:340` |
| MySQL 行编辑工具 | Plus 新增、Copy 复制为新行、Trash 删除、Rows 批量赋值、SelectionSlash 取消选择、刷新；内联/多行编辑、NULL/默认值、未保存标记、保存/检查状态、放弃更改/删除确认 | 保留。`MysqlEditableResults.tsx:442` 到 `:449`、`:498` 到 `:529`、`:539` 到 `:556`；新增和复制草稿不与已有行混淆、批量修改仅指定字段 |
| MySQL 行详情/整行输入 | 行详情关闭 X、每字段 Copy、整行 JSON；新增字段搜索、填写/默认/NULL 选择、多行文本、字段错误、暂存/取消 | 保留。`MysqlResultRowDetail.tsx:35` 到 `:80`；`MysqlRowSheet.tsx:37` 到 `:57`；长值已有完整查看入口，不能说“无法看被省略的内容” |
| MySQL SQL 导出 | SELECT/INSERT/UPDATE/DELETE 类型、UPDATE 字段勾选、只生成不执行说明、原文预览、复制 SQL、保存 .sql、关闭 | 保留。`MysqlSqlExportDialog.tsx:35` 到 `:41`；不新增自动执行导出脚本的动作 |
| Redis DB 与范围 | 固定 DB Badge、CaretDown 已登记范围选择、范围显示名/模式、单范围静态显示、未配置说明 | 保留。`RedisScopePicker.tsx:19` 到 `:38`；不能为了“像 Redis Insight”增加任意 DB 或不受控模式 |
| Redis 搜索与历史 | MagnifyingGlass 搜索、完整 Key/关键词或通配符、精确匹配 Checkbox、Enter、最近历史/清空、方向键建议、中文输入法保护、Ctrl/⌘+F 定位 | 保留。`RedisKeySearch.tsx:39` 到 `:74`；`RedisWorkspace.tsx:182` 到 `:185`；历史按 scope，未完成扫描与未找到结果区分 |
| Redis Key 树与扫描 | 树/列表切换、刷新、展开/收起、Folder/Key 图标、已加载分组数、关键词强调、目录右键搜索、路径摘要、停止/继续搜索、加载数和状态 | 保留。`RedisKeyBrowser.tsx:150` 到 `:183`；`RedisWorkspace.tsx:213` 到 `:228`；已有 roving tabindex 可复用作 W02 样板 |
| Redis 文档标签/元信息 | PushPin 固定、预览斜体、关闭 X、未保存/处理中/待核实；类型 Badge、Key 完整显示与 Copy、大小/成员数、TTL、读取时间、刷新 | 保留并改 W01。`RedisWorkspace.tsx:75` 到 `:95`、`:234` 到 `:258`；最近读取 TTL 已注明，不改成伪实时倒计时 |
| Redis 五类内容 | String 文本/JSON/HEX；Hash 精确字段定位；List/Set/ZSet 成员表、更多数据、选中值展示；过期/不存在/不支持/截断提示 | 保留。`RedisWorkspace.tsx:95` 到 `:127`；`RedisValueViewer.tsx:23` 到 `:43`；不新增不受支持类型的写入能力 |
| Redis 内容查看工具 | JSON/文本/十六进制分段、复制当前/已加载部分、查找 MagnifyingGlass、TextAlignLeft 换行、JSON 全部折叠/展开；CodeMirror 只读、高亮、本地查找 | 保留并改 W06 编辑部分。`RedisValueViewer.tsx:25` 到 `:42`；`RedisValueEditor.tsx:49` 到 `:65` |
| Redis 新建/编辑/TTL | Plus 新增、PencilSimple 编辑值、JSON/文本模式、字节计数、过期方式/时长单位、取消、FloppyDisk 保存、Ctrl/⌘+S、结果核实 | 保留并改 W06。`RedisWriteEditor.tsx:13` 到 `:32`；String/完整 UTF-8 编辑限制在 `RedisWorkspace.tsx:258` 已明确 |
| Redis 删除与冲突处理 | Trash 删除、环境/DB/类型/精确 Key、不可撤销说明、取消/确认删除；未知结果核实、服务器当前值与保留草稿对照、未保存导航/关闭保护 | 保留。`RedisWorkspace.tsx:265` 到 `:276`；不得省掉确认或把“当前不存在”自动当成上次删除成功 |

上表简写路径：服务器条目位于 `renderer/v2/src/features/server-workspace/`，MySQL 位于 `renderer/v2/src/features/database/`，Redis 位于 `renderer/v2/src/features/redis/`；共享条目已显式写目录。

## 信息密度、长期舒适度和配色结论

| 模块 | 当前可保留的基础 | 适合实施的改善 | 不应无证据改动 |
| --- | --- | --- | --- |
| 服务器 | 资源轨道、侧栏、统一文档标签、可调分屏；终端 14px 等宽字体；传输默认汇总；指标小型常驻 | W01/W02/W05/W09/W10 提高准确性、核对和发现效率 | ANSI 语义色、粘贴颜色机制、终端字体回退、恢复状态机、传输暂停/续传逻辑 |
| MySQL | 表侧栏+SQL/结果+表文档；32px 行；查询统计收纳弹层；结果区已有 container query | W01/W03/W04/W07，重点减少焦点与事务识别成本 | 为追求“简洁”移除事务状态、未保存数量、关键危险提示，或把服务器 WHERE 与本地结果筛选混为一个功能 |
| Redis | 范围/搜索/树在左，类型/TTL/内容在右；Key 可完整横向查看；格式工具集中；状态占固定高度 | W01/W06，重点补齐查看到编辑的连续性 | 隐藏范围、自动扩大读取、误导的实时 TTL、增加不受支持写类型 |
| Docker | Compose 分组、状态筛选、概览/日志/资源分区；文本状态配合颜色；采样时机清楚 | W08/W12，提高日志定位与状态用词一致性 | 没有需求时添加启停/删除/Exec；仅为“看起来高级”加入持续抓取或动态图表 |

颜色基础已经统一到 `renderer/v2/src/styles/globals.css:120` 的控件高度、`:134` 的主色和成功/警告/危险令牌；焦点、强制颜色、减少运动处理见 `:218`、`:259`、`:277`。目录选中、结果草稿、搜索匹配和危险操作应保留各自语义。服务器 diff 现有删除/新增色在 `server-workspace.css:338` 到 `:339`；Redis JSON 语法类在 `RedisValueEditor.tsx:15` 到 `:21`。没有对比度实测证据时，不断言“现有配色不达标”。

12px 次级文字广泛用于工具条和数据内容，服务器文件编辑器在 `server-workspace.css:325` 固定 12px；终端则在 `ServerTerminal.tsx:316` 为 14px。这是需要长期阅读验证的密度选择，不是本轮证明的错误。先修复任务效率，再决定是否增加统一字体/密度偏好，避免直接放大所有 UI 后减少工作面积。

## 待验证：不作为已证明的必改项

| 验证项 | 当前证据与未知点 | 验证方式及修改触发条件 |
| --- | --- | --- |
| 窄窗口与面板宽度 | 应用最小 960×640：`src/main.mjs:80` 到 `:81`；已有 SQL 按钮完整可见测试 `scripts/database-sql-ui.cjs:176`；结果区域已有 `mysql-database-workspace.css:793` 到 `:794` 的容器适配 | 960×640、1280×720、侧栏最大宽、左右/上下分屏、长标签与状态条并存；只有关键控件被裁切或主要任务过度滚动时，实施面板级收纳/菜单，不宣称没有响应式 |
| 125%/150% Windows 缩放和长时间阅读 | 小字体确实存在，但源码不能证明实际屏幕不舒服；现有终端字体专门考虑中文回退 | 用模拟数据连续完成终端/配置核对/宽表/JSON 编辑，记录误读、眼疲劳与有效面积；出现稳定问题再提供统一字体或密度设置 |
| 浅色/深色语法和状态色对比度 | 有完整主题和语义令牌；部分终端搜索与 ANSI 使用专门色值 | 测算普通文字、次级文字、语法类别、占位、警告、选择/焦点的对比；只修正已失败的色对，不全局改成品牌色 |
| 传输面板长期信息密度 | `server-workspace.css:62` 行为 84px；宽屏有速度/进度/操作列，已有宽度断点 | 10 个混合任务、长名称、暂停/中断/错误消息、低高度窗口；若遮挡终端任务且难以管理再增加紧凑任务布局，保留进度/状态/错误可读性 |
| 指标信息是否足够 | CPU/内存/磁盘有即时值、时间、阈值和旧值，未提供时间序列 | 真实目标用户是否需要趋势诊断；需求成立再评估历史采样与安全预算，不以缺少图表判定当前设计不成熟 |
| Docker 日志是否需要下一处/上一处 | 当前是行筛选，不是逐条匹配导航；W08 足以改善已存在的任务 | 2000 行加载范围内用户是否仍需逐处跳转；需求成立再扩展导航，避免混淆“行数匹配”和“处数匹配” |
| 关闭与返回的学习成本 | 三种工作区都有明确关闭确认和返回保留说明；不确定用户是否仍误关 | 观察完成后退出工作区任务和未保存任务；只有反复误解才调入口文案或位置，不先取消现有保护 |
| 屏幕阅读器与焦点恢复 | 有很多 aria 属性与快捷键；W02/W03 的焦点结构问题有代码证据，其他组合仍需实测 | Windows Narrator/NVDA、键盘操作 Popover/Dialog/ContextMenu、虚拟滚动和结果追加；修复具体失败，不能声称已完成无障碍认证 |

## 实施与验证边界

建议先交付 W01/W02/W03，再完成 W04/W07/W08/W09/W10/W12 的小范围展示和交互改善；W05/W06 分别按上述有界方案独立交付。W11 已复核为保留，不实施重复 Tooltip 包装。W05 的完整上下文折叠不是第一阶段前置条件，W06 不需要新增生产依赖。待验证项保持待验证，不能未经证据纳入“全部必须优化”。

每项行为改变需要与现有 UI 模拟脚本结合验证，优先扩展真实交互断言而非只断言源码中出现类名。共享工作区/连接/布局变化执行 `corepack pnpm run test:ui`；服务器、数据库、Redis、Docker 分别执行 `corepack pnpm run test:ui:server-workspace`、`corepack pnpm run test:ui:database`、`corepack pnpm run test:ui:redis`、`corepack pnpm run test:ui:docker` 的适用项；最终执行 `corepack pnpm run check` 和 `corepack pnpm test`。仅本文档变更先做 `git diff --check` 与路径/命令核验，不伪称已运行应用套件。

现有验证入口包括 `scripts/workspace-controls-ui.cjs`、`scripts/workspace-layout-ui.cjs`、`scripts/workspace-file-editor-ui.cjs`、`scripts/server-terminal-theme-ui.cjs`、`scripts/server-terminal-interaction-ui.cjs`、`scripts/workspace-transfer-layout-ui.cjs`、`scripts/workspace-metrics-ui.cjs`、`scripts/workspace-docker-ui.cjs`、`scripts/database-sql-ui.cjs`、`scripts/database-edit-ui.cjs`、`scripts/database-reconnect-ui.cjs`、`scripts/redis-reconnect-ui.cjs`。优化前评估仅核对这些入口；后续执行结果见[主方案](ui-optimization-plan.md)。

本次 UI 优化不得改变凭据隔离、项目/环境/插件作用域、连接检查、短期上下文、单次确认及精确参数绑定、文件 stat/hash 前置条件、数据库/命令策略、主机密钥验证和审计。仅使用模拟远端数据验证；不得将真实服务器输出、数据库内容、Runbook 或凭据写入审查文档、截图或测试夹具。
