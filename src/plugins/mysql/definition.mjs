import { mysqlAdapter } from './connection.mjs';
import { AppError } from '../../errors.mjs';
import { CONTROL_RE, normalizeHost, normalizePort, normalizeAddressFamily, normalizePolicy, normalizeTransport, transportReady } from '../../plugin-config-utils.mjs';

const capabilities = {
  describe: { decision:'auto', risk:'read', label:'读取数据库结构' },
  select: { decision:'auto', risk:'read', label:'执行只读 SELECT' },
  explain: { decision:'auto', risk:'read', label:'读取执行计划' },
};

function normalizeConfiguration(input, existing, base) {
  const source = {
    ...(existing ?? {}),
    ...input,
    policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
    limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
    tls: { ...(existing?.tls ?? {}), ...(input.tls ?? {}) },
  };
  const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
  const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
  const host = normalizeHost(target.host, { required: false });
  const database = String(target.database ?? '').trim();
  const username = String(auth.username ?? '').trim();
  if (database.length > 128 || CONTROL_RE.test(database) || username.length > 128 || CONTROL_RE.test(username)) {
    throw new AppError('INVALID_ARGUMENT', 'MySQL 数据库或用户名无效。');
  }
  const transport = normalizeTransport({ ...(existing?.transport ?? {}), ...(input.transport ?? {}) });
  return {
    ...base,
    configState: host && database && username && transportReady(transport) ? 'ready' : 'draft',
    target: {
      host,
      port: normalizePort(target.port, 3306),
      database,
      addressFamily: normalizeAddressFamily(target.addressFamily),
    },
    auth: { username },
    transport,
    tls: { mode: ['disabled', 'preferred', 'required', 'verifyIdentity'].includes(source.tls?.mode) ? source.tls.mode : 'preferred' },
    policy: normalizePolicy(source.policy, { describe: 'auto', select: 'auto', explain: 'auto' }),
    limits: {
      maxRows: Math.min(Math.max(Number(source.limits?.maxRows ?? 100), 1), 1000),
      maxBytes: Math.min(Math.max(Number(source.limits?.maxBytes ?? 1_048_576), 1024), 4_194_304),
      timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 10_000), 500), 60_000),
      maxConcurrency: 1,
    },
  };
}

function invoke({plugin, capability, args, runtime, options = {}}) {
  if (capability === 'describe' && args.operation === 'search') return runtime.searchSchema(plugin, args);
  if (capability === 'describe') return args.table ? runtime.describeTable(plugin, args.table, args) : runtime.listTables(plugin, args);
  if (capability === 'select') return runtime.queryReadonly(plugin, args.sql, args.params, {lossless:options.losslessMysql ?? false});
  if (capability === 'explain') return runtime.explain(plugin, args.sql, args.params);
  throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '该插件操作尚未实现。');
}

export const mysqlPluginDefinition = {
  type:'mysql',
  connectionAdapter:mysqlAdapter,
  connectionFields:['target','auth','transport','tls'],
  connectionNestedFields:{
    target:['host','port','database','addressFamily'],
    auth:['username'],
    transport:['kind','serverPluginInstanceId','interfaceAlias'],
    tls:['mode'],
  },
  normalizeConfiguration,
  publicResource: plugin => ({database:plugin.target?.database}),
  capabilities,
  invoke,
};
