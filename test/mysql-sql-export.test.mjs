import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMysqlSql, mysqlSqlLiteral } from '../renderer/v2/src/features/database/mysql-sql-export.ts';
import { paintMysqlRows } from '../renderer/v2/src/features/database/mysql-row-selection.ts';
const col=(name,dataType='varchar',extra={})=>({name,source:name,dataType,editable:true,...extra});
const data={database:'fixture',table:'items',columns:[col('id','bigint',{primary:true,editable:false}),col('tenant','int',{primary:true,editable:false}),col('label'),col('computed','int',{editable:false,generated:true})],rows:[{rowId:'a',values:{id:'9007199254740993',tenant:'1',label:"中文'内容",computed:'2'}},{rowId:'b',values:{id:'9007199254740994',tenant:'2',label:null,computed:'4'}}],insertMissingColumns:[]};
test('四类 SQL 使用完整复合主键且仅生成选中行，保留大整数和 NULL',()=>{
  for(const kind of ['SELECT','INSERT','UPDATE','DELETE']){
    const sql=generateMysqlSql(data,[data.rows[1]],kind);
    assert.match(sql,/9007199254740994/u);assert.doesNotMatch(sql,/9007199254740993/u);
    assert.match(sql,/\x60fixture\x60\.\x60items\x60/u);
    if(kind!=='INSERT')assert.match(sql,/\x60id\x60 = 9007199254740994 AND \x60tenant\x60 = 2/u);
    if(kind==='INSERT'||kind==='UPDATE'){assert.match(sql,/NULL/u);assert.doesNotMatch(sql,/computed/u);}
  }
  const sql=generateMysqlSql(data,data.rows,'SELECT');
  assert.match(sql,/\(\x60id\x60 = 9007199254740993 AND \x60tenant\x60 = 1\)\n   OR \(\x60id\x60 = 9007199254740994 AND \x60tenant\x60 = 2\)/u);
});
test('SQL 值无损保留特殊字符，数值不得夹带 SQL',()=>{
  assert.equal(mysqlSqlLiteral(col('v'),null),'NULL');
  assert.equal(mysqlSqlLiteral(col('v'),'NULL'),"'NULL'");
  assert.equal(mysqlSqlLiteral(col('v'),''),"''");
  assert.equal(mysqlSqlLiteral(col('v'),"中文'😀"),"'中文''😀'");
  for(const value of ['a\\b','a\nb','\u0000']){
    const sql=mysqlSqlLiteral(col('v'),value);
    assert.equal(sql,"CONVERT(X'"+Buffer.from(value).toString('hex')+"' USING utf8mb4)");
  }
  assert.equal(mysqlSqlLiteral(col('v','decimal'),'9999999999999999.1234'),'9999999999999999.1234');
  assert.throws(()=>mysqlSqlLiteral(col('v','bigint'),'1;DELETE FROM items'));
  assert.throws(()=>mysqlSqlLiteral(col('v','blob'),'binary'));
  assert.throws(()=>mysqlSqlLiteral(col('v'),undefined));
});
test('SQL 生成拒绝未知来源、伪造行、缺失主键和必填字段，UPDATE 不能修改主键',()=>{
  for(const rows of [[],[data.rows[0],data.rows[0]],[structuredClone(data.rows[0])]])assert.throws(()=>generateMysqlSql(data,rows,'DELETE'));
  assert.throws(()=>generateMysqlSql({...data,database:undefined},data.rows,'INSERT'));
  assert.throws(()=>generateMysqlSql({...data,columns:[col('label')]},data.rows,'DELETE'));
  assert.throws(()=>generateMysqlSql({...data,insertMissingColumns:['required']},data.rows,'INSERT'),/required/u);
  for(const fields of [[],['id'],['computed'],['unknown']])assert.throws(()=>generateMysqlSql(data,data.rows,'UPDATE',fields));
  assert.doesNotMatch(generateMysqlSql(data,data.rows,'UPDATE',['label']),/SET \x60id\x60/u);
  const aliased={...data,table:'table\x60name',columns:data.columns.map(c=>({...c,source:c.name==='label'?'real_label':c.source}))};
  assert.match(generateMysqlSql(aliased,data.rows,'UPDATE'),/\x60table\x60\x60name\x60 SET \x60real_label\x60/u);
  const row={rowId:'null',values:{id:null,tenant:'1'}};
  assert.throws(()=>generateMysqlSql({...data,rows:[row]},[row],'DELETE'));
});
test('行号拖选按起点涂选或取消，反复经过不会反转，范围限制 100 行',()=>{
  const rows=Array.from({length:105},(_,i)=>i);
  let selected=paintMysqlRows(new Set([8]),rows,1,4,true).selection;
  assert.deepEqual([...selected],[8,1,2,3,4]);
  selected=paintMysqlRows(selected,rows,4,2,false).selection;
  assert.deepEqual([...selected],[8,1]);
  assert.deepEqual([...paintMysqlRows(selected,rows,2,4,false).selection],[8,1]);
  const full=paintMysqlRows(new Set(),rows,104,0,true);
  assert.equal(full.selection.size,100);assert.equal(full.limited,true);
  assert.deepEqual([...paintMysqlRows(new Set([3]),rows,-1,3,true).selection],[3]);
});
