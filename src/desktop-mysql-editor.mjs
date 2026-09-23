import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { applyMysqlRowLimit } from './mysql-policy.mjs';
import { mysqlRuntimeInternals } from './mysql-plugin-runtime.mjs';
import { editableMysqlQuery, mysqlEditProjection, mysqlEditHash, mysqlEditError, normalizeMysqlEditValue, quoteMysqlName, MYSQL_EDIT_LIMITS as LIMIT } from './mysql-edit-policy.mjs';

const SCOPE = ['projectId','environmentId','pluginInstanceId'];
const FIELDS = {open:['sql','params'],prepare:['editId','changes'],commit:['editId','planId'],status:['editId','planId'],release:['editId']};
const identity = plugin => JSON.stringify([...SCOPE.map(field=>plugin[field]),plugin.revision,plugin.target.database]);
const fail = (code,message,details) => new AppError(code,message,details);
const stale = () => fail('MYSQL_EDIT_STALE','编辑数据已过期或连接已变化，请重新加载。');
const visible = value => value === null ? null : typeof value === 'string' ? value : Buffer.isBuffer(value) ? '[二进制数据]' : '[不支持编辑的值]';
// 编辑读取保留数字、JSON 和日期的原始文本，避免经过 JS 数值及日期对象丢失精度。
const cloneValues = values => values.map(value=>Buffer.isBuffer(value)?Buffer.from(value):value);
const rawOptions = (projection, aliases = true) => {
  const columns = new Map(projection.map(item=>[aliases?item.name:item.source,item.column]));
  return {rowsAsArray:true,supportBigNumbers:true,bigNumberStrings:true,typeCast:(field,next)=>{
    const type=columns.get(field.name)?.dataType;
    if(['binary','varbinary','tinyblob','blob','mediumblob','longblob','geometry','bit'].includes(type))return field.buffer();
    if (['tinyint','smallint','mediumint','int','integer','bigint','float','double','real','year'].includes(type)) {
      const value=next();return value === null ? null : String(value);
    }
    return type==='json'?field.string('utf8'):field.string();
  }};
};

export function prepareMysqlEditRequest(payload, operation) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !FIELDS[operation]
    || Object.keys(payload).some(field=>![...SCOPE,...FIELDS[operation]].includes(field))) throw fail('INVALID_ARGUMENT','数据库编辑请求包含无效参数。');
  for (const field of SCOPE) if (typeof payload[field] !== 'string' || !payload[field].trim() || payload[field].length>128 || /[\u0000-\u001f\u007f]/u.test(payload[field])) throw fail('INVALID_ARGUMENT','数据库编辑作用域无效。');
  for (const field of ['editId','planId'].filter(field=>FIELDS[operation].includes(field))) if (typeof payload[field] !== 'string' || !/^[a-f0-9-]{36}$/u.test(payload[field])) throw fail('INVALID_ARGUMENT','编辑会话或保存计划无效。');
  if (operation === 'open' && (typeof payload.sql !== 'string' || Buffer.byteLength(payload.sql)>65536)) throw fail('INVALID_ARGUMENT','编辑查询无效。');
  return Object.fromEntries(SCOPE.map(field=>[field,payload[field]]));
}

async function readSchema(query, plugin, table) {
  const [tables] = await query('SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [plugin.target.database,table]);
  if (tables.length !== 1 || tables[0].TABLE_TYPE !== 'BASE TABLE' || String(tables[0].ENGINE).toLowerCase() !== 'innodb') throw mysqlEditError('仅支持可通过 InnoDB 事务保存的基础表。');
  const [rows] = await query('SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 4097',[plugin.target.database,table]);
  if (!rows.length || rows.length>4096) throw mysqlEditError('表结构为空或超出编辑上限。');
  // 列标记可能把无主键表的唯一索引显示成 PRI，必须从约束元数据确认真正主键。
  const [primary] = await query("SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION LIMIT 17",[plugin.target.database,table]);
  if (!primary.length || primary.length>16) throw mysqlEditError('仅支持具有明确主键的数据表；唯一索引不能代替主键。');
  const primaryNames=new Set(primary.map(row=>row.COLUMN_NAME));
  const columns = rows.map(row=>({name:row.COLUMN_NAME,type:row.COLUMN_TYPE,dataType:row.DATA_TYPE.toLowerCase(),nullable:row.IS_NULLABLE === 'YES',key:primaryNames.has(row.COLUMN_NAME)?'PRI':row.COLUMN_KEY==='PRI'?'':row.COLUMN_KEY,extra:row.EXTRA??'',
    maxLength:row.CHARACTER_MAXIMUM_LENGTH === null ? null : Number(row.CHARACTER_MAXIMUM_LENGTH),
    precision:Number(row.NUMERIC_PRECISION),scale:Number(row.NUMERIC_SCALE),datetimePrecision:Number(row.DATETIME_PRECISION)}));
  return {table,columns};
}

export class DesktopMysqlEditor {
  constructor(runtime, store, {now=Date.now}={}) { Object.assign(this,{runtime,store,now}); this.edits=new Map(); }
  prune() {
    for(const [id,edit] of this.edits) if(edit.expiresAt<=this.now() && ![...edit.plans.values()].some(plan=>plan.status === 'running')) this.edits.delete(id);
  }
  closeOwner(owner) { for(const [id,edit] of this.edits) if(edit.owner === owner) this.edits.delete(id); }
  get(owner,plugin,id,{connection=true}={}) {
    this.prune();
    const edit=this.edits.get(id);
    if(!edit || edit.owner!==owner || edit.identity!==identity(plugin) || (connection && edit.session!==this.runtime.require(plugin))) throw stale();
    return edit;
  }
  release(owner,scope,id) {
    const edit=this.edits.get(id);
    if(edit && edit.owner === owner && SCOPE.every(field=>edit.plugin[field]===scope[field])) this.edits.delete(id);
    return {released:true};
  }
  publicEdit(edit) {
    return {editId:edit.id,table:edit.table,expiresAt:edit.expiresAt,limits:{maxRows:LIMIT.rows,maxCells:LIMIT.cells},
      columns:edit.projection.map(item=>({name:item.name,source:item.source,type:item.column.type,dataType:item.column.dataType,nullable:item.column.nullable,primary:item.column.key === 'PRI',editable:item.editable,reason:item.reason??null})),
      rows:[...edit.rows.values()].map(row=>({rowId:row.id,values:Object.fromEntries(edit.projection.map((column,index)=>[column.name,visible(row.values[index])]))})),
      truncated:edit.truncated};
  }
  async open(owner,plugin,payload,assertOwner=()=>{}) {
    this.prune();
    if(this.edits.size>=LIMIT.snapshots) throw fail('MYSQL_EDIT_BUSY','编辑标签数量已达上限，请先关闭其他编辑标签。');
    const selected=editableMysqlQuery(payload.sql);
    const params=mysqlRuntimeInternals.normalizeParams(payload.params);
    const result=await this.runtime.desktopEditSession(plugin,null,async(query,session)=>{
      const schema=await readSchema(query,plugin,selected.table);
      const projection=mysqlEditProjection(selected,schema);
      if(!projection.some(column=>column.editable)) throw mysqlEditError('查询结果没有可修改的字段。');
      const maximum=Math.min(1000,plugin.limits.maxRows);
      const [rows,fields]=await query(applyMysqlRowLimit(selected,maximum),params,rawOptions(projection));
      if(fields.length!==projection.length || fields.some((field,index)=>field.name!==projection[index].name || field.orgName!==projection[index].source || field.orgTable!==selected.table || (field.schema??field.db)!==plugin.target.database)) throw mysqlEditError('结果字段来源无法可靠确认，请使用简单单表查询。');
      if(Buffer.byteLength(JSON.stringify(rows))>Math.min(LIMIT.snapshotBytes,plugin.limits.maxBytes)) throw fail('RESULT_LIMIT_EXCEEDED','编辑结果超过大小上限，请缩小查询范围。');
      assertOwner();
      const keys=projection.map((column,index)=>column.column.key === 'PRI' ? index : -1).filter(index=>index>=0);
      const captured=new Map(),seen=new Set();
      for(const values of rows.slice(0,maximum)){
        if(values.length!==projection.length || keys.some(index=>typeof values[index]!=='string')) throw mysqlEditError('结果主键无法无损识别。');
        const signature=mysqlEditHash(keys.map(index=>values[index]));
        if(seen.has(signature)) throw mysqlEditError('查询出现重复主键，无法可靠编辑。');
        seen.add(signature);
        const id=crypto.randomUUID();
        captured.set(id,{id,values:cloneValues(values),signature});
      }
      return {id:crypto.randomUUID(),owner,identity:identity(plugin),plugin:structuredClone(plugin),session,table:selected.table,schema,projection,keys,rows:captured,plans:new Map(),expiresAt:this.now()+LIMIT.lifetimeMs,truncated:rows.length>maximum};
    });
    assertOwner();
    if(this.edits.size>=LIMIT.snapshots) throw fail('MYSQL_EDIT_BUSY','编辑标签数量已达上限。');
    this.edits.set(result.id,result);
    const auditWarning=await this.store.appendAudit(plugin.projectId,{environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,pluginType:"mysql",pluginNameSnapshot:plugin.displayName,actor:"user",operationId:crypto.randomUUID(),type:"plugin-operation",auditAction:"mysql.select",auditTarget:"固定数据库 "+plugin.target.database+" · 表 "+result.table,rowCount:result.rows.size,truncated:result.truncated,result:"success"}).then(()=>false,()=>true);
    assertOwner();
    return {...this.publicEdit(result),...(auditWarning?{auditWarning:true}:{})};
  }
  prepare(owner,plugin,payload) {
    const edit=this.get(owner,plugin,payload.editId);
    if([...edit.plans.values()].some(plan=>plan.status==='running'||plan.status==='unknown')) throw fail('MYSQL_EDIT_BUSY','上次保存尚未结束或结果不确定，请先核实。');
    if(!Array.isArray(payload.changes)||!payload.changes.length||payload.changes.length>LIMIT.rows||Buffer.byteLength(JSON.stringify(payload.changes))>LIMIT.changeBytes) throw fail('INVALID_ARGUMENT','每次最多保存 100 行，修改内容不能超过 256 KiB。');
    const seen=new Set(),changes=[];
    let cells=0;
    for(const input of payload.changes){
      if(!input || typeof input!=='object' || Object.keys(input).some(key=>!['rowId','values'].includes(key)) || typeof input.rowId!=='string' || !input.values || typeof input.values!=='object' || Array.isArray(input.values)) throw fail('INVALID_ARGUMENT','修改行格式无效。');
      const row=edit.rows.get(input.rowId);
      if(!row||seen.has(row.id)) throw fail('INVALID_ARGUMENT','修改行不存在或重复。');
      seen.add(row.id);
      const values=[];
      for(const [name,value] of Object.entries(input.values)){
        const index=edit.projection.findIndex(column=>column.name===name);
        if(index<0) throw fail('MYSQL_EDIT_COLUMN_READONLY','字段不属于当前查询。');
        const column=edit.projection[index];
        let normalized;
        try { normalized=normalizeMysqlEditValue(column.column,value); }
        catch (error) {
          if (error instanceof AppError) throw fail(error.code,"字段 "+column.name+"："+error.message,{column:column.name,rowIds:[row.id]});
          throw error;
        }
        if(normalized!==row.values[index]) values.push({index,name,source:column.source,value:normalized,original:visible(row.values[index])});
      }
      cells+=values.length;
      if(values.length) changes.push({rowId:row.id,signature:row.signature,values,originalHash:mysqlEditHash(row.values)});
    }
    if(!changes.length) throw fail('MYSQL_EDIT_NO_CHANGES','没有需要保存的修改。');
    if(cells>LIMIT.cells) throw fail('INVALID_ARGUMENT','单次修改的字段数量超出上限。');
    for(const [id,plan] of edit.plans) if(plan.status==='prepared'||edit.plans.size>=5) edit.plans.delete(id);
    const plan={id:crypto.randomUUID(),status:'prepared',changes:structuredClone(changes).sort((a,b)=>a.signature.localeCompare(b.signature)),expiresAt:this.now()+LIMIT.planMs};
    edit.plans.set(plan.id,plan);
    return {planId:plan.id,editId:edit.id,table:edit.table,rowCount:changes.length,cellCount:cells,expiresAt:plan.expiresAt,
      changes:changes.map(change=>({rowId:change.rowId,keys:Object.fromEntries(edit.keys.map(index=>[edit.projection[index].name,visible(edit.rows.get(change.rowId).values[index])])),values:change.values.map(({name,original,value})=>({name,original,value}))}))};
  }
  status(owner,plugin,payload) {
    const edit=this.get(owner,plugin,payload.editId,{connection:false}),plan=edit.plans.get(payload.planId);
    if(!plan) throw stale();
    return this.publicPlan(plan);
  }
  publicPlan(plan) { return {planId:plan.id,status:plan.status,...(plan.result?{result:plan.result}:{}),...(plan.error?{error:plan.error}:{})}; }
  async commit(owner,plugin,payload,assertOwner=()=>{}) {
    const edit=this.get(owner,plugin,payload.editId,{connection:false}),plan=edit.plans.get(payload.planId);
    if(!plan) throw stale();
    if(plan.status!=='prepared') return this.publicPlan(plan);
    if(plan.expiresAt<=this.now()) throw stale();
    this.get(owner,plugin,payload.editId);
    assertOwner();
    plan.status='running';
    const operationId=plan.id;
    const base={environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,pluginType:'mysql',pluginNameSnapshot:plugin.displayName,actor:'user',operationId,auditAction:'mysql.update',auditTarget:'固定数据库 '+plugin.target.database+' · 表 '+edit.table,
      changedColumns:[...new Set(plan.changes.flatMap(change=>change.values.map(value=>value.source)))],requestedRows:plan.changes.length};
    let attemptedCommit=false,started=false;
    const startedAt=this.now();
    try {
      await this.store.appendAudit(plugin.projectId,{...base,type:'plugin-operation-started',result:'started'});
      const fresh=await this.runtime.desktopEditSession(plugin,edit.session,async query=>{
        const assertActive=()=>{assertOwner();this.get(owner,plugin,edit.id);};
        const select=edit.projection.map(column=>quoteMysqlName(column.source)).join(',');
        const table=quoteMysqlName(plugin.target.database)+'.'+quoteMysqlName(edit.table);
        const where=edit.keys.map(index=>quoteMysqlName(edit.projection[index].source)+' <=> ?').join(' AND ');
        const fetch=async(row,lock=false)=>{
          const [found]=await query('SELECT '+select+' FROM '+table+' WHERE '+where+' LIMIT 2'+(lock?' FOR UPDATE':''),edit.keys.map(index=>row.values[index]),rawOptions(edit.projection,false));
          return found;
        };
        assertActive();
        const [[mode]]=await query('SELECT @@SESSION.sql_mode AS sqlMode');
        if(!/(?:^|,)STRICT_(?:TRANS|ALL)_TABLES(?:,|$)/u.test(mode.sqlMode??'')) throw mysqlEditError('当前连接未启用严格 SQL 模式，请启用后再编辑，避免数据库静默截断字段值。');
        try {
          await query('START TRANSACTION');started=true;
          const locked=new Map();
          for(const change of plan.changes){
            assertActive();
            const row=edit.rows.get(change.rowId);
            if(!row || mysqlEditHash(row.values)!==change.originalHash) throw stale();
            const found=await fetch(row,true);
            if(found.length!==1 || mysqlEditHash(found[0])!==change.originalHash) throw fail('MYSQL_EDIT_CONFLICT','数据已被修改或删除，本批修改未保存。请重新加载并核对。',{rowIds:[change.rowId]});
            locked.set(change.rowId,row);
          }
          const currentSchema=await readSchema(query,plugin,edit.table);
          if(mysqlEditHash(currentSchema)!==mysqlEditHash(edit.schema)) throw fail('MYSQL_EDIT_SCHEMA_CHANGED','表结构已变化，本批修改未保存。');
          for(const change of plan.changes){
            assertActive();
            const row=locked.get(change.rowId);
            const [result]=await query('UPDATE '+table+' SET '+change.values.map(value=>quoteMysqlName(value.source)+' = ?').join(',')+' WHERE '+where,
              [...change.values.map(value=>value.value),...edit.keys.map(index=>row.values[index])]);
            if(result.affectedRows!==1 || result.warningStatus>0) throw fail('MYSQL_EDIT_WRITE_MISMATCH','数据库返回了非预期的更新结果，本批修改已撤销。',{rowIds:[change.rowId]});
          }
          const updated=[];
          for(const change of plan.changes){
            const found=await fetch(locked.get(change.rowId));
            if(found.length!==1) throw fail('MYSQL_EDIT_WRITE_MISMATCH','更新后无法确认目标行，本批修改已撤销。');
            updated.push({rowId:change.rowId,values:found[0]});
          }
          assertActive();
          attemptedCommit=true;
          await query('COMMIT');started=false;
          return updated;
        } catch(error) {
          if(started&&!attemptedCommit){
            try {await query('ROLLBACK');started=false;} catch {
              await this.runtime.invalidateSession(plugin,edit.session,fail('ROUTE_UNAVAILABLE','编辑事务已中断。'));
            }
          }
          throw error;
        }
      });
      for(const item of fresh) edit.rows.get(item.rowId).values=cloneValues(item.values);
      edit.expiresAt=this.now()+LIMIT.lifetimeMs;
      plan.status='success';
      plan.result={rowCount:plan.changes.length,rows:fresh.map(item=>({rowId:item.rowId,values:Object.fromEntries(edit.projection.map((column,index)=>[column.name,visible(item.values[index])]))}))};
    } catch(error) {
      plan.status=attemptedCommit?'unknown':'failed';
      plan.error=error instanceof AppError?{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}:{code:'MYSQL_EDIT_FAILED',message:'保存失败，本批修改未提交。请检查账号写入权限、字段约束及连接状态。'};
      if(attemptedCommit){
        plan.error={code:'MYSQL_EDIT_OUTCOME_UNKNOWN',message:'提交期间连接中断，保存结果不确定。请重新查询核实，勿重复提交。'};
        await this.runtime.invalidateSession(plugin,edit.session,fail('ROUTE_UNAVAILABLE','提交结果不确定。'));
      }
    }
    const auditFailed=await this.store.appendAudit(plugin.projectId,{...base,type:'plugin-operation',...(plan.status==='success'?{affectedRows:plan.changes.length}:{}),result:plan.status==='success'?'success':plan.status==='unknown'?'unknown':'error',errorCode:plan.error?.code,durationMs:this.now()-startedAt}).then(()=>false,()=>true);
    if(auditFailed&&plan.result)plan.result.auditWarning=true;
    return this.publicPlan(plan);
  }
}
