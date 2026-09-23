import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// 仅通过产品四个只读 Docker 接口验收，业务内容和容器标识只留在内存。
export async function probeDockerReadOnly({ runtime, operations, plugin, scope, owner, measure }) {
  const manager = operations.docker, client = runtime.broker.requireSession(runtime.key(plugin)).client;
  const originalExec = client.exec, inFlight = new Set(), channels = new Set();
  let execCount = 0, onOpened = null;
  const waitFor = async predicate => {
    for (let index = 0; index < 900 && !predicate(); index++) await delay(10);
    if (!predicate()) throw Object.assign(new Error('Docker 后台测量超过观察时限。'), { code:'PROBE_DEADLINE' });
  };
  client.exec = function(command, options, callback) {
    execCount += 1;
    return originalExec.call(this, command, options, (error, stream) => {
      if (stream) {
        channels.add(stream);
        stream.once('close', () => channels.delete(stream));
      }
      callback(error, stream);
      if (stream && onOpened) { const notify = onOpened; onOpened = null; notify(); }
    });
  };
  const read = (payload, selectedOwner = owner) => {
    const pending = manager.read(selectedOwner, { ...scope, ...payload });
    inFlight.add(pending);
    pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  };
  const connected = () => assert.equal(runtime.status(plugin).connected, true);
  try {
    const first = await measure('docker.list.first', () => read({ kind:'list', limit:1 }));
    assert.ok(first.total <= 1000);
    const items = [...first.items];
    if (first.nextCursor) {
      await measure('docker.list.snapshot-pages', async () => {
        const reads = execCount;
        let cursor = first.nextCursor, pages = 0;
        while (cursor) {
          assert.ok(pages++ < 6, '分页不能超出一千条的快照上限');
          const page = await read({ kind:'list', limit:200, cursor });
          assert.equal(page.sampledAt, first.sampledAt); assert.equal(page.total, first.total);
          items.push(...page.items); cursor = page.nextCursor;
        }
        assert.equal(execCount, reads, '续页不再次访问服务器');
        assert.equal(items.length, first.total); assert.equal(new Set(items.map(item => item.id)).size, items.length);
      });
      await measure('docker.list.cursor-owner', async () => {
        const reads = execCount;
        await assert.rejects(read({ kind:'list', cursor:first.nextCursor }, owner + '-other'), { code:'DOCKER_CURSOR_EXPIRED' });
        assert.equal(execCount, reads);
      });
    } else console.log(JSON.stringify({ feature:'docker.list.snapshot-pages', status:'not-covered', reason:'fewer-than-two-containers' }));
    for (let index = 0; index < 2; index++) await measure('docker.list.refresh.' + index, async () => {
      const page = await read({ kind:'list', limit:200 });
      assert.ok(page.items.length <= 200); assert.ok(page.total <= 1000);
    });
    await measure('docker.parameters.reject-before-exec', async () => {
      const reads = execCount;
      for (const payload of [{ kind:'list', limit:201 }, { kind:'inspect', containerId:'invalid' }, { kind:'logs', containerId:'a'.repeat(64), maxBytes:0 }]) {
        await assert.rejects(read(payload), { code:'INVALID_ARGUMENT' });
      }
      assert.equal(execCount, reads);
    });
    const missingId = crypto.randomBytes(32).toString('hex');
    assert.ok(!items.some(item => item.id === missingId));
    for (const kind of ['inspect', 'stats', 'logs']) await measure('docker.missing.' + kind, async () => {
      await assert.rejects(read({ kind, containerId:missingId, ...(kind === 'logs' ? { lines:1, maxBytes:64 } : {}) }), { code:'DOCKER_CONTAINER_NOT_FOUND' });
      connected();
    });
    const containerId = items.find(item => item.state === 'running')?.id;
    if (!containerId) {
      console.log(JSON.stringify({ feature:'docker.details-and-cancel', status:'not-covered', reason:'no-running-container' }));
      return;
    }
    await measure('docker.inspect.identity', async () => {
      const result = await read({ kind:'inspect', containerId });
      assert.equal(result.id, containerId);
      assert.equal(Object.hasOwn(result, 'Env'), false); assert.equal(Object.hasOwn(result, 'Config'), false);
    });
    await measure('docker.stats.single-sample', async () => {
      const result = await read({ kind:'stats', containerId });
      assert.equal(typeof result.available, 'boolean');
      if (result.available) assert.equal(typeof result.cpu, 'string');
    });
    await measure('docker.logs.bounded', async () => {
      const result = await read({ kind:'logs', containerId, lines:10, maxBytes:1024 });
      // UTF-8 边界的替换字符最多额外占两个字节，原始读取预算仍严格受限。
      assert.ok(Buffer.byteLength(result.content) <= 1026); assert.equal(result.maxBytes, 1024);
    });
    await measure('docker.cancel.open-channel', async () => {
      let opened = false;
      onOpened = () => { opened = true; };
      const requestId = 'probe-open-channel';
      const pending = read({ kind:'stats', containerId, requestId });
      const rejected = assert.rejects(pending, { code:'DOCKER_CANCELLED' }); rejected.catch(() => undefined);
      try {
        await waitFor(() => opened);
        const record = [...manager.pending.values()].find(item => item.key.endsWith('"' + requestId + '"]'));
        assert.ok(record);
        manager.cancel(owner + '-other', { ...scope, requestId });
        assert.equal(record.controller.signal.aborted, false);
        await measure('docker.cancel.feedback', async () => {
          manager.cancel(owner, { ...scope, requestId }); await rejected;
          assert.equal(manager.pending.size, 0); connected();
        });
        await waitFor(() => channels.size === 0);
      } finally {
        onOpened = null; manager.cancel(owner, { ...scope, requestId });
        await pending.catch(() => undefined);
      }
    });
    await measure('docker.cancel.queued', async () => {
      const startedExecs = execCount;
      const active = [0,1].map(index => read({ kind:'stats', containerId, requestId:'probe-active-' + index }));
      const occupied = Promise.all(active); occupied.catch(() => undefined);
      let pending;
      try {
        await waitFor(() => runtime.readScheduler.active === 2 && execCount === startedExecs + 2);
        const requestId = 'probe-queued';
        pending = read({ kind:'list', requestId });
        const rejected = assert.rejects(pending, { code:'DOCKER_CANCELLED' }); rejected.catch(() => undefined);
        await waitFor(() => runtime.readScheduler.queue.length === 1);
        const beforeQueuedExecs = execCount;
        await measure('docker.cancel.queued-feedback', async () => {
          manager.cancel(owner, { ...scope, requestId }); await rejected;
          assert.equal(runtime.readScheduler.queue.length, 0);
          assert.equal(execCount, beforeQueuedExecs, '取消的排队请求不发出远端命令');
        });
        await occupied;
        connected();
      } finally {
        manager.cancel(owner, scope);
        await Promise.allSettled([...active, ...(pending ? [pending] : [])]);
      }
    });
    await measure('docker.after-cancel', async () => {
      const result = await read({ kind:'list', limit:200 });
      assert.ok(Array.isArray(result.items)); connected();
    });
    await measure('docker.snapshot.close-owner', async () => {
      const result = await read({ kind:'list', limit:1 });
      const snapshot = [...manager.snapshots.values()].findLast(item => item.owner === owner);
      assert.ok(snapshot);
      const cursor = result.nextCursor ?? snapshot.id + ':0', reads = execCount;
      manager.closeOwner(owner);
      await assert.rejects(read({ kind:'list', cursor }), { code:'DOCKER_CURSOR_EXPIRED' });
      assert.equal(execCount, reads); connected();
    });
  } finally {
    onOpened = null; manager.closeOwner(owner);
    await Promise.allSettled([...inFlight]);
    try { await waitFor(() => channels.size === 0); }
    finally { client.exec = originalExec; }
    assert.equal(manager.pending.size, 0); assert.equal(runtime.readScheduler.queue.length, 0);
  }
}
