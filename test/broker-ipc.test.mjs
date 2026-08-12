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
  const fakeBroker = {
    status(projectId) { return { projectId, connected: true, generation: 7 }; },
    listStatuses() { return { demo: { connected: true, generation: 7 } }; },
  };
  const server = new BrokerServer({ dataRoot: root, token, broker: fakeBroker });
  await server.start();
  t.after(() => server.stop());
  const response = await callBroker(root, 'status', { projectId: 'demo' }, 2_000);
  assert.deepEqual(response, { projectId: 'demo', connected: true, generation: 7 });
  assert.deepEqual(await callBroker(root, 'info', {}, 2_000), { version: 'unknown' });
});

test('broker survives an abandoned client and stop closes idle pipe clients promptly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-broker-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = await ensureBrokerToken(root);
  const fakeBroker = {
    async status(projectId) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { projectId, connected: true };
    },
    listStatuses() { return {}; },
  };
  const server = new BrokerServer({ dataRoot: root, token, broker: fakeBroker });
  await server.start();
  const abandoned = net.createConnection(server.endpoint);
  await new Promise((resolve, reject) => {
    abandoned.once('connect', resolve);
    abandoned.once('error', reject);
  });
  abandoned.write(`${JSON.stringify({ id: 'abandoned', auth: token, method: 'status', params: { projectId: 'demo' } })}\n`);
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await callBroker(root, 'status', { projectId: 'still-alive' }, 2_000)).connected, true);

  const idle = net.createConnection(server.endpoint);
  await new Promise((resolve, reject) => {
    idle.once('connect', resolve);
    idle.once('error', reject);
  });
  const started = Date.now();
  await server.stop();
  assert.ok(Date.now() - started < 1_000);
});
