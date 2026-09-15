import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { OperationGate, capabilityRule } from '../src/operation-gate.mjs';
import { V2Service } from '../src/v2-service.mjs';

const scope={projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',clientInstanceId:'agent1'};
const server={pluginType:'server',policy:{config:'deny','fs.delete':'auto'}};

test('状态等待结束后重新校验上下文，失效时不返回批准状态', async () => {
  const manager = new ConfirmationManager();
  const entry = manager.request(scope,'service.control',{unit:'fixture.service'});
  let verifications = 0;
  const service = new V2Service({confirmationManager:manager,contextManager:{verify:async () => {
    verifications += 1;
    if (verifications > 1) throw Object.assign(new Error('失效'),{code:'CONTEXT_INVALIDATED'});
  }}});
  const waiting = service.confirmationStatus({...scope,confirmationId:entry.requestId,waitMs:1000});
  manager.approve(entry.requestId);
  await assert.rejects(waiting,{code:'CONTEXT_INVALIDATED'});
  assert.equal(manager.approved.size,1);
});

test('built-in risk table auto-allows reads and ignores mutable plugin policy', () => {
  const manager=new ConfirmationManager();
  const gate=new OperationGate(manager);
  assert.equal(capabilityRule('server','fs.read').decision,'auto');
  assert.equal(gate.authorize({scope,plugin:server,capability:'fs.read',args:{path:'/etc/secret.conf'}}).risk,'read');
  assert.equal(manager.list().length,0);
});

test('server changes require one exact approval and parameter changes require another', () => {
  const manager=new ConfirmationManager();
  const gate=new OperationGate(manager);
  const request={scope,plugin:server,capability:'fs.delete',args:{path:'/srv/app.jar',_precondition:{remote:{exists:true,size:10,mtime:7}}},summary:'删除 /srv/app.jar'};
  assert.throws(()=>gate.authorize(request),(error)=>error.code==='CONFIRMATION_REQUIRED');
  const pending=manager.list()[0];
  assert.equal(pending.riskLevel,'destructive');
  assert.equal(pending.approvalLevel,'standard');
  manager.approve(pending.requestId);
  const authorization=gate.authorize(request);
  assert.equal(authorization.decision,'confirm');
  assert.equal(authorization.confirmationId,pending.requestId);
  assert.throws(()=>gate.authorize(request),(error)=>error.code==='CONFIRMATION_REQUIRED');
  manager.reject(manager.list()[0].requestId);
  const changed={...request,args:{...request.args,_precondition:{remote:{exists:true,size:11,mtime:8}}}};
  assert.throws(()=>gate.authorize(changed),(error)=>error.code==='CONFIRMATION_REQUIRED');
});

test('shell uses strong confirmation and unknown capabilities fail closed', () => {
  const manager=new ConfirmationManager();
  const gate=new OperationGate(manager);
  assert.throws(()=>gate.authorize({scope,plugin:server,capability:'shell.execute',args:{command:'whoami'},summary:'whoami'}),(error)=>error.code==='CONFIRMATION_REQUIRED');
  assert.equal(manager.list()[0].approvalLevel,'strong');
  assert.throws(()=>gate.authorize({scope,plugin:server,capability:'server.magic',args:{}}),(error)=>error.code==='POLICY_DENIED');
});

test('确认状态查询隔离会话且不泄露参数或批准令牌', async () => {
  const manager = new ConfirmationManager();
  const entry = manager.request(scope,'shell.execute',{command:'fixture-private-command'},'fixture-private-summary');
  assert.equal((await manager.status(scope,entry.requestId)).status,'awaiting_user');
  for (const field of ['projectId','environmentId','pluginInstanceId','clientInstanceId']) {
    await assert.rejects(manager.status({...scope,[field]:'other'},entry.requestId), error => error.code === 'CONFIRMATION_NOT_FOUND');
  }
  const waiting = manager.status(scope,entry.requestId,1000);
  const approved = manager.approve(entry.requestId);
  const result = await waiting;
  assert.equal(result.status,'approved');
  assert.doesNotMatch(JSON.stringify(result),/fixture-private|approvalToken|operationHash/);
  assert.ok(!JSON.stringify(result).includes(approved.approvalToken));
  assert.equal(manager.approved.size,1);
  manager.consumeMatching(scope,'shell.execute',{command:'fixture-private-command'});
  assert.equal((await manager.status(scope,entry.requestId)).status,'consumed');
  manager.executionStatus(entry.requestId,'running');
  manager.executionStatus(entry.requestId,'succeeded');
  assert.equal((await manager.status(scope,entry.requestId)).status,'succeeded');
  assert.equal(manager.consumeMatching(scope,'shell.execute',{command:'fixture-private-command'}),false);
});

test('拒绝、过期和失效保留可查询状态，不会重新创建确认', async () => {
  let now = 100;
  const manager = new ConfirmationManager({ now:() => now, ttlMs:20 });
  const create = () => manager.request(scope,'service.control',{action:'restart'});
  const rejected = create();
  manager.reject(rejected.requestId);
  assert.equal((await manager.status(scope,rejected.requestId)).status,'rejected');
  const expired = create();
  now += 21;
  assert.equal((await manager.status(scope,expired.requestId)).status,'expired');
  const invalidated = create();
  manager.invalidateEnvironment(scope.projectId,scope.environmentId);
  assert.equal((await manager.status(scope,invalidated.requestId)).status,'invalidated');
  assert.equal(manager.pending.size,0);
  assert.equal(manager.approved.size,0);
  await assert.rejects(manager.status(scope,invalidated.requestId,10001),error => error.code === 'INVALID_ARGUMENT');
});
