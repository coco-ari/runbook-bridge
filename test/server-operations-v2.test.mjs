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
  const json=serverOperationInternals.redactConfig('{"username":"app","password":"json-secret","nested":{"token":"nested-secret"}}');
  const structured=serverOperationInternals.redactConfig('secret: |\n  line-one\n  line-two\nname: safe\n<password>xml-secret</password>');
  assert.doesNotMatch(value,/hunter2|abc\.def/);
  assert.doesNotMatch(json,/json-secret|nested-secret/);
  assert.doesNotMatch(structured,/line-one|line-two|xml-secret/);
  assert.match(value,/normal=value/);
});

test('log tools reject configuration file handles and config pagination happens after redaction', async () => {
  const content='username=app\npassword=supersecret\nnormal=value';
  const runtime={readRemoteRange:async()=>({content,startByte:0,endByte:Buffer.byteLength(content),size:Buffer.byteLength(content),truncated:false,mtime:7})};
  const operations=new ServerOperations(runtime,{});
  const configSource={sourceId:'config',displayName:'Config',kind:'config',root:'/etc/app',patterns:['*.conf'],maxFileBytes:1024};
  const scopedPlugin={...plugin,sources:[configSource]};
  const fileId=operations.rememberFile(scopedPlugin,configSource,{canonicalPath:'/etc/app/app.conf',size:Buffer.byteLength(content),mtime:7});
  await assert.rejects(()=>operations.readLog(scopedPlugin,{fileId}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  await assert.rejects(()=>operations.searchLogs(scopedPlugin,{fileIds:[fileId],contains:'secret'}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  let cursor=null;
  let combined='';
  do {
    const page=await operations.readConfig(scopedPlugin,{fileId,cursor,maxBytes:5});
    combined+=page.content;
    cursor=page.nextCursor;
  } while(cursor);
  assert.doesNotMatch(combined,/supersecret/);
  assert.match(combined,/\[REDACTED\]/);
});
