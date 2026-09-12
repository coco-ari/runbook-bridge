import parserPackage from 'node-sql-parser';
import { AppError } from './errors.mjs';
import { validateMysqlSelect } from './mysql-policy.mjs';

const parser = new parserPackage.Parser();
const identifier = (value) => `\`${value.replaceAll('`', '``')}\``;

export function desktopMysqlPreviewSql(table, { where = '', orderBy = [], limit, offset = 0 }) {
  if (typeof where !== 'string' || Buffer.byteLength(where, 'utf8') > 8192) {
    throw new AppError('INVALID_ARGUMENT', '筛选条件必须是 8 KB 以内的表达式。');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new AppError('INVALID_ARGUMENT', '每次预览读取数量必须为 1 到 100。');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || (offset > 0 && limit === undefined)) {
    throw new AppError('INVALID_ARGUMENT', '预览分页偏移无效。');
  }
  if (!Array.isArray(orderBy) || orderBy.length > 8 || orderBy.some(item => !item || typeof item !== 'object'
    || Object.keys(item).some(key => !['column', 'direction'].includes(key))
    || typeof item.column !== 'string' || !item.column || item.column.length > 128 || /[\u0000-\u001f\u007f]/u.test(item.column)
    || !['asc', 'desc'].includes(item.direction))) {
    throw new AppError('INVALID_ARGUMENT', '排序仅支持字段名和升降序。');
  }
  let predicate = '';
  if (where.trim()) {
    const { ast, tables } = validateMysqlSelect(`SELECT 1 WHERE (${where})`);
    if (!ast.where || tables.length || ast.from || ast.with || ast._next || ast.set_op || ast.orderby || ast.limit || ast.groupby || ast.having) {
      throw new AppError('INVALID_ARGUMENT', '这里只填写筛选条件，不包含其他查询或排序语句。');
    }
    // 只序列化校验后的表达式，防止筛选输入逃逸到固定的表、排序或分页之外。
    const pending = [ast.where];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'select' || node.ast?.type === 'select') throw new AppError('INVALID_ARGUMENT', '简单筛选不支持子查询，请使用 SQL 查询页。');
      pending.push(...Object.values(node));
    }
    predicate = ` WHERE ${parser.exprToSQL(ast.where, { database:'MySQL' })}`;
  }
  const order = orderBy.length ? ` ORDER BY ${orderBy.map(item => `${identifier(item.column)} ${item.direction.toUpperCase()}`).join(', ')}` : '';
  return `SELECT * FROM ${identifier(table)}${predicate}${order}${limit === undefined ? '' : ` LIMIT ${offset}, ${limit}`}`;
}
