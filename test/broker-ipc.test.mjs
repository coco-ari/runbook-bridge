import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { BrokerServer } from '../src/broker-server.mjs';
import { callBroker } from '../src/broker-client.mjs';
import { ensureBrokerToken } from '../src/broker-auth.mjs';

test('local broker requires the shared per-user token and returns structured data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = await ensureBrokerToken(root);
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
  const token = await ensureBrokerToken(root);
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
