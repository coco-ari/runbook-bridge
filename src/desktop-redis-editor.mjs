import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { AppError } from './errors.mjs';
import { findRedisPattern, redisKeyAllowed } from './redis-plugin-runtime.mjs';

const SCOPE=['projectId','environmentId','pluginInstanceId'];
const FIELDS={open:['patternId','key','mode'],prepare:['editId','value','format','expiry'],commit:['editId','planId'],status:['editId','planId'],release:['editId']};
const fail=(code,message)=>new AppError(code,message);
const stale=()=>fail('REDIS_EDIT_STALE','编辑会话已失效，请重新读取并核对内容。');
const conflict=()=>fail('REDIS_EDIT_CONFLICT','Key 已变化或过期，内容未保存。请重新读取并核对。');
const identity=plugin=>JSON.stringify([...SCOPE.map(name=>plugin[name]),plugin.revision,plugin.target.db]);
const text=value=>Buffer.isBuffer(value)?value.toString('utf8'):value;
const MAX_BYTES=65536,MAX_EDITS=24,LIFETIME=1800000,PLAN_MS=120000;

export function prepareRedisEditRequest(payload,operation){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!FIELDS[operation]||Object.keys(payload).some(name=>![...SCOPE,...FIELDS[operation]].includes(name))||SCOPE.some(name=>typeof payload[name]!=='string'||!payload[name]||payload[name].length>128||/[\\/\u0000-\u001f\u007f]/u.test(payload[name]))) throw fail('INVALID_ARGUMENT','Redis 编辑请求参数无效。');
  for(const name of ['editId','planId'].filter(name=>FIELDS[operation].includes(name))) if(typeof payload[name]!=='string'||!/^[a-f0-9-]{36}$/u.test(payload[name])) throw fail('INVALID_ARGUMENT','编辑会话或保存计划无效。');
  if(operation==='open'&&(typeof payload.patternId!=='string'||!payload.patternId||payload.patternId.length>128||typeof payload.key!=='string'||!payload.key||Buffer.byteLength(payload.key)>1024||Buffer.from(payload.key).toString('utf8')!==payload.key||!['create','update','delete'].includes(payload.mode))) throw fail('INVALID_ARGUMENT','请选择有效的 Key、范围和编辑方式。');
  return Object.fromEntries(SCOPE.map(name=>[name,payload[name]]));
}

export class DesktopRedisEditor {
  constructor(runtime,store,{now=Date.now}={}){Object.assign(this,{runtime,store,now});this.edits=new Map();this.opening=0;}
  close(edit){clearTimeout(edit.timer);edit.connection.close();}
  remove(edit){this.close(edit);this.edits.delete(edit.id);}
  closeOwner(owner){for(const edit of this.edits.values())if(edit.owner===owner)this.remove(edit);}
  dispose(){for(const edit of this.edits.values())this.remove(edit);}
  get(owner,plugin,id,{connection=true}={}){
    const edit=this.edits.get(id);
    if(!edit||edit.owner!==owner||edit.identity!==identity(plugin))throw stale();
    if(connection&&(edit.expiresAt<=this.now()||edit.connection.closed||edit.session!==this.runtime.require(plugin)))throw stale();
    return edit;
  }
  release(owner,scope,id){const edit=this.edits.get(id);if(edit?.owner===owner&&SCOPE.every(name=>scope[name]===edit.plugin[name]))this.remove(edit);return {released:true};}
  async open(owner,plugin,payload,assertOwner=()=>{}){
    for(const edit of this.edits.values())if(edit.expiresAt<=this.now()&&edit.plan?.status!=='running')this.remove(edit);
    if(this.edits.size+this.opening>=MAX_EDITS)throw fail('REDIS_EDIT_BUSY','编辑标签数量已达上限，请关闭其他编辑标签。');
    const pattern=findRedisPattern(plugin,payload.patternId);
    if(!redisKeyAllowed(pattern.pattern,payload.key))throw fail('POLICY_DENIED','Key 不在当前允许范围内。');
    const session=this.runtime.require(plugin),connection=this.runtime.desktopEditConnection(plugin);
    this.opening++;
    try{
      const deadline=Date.now()+plugin.limits.timeoutMs;
      await connection.open(deadline);
      const command=args=>connection.command(args,deadline);
      await command(['WATCH',payload.key]);
      const type=text(await command(['TYPE',payload.key]));
      if(payload.mode==='create'&&type!=='none')throw fail('REDIS_KEY_EXISTS','Key 已存在，请更换名称或打开该 Key 编辑。');
      if(payload.mode!=='create'&&type==='none')throw conflict();
      if(payload.mode==='update'&&type!=='string')throw fail('REDIS_EDIT_READONLY','当前仅支持编辑 String 和 JSON 文本。');
      if(payload.mode==='delete'&&!['string','hash','list','set','zset'].includes(type))throw fail('REDIS_EDIT_READONLY','当前类型暂不支持删除。');
      const ttl=await command(['PTTL',payload.key]);
      if(!Number.isSafeInteger(ttl)||ttl < -2)throw stale();
      let value=null;
      const maxBytes=Math.min(MAX_BYTES,plugin.limits.maxValueBytes);
      if(payload.mode==='update'){
        const length=await command(['STRLEN',payload.key]);
        if(!Number.isSafeInteger(length)||length<0||length>maxBytes)throw fail('REDIS_EDIT_READONLY','内容超过编辑大小上限，仅支持查看。');
        const raw=await command(['GETRANGE',payload.key,0,maxBytes]);
        if(!Buffer.isBuffer(raw)||raw.length!==length||!isUtf8(raw)||raw.includes(0))throw fail('REDIS_EDIT_READONLY','内容不是完整 UTF-8 文本或已变化，无法安全编辑。');
        value=raw.toString('utf8');
      }
      assertOwner();if(session!==this.runtime.require(plugin))throw stale();
      const edit={id:crypto.randomUUID(),owner,identity:identity(plugin),plugin:structuredClone(plugin),session,connection,key:payload.key,mode:payload.mode,type,maxBytes,expiresAt:this.now()+LIFETIME,plan:null};
      edit.timer=setTimeout(()=>this.close(edit),LIFETIME);edit.timer.unref?.();this.edits.set(edit.id,edit);
      return {editId:edit.id,key:edit.key,type,value,ttlMilliseconds:ttl,maxBytes,expiresAt:edit.expiresAt};
    }catch(error){connection.close();throw error;}finally{this.opening--;}
  }
  prepare(owner,plugin,payload){
    const edit=this.get(owner,plugin,payload.editId);
    if(edit.plan&&['running','unknown','success'].includes(edit.plan.status))throw fail('REDIS_EDIT_BUSY','请先核实上次保存结果或重新读取。');
    let args;
    if(edit.mode==='delete'){
      if(['value','format','expiry'].some(name=>payload[name]!==undefined))throw fail('INVALID_ARGUMENT','删除操作不能包含新值。');
      args=['UNLINK',edit.key];
    }else{
      if(typeof payload.value!=='string'||Buffer.byteLength(payload.value)>edit.maxBytes||Buffer.from(payload.value).toString('utf8')!==payload.value||payload.value.includes('\0'))throw fail('REDIS_EDIT_VALUE_INVALID','请输入大小限制内的有效 UTF-8 文本。');
      if(!['text','json'].includes(payload.format))throw fail('INVALID_ARGUMENT','内容格式无效。');
      if(payload.format==='json')try{JSON.parse(payload.value);}catch{throw fail('REDIS_EDIT_VALUE_INVALID','JSON 格式无效，请修正后保存。');}
      const expiry=payload.expiry;
      if(!expiry||typeof expiry!=='object'||Array.isArray(expiry)||Object.keys(expiry).some(name=>!['mode','milliseconds'].includes(name))||!['keep','persistent','relative'].includes(expiry.mode)|| (edit.mode==='create'&&expiry.mode==='keep') || (expiry.mode==='relative'? !Number.isSafeInteger(expiry.milliseconds)||expiry.milliseconds<1||expiry.milliseconds>315360000000 : expiry.milliseconds!==undefined))throw fail('INVALID_ARGUMENT','过期设置无效，请输入有效时长。');
      args=['SET',edit.key,payload.value,edit.mode==='create'?'NX':'XX',...(expiry.mode==='keep'?['KEEPTTL']:expiry.mode==='relative'?['PX',String(expiry.milliseconds)]:[])];
    }
    edit.plan={id:crypto.randomUUID(),status:'prepared',args,expiresAt:this.now()+PLAN_MS};
    return {planId:edit.plan.id,editId:edit.id,key:edit.key,type:edit.type,mode:edit.mode,expiresAt:edit.plan.expiresAt};
  }
  publicPlan(plan){return {planId:plan.id,status:plan.status,...(plan.error?{error:plan.error}:{}),...(plan.result?{result:plan.result}:{})};}
  status(owner,plugin,payload){const edit=this.get(owner,plugin,payload.editId,{connection:false});if(edit.plan?.id!==payload.planId)throw stale();return this.publicPlan(edit.plan);}
  async commit(owner,plugin,payload,assertOwner=()=>{}){
    const edit=this.get(owner,plugin,payload.editId,{connection:false}),plan=edit.plan;
    if(plan?.id!==payload.planId)throw stale();
    if(plan.status!=='prepared')return this.publicPlan(plan);
    this.get(owner,plugin,payload.editId);if(plan.expiresAt<=this.now())throw stale();assertOwner();plan.status='running';
    let attempted=false;
    const base={environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,pluginType:'redis',pluginNameSnapshot:plugin.displayName,actor:'user',operationId:plan.id,auditAction:'redis.'+edit.mode,auditTarget:'固定 DB '+plugin.target.db};
    try{
      await this.store.appendAudit(plugin.projectId,{...base,type:'plugin-operation-started',result:'started'});
      const deadline=Date.now()+plugin.limits.timeoutMs;
      const command=args=>edit.connection.command(args,deadline);
      assertOwner();this.get(owner,plugin,edit.id);
      await command(['MULTI']);
      if(text(await command(plan.args))!=='QUEUED')throw fail('REDIS_EDIT_FAILED','Redis 未接受本次写入计划。');
      assertOwner();this.get(owner,plugin,edit.id);attempted=true;
      const result=await command(['EXEC']);
      attempted=false;
      if(result===null || !Array.isArray(result)||result.length!==1 || (edit.mode==='delete'? result[0]!==1:text(result[0])!=='OK'))throw conflict();
      plan.status='success';plan.result={key:edit.key,mode:edit.mode};
    }catch(error){
      plan.status=attempted?'unknown':'failed';
      plan.error=attempted?{code:'REDIS_EDIT_OUTCOME_UNKNOWN',message:'提交期间连接中断，结果不确定。请重新读取核实，勿重复提交。'}:error instanceof AppError?{code:error.code,message:error.message}:{code:'REDIS_EDIT_FAILED',message:'写入失败，请检查连接和账号权限。'};
    }finally{this.close(edit);plan.args=[];}
    const auditFailed=await this.store.appendAudit(plugin.projectId,{...base,type:'plugin-operation',result:plan.status==='success'?'success':plan.status==='unknown'?'unknown':'error',errorCode:plan.error?.code}).then(()=>false,()=>true);
    if(auditFailed&&plan.result)plan.result.auditWarning=true;
    return this.publicPlan(plan);
  }
}
