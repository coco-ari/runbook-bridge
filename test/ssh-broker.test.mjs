import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';
import YAML from 'yaml';
import { ProjectStore } from '../src/project-store.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';

const { Server: SshServer } = ssh2;

async function startSshServer(t, { authorizedPublicKey, sftpRoot, connectionTracker, authenticationState } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const allowedKey = authorizedPublicKey ? ssh2.utils.parseKey(authorizedPublicKey) : null;
  const clients = new Set();
  if (connectionTracker) {
    connectionTracker.totalConnections = 0;
    connectionTracker.activeClients = () => clients.size;
    connectionTracker.disconnectAll = () => {
      for (const client of clients) client.end();
    };
  }
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    if (connectionTracker) connectionTracker.totalConnections += 1;
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'password' &&
        ctx.username === 'deploy' &&
        ctx.password === 'test-password' &&
        authenticationState?.allowPassword !== false
      ) ctx.accept();
      else if (
        ctx.method === 'publickey' &&
        ctx.username === 'deploy' &&
        allowedKey &&
        ctx.key.algo === allowedKey.type &&
        ctx.key.data.length === allowedKey.getPublicSSH().length &&
        crypto.timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH()) &&
        (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)
      ) {
        ctx.accept();
      }
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`executed:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
        if (sftpRoot) {
          session.on('sftp', (acceptSftp) => {
            const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
            const handles = new Map();
            let nextHandle = 1;
            const sftp = acceptSftp();
            const resolveRemote = (filename) => {
              const rootPath = path.resolve(sftpRoot);
              const resolved = path.resolve(rootPath, String(filename).replace(/^[/\\]+/, ''));
              if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error('path escape');
              return resolved;
            };
            const handleEntry = (handle) => handles.get(handle.readUInt32BE(0));
            const attrs = (reqid, stats) => sftp.attrs(reqid, {
              mode: stats.mode,
              uid: stats.uid ?? 0,
              gid: stats.gid ?? 0,
              size: stats.size,
              atime: Math.floor(stats.atimeMs / 1000),
              mtime: Math.floor(stats.mtimeMs / 1000),
            });
            const stat = (reqid, filename) => {
              fsSync.stat(resolveRemote(filename), (error, stats) => {
                if (error) sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                else attrs(reqid, stats);
              });
            };
            sftp.on('OPEN', (reqid, filename, flags) => {
              let nodeFlags = 'r';
              if (flags & OPEN_MODE.WRITE) {
                nodeFlags = flags & OPEN_MODE.TRUNC ? 'w' : flags & OPEN_MODE.READ ? 'r+' : 'a';
              }
              const target = resolveRemote(filename);
              fsSync.mkdirSync(path.dirname(target), { recursive: true });
              fsSync.open(target, nodeFlags, 0o600, (error, fd) => {
                if (error) return sftp.status(reqid, STATUS_CODE.FAILURE);
                const id = nextHandle++;
                handles.set(id, { fd });
                const handle = Buffer.alloc(4);
                handle.writeUInt32BE(id);
                sftp.handle(reqid, handle);
              });
            });
            sftp.on('WRITE', (reqid, handle, offset, data) => {
              const entry = handleEntry(handle);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fsSync.write(entry.fd, data, 0, data.length, offset, (error) =>
                sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
            });
            sftp.on('READ', (reqid, handle, offset, length) => {
              const entry = handleEntry(handle);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              const buffer = Buffer.alloc(length);
              fsSync.read(entry.fd, buffer, 0, length, offset, (error, bytesRead) => {
                if (error) sftp.status(reqid, STATUS_CODE.FAILURE);
                else if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF);
                else sftp.data(reqid, buffer.subarray(0, bytesRead));
              });
            });
            sftp.on('FSTAT', (reqid, handle) => {
              const entry = handleEntry(handle);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fsSync.fstat(entry.fd, (error, stats) => {
                if (error) sftp.status(reqid, STATUS_CODE.FAILURE);
                else attrs(reqid, stats);
              });
            });
            sftp.on('CLOSE', (reqid, handle) => {
              const id = handle.readUInt32BE(0);
              const entry = handles.get(id);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              handles.delete(id);
              fsSync.close(entry.fd, (error) => sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
            });
            sftp.on('STAT', stat).on('LSTAT', stat);
            sftp.on('RENAME', (reqid, from, to) => {
              fsSync.rename(resolveRemote(from), resolveRemote(to), (error) =>
                sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
            });
            sftp.on('REMOVE', (reqid, filename) => {
              fsSync.unlink(resolveRemote(filename), (error) =>
                sftp.status(reqid, error ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.OK));
            });
            sftp.on('REALPATH', (reqid, filename) => {
              sftp.name(reqid, [{ filename, longname: filename, attrs: {} }]);
            });
          });
        }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    for (const client of clients) client.end();
    server.close(resolve);
  }));
  return server.address().port;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not reached before timeout');
}

test('SSH broker confirms host key, executes through the live session, and revokes on disconnect', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-ssh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await startSshServer(t);
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'local-ssh',
    name: '本地 SSH 测试',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  let required;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      required = error;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED' && error.details?.fingerprint?.startsWith('SHA256:');
    },
  );
  const connected = await broker.connect(project.id, {
    password: 'test-password',
    acceptHostKey: required.details.fingerprint,
  });
  assert.equal(connected.connected, true);
  assert.equal((await store.get(project.id)).ssh.hostKeyFingerprint, required.details.fingerprint);
  const { docsHash } = await store.readContext(project.id);
  const { contextToken } = await broker.openContext(project.id, docsHash);
  const executed = await broker.execute(project.id, contextToken, 'printf hello', '/srv/example dir');
  assert.equal(executed.exitCode, 0);
  assert.match(executed.stdout, /executed:cd -- '\/srv\/example dir' && printf hello/);
  await broker.disconnect(project.id);
  await assert.rejects(
    () => broker.execute(project.id, contextToken, 'whoami'),
    (error) => error.code === 'SSH_NOT_CONNECTED',
  );
});

test('SSH broker authenticates with an encrypted private key without persisting its passphrase', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const passphrase = 'temporary-passphrase';
  const { private: privateKey, public: publicKey } = ssh2.utils.generateKeyPairSync('ed25519', {
    passphrase,
    cipher: 'aes256-ctr',
  });
  const keyPath = path.join(root, 'deploy-key.pem');
  await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
  const port = await startSshServer(t, { authorizedPublicKey: publicKey });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'private-key-ssh',
    name: '私钥 SSH 测试',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'privateKey', privateKeyPath: keyPath },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  await assert.rejects(
    () => broker.connect(project.id, { privateKeyPassphrase: 'wrong-passphrase' }),
    (error) => error.code === 'SSH_IDENTITY_UNAVAILABLE',
  );
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { privateKeyPassphrase: passphrase }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { privateKeyPassphrase: passphrase, acceptHostKey: fingerprint });
  assert.equal(broker.status(project.id).connected, true);
  const rawConfig = await fs.readFile(path.join(root, 'projects', project.id, 'project.yaml'), 'utf8');
  assert.doesNotMatch(rawConfig, /temporary-passphrase/);
  await broker.disconnect(project.id);
});

test('SSH broker streams uploads and downloads through SFTP', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'logs'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await startSshServer(t, { sftpRoot: remoteRoot });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'sftp-project',
    name: 'SFTP 测试',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint });
  const { docsHash } = await store.readContext(project.id);
  const { contextToken } = await broker.openContext(project.id, docsHash);
  const localArtifact = path.join(root, 'app.jar');
  await fs.writeFile(localArtifact, Buffer.from('fake-jar-content'));
  const uploaded = await broker.upload(project.id, contextToken, localArtifact, '/releases/app.jar');
  assert.equal(uploaded.sizeBytes, 16);
  assert.equal(await fs.readFile(path.join(remoteRoot, 'releases', 'app.jar'), 'utf8'), 'fake-jar-content');
  await fs.writeFile(path.join(remoteRoot, 'logs', 'start.log'), 'Started DemoApplication\n');
  const downloaded = await broker.download(project.id, contextToken, '/logs/start.log');
  assert.equal(await fs.readFile(downloaded.localPath, 'utf8'), 'Started DemoApplication\n');
  assert.equal(downloaded.sizeBytes, 24);
  await broker.disconnect(project.id);
});

test('structured log search accepts explicit absolute files and returns bounded context metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-log-search-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(remoteRoot, 'logs', 'app.log'),
    ['INFO boot', 'request order-42 accepted', `WARN ${'x'.repeat(9_000)}`, 'order-42 completed', 'INFO done'].join('\n'),
  );
  await fs.mkdir(path.join(remoteRoot, 'archive'), { recursive: true });
  await fs.writeFile(path.join(remoteRoot, 'archive', 'old.log'), 'archived order-42\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await startSshServer(t, { sftpRoot: remoteRoot });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'log-search-project',
    name: '日志搜索测试',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const configPath = path.join(root, 'projects', project.id, 'project.yaml');
  const legacyConfig = YAML.parse(await fs.readFile(configPath, 'utf8'));
  legacyConfig.diagnostics = { allowedLogRoots: ['/logs'] };
  await fs.writeFile(configPath, YAML.stringify(legacyConfig), 'utf8');
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint });
  const { docsHash } = await store.readContext(project.id);
  const { contextToken } = await broker.openContext(project.id, docsHash);
  const result = await broker.searchLogs(project.id, contextToken, {
    files: ['/logs/app.log'],
    keywords: ['order-42'],
    beforeLines: 1,
    afterLines: 1,
    pageSize: 1,
  });
  assert.equal(result.summary.totalMatches, 2);
  assert.equal(result.summary.lineNumberScope, 'scanned_snapshot');
  assert.equal('displayTimezone' in result.summary, false);
  assert.equal('timeNormalization' in result.summary, false);
  assert.equal(result.contexts.length, 1);
  assert.match(result.contexts[0].lines.map((line) => line.text).join('\n'), /order-42/);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.outputTruncated, true);
  assert.equal(result.summary.truncation.sourceTruncated, false);
  assert.equal(result.summary.firstMatch.text, undefined);
  assert.equal(result.summary.lastMatch.text, undefined);
  assert.equal(result.summary.snapshots[0].firstMatch.text, undefined);
  assert.equal(result.summary.matchTextIncludedInSummary, false);
  assert.equal(result.contexts[0].lines.some((line) => line.textTruncated), true);
  const legacyWhitelistIgnored = await broker.searchLogs(project.id, contextToken, {
    files: ['/archive/old.log'],
    keywords: ['order-42'],
  });
  assert.equal(legacyWhitelistIgnored.summary.totalMatches, 1);
  await assert.rejects(
    () => broker.searchLogs(project.id, contextToken, {
      files: ['logs/app.log'],
      keywords: ['order-42'],
    }),
    (error) => error.code === 'PATH_INVALID',
  );
  await broker.disconnect(project.id);
});

test('unexpected SSH loss reconnects automatically and a user disconnect cancels future retries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-auto-reconnect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = {};
  const port = await startSshServer(t, { connectionTracker: tracker });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'auto-reconnect',
    name: '自动重连测试',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const broker = new SshBroker(store, { reconnectDelaysMs: [10, 20] });
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint });
  broker.setReconnectHandler((projectId) =>
    broker.connectAutomatically(projectId, { password: 'test-password' }));
  broker.enableAutoReconnect(project.id);
  const firstGeneration = broker.status(project.id).generation;

  tracker.disconnectAll();
  await waitFor(() => broker.status(project.id).reconnecting);
  assert.equal(broker.status(project.id).connected, false);
  await waitFor(() => broker.status(project.id).connected);
  assert.ok(broker.status(project.id).generation > firstGeneration);
  assert.ok(tracker.totalConnections >= 3);

  tracker.disconnectAll();
  await waitFor(() => broker.status(project.id).reconnecting);
  const connectionsBeforeStop = tracker.totalConnections;
  await broker.disconnect(project.id, 'user');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(broker.status(project.id), {
    connected: false,
    connecting: false,
    reconnecting: false,
    reconnectStopped: false,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    reconnectErrorCode: null,
    autoReconnectEnabled: false,
    generation: broker.status(project.id).generation,
    connectedAt: null,
  });
  assert.equal(tracker.totalConnections, connectionsBeforeStop);
});

test('automatic reconnect stops after SSH authentication is rejected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-auth-reconnect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = {};
  const authenticationState = { allowPassword: true };
  const port = await startSshServer(t, { connectionTracker: tracker, authenticationState });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'auth-reconnect',
    name: '认证失败停止重连',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
    credentials: { remember: true },
  });
  const broker = new SshBroker(store, { reconnectDelaysMs: [10, 20] });
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint });
  broker.setReconnectHandler((projectId) =>
    broker.connectAutomatically(projectId, { password: 'test-password' }));
  broker.enableAutoReconnect(project.id);

  authenticationState.allowPassword = false;
  tracker.disconnectAll();
  await waitFor(() => broker.status(project.id).reconnectStopped);
  const stopped = broker.status(project.id);
  assert.equal(stopped.connected, false);
  assert.equal(stopped.reconnecting, false);
  assert.equal(stopped.reconnectStopped, true);
  assert.equal(stopped.reconnectErrorCode, 'SSH_AUTH_FAILED');
  assert.equal(stopped.autoReconnectEnabled, false);
  const connectionsAfterStop = tracker.totalConnections;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(tracker.totalConnections, connectionsAfterStop);

  const audit = (await fs.readFile(path.join(root, 'projects', project.id, 'audit', 'operations.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) =>
    entry.type === 'auto-reconnect' &&
    entry.result === 'stopped' &&
    entry.errorCode === 'SSH_AUTH_FAILED' &&
    entry.retryable === false));
});

test('concurrent connects leave at most one managed SSH client and disconnect revokes it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-concurrent-ssh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = {};
  const port = await startSshServer(t, { connectionTracker: tracker });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'concurrent-ssh',
    name: '并发 SSH',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint });
  const results = await Promise.allSettled([
    broker.connect(project.id, { password: 'test-password' }),
    broker.connect(project.id, { password: 'test-password' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tracker.activeClients(), 1);
  await broker.disconnect(project.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tracker.activeClients(), 0);
});

test('audit storage failure does not turn an already completed command into a retryable failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-audit-warning-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await startSshServer(t);
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'audit-warning',
    name: '审计告警',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  const connected = await broker.connect(project.id, {
    password: 'test-password',
    acceptHostKey: fingerprint,
  });
  assert.equal(connected.connected, true);
  const { docsHash } = await store.readContext(project.id);
  const { contextToken } = await broker.openContext(project.id, docsHash);
  store.appendAudit = async () => { throw new Error('simulated disk failure'); };
  const result = await broker.execute(project.id, contextToken, 'printf once');
  assert.equal(result.exitCode, 0);
  assert.equal(result.auditWarning, true);
  await broker.disconnect(project.id);
});

test('host-key persistence failure closes the ready SSH client instead of leaking a session', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-persistence-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = {};
  const port = await startSshServer(t, { connectionTracker: tracker });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'persistence-failure',
    name: '持久化失败',
    ssh: { host: '127.0.0.1', port, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password' }),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  store.update = async () => { throw new Error('simulated config write failure'); };
  await assert.rejects(
    () => broker.connect(project.id, { password: 'test-password', acceptHostKey: fingerprint }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(broker.status(project.id).connected, false);
  assert.equal(tracker.activeClients(), 0);
});
