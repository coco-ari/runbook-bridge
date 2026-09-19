import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { SshBroker } from '../src/ssh-broker.mjs';
import { createCloudServer } from '../services/cloud-config/server.mjs';
import { CloudConfigClient } from '../src/cloud-config-client.mjs';
import { CLOUD_MAX_BYTES, newCloudMeta, cloudHash, encryptCloudSnapshot } from '../src/cloud-config-crypto.mjs';

test('托管 SSH 私钥实际通过回环 SSH 认证，并继续拒绝未知和变化指纹',async t => {
  const privateKey = crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
  const parsed = ssh2.utils.parseKey(privateKey);
  const fingerprint = 'SHA256:'+crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/,'');
  const clients = new Set(); let authenticated = 0;
  const server = new ssh2.Server({hostKeys:[privateKey]},client => {
    clients.add(client); client.on('error',() => {}); client.on('close',() => clients.delete(client));
    client.on('authentication',context => {
      if (context.method === 'publickey' && context.key.data.equals(parsed.getPublicSSH()) && (!context.signature || parsed.verify(context.blob,context.signature,context.hashAlgo))) { authenticated++; context.accept(); }
      else context.reject();
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const config = {ssh:{host:'127.0.0.1',port:server.address().port,username:'synthetic',hostKeyFingerprint:fingerprint},auth:{type:'privateKey',privateKeySource:'vault'},proxy:{type:'direct'}};
  const broker = new SshBroker({get:async () => config,appendAudit:async () => {}});
  t.after(async () => { await broker.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  await broker.connect('synthetic',{privateKeyPem:privateKey});
  assert.ok(authenticated > 0);
  assert.equal(broker.status('synthetic').connected,true);
  await broker.disconnect('synthetic');
  await assert.rejects(broker.connect('synthetic',{}),{code:'SSH_IDENTITY_UNAVAILABLE'});
  config.ssh.hostKeyFingerprint = 'SHA256:synthetic-mismatch';
  await assert.rejects(broker.connect('synthetic',{privateKeyPem:privateKey}),{code:'SSH_HOST_KEY_CHANGED'});
  delete config.ssh.hostKeyFingerprint;
  await assert.rejects(broker.connect('synthetic',{privateKeyPem:privateKey}),{code:'SSH_HOST_KEY_CONFIRM_REQUIRED'});
});

test('云服务条件提交、历史清理、认证、请求限额与错误响应均有边界',async t => {
  const adminToken = crypto.randomBytes(32).toString('base64url');
  let tick = Date.now();
  const server = createCloudServer({adminToken,retention:2,now:() => tick});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new CloudConfigClient({allowTestHttp:true});
  const meta = newCloudMeta(), auth = crypto.randomBytes(32).toString('base64url'), key = crypto.randomBytes(32);
  await client.request(origin,'/api/v1/repos',{method:'POST',token:adminToken,body:{metadata:meta,authHash:cloudHash(auth)}});
  const session = {origin,repoId:meta.repoId,keys:{auth,encryption:key}};
  let parentId = null; const ids = [];
  for (let index=0;index<3;index++) {
    const encrypted = encryptCloudSnapshot({schemaVersion:1,projects:[]},meta,key,parentId);
    await client.call(session,'snapshots',{method:'POST',body:encrypted,parentId});
    parentId = encrypted.snapshotId; ids.push(parentId);
  }
  assert.equal((await client.call(session,'versions')).versions.length,2);
  await assert.rejects(client.call(session,`snapshots/${ids[0]}`),{code:'CLOUD_NOT_FOUND'});
  await assert.rejects(client.call(session,'snapshots',{method:'POST',parentId:null,body:encryptCloudSnapshot({},meta,key)}),{code:'CLOUD_CONFLICT'});
  assert.equal((await client.call(session,'head')).snapshotId,parentId);
  await assert.rejects(client.request(origin,'/api/v1/repos',{method:'POST',token:'synthetic-wrong-admin',body:{}}),{code:'CLOUD_AUTH_FAILED'});
  await assert.rejects(client.call(session,'snapshots',{method:'POST',parentId,body:{large:'x'.repeat(CLOUD_MAX_BYTES)}}),{code:'CLOUD_TOO_LARGE'});
  for (let i=0;i<20;i++) await fetch(`${origin}/api/v1/repos/${meta.repoId}/head`,{headers:{Authorization:'Bearer synthetic-wrong-access'}});
  const limited = await fetch(`${origin}/api/v1/repos/${meta.repoId}/head`,{headers:{Authorization:`Bearer ${auth}`}});
  assert.equal(limited.status,429);
  assert.ok(!JSON.stringify(await limited.json()).includes(auth));
  tick += 61_000;
  assert.equal((await client.call(session,'head')).snapshotId,parentId);
});

test('云客户端限制响应长度并拒绝重定向和外部错误正文',async () => {
  const client = new CloudConfigClient({fetchImpl:async (_url,options) => {
    assert.equal(options.redirect,'error');
    return new Response('synthetic-sensitive-provider-response',{status:500});
  }});
  await assert.rejects(client.request('https://example.invalid','/test'),error => error.code === 'CLOUD_SERVER_ERROR' && !error.message.includes('synthetic-sensitive'));
  client.fetch = async () => new Response('{}',{headers:{'content-length':String(CLOUD_MAX_BYTES+1)}});
  await assert.rejects(client.request('https://example.invalid','/test'),{code:'CLOUD_TOO_LARGE'});
});
