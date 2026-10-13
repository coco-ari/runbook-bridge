# 3.0 源码与 Codex Agent 工作区

这两个环境插件各有独立工作区：源码工作区负责下载和阅读，Codex Agent 工作区负责对话。代码由独立的 CodeMinificationRepository 服务交付；现有云配置只保存连接配置与允许同步的凭据。

## 源码服务与源码插件

1. 在 CodeMinificationRepository 管理端为项目启用「AI 运维源码快照与增量下载」，按需选择自动同步周期，然后立即同步一次。原 Jenkins / ZIP 下载接口保持不变。
2. 在运维工具的目标环境添加「源码」插件，填写管理端提供的**源码服务地址、项目 ID、项目下载密码**。地址是服务根地址，不是 `/source/latest` 或 manifest 的接口地址。公网用 HTTPS；允许受支持的内网 HTTP。
3. 验证、保存并连接后，打开源码工作区，选择下载远端已发布版本。用户端无需安装 Git。
4. 首次下载固定快照 ZIP；后续按文件 SHA-256 复用本地对象，只下载目标版本缺少的内容。改名和删除通过目标清单重建，不需要逐个安装中间版本。失败、取消或断线保留当前版本。

工作区支持目录树、多文件标签、行号、高亮、文件名/全文搜索、打开本地目录、检查版本和清理旧版本。已下载源码可离线查看。SSE 通知和一分钟轮询只更新远端版本提示，不自动替换代码。

每个项目/环境/插件/来源配置拥有隔离的本地缓存。单快照最多 20,000 文件、256 MiB，单文件 16 MiB；编辑器预览上限 2 MiB，全文搜索最多扫描 32 MiB、返回 200 条结果，并显示截断提示。源码不包含 Git 历史，符号链接和不能跨平台安全表示的路径会拒绝同步。

清理保留当前版本、打开的源码工作区和 Codex 会话引用的版本。已下载的代码不会因云端重置下载密码被远程删除；重置会阻止继续访问服务。

## Codex Agent 插件

本机需要 **Codex CLI 0.159.0 或更新版本**。插件自动查找可执行文件，也可填写绝对路径；Windows 使用原生 `codex.exe`。不复用或改写用户已有的 CLI 配置和登录目录。

认证方式：

- **ChatGPT 登录**：保存插件、连接 CLI，在工作区点击「登录 ChatGPT」，在官方浏览器页面完成登录。可取消登录或退出账号。
- **兼容 Responses 服务**：配置服务基础地址、模型 ID 和 API Key。只支持 Codex 的 Responses 协议；不承诺其他第三方协议兼容。API Key 保存在凭据库，工作区不会返回保存的密钥。连接验证检查 CLI 与配置，模型服务是否可调用以实际提问结果为准。

打开 Agent 工作区，点击「新建对话」，选择同环境已下载的源码插件和模型。可不绑定源码，只使用环境运维工具。模型列表是 CLI 提供的候选列表，可直接填写 ID；服务支持和账号配额以实际请求为准。

对话固定创建时的源码快照。更新源码后，已有对话继续读取原目录；要分析新代码请创建新对话。源码插件换地址、换项目或被删除后，旧会话不能继续使用旧绑定发起新问题。

工作区显示 Markdown 回复、流式输出、工具活动和补充信息问题，支持停止及继续提问、会话列表、删除记录、进程重连后恢复。输入草稿与阅读位置在切换工作区时保留，草稿不跨应用重启；会话记录在本机持久化。每个插件配置最多 200 会话，单会话 4 MiB；达到限制后新建会话或清理旧记录。删除工作台会话会释放源码引用；Codex CLI 自身的本机历史仍由 CLI 管理。

## MCP 与权限

`open_environment` 的 `sourceCode` 数组只返回同环境的本地目录、快照 ID、提交 ID、文件数量和可用状态。没有新增源码内容读取、源码搜索、下载更新或 Agent 对话 MCP 工具。Agent 使用自己的本地文件工具读取代码。

内置 Agent 使用可撤销的 Broker 凭据，服务端强制限定项目与环境，不能借参数访问其他环境或修改插件配置。断开、进程退出及连接配置变化使授权失效。原外接 MCP 的连接方式保持兼容。

每个对话使用中性的独立工作目录；通过 Codex 命名权限 profile，只允许写入该工作目录、只读访问选定源码及必要的系统工具，禁止本地命令联网及读取应用凭据。CLI 必须返回正确的活动 profile，否则拒绝开始会话。此版本不开放扩大本地沙箱权限的批准入口：提权、扩大文件访问范围和未知请求默认拒绝。用户补充信息问题可在工作区回答。

运维读取和变更继续走现有 MCP、上下文与 OperationGate。变更仍需逐次审批，工作区页头和输入框旁可打开消息中心，查看范围及操作参数。不会把人工终端权限交给 Agent。

此实现使用官方 app-server stdio 协议及实验性的命名权限 profile；已在 macOS CLI 0.159.2 验证真实握手、源码读权限、写入拒绝、应用凭据/其他环境读取拒绝和命令环境密钥隔离。Windows/Linux 的原生沙箱行为还需在对应平台验收，不能把 macOS 验证视为跨平台验证。

## 数据与备份

应用数据目录新增：

- `source-cache/`：校验后的文件对象、不可变源码目录、当前版本指针与会话引用。
- `codex-agent/`：按插件配置身份隔离的 Codex 状态、工作目录和本机对话。

源码服务密码与自定义服务 API Key 使用既有凭据库。ChatGPT OAuth 由隔离目录中的 Codex 管理，不进入工作区转录、MCP、应用日志或云配置。源码、对话、OAuth 和缓存不随云配置同步。换设备后重新下载源码、安装 CLI 并登录；旧配置身份下的本机历史不会自动转移到新模型服务。

## 验证

```sh
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run test:ui:source
corepack pnpm run test:ui:codex
node scripts/test-source-service.mjs /path/to/CodeMinificationRepository
corepack pnpm run test:codex:protocol
```

前两种专项 UI 使用临时数据和模拟子进程；真实 CLI 协议验证也使用临时 HOME，不读取已有账号或调用付费模型。服务端契约与首次/增量传输的集成测试通过真实本地 Git 与 HTTP 交互。

macOS 的包内界面 smoke 使用 Chromium 的测试钥匙串与独立临时数据，避免临时签名包阻塞于用户钥匙串授权。这项测试不覆盖正式签名应用的系统钥匙串权限；产品启动仍使用系统安全存储。测试开关依据 [Chromium 的测试钥匙串定义](https://chromium.googlesource.com/chromium/src/+/refs/tags/129.0.6668.107/components/os_crypt/sync/os_crypt_switches.cc)。

协议参考：[官方 app-server](https://learn.chatgpt.com/docs/app-server)、[Codex 权限 profile](https://learn.chatgpt.com/docs/permissions)。
