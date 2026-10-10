import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmationEnvironments } from '../renderer/v2/src/features/confirmations/global-confirmation-model.ts';
import { countActiveConfirmations, confirmationCountSnapshot, confirmationCountLoading, ConfirmationCountReadCoordinator } from '../renderer/v2/src/features/confirmations/confirmation-count-model.ts';

const now = 100;
const request = (requestId, projectId, environmentId, expiresAt = 200) => ({ requestId, projectId, environmentId, expiresAt });

test('全局按项目与环境分组，计数去重并忽略过期及无效请求', () => {
  const items = [request('a','p1','same'),request('b','p1','same'),request('c','p2','same'),request('d','p1','other'),
    request('a','p1','same'),request('expired','p2','same',now),request('invalid','p1','',200),request('invalid-date','p1','same',NaN)];
  assert.equal(countActiveConfirmations(items,undefined,now),4);
  assert.deepEqual(confirmationEnvironments(items,now),[
    {projectId:'p1',environmentId:'same',count:2},
    {projectId:'p2',environmentId:'same',count:1},
    {projectId:'p1',environmentId:'other',count:1},
  ]);
  assert.equal(countActiveConfirmations(items,{projectId:'p1',environmentId:'same'},now),2);
  assert.deepEqual(confirmationEnvironments(items,200),[]);
});

test('全局无选择仍可读取，失败不伪装为零项', () => {
  assert.deepEqual(confirmationCountLoading(),{count:null,loading:true,unavailable:false});
  assert.deepEqual(confirmationCountSnapshot(null),{count:null,loading:false,unavailable:true});
  assert.deepEqual(confirmationCountSnapshot([]),{count:0,loading:false,unavailable:false});
});

test('全局订阅优先于在途读取，重试与卸载隔离旧请求', () => {
  const coordinator = new ConfirmationCountReadCoordinator();
  const first = coordinator.activateScope();
  assert.equal(coordinator.acceptSubscription(first),true);
  assert.equal(coordinator.isReadCurrent(first),false);
  const retry = coordinator.activateScope();
  assert.equal(coordinator.acceptSubscription(first),false);
  assert.equal(coordinator.isReadCurrent(retry),true);
  coordinator.deactivateScope(retry);
  assert.equal(coordinator.isReadCurrent(retry),false);
});
