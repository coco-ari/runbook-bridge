import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConnectionManager } from '../src/connection-manager.mjs';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProjectStore } from '../src/project-store.mjs';

const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

test('a user-supplied password is encrypted after success and reused only on a later explicit connect', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-reconnect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id: 'one-click-reconnect',
    name: '一键重连',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const credentials = new CredentialStore(projects, fakeEncryption);
  const calls = [];
  const automaticallyEnabled = [];
  let reconnectHandler;
  const broker = {
    setReconnectHandler(handler) { reconnectHandler = handler; },
    enableAutoReconnect(projectId) { automaticallyEnabled.push(projectId); },
    async connect(projectId, secrets) {
      calls.push({ projectId, secrets: { ...secrets } });
      return { connected: true };
    },
    async connectAutomatically(projectId, secrets) {
      calls.push({ projectId, secrets: { ...secrets }, automatic: true });
      return { connected: true };
    },
    async disconnect() {},
  };
  const connections = new ConnectionManager(projects, credentials, broker);
  await connections.connect(project.id, { password: 'remember-me' });
  await connections.connect(project.id, {});
  await reconnectHandler(project.id);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].secrets.password, 'remember-me');
  assert.equal(calls[1].secrets.password, 'remember-me');
  assert.equal(calls[2].secrets.password, 'remember-me');
  assert.equal(calls[2].automatic, true);
  assert.deepEqual(automaticallyEnabled, [project.id, project.id]);
  assert.equal(await credentials.has(project.id), true);
});

test('newly entered credentials can replace an unreadable saved credential', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-replace-credential-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id: 'replace-credential',
    name: '替换凭据',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const credentials = new CredentialStore(projects, fakeEncryption);
  await fs.writeFile(credentials.filePath(project.id), '{"version":1,"ciphertext":"broken"}', 'utf8');
  let received;
  const broker = {
    async connect(_projectId, secrets) {
      received = secrets;
      return { connected: true };
    },
    async disconnect() {},
  };
  await new ConnectionManager(projects, credentials, broker).connect(project.id, {
    password: 'replacement-password',
  });
  assert.equal(received.password, 'replacement-password');
  assert.equal((await credentials.load(project.id, await projects.get(project.id))).password, 'replacement-password');
});

test('saved credentials are never reused after the SSH or proxy identity changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-credential-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id: 'credential-binding',
    name: '凭据绑定',
    ssh: { host: 'server-a.example', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const credentials = new CredentialStore(projects, fakeEncryption);
  let connectCalls = 0;
  const broker = {
    async connect() { connectCalls += 1; return { connected: true }; },
    async disconnect() {},
  };
  const connections = new ConnectionManager(projects, credentials, broker);
  await connections.connect(project.id, { password: 'server-a-password' });
  await projects.update(project.id, { ssh: { host: 'server-b.example' } });
  await assert.rejects(
    () => connections.connect(project.id, {}),
    (error) => error.code === 'CREDENTIAL_SCOPE_CHANGED',
  );
  assert.equal(connectCalls, 1);
  await connections.connect(project.id, { password: 'server-b-password' });
  assert.equal(connectCalls, 2);
  assert.equal(
    (await credentials.load(project.id, await projects.get(project.id))).password,
    'server-b-password',
  );
});
