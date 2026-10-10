import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCloudServer } from '../services/cloud-config/server.mjs';
import { newCloudMeta, cloudHash, encryptCloudSnapshot } from '../src/cloud-config-crypto.mjs';
import { CloudConfigClient } from '../src/cloud-config-client.mjs';
import { readUpdateEvents, subscribeUpdateEvents } from '../src/update-event-client.mjs';

const ADMIN = 'synthetic-update-event-admin-000000000001';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(predicate) {
  const deadline = Date.now()+4000;
  while (!predicate()) { if (Date.now()>deadline) assert.fail('等待合成推送超时'); await delay(10); }
}
async function server(t,options = {}) {
  const service = createCloudServer({adminToken:ADMIN,...options});
  await new Promise(resolve => service.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { service.close(resolve); service.closeAllConnections(); }));
  return `http://127.0.0.1:${service.address().port}`;
}
async function repo(origin) {
  const metadata = newCloudMeta(), client = new CloudConfigClient();
  const auth = crypto.randomBytes(32).toString('base64url');
  await client.request(origin,'/api/v1/repos',{method:'POST',token:ADMIN,body:{metadata,authHash:cloudHash(auth)}});
  return {origin,repoId:metadata.repoId,metadata,keys:{auth,encryption:crypto.randomBytes(32)},client};
}
function watch(t,url,token) {
  const controller = new AbortController(), changes = [];
  const promise = readUpdateEvents({url,token,signal:controller.signal,onChange:revision => changes.push(revision)}).catch(error => { if (!controller.signal.aborted) throw error; });
  t.after(async () => { controller.abort(); await promise; });
  return {changes,controller,promise};
}

test('仓库推送认证与范围隔离，提交后送达且重连补发最新状态',async t => {
  const origin = await server(t), a = await repo(origin), b = await repo(origin);
  const url = `${origin}/api/v1/repos/${a.repoId}/events`;
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${b.keys.auth}`}})).status,401);
  const aw = watch(t,url,a.keys.auth), bw = watch(t,`${origin}/api/v1/repos/${b.repoId}/events`,b.keys.auth);
  await until(() => aw.changes.length && bw.changes.length);
  assert.deepEqual(aw.changes,[null]);
  const envelope = encryptCloudSnapshot({schemaVersion:1,projects:[]},a.metadata,a.keys.encryption,null);
  await a.client.call(a,'snapshots',{method:'POST',body:envelope,parentId:null});
  await until(() => aw.changes.length === 2);
  assert.deepEqual(aw.changes,[null,envelope.snapshotId]);
  assert.deepEqual(bw.changes,[null]);
  await assert.rejects(a.client.call(a,'snapshots',{method:'POST',body:envelope,parentId:null}),{code:'CLOUD_CONFLICT'});
  await delay(30); assert.equal(aw.changes.length,2);
  aw.controller.abort(); await aw.promise;
  const again = watch(t,url,a.keys.auth);
  await until(() => again.changes.length);
  assert.deepEqual(again.changes,[envelope.snapshotId]);
});

test('软件推送检测原子发布且拒绝凭据、未知平台和过量连接',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'update-events-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'win32','x64'),{recursive:true});
  const origin = await server(t,{releasesDirectory:directory,eventOptions:{intervalMs:20,maxConnections:1}});
  const url = `${origin}/api/v1/updates/win32/x64/events`;
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer synthetic-forbidden'}})).status,400);
  assert.equal((await fetch(`${origin}/api/v1/updates/darwin/ia32/events`)).status,404);
  const stream = watch(t,url);
  await until(() => stream.changes.length);
  assert.equal((await fetch(url)).status,429);
  const manifest = path.join(directory,'win32','x64','latest.yml');
  await fs.writeFile(`${manifest}.tmp`,'synthetic-complete-manifest');
  await delay(50); assert.deepEqual(stream.changes,[null]);
  await fs.rename(`${manifest}.tmp`,manifest);
  await until(() => stream.changes.length === 2);
  assert.equal(stream.changes[1],cloudHash('synthetic-complete-manifest'));
  await delay(60); assert.equal(stream.changes.length,2);
});

test('客户端限制事件长度和格式，拒绝重定向并取消过期连接',async () => {
  const controller = new AbortController();
  for (const body of ['event: change\ndata: {"revision":"ok","url":"https://bad.invalid"}\n\n','data: '+ 'x'.repeat(5000)+'\n\n','event: change\ndata: nope\n\n']) {
    await assert.rejects(readUpdateEvents({url:'https://synthetic.example.invalid/events',signal:controller.signal,onChange:() => assert.fail('不接受非法事件'),fetchImpl:async (_url,options) => {
      assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,undefined);
      return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
    }}));
  }
  const changes = [];
  const parts = ['event: cha','nge\r\ndata: {"revision":"v1"}\r\n','\r\n: heartbeat\n\n'];
  await readUpdateEvents({url:'https://synthetic.example.invalid/events',token:'synthetic-auth',signal:controller.signal,onChange:v => changes.push(v),fetchImpl:async (_url,options) => {
    assert.equal(options.headers.Authorization,'Bearer synthetic-auth');
    return new Response(new ReadableStream({start(stream) { for (const part of parts) stream.enqueue(new TextEncoder().encode(part)); stream.close(); }}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.deepEqual(changes,['v1']);
  await assert.rejects(readUpdateEvents({url:'https://synthetic.example.invalid/events',signal:controller.signal,onChange:() => {},fetchImpl:async () => new Response('',{status:404})}),error => error.retryMs === 900_000);
});

test('旧服务订阅退避重试且退出后不重连',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let calls = 0;
  const stream = subscribeUpdateEvents({url:'https://synthetic.example.invalid/events',onChange:() => assert.fail(),fetchImpl:async () => { calls++; return new Response('',{status:404}); }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls,1);
  t.mock.timers.tick(899_999); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,1);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,2);
  stream.dispose();
  t.mock.timers.tick(900_000); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,2);
});
