import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.mjs';

export const MYSQL_GROUP_PREFIX = 'rbb:mysql-group:';
export const MYSQL_GROUP_NAME_PREFIX = 'rbb:mysql-name:';
const GROUP_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function mysqlPluginGroup(plugin) {
  if (plugin?.pluginType === 'mysql' && GROUP_ID.test(plugin.mysqlConnectionId ?? '')) return {id:plugin.mysqlConnectionId,name:plugin.mysqlConnectionName ?? 'MySQL 连接'};
  if (plugin?.pluginType !== 'mysql' || !Array.isArray(plugin.tags)) return null;
  const ids = plugin.tags.filter(tag => tag.startsWith(MYSQL_GROUP_PREFIX));
  const names = plugin.tags.filter(tag => tag.startsWith(MYSQL_GROUP_NAME_PREFIX));
  if (ids.length !== 1 || !GROUP_ID.test(ids[0].slice(MYSQL_GROUP_PREFIX.length))) return null;
  return {id:ids[0].slice(MYSQL_GROUP_PREFIX.length),name:names.length === 1 ? names[0].slice(MYSQL_GROUP_NAME_PREFIX.length) : 'MySQL 插件组'};
}

export function withoutMysqlGroupTags(tags = []) {
  return tags.filter(tag => !tag.startsWith(MYSQL_GROUP_PREFIX) && !tag.startsWith(MYSQL_GROUP_NAME_PREFIX));
}

export function mysqlGroupTags(tags, id, name) {
  const normalized = String(name ?? '').normalize('NFKC').trim();
  if (!GROUP_ID.test(id) || !normalized || normalized.length > 40 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new AppError('INVALID_ARGUMENT','MySQL 组名须为 1–40 个字符。');
  }
  return [...withoutMysqlGroupTags(tags),`${MYSQL_GROUP_PREFIX}${id}`,`${MYSQL_GROUP_NAME_PREFIX}${normalized}`];
}

export function mysqlGroupMembers(plugin, plugins) {
  const group = mysqlPluginGroup(plugin);
  return group ? plugins.filter(item => item.projectId === plugin.projectId && item.environmentId === plugin.environmentId && mysqlPluginGroup(item)?.id === group.id) : [];
}

export function mysqlSharedConnection(plugin) {
  const {database: _database,...target} = plugin.target;
  return {target,auth:plugin.auth,transport:plugin.transport,tls:plugin.tls};
}

export function mysqlConnectionsEqual(left, right) {
  return isDeepStrictEqual(mysqlSharedConnection(left),mysqlSharedConnection(right));
}

export function normalizeBatchDatabases(databases) {
  if (!Array.isArray(databases) || databases.length < 1 || databases.length > 100
    || databases.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\p{Cc}\p{Cf}]/u.test(value))) {
    throw new AppError('INVALID_ARGUMENT','请选择 1–100 个有效数据库。');
  }
  const normalized = databases.map(value => value.trim());
  if (new Set(normalized).size !== normalized.length) throw new AppError('INVALID_ARGUMENT','数据库选择不能重复。');
  return normalized;
}
