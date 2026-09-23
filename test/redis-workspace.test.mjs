import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RedisPluginRuntime } from '../src/redis-plugin-runtime.mjs';
import { PluginManager } from '../src/plugin-manager.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { registerRedisWorkspaceIpc } from '../src/redis-workspace-ipc.mjs';
import { BoundedRespDecoder, REDIS_REPLY_BYTES } from '../src/redis-workspace-reader.mjs';
import { redisProtocolFixture, resp } from './fixtures/redis-workspace-server.mjs';

const scope = { projectId: 'fixture-project', environmentId: 'testing', pluginInstanceId: 'fixture-redis' };
async function harness(t, handler, limits = {}) {
  const fixture = await redisProtocolFixture(handler);
  const plugin = { ...scope, pluginType: 'redis', configState: 'ready', revision: 1, displayName: '测试缓存',
    target: { host: 'redis.invalid', port: 6379, db: 3 }, auth: { username: '' }, tls: { mode: 'disabled' },
    patterns: [{ patternId: 'cache', pattern: 'cache:*', displayName: '缓存' }],
    limits: { maxKeys: 100, maxValueBytes: 65536, timeoutMs: 1500, ...limits } };
  const client = Object.assign(new EventEmitter(), { connect: async () => {}, ping: async () => 'PONG', quit: async () => {}, disconnect: async () => {}, isOpen: true });
  const runtime = new RedisPluginRuntime({ createRelay: async () => ({ host: '127.0.0.1', port: fixture.port, generation: 1 }), closeRelay: async () => {} },
    { load: async () => ({ password: 'fixture-only-password' }) }, { factory: () => client });
  await runtime.connect(plugin);
  const audits = [];
  const store = { getPlugin: async (...ids) => {
    if (ids.join('/') !== Object.values(scope).join('/')) throw Object.assign(new Error('scope'), { code: 'SCOPE_MISMATCH' });
    return structuredClone(plugin);
  }, appendAudit: async (_project, event) => { audits.push(event); } };
  const connection = { assertConfigurationStable: () => {}, snapshot: () => ({ plugins: { [scope.pluginInstanceId]: { phase: runtime.status(plugin).connected ? 'connected' : 'disconnected' } } }) };
  const service = new V2Service({ workspaceStore: store, connectionManager: connection, pluginManager: new PluginManager({ redisRuntime: runtime }) });
  const handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 10, mainFrame: {}, isDestroyed: () => false });
  const services = { v2Service: service, isWorkspaceRenderer: (candidate) => candidate === sender };
  registerRedisWorkspaceIpc({ handle: (name, fn) => handlers.set(name, fn) }, services);
  const event = { sender, senderFrame: sender.mainFrame };
  const invoke = (operation, payload = {}, source = event) => handlers.get('v2:redis-workspace-' + operation)(source, { ...scope, ...(operation === 'release' ? {} : { patternId: 'cache' }), ...payload });
  t.after(async () => { service.redisWorkspaceManager.dispose(); await runtime.closeAll(); await fixture.close(); });
  return { invoke, fixture, plugin, runtime, service, audits, sender, event, store };
}
function standard(args) {
  const [command, key] = args;
  const types = { 'cache:text': 'string', 'cache:hash': 'hash', 'cache:list': 'list', 'cache:set': 'set', 'cache:zset': 'zset', 'cache:stream': 'stream' };
  if (command === 'TYPE') return types[key] ?? 'none';
  if (command === 'TTL') return -1;
  if (command === 'STRLEN') return 5;
  if (command === 'GETRANGE') return 'hello';
  if (['HLEN', 'LLEN', 'SCARD', 'ZCARD'].includes(command)) return 2;
  if (command === 'HSTRLEN') return args[2] === 'missing' ? 0 : 3;
  if (command === 'HGET') return args[2] === 'missing' ? null : 'abc';
  if (command === 'HSCAN') return ['0', ['name', '示例', 'enabled', 'true']];
  if (command === 'SSCAN') return ['0', ['first', 'second']];
  if (command === 'LRANGE') return ['first', 'second'];
  if (command === 'ZRANGE') return ['first', '1.5', 'second', '2'];
  if (command === 'SCAN') return ['0', Object.keys(types)];
  throw new Error('未登记测试命令');
}

test('RESP2 增量解析支持碎片、嵌套、二进制和空值，并在声明超限时拒绝', () => {
  const expected = [Buffer.from('中文'), [null, 7, Buffer.from([0, 255])], Buffer.alloc(0)];
  const decoder = new BoundedRespDecoder();
  for (const byte of resp(expected)) decoder.push(Buffer.from([byte]));
  assert.deepEqual(decoder.value, expected);
  for (const raw of ['$' + (REDIS_REPLY_BYTES + 1) + '\r\n', '*9999999\r\n']) {
    assert.throws(() => new BoundedRespDecoder().push(Buffer.from(raw)), { code: 'REDIS_REPLY_TOO_LARGE' });
  }
  assert.throws(() => new BoundedRespDecoder().push(Buffer.from('$1\r\naXX')), { code: 'REDIS_REPLY_INVALID' });
  assert.throws(() => new BoundedRespDecoder().push(Buffer.from('-NOPERM private-payload\r\n')), (error) => error.code === 'REDIS_PERMISSION_DENIED' && !error.message.includes('private-payload'));
});

test('桌面 Redis 来源、作用域、范围及参数覆盖在读取前被拒绝', async (t) => {
  const h = await harness(t, standard);
  for (const [payload, code] of [[{ key: 'outside' }, 'POLICY_DENIED'], [{ key: 'cache:text', patternId: 'unknown' }, 'POLICY_DENIED'],
    [{ key: 'cache:text', command: 'SET' }, 'INVALID_ARGUMENT'], [{ key: 'cache:text', db: 0 }, 'INVALID_ARGUMENT'], [{ key: 'cache:text', limit: 0 }, 'INVALID_ARGUMENT'], [{ key: 'cache:text\n' }, 'POLICY_DENIED'], [{ key: 'cache:' + String.fromCharCode(0xd800) }, 'INVALID_ARGUMENT']]) {
    assert.equal((await h.invoke('read', payload)).error.code, code);
  }
  assert.equal((await h.invoke('scan', {}, { ...h.event, senderFrame: {} })).error.code, 'WORKSPACE_ACCESS_DENIED');
  for (const field of ['projectId', 'environmentId', 'pluginInstanceId']) {
    assert.equal((await h.invoke('inspect', { [field]: 'outside-scope', key: 'cache:text' })).ok, false);
  }
  assert.equal(h.fixture.calls.length, 0);
  const result = await h.invoke('inspect', { key: 'cache:text' });
  assert.equal(result.data.ttlSeconds, -1);
  assert.ok(h.fixture.calls.some((call) => call[0] === 'SELECT' && call[1] === '3'));
  assert.ok(h.audits.every((entry) => entry.actor === 'user'));
  assert.ok(!JSON.stringify(h.audits).includes('cache:text'));
  assert.ok(!JSON.stringify(h.audits).includes('hello'));
});

test('SCAN 超额批次保留全部余项，空批次不等于扫描结束', async (t) => {
  let scans = 0;
  const h = await harness(t, (args) => args[0] === 'SCAN' ? (++scans === 1 ? ['8', []] : ['0', ['cache:a', 'cache:b', 'cache:c', 'cache:d', 'cache:e']]) : standard(args), { maxKeys: 2 });
  const first = (await h.invoke('scan')).data;
  assert.equal(first.complete, false);
  assert.deepEqual(first.keys, []);
  let cursor = first.nextCursor;
  const all = [];
  do {
    const response = await h.invoke('scan', { cursor });
    assert.equal(response.ok, true);
    all.push(...response.data.keys);
    cursor = response.data.nextCursor;
  } while (cursor);
  assert.deepEqual(all, ['cache:a', 'cache:b', 'cache:c', 'cache:d', 'cache:e']);
  assert.equal(scans, 2);
});

test('游标绑定查询、窗口、配置和连接，已过期游标不能继续', async (t) => {
  const h = await harness(t, () => ['5', ['cache:a']], { maxKeys: 1 });
  const next = async () => (await h.invoke('scan')).data.nextCursor;
  assert.equal((await h.invoke('scan', { cursor: await next(), keyword: 'changed' })).error.code, 'INVALID_CURSOR');
  const cursor = await next();
  assert.equal((await h.service.invokeDesktopRedis('renderer:other', { ...scope, patternId: 'cache', cursor }, 'scan').catch((error) => error)).code, 'INVALID_CURSOR');
  const expiring = await next();
  for (const record of h.service.redisWorkspaceManager.records.values()) for (const entry of record.cursors.values()) entry.expiresAt = 0;
  assert.equal((await h.invoke('scan', { cursor: expiring })).error.code, 'INVALID_CURSOR');
  const revised = await next();
  h.plugin.revision += 1;
  assert.equal((await h.invoke('scan', { cursor: revised })).error.code, 'INVALID_CURSOR');
});

test('五种类型、精确字段、空值与未支持类型保持只读且有界', async (t) => {
  const h = await harness(t, standard);
  for (const type of ['text', 'hash', 'list', 'set', 'zset']) {
    const response = await h.invoke('read', { key: 'cache:' + type });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.data.exists, true);
    assert.equal(response.data.nextCursor, null);
    if (type === 'text') assert.equal(response.data.value.text, 'hello');
    else assert.equal(response.data.rows.length, 2);
  }
  assert.equal((await h.invoke('read', { key: 'cache:hash', field: 'missing' })).data.fieldExists, false);
  assert.equal((await h.invoke('read', { key: 'cache:hash', field: 'name' })).data.value.text, 'abc');
  assert.equal((await h.invoke('read', { key: 'cache:stream' })).data.unsupported, true);
  assert.equal((await h.invoke('read', { key: 'cache:expired' })).data.exists, false);
  assert.equal((await h.invoke('read', { key: 'cache:text', expectedType: 'hash' })).error.code, 'REDIS_TYPE_CHANGED');
  assert.ok(h.fixture.calls.filter((args) => ['LRANGE', 'ZRANGE'].includes(args[0])).every((args) => Number(args[3]) >= 0 && Number(args[3]) < 50));
});

test('集合字节预算保留分页余项，二进制和超大字段不伪装完整文本', async (t) => {
  const h = await harness(t, (args) => {
    if (args[0] === 'SSCAN') return ['0', [Buffer.alloc(300, 255), 'tail']];
    if (args[0] === 'HSTRLEN') return 100000;
    if (args[0] === 'HGET') throw new Error('超大字段不能被读取');
    return standard(args);
  }, { maxValueBytes: 256 });
  const first = (await h.invoke('read', { key: 'cache:set' })).data;
  assert.equal(first.rows[0].value.text, null);
  assert.equal(first.rows[0].value.shownBytes, 256);
  assert.equal(first.truncated, true);
  const second = (await h.invoke('read', { key: 'cache:set', cursor: first.nextCursor })).data;
  assert.equal(second.rows[0].value.text, 'tail');
  const field = (await h.invoke('read', { key: 'cache:hash', field: 'large' })).data;
  assert.equal(field.truncated, true);
  assert.equal(field.value, null);
});

test('回复超限和超时只关闭独立读取通道，插件主连接继续可用', async (t) => {
  let mode = 'large';
  const h = await harness(t, (args) => {
    if (args[0] === 'SCAN' && mode === 'large') return { raw: Buffer.from('$' + (REDIS_REPLY_BYTES + 1) + '\r\n') };
    if (args[0] === 'SCAN' && mode === 'timeout') return undefined;
    return standard(args);
  }, { timeoutMs: 80 });
  assert.equal((await h.invoke('scan')).error.code, 'REDIS_REPLY_TOO_LARGE');
  assert.equal(h.runtime.status(h.plugin).connected, true);
  mode = 'timeout';
  assert.equal((await h.invoke('scan')).error.code, 'PLUGIN_TIMEOUT');
  assert.equal(h.runtime.status(h.plugin).connected, true);
  mode = 'normal';
  assert.equal((await h.invoke('inspect', { key: 'cache:text' })).ok, true);
});

test('关闭、导航和断连立即释放通道并丢弃在途回复', async (t) => {
  let release;
  const h = await harness(t, async (args) => args[0] === 'SCAN' ? new Promise((resolve) => { release = resolve; }) : standard(args));
  const pending = h.invoke('scan');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await h.invoke('release')).ok, true);
  release(['0', ['cache:late']]);
  assert.equal((await pending).ok, false);
  assert.equal(h.runtime.status(h.plugin).connected, true);
  await h.invoke('inspect', { key: 'cache:text' });
  h.sender.emit('did-start-navigation', {}, '', false, true);
  assert.equal(h.service.redisWorkspaceManager.records.size, 0);
  await h.invoke('inspect', { key: 'cache:text' });
  await h.runtime.disconnect(h.plugin);
  assert.equal(h.service.redisWorkspaceManager.records.size, 0);
});

test('开始审计失败阻止远端读取，完成审计失败保留可见提示', async (t) => {
  const h = await harness(t, standard);
  h.store.appendAudit = async () => { throw new Error('fixture audit failure'); };
  assert.equal((await h.invoke('scan')).ok, false);
  assert.equal(h.fixture.calls.length, 0);
  h.store.appendAudit = async (_project, entry) => { if (entry.result === 'success') throw new Error('fixture audit failure'); };
  assert.equal((await h.invoke('scan')).data.auditWarning, true);
});

test('审计等待期间释放工作区或销毁窗口不会重新创建读取通道', async (t) => {
  for (const mode of ['release', 'destroy']) {
    const h = await harness(t, standard);
    let started;
    let resume;
    h.store.appendAudit = async (_project, entry) => {
      if (entry.type === 'plugin-operation-started') {
        started = true;
        await new Promise((resolve) => { resume = resolve; });
      }
    };
    const pending = h.invoke('scan');
    while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
    if (mode === 'release') await h.invoke('release');
    else h.sender.emit('destroyed');
    resume();
    assert.equal((await pending).error.code, 'REDIS_WORKSPACE_STALE');
    assert.equal(h.fixture.calls.length, 0);
    assert.equal(h.service.redisWorkspaceManager.records.size, 0);
  }
});

test('String 读取保留 UTF-8 字符边界，空字符串与不存在分开显示', async (t) => {
  const raw = Buffer.from('中'.repeat(100));
  const h = await harness(t, (args) => {
    if (args[0] === 'TYPE') return args[1] === 'cache:gone' ? 'none' : 'string';
    if (args[0] === 'STRLEN') return args[1] === 'cache:empty' ? 0 : raw.length;
    if (args[0] === 'GETRANGE') return raw.subarray(0, Number(args[3]) + 1);
    return standard(args);
  }, { maxValueBytes: 256 });
  const preview = (await h.invoke('read', { key: 'cache:unicode' })).data.value;
  assert.equal(preview.text, '中'.repeat(85));
  assert.equal(preview.shownBytes, 255);
  assert.equal(preview.truncated, true);
  const empty = (await h.invoke('read', { key: 'cache:empty' })).data;
  assert.equal(empty.exists, true);
  assert.equal(empty.value.text, '');
  assert.equal(empty.value.truncated, false);
  assert.equal((await h.invoke('read', { key: 'cache:gone' })).data.exists, false);
});

test('读取中删除或改变类型时丢弃旧内容，错误不回显服务端正文', async (t) => {
  let reads = 0;
  const h = await harness(t, (args) => args[0] === 'TYPE' ? (++reads === 1 ? 'string' : 'none') : standard(args));
  const gone = (await h.invoke('read', { key: 'cache:text' })).data;
  assert.equal(gone.exists, false);
  assert.equal(gone.value, undefined);
  const changed = await harness(t, (args) => {
    if (args[0] === 'GETRANGE') return { raw: Buffer.from('-WRONGTYPE private-fixture-body\r\n') };
    return standard(args);
  });
  const result = await changed.invoke('read', { key: 'cache:text' });
  assert.equal(result.error.code, 'REDIS_TYPE_CHANGED');
  assert.ok(!JSON.stringify(result).includes('private-fixture-body'));
});

test('同一插件的桌面读取串行，配置修订在请求完成前再次验证', async (t) => {
  let resume;
  const h = await harness(t, async (args) => args[0] === 'SCAN' ? new Promise((resolve) => { resume = resolve; }) : standard(args));
  const pending = h.invoke('scan');
  while (!resume) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await h.invoke('inspect', { key: 'cache:text' })).error.code, 'READ_BUSY');
  h.plugin.revision++;
  resume(['0', ['cache:old']]);
  const result = await pending;
  assert.equal(result.error.code, 'REDIS_WORKSPACE_STALE');
  assert.equal(h.service.redisWorkspaceManager.records.size, 0);
});

test('整次请求共用超时预算，不能为每个 Redis 命令重新延长', async (t) => {
  const h = await harness(t, async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    return standard(args);
  }, { timeoutMs: 80 });
  assert.equal((await h.invoke('inspect', { key: 'cache:text' })).error.code, 'PLUGIN_TIMEOUT');
  assert.equal(h.runtime.status(h.plugin).connected, true);
});

test('多次超额扫描的余项触达缓存预算后停止加载，已保留数据仍然有界', async (t) => {
  const entries = Array.from({ length: 8 }, (_, index) => ['field-' + index, Buffer.alloc(120 * 1024, 97)]).flat();
  const h = await harness(t, (args) => args[0] === 'HSCAN' ? ['0', entries] : standard(args), { maxKeys: 1 });
  let accepted = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await h.invoke('read', { key: 'cache:hash' });
    if (!response.ok) {
      assert.equal(response.error.code, 'REDIS_CACHE_LIMIT');
      break;
    }
    accepted++;
    assert.equal(response.data.rows.length, 1);
    assert.ok(response.data.nextCursor);
  }
  assert.equal(accepted, 4);
  const record = [...h.service.redisWorkspaceManager.records.values()][0];
  const retained = [...record.cursors.values()].reduce((sum, state) => sum + state.pending.reduce(
    (total, row) => total + row.reduce((bytes, entry) => bytes + entry.length, 0), 0), 0);
  assert.ok(retained <= 4 * 1024 * 1024);
  assert.equal(record.cursors.size, 4);
  assert.equal(h.runtime.status(h.plugin).connected, true);
  assert.equal((await h.invoke('inspect', { key: 'cache:text' })).ok, true);
});

test('独立读取通道保持主连接的 TLS 身份参数且不新建插件路由', async (t) => {
  const h = await harness(t, standard);
  const session = h.runtime.require(h.plugin);
  const original = session.workspaceOptions;
  session.workspaceOptions = { ...original, socket: { ...original.socket, tls: true, servername: 'redis.invalid', rejectUnauthorized: true, ca: 'fixture-ca' } };
  const reader = h.runtime.workspaceReader(h.plugin);
  assert.equal(reader.options.socket.servername, 'redis.invalid');
  assert.equal(reader.options.socket.rejectUnauthorized, true);
  assert.equal(reader.options.socket.ca, 'fixture-ca');
  assert.equal(reader.options.socket.host, '127.0.0.1');
  assert.equal(reader.options.socket.port, h.fixture.port);
  reader.close();
  assert.equal(h.runtime.status(h.plugin).connected, true);
});


test('搜索自动合并空批次，通配符结果始终受已登记范围和插件条数限制', async (t) => {
  const replies = [
    ['8', []], ['9', ['cache:other', 'outside:user:1']],
    ['0', ['cache:user:1', 'cache:user:2', 'cache:user:3']],
  ];
  const h = await harness(t, (args) => {
    if (args[0] !== 'SCAN') return standard(args);
    assert.equal(args[3], 'cache:*');
    assert.equal(args[5], '2');
    return replies.shift();
  }, { maxKeys: 2 });
  const first = await h.invoke('scan', { keyword: '*user*' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.data.keys, ['cache:user:1', 'cache:user:2']);
  assert.equal(first.data.complete, false);
  const last = await h.invoke('scan', { keyword: '*user*', cursor: first.data.nextCursor });
  assert.deepEqual(last.data.keys, ['cache:user:3']);
  assert.equal(last.data.complete, true);
  assert.equal(h.fixture.calls.filter((args) => args[0] === 'SCAN').length, 3);
  assert.ok(!JSON.stringify(h.audits).includes('cache:user'));
  assert.ok(!JSON.stringify(h.audits).includes('*user*'));
});

test('稀疏搜索每次请求最多扫描八批，空批次保留续查游标', async (t) => {
  let scans = 0;
  const h = await harness(t, (args) => args[0] === 'SCAN' ? [String(++scans), []] : standard(args));
  const first = await h.invoke('scan', { keyword: 'missing' });
  assert.equal(first.ok, true);
  assert.ok(scans > 0 && scans <= 8);
  assert.deepEqual(first.data.keys, []);
  assert.equal(first.data.complete, false);
  const before = scans;
  const next = await h.invoke('scan', { keyword: 'missing', cursor: first.data.nextCursor });
  assert.equal(next.ok, true);
  assert.ok(scans > before && scans <= before + 8);
  assert.equal(h.fixture.calls.filter((args) => args[0] === 'SCAN')[before][1], String(before));
});

test('搜索批次达到时间预算后返回已有结果，剩余扫描可续查', async (t) => {
  let scans = 0;
  const h = await harness(t, async (args) => {
    if (args[0] !== 'SCAN') return standard(args);
    scans += 1;
    if (scans === 1) { await new Promise((resolve) => setTimeout(resolve, 120)); return ['7', ['cache:user:1']]; }
    return ['0', ['cache:user:2']];
  });
  const first = await h.invoke('scan', { keyword: 'user' });
  assert.equal(first.ok, true);
  assert.equal(scans, 1);
  assert.deepEqual(first.data.keys, ['cache:user:1']);
  assert.equal(first.data.complete, false);
  const next = await h.invoke('scan', { keyword: 'user', cursor: first.data.nextCursor });
  assert.deepEqual(next.data.keys, ['cache:user:2']);
  assert.equal(next.data.complete, true);
});
