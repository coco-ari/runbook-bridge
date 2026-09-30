import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DesktopRedisEditor, prepareRedisEditRequest } from '../src/desktop-redis-editor.mjs';
import { RedisEditConnection } from '../src/redis-edit-connection.mjs';
import { RedisWorkspaceReader } from '../src/redis-workspace-reader.mjs';
import { redisProtocolFixture } from './fixtures/redis-workspace-server.mjs';

const scope={projectId:'fixture-project',environmentId:'fixture-env',pluginInstanceId:'fixture-redis'};
const plugin={...scope,revision:1,displayName:'测试 Redis',target:{db:3},patterns:[{patternId:'allowed',pattern:'fixture:*'}],limits:{timeoutMs:1000,maxValueBytes:65536}};
function harness({auditFailure=false,execFailure=false}={}){
  const records=new Map([['fixture:key',{type:'string',value:Buffer.from('original'),ttl:10000}]]),versions=new Map(),calls=[],audits=[];
  let session={},clock=1000;
  const connections=[];
  const runtime={require:()=>session,desktopEditConnection:()=>{
    let watched,version,queued;
    const connection={closed:false,open:async()=>{},close(){this.closed=true;},async command(args){
      if(this.closed)throw new Error('closed');calls.push(args);
      const [command,key]=args,record=records.get(key);
      if(command==='WATCH'){watched=key;version=versions.get(key)??0;return 'OK';}
      if(command==='TYPE')return record?.type??'none';
      if(command==='PTTL')return record?.ttl??-2;
      if(command==='STRLEN')return record?.value.length??0;
      if(command==='GETRANGE')return record?.value.subarray(0,Number(args[3])+1)??Buffer.alloc(0);
      if(command==='MULTI')return 'OK';
      if(command==='SET'||command==='UNLINK'){queued=args;return 'QUEUED';}
      if(command==='EXEC'){
        if(execFailure)throw new Error('fixture-sensitive-network-error');
        if((versions.get(watched)??0)!==version)return null;
        const current=records.get(watched);
        if(queued[0]==='UNLINK'){records.delete(watched);return [current?1:0];}
        if((queued.includes('NX')&&current)||(queued.includes('XX')&&!current))return [null];
        const ttl=queued.includes('KEEPTTL')?current.ttl:queued.includes('PX')?Number(queued.at(-1)):-1;
        records.set(watched,{type:'string',value:Buffer.from(queued[2]),ttl});return ['OK'];
      }
      throw new Error('unexpected command');
    }};
    connections.push(connection);return connection;
  }};
  const editor=new DesktopRedisEditor(runtime,{appendAudit:async(_project,event)=>{audits.push(event);if(auditFailure)throw new Error('fixture-sensitive-audit');}},{now:()=>clock});
  return {editor,records,calls,audits,connections,change:(key,record)=>{if(record)records.set(key,record);else records.delete(key);versions.set(key,(versions.get(key)??0)+1);},reconnect:()=>{session={};},expire:()=>{clock+=2000000;},open:(mode='update',key='fixture:key')=>editor.open('window-a',plugin,{patternId:'allowed',key,mode})};
}
const prepare=(h,session,extra={})=>h.editor.prepare('window-a',plugin,{editId:session.editId,value:'changed',format:'text',expiry:{mode:'keep'},...extra});
const commit=(h,session,plan)=>h.editor.commit('window-a',plugin,{editId:session.editId,planId:plan.planId});

test('Redis 文本修改保留 TTL、精确绑定计划，重复提交不会再次写入',async t=>{
  const h=harness();t.after(()=>h.editor.dispose());const session=await h.open();assert.equal(session.value,'original');
  const plan=prepare(h,session);h.records.get('fixture:key').ttl=9000;
  assert.equal((await commit(h,session,plan)).status,'success');assert.equal(h.records.get('fixture:key').ttl,9000);
  assert.equal((await commit(h,session,plan)).status,'success');assert.equal(h.calls.filter(args=>args[0]==='EXEC').length,1);
  assert.doesNotMatch(JSON.stringify(h.audits),/original|changed/u);
});

test('新增禁止覆盖，支持空字符串、永久与显式有效期',async t=>{
  const h=harness();t.after(()=>h.editor.dispose());await assert.rejects(h.open('create'),{code:'REDIS_KEY_EXISTS'});
  const session=await h.open('create','fixture:new'),plan=prepare(h,session,{value:'',expiry:{mode:'relative',milliseconds:60000}});
  assert.equal((await commit(h,session,plan)).status,'success');assert.equal(h.records.get('fixture:new').value.length,0);assert.equal(h.records.get('fixture:new').ttl,60000);
  const persistent=await h.open(),next=prepare(h,persistent,{expiry:{mode:'persistent'}});await commit(h,persistent,next);assert.equal(h.records.get('fixture:key').ttl,-1);
});

test('并发修改、创建竞争、删除后重建和过期均阻止写入',async t=>{
  for(const mode of ['update','create','delete']){
    const h=harness();t.after(()=>h.editor.dispose());const key=mode==='create'?'fixture:new':'fixture:key',session=await h.open(mode,key);
    const plan=mode==='delete'?h.editor.prepare('window-a',plugin,{editId:session.editId}):prepare(h,session,{expiry:{mode:'persistent'}});
    h.change(key,{type:'string',value:Buffer.from('external'),ttl:-1});
    const result=await commit(h,session,plan);assert.equal(result.error.code,'REDIS_EDIT_CONFLICT');assert.equal(h.records.get(key).value.toString(),'external');
  }
  const h=harness();t.after(()=>h.editor.dispose());const session=await h.open(),plan=prepare(h,session);h.change('fixture:key',null);assert.equal((await commit(h,session,plan)).error.code,'REDIS_EDIT_CONFLICT');
});

test('常用五种类型可单 Key 删除，禁止目录和未登记范围',async t=>{
  for(const type of ['string','hash','list','set','zset']){
    const h=harness();t.after(()=>h.editor.dispose());h.records.get('fixture:key').type=type;
    const session=await h.open('delete'),plan=h.editor.prepare('window-a',plugin,{editId:session.editId});assert.equal((await commit(h,session,plan)).status,'success');assert.equal(h.records.size,0);assert.ok(h.calls.some(args=>args[0]==='UNLINK'));
  }
  const h=harness();t.after(()=>h.editor.dispose());await assert.rejects(h.open('create','outside:key'),{code:'POLICY_DENIED'});
  assert.throws(()=>prepareRedisEditRequest({...scope,patternId:'allowed',key:'fixture:*',mode:'delete',all:true},'open'),{code:'INVALID_ARGUMENT'});
});

test('JSON 校验、二进制与超限值、过期设置和未知字段被拒绝',async t=>{
  const h=harness();t.after(()=>h.editor.dispose());const session=await h.open();
  for(const extra of [{format:'json',value:'{'},{value:'x'.repeat(65537)},{expiry:{mode:'relative',milliseconds:0}},{expiry:{mode:'keep',milliseconds:1}}])assert.throws(()=>prepare(h,session,extra));
  h.records.get('fixture:key').value=Buffer.from([0xff]);await assert.rejects(h.open(),{code:'REDIS_EDIT_READONLY'});
  h.records.get('fixture:key').value=Buffer.alloc(65537,65);await assert.rejects(h.open(),{code:'REDIS_EDIT_READONLY'});
  assert.throws(()=>prepareRedisEditRequest({...scope,editId:session.editId,command:'FLUSHDB'},'prepare'),{code:'INVALID_ARGUMENT'});
});

test('窗口、配置、作用域、连接及会话到期阻止旧授权',async t=>{
  const h=harness();t.after(()=>h.editor.dispose());const session=await h.open();
  assert.throws(()=>h.editor.prepare('other',plugin,{editId:session.editId}),{code:'REDIS_EDIT_STALE'});
  assert.throws(()=>h.editor.prepare('window-a',{...plugin,revision:2},{editId:session.editId}),{code:'REDIS_EDIT_STALE'});
  h.reconnect();assert.throws(()=>prepare(h,session),{code:'REDIS_EDIT_STALE'});
  const next=await h.open();h.expire();assert.throws(()=>prepare(h,next),{code:'REDIS_EDIT_STALE'});
});

test('提交中断只返回不确定状态，审计失败不执行写入，错误正文不泄露',async t=>{
  for(const options of [{execFailure:true},{auditFailure:true}]){
    const h=harness(options);t.after(()=>h.editor.dispose());const session=await h.open(),plan=prepare(h,session),result=await commit(h,session,plan);
    assert.equal(result.status,options.execFailure?'unknown':'failed');assert.doesNotMatch(JSON.stringify(result),/fixture-sensitive/u);
    await commit(h,session,plan);assert.equal(h.calls.filter(args=>args[0]==='EXEC').length,options.execFailure?1:0);
  }
});

test('独立写入连接不扩大只读通道或任意命令入口',()=>{
  const reader=new RedisWorkspaceReader({}),writer=new RedisEditConnection({});reader.ready=true;writer.ready=true;
  assert.throws(()=>reader.command(['SET','fixture:key','value'],Date.now()+1000),{code:'POLICY_DENIED'});
  for(const command of ['FLUSHDB','EVAL','DEL','KEYS','SELECT'])assert.throws(()=>writer.command([command],Date.now()+1000),{code:'POLICY_DENIED'});
});

test('真实 RESP 写入区分服务器拒绝、事务冲突和提交断线，不泄露错误正文',async t=>{
  const cases=[
    {name:'永久 Key 无需 KEEPTTL',ttl:-1,reply:'*1\r\n+OK\r\n',status:'success'},
    {name:'有效期保留',ttl:10000,reply:'*1\r\n+OK\r\n',status:'success'},
    {name:'旧服务端拒绝选项',ttl:10000,reply:'*1\r\n-ERR syntax error private-value\r\n',status:'failed',code:'REDIS_COMMAND_UNSUPPORTED'},
    {name:'写入权限不足',ttl:-1,reply:'*1\r\n-NOPERM private-value\r\n',status:'failed',code:'REDIS_PERMISSION_DENIED'},
    {name:'事务被拒绝',ttl:-1,reply:'-EXECABORT private-value\r\n',status:'failed'},
    {name:'事务冲突',ttl:-1,reply:'*-1\r\n',status:'failed',code:'REDIS_EDIT_CONFLICT'},
    {name:'回复不完整',ttl:-1,reply:'*1\r\n-ERR private-value',status:'unknown'},
    {name:'畸形回复',ttl:-1,reply:'*2\r\n-ERR private-value\r\n+OK\r\n',status:'unknown'},
    {name:'意外单项回复',ttl:-1,reply:'*1\r\n+unexpected\r\n',status:'unknown'},
  ];
  for(const entry of cases)await t.test(entry.name,async t=>{
    const fixture=await redisProtocolFixture((args,socket)=>{
      if(args[0]==='WATCH'||args[0]==='MULTI')return 'OK';
      if(args[0]==='TYPE')return 'string';
      if(args[0]==='PTTL')return entry.ttl;
      if(args[0]==='STRLEN')return 8;
      if(args[0]==='GETRANGE')return 'original';
      if(args[0]==='SET'){
        assert.equal(args.includes('KEEPTTL'),entry.ttl!==-1);
        return 'QUEUED';
      }
      if(args[0]==='EXEC'){socket.end(entry.reply);return;}
      throw new Error('未登记测试命令');
    });
    const session={},audits=[];
    const editor=new DesktopRedisEditor({require:()=>session,desktopEditConnection:()=>new RedisEditConnection({socket:{host:'127.0.0.1',port:fixture.port},database:0})},{appendAudit:async(_project,event)=>audits.push(event)});
    t.after(async()=>{editor.dispose();await fixture.close();});
    const edit=await editor.open('window-a',plugin,{patternId:'allowed',key:'fixture:key',mode:'update'});
    const plan=editor.prepare('window-a',plugin,{editId:edit.editId,value:'changed',format:'text',expiry:{mode:'keep'}});
    const result=await editor.commit('window-a',plugin,{editId:edit.editId,planId:plan.planId});
    assert.equal(result.status,entry.status);
    if(entry.code)assert.equal(result.error.code,entry.code);
    assert.doesNotMatch(JSON.stringify([result,audits]),/private-value|original|changed/u);
    await editor.commit('window-a',plugin,{editId:edit.editId,planId:plan.planId});
    assert.equal(fixture.calls.filter(args=>args[0]==='EXEC').length,1);
  });
});

test('编辑通道认证拒绝不会被当作已连接',async t=>{
  const server=net.createServer(socket=>socket.once('data',()=>socket.end('-WRONGPASS private-value\r\n')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const connection=new RedisEditConnection({socket:{host:'127.0.0.1',port:server.address().port},password:'fixture-only-password',database:0});
  t.after(async()=>{connection.close();await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(connection.open(Date.now()+1000),{code:'AUTHENTICATION_FAILED'});
  assert.equal(connection.ready,false);
});
