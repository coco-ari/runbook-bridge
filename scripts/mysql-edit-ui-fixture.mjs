import fs from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// UI 测试仅使用隔离夹具；显式配置测试环境变量时才连接授权的临时 MySQL。
export async function installMysqlEditUiFixture({ipcMain,registeredChannels,plugin,moduleRoot}) {
  const readModule=name=>import(pathToFileURL(path.join(moduleRoot,"src",name)).href);
  const {MysqlPluginRuntime}=await readModule("mysql-plugin-runtime.mjs");
  const {DesktopMysqlEditor}=await readModule("desktop-mysql-editor.mjs");
  const {editableMysqlQuery,mysqlEditProjection}=await readModule("mysql-edit-policy.mjs");
  const {registerMysqlEditIpc}=await readModule("mysql-edit-ipc.mjs");
  let live, connection, rows=Array.from({length:32},(_,index)=>({id:String(9007199254740993n+BigInt(index)),label:'测试记录 '+String(index+1).padStart(2,'0'),optional:index===0?null:'',amount:(index+1)+'.0000',state:'open',quantity:'1',doubled:'2'})),backup;
  const audits=[],writes=[];
  const exportRoot=await fs.mkdtemp(path.join(os.tmpdir(),"mysql-export-ui-"));
  const exportPath=path.join(exportRoot,"selected.sql");
  const names=['id','label','optional','amount','state','quantity','doubled'];
  const types=['bigint unsigned','varchar(100)','text','decimal(20,4)',"enum('open','closed')",'int','int'];
  const schema={table:'orders',columns:names.map((name,i)=>({name,type:types[i],dataType:types[i].split(/[ (]/)[0],key:i===0?'PRI':'',extra:name==='doubled'?'STORED GENERATED':'',nullable:!['id','label','state','quantity'].includes(name),maxLength:name==='label'?100:null,precision:20,scale:name==='amount'?4:0,datetimePrecision:0}))};
  if(process.env.RUNBOOK_MYSQL_TEST_HOST){
    const {createMysqlEditLiveFixture}=await import('./mysql-edit-live-fixture.mjs');
    live=await createMysqlEditLiveFixture();
    plugin.target.database=live.database;
    await live.admin.query("CREATE TABLE orders (id BIGINT UNSIGNED PRIMARY KEY, label VARCHAR(100) NOT NULL, optional TEXT, amount DECIMAL(20,4), state ENUM('open','closed') NOT NULL DEFAULT 'open', quantity INT NOT NULL DEFAULT 1, doubled INT GENERATED ALWAYS AS (quantity*2) STORED) ENGINE=InnoDB");
    for(const row of rows)await live.admin.query('INSERT INTO orders(id,label,optional,amount) VALUES (?,?,?,?)',[row.id,row.label,row.optional,row.amount]);
    connection=await live.connect();
  } else {
    connection={query:async request=>{
      const sql=request.sql,params=request.values??[];
      if(sql.includes('SELECT TABLE_TYPE'))return [[{TABLE_TYPE:'BASE TABLE',ENGINE:'InnoDB'}]];
      if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return [[{COLUMN_NAME:'id'}]];
      if(sql.includes('information_schema.COLUMNS'))return [schema.columns.map(c=>({COLUMN_NAME:c.name,COLUMN_TYPE:c.type,DATA_TYPE:c.dataType,IS_NULLABLE:c.nullable?'YES':'NO',COLUMN_KEY:c.key,COLUMN_DEFAULT:c.name==='state'?'open':c.name==='quantity'?'1':null,EXTRA:c.extra,CHARACTER_MAXIMUM_LENGTH:c.maxLength,NUMERIC_PRECISION:c.precision,NUMERIC_SCALE:c.scale,DATETIME_PRECISION:c.datetimePrecision}))];
      if(sql.includes(' AS effective_grants '))return [[{PRIVILEGE_TYPE:'TRIGGER'}]];
      if(sql.includes('LIMIT 0 FOR UPDATE'))return [[],[]];
      if(sql.includes('information_schema.TRIGGERS')||sql.includes('information_schema.INNODB_FOREIGN'))return [[]];
      if(sql.includes('@@SESSION.sql_mode'))return [[{sqlMode:'STRICT_TRANS_TABLES'}]];
      if(sql==='START TRANSACTION'){backup=structuredClone(rows);return [{}];}
      if(sql==='ROLLBACK'){rows=backup;return [{}];}
      if(sql==='COMMIT'){backup=null;return [{}];}
      if(sql.startsWith('DELETE ')){const previous=rows.length;rows=rows.filter(row=>row.id!==params[0]);writes.push(sql);return [{affectedRows:previous-rows.length,warningStatus:0}];}
      if(sql.startsWith('INSERT ')){
        const selected=[...sql.slice(sql.indexOf(' (')+2,sql.indexOf(') VALUES')).matchAll(/`([^`]+)`/gu)].map(match=>match[1]);
        const row={id:null,label:null,optional:null,amount:null,state:'open',quantity:'1'};
        selected.forEach((name,index)=>{row[name]=params[index];});
        if(rows.some(item=>item.id===row.id))throw new Error('fixture duplicate');
        row.doubled=String(Number(row.quantity)*2);rows.push(row);writes.push(sql);return [{affectedRows:1,warningStatus:0}];
      }
      if(sql.startsWith('UPDATE ')){
        const row=rows.find(row=>row.id===params.at(-1));
        if(!row)return [{affectedRows:0,warningStatus:0}];
        [...sql.matchAll(/\x60([^\x60]+)\x60 = \?/gu)].forEach((match,index)=>{row[match[1]]=params[index];});
        row.doubled=String(Number(row.quantity)*2);writes.push(sql);return [{affectedRows:1,warningStatus:0}];
      }
      let selected,projection;
      if(sql.includes('<=>')){
        selected=rows.filter(row=>row.id===params[0]);
        projection=[...sql.slice(0,sql.indexOf(' FROM')).matchAll(/\x60([^\x60]+)\x60/gu)].map(match=>({source:match[1],name:match[1]}));
      }else{
        const parsed=editableMysqlQuery(sql);projection=mysqlEditProjection(parsed,schema);
        selected=rows.slice();
        const limit=sql.match(/LIMIT\s+(\d+)/iu);
        const offset=Number(sql.match(/OFFSET\s+(\d+)/iu)?.[1]??0);
        if(limit)selected=selected.slice(offset,offset+Number(limit[1]));
      }
      const values=selected.map(row=>projection.map(p=>row[p.source]));
      return [values,projection.map(p=>({name:p.name,orgName:p.source,orgTable:'orders',schema:plugin.target.database}))];
    },destroy(){}};
  }
  if(!live)connection.execute=connection.query;
  const runtime=new MysqlPluginRuntime({closeRelay:async()=>{}},{});
  const session={connection};
  runtime.sessions.set([plugin.projectId,plugin.environmentId,plugin.pluginInstanceId].join('/'),session);
  const editor=new DesktopMysqlEditor(runtime,{appendAudit:async(_project,event)=>{audits.push(event);}});
  const scope=Object.fromEntries(['projectId','environmentId','pluginInstanceId'].map(name=>[name,plugin[name]]));
  const services={isWorkspaceRenderer:()=>true,pickMysqlExportPath:async()=>exportPath,v2Service:{mysqlEditor:editor,invokeDesktopMysqlEdit:async(owner,payload,operation,assertOwner)=>{
    assert.deepEqual(Object.fromEntries(Object.keys(scope).map(key=>[key,payload[key]])),scope);
    if(operation==='release')return editor.release(owner,scope,payload.editId);
    return editor[operation](owner,plugin,payload,assertOwner);
  }}};
  for(const operation of ['open','row','prepare','commit','status','release']){
    const channel='v2:mysql-edit-'+operation;ipcMain.removeHandler(channel);registeredChannels.add(channel);
  }
  ipcMain.removeHandler('v2:mysql-export-save');registeredChannels.add('v2:mysql-export-save');
  registerMysqlEditIpc(ipcMain,services);
  const handler=(channel,action)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,async(_event,payload)=>({ok:true,data:await action(payload)}));};
  handler('v2:mysql-list-tables',()=>({tables:[{name:'orders',type:'BASE TABLE',queryable:true}],nextCursor:null,truncated:false}));
  handler('v2:mysql-describe-table',()=>({table:'orders',columns:schema.columns}));
  const read=async sql=>{
    const snapshot=await editor.open('fixture-read',plugin,{sql});
    editor.closeOwner('fixture-read');
    return {rows:snapshot.rows.map(row=>row.values),columns:snapshot.columns.map(column=>({name:column.name,table:'orders',type:253})),rowCount:snapshot.rows.length,bytes:2000,truncated:false,durationMs:3,limitsApplied:plugin.limits};
  };
  handler('v2:mysql-query-readonly',payload=>read(payload.sql));
  handler('v2:mysql-preview-table',payload=>read('SELECT * FROM orders ORDER BY id LIMIT '+(payload.limit??20)+' OFFSET '+(payload.offset??0)));
  return {
    editor,audits,writes,live:Boolean(live),
    readExport:()=>fs.readFile(exportPath,"utf8"),
    read:async()=>live?(await live.admin.query({sql:'SELECT id,label,optional,amount,state FROM orders ORDER BY id',bigNumberStrings:true}))[0].map(row=>({...row})):structuredClone(rows),
    external:async(id,label)=>{if(live)await live.admin.query('UPDATE orders SET label=? WHERE id=?',[label,id]);else rows.find(row=>row.id===id).label=label;},
    close:async()=>{await fs.rm(exportRoot,{recursive:true,force:true});editor.closeOwner('fixture-read');if(live)await live.close();},
  };
}
