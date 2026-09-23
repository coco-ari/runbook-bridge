import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createUploadFixture } from '../test/fixtures/upload-ssh-server.mjs';

// 仅使用回环 SSH 和合成数据，比较共享进程内客户端与夹具服务端的总成本。
const MiB = 1024 * 1024, bytes = 8 * MiB, cleanup = [], results = [];
const round = value => Math.round(value * 10) / 10;
const hash = body => crypto.createHash('sha256').update(body).digest('hex');
let fixture;
async function measure(feature, operation) {
  const histogram = monitorEventLoopDelay({ resolution:10 }); histogram.enable(); await delay(25); histogram.reset();
  const socket = fixture.broker.requireSession('fixture').client._sock;
  const received = socket.bytesRead, written = socket.bytesWritten, cpu = process.cpuUsage(), started = performance.now();
  try {
    const value = await operation(), used = process.cpuUsage(cpu);
    const row = { feature, status:'passed', ms:round(performance.now() - started), cpuMs:round((used.user + used.system) / 1000),
      receivedBytes:socket.bytesRead - received, writtenBytes:socket.bytesWritten - written,
      maxEventLoopDelayMs:round(histogram.max / 1e6) };
    results.push(row); console.log(JSON.stringify(row)); return value;
  } catch (error) {
    console.log(JSON.stringify({ feature, status:'failed', code:error.code ?? error.name, actualCode:error.actual?.code, expectedCode:error.expected?.code, operator:error.operator, actual:['boolean','number'].includes(typeof error.actual) ? error.actual : undefined, expected:['boolean','number'].includes(typeof error.expected) ? error.expected : undefined }));
    throw error;
  } finally { histogram.disable(); }
}
try {
  fixture = await createUploadFixture({ after:fn => cleanup.push(fn) }, { capacity:bytes });
  fixture.faults.onClientError = error => console.log(JSON.stringify({ feature:'local-compression.fixture-error', status:'observed', level:['protocol','client-socket'].includes(error.level) ? error.level : 'other', compressionError:/compression|inflate|zlib/i.test(error.message), integrityError:/mac|integrity|decrypt/i.test(error.message), invalidHandle:/handle|channel|stream/i.test(error.message) }));
  const factory = fixture.broker.clientFactory;
  let compressed = false;
  fixture.broker.clientFactory = function() {
    const client = factory.call(this), connect = client.connect;
    client.connect = function(config) { return connect.call(this, { ...config, algorithms:{ ...config.algorithms, compress:compressed ? ['zlib@openssh.com'] : ['none'] } }); };
    client.on('error', error => console.log(JSON.stringify({ feature:'local-compression.connection-error', status:'observed', compressed, level:['protocol','client-socket','client-authentication','client-timeout'].includes(error.level) ? error.level : 'other', compressionError:/compression|inflate|zlib/i.test(error.message), integrityError:/mac|integrity|decrypt/i.test(error.message) })));
    return client;
  };
  const connect = () => fixture.broker.connect('fixture', { password:'fixture-password' });
  const datasets = [
    { kind:'text', body:Buffer.alloc(bytes, 'synthetic repeated operational text\n') },
    { kind:'random', body:crypto.randomBytes(bytes) },
  ];
  for (const dataset of datasets) {
    dataset.source = path.join(fixture.root, dataset.kind + '.bin');
    await fs.writeFile(dataset.source, dataset.body, { flag:'wx' });
    const stats = await fs.stat(dataset.source);
    dataset.condition = { local:{ size:bytes, mtimeMs:stats.mtimeMs, sha256:hash(dataset.body) }, remote:{ exists:false } };
  }
  for (const [index, enabled] of (process.argv.includes('--lifecycle-only') ? [] : [false,true,true,false]).entries()) {
    await fixture.broker.disconnect('fixture'); compressed = enabled; await connect();
    const prefix = 'local-compression.' + (enabled ? 'enabled.' : 'disabled.') + index;
    for (const dataset of datasets) {
      fixture.files.set('/source.bin', dataset.body);
      const downloaded = await measure(prefix + '.' + dataset.kind + '.read', () => fixture.broker.withWorkspaceReadSession('fixture', reader => reader.readBuffer('/source.bin', 0, bytes)));
      assert.equal(downloaded.truncated, false); assert.deepEqual(downloaded.content, dataset.body);
      await measure(prefix + '.' + dataset.kind + '.upload', () => fixture.broker.uploadRemoteFileApproved('fixture', dataset.source, '/target.bin', dataset.condition, { resumable:true }));
      assert.deepEqual(fixture.files.get('/target.bin'), dataset.body);
      assert.equal([...fixture.files.keys()].some(name => name.includes('.part-')), false);
      fixture.files.delete('/source.bin'); fixture.files.delete('/target.bin'); fixture.modes.delete('/target.bin');
    }
  }
  await fixture.broker.disconnect('fixture'); compressed = !process.argv.includes('--no-compression'); await connect();
  const dataset = datasets[1], controller = new AbortController();
  fixture.faults.onWrite = () => controller.abort();
  await measure('local-compression.cancel-upload', async () => {
    await assert.rejects(fixture.broker.uploadRemoteFileApproved('fixture', dataset.source, '/cancel.bin', dataset.condition, { resumable:true, signal:controller.signal }), { code:'TRANSFER_CANCELLED' });
    assert.equal(fixture.files.size, 0); assert.equal(fixture.broker.status('fixture').connected, true);
  });
  fixture.faults.onWrite = null;
  fixture.files.set('/source.bin', dataset.body);
  await measure('local-compression.read-after-cancel', async () => {
    const result = await fixture.broker.withWorkspaceReadSession('fixture', reader => reader.readBuffer('/source.bin', 0, bytes));
    assert.deepEqual(result.content, dataset.body);
  });
  let checkpoint;
  const send = () => fixture.broker.uploadRemoteFileApproved('fixture', dataset.source, '/resume.bin', dataset.condition, { resumable:true, checkpoint, onCheckpoint:value => { checkpoint = value; } });
  fixture.faults.dropAfter = 1.5 * MiB;
  await measure('local-compression.interrupt-upload', async () => { await assert.rejects(send()); assert.equal(checkpoint.bytes, MiB); });
  await connect();
  await measure('local-compression.resume-upload', async () => {
    const before = fixture.counters.writes.length; await send();
    assert.equal(fixture.counters.writes[before].offset, MiB); assert.deepEqual(fixture.files.get('/resume.bin'), dataset.body);
    assert.equal([...fixture.files.keys()].some(name => name.includes('.part-')), false);
  });
} catch (error) { process.exitCode = 1; console.log(JSON.stringify({ status:'failed', code:error.code ?? error.name })); }
finally {
  for (const finalize of cleanup.reverse()) await finalize();
  console.log(JSON.stringify({ status:process.exitCode ? 'failed' : 'finished', passed:results.length, bytesPerTransfer:bytes, localCleanup:true }));
}
