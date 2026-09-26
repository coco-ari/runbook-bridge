import parserPackage from 'node-sql-parser';
import { AppError } from './errors.mjs';
import { MYSQL_READ_CAPABILITIES, applyMysqlRowLimit, validateMysqlSelect } from './mysql-policy.mjs';
import { splitMysqlScript } from './mysql-script-splitter.mjs';

const parser = new parserPackage.Parser();
const PURE_FUNCTIONS = new Set(MYSQL_READ_CAPABILITIES.allowedFunctions);
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_STATEMENTS = 100;
const MAX_ROWS = 1000;
const DML_TYPES = new Set(['insert', 'update', 'delete']);

function denied(message) { throw new AppError('HARD_POLICY_DENIED', message); }
function unsupported(message = 'SQL 无法按安全解析器识别，请检查语法或简化语句。') {
  throw new AppError('DATABASE_QUERY_UNSUPPORTED', message);
}
function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const child of Object.values(node)) walk(child, visitor);
}
function parse(sql) {
  let ast;
  try { ast = parser.astify(sql, { database: 'MySQL' }); }
  catch { unsupported(); }
  if (!ast || Array.isArray(ast)) denied('每条 SQL 必须是一个完整语句。');
  return ast;
}
function quoteIdentifier(value) { return `\`${String(value).replace(/`/gu, '``')}\``; }
// node-sql-parser retains doubled backticks in table names. Metadata preflight
// must inspect the actual server identifier, not a different escaped name.
function decodedIdentifier(value) { return String(value).replace(/``/gu, '`'); }
function pureExpressions(ast, { writes = false } = {}) {
  walk(ast, (node) => {
    if (node.db) denied('仅允许操作当前插件配置的数据库，禁止跨库引用。');
    if (['var', 'variable', 'assign', 'param'].includes(node.type) || (node.type === 'origin' && node.value === '?')) denied('暂不支持 SQL 变量、赋值表达式或参数占位符。');
    if (writes && node !== ast && (node.type === 'select' || DML_TYPES.has(node.type))) denied('首版写入仅支持单表，不支持子查询或嵌套写入。');
    if (node.type === 'function' || node.type === 'aggr_func') {
      if (node.name?.schema) denied('禁止调用存储函数或数据库限定函数。');
      const name = node.type === 'aggr_func' ? String(node.name ?? '').toLowerCase()
        : (node.name?.name ?? []).map((part) => String(part?.value ?? '')).join('.').toLowerCase();
      if (!PURE_FUNCTIONS.has(name)) {
        // Do not echo an untrusted function expression into public diagnostics.
        throw new AppError('DATABASE_FUNCTION_NOT_ALLOWED', '该函数不在已审核的纯函数范围内，首版暂不支持。');
      }
    }
    if (node.locking_read || node.into?.position) denied('禁止锁定读、文件输出或其他读取副作用。');
  });
}
function singleTable(sources) {
  if (!Array.isArray(sources) || sources.length !== 1 || typeof sources[0]?.table !== 'string' || !sources[0].table || sources[0].db || sources[0].join || sources[0].expr) {
    denied('首版仅支持当前数据库内的单表操作。');
  }
  return { ...sources[0], table: decodedIdentifier(sources[0].table) };
}
function classify(item) {
  const ast = parse(item.sql);
  if (ast.type === 'select') {
    const validated = validateMysqlSelect(item.sql, { maxSqlBytes: MAX_SCRIPT_BYTES });
    pureExpressions(validated.ast);
    return { ...item, kind: 'select', write: false, dangerous: false, tables: validated.tables.map(decodedIdentifier) };
  }
  if (ast.type === 'explain') {
    if (ast.expr?.type !== 'select') denied('首版仅支持 EXPLAIN SELECT。');
    const validated = validateMysqlSelect(parser.sqlify(ast.expr, { database: 'MySQL' }), { maxSqlBytes: MAX_SCRIPT_BYTES });
    pureExpressions(validated.ast);
    return { ...item, kind: 'explain', write: false, dangerous: false, tables: validated.tables.map(decodedIdentifier) };
  }
  if (ast.type === 'transaction') {
    const action = String(ast.expr?.action?.value ?? '').toLowerCase();
    if (ast.expr?.modes || (ast.expr?.keyword && !['TRANSACTION', 'WORK'].includes(ast.expr.keyword))) denied('首版事务控制仅支持 BEGIN、START TRANSACTION、COMMIT、ROLLBACK。');
    const kind = action === 'start' || action === 'begin' ? 'begin' : action;
    if (!['begin', 'commit', 'rollback'].includes(kind)) denied('该事务控制语句暂不支持。');
    return { ...item, kind, write: false, dangerous: false, tables: [] };
  }
  if (ast.type === 'show' || ast.type === 'desc') {
    let table;
    if (ast.type === 'desc') {
      if (typeof ast.table !== 'string' || !ast.table || Object.keys(ast).some((key) => !['type', 'table'].includes(key))) denied('首版 DESCRIBE 仅支持当前库中的单表。');
      table = decodedIdentifier(ast.table);
    } else if (ast.keyword === 'tables') {
      if (Object.keys(ast).some((key) => !['type', 'keyword'].includes(key))) denied('SHOW TABLES 不支持跨库或附加选项。');
    } else if (['columns', 'index'].includes(ast.keyword)) {
      table = singleTable(ast.from).table;
      if (Object.keys(ast).some((key) => !['type', 'keyword', 'from'].includes(key))) denied('该 SHOW 选项暂不支持。');
    } else if (ast.keyword === 'create' && ast.suffix === 'table') {
      table = singleTable([ast.table]).table;
    } else denied('首版仅支持 SHOW TABLES、SHOW COLUMNS、SHOW INDEX、SHOW CREATE TABLE 和 DESCRIBE。');
    pureExpressions(ast);
    return { ...item, kind: ast.type === 'desc' ? 'describe' : 'show', write: false, dangerous: false, tables: table ? [table] : [], ...(table ? { table } : {}) };
  }
  if (DML_TYPES.has(ast.type)) {
    if (ast.with || ast.returning || ast.partition) denied('首版写入不支持 CTE、RETURNING 或分区选项。');
    const target = singleTable(ast.type === 'delete' ? ast.from : ast.table);
    if (ast.type === 'delete') {
      const declared = singleTable(ast.table);
      if (!declared.addition || declared.table !== target.table) denied('首版 DELETE 仅支持 DELETE FROM 单表语法。');
    }
    if (ast.type === 'insert' && (ast.values?.type !== 'values' || !ast.values.values?.length || ast.on_duplicate_update || ast.set || (ast.prefix && !['into', ''].includes(ast.prefix)))) {
      denied('首版 INSERT 仅支持 VALUES，不支持 INSERT SELECT、IGNORE、SET 或冲突更新。');
    }
    if (ast.type === 'update' && !ast.set?.length) unsupported('UPDATE 缺少有效的赋值内容。');
    pureExpressions(ast, { writes: true });
    return { ...item, kind: ast.type, write: true, dangerous: ['update', 'delete'].includes(ast.type) && !ast.where, tables: [target.table], table: target.table };
  }
  denied('首版仅支持查询、单表增删改和事务控制；暂不支持结构修改、账号授权、SET、CALL 或文件读写。');
}

export function prepareMysqlSqlScript(input) {
  const sql = String(input ?? '');
  if (!sql.trim() || Buffer.byteLength(sql, 'utf8') > MAX_SCRIPT_BYTES) throw new AppError('INVALID_ARGUMENT', 'SQL 不能为空，单次脚本最多 256 KiB。');
  const statements = splitMysqlScript(sql);
  if (!statements.length || statements.length > MAX_STATEMENTS) throw new AppError('INVALID_ARGUMENT', '单次脚本需要包含 1 至 100 条 SQL。');
  // Validate the complete batch before an execution session can start any query.
  return statements.map((item, index) => {
    try { return classify(item); }
    catch (error) {
      if (error instanceof AppError) error.details = { ...(error.details ?? {}), statementIndex: index, line: item.line };
      throw error;
    }
  });
}

export function mysqlSqlRequest(item, { database, maxRows = 200 } = {}) {
  if (typeof database !== 'string' || !database || database.includes('\0')) throw new AppError('INVALID_ARGUMENT', 'SQL 执行需要明确的当前数据库。');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new AppError('INVALID_ARGUMENT', 'SQL 结果行数必须为 1 至 1000。');
  // Do not trust a renderer-supplied classification or previously mutated item.
  const [checked, ...remaining] = prepareMysqlSqlScript(item?.sql);
  if (remaining.length) denied('执行请求只能包含一条已校验 SQL。');
  const limit = maxRows + 1;
  if (checked.kind === 'select' || checked.kind === 'explain') {
    const ast = parse(checked.sql);
    const selectAst = checked.kind === 'explain' ? ast.expr : ast;
    const statement = parser.sqlify(selectAst, { database: 'MySQL' });
    const validated = validateMysqlSelect(statement, { maxSqlBytes: MAX_SCRIPT_BYTES });
    const bounded = selectAst.set_op || selectAst._next
      ? `SELECT * FROM (${statement}) AS ${quoteIdentifier('_desktop_result')} LIMIT ${limit}`
      : applyMysqlRowLimit(validated, maxRows);
    return { sql: checked.kind === 'explain' ? `EXPLAIN ${bounded}` : bounded, values: [] };
  }
  if (checked.kind === 'show' || checked.kind === 'describe') {
    const ast = parse(checked.sql);
    if (ast.keyword === 'tables') return {
      sql: `SELECT TABLE_NAME AS ${quoteIdentifier(`Tables_in_${database}`)} FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT ?`,
      values: [database, limit],
    };
    if (checked.kind === 'describe' || ast.keyword === 'columns') return {
      sql: 'SELECT COLUMN_NAME AS Field, COLUMN_TYPE AS Type, IS_NULLABLE AS `Null`, COLUMN_KEY AS `Key`, COLUMN_DEFAULT AS `Default`, EXTRA AS Extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ?',
      values: [database, checked.table, limit],
    };
    if (ast.keyword === 'index') return {
      sql: 'SELECT TABLE_NAME AS `Table`, NON_UNIQUE AS Non_unique, INDEX_NAME AS Key_name, SEQ_IN_INDEX AS Seq_in_index, COLUMN_NAME AS Column_name, COLLATION AS Collation, CARDINALITY AS Cardinality, SUB_PART AS Sub_part, NULLABLE AS `Null`, INDEX_TYPE AS Index_type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT ?',
      values: [database, checked.table, limit],
    };
    return { sql: `SHOW CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(checked.table)}`, values: [] };
  }
  if (checked.kind === 'begin') return { sql: 'START TRANSACTION', values: [] };
  if (checked.kind === 'commit' || checked.kind === 'rollback') return { sql: checked.kind.toUpperCase(), values: [] };
  return { sql: checked.sql, values: [] };
}
