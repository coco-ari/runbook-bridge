import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialStore, credentialBinding } from '../src/credential-store.mjs';
import { ProjectStore } from '../src/project-store.mjs';

const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
};

test('credentials are encrypted and software clear requests preserve them', async (t) => {
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
  assert.equal(await credentials.has(project.id), true);
  assert.deepEqual(await credentials.load(project.id, project), {
    password: 'server-password',
    proxyPassword: 'proxy-password',
  });
});

test('migration reader recovers project-scoped v1 credentials without rewriting the legacy envelope', async (t) => {
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
  const sourceBefore = await fs.readFile(credentials.filePath(project.id));
  const candidate = await credentials.readMigrationCandidate(project.id,project);
  assert.equal(candidate.status,'verified');
  assert.equal(candidate.verification,'legacy-project-directory');
  assert.equal(candidate.formatVersion,1);
  assert.deepEqual(candidate.secrets,{password:'old-password'});
  assert.deepEqual(await fs.readFile(credentials.filePath(project.id)),sourceBefore);
  // Normal runtime loading remains binding-strict; only the migration path is
  // allowed to interpret the old project-directory scope.
  await assert.rejects(
    () => credentials.load(project.id, project),
    (error) => error.code === 'CREDENTIAL_REENTRY_REQUIRED',
  );
  assert.equal(await credentials.hasUsable(project.id, project), false);
});

test('v2 migration candidates expose only an allow-listed binding summary and never alter source bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-v2-migration-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const projects = new ProjectStore(root);
  const project = await projects.create({
    id:'v2-migration',name:'V2 凭据',ssh:{host:'old.internal',port:22,username:'deploy'},
    auth:{type:'password'},proxy:{type:'direct'},
  });
  const credentials = new CredentialStore(projects,fakeEncryption);
  await credentials.save(project.id,{password:'legacy-password',proxyPassword:'legacy-proxy'},project);
  const sourceBefore = await fs.readFile(credentials.filePath(project.id));

  const exact = await credentials.readMigrationCandidate(project.id,project);
  assert.equal(exact.status,'verified');
  assert.equal(exact.verification,'exact-binding');
  assert.deepEqual(exact.sourceBinding,{
    host:'old.internal',port:22,username:'deploy',authType:'password',privateKeyPathConfigured:false,
    proxyType:'direct',proxyHost:'',proxyPort:0,proxyUsername:'',
  });

  const changed = {...project,ssh:{...project.ssh,host:'new.internal'}};
  const mismatch = await credentials.readMigrationCandidate(project.id,changed);
  assert.equal(mismatch.status,'confirmation-required');
  assert.equal(mismatch.currentBinding.host,'new.internal');
  assert.equal(mismatch.changedFields.host,true);
  assert.equal(mismatch.changedFields.privateKeyPath,false);
  const scope = {projectId:project.id,environmentId:'default',pluginInstanceId:'server-primary'};
  const status = credentials.rememberMigration(scope,mismatch,{expectedRevision:3,pluginBindingHash:'a'.repeat(64)});
  assert.deepEqual(status.fields,{password:true,privateKeyPassphrase:false,proxyPassword:true});
  assert.deepEqual(Object.keys(status.sourceBinding).sort(),[
    'authType','host','port','privateKeyPathConfigured','proxyHost','proxyPort','proxyType','proxyUsername','username',
  ]);
  assert.doesNotMatch(JSON.stringify(status),/legacy-password|legacy-proxy|ciphertext|"privateKeyPath"\s*:\s*"/u);
  assert.equal(Object.hasOwn(status.sourceBinding,'privateKeyPath'),false);
  assert.deepEqual(await fs.readFile(credentials.filePath(project.id)),sourceBefore);
  assert.equal(credentials.invalidatePlugin(project.id,'default','server-primary'),true);
  assert.equal(credentials.migrationStatus(scope),null,'recreating the same scope cannot inherit a stale prompt');
  credentials.rememberMigration(scope,mismatch,{expectedRevision:3,pluginBindingHash:'a'.repeat(64)});
  assert.equal(credentials.invalidateProject(project.id),1);
  assert.equal(credentials.migrationStatus(scope),null);

  const unsafePayload = {
    binding:{...credentialBinding(project),password:'must-not-leak'},
    secrets:{password:'still-secret'},
  };
  const unsafeCiphertext = fakeEncryption.encryptString(JSON.stringify(unsafePayload));
  await fs.writeFile(credentials.filePath(project.id),JSON.stringify({version:2,ciphertext:unsafeCiphertext.toString('base64')}));
  const unsafe = await credentials.readMigrationCandidate(project.id,changed);
  assert.equal(unsafe.status,'unreadable');
  assert.doesNotMatch(JSON.stringify(unsafe),/must-not-leak|still-secret|ciphertext/u);
});
