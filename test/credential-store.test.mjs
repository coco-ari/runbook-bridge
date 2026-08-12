import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProjectStore } from '../src/project-store.mjs';

const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
};

test('credentials are stored outside project.yaml as encrypted data and can be cleared', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id: 'remembered-login',
    name: '记住登录',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const credentials = new CredentialStore(projects, fakeEncryption);
  await credentials.save(project.id, {
    password: 'server-password',
    privateKeyPassphrase: '',
    proxyPassword: 'proxy-password',
  }, project);
  const config = await fs.readFile(path.join(projects.projectDir(project.id), 'project.yaml'), 'utf8');
  const encrypted = await fs.readFile(path.join(projects.projectDir(project.id), 'credentials.enc.json'), 'utf8');
  assert.doesNotMatch(config, /server-password|proxy-password/);
  assert.doesNotMatch(encrypted, /server-password|proxy-password/);
  assert.deepEqual(await credentials.load(project.id, project), {
    password: 'server-password',
    proxyPassword: 'proxy-password',
  });
  assert.equal(await credentials.has(project.id), true);
  assert.equal(await credentials.hasUsable(project.id, project), true);
  await credentials.clear(project.id);
  assert.equal(await credentials.has(project.id), false);
});

test('legacy credential envelopes require one explicit credential re-entry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-legacy-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id: 'legacy-credential',
    name: '旧凭据',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const credentials = new CredentialStore(projects, fakeEncryption);
  const legacyCiphertext = fakeEncryption.encryptString(JSON.stringify({ password: 'old-password' }));
  await fs.writeFile(
    credentials.filePath(project.id),
    JSON.stringify({ version: 1, ciphertext: legacyCiphertext.toString('base64') }),
  );
  await assert.rejects(
    () => credentials.load(project.id, project),
    (error) => error.code === 'CREDENTIAL_REENTRY_REQUIRED',
  );
  assert.equal(await credentials.hasUsable(project.id, project), false);
});
