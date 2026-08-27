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

async function startSshServer(t, {
  authorizedPublicKey,
  sftpRoot,
  connectionTracker,
  authenticationState,
  sftpCloseDelayMs = 0,
  sftpReadDelayMs = 0,
  maxSftpReadBytes = null,
  sftpEofAtOffset = null,
  sftpDirectoryEntries = null,
  sftpDirectoryBatchSize = 128,
  onFirstSftpRead = null,
  disconnectAfterSftpReads = null,
  sftpTracker,
} = {}) {
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
            let readRequests = 0;
            let firstReadObserved = false;
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
                handles.set(id, { fd, path:target });
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
              readRequests += 1;
              if (sftpTracker) {
                sftpTracker.readRequests = (sftpTracker.readRequests ?? 0) + 1;
                sftpTracker.readOffsets = [...(sftpTracker.readOffsets ?? []), offset];
                sftpTracker.requestedReadLengths = [...(sftpTracker.requestedReadLengths ?? []), length];
              }
              if (
                Number.isInteger(disconnectAfterSftpReads) &&
                readRequests > disconnectAfterSftpReads
              ) {
                const id = handle.readUInt32BE(0);
                const entry = handles.get(id);
                if (sftpTracker) sftpTracker.readDisconnects = (sftpTracker.readDisconnects ?? 0) + 1;
                if (!entry) {
                  client.end();
                  return;
                }
                handles.delete(id);
                fsSync.close(entry.fd, () => client.end());
                return;
              }
              const entry = handleEntry(handle);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (!firstReadObserved) {
                firstReadObserved = true;
                onFirstSftpRead?.(entry.path);
              }
              if (Number.isInteger(sftpEofAtOffset) && offset >= sftpEofAtOffset) {
                sftp.status(reqid, STATUS_CODE.EOF);
                return;
              }
              const eofBoundedLength = Number.isInteger(sftpEofAtOffset)
                ? Math.min(length, sftpEofAtOffset - offset)
                : length;
              const boundedLength = Number.isInteger(maxSftpReadBytes)
                ? Math.min(eofBoundedLength, maxSftpReadBytes)
                : eofBoundedLength;
              if (boundedLength <= 0) {
                sftp.status(reqid, STATUS_CODE.EOF);
                return;
              }
              const buffer = Buffer.alloc(boundedLength);
              if (sftpTracker) {
                sftpTracker.activeReads = (sftpTracker.activeReads ?? 0) + 1;
                sftpTracker.maxActiveReads = Math.max(sftpTracker.maxActiveReads ?? 0, sftpTracker.activeReads);
              }
              const respond = () => fsSync.read(entry.fd, buffer, 0, boundedLength, offset, (error, bytesRead) => {
                if (sftpTracker) sftpTracker.activeReads -= 1;
                if (error) sftp.status(reqid, STATUS_CODE.FAILURE);
                else if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF);
                else sftp.data(reqid, buffer.subarray(0, bytesRead));
              });
              if (sftpReadDelayMs > 0) setTimeout(respond, sftpReadDelayMs);
              else respond();
            });
            sftp.on('FSTAT', (reqid, handle) => {
              const entry = handleEntry(handle);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fsSync.fstat(entry.fd, (error, stats) => {
                if (error) sftp.status(reqid, STATUS_CODE.FAILURE);
                else attrs(reqid, stats);
              });
            });
            sftp.on('OPENDIR', (reqid, filename) => {
              const target = resolveRemote(filename);
              const openDirectory = (directoryEntries) => {
                const id = nextHandle++;
                handles.set(id, { directoryEntries, directoryOffset:0 });
                const handle = Buffer.alloc(4);
                handle.writeUInt32BE(id);
                if (sftpTracker) sftpTracker.openDirectoryRequests = (sftpTracker.openDirectoryRequests ?? 0) + 1;
                sftp.handle(reqid, handle);
              };
              if (Array.isArray(sftpDirectoryEntries)) {
                openDirectory(sftpDirectoryEntries.map((value) => {
                  const filename = typeof value === 'string' ? value : value.filename;
                  return {
                    filename,
                    longname:filename,
                    attrs:{
                      mode:value.mode ?? 0o100644,
                      uid:value.uid ?? 0,
                      gid:value.gid ?? 0,
                      size:value.size ?? 0,
                      atime:value.atime ?? 0,
                      mtime:value.mtime ?? 0,
                    },
                  };
                }));
                return;
              }
              fsSync.readdir(target, { withFileTypes:true }, (error, dirents) => {
                if (error) {
                  sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                  return;
                }
                const directoryEntries = dirents.map((dirent) => {
                  const stats = fsSync.lstatSync(path.join(target, dirent.name));
                  return {
                    filename:dirent.name,
                    longname:dirent.name,
                    attrs:{
                      mode:stats.mode,
                      uid:stats.uid ?? 0,
                      gid:stats.gid ?? 0,
                      size:stats.size,
                      atime:Math.floor(stats.atimeMs / 1000),
                      mtime:Math.floor(stats.mtimeMs / 1000),
                    },
                  };
                });
                openDirectory(directoryEntries);
              });
            });
            sftp.on('READDIR', (reqid, handle) => {
              const entry = handleEntry(handle);
              if (!entry?.directoryEntries) {
                sftp.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              if (sftpTracker) sftpTracker.readDirectoryRequests = (sftpTracker.readDirectoryRequests ?? 0) + 1;
              if (entry.directoryOffset >= entry.directoryEntries.length) {
                sftp.status(reqid, STATUS_CODE.EOF);
                return;
              }
              const names = entry.directoryEntries.slice(
                entry.directoryOffset,
                entry.directoryOffset + sftpDirectoryBatchSize,
              );
              entry.directoryOffset += names.length;
              if (sftpTracker) {
                sftpTracker.directoryEntriesReturned = (sftpTracker.directoryEntriesReturned ?? 0) + names.length;
              }
              sftp.name(reqid, names);
            });
            sftp.on('CLOSE', (reqid, handle) => {
              if (sftpTracker) sftpTracker.closeRequests = (sftpTracker.closeRequests ?? 0) + 1;
              const id = handle.readUInt32BE(0);
              const entry = handles.get(id);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              handles.delete(id);
              if (entry.directoryEntries) {
                const respond = () => {
                  if (sftpTracker) sftpTracker.closeResponses = (sftpTracker.closeResponses ?? 0) + 1;
                  sftp.status(reqid, STATUS_CODE.OK);
                };
                if (sftpCloseDelayMs > 0) setTimeout(respond, sftpCloseDelayMs);
                else respond();
                return;
              }
              fsSync.close(entry.fd, (error) => {
                const respond = () => {
                  if (sftpTracker) sftpTracker.closeResponses = (sftpTracker.closeResponses ?? 0) + 1;
                  sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
                };
                if (sftpCloseDelayMs > 0) setTimeout(respond, sftpCloseDelayMs);
                else respond();
              });
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

function monitorProcessErrors(t) {
  const errors = [];
  const onUncaughtException = (error) => errors.push(error);
  const onUnhandledRejection = (reason) => errors.push(reason);
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => {
    process.removeListener('uncaughtExceptionMonitor', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  });
  return errors;
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
  const localStats = await fs.lstat(localArtifact);
  const localSha256 = crypto.createHash('sha256').update(await fs.readFile(localArtifact)).digest('hex');
  await broker.uploadRemoteFileApproved(project.id, localArtifact, '/releases/approved.jar', {
    local:{size:localStats.size,mtimeMs:localStats.mtimeMs,sha256:localSha256},
    remote:{exists:false,path:'/releases/approved.jar'},
  });
  assert.equal(await fs.readFile(path.join(remoteRoot, 'releases', 'approved.jar'), 'utf8'), 'fake-jar-content');
  const writeContent='server.port=8080\npassword=visible\n';
  const writeBuffer=Buffer.from(writeContent);
  await broker.writeRemoteFileApproved(project.id, '/releases/application.conf', writeContent, {
    remote:{exists:false,path:'/releases/application.conf'}, bytes:writeBuffer.length,
    newSha256:crypto.createHash('sha256').update(writeBuffer).digest('hex'),
  });
  const sourceSnapshot=await broker.statRemotePath(project.id,'/releases/application.conf');
  await broker.moveRemotePathApproved(project.id,'/releases/application.conf','/releases/application-moved.conf',{
    source:sourceSnapshot,destination:{exists:false,path:'/releases/application-moved.conf'},
  });
  const movedSnapshot=await broker.statRemotePath(project.id,'/releases/application-moved.conf');
  await broker.deleteRemotePathApproved(project.id,'/releases/application-moved.conf',{remote:movedSnapshot});
  await assert.rejects(()=>fs.stat(path.join(remoteRoot,'releases','application-moved.conf')),(error)=>error.code==='ENOENT');
  await fs.writeFile(path.join(remoteRoot, 'logs', 'start.log'), 'Started DemoApplication\n');
  const downloaded = await broker.download(project.id, contextToken, '/logs/start.log');
  assert.equal(await fs.readFile(downloaded.localPath, 'utf8'), 'Started DemoApplication\n');
  assert.equal(downloaded.sizeBytes, 24);
  await broker.disconnect(project.id);
});

test('remote read sessions expose bounded Buffer ranges and preserve text reads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-buffer-range-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'files'), { recursive: true });
  const payload = Buffer.allocUnsafe(200_000);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) % 256;
  await fs.writeFile(path.join(remoteRoot, 'files', 'payload.bin'), payload);
  await fs.writeFile(path.join(remoteRoot, 'files', 'app.log'), 'alpha\nbeta\ngamma\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sftpTracker = {};
  const port = await startSshServer(t, {
    sftpRoot:remoteRoot,
    maxSftpReadBytes:4_096,
    sftpReadDelayMs:5,
    sftpTracker,
  });
  const store = new ProjectStore(root);
  const project = await store.create({
    id:'buffer-range-project',
    name:'二进制范围读取测试',
    ssh:{host:'127.0.0.1',port,username:'deploy'},
    auth:{type:'password'},
    proxy:{type:'direct'},
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id,{password:'test-password'}),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id,{password:'test-password',acceptHostKey:fingerprint});

  const sessionResult = await broker.withRemoteReadSession(project.id, async (reader) => {
    assert.equal(reader.generation, broker.status(project.id).generation);
    assert.equal(typeof reader.statPath, 'function');
    assert.equal(typeof reader.readBuffer, 'function');
    const snapshot = await reader.statPath('/files/payload.bin');
    const binary = await reader.readBuffer('/files/payload.bin', 17, 140_000);
    const text = await reader.readRange('/files/app.log', 0, 1_024);
    await assert.rejects(
      () => reader.readBuffer('/files/payload.bin', 0, 64 * 1024 * 1024 + 1),
      (error) => error.code === 'INVALID_ARGUMENT' && error.details?.maxBytes === 64 * 1024 * 1024,
    );
    await assert.rejects(
      () => reader.readBuffer('/files', 0, 16),
      (error) => error.code === 'SOURCE_NOT_ALLOWED',
    );
    return {snapshot,binary,text};
  });

  assert.equal(sessionResult.snapshot.type, 'file');
  assert.equal(sessionResult.snapshot.size, payload.length);
  assert.equal(Buffer.isBuffer(sessionResult.binary.content), true);
  assert.deepEqual(sessionResult.binary.content, payload.subarray(17, 140_017));
  assert.equal(sessionResult.binary.canonicalPath, '/files/payload.bin');
  assert.equal(sessionResult.binary.startByte, 17);
  assert.equal(sessionResult.binary.endByte, 140_017);
  assert.equal(sessionResult.binary.size, payload.length);
  assert.equal(sessionResult.binary.truncated, true);
  assert.equal(typeof sessionResult.binary.mtime, 'number');
  assert.equal(sessionResult.text.content, 'alpha\nbeta\ngamma\n');
  assert.equal(typeof sessionResult.text.content, 'string');
  assert.ok(sftpTracker.maxActiveReads > 1);
  assert.equal(sftpTracker.closeRequests, 2);
  assert.equal(sftpTracker.closeResponses, 2);

  const tail = await broker.readRemoteBuffer(project.id, '/files/payload.bin', 199_990, 64);
  assert.deepEqual(tail.content, payload.subarray(199_990));
  assert.equal(tail.startByte, 199_990);
  assert.equal(tail.endByte, payload.length);
  assert.equal(tail.truncated, false);
  await broker.disconnect(project.id);
});

test('remote directory listing stops after the 10001st entry and closes its handle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-bounded-directory-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'logs'), { recursive:true });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const sftpTracker = {};
  const directoryEntries = Array.from({length:20_000}, (_, index) => ({
    filename:`entry-${String(index).padStart(5, '0')}.log`,
    size:index,
  }));
  const port = await startSshServer(t, {
    sftpRoot:remoteRoot,
    sftpDirectoryEntries:directoryEntries,
    sftpDirectoryBatchSize:128,
    sftpTracker,
  });
  const store = new ProjectStore(root);
  const project = await store.create({
    id:'bounded-directory-project',
    name:'目录分页上限测试',
    ssh:{host:'127.0.0.1',port,username:'deploy'},
    auth:{type:'password'},
    proxy:{type:'direct'},
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id,{password:'test-password'}),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id,{password:'test-password',acceptHostKey:fingerprint});

  const result = await broker.listRemoteDirectory(project.id, '/logs', {offset:9_995,limit:10});
  assert.deepEqual(
    result.map((entry) => entry.name),
    ['entry-09995.log', 'entry-09996.log', 'entry-09997.log', 'entry-09998.log', 'entry-09999.log'],
  );
  assert.equal(result.totalEntries, 10_001);
  assert.equal(result.hasMoreWithinCap, false);
  assert.equal(result.sourceTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(sftpTracker.openDirectoryRequests, 1);
  assert.ok(sftpTracker.directoryEntriesReturned >= 10_001);
  assert.ok(sftpTracker.directoryEntriesReturned < directoryEntries.length);
  assert.equal(sftpTracker.closeRequests, 1);
  assert.equal(sftpTracker.closeResponses, 1);
  await broker.disconnect(project.id);
});

test('binary range reads reject metadata changes that occur after the initial stat', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-buffer-changed-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'files'), { recursive:true });
  await fs.writeFile(path.join(remoteRoot, 'files', 'changing.bin'), Buffer.alloc(100_000, 0x41));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const sftpTracker = {};
  const port = await startSshServer(t, {
    sftpRoot:remoteRoot,
    onFirstSftpRead:(target) => fsSync.appendFileSync(target, Buffer.from([0x42])),
    sftpTracker,
  });
  const store = new ProjectStore(root);
  const project = await store.create({
    id:'buffer-changed-project',
    name:'二进制变化测试',
    ssh:{host:'127.0.0.1',port,username:'deploy'},
    auth:{type:'password'},
    proxy:{type:'direct'},
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id,{password:'test-password'}),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id,{password:'test-password',acceptHostKey:fingerprint});

  await assert.rejects(
    () => broker.readRemoteBuffer(project.id, '/files/changing.bin', 0, 50_000),
    (error) => error.code === 'SOURCE_CHANGED' && error.details?.path === '/files/changing.bin',
  );
  assert.equal(sftpTracker.closeRequests, 1);
  assert.equal(sftpTracker.closeResponses, 1);
  await broker.disconnect(project.id);
});

test('binary range reads reject an early EOF as a concurrent source change', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-buffer-eof-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'files'), { recursive: true });
  const payload = Buffer.alloc(180_000, 0x5a);
  await fs.writeFile(path.join(remoteRoot, 'files', 'changing.bin'), payload);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sftpTracker = {};
  const eofAt = 70_123;
  const port = await startSshServer(t, {sftpRoot:remoteRoot,sftpEofAtOffset:eofAt,sftpTracker});
  const store = new ProjectStore(root);
  const project = await store.create({
    id:'buffer-eof-project',
    name:'二进制 EOF 测试',
    ssh:{host:'127.0.0.1',port,username:'deploy'},
    auth:{type:'password'},
    proxy:{type:'direct'},
  });
  const broker = new SshBroker(store);
  let fingerprint;
  await assert.rejects(
    () => broker.connect(project.id,{password:'test-password'}),
    (error) => {
      fingerprint = error.details?.fingerprint;
      return error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED';
    },
  );
  await broker.connect(project.id,{password:'test-password',acceptHostKey:fingerprint});

  await assert.rejects(
    () => broker.readRemoteBuffer(project.id, '/files/changing.bin', 0, 150_000),
    (error) => error.code === 'SOURCE_CHANGED' && error.details?.path === '/files/changing.bin',
  );
  assert.ok(sftpTracker.readOffsets.includes(eofAt));
  assert.ok(sftpTracker.readOffsets.some((offset) => offset > eofAt));
  assert.equal(sftpTracker.closeRequests, 1);
  assert.equal(sftpTracker.closeResponses, 1);
  await broker.disconnect(project.id);
});

test('SSH broker reports an unavailable SFTP subsystem without leaking INTERNAL_ERROR', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-sftp-unavailable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const port = await startSshServer(t);
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'sftp-unavailable-project',
    name: 'SFTP 不可用测试',
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

  await assert.rejects(
    () => broker.listRemoteDirectory(project.id, '/var/log/app'),
    (error) => error.code === 'SFTP_UNAVAILABLE' && error.code !== 'INTERNAL_ERROR',
  );
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

test('structured log search waits for a delayed SFTP CLOSE response without a late process error', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-log-close-delay-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'logs'), { recursive: true });
  await fs.writeFile(path.join(remoteRoot, 'logs', 'app.log'), 'INFO boot\norder-42 completed\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sftpTracker = {};
  const closeDelayMs = 80;
  const port = await startSshServer(t, {
    sftpRoot: remoteRoot,
    sftpCloseDelayMs: closeDelayMs,
    sftpTracker,
  });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'log-close-delay',
    name: '日志关闭延迟测试',
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
  const processErrors = monitorProcessErrors(t);

  const result = await broker.searchLogs(project.id, contextToken, {
    files: ['/logs/app.log'],
    keywords: ['order-42'],
  });

  assert.equal(result.summary.totalMatches, 1);
  assert.equal(sftpTracker.closeRequests, 1);
  assert.equal(sftpTracker.closeResponses, 1);
  await new Promise((resolve) => setTimeout(resolve, closeDelayMs * 2));
  assert.deepEqual(processErrors, []);
  await broker.disconnect(project.id);
});

test('mid-read SSH loss returns TRANSFER_INTERRUPTED without hanging and releases log-search state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-log-read-loss-'));
  const remoteRoot = path.join(root, 'remote');
  await fs.mkdir(path.join(remoteRoot, 'logs'), { recursive: true });
  await fs.writeFile(path.join(remoteRoot, 'logs', 'large.log'), Buffer.alloc(150_000, 0x61));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sftpTracker = {};
  const port = await startSshServer(t, {
    sftpRoot: remoteRoot,
    disconnectAfterSftpReads: 1,
    sftpTracker,
  });
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'log-read-loss',
    name: '日志读取中断测试',
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
  const processErrors = monitorProcessErrors(t);
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('log search did not settle after the SSH connection closed')), 3_000);
  });

  try {
    await assert.rejects(
      Promise.race([
        broker.searchLogs(project.id, contextToken, {
          files: ['/logs/large.log'],
          keywords: ['needle'],
        }),
        deadline,
      ]),
      (error) => error.code === 'TRANSFER_INTERRUPTED',
    );
  } finally {
    clearTimeout(deadlineTimer);
  }

  assert.ok(sftpTracker.readRequests >= 2);
  assert.ok(sftpTracker.readDisconnects >= 1);
  assert.equal(broker.activeLogSearchProjects.has(project.id), false);
  assert.equal(broker.activeLogSearchCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(processErrors, []);
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
