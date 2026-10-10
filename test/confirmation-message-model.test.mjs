import test from 'node:test';
import assert from 'node:assert/strict';
import { activeConfirmationMessages, ConfirmationArrivals } from '../renderer/v2/src/features/confirmations/confirmation-message-model.ts';
const request=(requestId,expiresAt=1000)=>({requestId,projectId:'p',environmentId:'e',pluginInstanceId:'s',capability:'fs.write',summary:'合成请求',expiresAt});
test('消息列表仅保留未过期且范围完整的请求，去重并按到期时间排序',()=>{
 assert.deepEqual(activeConfirmationMessages([request('later',2000),request('soon'),request('soon'),request('expired',100),{...request('bad'),pluginInstanceId:null},request('infinite',Infinity)],100).map(x=>x.requestId),['soon','later']);
 assert.deepEqual(activeConfirmationMessages([request('soon')],1000),[]);
});
test('新增请求只提醒一次，初读、重复广播、队列减少和重读均不重复提醒',()=>{
 const arrival=new ConfirmationArrivals();
 assert.equal(arrival.receive([request('initial')],100),0);
 assert.equal(arrival.receive([request('initial'),request('new')],101),1);
 assert.equal(arrival.receive([request('initial'),request('new'),request('new')],102),0);
 assert.equal(arrival.receive([],103),0);
 assert.equal(arrival.receive([request('new')],104),0);
 assert.equal(arrival.receive([request('expired',104),request('another')],105),1);
 assert.equal(arrival.receive([request('initial')],1001),0);
});
