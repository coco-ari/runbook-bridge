import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { SshBroker } from '../../src/ssh-broker.mjs';
const call = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));

export async function createUploadFixture(t, { writeDelayMs = 0, capacity = 0, allowRenameOverwrite = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'runbook-resume-probe-'));
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const publicKey = ssh2.utils.parseKey(key).getPublicSSH();
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
  const files = new Map();
  const clients = new Set();
  const sockets = new Set();
  const counters = { uploaded: 0, downloaded: 0, renames: 0, removes: 0, rmdirs: 0, directoryReads: 0, directoryCloses: 0, probes: 0, pendingWrites: 0, maxPendingWrites: 0, writes: [] };
  const faults = { dropAfter: Infinity, dropRename: false, onWrite: null, beforeRemove: null, beforeRmdir: null, deleteDenied: new Set(), realPaths: new Map(), repeatDirectoryDots: false };
  const modes = new Map();
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    let dropped = false;
    const drop = () => { dropped = true; client._sock.destroy(); };
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (approve, _reject, info) => {
        assert.equal(info.command, 'probe');
        counters.probes += 1;
        const channel = approve(); channel.end('ok'); channel.exit(0);
      });
      session.on('sftp', approve => {
        const sftp = approve();
        sftp.on('error', () => undefined);
        const handles = new Map(); let sequence = 0;
        const attrs = name => ({ mode: modes.get(name) ?? 0o100644, size: files.get(name).length, uid: 1, gid: 1, atime: 1, mtime: 1 });
        const status = (id, code) => { if (!dropped) sftp.status(id, code); };
        const stat = (id, name) => files.has(name) ? sftp.attrs(id, attrs(name)) : status(id, 2);
        sftp.on('LSTAT', stat); sftp.on('STAT', stat);
        sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: faults.realPaths.get(name) ?? name, longname: name, attrs: {} }]));
        sftp.on('OPEN', (id, name, flags, attributes) => {
          if (dropped) return;
          if ((flags & 32) && files.has(name)) return status(id, 4);
          if (!files.has(name) && !(flags & 8)) return status(id, 2);
          if (!files.has(name) || (flags & 16)) { files.set(name, Buffer.alloc(0)); modes.set(name, (attributes.mode ?? 0o644) | 0o100000); }
          const handle = Buffer.from(String(++sequence)); handles.set(handle.toString(), name); sftp.handle(id, handle);
        });
        sftp.on('FSTAT', (id, handle) => stat(id, handles.get(handle.toString())));
        sftp.on('WRITE', (id, handle, offset, data) => {
          if (dropped) return;
          const name = handles.get(handle.toString()); const previous = files.get(name);
          const length = Math.max(previous.length, offset + data.length);
          const next = capacity && previous.buffer.byteLength >= capacity
            ? Buffer.from(previous.buffer, previous.byteOffset, length)
            : Buffer.alloc(Math.max(length, capacity)).subarray(0, length);
          if (next.buffer !== previous.buffer) previous.copy(next);
          data.copy(next, offset); files.set(name, next);
          counters.writes.push({ offset, bytes: data.length });
          counters.pendingWrites += 1;
          counters.maxPendingWrites = Math.max(counters.maxPendingWrites, counters.pendingWrites);
          counters.uploaded += data.length;
          faults.onWrite?.();
          // 模拟已经落盘、回执尚未返回时连接断开，不能只依赖客户端已确认的偏移。
          if (next.length >= faults.dropAfter) { faults.dropAfter = Infinity; drop(); return; }
          const acknowledge = () => { counters.pendingWrites -= 1; status(id, 0); };
          if (writeDelayMs) setTimeout(acknowledge, writeDelayMs); else acknowledge();
        });
        sftp.on('READ', (id, handle, offset, length) => {
          if (dropped) return;
          const data = files.get(handles.get(handle.toString()));
          if (offset >= data.length) return status(id, 1);
          const chunk = data.subarray(offset, offset + length); counters.downloaded += chunk.length; sftp.data(id, chunk);
        });
        sftp.on('CLOSE', (id, handle) => { if (handles.get(handle.toString())?.directory) counters.directoryCloses += 1; handles.delete(handle.toString()); status(id, 0); });
        sftp.on('OPENDIR', (id, name) => {
          if (!files.has(name)) return status(id, 2);
          if ((modes.get(name) & 0o170000) !== 0o40000) return status(id, 4);
          const handle = Buffer.from(String(++sequence)); handles.set(handle.toString(), { directory: name, read: false }); sftp.handle(id, handle);
        });
        sftp.on('READDIR', (id, handle) => {
          counters.directoryReads += 1;
          const current = handles.get(handle.toString());
          if (current.read && !faults.repeatDirectoryDots) return status(id, 1);
          current.read = true;
          const names = [...files.keys()].filter(name => name !== current.directory && path.posix.dirname(name) === current.directory);
          sftp.name(id, ['.', '..'].map(filename => ({ filename, longname: filename, attrs: {} }))
            .concat(names.map(name => ({ filename: path.posix.basename(name), longname: name, attrs: attrs(name) }))));
        });
        sftp.on('REMOVE', (id, name) => {
          counters.removes += 1; faults.beforeRemove?.(name);
          if (faults.deleteDenied.has(name)) return status(id, 3);
          if (!files.has(name)) return status(id, 2);
          if ((modes.get(name) & 0o170000) === 0o40000) return status(id, 4);
          files.delete(name); modes.delete(name); status(id, 0);
        });
        sftp.on('RMDIR', (id, name) => {
          counters.rmdirs += 1; faults.beforeRmdir?.(name);
          if (faults.deleteDenied.has(name)) return status(id, 3);
          if (!files.has(name)) return status(id, 2);
          if ((modes.get(name) & 0o170000) !== 0o40000 || [...files.keys()].some(value => value.startsWith(name + '/'))) return status(id, 4);
          files.delete(name); modes.delete(name); status(id, 0);
        });
        sftp.on('MKDIR', (id, name, attributes) => {
          if (files.has(name)) return status(id, 4);
          files.set(name, Buffer.alloc(0)); modes.set(name, (attributes.mode ?? 0o755) | 0o40000); status(id, 0);
        });
        sftp.on('RENAME', (id, from, to) => {
          if ((!allowRenameOverwrite && files.has(to)) || !files.has(from)) return status(id, 4);
          files.set(to, files.get(from)); modes.set(to,modes.get(from)); files.delete(from); counters.renames += 1;
          if (faults.dropRename) { faults.dropRename = false; drop(); return; }
          status(id, 0);
        });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { limits: { commandTimeoutSeconds: 10 }, ssh: { host: '127.0.0.1', port: server.address().port, username: 'fixture', hostKeyFingerprint: fingerprint }, auth: { type: 'password' }, proxy: { type: 'direct' } };
  const broker = new SshBroker({ get: async () => config, appendAudit: async () => undefined });
  const connect = async () => {
    const client = new ssh2.Client(); sockets.add(client); client.on('error', () => undefined);
    await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture-password', hostVerifier: value => value.equals(publicKey), readyTimeout: 5000 }));
    const sftp = await call(client, 'sftp'); sftp.on('error', () => undefined);
    const interrupted = new AbortController();
    client.once('close', () => interrupted.abort());
    sftp.once('close', () => interrupted.abort());
    sftp.probeSignal = interrupted.signal;
    return { client, sftp };
  };
  t.after(async () => {
    await broker.closeAll();
    for (const client of sockets) client.destroy();
    for (const client of clients) client._sock.destroy();
    await new Promise(resolve => server.close(resolve));
    const checked = path.resolve(root);
    assert.equal(path.dirname(checked), path.resolve(os.tmpdir()));
    assert.ok(path.basename(checked).startsWith('runbook-resume-probe-'));
    await fsp.rm(checked, { recursive: true, force: true });
  });
  return { root, files, modes, counters, faults, broker, connect, fingerprint };
}
