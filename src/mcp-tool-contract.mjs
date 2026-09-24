import { logLimitSchema } from './log-search-limits.mjs';
import { OFFSET_CURSOR_INPUT_SCHEMA, REDIS_CURSOR_INPUT_SCHEMA } from './pagination-cursor.mjs';

export const instructions = `这是一个插件化 Agent 运维入口。项目下的环境彼此隔离；每次开始工作必须先调用 open_environment，读取精准的环境运维说明、插件目录、resourceHints 和 contextToken。桌面应用不会因为 Agent 调用而连接环境；插件未连接时，请用户在桌面应用点击“连接环境”。环境部分连接时，仅调用明确显示 connected 的插件。优先使用 resourceHints 中已解析的 Server 资源；resourceHintsTruncated 为 true 时按目标插件调用 server_list_sources 补充。日志直接调用 server_search_logs，未知文件位置优先调用 server_find_files，仅在需要浏览目录时调用 server_list_directory。Server 的普通文件和目录读取不受数据源目录限制，也不因内容敏感而拦截；读取前应结合服务器负载合理收窄路径、深度、文件数和扫描字节，禁止读取设备、FIFO、Socket 等特殊文件。日志排查优先调用 server_search_logs，让工具在一次请求中完成目录发现、多条件匹配和 .zip/.gz 归档内搜索；不要为这些只读工作改用 Shell、下载或本地解压。动态日志允许有界增长；必须检查 coverage、truncated、skipped 和 guidance，不能把部分扫描无匹配当作完整日志没有证据。需要最新片段时使用 server_read_file 的 tail:true；ZIP/GZIP 的 maxScanBytes 是压缩输入预算，maxExpandedBytes 是解压后预算。SFTP 超时而目录/stat 正常时先缩小到单个文件、合并 queries，不要反复让用户重连。上传、写入、移动、删除、服务控制和任意 Shell 都必须由用户在桌面端逐次确认，确认后参数或目标状态变化会要求重新确认。MySQL 插件固定一个数据库且只允许结构、SELECT、EXPLAIN；不清楚表或字段时优先调用 mysql_search_schema，不要先分页枚举全库。日志输入默认 4 MiB、单页远程会话预算 20 秒，首次搜索优先省略预算参数并合并 queries；日志正文默认按 32 KiB 分页，先读取状态和 nextCursor；server_search_logs 返回 nextCursor 时保持其余参数完全一致续查；conclusion:inconclusive 表示证据不完整，remainingDirectories 给出尚未遍历的目录。超时部分页保留已完成匹配和 nextCursor，不能当作完整无匹配；同一文件续查再次超时再缩小范围。INVALID_ARGUMENT 时读取 details.field/minimum/maximum/suggestedValue，不能盲猜预算或带旧 cursor 改参数。MySQL 错误 queryStarted:false 且 operation:table_check 表示业务 SQL 尚未执行，先检查元数据访问或连接恢复；timings 区分表检查、业务排队、业务执行和总耗时。需要重新发现新增文件或避开短期缓存时，以 refresh:true 发起新搜索。READ_BUSY/LOG_SEARCH_BUSY 是本地排队已满，按 retryAfterMs 等待后重试，不表示远端断线。mysql_search_schema 默认先搜表；需要字段时指定 searchIn:columns，已知表时同时传 table；mysql_describe_table 的 includeIndexes:true 用于配合 mysql_explain 优化查询，refresh:true 更新元数据。变更返回 CONFIRMATION_REQUIRED 后用 get_confirmation_status 和 waitMs:10000 等待；只有 approved 时原参数重试一次，running/succeeded 不得重复执行。open_environment 的 runtime 与 mcpRuntime 可用于核对实际运行的构建，发现版本不一致时应更新对应进程。Redis 只允许已登记 patternId 下的 SCAN、读取和 TTL。`;

const scope = {
  projectId: { type: 'string', minLength: 2, maxLength: 63 },
  environmentId: { type: 'string', minLength: 2, maxLength: 63 },
  pluginInstanceId: { type: 'string', minLength: 2, maxLength: 63 },
  contextToken: { type: 'string', minLength: 16, maxLength: 256 },
  requestId: { type: 'string', minLength: 1, maxLength: 128 },
  approvalToken: { type: 'string', minLength: 16, maxLength: 256 },
};

function tool(name, description, required, properties = {}, constraints = {}) {
  const mutations = new Set(['add_plugin','server_upload_file','server_write_file','server_move_path','server_delete_path','server_control_service','server_execute_shell']);
  return { name, description, annotations:{ readOnlyHint:!mutations.has(name), destructiveHint:mutations.has(name), openWorldHint:true }, inputSchema: { type: 'object', additionalProperties: false, required, properties, ...constraints } };
}

function scoped(name, description, extraRequired = [], extra = {}, constraints = {}) {
  return tool(name, description, ['projectId', 'environmentId', 'pluginInstanceId', 'contextToken', ...extraRequired], { ...scope, ...extra }, constraints);
}

export const tools = [
  scoped('get_confirmation_status', '只读查询当前会话的确认状态；可用 waitMs 等待变化，最长 10 秒。仅 approved 时原样重试变更一次；running/succeeded 时不要重发。', ['confirmationId'], { confirmationId:{ type:'string', minLength:36, maxLength:36 }, waitMs:{ type:'integer', minimum:0, maximum:10000, default:0 } }),
  tool('list_projects', '列出本机项目摘要，不连接任何环境。', [], {}),
  tool('list_environments', '列出项目的用户自定义环境，不连接插件。', ['projectId'], { projectId: scope.projectId }),
  tool('open_environment', '读取一个环境的运维说明、插件目录、可直接导航的 resourceHints、连接状态并取得短期上下文令牌。', ['projectId', 'environmentId'], { projectId: scope.projectId, environmentId: scope.environmentId }),
  tool('add_plugin', '在已打开环境中添加一个配置完整且保持断开的 Server、MySQL 或 Redis 插件。只接收结构化非敏感配置。', ['projectId','environmentId','contextToken','pluginType','displayName','configuration'], {
    projectId:scope.projectId, environmentId:scope.environmentId, contextToken:scope.contextToken,
    pluginType:{ type:'string', enum:['server','mysql','redis'] }, displayName:{ type:'string', minLength:1, maxLength:120 },
    configuration:{ type:'object', additionalProperties:false, properties:{
      host:{ type:'string', maxLength:255 }, port:{ type:'integer', minimum:1, maximum:65535 }, username:{ type:'string', maxLength:128 },
      database:{ type:'string', maxLength:128 }, logicalDb:{ type:'integer', minimum:0, maximum:15 },
      addressFamily:{ type:'string', enum:['ipv4Preferred','ipv4Only','ipv6Preferred','ipv6Only'] },
      connectionMode:{ type:'string', enum:['direct','serverTunnel','windowsVpn'] }, serverPluginInstanceId:scope.pluginInstanceId,
      vpnInterfaceAlias:{ type:'string', maxLength:128 }, tlsMode:{ type:'string', enum:['disabled','preferred','required','verifyIdentity'] },
      authType:{ type:'string', enum:['password','privateKey','agent'] }, privateKeyPath:{ type:'string', maxLength:4096 },
      uplinkType:{ type:'string', enum:['direct','socks5','http','windowsVpn'] }, proxyHost:{ type:'string', maxLength:255 },
      proxyPort:{ type:'integer', minimum:1, maximum:65535 }, proxyUsername:{ type:'string', maxLength:128 },
    } },
  }),
  scoped('server_list_actions', '列出 Server 插件内置且已登记的结构化安全动作。不会联网。'),
  scoped('server_run_action', '运行一个固定 actionId；不能传 Shell 命令。', ['actionId'], { actionId: { type: 'string', enum: ['system.summary', 'process.summary', 'network.listen', 'filesystem.usage', 'service.status'] }, parameters: { type: 'object', additionalProperties: { type: 'string' } } }),
  scoped('server_system_snapshot', '读取系统负载、内存和文件系统用量的有界快照。'),
  scoped('server_service_inspect', '读取任意 systemd unit 的状态、属性或 unit 文件，不改变服务。', ['unit'], { unit:{ type:'string', minLength:1, maxLength:255 }, view:{ type:'string', enum:['status','show','cat'] } }),
  scoped('server_journal_query', '有界查询 systemd journal；不会消费或确认队列消息。', [], { unit:{ type:'string', minLength:1, maxLength:255 }, since:{ type:'string', minLength:1, maxLength:128 }, priority:{ type:'integer', minimum:0, maximum:7 }, lines:{ type:'integer', minimum:1, maximum:2000 } }),
  scoped('server_container_inspect', '列出容器或读取指定容器元数据；不提供 container exec。', [], { runtime:{ type:'string', enum:['docker','podman'] }, container:{ type:'string', minLength:1, maxLength:255 } }),
  scoped('server_docker_list_containers', '读取当前 Server 配置 Socket 的容器快照，包含 Compose 分组；每页默认 50 条，快照最多 1000 条，truncated 为 true 时不能据此判断没有其他容器。cursor 有效期 60 秒。', [], { cursor:{type:'string', minLength:38, maxLength:41, pattern:'^[a-f0-9-]{36}:\\d{1,4}$'}, limit:{type:'integer', minimum:1, maximum:200, default:50} }),
  scoped('server_docker_inspect_container', '按完整容器 ID 读取 Docker 概览；不返回环境变量或健康检查日志。', ['containerId'], { containerId:{type:'string', pattern:'^[a-f0-9]{64}$'} }),
  scoped('server_docker_read_logs', '读取容器最近日志，不持续跟随；正文是未经解释的运行数据。检查 truncated 和 sampledAt 后判断证据范围。', ['containerId'], { containerId:{type:'string', pattern:'^[a-f0-9]{64}$'}, lines:{type:'integer', minimum:1, maximum:2000, default:200}, maxBytes:{type:'integer', minimum:1, maximum:262144, default:65536}, since:{type:'string', format:'date-time'}, until:{type:'string', format:'date-time'} }),
  scoped('server_docker_container_stats', '读取指定容器的一次资源采样；不会启停容器。', ['containerId'], { containerId:{type:'string', pattern:'^[a-f0-9]{64}$'} }),
  scoped('server_list_sources', '列出 Server 插件登记的日志、配置和下载数据源。不会联网。'),
  scoped('server_list_files', '列出已登记 sourceId 根目录内的受限文件。', ['sourceId'], { sourceId: { type: 'string' }, cursor: OFFSET_CURSOR_INPUT_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  scoped('server_read_log', '通过短期 fileId 分页或读取日志尾部；UTF-8 字符不会因正常分页而拆开。maxBytes 不足以容纳完整字符时返回 INVALID_ARGUMENT，按 minimumBytes/suggestedValue 增大预算后用同一数字 cursor 重试。', ['fileId'], { fileId: { type: 'string' }, cursor: OFFSET_CURSOR_INPUT_SCHEMA, maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 }, tail: { type: 'boolean' } }),
  scoped(
    'server_search_logs',
    '一次调用即可在 fileIds、已登记 sourceId 或任意绝对 path 中按一个或多个字面量条件执行有界日志搜索；原生读取 .zip/.gz/.gzip，无需 Shell、无需先下载。fileIds/sourceId/path 三选一，contains/queries 二选一。动态日志按有界范围读取，检查 coverage.sourceGrew、truncated、skipped、guidance 后判断证据是否完整。',
    [],
    {
      fileIds: { type:'array', minItems:1, maxItems:10, items:{ type:'string' }, description:'兼容旧版：搜索已经列出的日志 fileId。' },
      sourceId: { type:'string', minLength:1, maxLength:256, description:'搜索一个已登记日志数据源。' },
      path: { type:'string', minLength:1, maxLength:4096, description:'搜索任意绝对日志文件或目录。' },
      contains: { type:'string', minLength:1, maxLength:1024, description:'兼容旧版：单个字面量查询，UTF-8 最多 1024 字节。' },
      queries: { type:'array', minItems:1, maxItems:10, items:{ type:'string', minLength:1, maxLength:1024 }, description:'一次搜索的多个字面量查询；每项 UTF-8 最多 1024 字节，合计最多 4096 字节。' },
      matchMode: { type:'string', enum:['any','all'], default:'any', description:'any 匹配任一查询；all 要求同一行匹配全部查询。' },
      caseSensitive: { type:'boolean', default:true },
      pattern: { type:'string', minLength:1, maxLength:256, description:'仅匹配单个文件名的 glob。' },
      maxDepth: logLimitSchema('maxDepth'),
      maxFiles: logLimitSchema('maxFiles'),
      maxMatches: logLimitSchema('maxMatches'),
      cursor: { type:'string', pattern:'^[a-f0-9]{64}$', minLength:64, maxLength:64, description:'继续上次搜索；其余参数保持不变，直接传回 nextCursor。' },
      refresh: { type:'boolean', description:'新搜索时重新读取目录和文件；续查仍使用已验证的快照。' },
      beforeLines: { ...logLimitSchema('beforeLines'), default:2 },
      afterLines: { ...logLimitSchema('afterLines'), default:2 },
      includeArchives: { type:'boolean', default:true, description:'是否原生读取匹配的 ZIP/Gzip 日志归档。' },
      maxScanBytes: logLimitSchema('maxScanBytes', '远端输入预算；普通日志默认扫描尾部，归档需容纳完整压缩文件。默认 4 MiB，最大 64 MiB。首次搜索建议省略此项；明确需要扩大覆盖范围时再调整。'),
      maxExpandedBytes: logLimitSchema('maxExpandedBytes', '解压后总预算，也约束单个归档条目；默认 min(4×maxScanBytes, 128 MiB)，最大 128 MiB。超限请按 skipped/guidance 调整。'),
      maxResultBytes: logLimitSchema('maxResultBytes', '匹配与上下文的 UTF-8 JSON 正文预算，默认 32 KiB，范围 16 KiB 至 2 MiB；元数据另计。按 nextCursor 续查。单条匹配过大时保留该条并标记截断。'),
      maxArchiveEntries: logLimitSchema('maxArchiveEntries', '单次请求内所有归档合计最多处理的条目数。'),
    },
    {
      allOf: [
        { oneOf: [{ required:['fileIds'] }, { required:['sourceId'] }, { required:['path'] }] },
        { oneOf: [{ required:['contains'] }, { required:['queries'] }] },
      ],
    },
  ),
  scoped('server_read_config', '读取已登记的配置 fileId，原样返回内容，不隐藏敏感字段。按完整 UTF-8 字符分页；maxBytes 不足时返回 INVALID_ARGUMENT 和 minimumBytes/suggestedValue，可保留数字 cursor 增大预算重试。', ['fileId'], { fileId: { type: 'string' }, cursor: OFFSET_CURSOR_INPUT_SCHEMA, maxBytes: { type: 'integer', minimum: 1, maximum: 262144 } }),
  scoped('server_stat', '查看任意服务器绝对路径的类型、大小、权限和修改时间。', ['path'], { path:{ type:'string', minLength:1, maxLength:4096 } }),
  scoped('server_list_directory', '分页列出任意服务器目录；不读取目录中的文件内容。', ['path'], { path:{ type:'string', minLength:1, maxLength:4096 }, cursor:OFFSET_CURSOR_INPUT_SCHEMA, limit:{ type:'integer', minimum:1, maximum:500 } }),
  scoped('server_find_files', '在任意服务器目录下按文件名 glob 有界查找普通文件；不跟随符号链接目录。', ['path'], { path:{ type:'string', minLength:1, maxLength:4096 }, pattern:{ type:'string', minLength:1, maxLength:256 }, maxDepth:{ type:'integer', minimum:0, maximum:12 }, maxResults:{ type:'integer', minimum:1, maximum:1000 }, refresh:{ type:'boolean', description:'重新读取目录，忽略 15 秒缓存。' } }),
  scoped('server_read_file', '分页或 tail:true 读取任意服务器普通文件，包括包含敏感信息的配置；动态文件返回 sourceGrew、observedSize 和实际字节范围。按完整 UTF-8 字符分页，maxBytes 不足时返回 INVALID_ARGUMENT 和 minimumBytes/suggestedValue，可保留数字 cursor 增大预算重试。特殊文件不会被读取；压缩日志请用 server_search_logs。', ['path'], { path:{ type:'string', minLength:1, maxLength:4096 }, cursor:OFFSET_CURSOR_INPUT_SCHEMA, maxBytes:{ type:'integer', minimum:1, maximum:1048576 }, tail:{ type:'boolean', default:false, description:'从当前文件尾部读取 maxBytes 字节；true 时不能提供 cursor。' } }, { not:{ properties:{tail:{const:true}}, required:['tail','cursor'] } }),
  scoped('server_search_files', '在任意服务器目录下对普通文件做有界字面量搜索；应根据服务器负载合理收窄范围。', ['path','contains'], { path:{ type:'string', minLength:1, maxLength:4096 }, pattern:{ type:'string', minLength:1, maxLength:256 }, contains:{ type:'string', minLength:1, maxLength:4096 }, maxDepth:{ type:'integer', minimum:0, maximum:12 }, maxFiles:{ type:'integer', minimum:1, maximum:500 }, maxMatches:{ type:'integer', minimum:1, maximum:500 }, maxScanBytes:{ type:'integer', minimum:65536, maximum:33554432 } }),
  scoped('server_download_file', '把任意服务器普通文件下载到项目本地 downloads 目录；兼容旧版 fileId。path 与 fileId 二选一。', [], { path:{ type:'string', minLength:1, maxLength:4096 }, fileId:{ type:'string' } }),
  scoped('server_upload_file', '上传一个本地普通文件到服务器。此变更必须在桌面端逐次确认。', ['localPath','remotePath'], { localPath:{ type:'string', minLength:1, maxLength:4096 }, remotePath:{ type:'string', minLength:1, maxLength:4096 }, overwrite:{ type:'boolean' } }),
  scoped('server_write_file', '创建或完整覆写一个服务器文本文件（最大 1 MiB）。此变更必须逐次确认。', ['path','content'], { path:{ type:'string', minLength:1, maxLength:4096 }, content:{ type:'string', maxLength:1048576 }, overwrite:{ type:'boolean' } }),
  scoped('server_move_path', '移动或重命名服务器文件或目录。此变更必须逐次确认。', ['sourcePath','destinationPath'], { sourcePath:{ type:'string', minLength:1, maxLength:4096 }, destinationPath:{ type:'string', minLength:1, maxLength:4096 }, overwrite:{ type:'boolean' } }),
  scoped('server_delete_path', '删除服务器普通文件、符号链接或空目录；不递归删除。此变更必须逐次确认。', ['path'], { path:{ type:'string', minLength:1, maxLength:4096 } }),
  scoped('server_control_service', '启动、停止、重启或 reload 一个 systemd 服务。此操作必须逐次确认。非零或未取得退出码时返回 SERVICE_CONTROL_FAILED；先检查服务状态和日志，再决定是否重新确认。', ['action','unit'], { action:{ type:'string', enum:['start','stop','restart','reload'] }, unit:{ type:'string', minLength:1, maxLength:255 } }),
  scoped('server_execute_shell', '执行任意 Shell 命令。风险最高，桌面端会显示完整命令并要求强确认。', ['command'], { command:{ type:'string', minLength:1, maxLength:16384 }, workingDirectory:{ type:'string', minLength:1, maxLength:4096 } }),
  scoped('mysql_list_tables', '分页列出此单库 MySQL 插件中的表；元数据短期缓存，可用 refresh 刷新。', [], { cursor: OFFSET_CURSOR_INPUT_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 200 }, refresh:{ type:'boolean' } }),
  scoped('mysql_search_schema', '按任一不区分大小写的字面量关键词搜索此单库 MySQL 插件中的基础表、字段和注释；不会枚举其他数据库。', ['keywords'], {
    keywords: { type:'array', minItems:1, maxItems:10, items:{ type:'string', minLength:1, maxLength:64 } },
    limit: { type:'integer', minimum:1, maximum:100, default:50 },
    table: { type:'string', minLength:1, maxLength:128, description:'可选的准确表名，将字段搜索限制在此表。' },
    searchIn: { type:'string', enum:['auto','tables','columns','all'], default:'auto', description:'auto 先搜索表名和注释，无命中再搜索字段；all 显式搜索两者。' },
    refresh: { type:'boolean', description:'忽略短期元数据缓存。' },
  }),
  scoped('mysql_describe_table', '查看基础表字段；优化查询时传 includeIndexes:true 读取索引。元数据短期缓存，支持 refresh。', ['table'], { table: { type: 'string', minLength: 1, maxLength: 128 }, includeIndexes:{ type:'boolean' }, refresh:{ type:'boolean' } }),
  scoped('mysql_query_readonly', '执行单条只读 SELECT。固定数据库，禁止 USE、跨库、写入和多语句。', ['sql'], { sql: { type: 'string', minLength: 1, maxLength: 65536 }, params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } } }),
  scoped('mysql_explain', '执行 EXPLAIN SELECT；禁止 EXPLAIN ANALYZE。', ['sql'], { sql: { type: 'string', minLength: 1, maxLength: 65536 }, params: { type: 'array', maxItems: 100 } }),
  scoped('redis_scan', '按已登记 patternId 有界扫描 Redis key。', ['patternId'], { patternId: { type: 'string' }, cursor: REDIS_CURSOR_INPUT_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 1000 } }),
  scoped('redis_read', '读取 patternId 范围内的 String、Hash 单字段或集合元数据。', ['patternId', 'key'], { patternId: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 1024 }, field: { type: 'string', maxLength: 1024 } }),
  scoped('redis_ttl', '读取 patternId 范围内 key 的 TTL。', ['patternId', 'key'], { patternId: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 1024 } }),
];

export const methodByTool = {
  get_confirmation_status:'confirmationStatus',
  list_projects: 'listProjects', list_environments: 'listEnvironments', open_environment: 'openEnvironment', add_plugin:'addPlugin',
  server_list_actions: 'serverListActions', server_run_action: 'serverRunAction', server_system_snapshot:'serverSystemSnapshot',
  server_service_inspect:'serverServiceInspect', server_journal_query:'serverJournalQuery', server_container_inspect:'serverContainerInspect', server_list_sources: 'serverListSources',
  server_docker_list_containers:'serverDockerListContainers', server_docker_inspect_container:'serverDockerInspectContainer',
  server_docker_read_logs:'serverDockerReadLogs', server_docker_container_stats:'serverDockerContainerStats',
  server_list_files: 'serverListFiles', server_read_log: 'serverReadLog', server_search_logs: 'serverSearchLogs',
  server_read_config: 'serverReadConfig', server_stat:'serverStat', server_list_directory:'serverListDirectory',
  server_find_files:'serverFindFiles', server_read_file:'serverReadFile', server_search_files:'serverSearchFiles', server_download_file: 'serverDownloadFile',
  server_upload_file:'serverUploadFile', server_write_file:'serverWriteFile', server_move_path:'serverMovePath', server_delete_path:'serverDeletePath',
  server_control_service:'serverControlService', server_execute_shell:'serverExecuteShell',
  mysql_list_tables: 'mysqlListTables', mysql_search_schema:'mysqlSearchSchema', mysql_describe_table: 'mysqlDescribeTable', mysql_query_readonly: 'mysqlQueryReadonly', mysql_explain: 'mysqlExplain',
  redis_scan: 'redisScan', redis_read: 'redisRead', redis_ttl: 'redisTtl',
};
