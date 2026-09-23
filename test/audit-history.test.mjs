import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceStore, workspaceInternals } from '../src/workspace-store.mjs';
import { auditActor, auditExecutionContext, auditOutcome, operationAuditMetadata, presentAuditEvent, safeAuditText } from '../src/audit-record.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-audit-history-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new WorkspaceStore(root);
  await store.init();
  const project = await store.createProject({name:'测试记录',environmentName:'测试环境'});
  const [environment] = await store.listEnvironments(project.projectId);
  const base = {projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:'test-server',pluginType:'server',pluginNameSnapshot:'测试服务器',actor:'agent',capability:'fs.find'};
  const file = path.join(store.projectDir(project.projectId),'audit','operations-v3.jsonl');
  const write = async entries => { await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,entries.map(entry => JSON.stringify({...base,...entry})).join('\n') + '\n'); };
  const list = filters => store.listAudit(project.projectId,{environmentId:base.environmentId,view:'operations',...filters});
  return {store,base,file,write,list};
}

test('来源以显式操作者为准，缺失来源和结果均不猜测', () => {
  assert.equal(auditActor({actor:'user',type:'plugin-operation'}),'user');
  assert.equal(auditActor({origin:'agent',type:'docker-read'}),'agent');
  assert.equal(auditActor({source:'desktop-human'}),'user');
  assert.equal(auditActor({type:'plugin-operation'}),'unknown');
  assert.equal(auditOutcome({result:'started'}),'unknown');
  assert.equal(auditOutcome({result:'future-status'}),'unknown');
  assert.equal(presentAuditEvent({type:'plugin-connection-updated',actor:'user',result:'success'}).category,'configuration');
  assert.equal(auditOutcome({type:'server-metrics-status',result:'system:ready'}),'success');
  assert.equal(auditOutcome({type:'server-metrics-stop',result:'paused'}),'stopped');
  assert.equal(presentAuditEvent({type:'desktop-upload',pluginInstanceId:'exists',operation:{remotePath:'/test/release.zip'}}).pluginNameSnapshot,'插件名称未记录');
});

test('动作摘要区分日志与数据库子操作，只提取允许的元数据', () => {
  const plugin = {pluginType:'server',displayName:'测试服务器'};
  assert.equal(operationAuditMetadata(plugin,'logs',{operation:'list'}).auditAction,'logs.list');
  assert.equal(operationAuditMetadata(plugin,'logs',{operation:'search'}).auditAction,'logs.search');
  assert.equal(operationAuditMetadata(plugin,'logs',{}).auditAction,'logs.read');
  assert.equal(operationAuditMetadata(plugin,'service.control',{action:'restart',unit:'fixture.service'}).auditAction,'service.restart');
  const data = operationAuditMetadata({pluginType:'mysql',displayName:'测试数据库',target:{database:'fixture'}},'select',{sql:'secret-sql-marker',params:['parameter-marker']},'previewTable');
  assert.equal(data.auditAction,'mysql.preview');
  assert.doesNotMatch(JSON.stringify(data),/secret-sql-marker|parameter-marker/u);
  const shell = presentAuditEvent({type:'confirmation-approved',capability:'shell.execute',operationSummary:'执行 Shell：token=legacy-marker'});
  assert.equal(shell.target,'');
  assert.doesNotMatch(safeAuditText('password="spaced secret" https://user:pass@example.invalid token secret=fixture'),/spaced secret|user:pass|secret=fixture/u);
});

test('新操作有独立执行标识，审批过程与执行结果合并且用户参与筛选有效', async t => {
  const {write,list} = await fixture(t);
  await write([
    {type:'plugin-operation-decision',confirmationId:'approval-one',result:'pending-confirmation',time:'2026-09-23T01:00:00Z',capability:'service.control',auditAction:'service.restart',auditTarget:'fixture.service'},
    {type:'confirmation-approved',confirmationId:'approval-one',actor:'user',result:'success',time:'2026-09-23T01:00:05Z'},
    {type:'plugin-operation-started',confirmationId:'approval-one',operationId:'execution-one',result:'started',time:'2026-09-23T01:00:06Z',capability:'service.control',auditAction:'service.restart'},
    {type:'plugin-operation',confirmationId:'approval-one',operationId:'execution-one',result:'error',errorCode:'SERVICE_CONTROL_FAILED',durationMs:2000,time:'2026-09-23T01:00:08Z',capability:'service.control',auditAction:'service.restart'},
  ]);
  const page = await list({actor:'user'});
  assert.equal(page.entries.length,1);
  const operation = page.entries[0];
  assert.equal(operation.title,'重启服务');
  assert.equal(operation.actor,'agent');
  assert.equal(operation.result,'error');
  assert.equal(operation.approval,'approved');
  assert.equal(operation.durationMs,2000);
  assert.deepEqual(operation.timeline.map(event => event.actor),['agent','user','agent','agent']);
  assert.equal((await list({actor:'system'})).entries.length,0);
});

test('跨窗口分页保持完整过程，新追加记录不造成重复或遗漏', async t => {
  const {write,list,store,base} = await fixture(t);
  const entries = [{type:'plugin-operation-started',operationId:'long-operation',result:'started',time:'2026-09-22T01:00:00Z'}];
  for (let index = 0; index < 530; index++) entries.push({type:'plugin-operation',operationId:`op-${index}`,result:'success',auditTarget:`/fixture/file-${index}`,time:'2026-09-23T01:00:00Z'});
  entries.push({type:'plugin-operation',operationId:'long-operation',result:'success',time:'2026-09-23T02:00:00Z'});
  await write(entries);
  const first = await list({limit:50});
  assert.equal(first.entries[0].eventCount,2);
  assert.equal(first.entries[0].timeline[0].phase,'开始执行');
  await store.appendAudit(base.projectId,{...base,type:'plugin-operation',operationId:'new-after-snapshot',result:'success'});
  const all = [...first.entries];
  let cursor = first.nextCursor;
  for (let guard = 0; cursor && guard < 20; guard++) { const page = await list({limit:50,cursor}); all.push(...page.entries); cursor = page.nextCursor; }
  assert.equal(cursor,null);
  assert.equal(all.length,531);
  assert.equal(new Set(all.map(entry => entry.auditId)).size,531);
  assert.equal(all.filter(entry => entry.eventCount === 2).length,1);
  const search = await list({query:'file-0'});
  assert.equal(search.entries.length,1);
  assert.equal(search.entries[0].target,'/fixture/file-0');
});

test('并发或重用旧请求标识不强行合并，不同作用域互不关联', async t => {
  const {write,list} = await fixture(t);
  await write([
    {type:'plugin-operation-started',requestId:'legacy',result:'started'},
    {type:'plugin-operation-started',requestId:'legacy',result:'started'},
    {type:'plugin-operation',requestId:'legacy',result:'success'},
    {type:'plugin-operation',requestId:'legacy',result:'error'},
    {type:'plugin-operation-started',operationId:'unique-one',requestId:'same-input',result:'started'},
    {type:'plugin-operation-started',operationId:'unique-two',requestId:'same-input',result:'started'},
    {type:'plugin-operation',operationId:'unique-one',requestId:'same-input',result:'success'},
    {type:'plugin-operation',operationId:'unique-two',requestId:'same-input',result:'error'},
    {type:'plugin-operation',environmentId:'other-environment',operationId:'unique-one',result:'error'},
  ]);
  const page = await list({});
  assert.equal(page.entries.length,6);
  assert.deepEqual(page.entries.slice(0,2).map(entry => entry.eventCount),[2,2]);
  assert.ok(page.entries.slice(2).every(entry => entry.eventCount === 1));
});

test('分页游标绑定筛选与作用域，清除记录后拒绝旧游标', async t => {
  const {write,list,store,base} = await fixture(t);
  await write(Array.from({length:4},(_,i) => ({type:'runbook-updated',result:'success',actor:'user',operationId:`single-${i}`})));
  const page = await list({limit:1});
  assert.ok(page.nextCursor);
  await assert.rejects(list({cursor:page.nextCursor,actor:'agent'}),{code:'AUDIT_CURSOR_STALE'});
  await assert.rejects(list({cursor:page.nextCursor,pluginInstanceId:'other-plugin'}),{code:'AUDIT_CURSOR_STALE'});
  await store.clearAudit(base.projectId,{environmentId:base.environmentId});
  await assert.rejects(list({cursor:page.nextCursor}),{code:'AUDIT_CURSOR_STALE'});
});

test('只有当前进程仍在运行的操作显示进行中，审批批准不等于执行成功', async t => {
  const {store,base,list} = await fixture(t);
  await store.appendAudit(base.projectId,{...base,type:'plugin-operation-started',operationId:'active',result:'started'});
  assert.equal((await list({})).entries[0].result,'running');
  await store.appendAudit(base.projectId,{...base,type:'plugin-operation',operationId:'active',result:'success'});
  assert.equal((await list({})).entries[0].result,'success');
  await store.appendAudit(base.projectId,{...base,type:'confirmation-approved',confirmationId:'pending-execution',actor:'user',result:'success',expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal((await list({})).entries[0].result,'approved');
});

test('会话状态按语义展示，长过程的内存和返回内容有界', async t => {
  const {write,list} = await fixture(t);
  await write([
    {type:'server-metrics-start',sessionId:'monitor',actor:'user',result:'started'},
    ...Array.from({length:100},() => ({type:'server-metrics-status',sessionId:'monitor',actor:'system',result:'system:ready'})),
    {type:'server-metrics-stop',sessionId:'monitor',actor:'user',result:'paused'},
  ]);
  const [operation] = (await list({})).entries;
  assert.equal(operation.result,'stopped');
  assert.equal(operation.title,'查看服务器资源监控');
  assert.equal(operation.actor,'user');
  assert.equal(operation.timeline.length,64);
  assert.equal(operation.timeline[0].phase,'开启资源监控');
  assert.equal(operation.eventCount,102);
  assert.equal(operation.timelineTruncated,true);
});

test('反向读取的位置支持中文跨块、坏行与分页边界', async t => {
  const {write,file} = await fixture(t);
  await write([{type:'runbook-updated',auditTarget:'中文目标'},{type:'runbook-updated',auditTarget:'第二项'}]);
  const rows = [];
  for await (const row of workspaceInternals.readLinesReverse(file,{withOffset:true,chunkBytes:7})) rows.push(row);
  assert.equal(rows.length,2);
  assert.equal(JSON.parse(rows[0].line).auditTarget,'第二项');
  const earlier = [];
  for await (const row of workspaceInternals.readLinesReverse(file,{withOffset:true,endPosition:rows[0].offset,chunkBytes:7})) earlier.push(row);
  assert.equal(earlier.length,1);
  assert.equal(JSON.parse(earlier[0].line).auditTarget,'中文目标');
});

test('父操作关联仅传播到相同作用域的执行事件，后台断连不会继承旧发起方', async t => {
  const {store,base,list} = await fixture(t);
  const parent = {...base,operationId:'parent-operation',auditAction:'service.inspect',auditTarget:'fixture.service'};
  await store.appendAudit(base.projectId,{...parent,type:'plugin-operation-started',result:'started'});
  await auditExecutionContext.run(parent,async () => {
    await store.appendAudit(base.projectId,{...base,actor:undefined,type:'execute',operationId:'child-operation',result:'success'});
    await store.appendAudit(base.projectId,{...base,actor:undefined,type:'execute',pluginInstanceId:'different-server',operationId:'separate-operation',result:'success'});
    await store.appendAudit(base.projectId,{...base,actor:undefined,capability:undefined,type:'disconnect',reason:'connection-lost',result:'connection-lost'});
  });
  const pending = (await list({pluginInstanceId:base.pluginInstanceId})).entries;
  assert.equal(pending.find(entry => entry.title === '查看服务状态').result,'running');
  assert.equal(pending.find(entry => entry.title === '断开服务器').actor,'system');
  await store.appendAudit(base.projectId,{...parent,type:'plugin-operation',result:'success'});
  assert.equal((await list({pluginInstanceId:base.pluginInstanceId})).entries.find(entry => entry.title === '查看服务状态').eventCount,3);
});

test('等待人工确认不显示为错误，审批过期与来源缺失有明确语义', async t => {
  const {write,list} = await fixture(t);
  await write([
    {type:'plugin-operation-decision',confirmationId:'pending',result:'pending-confirmation',errorCode:'CONFIRMATION_REQUIRED'},
    {type:'confirmation-approved',confirmationId:'approved-only',actor:'user',result:'success',expiresAt:'2000-01-01T00:00:00Z'},
  ]);
  const page = await list({});
  assert.equal(page.entries[0].result,'expired');
  assert.equal(page.entries[0].actor,'unknown');
  assert.equal(page.entries[1].result,'pending');
  assert.equal(page.entries[1].errorCode,'');
  assert.equal(page.entries[1].errorSummary,'');
});

test('桌面成功 Redis 扫描默认降噪，异常和其他来源保留且原始审计不变', async t => {
  const {write,list,store,base,file} = await fixture(t);
  const scan = {pluginType:'redis',capability:'scan',actor:'user',result:'success'};
  await write([
    ...Array.from({length:270},(_,i) => [
      {...scan,type:'plugin-operation-started',operationId:'scan-'+i,result:'started'},
      {...scan,type:'plugin-operation',operationId:'scan-'+i},
    ]).flat(),
    {...scan,type:'plugin-operation',operationId:'failed',result:'error',errorCode:'REDIS_TIMEOUT'},
    {...scan,type:'plugin-operation-decision',operationId:'blocked',result:'blocked'},
    {...scan,type:'plugin-operation',operationId:'agent',actor:'agent'},
    {...scan,type:'plugin-operation',operationId:'unknown-actor',actor:undefined},
    {...scan,type:'plugin-operation',operationId:'read',capability:'read'},
    {...scan,type:'plugin-operation-started',operationId:'unfinished',result:'started'},
  ]);
  const before = await fs.readFile(file,'utf8');
  const normal = await list({limit:50});
  assert.equal(normal.entries.length,6);
  assert.equal(normal.nextCursor,null);
  assert.ok(normal.entries.some(entry => entry.result === 'error'));
  assert.ok(normal.entries.some(entry => entry.actor === 'agent'));
  const full = await list({limit:10,includeRedisScans:true});
  assert.equal(full.entries.length,10);
  assert.ok(full.nextCursor);
  await assert.rejects(list({cursor:full.nextCursor,includeRedisScans:false}),{code:'AUDIT_CURSOR_STALE'});
  const next = await list({limit:10,cursor:full.nextCursor,includeRedisScans:true});
  assert.equal(new Set([...full.entries,...next.entries].map(entry => entry.auditId)).size,20);
  await assert.rejects(list({includeRedisScans:'true'}),{code:'INVALID_ARGUMENT'});
  const raw = await store.listAudit(base.projectId,{environmentId:base.environmentId});
  assert.equal(raw.entries.length,100);
  assert.equal(await fs.readFile(file,'utf8'),before);
});


test('终端同一会话内每条命令独立展示，保留退出码且不混入开关会话', async t => {
  const {write,list} = await fixture(t);
  const base = {actor:'user',sessionId:'terminal-session'};
  await write([
    {...base,type:'terminal-open',result:'success'},
    {...base,type:'terminal-command',operationId:'command-one',auditAction:'shell.execute',auditTarget:'pwd',exitCode:0,result:'success'},
    {...base,type:'terminal-command',operationId:'command-two',auditAction:'shell.execute',auditTarget:'false',exitCode:1,result:'error'},
    {...base,type:'terminal-close',result:'success'},
  ]);
  const page = await list({actor:'user'});
  assert.equal(page.entries.length,3);
  const commands = page.entries.filter(entry=>entry.action === 'shell.execute');
  assert.deepEqual(commands.map(entry=>[entry.target,entry.exitCode,entry.result]),[['false',1,'error'],['pwd',0,'success']]);
  assert.ok(commands.every(entry=>entry.eventCount === 1));
});
