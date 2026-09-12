import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMysqlSelect, applyMysqlRowLimit } from '../src/mysql-policy.mjs';
import { prepareDesktopMysqlOperation } from '../src/desktop-mysql-operation.mjs';
import { mysqlCompletionContext, mysqlSelectSnippet, mysqlSqlDiagnostic, compareMysqlCells } from '../renderer/v2/src/features/database/mysql-sql-assist.ts';

const scope = { projectId:'fixture-project', environmentId:'fixture-environment', pluginInstanceId:'fixture-mysql' };
const preview = (options) => prepareDesktopMysqlOperation({ ...scope, table:'records', ...options }, 'previewTable').args.sql;
const tables = [{ name:'records', type:'BASE TABLE', queryable:true }, { name:'record_view', type:'VIEW', queryable:false }];

test('行数限制同时保留两种 LIMIT 写法的偏移和更小的读取数量', () => {
  for (const [sql, count, offset] of [
    ['SELECT * FROM records LIMIT 20 OFFSET 100',20,100],
    ['SELECT * FROM records LIMIT 100, 20',20,100],
    ['SELECT * FROM records LIMIT 200 OFFSET 40',21,40],
    ['SELECT * FROM records LIMIT 40, 200',21,40],
    ['SELECT * FROM records LIMIT 5 OFFSET 0',5,0],
  ]) {
    const { ast } = validateMysqlSelect(applyMysqlRowLimit(validateMysqlSelect(sql),20));
    const isOffset = ast.limit.seperator === 'offset';
    assert.equal(ast.limit.value[isOffset ? 0 : 1].value,count);
    assert.equal(ast.limit.value[isOffset ? 1 : 0].value,offset);
  }
});

test('表预览把条件限制在表达式内，并保留排序和分页', () => {
  const sql = preview({ where:"id > 10 AND label LIKE 'fixture%'",orderBy:[{column:'id',direction:'desc'}],limit:20,offset:40 });
  const { ast, tables } = validateMysqlSelect(sql);
  assert.deepEqual(tables,['records']);
  assert.equal(ast.orderby[0].expr.column,'id');
  assert.equal(ast.orderby[0].type,'DESC');
  assert.deepEqual(ast.limit.value.map(item => item.value),[40,20]);
  assert.equal(ast.where.operator,'AND');
  assert.match(preview({where:"label = 'ORDER BY id'"}), /ORDER BY id/);
  const quoted = validateMysqlSelect(preview({orderBy:[{column:'x`; DELETE FROM records; --',direction:'asc'}]}));
  assert.equal(quoted.ast.orderby[0].expr.column.replaceAll('``','`'),'x`; DELETE FROM records; --');
});
for (const options of [
  { where:'id IN (SELECT id FROM other_records)' },
  { where:'id IN (SELECT 1)' },
  { where:'1=1) UNION SELECT 1 -- ' },
  { where:'1=1) ORDER BY 1 -- ' },
  { where:'SLEEP(1)=0' },
  { where:'1=1); DELETE FROM records; -- ' },
  { where:'x'.repeat(8193) }, { where:{} }, { where:null },
  { limit:0 }, { limit:101 }, { offset:-1 }, { offset:100001,limit:20 }, { offset:20 },
  { orderBy:[{column:'id',direction:'asc; drop'}] }, { orderBy:[{column:'id',direction:'asc',sql:'arbitrary'}] },
]) test('表预览拒绝越界或逃逸参数 ' + JSON.stringify(options).slice(0,100), () => assert.throws(() => preview(options)));

test('SQL 生成保留标识符边界，补全支持表名和常用别名', () => {
  assert.match(mysqlSelectSnippet('odd`table'), /`odd``table`/);
  for (const sql of ['SELECT records.', 'SELECT r. FROM records r', 'SELECT r. FROM records AS r']) {
    const caret = sql.indexOf('.') + 1;
    assert.equal(mysqlCompletionContext(sql,caret,tables)?.table,'records');
  }
  const partial = 'SELECT r.la FROM records r';
  const context = mysqlCompletionContext(partial,partial.indexOf('la')+2,tables);
  assert.equal(context.prefix,'la');
  assert.equal(partial.slice(context.start,context.end),'la');
  assert.equal(mysqlCompletionContext('SELECT * FROM rec',17,tables)?.kind,'table');
  for (const sql of ["SELECT 'records.", 'SELECT 1 -- records.', 'SELECT record_view.', 'SELECT unknown.']) assert.equal(mysqlCompletionContext(sql,sql.length,tables),null);
});

test('基础语法诊断区分有效查询、不完整 SQL 和写入语句', async () => {
  assert.equal((await mysqlSqlDiagnostic('SELECT id FROM records LIMIT 20')).kind,'valid');
  assert.equal((await mysqlSqlDiagnostic('SELECT\nFROM')).kind,'error');
  assert.equal((await mysqlSqlDiagnostic('DELETE FROM records')).kind,'error');
  assert.equal((await mysqlSqlDiagnostic('SELECT 1; SELECT 2')).kind,'error');
  assert.equal(await mysqlSqlDiagnostic('   '),null);
});

test('结果排序保持 BIGINT、DECIMAL 和空值的正确顺序', () => {
  assert.ok(compareMysqlCells('9007199254740992','9007199254740993',true) < 0);
  assert.ok(compareMysqlCells('1.11','1.2',true) < 0);
  assert.ok(compareMysqlCells('-12.2','-2.1',true) < 0);
  assert.ok(compareMysqlCells(null,0,true) < 0);
  assert.equal(compareMysqlCells('-0.0','0',true),0);
});
