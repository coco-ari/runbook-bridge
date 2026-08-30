# 全功能检查与交付验证

状态：本地验证完成（2026-08-31，Windows x64，Node.js 24.12.0 / 22.23.2，pnpm 11.21.0）。下列通过结论仅对应列出的场景与边界；提交和推送信息随最终交付记录提供。

## 验证原则

- 覆盖当前已交付功能，不把未来的部署功能或第三方插件市场纳入现有能力。
- 界面测试使用真实 Renderer；插件请求尽可能穿过真实 IPC、store、编辑会话、探针与凭据解析器，网络端使用模拟运行时或本机测试服务。
- 全部数据使用临时目录和合成数据，不连接真实基础设施，不读取用户的生产配置或凭据。
- 不以无条件成功的 API mock 或源码正则代替行为验证。安全合同测试作为补充，不能单独证明功能可用。
- 正常、失败、取消、重试、重复操作、并发变更、过期响应、作用域切换和删除后重建都需要覆盖。
- 凭据隔离、精确作用域、单次确认、主机指纹与 TLS 校验、数据库只读策略保持不变。
- 测试只能证明列出的场景和环境；不宣称对所有外部网络、服务器及操作系统组合有绝对无缺陷保证。

## 功能矩阵

| 范围 | 场景 | 主要证据入口 | 状态 |
| --- | --- | --- | --- |
| 项目与环境 | 新增、重命名、排序、删除、删除重建、空状态、失败重试、版本冲突 | `scripts/ui-react-business-smoke.cjs`、project/environment/store 测试 | 通过 |
| 插件新增 | Server 密码/私钥/Agent，MySQL 固定库，Redis Logical DB，有凭据/无凭据，空值与非法输入 | plugin UI smoke、probe/edit/IPC/store 测试 | 通过 |
| 连接方式 | 直连、Server 代理、同环境 SSH 隧道、VPN 参数、依赖缺失或删除、TLS 显式探测与确认 | plugin UI、connection/route/runtime 测试 | 通过；外部环境限制见下文 |
| 验证生命周期 | 检查中编辑、切类型、取消、关闭、切作用域、迟到成功/失败、指纹与 TLS 重试 | plugin editor/UI、probe/edit session 测试 | 通过 |
| 插件编辑 | 保留/替换凭据、改变身份/数据库/DB、保存失败重试、修订冲突、取消恢复、重复保存 | plugin edit/credential/IPC/UI 测试 | 通过 |
| 插件删除重建 | 删除最后插件、同/不同标识重建、旧凭据保留但不误复用、依赖保护、写入失败无残留 | plugin UI、backend lifecycle/store、包内真实协议测试 | 通过 |
| 正式连接 | 单插件/整环境连接、部分成功、重试、取消、断开、指纹确认、切页与刷新 | connection-intent/environment/runtime 测试、UI smoke | 通过 |
| 运维说明 | 读取、编辑、保存、取消、版本冲突、切页保护 | runbook 测试、business UI smoke | 通过 |
| 快捷提问 | 全局开场词、增改删、复制、空状态、冲突与失败重试 | quick-question 测试、business UI smoke | 通过 |
| 记录与确认 | 过滤/分页/清空、允许/拒绝、强确认、过期与单次执行、作用域变化 | audit/confirmation/gate 测试、business/plugin UI | 通过 |
| MCP / Server | 工具发现、上下文、状态/文件/日志/压缩归档读取、受确认保护的变更 | MCP/service/broker/server/policy 测试 | 通过 |
| MCP / 数据库 | MySQL 固定库只读与结构查询，Redis pattern 内有界读取，拒绝越权操作 | mysql/redis/policy/MCP 测试 | 通过 |
| 桌面基础 | 导航、搜索、键盘、焦点、弹窗隔离、缩放、面板布局及持久化、空/异常状态 | foundation/business UI、packaged UI | 通过 |
| 发布产物 | 生产 Renderer 资源、35 个 MCP 工具、版本一致、安装程序生成、临时数据启动与重启 | dist、verify-package、packaged-mcp/ui smoke | 通过；未在当前账户安装 |
| 提交交付 | 排除本地配置/凭据/生成物、提交、推送、安装包哈希与路径 | git、构建产物与最终交付记录 | 本地检查完成；提交与推送见交付记录 |

## 已知问题与修复记录

- 新增探针错误携带 `credentialIntent`：新增请求省略编辑凭据控制字段，类型禁止误传；后端继续拒绝所有新增探针凭据复用控制字段。
- MySQL 数据库列表真实返回 `{databases,truncated}`，前端原先按数组处理；已同步桥类型、列表与截断提示。修改已有非空密码、变更草稿、迟到结果与失败均受代次隔离，发现按钮不会永久停留在忙碌状态。
- 编辑检查尚未获得 operationId 时错误调用新增探针取消；取消后迟到成功仍可能保存；取消失败后关闭可能遗留探针。已正确区分新增和编辑取消、校验请求代次，并在关闭时清理仍存活的操作。
- Server 代理切换使用了错误默认端口，切上行方式后隐藏代理密码仍可能发送；已按真实代理类型设置端口并清理隐藏临时字段。
- 修改部分凭据时，验证与保存的字段合并不同：验证漏用了同一身份下未修改的 SSH 或 TLS 字段。现仅在同身份编辑时合并；新探针与跨身份请求不读取旧凭据，不可读旧凭据的保存仍需独立显式替换确认。
- 创建插件时环境索引写失败会遗留配置文件；已回滚本次创建文件，并拒绝覆盖原有未入索引文件。
- 删除插件依赖、非空/最后环境、仍连接/待恢复事务项目被拒绝时，原先先清除了编辑会话。现先执行无副作用预检，并在进入实际变更时重新检查。
- 项目删除被自身项目门禁阻断：保留项目级封锁、活动排空、状态重读与事务恢复保护，移除与其冲突的重复环境变更入口。
- 删除后同标识重建可能继承保留的凭据。GUI 与 MCP 共享创建身份隔离：自动命名可同名重建并使用新标识，显式历史标识被稳定拒绝；旧凭据文件保持原字节。插件、环境和项目删除后重建均覆盖。
- 旧 SSH 验证迟到的主机指纹错误会污染新一轮编辑；只允许当前操作、当前代次且未取消的结果更新临时指纹。
- 正式连接的 props、刷新、连接完成、指纹确认回包缺少序列防护；已阻止旧状态覆盖新状态及旧指纹弹窗重开，过期刷新错误不会覆盖已连接状态。六项执行真实 hook 回调的行为回归覆盖这些路径及取消/切范围控制。
- Server 从密码切换 SSH Agent 被误要求复用旧密码；只对不需要应用管理凭据的 Agent 连接放行。带认证代理和切回密码仍保留原凭据门禁。
- 打包真实协议测试复现删除最后一个已连接插件后，环境界面已显示未连接，但 `desiredConnected` 仍为 true，导致空项目无法删除。空环境需要清除连接意图与重试状态；仍有其他连接分支时必须保留其意图。此路径加入包内断言与后端回归。
- 审计列表桥类型改为真实 `{entries,nextCursor}`。模态测试改为验证后台交互控件隐藏、实际背景聚焦被拦回与真实 Tab/Shift+Tab 循环，同时保留 `aria-live` 状态区域。
- 首轮干净 Windows CI 暴露了测试兼容性问题：Node 22 下模拟连接没有活动网络句柄，测试会早于生产 `unref` 超时退出；六处等待增加仅测试使用的五秒有界保活，原超时、错误码和状态断言保留。快捷提问源码边界检查改为兼容 LF/CRLF，并断言边界确实存在且顺序正确。这两项没有修改应用源码或生产超时策略。

## 安全与环境边界

- 安全边界相关变更是收紧新实例凭据身份隔离、限制同身份字段复用、清除过期验证状态；没有取消确认、跨范围访问、主机指纹校验、MySQL/Redis 策略或加密存储要求。
- 本机协议服务用于打包产物的真实驱动测试，不代表所有 MySQL/Redis/SSH 服务端版本都已验证。代理/VPN/TLS组合有后端与UI回归，真实企业VPN、生产证书、系统SSH Agent及远程基础设施未连接测试。
- 未在用户当前 Windows 账户中运行 NSIS 安装/覆盖升级/卸载回归，因为它会修改既有安装注册信息和快捷方式。已生成安装程序，包内启动、重启和真实协议链路另行验证；安装回归保留在一次性 Windows Release Runner 中执行。

## 最终验证记录

| 命令 / 入口 | 最终结果 |
| --- | --- |
| `corepack pnpm run check` | 通过：源码与脚本语法、Renderer TypeScript 检查 |
| `corepack pnpm test` | 639 项通过，失败/取消/跳过均为 0；包含 83 项插件生命周期集成测试及 6 项真实连接 hook 竞态回归 |
| Node.js 22.23.2 下 `node --test test/*.test.mjs` | 639 项通过，失败/取消/跳过均为 0；与 CI 使用相同 Node 主版本 |
| `corepack pnpm run test:ui` | 通过：31 次只读调用，0 变更、0 外部请求、0 Renderer 错误、0 可访问性失败 |
| `corepack pnpm run test:ui:business` | 通过：27 次精确变更，包含失败重试、编辑保护与焦点循环 |
| `corepack pnpm exec electron scripts/ui-react-plugin-operations-smoke.cjs` | 通过：111 次作用域请求；保留原有连接、编辑及生命周期断言，并执行 8 轮原生 tooltip/焦点检查 |
| `corepack pnpm exec electron scripts/ui-react-plugin-editor-matrix-smoke.cjs` | 通过：79 次作用域 IPC 请求、36 次真实管理器验证，残留探针与编辑会话为 0 |
| `corepack pnpm exec electron scripts/ui-react-plugin-operations-smoke.cjs --probe-regression-only` | 通过：8 次请求，新增检查及删除后首次新增不再发送编辑专用凭据控制字段 |
| `corepack pnpm run dist` | 通过：生成 Windows x64 NSIS 安装程序；保留版本 1.0.46 |
| `node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"` | 通过：包内源码、Renderer 资源哈希与最终本地源一致，1 个 JS/1 个 CSS 入口，源 Renderer 和已删除兼容路径未混入包 |
| `node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"` | 通过：35 个结构化工具，归档运行时可用 |
| `node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"` | 通过：58 个 preload API、隔离空工作区、128px 导航栏、重启持久化；三类插件真实协议生命周期 80 次调用，明文测试凭据泄漏数为 0 |
| `git diff --check` / `git diff --cached --check` | 通过；生成目录、本地设置和合成测试运行产物不纳入提交 |

包内真实协议测试穿过 preload、IPC、store、Windows 加密凭据存储和网络驱动。SSH 认证 8 次、MySQL 认证 9 次/查询 20 次、Redis 认证 8 次/PING 11 次，各协议都实际拒绝一次错误密码。更换密码后仅新密码被测试服务接受，随后不提供临时凭据的断开重连仍成功。三类插件均完成同名删除重建、最后插件删除后清空连接意图，以及最终空项目删除。

UI 四组按顺序运行，避免原生窗口抢焦点。最终后端修复后重跑全部 639 项测试并重建安装包，再对新包执行全部三项打包验证。后续 CI 兼容修复仅改测试与文档，安装包源码未变，并用 Node 22/24 再跑完整测试。生产包仅有 Vite 大块资源提示，无构建失败。

安装包：`dist/Agent运维工作台 Setup 1.0.46.exe`，115,888,808 字节。

SHA-256：`199FF64041842BBE736FD512078634EC3BA5003D2E308C37B3ED44DD7670C878`。

安装包与运行日志不提交到仓库。代码提交号、推送状态及本机绝对安装路径见最终交付消息和本机 `dist/verification-1.0.46.md`；本报告不把尚未发生的远端 CI 或实际安装结果算作通过。
