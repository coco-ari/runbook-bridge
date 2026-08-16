import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerOperations, serverOperationInternals } from '../src/server-operations.mjs';

const plugin={projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',pluginType:'server',limits:{maxBytes:65536},actions:[{actionId:'service.status',serviceId:'orders',displayName:'Orders',unit:'orders.service'},{actionId:'filesystem.usage',mountId:'data',displayName:'Data',mountPath:'/srv/data'}],sources:[]};

test('Server operations map actionId to fixed commands and reject arbitrary parameters', () => {
  const operations=new ServerOperations({},{});
  assert.equal(operations.commandFor(plugin,'service.status',{serviceId:'orders'}),'LC_ALL=C systemctl --no-pager --full status -- orders.service');
  assert.equal(operations.commandFor(plugin,'filesystem.usage',{mountId:'data'}),'LC_ALL=C df -P -B1 -- /srv/data');
  assert.throws(()=>operations.commandFor(plugin,'service.status',{serviceId:'orders',command:'rm -rf /'}),(error)=>error.code==='INVALID_ARGUMENT');
  assert.throws(()=>operations.commandFor(plugin,'bash',{}),(error)=>error.code==='POLICY_DENIED');
});

test('configuration reader redacts common secret formats', () => {
  const value=serverOperationInternals.redactConfig('username=app\npassword=hunter2\nAuthorization: Bearer abc.def\nnormal=value');
  assert.doesNotMatch(value,/hunter2|abc\.def/);
  assert.match(value,/normal=value/);
});
