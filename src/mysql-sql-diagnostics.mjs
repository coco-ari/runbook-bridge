import { AppError, toPublicError } from './errors.mjs';
import { mysqlRuntimeInternals } from './mysql-plugin-runtime.mjs';

const ACCESS_DENIED_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
]);

const REASONS = Object.freeze({
  trigger_visibility:'无法确认目标表的触发器元数据可见性，已停止本次写入检查。',
  cascade_visibility:'无法完整核对目标表的入向级联外键，已停止本次修改或删除检查。',
  write_privilege:'数据库拒绝了当前账号对目标表或字段的写入，请核对本次操作所需权限。',
  select_privilege:'数据库拒绝读取目标表或字段，请核对 SELECT 权限；写入前的表校验也需要读取权限。',
  operation_privilege:'数据库拒绝了本次操作，请核对当前账号对目标数据库、表或字段的访问权限。',
  table_unavailable:'目标表不存在或当前账号无法读取其结构信息，请核对表名与可见性。',
  table_type:'当前对象不是基础表，本版暂不支持通过 SQL 操作此类对象。',
  non_transactional:'当前目标表不是 InnoDB 表，本版暂不支持对其写入，无法保证事务回滚。',
  trigger_side_effect:'已发现与本次写入相关的触发器，本版暂不执行带此类副作用的 SQL。',
  cascade_side_effect:'已发现与本次修改或删除相关的入向级联外键，本版暂不执行此类 SQL。',
  strict_mode:'当前会话未启用 STRICT_TRANS_TABLES 或 STRICT_ALL_TABLES，已停止写入检查。',
});

export function mysqlSqlUnsafeError(reason) {
  return typeof reason === 'string' && Object.hasOwn(REASONS, reason)
    ? new AppError('MYSQL_SQL_WRITE_UNSAFE', REASONS[reason], {reason})
    : new AppError('MYSQL_SQL_WRITE_UNSAFE', 'SQL 执行检查未通过，请核对当前目标和执行条件。');
}

export function isMysqlSqlPermissionError(error) {
  return ACCESS_DENIED_CODES.has(error?.code);
}

function publicDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  const safe = {};
  if (['queue','query','metadata'].includes(details.phase)) safe.phase = details.phase;
  if (['read','write','query','metadata','table_check','explain'].includes(details.operation)) safe.operation = details.operation;
  for (const [key, maximum] of [['statementIndex',99],['line',1_000_000],['timeoutMs',600_000]]) {
    if (Number.isInteger(details[key]) && details[key] >= 0 && details[key] <= maximum) safe[key] = details[key];
  }
  for (const key of ['retryable','queryStarted']) if (typeof details[key] === 'boolean') safe[key] = details[key];
  return Object.keys(safe).length ? safe : undefined;
}

// Context is an application-owned classification, never a parsed driver message.
// mysql2 embeds SQL, users, hosts and values in several permission diagnostics.
export function mysqlSqlPublicError(error, fallbackMessage = 'SQL 执行失败，请检查语法、字段约束或数据库账号权限。', {operation} = {}) {
  if (error?.code === 'MYSQL_SQL_WRITE_UNSAFE') return toPublicError(mysqlSqlUnsafeError(error.details?.reason));
  if (isMysqlSqlPermissionError(error)) {
    const reason = operation === 'write' ? 'write_privilege' : operation === 'read' ? 'select_privilege' : 'operation_privilege';
    return toPublicError(mysqlSqlUnsafeError(reason));
  }
  const mapped = toPublicError(mysqlRuntimeInternals.mysqlError(error, fallbackMessage));
  return {...mapped, details:publicDetails(mapped.details)};
}
