#!/usr/bin/env node
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { defaultDataRoot } from './paths.mjs';
import { callBroker } from './broker-client.mjs';
import { AppError, toPublicError } from './errors.mjs';

const VERSION = '1.0.11';
const dataRoot = defaultDataRoot();
const clientInstanceId = crypto.randomBytes(16).toString('hex');
let brokerHandshake = null;
const instructions = `这是一个插件化 Agent 运维入口。项目下的环境彼此隔离；每次开始工作必须先调用 open_environment，读取该环境运维说明、插件目录和 contextToken。桌面应用不会因为 Agent 调用而连接环境；插件未连接时，请用户在桌面应用点击“连接环境”。环境部分连接时，仅调用明确显示 connected 的插件。可使用 add_plugin 根据运维说明或已脱敏配置添加一个断开的插件；只能传结构化非敏感配置，绝不能索要、读取或传递密码、私钥内容、Token 或 DSN，创建后必须重新 open_environment。Server 不提供任意 Shell，只能使用固定 actionId，日志和配置只能通过 sourceId/fileId。MySQL 插件固定一个数据库且只允许结构、SELECT、EXPLAIN；Redis 只允许已登记 patternId 下的 SCAN、读取和 TTL。`;

const scope = {
  projectId: { type: 'string', minLength: 2, maxLength: 63 },
  environmentId: { type: 'string', minLength: 2, maxLength: 63 },
  pluginInstanceId: { type: 'string', minLength: 2, maxLength: 63 },
  contextToken: { type: 'string', minLength: 16, maxLength: 256 },
  requestId: { type: 'string', minLength: 1, maxLength: 128 },
  approvalToken: { type: 'string', minLength: 16, maxLength: 256 },
};

function tool(name, description, required, properties = {}) {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, required, properties } };
}

function scoped(name, description, extraRequired = [], extra = {}) {
  return tool(name, description, ['projectId', 'environmentId', 'pluginInstanceId', 'contextToken', ...extraRequired], { ...scope, ...extra });
}

const tools = [
  tool('list_projects', '列出本机项目摘要，不连接任何环境。', [], {}),
  tool('list_environments', '列出项目的用户自定义环境，不连接插件。', ['projectId'], { projectId: scope.projectId }),
  tool('open_environment', '读取一个环境的运维说明、插件目录、连接状态并取得短期上下文令牌。', ['projectId', 'environmentId'], { projectId: scope.projectId, environmentId: scope.environmentId }),
  tool('add_plugin', '在已打开环境中添加一个保持断开的 Server、MySQL 或 Redis 插件。只接收结构化非敏感配置；仅填写名称也可保存为待配置草稿。', ['projectId','environmentId','contextToken','pluginType','displayName'], {
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
  scoped('server_list_sources', '列出 Server 插件登记的日志、配置和下载数据源。不会联网。'),
  scoped('server_list_files', '列出已登记 sourceId 根目录内的受限文件。', ['sourceId'], { sourceId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  scoped('server_read_log', '通过短期 fileId 分页或读取日志尾部。', ['fileId'], { fileId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 }, tail: { type: 'boolean' } }),
  scoped('server_search_logs', '在最多 10 个已列出的 fileId 中执行有界字面量搜索。', ['fileIds', 'contains'], { fileIds: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } }, contains: { type: 'string', minLength: 1, maxLength: 1024 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 }, maxScanBytes: { type: 'integer', minimum: 65536, maximum: 8388608 } }),
  scoped('server_read_config', '读取已登记的配置 fileId，并在本地脱敏。', ['fileId'], { fileId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: 262144 } }),
  scoped('server_download_file', '把已登记的 fileId 下载到项目本地 downloads 目录。', ['fileId'], { fileId: { type: 'string' } }),
  scoped('mysql_list_tables', '分页列出此单库 MySQL 插件中的表；不会枚举其他数据库。', [], { cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  scoped('mysql_describe_table', '查看一个基础表的字段结构；V1 不开放 View。', ['table'], { table: { type: 'string', minLength: 1, maxLength: 128 } }),
  scoped('mysql_query_readonly', '执行单条只读 SELECT。固定数据库，禁止 USE、跨库、写入和多语句。', ['sql'], { sql: { type: 'string', minLength: 1, maxLength: 65536 }, params: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } } }),
  scoped('mysql_explain', '执行 EXPLAIN SELECT；禁止 EXPLAIN ANALYZE。', ['sql'], { sql: { type: 'string', minLength: 1, maxLength: 65536 }, params: { type: 'array', maxItems: 100 } }),
  scoped('redis_scan', '按已登记 patternId 有界扫描 Redis key。', ['patternId'], { patternId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }),
  scoped('redis_read', '读取 patternId 范围内的 String、Hash 单字段或集合元数据。', ['patternId', 'key'], { patternId: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 1024 }, field: { type: 'string', maxLength: 1024 } }),
  scoped('redis_ttl', '读取 patternId 范围内 key 的 TTL。', ['patternId', 'key'], { patternId: { type: 'string' }, key: { type: 'string', minLength: 1, maxLength: 1024 } }),
];

const methodByTool = {
  list_projects: 'listProjects', list_environments: 'listEnvironments', open_environment: 'openEnvironment', add_plugin:'addPlugin',
  server_list_actions: 'serverListActions', server_run_action: 'serverRunAction', server_list_sources: 'serverListSources',
  server_list_files: 'serverListFiles', server_read_log: 'serverReadLog', server_search_logs: 'serverSearchLogs',
  server_read_config: 'serverReadConfig', server_download_file: 'serverDownloadFile',
  mysql_list_tables: 'mysqlListTables', mysql_describe_table: 'mysqlDescribeTable', mysql_query_readonly: 'mysqlQueryReadonly', mysql_explain: 'mysqlExplain',
  redis_scan: 'redisScan', redis_read: 'redisRead', redis_ttl: 'redisTtl',
};

const server = new Server({ name: 'agent-ops-workbench', version: VERSION }, { capabilities: { tools: {} }, instructions });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = request.params.name;
    const method = methodByTool[name];
    if (!method) throw new AppError('METHOD_NOT_FOUND', '未知 MCP 工具。');
    const args = { ...(request.params.arguments ?? {}) };
    args.clientInstanceId = clientInstanceId;
    brokerHandshake ??= callBroker(dataRoot, 'info', {}, 10_000).then((info) => {
      if (info?.protocolVersion !== 2) throw new AppError('BROKER_VERSION_MISMATCH', '桌面端与 Agent MCP 版本不兼容，请重启并更新 Agent 运维工作台。', { expectedProtocol:2, actualProtocol:info?.protocolVersion ?? null });
      return info;
    }).catch((error) => { brokerHandshake = null; throw error; });
    await brokerHandshake;
    const result = await callBroker(dataRoot, `v2.${method}`, args, 10 * 60 * 1000);
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (error) {
    const value = toPublicError(error);
    return { isError: true, content: [{ type: 'text', text: `${value.code}: ${value.message}` }], structuredContent: { ok: false, error: value } };
  }
});

await server.connect(new StdioServerTransport());
