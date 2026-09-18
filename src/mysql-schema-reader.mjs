import { AppError } from './errors.mjs';
import { parseOffsetCursor } from './pagination-cursor.mjs';
import { capRows } from './mysql-results.mjs';

export function normalizeSchemaKeywords(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) {
    throw new AppError('INVALID_ARGUMENT', 'Schema 搜索需要 1 到 10 个关键词。');
  }
  const keywords = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', 'Schema 搜索关键词必须是字符串。');
    const keyword = value.trim().normalize('NFKC');
    if (!keyword || [...keyword].length > 64 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
      throw new AppError('INVALID_ARGUMENT', 'Schema 搜索关键词不能为空、包含控制字符或超过 64 个字符。');
    }
    const signature = keyword.toLocaleLowerCase('zh-CN');
    if (!seen.has(signature)) {
      seen.add(signature);
      keywords.push(keyword);
    }
  }
  return keywords;
}

export class MysqlSchemaReader {
  constructor({ querySession, assertBaseTables }) {
    this.querySession = querySession;
    this.assertBaseTables = assertBaseTables;
  }

  async listTables(plugin, { cursor, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const offset = parseOffsetCursor(cursor);
    const [rows] = await this.querySession(plugin, {
      sql: 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ? OFFSET ?',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, safeLimit + 1, offset],
    }, { fallbackMessage:'MySQL 数据表列表读取失败。', operation:'list_tables' });
    const truncated = rows.length > safeLimit;
    return {
      tables: rows.slice(0, safeLimit).map((row) => ({ name: row.TABLE_NAME, type: row.TABLE_TYPE, queryable: row.TABLE_TYPE === 'BASE TABLE' })),
      nextCursor: truncated ? String(offset + safeLimit) : null,
      truncated,
    };
  }

  async searchSchema(plugin, { keywords: inputKeywords, limit = 50, table, searchIn = 'auto' } = {}) {
    const keywords = normalizeSchemaKeywords(inputKeywords);
    const safeLimit = limit;
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) {
      throw new AppError('INVALID_ARGUMENT', 'Schema 搜索结果上限必须是 1 到 100 之间的整数。');
    }
    if (!['auto','tables','columns','all'].includes(searchIn)) throw new AppError('INVALID_ARGUMENT', 'searchIn 必须是 auto、tables、columns 或 all。');
    if (table !== undefined && (typeof table !== 'string' || !table.trim() || table.length > 128 || /[\u0000-\u001f\u007f]/.test(table))) throw new AppError('INVALID_ARGUMENT', '表名无效。');
    const tableFilter = table === undefined ? '' : ' AND t.TABLE_NAME = ?';
    const tableValues = table === undefined ? [] : [table];
    const tablePredicate = keywords
      .map(() => "(INSTR(LOWER(t.TABLE_NAME), LOWER(?)) > 0 OR INSTR(LOWER(COALESCE(t.TABLE_COMMENT, '')), LOWER(?)) > 0)")
      .join(' OR ');
    const columnPredicate = keywords
      .map(() => "(INSTR(LOWER(c.COLUMN_NAME), LOWER(?)) > 0 OR INSTR(LOWER(COALESCE(c.COLUMN_COMMENT, '')), LOWER(?)) > 0)")
      .join(' OR ');
    const tableSql = `SELECT 'table' AS match_kind, t.TABLE_NAME AS table_name, t.TABLE_COMMENT AS table_comment,
        NULL AS column_name, NULL AS column_type, NULL AS column_comment, NULL AS column_key
        FROM information_schema.TABLES t
        WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'${tableFilter} AND (${tablePredicate})`;
    const columnSql = `SELECT 'column' AS match_kind, c.TABLE_NAME AS table_name, t.TABLE_COMMENT AS table_comment,
        c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type, c.COLUMN_COMMENT AS column_comment, c.COLUMN_KEY AS column_key
        FROM information_schema.COLUMNS c
        INNER JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'${tableFilter} AND (${columnPredicate})`;
    const values = [plugin.target.database, ...tableValues, ...keywords.flatMap(keyword => [keyword, keyword])];
    const query = async (kind) => {
      const sql = kind === 'all' ? `${tableSql} UNION ALL ${columnSql}` : kind === 'tables' ? tableSql : columnSql;
      const [rows] = await this.querySession(plugin, {
        sql:`${sql} ORDER BY table_name, match_kind DESC, column_name LIMIT ?`,
        timeout:plugin.limits.timeoutMs,
        values:[...values, ...(kind === 'all' ? values : []), safeLimit + 1],
      }, { fallbackMessage:'MySQL Schema 搜索失败。', operation:`search_${kind}` });
      return rows;
    };
    // 先查成本较低的表目录，只有没有命中时才自动搜索字段。
    let searchedIn = searchIn === 'auto' ? 'tables' : searchIn;
    let rows = await query(searchedIn);
    if (searchIn === 'auto' && rows.length === 0) {
      searchedIn = 'all';
      rows = await query('columns');
    }
    const matches = rows.slice(0, safeLimit).map((row) => ({
      kind:row.match_kind,
      table:row.table_name,
      tableComment:row.table_comment || null,
      ...(row.match_kind === 'column' ? {column:{
        name:row.column_name,
        type:row.column_type,
        key:row.column_key || null,
        comment:row.column_comment || null,
      }} : {}),
    }));
    const capped = capRows(matches, safeLimit, plugin.limits.maxBytes);
    return {
      keywords,
      searchedIn,
      ...(table === undefined ? {} : { table }),
      guidance:searchIn === 'auto' && searchedIn === 'tables' ? ['已优先匹配表名和注释；用 mysql_describe_table 读取候选表，或 searchIn:columns 搜索字段。'] : [],
      matches:capped.rows,
      matchCount:capped.rowCount,
      bytes:capped.bytes,
      truncated:rows.length > safeLimit || capped.truncated,
      limitsApplied:{maxMatches:safeLimit,maxBytes:plugin.limits.maxBytes,timeoutMs:plugin.limits.timeoutMs},
    };
  }

  async describeTable(plugin, tableName, { includeIndexes = false } = {}) {
    if (typeof includeIndexes !== 'boolean') throw new AppError('INVALID_ARGUMENT', 'includeIndexes 必须是布尔值。');
    const table = String(tableName ?? '').trim();
    if (!table || table.length > 128 || /[\u0000-\u001f\u007f]/.test(table)) throw new AppError('INVALID_ARGUMENT', '表名无效。');
    await this.assertBaseTables(plugin, [table]);
    const [rows] = await this.querySession(plugin, {
      sql: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 4097',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, table],
    }, { fallbackMessage:'MySQL 表结构读取失败。', operation:'describe_table' });
    const columns = capRows(rows.map((row) => ({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES', key: row.COLUMN_KEY || null, default: row.COLUMN_DEFAULT, extra: row.EXTRA || null })), 4096, plugin.limits.maxBytes);
    const result = { table, columns:columns.rows, truncated:columns.truncated };
    if (includeIndexes) {
      const [indexes] = await this.querySession(plugin, {
        sql:'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT 257',
        values:[plugin.target.database, table], timeout:plugin.limits.timeoutMs,
      }, { fallbackMessage:'MySQL 索引信息读取失败。', operation:'describe_indexes' });
      let capped;
      try {
        capped = capRows(indexes, 256, Math.max(2, plugin.limits.maxBytes - columns.bytes));
      } catch (error) {
        if (error.code !== 'RESULT_LIMIT_EXCEEDED') throw error;
        capped = {rows:[],truncated:true};
      }
      result.indexes = capped.rows;
      result.truncated ||= capped.truncated;
    }
    return result;
  }

}
