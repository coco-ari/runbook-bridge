import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { ProjectStore } from '../src/project-store.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const input = {
  id: 'order-prod',
  name: '订单系统生产',
  ssh: { host: '192.168.10.20', port: 22, username: 'order-deploy' },
  auth: { type: 'privateKey', privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519' },
  proxy: { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'proxy-user' },
  password: 'must-not-persist',
  proxyPassword: 'must-not-persist-either',
};

test('project creation persists only non-secret connection metadata', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  assert.equal(project.id, 'order-prod');
  assert.equal(project.auth.type, 'privateKey');
  assert.equal(project.proxy.type, 'socks5');
  const configPath = path.join(root, 'projects', project.id, 'project.yaml');
  const raw = await fs.readFile(configPath, 'utf8');
  assert.doesNotMatch(raw, /must-not-persist/);
  const parsed = YAML.parse(raw);
  assert.equal(parsed.auth.privateKeyPath, input.auth.privateKeyPath);
  assert.equal(parsed.proxy.username, 'proxy-user');
  assert.equal(parsed.password, undefined);
  assert.deepEqual(parsed.commandPolicy, { enabled: true, customDeny: [] });
  const defaultReadme = await store.readDoc(project.id, 'README.md');
  assert.match(defaultReadme, /产物清单/);
  assert.match(defaultReadme, /Codex MCP 安装/);
  assert.match(defaultReadme, /codex mcp add --env ELECTRON_RUN_AS_NODE=1 ai-ops/);
  assert.match(defaultReadme, /codex mcp get ai-ops/);
});

test('command policy is enabled by default and validates per-project custom deny phrases', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  assert.deepEqual(project.commandPolicy, { enabled: true, customDeny: [] });

  const updated = await store.update(project.id, {
    commandPolicy: {
      enabled: false,
      customDeny: ['docker system prune', '  Docker   System Prune  ', 'rm -rf /home/order'],
    },
  });
  assert.deepEqual(updated.commandPolicy, {
    enabled: false,
    customDeny: ['docker system prune', 'rm -rf /home/order'],
  });
  assert.deepEqual((await store.get(project.id)).commandPolicy, updated.commandPolicy);

  await assert.rejects(
    () => store.update(project.id, { commandPolicy: { customDeny: Array.from({ length: 51 }, (_, index) => `rule-${index}`) } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => store.update(project.id, { commandPolicy: { customDeny: ['bad\nrule'] } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('connection settings can be edited and changing the target clears the pinned host key', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create({
    ...input,
    ssh: { ...input.ssh, hostKeyFingerprint: 'SHA256:old-host-key' },
  });
  const updated = await store.update(project.id, {
    name: '订单系统新环境',
    ssh: { host: '192.168.10.21', port: 2222, username: 'new-deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  assert.equal(updated.name, '订单系统新环境');
  assert.equal(updated.ssh.host, '192.168.10.21');
  assert.equal(updated.ssh.port, 2222);
  assert.equal(updated.ssh.hostKeyFingerprint, undefined);
  assert.deepEqual(updated.auth, { type: 'password' });
  assert.deepEqual(updated.proxy, { type: 'direct' });
});

test('documents are arbitrary markdown files and context hash changes on save', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  await store.createDoc(project.id, 'DEPLOY.md');
  await store.saveDoc(project.id, 'DEPLOY.md', '# 部署\n\n上传三个产物。');
  const first = await store.readContext(project.id);
  assert.deepEqual(first.documentNames, ['README.md', 'DEPLOY.md']);
  assert.equal(first.documents.length, 2);
  const saved = await store.saveDoc(project.id, 'DEPLOY.md', '# 部署\n\n内容已更新。');
  assert.equal(saved.verified, true);
  assert.equal(saved.sizeBytes, Buffer.byteLength('# 部署\n\n内容已更新。', 'utf8'));
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  const second = await store.readContext(project.id);
  assert.notEqual(first.docsHash, second.docsHash);
});

test('broker context is invalidated when markdown changes', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  const broker = new SshBroker(store);
  broker.sessions.set(project.id, { client: {}, generation: 1, connectedAt: new Date().toISOString() });
  const { docsHash } = await store.readContext(project.id);
  const { contextToken } = await broker.openContext(project.id, docsHash);
  await broker.requireContext(project.id, contextToken);
  await store.saveDoc(project.id, 'README.md', '# changed');
  await assert.rejects(
    () => broker.requireContext(project.id, contextToken),
    (error) => error.code === 'PROJECT_CONTEXT_REQUIRED',
  );
});

test('broker refuses a token when documents changed between MCP read and token signing', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  const broker = new SshBroker(store);
  broker.sessions.set(project.id, { client: {}, generation: 1, connectedAt: new Date().toISOString() });
  const first = await store.readContext(project.id);
  await store.saveDoc(project.id, 'README.md', '# newer instructions');
  await assert.rejects(
    () => broker.openContext(project.id, first.docsHash),
    (error) => error.code === 'PROJECT_CONTEXT_CHANGED',
  );
});

test('truncated project documents are hashed but never receive an operation token', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create({ ...input, limits: { maxDocumentKB: 1 } });
  await store.createDoc(project.id, 'SAFETY.md');
  await store.saveDoc(project.id, 'SAFETY.md', `# 安全规则\n\n${'x'.repeat(2048)}`);
  const first = await store.readContext(project.id);
  assert.equal(first.truncated, true);
  await store.saveDoc(project.id, 'SAFETY.md', `# 新安全规则\n\n${'y'.repeat(2048)}`);
  const second = await store.readContext(project.id);
  assert.notEqual(first.docsHash, second.docsHash);
  const broker = new SshBroker(store);
  broker.sessions.set(project.id, { client: {}, generation: 1, connectedAt: new Date().toISOString() });
  await assert.rejects(
    () => broker.openContext(project.id, second.docsHash),
    (error) => error.code === 'PROJECT_DOCUMENTS_TRUNCATED',
  );
});

test('README cannot be deleted and unsafe document names are rejected', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  const project = await store.create(input);
  await assert.rejects(() => store.deleteDoc(project.id, 'README.md'), (error) => error.code === 'POLICY_DENIED');
  await assert.rejects(() => store.createDoc(project.id, '../secret.md'), (error) => error.code === 'INVALID_DOCUMENT_NAME');
});

test('project configuration rejects control characters and invalid proxy limits', async (t) => {
  const root = await tempRoot(t);
  const store = new ProjectStore(root);
  await assert.rejects(
    () => store.create({ ...input, ssh: { ...input.ssh, host: "good.example\r\nInjected: yes" } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => store.create({ ...input, proxy: { type: 'http', host: '127.0.0.1', port: 70000 } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});
