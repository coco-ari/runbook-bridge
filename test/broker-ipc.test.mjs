import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { BrokerServer } from '../src/broker-server.mjs';
import { callBroker } from '../src/broker-client.mjs';
import { rotateBrokerToken } from '../src/broker-auth.mjs';

test('local broker requires the shared per-user token and returns structured data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = await rotateBrokerToken(root);
  const v2Service = { listProjects() { return { projects: [{ projectId: 'demo' }] }; } };
  const server = new BrokerServer({ dataRoot: root, token, v2Service });
  await server.start();
  t.after(() => server.stop());
  await assert.rejects(
    () => callBroker(root, 'status', { projectId: 'demo' }, 2_000),
    (error) => error.code === 'METHOD_NOT_FOUND',
  );
  assert.deepEqual(await callBroker(root, 'v2.listProjects', {}, 2_000), { projects: [{ projectId: 'demo' }] });
  assert.deepEqual(await callBroker(root, 'info', {}, 2_000), { version: 'unknown', protocolVersion: 2 });
});

test('broker survives an abandoned client and stop closes idle pipe clients promptly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = await rotateBrokerToken(root);
  const v2Service = {
    async listProjects() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { projects: [{ projectId: 'still-alive' }] };
    },
  };
  const server = new BrokerServer({ dataRoot: root, token, v2Service });
  await server.start();
  const abandoned = net.createConnection(server.endpoint);
  await new Promise((resolve, reject) => {
    abandoned.once('connect', resolve);
    abandoned.once('error', reject);
  });
  abandoned.write(`${JSON.stringify({ id: 'abandoned', auth: token, method: 'v2.listProjects', params: {} })}\n`);
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await callBroker(root, 'v2.listProjects', {}, 2_000)).projects[0].projectId, 'still-alive');

  const idle = net.createConnection(server.endpoint);
  await new Promise((resolve, reject) => {
    idle.once('connect', resolve);
    idle.once('error', reject);
  });
  const started = Date.now();
  await server.stop();
  assert.ok(Date.now() - started < 1_000);
});

test('broker preserves legacy log search and forwards every bounded search field', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-log-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = await rotateBrokerToken(root);
  const invocations = [];
  const v2Service = {
    invoke(params, capability, args) {
      invocations.push({params,capability,args});
      return { accepted:true };
    },
  };
  const server = new BrokerServer({ dataRoot:root, token, v2Service });
  await server.start();
  t.after(() => server.stop());
  const scope = {
    projectId:'project-one',
    environmentId:'production',
    pluginInstanceId:'server-main',
    contextToken:'context-token-1234',
  };

  assert.deepEqual(await callBroker(root, 'v2.serverSearchLogs', {
    ...scope,
    fileIds:['legacy-file'],
    contains:'ERROR',
    maxLines:25,
  }, 2_000), { accepted:true });
  assert.deepEqual(invocations[0].args.fileIds, ['legacy-file']);
  assert.equal(invocations[0].args.contains, 'ERROR');
  assert.equal(invocations[0].args.maxLines, 25);

  const modern = {
    ...scope,
    sourceId:'registered-logs',
    queries:['ERROR','timeout'],
    matchMode:'all',
    caseSensitive:false,
    pattern:'*.log.*',
    maxDepth:12,
    maxFiles:100,
    maxMatches:500,
    beforeLines:50,
    afterLines:49,
    includeArchives:true,
    maxScanBytes:64 * 1024 * 1024,
    maxExpandedBytes:128 * 1024 * 1024,
    maxArchiveEntries:128,
  };
  assert.deepEqual(await callBroker(root, 'v2.serverSearchLogs', modern, 2_000), { accepted:true });
  assert.equal(invocations[1].capability, 'logs');
  assert.deepEqual(invocations[1].args, {
    operation:'search',
    fileIds:undefined,
    sourceId:'registered-logs',
    path:undefined,
    contains:undefined,
    queries:['ERROR','timeout'],
    matchMode:'all',
    caseSensitive:false,
    pattern:'*.log.*',
    maxDepth:12,
    maxFiles:100,
    maxMatches:500,
    maxLines:undefined,
    beforeLines:50,
    afterLines:49,
    includeArchives:true,
    maxScanBytes:64 * 1024 * 1024,
    maxExpandedBytes:128 * 1024 * 1024,
    maxArchiveEntries:128,
  });

  await callBroker(root, 'v2.serverSearchLogs', {
    ...scope,
    path:'/var/log/app',
    queries:['WARN'],
  }, 2_000);
  assert.equal(invocations[2].args.path, '/var/log/app');
  await callBroker(root, 'v2.serverReadFile', {...scope,path:'/var/log/app.log',tail:true,maxBytes:4096}, 2_000);
  assert.equal(invocations[3].capability, 'fs.read');
  assert.deepEqual(invocations[3].args, {path:'/var/log/app.log',cursor:undefined,maxBytes:4096,tail:true});
});

test('broker routes MySQL schema search through the existing describe capability', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-schema-search-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const token = await rotateBrokerToken(root);
  const invocations = [];
  const server = new BrokerServer({
    dataRoot:root,
    token,
    v2Service:{invoke:(params,capability,args) => { invocations.push({params,capability,args}); return {accepted:true}; }},
  });
  await server.start();
  t.after(() => server.stop());
  const params = {
    projectId:'project-one',environmentId:'production',pluginInstanceId:'mysql-main',contextToken:'context-token-1234',
    keywords:['coupon','uid'],limit:25,
  };
  assert.deepEqual(await callBroker(root,'v2.mysqlSearchSchema',params,2000),{accepted:true});
  assert.equal(invocations[0].capability,'describe');
  assert.deepEqual(invocations[0].args,{operation:'search',keywords:['coupon','uid'],limit:25});
});

test('Unix Broker 限制 socket 和 Token 权限，拒绝覆盖普通文件及活动 socket', {skip:process.platform === 'win32'}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-unix-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const token = await rotateBrokerToken(root);
  const server = new BrokerServer({dataRoot:root,token,v2Service:{listProjects:() => ({projects:[]})}});
  await fs.writeFile(server.endpoint,'owned regular file',{mode:0o600});
  await assert.rejects(server.start(),(error) => error.code === 'BROKER_UNAVAILABLE');
  assert.equal(await fs.readFile(server.endpoint,'utf8'),'owned regular file');
  await fs.unlink(server.endpoint);
  await server.start();
  t.after(() => server.stop());
  assert.equal((await fs.stat(server.endpoint)).mode & 0o777,0o600);
  assert.equal((await fs.stat(path.join(root,'broker.token'))).mode & 0o777,0o600);
  const duplicate = new BrokerServer({dataRoot:root,token});
  await assert.rejects(duplicate.start(),(error) => error.code === 'BROKER_UNAVAILABLE');
  assert.deepEqual(await callBroker(root,'v2.listProjects',{},2_000),{projects:[]});
  await server.stop();
  await assert.rejects(fs.stat(server.endpoint),{code:'ENOENT'});
  await server.start();
  assert.deepEqual(await callBroker(root,'v2.listProjects',{},2_000),{projects:[]});
});

test('Unix Broker 和 MCP 在长数据目录下使用同一短 socket', {skip:process.platform === 'win32'}, async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-unix-long-'));
  const root = path.join(parent,'中文目录'.repeat(20));
  t.after(() => fs.rm(parent,{recursive:true,force:true}));
  const token = await rotateBrokerToken(root);
  const server = new BrokerServer({dataRoot:root,token,v2Service:{listProjects:() => ({projects:[]})}});
  await server.start();
  t.after(() => server.stop());
  assert.ok(Buffer.byteLength(server.endpoint) <= 100);
  assert.deepEqual(await callBroker(root,'v2.listProjects',{},2_000),{projects:[]});
});
