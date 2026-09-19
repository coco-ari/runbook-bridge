# 云配置仓库

云配置用于个人多设备迁移。桌面左侧的“云配置”入口支持创建、绑定仓库，按项目上传或下载，预览冲突、选择历史版本以及恢复本机备份。下载后点击原有“连接环境”或插件连接按钮；导入不会自动连接服务器。

## 部署

服务独立于桌面应用，使用 Node.js 24 的 `node:sqlite` 与标准加密、HTTP API，不需要额外生产依赖。当前 Node.js 24 的 SQLite API 可能输出实验性提示。Docker Compose 同时启动云服务和负责 HTTPS 的 Caddy；仅 HTTPS 代理对外暴露端口。

准备一个指向部署机器的域名，开放 80、443 端口，并安装 Docker Compose。将至少 32 个字符的随机管理员令牌保存到代码仓库外的文件，例如用以下命令创建（文件路径按实际环境调整）：

```sh
umask 077
node -e "require('node:fs').writeFileSync('/srv/runbook-cloud-admin-token',require('node:crypto').randomBytes(32).toString('base64url'),{mode:0o600})"
chown 1000:1000 /srv/runbook-cloud-admin-token
export CLOUD_DOMAIN=config.example.com
export CLOUD_ADMIN_TOKEN_FILE=/srv/runbook-cloud-admin-token
docker compose -f services/cloud-config/compose.yaml up -d --build
```

容器以 UID 1000 的 `node` 用户运行。Linux 下文件型 Compose secret 保留源文件权限，上述 `chown` 让容器可以读取权限为 `0600` 的令牌；如启用用户命名空间，请按实际 UID 映射调整。构建上下文仅允许云服务代码和两个共享模块，排除本地数据与凭据。

管理员令牌只用于创建仓库。桌面点击“创建新仓库”，填写 HTTPS 服务根地址和该令牌，保存默认生成的随机仓库密码，也可改为至少 16 个字符的自定义密码。创建后复制仓库链接；其他电脑只需链接和仓库密码，不需要管理员令牌。

持久化数据位于 `cloud-data` 卷中的 `cloud.sqlite`，Caddy 证书位于 `caddy-data` 卷。备份数据库时先停止云服务，完整备份数据卷，再启动服务；不要只复制运行中的 SQLite 主文件而遗漏 WAL。恢复时使用同一份完整数据卷。服务健康检查为内部 `GET /healthz`；日志不记录密码、访问头或配置正文。

第一版没有管理网站、公开注册、团队成员或权限分级。一个客户端绑定一个仓库，知道密码的人拥有该仓库读写权限。密码更换使用新密码创建新仓库并重新上传；旧仓库停止使用或由部署管理员停止对应服务。忘记密码无法在服务端找回，可从仍保存本地配置的电脑创建新仓库。

## 同步内容和操作

每个项目包含环境、服务器/MySQL/Redis 插件、操作规则、Redis Key 范围、环境 Runbook、环境快捷提问，以及已保存的密码、代理密码、SSH 私钥和口令、TLS CA/客户端证书/私钥。不会上传整个应用目录；审计日志、编辑草稿、连接状态、审批、Broker 令牌、全局快捷提问开场白和界面布局均不参与同步。

上传只更新选择的项目，保留云端其他项目。下载支持选择最新或历史快照；先查看项目新增、修改、删除和凭据变更摘要，再逐项目选择保留本地或采用云端。采用云端会完整替换该项目的配置和凭据，包括预览中列出的删除项；本地审计记录保留。同名或同 ID但没有同步关联的本地项目不会被自动覆盖。

两个设备都修改同一项目时，由用户选择保留哪一份，不自动合并字段。上传使用条件版本提交；云端在预览后被更新会返回冲突，必须重新预览。预览有效期 5 分钟，绑定具体快照、本地配置和凭据版本，只能使用一次。选择保留的项目不会错误标记为已同步。

下载前检查活动编辑和文件传输；存在活动任务时先完成或取消。覆盖会断开该项目的连接并使旧 Agent 上下文、审批失效。导入以项目为原子单位，多个项目逐项显示完成或失败。每次覆盖前将本机配置和凭据保存为系统加密备份；“本地加密备份”可预览恢复。未完成事务在下次启动时恢复；无法解密或恢复的项目保持隔离，不允许继续连接。

历史版本回滚通过下载历史版本实现；如果需要同步到所有设备，再把恢复后的本地项目上传为新版本。云端默认保留最近 20 个版本，单个密文快照最大 20 MiB。本机备份与当前操作系统安全存储绑定，不适合作为跨设备迁移文件。

## 加密与连接边界

客户端以随机 32 字节盐和固定 `scrypt N=131072,r=8,p=1` 派生根密钥，通过绑定仓库 ID的 `HKDF-SHA-256` 分离访问凭证和数据加密密钥。服务端持久化访问凭证的 SHA-256 摘要。原始仓库密码及加密密钥不发送到服务器。

快照整体使用 `AES-256-GCM`、随机 12 字节 nonce、16 字节认证标签；格式版本、仓库 ID、快照 ID和父版本均参与认证。项目名、连接地址、运维说明也在密文中。服务端仍能看见仓库标识、版本时间、密文大小和网络来源。强随机密码用于抵御密文泄露后的离线猜测；“限流”不能代替强密码。

下载解密在 Electron 主进程完成，凭据重新加密存入目标机器的凭据库。SSH 文件私钥上传时只读取已明确配置的普通文件（不超过 1 MiB）；导入设置 `auth.privateKeySource: vault`，私钥内容在凭据库中，由连接运行时直接使用。原有 `privateKeyPath` 配置继续兼容，省略来源字段等同于 `file`；编辑器允许切回本机文件。

系统 VPN、SSH Agent 和硬件密钥仍依赖目标机器，预览会提示。未保存密码、配置不完整也会提示；仓库同步不保证网络可达。原有 SSH 主机指纹校验不变，首次信任仍需确认，指纹改变仍被拒绝。MySQL 固定数据库、Redis 范围及操作审批继续生效。

云配置不增加 MCP 工具，不向 Agent 返回凭据。新增桌面 IPC `v2:cloud-config` 仅允许受信任 Renderer 主框架调用；动作包括 `status/bind/create/unbind/catalog/prepare/confirm/prepareRestore`，上传下载预览不包含凭据值。Renderer 的 `connect-src 'none'` 保持不变，HTTPS 请求由主进程发起并拒绝重定向。

## 云 API 与验证

服务 API 前缀为 `/api/v1/repos`：管理员认证 `POST /` 创建仓库；公开 `GET /:id/meta` 提供格式、盐和派生参数；仓库认证后可调用 `GET /:id/head`、`GET /:id/versions`、`GET /:id/snapshots/:snapshotId` 和 `POST /:id/snapshots`。上传要求 `If-Match` 为当前快照 ID，空仓库为 `empty`。访问凭证放在 `Authorization: Bearer` 头中。

稳定失败类别包括认证失败、版本冲突、格式不支持、完整性失败、数据超限、限流、本机版本变化及事务恢复待处理。错误响应不复制远端内容或底层数据库异常。

```powershell
node --test test/cloud-config.test.mjs test/cloud-config-boundaries.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run test:ui:cloud
```

测试只使用临时数据目录、合成凭据、回环 HTTP/SSH 服务。生产客户端仅接受 HTTPS，回环 HTTP 例外只能由测试代码显式注入，桌面设置不提供绕过选项。
