import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';
import { normalizePlugin, sanitizePluginSnapshot, normalizeName } from './plugin-config-model.mjs';
import { mysqlPluginGroup, mysqlSharedConnection, withoutMysqlGroupTags, mysqlGroupTags, normalizeBatchDatabases } from './mysql-plugin-group.mjs';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function migrationId(parts) {
  const bytes = crypto.createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const mysqlConnectionCredentialId = id => {
  if (!ID.test(id)) throw new AppError('MYSQL_CONNECTION_INVALID','MySQL 连接标识无效。');
  return `mysql-connection-${id}`;
};

export function mysqlCredentialIdentity(plugin) {
  if (plugin?.pluginType !== 'mysql' || !plugin.mysqlConnectionId) return plugin;
  const {database:_database,...target} = plugin.target;
  return {...plugin,pluginInstanceId:mysqlConnectionCredentialId(plugin.mysqlConnectionId),target};
}

export function createMysqlConnection(plugin,{id = crypto.randomUUID(),name = plugin.displayName,revision = 1} = {}) {
  mysqlConnectionCredentialId(id);
  const normalized = normalizePlugin(plugin,plugin);
  return {connectionId:id,name:normalizeName(name,'MySQL 连接名称'),revision,...mysqlSharedConnection(normalized)};
}

export function bindMysqlConnection(plugin,connection) {
  if (!connection || !connection.target || !connection.auth || !connection.transport || !connection.tls) throw new AppError('MYSQL_CONNECTION_INVALID','MySQL 公共连接配置不完整。');
  mysqlConnectionCredentialId(connection.connectionId);
  if (!connection.name || !Number.isInteger(connection.revision) || connection.revision < 1) throw new AppError('MYSQL_CONNECTION_INVALID','MySQL 公共连接配置损坏。');
  return {...plugin,...mysqlSharedConnection({...connection,target:{...connection.target}}),
    target:{...connection.target,database:plugin.target.database},
    tags:withoutMysqlGroupTags(plugin.tags),mysqlConnectionId:connection.connectionId,
    mysqlConnectionName:connection.name,mysqlConnectionRevision:connection.revision};
}

export function storedPluginSnapshot(plugin,registry) {
  const value = sanitizePluginSnapshot(plugin,registry);
  if (plugin.pluginType !== 'mysql' || !plugin.mysqlConnectionId) return value;
  mysqlConnectionCredentialId(plugin.mysqlConnectionId);
  const {auth:_auth,transport:_transport,tls:_tls,mysqlConnectionName:_name,mysqlConnectionRevision:_revision,...rest} = value;
  return {...rest,schemaVersion:2,mysqlConnectionId:plugin.mysqlConnectionId,target:{database:value.target.database},tags:withoutMysqlGroupTags(value.tags)};
}

export function resolveStoredMysql(plugin,environment) {
  if (plugin.schemaVersion !== 2 || plugin.pluginType !== 'mysql' || !plugin.mysqlConnectionId
    || Object.keys(plugin.target ?? {}).some(key => key !== 'database') || ['auth','transport','tls'].some(key => Object.hasOwn(plugin,key))) {
    throw new AppError('MYSQL_CONNECTION_INVALID','数据库引用格式损坏。');
  }
  const connection = environment.mysqlConnections?.find(item => item.connectionId === plugin.mysqlConnectionId);
  if (!connection) throw new AppError('MYSQL_CONNECTION_NOT_FOUND','数据库引用的 MySQL 连接不存在。');
  const resolved = bindMysqlConnection({...plugin,schemaVersion:1},connection);
  let normalized;
  try { normalized = sanitizePluginSnapshot(resolved); }
  catch { throw new AppError('MYSQL_CONNECTION_INVALID','MySQL 公共连接配置无效。'); }
  if (!isDeepStrictEqual(mysqlSharedConnection(normalized),mysqlSharedConnection(resolved))) throw new AppError('MYSQL_CONNECTION_INVALID','MySQL 公共连接配置无效。');
  return resolved;
}

// 只合并明确属于同一旧组且连接、凭据完全相同的成员；普通单库始终独立迁移。
export function migrateMysqlRecords(records,existingConnections = []) {
  const connections = structuredClone(existingConnections);
  const buckets = [];
  records = records.flatMap(({plugin,secrets}) => {
    if (plugin.pluginType !== 'mysql' || plugin.mysqlConnectionId || !Object.hasOwn(plugin.target,'databases')) return [{plugin,secrets}];
    const databases = normalizeBatchDatabases(plugin.target.databases);
    if (!databases.includes(plugin.target.database)) throw new AppError('MYSQL_CONNECTION_INVALID','旧多库配置的默认库不在授权范围内，已保留原配置。');
    const ordered = [plugin.target.database,...databases.filter(database => database !== plugin.target.database)];
    const tags = mysqlGroupTags(plugin.tags,migrationId([plugin.projectId,plugin.environmentId,plugin.pluginInstanceId,'legacy-multi']),plugin.displayName.slice(0,40));
    return ordered.map((database,index) => ({secrets,plugin:{...normalizePlugin({...plugin,tags,pluginInstanceId:index === 0 ? plugin.pluginInstanceId : `mysql-${migrationId([plugin.projectId,plugin.environmentId,plugin.pluginInstanceId,database])}`,
      displayName:index === 0 ? plugin.displayName : database,target:{...plugin.target,database}},plugin),revision:index === 0 ? plugin.revision : 1,updatedAt:plugin.updatedAt}}));
  });
  const migrated = records.map(({plugin,secrets}) => {
    if (plugin.pluginType !== 'mysql' || plugin.mysqlConnectionId || plugin.configState === 'draft') return {plugin,secrets};
    const group = mysqlPluginGroup(plugin);
    let bucket = group && buckets.find(item => item.groupId === group.id
      && isDeepStrictEqual(item.common,mysqlSharedConnection(plugin)) && isDeepStrictEqual(item.secrets,secrets));
    if (!bucket) {
      // 同一旧配置在本机迁移和云端导入时使用稳定标识，避免反复同步生成不同连接。
      const id = migrationId([plugin.projectId,plugin.environmentId,plugin.pluginInstanceId]);
      if (connections.some(item => item.connectionId === id)) throw new AppError('MYSQL_CONNECTION_INVALID','迁移连接标识与已有记录冲突，原配置已保留。');
      const connection = createMysqlConnection(plugin,{id,name:group?.name ?? plugin.displayName});
      bucket = {groupId:group?.id,common:mysqlSharedConnection(plugin),secrets,connection};
      buckets.push(bucket);
      connections.push(connection);
    }
    return {plugin:bindMysqlConnection(plugin,bucket.connection),secrets};
  });
  return {connections,records:migrated};
}
