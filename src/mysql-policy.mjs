import crypto from 'node:crypto';
import parserPackage from 'node-sql-parser';
import { AppError } from './errors.mjs';

const { Parser } = parserPackage;
const parser = new Parser();
const PURE_FUNCTIONS = new Set([
  'abs', 'avg', 'ceil', 'ceiling', 'coalesce', 'concat', 'concat_ws', 'convert', 'count',
  'convert_tz', 'curdate', 'current_date', 'current_timestamp', 'date', 'date_add', 'date_format', 'date_sub',
  'day', 'extract', 'floor', 'greatest', 'group_concat', 'if', 'ifnull', 'json_extract',
  'json_length', 'json_unquote', 'json_valid', 'least', 'left', 'length', 'lower', 'lpad', 'max', 'min', 'month', 'now',
  'nullif', 'replace', 'right', 'round', 'rpad', 'substring', 'substring_index', 'sum',
  'timestampdiff', 'trim', 'upper', 'year',
]);
const FORBIDDEN_FUNCTIONS = new Set([
  'benchmark', 'get_lock', 'is_free_lock', 'load_file', 'master_pos_wait', 'name_const',
  'release_all_locks', 'release_lock', 'sleep', 'source_pos_wait',
  'wait_for_executed_gtid_set', 'wait_until_sql_thread_after_gtids',
]);
const FORBIDDEN_TEXT = /\b(?:into\s+(?:out|dump)file|procedure\s+analyse|for\s+(?:update|share)|lock\s+in\s+share\s+mode)\b/i;

function functionName(node) {
  const parts = node?.name?.name;
  if (!Array.isArray(parts)) return '';
  return parts.map((item) => String(item?.value ?? '')).join('.').toLowerCase();
}

function walk(node, visitor, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  visitor(node);
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visitor, seen);
    return;
  }
  for (const child of Object.values(node)) walk(child, visitor, seen);
}

function collectTables(ast) {
  const ctes = new Set((ast.with ?? []).map((item) => String(item?.name?.value ?? '').toLowerCase()));
  const tables = new Set();
  walk(ast, (node) => {
    if (!Array.isArray(node.from)) return;
    for (const source of node.from) {
      if (!source?.table) continue;
      const table = String(source.table);
      if (!source.db && ctes.has(table.toLowerCase())) continue;
      if (source.db) throw new AppError('HARD_POLICY_DENIED', '禁止跨数据库查询。');
      tables.add(table);
    }
    if (node.type === 'aggr_func' && !PURE_FUNCTIONS.has(String(node.name ?? '').toLowerCase())) {
      const name = String(node.name ?? 'unknown').toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(name)) throw new AppError('HARD_POLICY_DENIED', `禁止使用高风险函数 ${name}。`);
      throw new AppError('DATABASE_FUNCTION_NOT_ALLOWED', `不允许使用函数 ${name}。`, {function:name});
    }
  });
  return [...tables];
}

export function validateMysqlSelect(sql, { maxSqlBytes = 65_536 } = {}) {
  const statement = String(sql ?? '').trim();
  if (!statement || Buffer.byteLength(statement, 'utf8') > maxSqlBytes || statement.includes('\0')) {
    throw new AppError('INVALID_ARGUMENT', 'SQL 为空或超过长度限制。');
  }
  if (FORBIDDEN_TEXT.test(statement)) throw new AppError('HARD_POLICY_DENIED', 'SQL 包含固定禁止的读取副作用或资源消耗语法。');
  let ast;
  try {
    ast = parser.astify(statement, { database: 'MySQL' });
  } catch {
    throw new AppError('DATABASE_QUERY_UNSUPPORTED', 'SQL 无法按安全解析器识别，请检查语法或简化查询。');
  }
  if (Array.isArray(ast)) throw new AppError('HARD_POLICY_DENIED', '禁止多语句 SQL。');
  if (ast?.type !== 'select') throw new AppError('HARD_POLICY_DENIED', '只允许 SELECT 查询。');
  if (ast.locking_read || ast.into?.position) throw new AppError('HARD_POLICY_DENIED', '禁止锁定读或文件输出。');
  walk(ast, (node) => {
    if (node.type === 'function') {
      if (node.name?.schema) throw new AppError('HARD_POLICY_DENIED', '禁止调用数据库限定的存储函数。');
      const name = functionName(node);
      if (FORBIDDEN_FUNCTIONS.has(name)) throw new AppError('HARD_POLICY_DENIED', `禁止使用高风险函数 ${name}。`);
      if (!PURE_FUNCTIONS.has(name)) {
        const denied = name || 'unknown';
        throw new AppError('DATABASE_FUNCTION_NOT_ALLOWED', `不允许使用函数 ${denied}。`, {function:denied});
      }
    }
    if (['var', 'variable', 'assign'].includes(node.type)) throw new AppError('HARD_POLICY_DENIED', '禁止变量读取或写入。');
  });
  const tables = collectTables(ast);
  return {
    statement,
    ast,
    tables,
    fingerprint: crypto.createHash('sha256').update(statement.replace(/\s+/g, ' ').toLowerCase()).digest('hex'),
  };
}

export function validateMysqlExplain(sql, options) {
  const validated = validateMysqlSelect(sql, options);
  return { ...validated, statement: `EXPLAIN ${validated.statement}` };
}

export function applyMysqlRowLimit(validated, maxRows) {
  const ast = structuredClone(validated.ast);
  const requested = Number(maxRows) + 1;
  const values = ast.limit?.value ?? [];
  const existing = values.length === 1 ? Number(values[0]?.value) : values.length === 2 ? Number(values[1]?.value) : null;
  if (!Number.isFinite(existing) || existing > requested) {
    ast.limit = { seperator: '', value: [{ type: 'number', value: requested }] };
  }
  return parser.sqlify(ast, { database: 'MySQL' });
}
