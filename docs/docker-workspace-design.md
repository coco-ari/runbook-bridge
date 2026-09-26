# Server 工作区 Docker 功能

Docker 是 Server 工作区的一部分，共用已连接的 SSH，不增加独立插件类型、凭据或后台服务。首版只读，不提供启停、部署、容器终端或自动 sudo。

## 界面与交互

内容区最左侧是固定 36px 的资源栏，服务器和 Docker 图标各自带工具提示、选中状态和键盘焦点。上下方向键及 Home/End 移动焦点，Enter/Space 激活。入口由统一资源配置管理，不展示尚未实现的功能。

资源栏独立于可拖动侧栏；目录或容器侧栏默认 320px、最小 240px。侧栏折叠后资源栏保留，点击图标恢复侧栏。现有收藏、收起、隐藏文件、终端定位、刷新、上传六个按钮完整保留。

切换图标仅改变左侧资源列表。点击容器在右侧打开标签，和宿主机终端并列；标签以完整容器 ID 去重，最多保留 6 个容器与 8 个终端。关闭容器标签不操作远端容器，也不关闭终端。容器被同名新实例替代时需要重新从列表打开。

容器支持 Compose 项目分组、独立容器、名称/镜像/ID 搜索和运行状态筛选。右侧提供概览、日志、资源。日志搜索只过滤已加载文本；复制复制已加载的完整正文。资源仅在当前可见页面每 5 秒采样，隐藏、最小化或断连时暂停。

文件预览沿用上下分栏。容器激活时隐藏文件和终端区域，切回后恢复；双击文件恢复最近的终端区域并显示预览，没有会话时不自动创建终端。传输保持运行，Docker 资源面板激活时隐藏新上传入口。

## 连接配置与边界

Server 连接编辑页可设置 `target.dockerSocket`，留空使用 `/var/run/docker.sock`；支持 rootless Docker 的绝对 Socket 路径。路径必须是服务器上的绝对路径，禁止控制字符、空白和网络 URL。旧配置无需迁移。

Socket 属于连接目标配置，保存时沿用现有连接编辑事务和断开提示；变更使原上下文、读取请求和快照失效。不会根据 Docker CLI 当前 context 自动切换到另一台服务器。

读取使用固定 Docker CLI 命令、显式 Unix Socket、无 PTY 的独立 SSH 通道，并清除 Docker context/host/TLS 环境覆盖。命令仍经过现有命令策略；取消和超时只关闭读取通道，不关闭共享 SSH。Docker CLI、服务、权限或日志驱动故障不改变 SSH 连接状态。

## MCP 与桌面接口

新增工具均需要 `projectId`、`environmentId`、`pluginInstanceId`、`contextToken`。Broker 绑定 Agent 会话，执行前检查环境上下文和 Server 已连接状态。

| MCP 工具 | 附加参数 | 返回 |
|---|---|---|
| `server_docker_list_containers` | 可选 `limit`、`cursor` | 容器、Compose 项目/服务、采集时间、后续游标与截断状态 |
| `server_docker_inspect_container` | `containerId` | 状态、镜像、健康状态、端口、挂载、重启和时间信息 |
| `server_docker_read_logs` | `containerId`；可选 `lines`、`maxBytes`、`since`、`until` | 正文、采集时间、使用的限额与截断状态 |
| `server_docker_container_stats` | `containerId` | 一次 CPU、内存、网络、磁盘、进程采样及可用状态 |

容器 ID 必须是 64 位小写十六进制完整 ID。时间参数必须包含时区，服务统一转换为 UTC。列表每页默认 50、最多 200 条；一次快照最多 1000 条及 1 MiB 输出，游标绑定调用者、作用域、连接代次和目标，有效期 60 秒。桌面在同一有界快照内加载列表再做本地筛选。

日志默认 200 行、64 KiB，最多 2000 行、256 KiB，不持续跟随。截断时明确提示，不能把当前结果当作完整证据。概览和统计输出上限 1 MiB；超限拒绝解析不完整详情。读取超时不超过 Server 的配置上限或 10 秒，受现有全局/每 Server 调度限制。

桌面新增 `serverDockerRead` 与 `serverDockerCancel`，只接受当前登记窗口的主框架。取消绑定窗口、作用域和请求 ID。桌面与 MCP 共用读取管理器，读取结束前重新核对连接代次与目标指纹。错误不携带原始远端错误正文。审计记录作用域、操作和结果，不保存日志或详情正文；正文仅驻留内存。

既有 `server_container_inspect` 的 Docker/Podman 契约保留。当前共 40 个 MCP 工具、110 个桌面 preload API。数量分别由 `src/mcp-tool-contract.mjs` 与 `renderer/v2/src/bridge/ai-ops-v2.ts` 的接口清单核对，包内验证会检查真实导出。

## 验证

```powershell
node --test test/server-docker.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run test:ui:server-workspace
corepack pnpm run test:ui:docker
corepack pnpm run dist
node scripts/verify-package.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-mcp-smoke.mjs "dist/win-unpacked/Agent运维工作台.exe"
node scripts/packaged-ui-smoke.cjs "dist/win-unpacked/Agent运维工作台.exe"
```

测试使用模拟容器和临时数据根，不连接真实基础设施。Docker UI 专项覆盖资源切换不改变右侧内容、终端保留、标签去重/上限、手动刷新、本地日志搜索、隐藏暂停采样、主题、窄栏、折叠恢复、容器删除和关闭后迟到响应。
