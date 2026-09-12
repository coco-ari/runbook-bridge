import { AppError } from './errors.mjs';
import { parseOffsetCursor } from './pagination-cursor.mjs';

const SCOPE_FIELDS = ['projectId', 'environmentId', 'pluginInstanceId'];
const OPERATION_FIELDS = {
  listTables: ['cursor', 'limit'],
  describeTable: ['table'],
  previewTable: ['table'],
  queryReadonly: ['sql', 'params'],
};

export function prepareDesktopMysqlOperation(payload, operation) {
  const fields = OPERATION_FIELDS[operation];
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('INVALID_ARGUMENT', '数据库操作请求无效。');
  }
  const allowed = new Set([...SCOPE_FIELDS, ...fields]);
  if (Object.keys(payload).some((field) => !allowed.has(field))) {
    throw new AppError('INVALID_ARGUMENT', '数据库操作包含不允许的参数。');
  }
  const scope = {};
  for (const field of SCOPE_FIELDS) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new AppError('INVALID_ARGUMENT', '请选择有效的项目、环境和 MySQL 插件。');
    }
    scope[field] = value;
  }
  if (operation === 'listTables') {
    const limit = payload.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new AppError('INVALID_ARGUMENT', '数据表分页数量必须是 1 到 200 之间的整数。');
    }
    return { scope, capability: 'describe', args: { cursor: parseOffsetCursor(payload.cursor), limit } };
  }
  if (operation === 'queryReadonly') {
    if (typeof payload.sql !== 'string' || !payload.sql.trim() || Buffer.byteLength(payload.sql, 'utf8') > 65_536) {
      throw new AppError('INVALID_ARGUMENT', 'SQL 为空或超过长度限制。');
    }
    return { scope, capability: 'select', args: { sql: payload.sql, params: payload.params } };
  }
  const table = typeof payload.table === 'string' ? payload.table.trim() : '';
  if (!table || table.length > 128 || /[\u0000-\u001f\u007f]/u.test(table)) {
    throw new AppError('INVALID_ARGUMENT', '表名无效。');
  }
  return operation === 'describeTable'
    ? { scope, capability: 'describe', args: { table } }
    : { scope, capability: 'select', args: { sql: `SELECT * FROM \`${table.replaceAll('`', '``')}\`` }, preview: true };
}
