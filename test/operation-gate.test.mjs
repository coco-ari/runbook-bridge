import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { OperationGate, capabilityRule } from '../src/operation-gate.mjs';

const scope={projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',clientInstanceId:'agent1'};
const server={pluginType:'server',policy:{config:'deny','fs.delete':'auto'}};

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
