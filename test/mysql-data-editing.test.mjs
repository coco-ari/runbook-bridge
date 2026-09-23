import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { DesktopMysqlEditor, prepareMysqlEditRequest } from '../src/desktop-mysql-editor.mjs';
import { editableMysqlQuery, mysqlEditProjection, normalizeMysqlEditValue, quoteMysqlName } from '../src/mysql-edit-policy.mjs';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';

const scope={projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-mysql'};
const plugin={...scope,revision:1,pluginType:'mysql',displayName:'测试数据库',target:{database:'fixture'},limits:{maxRows:100,maxBytes:1048576,timeoutMs:3000}};
const column=(name,type='varchar',overrides={})=>({name,type:type==='varchar'?'varchar(100)':type,dataType:type,key:'',extra:'',nullable:true,maxLength:100,precision:20,scale:4,datetimePrecision:6,...overrides});
const schema={table:'items',columns:[column('id','bigint',{key:'PRI'}),column('label'),column('amount','decimal')]};

function harness({failure,auditFailure,metadata=schema,primaryNames}={}){
  let values=[['9007199254740993','first','1.0000'],['9007199254740994','second','2.0000']],backup=null;
  const statements=[],audits=[];
  let clock=1000,gate=null;
  const runtime=new MysqlPluginRuntime({closeRelay:async()=>{}},{});
  const session={connection:{query:async request=>{
    const sql=request.sql;statements.push({sql,values:request.values});
    if(gate)await gate(sql);
    if(failure)await failure(sql);
    if(sql.includes('SELECT TABLE_TYPE'))return [[{TABLE_TYPE:'BASE TABLE',ENGINE:'InnoDB'}]];
    if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return [(primaryNames??metadata.columns.filter(c=>c.key==='PRI').map(c=>c.name)).map(name=>({COLUMN_NAME:name}))];
    if(sql.includes('information_schema.COLUMNS'))return [metadata.columns.map(c=>({COLUMN_NAME:c.name,COLUMN_TYPE:c.type,DATA_TYPE:c.dataType,IS_NULLABLE:c.nullable?'YES':'NO',COLUMN_KEY:c.key,EXTRA:c.extra,CHARACTER_MAXIMUM_LENGTH:c.maxLength,NUMERIC_PRECISION:c.precision,NUMERIC_SCALE:c.scale,DATETIME_PRECISION:c.datetimePrecision}))];
    if(sql.includes('@@SESSION.sql_mode'))return [[{sqlMode:'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'}]];
    if(sql==='START TRANSACTION'){backup=structuredClone(values);return [{affectedRows:0}];}
    if(sql==='ROLLBACK'){values=backup;return [{affectedRows:0}];}
    if(sql==='COMMIT'){backup=null;return [{affectedRows:0}];}
    if(sql.startsWith('UPDATE ')){
      const row=values.find(row=>row[0]===request.values.at(-1));
      if(!row)return [{affectedRows:0,warningStatus:0}];
      const changed=[...sql.matchAll(/\x60([^\x60]+)\x60 = \?/gu)].map(match=>match[1]);
      changed.forEach((name,index)=>{row[metadata.columns.findIndex(c=>c.name===name)]=request.values[index];});
      return [{affectedRows:1,warningStatus:0}];
    }
    const subset=sql.includes('FOR UPDATE')||sql.includes(' WHERE '+quoteMysqlName('id')+' <=>')?values.filter(row=>row[0]===request.values[0]):values;
    return [structuredClone(subset),metadata.columns.map(c=>({name:c.name,orgName:c.name,orgTable:'items',schema:'fixture'}))];
  },destroy:()=>{}}};
  session.connection.execute=session.connection.query;
  runtime.sessions.set('fixture-project/fixture-environment/fixture-mysql',session);
  const editor=new DesktopMysqlEditor(runtime,{appendAudit:async(_project,event)=>{audits.push(event);if(auditFailure)throw new Error('fixture audit failure');}},{now:()=>clock});
  return {editor,runtime,statements,audits,session,rows:()=>values,advance:()=>{clock+=2000000;},mutate:fn=>{values=fn(values);},gate:fn=>{gate=fn;},
    open:()=>editor.open('window-a',plugin,{sql:'SELECT * FROM items'})};
}

test('编辑资格要求单表直接字段和完整主键，拒绝复杂查询与重复映射',()=>{
  for(const sql of ['SELECT 1','SELECT DISTINCT id FROM items','SELECT id, count(*) FROM items GROUP BY id','SELECT a.id FROM items a JOIN other b ON a.id=b.id','SELECT id FROM items UNION SELECT id FROM items','SELECT id FROM items WHERE id IN (SELECT id FROM items)','SELECT id+1 FROM items'])assert.throws(()=>editableMysqlQuery(sql));
  assert.equal(editableMysqlQuery('SELECT a.id AS identity_key,a.label FROM items a WHERE id > 1 ORDER BY id LIMIT 20').table,'items');
  assert.throws(()=>mysqlEditProjection(editableMysqlQuery('SELECT label FROM items'),schema),{code:'MYSQL_EDIT_READONLY'});
  assert.throws(()=>mysqlEditProjection(editableMysqlQuery('SELECT id,id FROM items'),schema),{code:'MYSQL_EDIT_READONLY'});
  assert.equal(mysqlEditProjection(editableMysqlQuery('SELECT id,label FROM items'),schema)[0].editable,false);
});

test('字段校验保留大整数、小数和日期精度，区分 NULL 与空字符串',()=>{
  assert.equal(normalizeMysqlEditValue(column('value','bigint'),'9007199254740993'),'9007199254740993');
  assert.throws(()=>normalizeMysqlEditValue(column('value','bigint'),'9223372036854775808'));
  assert.equal(normalizeMysqlEditValue(column('amount','decimal'),'123456789012.1234'),'123456789012.1234');
  assert.throws(()=>normalizeMysqlEditValue(column('amount','decimal'),'0.12345'));
  assert.equal(normalizeMysqlEditValue(column('date','datetime'),'2024-02-29 23:59:59.123456'),'2024-02-29 23:59:59.123456');
  assert.throws(()=>normalizeMysqlEditValue(column('date','datetime'),'2025-02-29 00:00:00'));
  assert.equal(normalizeMysqlEditValue(column('text'),''),'');
  assert.equal(normalizeMysqlEditValue(column('text'),null),null);
  assert.throws(()=>normalizeMysqlEditValue(column('text','varchar',{nullable:false}),null));
  assert.throws(()=>normalizeMysqlEditValue(column('state','enum',{type:"enum('open','closed')"}),'other'));
  assert.throws(()=>normalizeMysqlEditValue(column('json','json'),'{invalid}'));
  assert.throws(()=>normalizeMysqlEditValue(column('id','bigint',{key:'PRI'}),'2'));
});

test('快照、确认计划和参数化保存绑定目标行，重复提交不会再次执行',async()=>{
  const h=harness(),opened=await h.open();
  const target=opened.rows[1];
  const payload={editId:opened.editId,changes:[{rowId:target.rowId,values:{label:"new ' label",amount:'19.0001'}}]};
  const plan=h.editor.prepare('window-a',plugin,payload);
  payload.changes[0].values.label='篡改前端草稿';
  const result=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  assert.equal(result.status,'success');
  assert.deepEqual(h.rows()[0],['9007199254740993','first','1.0000']);
  assert.deepEqual(h.rows()[1],['9007199254740994',"new ' label",'19.0001']);
  assert.equal(h.statements.filter(s=>s.sql.startsWith('UPDATE')).length,1);
  assert.equal((await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId})).status,'success');
  assert.equal(h.statements.filter(s=>s.sql.startsWith('UPDATE')).length,1);
  assert.doesNotMatch(JSON.stringify(h.audits),/new ' label|篡改前端草稿|19.0001/u);
  assert.ok(h.statements.filter(s=>s.sql.startsWith('UPDATE')).every(s=>!s.sql.includes("new ' label")));
});

test('外部修改或删除目标行使整批失败，返回冲突行且不覆盖数据',async()=>{
  for(const deleted of [false,true]){
    const h=harness(),opened=await h.open();
    const plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:opened.rows.map(row=>({rowId:row.rowId,values:{label:'batch'}}))});
    h.mutate(rows=>deleted?rows.slice(0,1):rows.map((row,index)=>index===1?[row[0],'external',row[2]]:row));
    const before=structuredClone(h.rows());
    const saved=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
    assert.equal(saved.status,'failed');assert.equal(saved.error.code,'MYSQL_EDIT_CONFLICT');
    assert.deepEqual(saved.error.details.rowIds,[opened.rows[1].rowId]);
    assert.deepEqual(h.rows(),before);
    assert.ok(h.statements.some(s=>s.sql==='ROLLBACK'));
  }
});

test('批量第二行更新失败会回滚第一行，原始数据库错误不进入结果',async()=>{
  let writes=0;
  const h=harness({failure:sql=>{if(sql.startsWith('UPDATE')&&++writes===2)throw new Error('fixture-sensitive-driver-error');}});
  const opened=await h.open(),before=structuredClone(h.rows());
  const plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:opened.rows.map(row=>({rowId:row.rowId,values:{label:'batch'}}))});
  const result=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  assert.equal(result.status,'failed');assert.deepEqual(h.rows(),before);
  assert.doesNotMatch(JSON.stringify(result),/fixture-sensitive-driver-error/u);
});

test('提交阶段中断标记结果不确定，不允许再次执行或新准备保存',async()=>{
  const h=harness({failure:sql=>{if(sql==='COMMIT')throw Object.assign(new Error('fixture'),{code:'ECONNRESET'});}});
  const opened=await h.open(),plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:[{rowId:opened.rows[0].rowId,values:{label:'new'}}]});
  const payload={editId:opened.editId,planId:plan.planId};
  assert.equal((await h.editor.commit('window-a',plugin,payload)).status,'unknown');
  assert.equal((await h.editor.commit('window-a',plugin,payload)).status,'unknown');
  assert.equal(h.statements.filter(s=>s.sql.startsWith('UPDATE')).length,1);
});

test('窗口、作用域、配置、连接、到期与主键篡改均不能越权保存',async()=>{
  const h=harness(),opened=await h.open();
  const changes=[{rowId:opened.rows[0].rowId,values:{label:'new'}}],payload={editId:opened.editId,changes};
  assert.throws(()=>h.editor.prepare('window-b',plugin,payload),{code:'MYSQL_EDIT_STALE'});
  assert.throws(()=>h.editor.prepare('window-a',{...plugin,revision:2},payload),{code:'MYSQL_EDIT_STALE'});
  assert.throws(()=>h.editor.prepare('window-a',{...plugin,environmentId:'other'},payload),{code:'MYSQL_EDIT_STALE'});
  assert.throws(()=>h.editor.prepare('window-a',plugin,{...payload,changes:[{rowId:opened.rows[0].rowId,values:{id:'10'}}]}),{code:'MYSQL_EDIT_COLUMN_READONLY'});
  assert.throws(()=>prepareMysqlEditRequest({...scope,sql:'SELECT * FROM items',database:'other'},'open'),{code:'INVALID_ARGUMENT'});
  h.advance();assert.throws(()=>h.editor.prepare('window-a',plugin,payload),{code:'MYSQL_EDIT_STALE'});
});

test('审计初始写入失败时不开始数据库事务',async()=>{
  const h=harness({auditFailure:true}),opened=await h.open(),plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:[{rowId:opened.rows[0].rowId,values:{label:'new'}}]});
  const result=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  assert.equal(result.status,'failed');assert.equal(h.statements.some(s=>s.sql==='START TRANSACTION'),false);
});

test('保存事务占用插件调度，普通查询不会穿插在开始和提交之间',async()=>{
  const h=harness(),opened=await h.open(),plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:[{rowId:opened.rows[0].rowId,values:{label:'new'}}]});
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  h.gate(async sql=>{if(sql==='START TRANSACTION'){entered();await hold;}});
  const saving=h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  await started;
  const read=h.runtime.querySession(plugin,{sql:'SELECT health_marker'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.statements.some(s=>s.sql==='SELECT health_marker'),false);
  release();
  await Promise.all([saving,read]);
  assert.ok(h.statements.findIndex(s=>s.sql==='SELECT health_marker')>h.statements.findIndex(s=>s.sql==='COMMIT'));
});


test('表结构变化、计划过期和重连都会拒绝旧计划且不写入',async()=>{
  const metadata=structuredClone(schema),h=harness({metadata}),opened=await h.open();
  const plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:[{rowId:opened.rows[0].rowId,values:{label:'new'}}]});
  metadata.columns[1].maxLength=50;
  const result=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  assert.equal(result.error.code,'MYSQL_EDIT_SCHEMA_CHANGED');
  assert.equal(h.statements.some(s=>s.sql.startsWith('UPDATE')),false);
  const other=harness(),snapshot=await other.open();
  const prepared=other.editor.prepare('window-a',plugin,{editId:snapshot.editId,changes:[{rowId:snapshot.rows[0].rowId,values:{label:'new'}}]});
  other.runtime.sessions.set('fixture-project/fixture-environment/fixture-mysql',{connection:{execute:async()=>{throw new Error('不得执行');}}});
  await assert.rejects(other.editor.commit('window-a',plugin,{editId:snapshot.editId,planId:prepared.planId}),{code:'MYSQL_EDIT_STALE'});
  other.runtime.sessions.set('fixture-project/fixture-environment/fixture-mysql',other.session);
  other.advance();
  await assert.rejects(other.editor.commit('window-a',plugin,{editId:snapshot.editId,planId:prepared.planId}),{code:'MYSQL_EDIT_STALE'});
});

test('字段载荷、陌生行、超限批次与未知参数均被拒绝',async()=>{
  const h=harness(),opened=await h.open();
  const change={rowId:opened.rows[0].rowId,values:{label:'new'}};
  for(const changes of [[{...change,rowId:'unknown'}],[{...change,where:'1=1'}],[change,change],Array.from({length:101},()=>change),[{...change,values:{label:'x'.repeat(65537)}}]]) {
    assert.throws(()=>h.editor.prepare('window-a',plugin,{editId:opened.editId,changes}));
  }
  assert.throws(()=>prepareMysqlEditRequest({...scope,editId:opened.editId,planId:crypto.randomUUID(),changes:[change]},'commit'),{code:'INVALID_ARGUMENT'});
  assert.equal(h.statements.some(s=>s.sql.startsWith('UPDATE')),false);
});

test('窗口在事务进行中关闭会回滚，快照不能被恢复后继续使用',async()=>{
  const h=harness(),opened=await h.open(),plan=h.editor.prepare('window-a',plugin,{editId:opened.editId,changes:[{rowId:opened.rows[0].rowId,values:{label:'new'}}]});
  const before=structuredClone(h.rows());
  h.gate(sql=>{if(sql.startsWith('UPDATE'))h.editor.closeOwner('window-a');});
  const result=await h.editor.commit('window-a',plugin,{editId:opened.editId,planId:plan.planId});
  assert.equal(result.status,'failed');
  assert.deepEqual(h.rows(),before);
  assert.ok(h.statements.some(s=>s.sql==='ROLLBACK'));
});

test('唯一索引被列元数据标成 PRI 时，仍拒绝无真实主键表',async()=>{
  const h=harness({primaryNames:[]});
  await assert.rejects(h.open(),{code:'MYSQL_EDIT_READONLY'});
  assert.equal(h.statements.some(s=>s.sql.startsWith('UPDATE')),false);
});
