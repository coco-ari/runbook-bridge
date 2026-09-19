import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';
import { DEFAULT_TERMINAL_COLORS, probeTerminalShell, createTerminalStartup } from '../src/server-terminal-startup.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';

const scope = { projectId: 'project-a', environmentId: 'test', pluginInstanceId: 'server-a' };

class TerminalChannel extends Duplex {
  constructor() {
    super();
    this.writes = [];
    this.windows = [];
    this.pauseCount = 0;
    this.resumeCount = 0;
  }
  _read() {}
  _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback(); }
  setWindow(...size) { this.windows.push(size); }
  pause() { this.pauseCount += 1; return super.pause(); }
  resume() { this.resumeCount += 1; return super.resume(); }
  close() { this.destroy(); }
}

function startupMarker(command) {
  const label = command.match(/runbook-ready:[a-f0-9]{32}/u)?.[0];
  assert.ok(label, '初始化命令包含独立完成标记');
  return Buffer.from('\x1b]' + label + '\x07');
}

function fixture(t, options = {}) {
  const runtime = new EventEmitter();
  const channels = [];
  const audits = [];
  const state = { connected: true, generation: 1, revision: 1, pluginType: 'server', reads: 0, pluginData: {} };
  runtime.status = () => ({ connected: state.connected, generation: state.generation });
  runtime.openTerminal = options.openTerminal ?? (async () => { const channel = new TerminalChannel(); channels.push(channel); return channel; });
  const store = {
    getPlugin: async (projectId, environmentId, pluginInstanceId) => {
      state.reads += 1;
      return { projectId, environmentId, pluginInstanceId, pluginType: state.pluginType, revision: state.revision, ...structuredClone(state.pluginData) };
    },
    appendAudit: async (_projectId, entry) => { audits.push(entry); },
  };
  const manager = new ServerWorkspaceManager({ workspaceStore: store, serverRuntime: runtime });
  t.after(() => manager.dispose());
  return { manager, channels, state, audits, runtime, store };
}

test('终端复用已有连接与同一窗口会话，并严格绑定三层作用域', async (t) => {
  const { manager, channels, state } = fixture(t);
  const [first, second] = await Promise.all([manager.openTerminal(1, scope), manager.openTerminal(1, scope)]);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(channels.length, 1);
  assert.equal(first.status, 'open');
  for (const payload of [
    { ...scope, sessionId: first.sessionId, projectId: 'project-b' },
    { ...scope, sessionId: first.sessionId, environmentId: 'production' },
    { ...scope, sessionId: first.sessionId, pluginInstanceId: 'server-b' },
  ]) await assert.rejects(manager.writeTerminal(1, { ...payload, data: 'x' }), { code: 'TERMINAL_SCOPE_MISMATCH' });
  await assert.rejects(manager.readTerminal(2, { ...scope, sessionId: first.sessionId }), { code: 'TERMINAL_SCOPE_MISMATCH' });
  await assert.rejects(manager.openTerminal(1, { ...scope, environmentId: '' }), { code: 'INVALID_ARGUMENT' });
  state.connected = false;
  await assert.rejects(manager.openTerminal(1, scope), { code: 'SSH_NOT_CONNECTED' });
});

test('终端传递控制键和原始 UTF-8 字节，审计只含会话元数据', async (t) => {
  const { manager, channels, audits, state } = fixture(t);
  const session = await manager.openTerminal(1, { ...scope, cols: 120, rows: 35 });
  const payload = { ...scope, sessionId: session.sessionId };
  const raw = Buffer.from('前缀\x1b[32m中文输出😀\x1b[0m');
  channels[0].push(raw.subarray(0, 11));
  channels[0].push(raw.subarray(11));
  await delay(0);
  const read = await manager.readTerminal(1, payload);
  assert.ok(read.data instanceof Uint8Array);
  assert.deepEqual(Buffer.from(read.data), raw);
  await manager.writeTerminal(1, { ...payload, data: 'private-terminal-marker\x03\t\x1b[A' });
  assert.equal(channels[0].writes[0].toString(), 'private-terminal-marker\x03\t\x1b[A');
  await manager.resizeTerminal(1, { ...payload, cols: 99, rows: 40 });
  assert.deepEqual(channels[0].windows[0], [40, 99, 0, 0]);
  assert.equal(state.reads, 1);
  await manager.closeTerminal(1, payload);
  assert.equal(audits[0].type, 'terminal-open');
  assert.equal(audits[1].type, 'terminal-close');
  assert.ok(!JSON.stringify(audits).includes('private-terminal-marker'));
  assert.ok(!JSON.stringify(audits).includes('中文输出'));
});

test('高水位暂停读取，消费后恢复，每次最多 64 KiB 且不丢输出', async (t) => {
  const { manager, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  const blocks = Array.from({ length: 12 }, (_, i) => Buffer.alloc(64 * 1024, i));
  for (const block of blocks) channels[0].push(block);
  await delay(0);
  const record = manager.sessions.get(session.sessionId);
  assert.equal(record.paused, true);
  assert.equal(record.queuedBytes, 512 * 1024);
  const received = [];
  while (received.reduce((sum, value) => sum + value.length, 0) < 12 * 64 * 1024) {
    const next = await manager.readTerminal(1, payload);
    assert.ok(next.data.length <= 64 * 1024);
    received.push(Buffer.from(next.data));
  }
  assert.deepEqual(Buffer.concat(received), Buffer.concat(blocks));
  assert.equal(record.paused, false);
});

test('关闭时排空已缓存数据并唤醒等待，EOF 不需要重复轮询', async (t) => {
  const { manager, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  channels[0].push(Buffer.alloc(96 * 1024, 7));
  await delay(0);
  channels[0].emit('exit', 4);
  channels[0].emit('end');
  const first = await manager.readTerminal(1, payload);
  const last = await manager.readTerminal(1, payload);
  assert.equal(first.status, 'open');
  assert.equal(first.data.length, 64 * 1024);
  assert.equal(last.status, 'closed');
  assert.equal(last.exitCode, 4);
  assert.equal(last.data.length, 32 * 1024);

  const reopened = await manager.openTerminal(1, scope);
  const pending = manager.readTerminal(1, { ...scope, sessionId: reopened.sessionId });
  await delay(5);
  await manager.closeTerminal(1, { ...scope, sessionId: reopened.sessionId });
  assert.equal((await pending).status, 'closed');
});

test('空读取有时限且同会话拒绝并行长轮询', async (t) => {
  const { manager } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  const started = Date.now();
  const pending = manager.readTerminal(1, payload);
  await delay(5);
  await assert.rejects(manager.readTerminal(1, payload), { code: 'TERMINAL_READ_BUSY' });
  const result = await pending;
  assert.equal(result.data.length, 0);
  assert.equal(result.status, 'open');
  assert.ok(Date.now() - started >= 200);
  assert.ok(Date.now() - started < 1000);
});

test('断线、配置失效和窗口销毁关闭通道，重连不会重放输入', async (t) => {
  const { manager, channels, runtime, state } = fixture(t);
  let session = await manager.openTerminal(1, scope);
  runtime.emit('lifecycle', { ...scope, type: 'lost' });
  assert.equal(channels[0].destroyed, true);
  assert.equal((await manager.readTerminal(1, { ...scope, sessionId: session.sessionId })).status, 'closed');
  state.generation += 1;
  session = await manager.openTerminal(1, scope);
  assert.equal(channels.length, 2);
  assert.equal(channels[1].writes.length, 0);
  manager.closeScope(scope, 'configuration-changed');
  assert.equal(channels[1].destroyed, true);
  session = await manager.openTerminal(1, scope);
  manager.closeOwner(1);
  assert.equal(channels[2].destroyed, true);
  assert.equal(manager.sessions.size, 0);
  await assert.rejects(manager.writeTerminal(1, { ...scope, sessionId: session.sessionId, data: 'x' }), { code: 'TERMINAL_SCOPE_MISMATCH' });
  const next = await manager.openTerminal(1, scope);
  assert.equal(next.status, 'open');
});

test('窗口关闭使打开中的异步通道失效，但同 owner 可以再次打开', async (t) => {
  const pendingChannels = [];
  const { manager } = fixture(t, { openTerminal: () => new Promise((resolve) => pendingChannels.push(resolve)) });
  const opening = manager.openTerminal(1, scope);
  await delay(0);
  manager.closeOwner(1);
  const channel = new TerminalChannel();
  pendingChannels[0](channel);
  await assert.rejects(opening, { code: 'TERMINAL_CLOSED' });
  assert.equal(channel.destroyed, true);
  const second = manager.openTerminal(1, scope);
  await delay(0);
  pendingChannels[1](new TerminalChannel());
  assert.equal((await second).status, 'open');
});

test('每窗口最多 8 个活动终端，输入和窗口尺寸均有边界', async (t) => {
  const { manager } = fixture(t);
  const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => manager.openTerminal(1, { ...scope, pluginInstanceId: 'server-' + i })));
  await assert.rejects(manager.openTerminal(1, { ...scope, pluginInstanceId: 'extra' }), { code: 'TERMINAL_LIMIT_REACHED' });
  await assert.rejects(manager.writeTerminal(1, { ...scope, pluginInstanceId: 'server-0', sessionId: sessions[0].sessionId, data: 'x'.repeat(65537) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(manager.resizeTerminal(1, { ...scope, pluginInstanceId: 'server-0', sessionId: sessions[0].sessionId, cols: 0, rows: 24 }), { code: 'INVALID_ARGUMENT' });
});

test('broker 在现有 SSH 客户端请求 xterm PTY，不执行单命令且拒绝过期连接', async () => {
  const calls = [];
  const broker = new SshBroker({});
  const channel = new TerminalChannel();
  let accept;
  const client = { shell: (options, callback) => { calls.push(options); accept = callback; } };
  broker.sessions.set('scope', { client, generation: 1 });
  const opening = broker.openTerminal('scope', { cols: 110, rows: 30 });
  accept(null, channel);
  assert.equal(await opening, channel);
  assert.deepEqual(calls, [{ term: 'xterm-256color', cols: 110, rows: 30, width: 0, height: 0 }]);
  assert.equal(channel.isPaused(), true);
  const stale = broker.openTerminal('scope');
  broker.sessions.delete('scope');
  const staleChannel = new TerminalChannel();
  accept(null, staleChannel);
  await assert.rejects(stale, { code: 'TERMINAL_CLOSED' });
  assert.equal(staleChannel.destroyed, true);
});

test('二进制鼠标输入保留高位字节，非法编码拒绝发送', async (t) => {
  const { manager, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  await manager.writeTerminal(1, { ...payload, encoding: 'binary', data: '\x1b[M\xff\x80\x21' });
  assert.deepEqual(channels[0].writes[0], Buffer.from([27, 91, 77, 255, 128, 33]));
  await assert.rejects(manager.writeTerminal(1, { ...payload, encoding: 'binary', data: '中文' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(manager.writeTerminal(1, { ...payload, encoding: 'base64', data: 'abc' }), { code: 'INVALID_ARGUMENT' });
});

test('异步插件读取期间窗口和作用域失效不会创建迟到的终端', async (t) => {
  const { manager, store, channels } = fixture(t);
  let resolvePlugin;
  const getPlugin = store.getPlugin;
  store.getPlugin = () => new Promise((resolve) => { resolvePlugin = resolve; });
  let opening = manager.openTerminal(1, scope);
  manager.closeOwner(1);
  resolvePlugin(await getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId));
  await assert.rejects(opening, { code: 'WORKSPACE_CLOSED' });
  opening = manager.openTerminal(1, scope);
  manager.closeScope(scope, 'configuration-changed');
  resolvePlugin(await getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId));
  await assert.rejects(opening, { code: 'WORKSPACE_CLOSED' });
  assert.equal(channels.length, 0);
});

test('输入回调受背压限制，关闭会话时拒绝所有未完成的输入', async (t) => {
  const { manager, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId, data: 'x'.repeat(64 * 1024) };
  channels[0]._write = () => undefined;
  const writes = Array.from({ length: 4 }, () => manager.writeTerminal(1, payload));
  const settled = Promise.allSettled(writes);
  await delay(0);
  await assert.rejects(manager.writeTerminal(1, payload), { code: 'TERMINAL_INPUT_BUSY' });
  await manager.closeTerminal(1, payload);
  assert.ok((await settled).every((result) => result.status === 'rejected' && result.reason.code === 'TERMINAL_WRITE_FAILED'));
});

test('低频插件复核发现连接指纹变化后关闭终端', async (t) => {
  const { manager, channels, state } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  state.revision += 1;
  state.pluginData.target = { host: 'changed.example.test', port: 22 };
  manager.sessions.get(session.sessionId).nextValidationAt = 0;
  await assert.rejects(manager.writeTerminal(1, { ...payload, data: 'x' }), { code: 'TERMINAL_CLOSED' });
  assert.equal(channels[0].destroyed, true);
  assert.equal(channels[0].writes.length, 0);
});

test('本地审计不可用时拒绝建立人工终端', async (t) => {
  const { manager, store, channels } = fixture(t);
  store.appendAudit = async () => { throw new Error('fixture storage unavailable'); };
  await assert.rejects(manager.openTerminal(1, scope), { code: 'TERMINAL_AUDIT_UNAVAILABLE' });
  assert.equal(channels.length, 0);
  assert.equal(manager.sessions.size, 0);
});

test('修改名称和 Agent 策略后持续复用人工终端并刷新插件记录', async (t) => {
  const { manager, channels, state } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId: session.sessionId };
  state.revision += 1;
  state.pluginData = { displayName: '新的服务器名称', policy: { enabled: false }, sources: [], limits: { maxBytes: 1024 } };
  manager.sessions.get(session.sessionId).nextValidationAt = 0;
  await manager.writeTerminal(1, { ...payload, data: 'pwd\r' });
  const record = manager.sessions.get(session.sessionId);
  assert.equal(record.status, 'open');
  assert.equal(record.revision, state.revision);
  assert.equal(record.plugin.displayName, '新的服务器名称');
  assert.equal(channels[0].destroyed, false);
  assert.equal(channels[0].writes[0].toString(), 'pwd\r');
  state.revision += 1;
  state.pluginData.description = '更新说明';
  assert.equal((await manager.openTerminal(1, scope)).sessionId, session.sessionId);
  assert.equal(record.revision, state.revision);
  assert.equal(channels.length, 1);
});

test('连接配置变化使重复打开建立新会话，连接代次变化拒绝旧输入', async (t) => {
  const { manager, channels, state } = fixture(t);
  const first = await manager.openTerminal(1, scope);
  state.revision += 1;
  state.pluginData.auth = { type: 'agent', username: 'another-user' };
  const second = await manager.openTerminal(1, scope);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(channels[0].destroyed, true);
  assert.equal(channels.length, 2);
  state.generation += 1;
  await assert.rejects(manager.writeTerminal(1, { ...scope, sessionId: second.sessionId, data: 'x' }), { code: 'TERMINAL_CLOSED' });
  assert.equal(channels[1].destroyed, true);
  assert.equal(channels[1].writes.length, 0);
});


test('同一服务器的终端标签独立收发、关闭，并按标签复用打开请求', async (t) => {
  const { manager, channels } = fixture(t);
  const [first, repeated, second] = await Promise.all([
    manager.openTerminal(1, { ...scope, tabId: 'tab-a' }),
    manager.openTerminal(1, { ...scope, tabId: 'tab-a' }),
    manager.openTerminal(1, { ...scope, tabId: 'tab-b' }),
  ]);
  assert.equal(first.sessionId, repeated.sessionId);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(channels.length, 2);
  await manager.writeTerminal(1, { ...scope, sessionId: first.sessionId, data: 'first' });
  await manager.writeTerminal(1, { ...scope, sessionId: second.sessionId, data: 'second' });
  assert.equal(channels[0].writes[0].toString(), 'first');
  assert.equal(channels[1].writes[0].toString(), 'second');
  channels[0].push('one'); channels[1].push('two');
  await delay(0);
  const a = await manager.readTerminal(1, { ...scope, sessionId: first.sessionId });
  const b = await manager.readTerminal(1, { ...scope, sessionId: second.sessionId });
  assert.equal(Buffer.from(a.data).toString(), 'one');
  assert.equal(Buffer.from(b.data).toString(), 'two');
  await manager.closeTerminal(1, { ...scope, sessionId: first.sessionId });
  assert.equal(channels[0].destroyed, true);
  assert.equal(channels[1].destroyed, false);
  await manager.writeTerminal(1, { ...scope, sessionId: second.sessionId, data: 'still-open' });
  assert.equal(channels[1].writes.at(-1).toString(), 'still-open');
});

test('终端标签标识拒绝非法输入，并维持每窗口八会话上限', async (t) => {
  const { manager } = fixture(t);
  for (const tabId of ['', '../tab', 'a b', 12, 'a'.repeat(81)]) await assert.rejects(manager.openTerminal(1, { ...scope, tabId }), { code: 'INVALID_ARGUMENT' });
  for (let i = 0; i < 8; i += 1) await manager.openTerminal(1, { ...scope, tabId: 'tab-' + i });
  await assert.rejects(manager.openTerminal(1, { ...scope, tabId: 'overflow' }), { code: 'TERMINAL_LIMIT_REACHED' });
});


test('默认配色先于人工输入发送，新标签执行一次，复用与切换不重复', async (t) => {
  const channels = [];
  const options = [];
  let complete;
  const { manager } = fixture(t, { openTerminal: async (_plugin, option) => {
    options.push(option);
    const channel = new TerminalChannel();
    channel.desktopStartupCommand = options.at(-1).defaultColors ? DEFAULT_TERMINAL_COLORS : ':';
    channel._write = (chunk, _encoding, done) => {
      channel.writes.push(Buffer.from(chunk));
      const acknowledge = () => { channel.push(startupMarker(chunk.toString())); channel.push('operator@example:~$ '); done(); };
      if (channels.length === 1) complete = acknowledge;
      else acknowledge();
    };
    channels.push(channel);
    return channel;
  } });
  let ready = false;
  const opening = manager.openTerminal(1, scope).then(value => { ready = true; return value; });
  await delay(0);
  const reuse = manager.openTerminal(1, scope);
  await delay(0);
  assert.equal(ready, false);
  const record = [...manager.sessions.values()][0];
  await assert.rejects(manager.writeTerminal(1, { ...scope, sessionId: record.sessionId, data: 'ls\r' }), { code: 'TERMINAL_CLOSED' });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].writes.length, 1);
  assert.ok(channels[0].writes[0].toString().startsWith(DEFAULT_TERMINAL_COLORS));
  complete();
  const first = await opening;
  assert.equal((await reuse).sessionId, first.sessionId);
  assert.equal((await manager.openTerminal(1, { ...scope, defaultColors: false })).sessionId, first.sessionId);
  await manager.openTerminal(1, { ...scope, tabId: 'second' });
  await manager.openTerminal(1, { ...scope, tabId: 'disabled', defaultColors: false });
  assert.equal(channels[0].writes.length, 1);
  assert.ok(channels[1].writes[0].toString().startsWith(DEFAULT_TERMINAL_COLORS));
  assert.notDeepEqual(startupMarker(channels[0].writes[0].toString()), startupMarker(channels[1].writes[0].toString()));
  assert.equal(channels[2].writes.length, 1);
  assert.ok(channels[2].writes[0].toString().startsWith(':; printf'));
  assert.ok(!channels[2].writes[0].toString().includes('LS_COLORS'));
  assert.deepEqual(options.map(item => item.defaultColors), [true, true, false]);
  for (const defaultColors of [null, 'true', 1, {}]) await assert.rejects(manager.openTerminal(1, { ...scope, defaultColors }), { code: 'INVALID_ARGUMENT' });
});

test('窗口关闭中止未完成配色，迟到通道不能执行启动配置', async (t) => {
  let channel = new TerminalChannel();
  channel.desktopStartupCommand = DEFAULT_TERMINAL_COLORS;
  channel._write = () => undefined;
  const { manager, runtime } = fixture(t, { openTerminal: async () => channel });
  const opening = manager.openTerminal(1, scope);
  const rejected = assert.rejects(opening, { code: 'TERMINAL_CLOSED' });
  await delay(0);
  manager.closeOwner(1);
  await rejected;
  assert.equal(channel.destroyed, true);
  assert.equal(manager.sessions.size, 0);
  let accept;
  runtime.openTerminal = () => new Promise(resolve => { accept = resolve; });
  const late = manager.openTerminal(1, scope);
  await delay(0);
  manager.closeOwner(1);
  channel = new TerminalChannel();
  channel.desktopStartupCommand = DEFAULT_TERMINAL_COLORS;
  accept(channel);
  await assert.rejects(late, { code: 'TERMINAL_CLOSED' });
  assert.equal(channel.writes.length, 0);
});


test('目录查询按窗口、服务器和终端标签隔离，不写入终端也不记录路径内容', async t => {
  const { manager, channels, audits } = fixture(t);
  const first = await manager.openTerminal(1, { ...scope, tabId:'first' });
  const second = await manager.openTerminal(1, { ...scope, tabId:'second' });
  const calls = [];
  for (const [index, session] of [first, second].entries()) {
    manager.sessions.get(session.sessionId).shellPid = 101 + index;
    channels[index].desktopReadWorkingDirectory = async pid => { calls.push(pid); return { path:'/fixture/' + pid }; };
  }
  assert.deepEqual(await manager.terminalWorkingDirectory(1, { ...scope, sessionId:second.sessionId }), { path:'/fixture/102' });
  assert.deepEqual(calls, [102]);
  await assert.rejects(manager.terminalWorkingDirectory(2, { ...scope, sessionId:first.sessionId }), { code:'TERMINAL_SCOPE_MISMATCH' });
  await assert.rejects(manager.terminalWorkingDirectory(1, { ...scope, environmentId:'other', sessionId:first.sessionId }), { code:'TERMINAL_SCOPE_MISMATCH' });
  assert.ok(channels.every(channel => channel.writes.length === 0));
  assert.ok(!JSON.stringify(audits).includes('/fixture/'));
});

test('目录查询合并并发请求，关闭或连接变化拒绝迟到结果', async t => {
  for (const mode of ['close', 'generation', 'configuration']) {
    const { manager, channels, state } = fixture(t);
    const session = await manager.openTerminal(1, scope);
    const payload = { ...scope, sessionId:session.sessionId };
    manager.sessions.get(session.sessionId).shellPid = 42;
    let resolve, calls = 0, signal;
    channels[0].desktopReadWorkingDirectory = (_pid, options) => { calls++; signal = options.signal; return new Promise(done => { resolve = done; }); };
    const first = manager.terminalWorkingDirectory(1, payload);
    const second = manager.terminalWorkingDirectory(1, payload);
    const rejectedFirst = assert.rejects(first, { code:'TERMINAL_CLOSED' });
    const rejectedSecond = assert.rejects(second, { code:'TERMINAL_CLOSED' });
    await delay(0);
    assert.equal(calls, 1);
    if (mode === 'close') { await manager.closeTerminal(1, payload); assert.equal(signal.aborted, true); }
    else if (mode === 'generation') state.generation++;
    else state.pluginData = { target:{host:'changed.example.invalid',port:22} };
    resolve({ path:'/stale' });
    await Promise.all([rejectedFirst, rejectedSecond]);
  }
});

test('不支持目录识别的终端正常保留会话，查询失败后可重试', async t => {
  const { manager, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId:session.sessionId };
  await assert.rejects(manager.terminalWorkingDirectory(1, payload), { code:'TERMINAL_DIRECTORY_UNAVAILABLE' });
  manager.sessions.get(session.sessionId).shellPid = 42;
  channels[0].desktopReadWorkingDirectory = () => { throw Error('模拟读取失败'); };
  await assert.rejects(manager.terminalWorkingDirectory(1, payload));
  channels[0].desktopReadWorkingDirectory = async () => ({ path:'/srv' });
  assert.deepEqual(await manager.terminalWorkingDirectory(1, payload), { path:'/srv' });
  assert.equal(manager.sessions.get(session.sessionId).status, 'open');
});

function probeClient(output, code = 0) {
  const client = new EventEmitter();
  client.calls = [];
  client.exec = (command, options, accept) => {
    client.calls.push({ command, options });
    const channel = new TerminalChannel();
    accept(null, channel);
    queueMicrotask(() => { channel.emit('data', Buffer.from(output)); channel.emit('close', code); });
  };
  return client;
}

test('Shell 探测仅接受已知完整路径，拒绝额外输出及失败退出', async () => {
  for (const shell of ['/bin/bash', '/usr/local/bin/zsh', '/bin/sh', '/bin/dash', '/bin/ash', '/bin/ksh93']) {
    const client = probeClient(shell);
    assert.equal(await probeTerminalShell(client), true);
    assert.deepEqual(client.calls, [{ command: 'printf \'%s\' "$SHELL"', options: { pty: false } }]);
    assert.equal(client.listenerCount('close'), 0);
  }
  for (const shell of ['/bin/fish', '/bin/bash\n', '/bin/bash; echo unsafe', 'welcome /bin/bash', '', 'x'.repeat(4097)]) {
    assert.equal(await probeTerminalShell(probeClient(shell)), false);
  }
  assert.equal(await probeTerminalShell(probeClient('/bin/bash', 1)), false);
});

test('Shell 探测有时限，超时和断线后的迟到通道被释放', async () => {
  const client = new EventEmitter();
  let accept;
  client.exec = (_command, _options, callback) => { accept = callback; };
  assert.equal(await probeTerminalShell(client, 10), false);
  const late = new TerminalChannel();
  accept(null, late);
  assert.equal(late.destroyed, true);
  const pending = probeTerminalShell(client);
  client.emit('close');
  assert.equal(await pending, false);
  assert.equal(client.listenerCount('close'), 0);
});

test('broker 缓存 Shell 探测，关闭配色仍识别终端进程且不配置颜色', async () => {
  const broker = new SshBroker({});
  const client = probeClient('/bin/bash');
  const channels = [];
  client.shell = (_options, accept) => { const channel = new TerminalChannel(); channels.push(channel); accept(null, channel); };
  broker.sessions.set('scope', { client });
  const disabled = await broker.openTerminal('scope', { defaultColors: false });
  assert.equal(client.calls.length, 1);
  assert.equal(disabled.desktopStartupCommand, ':');
  assert.equal(disabled.desktopTrackDirectory, true);
  const [first, second] = await Promise.all([broker.openTerminal('scope'), broker.openTerminal('scope')]);
  assert.equal(client.calls.length, 1);
  assert.equal(first.desktopStartupCommand, DEFAULT_TERMINAL_COLORS);
  assert.equal(second.desktopStartupCommand, DEFAULT_TERMINAL_COLORS);
  assert.ok(channels.every(channel => channel.writes.length === 0), 'broker 只准备配置，等待管理器确认生命周期后发送');
  for (const channel of channels) channel.destroy();
  const unknown = probeClient('/bin/fish');
  unknown.shell = client.shell;
  broker.sessions.set('scope', { client: unknown });
  const skipped = await broker.openTerminal('scope');
  assert.equal(skipped.desktopStartupCommand, null);
  assert.equal(unknown.calls.length, 1);
  skipped.destroy();
});

test('静默初始化识别所有分包边界，不泄漏命令回显且完整保留后续 UTF-8 字节', async () => {
  const sample = createTerminalStartup(DEFAULT_TERMINAL_COLORS);
  const size = startupMarker(sample.command).length;
  sample.cancel();
  for (let split = 0; split <= size; split += 1) {
    const startup = createTerminalStartup(DEFAULT_TERMINAL_COLORS);
    const marker = startupMarker(startup.command);
    const prompt = Buffer.from('operator@example:~$ 中文😀');
    assert.equal(startup.consume(Buffer.from('登录横幅\r\n' + startup.command + '\r\n' + startup.command)).length, 0);
    assert.equal(startup.done, false, '可见命令中的标记文本不能提前结束初始化');
    assert.equal(startup.consume(marker.subarray(0, split)).length, 0);
    const tail = startup.consume(Buffer.concat([marker.subarray(split), prompt.subarray(0, prompt.length - 2)]));
    const last = startup.consume(prompt.subarray(prompt.length - 2));
    await startup.ready;
    assert.deepEqual(Buffer.concat([tail, last]), prompt);
    const userText = Buffer.from(DEFAULT_TERMINAL_COLORS + '\r\n\x1b[32m用户正常输出\x1b[0m');
    assert.deepEqual(startup.consume(userText), userText, '初始化完成后不再过滤任何用户命令或输出');
  }
});

test('静默初始化超时、输出超限和取消都会结束等待，不无限隐藏内容', async () => {
  const timed = createTerminalStartup(DEFAULT_TERMINAL_COLORS, { timeoutMs: 10 });
  await assert.rejects(timed.ready, { code: 'TERMINAL_STARTUP_TIMEOUT' });
  const bounded = createTerminalStartup(DEFAULT_TERMINAL_COLORS, { maxBytes: 64 });
  bounded.consume(Buffer.alloc(65, 97));
  await assert.rejects(bounded.ready, { code: 'TERMINAL_STARTUP_FAILED' });
  const cancelled = createTerminalStartup(DEFAULT_TERMINAL_COLORS);
  cancelled.cancel();
  await assert.rejects(cancelled.ready, { code: 'TERMINAL_CLOSED' });
  assert.equal(cancelled.consume(startupMarker(cancelled.command)).length, 0);
});

test('配置写入完成仍须等待远端确认，确认前断线不会返回可用会话', async (t) => {
  const channel = new TerminalChannel();
  channel.desktopStartupCommand = DEFAULT_TERMINAL_COLORS;
  const { manager } = fixture(t, { openTerminal: async () => channel });
  let resolved = false;
  const opening = manager.openTerminal(1, scope).then(result => { resolved = true; return result; });
  const rejected = assert.rejects(opening, { code: 'TERMINAL_CLOSED' });
  await delay(0);
  channel.push(channel.writes[0]);
  await delay(0);
  assert.equal(resolved, false);
  const record = [...manager.sessions.values()][0];
  assert.equal(record.queuedBytes, 0, '启动脚本不进入输出或回滚缓冲');
  manager.closeOwner(1);
  await rejected;
  assert.equal(channel.destroyed, true);
});

test('自动恢复绑定原窗口、标签和服务器配置，且不重放旧输入', async (t) => {
  const { manager, channels, runtime, state } = fixture(t);
  const session = await manager.openTerminal(1, { ...scope, tabId:'tab-a' });
  await manager.writeTerminal(1, { ...scope, sessionId:session.sessionId, data:'previous-input' });
  runtime.emit('lifecycle', { ...scope, type:'lost' });
  const closed = await manager.readTerminal(1, { ...scope, sessionId:session.sessionId });
  assert.equal(closed.closeReason, 'connection-lost');
  assert.equal(closed.recoverable, true);
  state.generation += 1;
  for (const [owner, payload] of [
    [2, { ...scope, tabId:'tab-a' }],
    [1, { ...scope, tabId:'tab-b' }],
    [1, { ...scope, pluginInstanceId:'another-server', tabId:'tab-a' }],
  ]) await assert.rejects(manager.openTerminal(owner, { ...payload, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
  const results = await Promise.all([1,2].map(() => manager.openTerminal(1, { ...scope, tabId:'tab-a', recoveryOf:session.sessionId })));
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.notEqual(results[0].sessionId, session.sessionId);
  assert.equal(channels.length, 2);
  assert.equal(channels[1].writes.length, 0);
});

test('正常 Shell 退出、主动结束会话和配置变化不允许自动恢复', async (t) => {
  for (const reason of ['exit', 'manual', 'configuration', 'credentials']) {
    await t.test(reason, async (child) => {
      const { manager, channels, runtime, state } = fixture(child);
      const session = await manager.openTerminal(1, scope);
      if (reason === 'exit') { channels[0].emit('exit', 0); channels[0].emit('end'); }
      runtime.emit('lifecycle', { ...scope, type:'lost' });
      if (reason === 'manual') await manager.closeTerminal(1, { ...scope, sessionId:session.sessionId });
      if (reason === 'configuration') manager.closeScope(scope, 'configuration-changed');
      if (reason === 'credentials') state.pluginData = { auth:{type:'agent',username:'changed-user'} };
      await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
      assert.equal(channels.length, 1);
    });
  }
});

test('通道先关闭后收到断线通知仍可恢复，未知关闭不会直接重开', async (t) => {
  const { manager, channels, runtime } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  const payload = { ...scope, sessionId:session.sessionId };
  channels[0].emit('end');
  assert.equal((await manager.readTerminal(1, payload)).recoverable, false);
  await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
  runtime.emit('lifecycle', { ...scope, type:'lost' });
  assert.equal((await manager.readTerminal(1, payload)).recoverable, true);
  const next = await manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId });
  assert.notEqual(next.sessionId, session.sessionId);
});

test('网络切换和唤醒保留恢复资格，配置变更撤销资格', async (t) => {
  for (const reason of ['network-interface-change', 'system-resume', 'configuration-change']) {
    await t.test(reason, async (child) => {
      const { manager, runtime } = fixture(child);
      const session = await manager.openTerminal(1, scope);
      runtime.emit('lifecycle', { ...scope, type:'disconnected', reason });
      const result = await manager.readTerminal(1, { ...scope, sessionId:session.sessionId });
      assert.equal(result.recoverable, reason !== 'configuration-change');
    });
  }
});

test('恢复打开失败保留原恢复资格，重试可成功且不会增加活动会话', async (t) => {
  const { manager, runtime } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  runtime.emit('lifecycle', { ...scope, type:'lost' });
  const open = runtime.openTerminal;
  runtime.openTerminal = async () => { throw new Error('模拟通道打开失败'); };
  await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_OPEN_FAILED' });
  assert.equal(manager.sessions.size, 1);
  runtime.openTerminal = open;
  assert.equal((await manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId })).status, 'open');
  assert.equal(manager.sessions.size, 1);
});

test('恢复中停止原终端会关闭迟到的通道，不影响同服务器其他终端', async (t) => {
  const { manager, runtime, channels } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  channels[0].emit('error', new Error('模拟终端通道错误'));
  const unaffected = await manager.openTerminal(1, { ...scope, tabId:'unaffected' });
  let release;
  runtime.openTerminal = () => new Promise(resolve => { release = resolve; });
  const pending = manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId });
  await delay(0);
  await manager.closeTerminal(1, { ...scope, sessionId:session.sessionId });
  const late = new TerminalChannel();
  release(late);
  await assert.rejects(pending, { code:'TERMINAL_CLOSED' });
  assert.equal(late.destroyed, true);
  assert.equal(manager.sessions.get(unaffected.sessionId).status, 'open');
  await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
});

test('八个终端按任意顺序恢复时保留尚未恢复的资格，并保持会话上限', async (t) => {
  const { manager, runtime, channels } = fixture(t);
  const previous = [];
  for (let index=0;index<8;index++) previous.push(await manager.openTerminal(1, { ...scope, tabId:'tab-'+index }));
  runtime.emit('lifecycle', { ...scope, type:'lost' });
  for (const index of [7,0,5,2,6,1,4,3]) {
    await manager.openTerminal(1, { ...scope, tabId:'tab-'+index, recoveryOf:previous[index].sessionId });
    assert.equal(manager.sessions.size, 8);
  }
  assert.equal(channels.length, 16);
  await assert.rejects(manager.openTerminal(1, { ...scope, tabId:'extra' }), { code:'TERMINAL_LIMIT_REACHED' });
});

test('未知关闭已经稳定后，未来无关断线不能重新获得恢复资格', async (t) => {
  const { manager, channels, runtime } = fixture(t);
  const session = await manager.openTerminal(1, scope);
  channels[0].emit('end');
  await new Promise(resolve => setImmediate(resolve));
  runtime.emit('lifecycle', { ...scope, type:'lost' });
  const result = await manager.readTerminal(1, { ...scope, sessionId:session.sessionId });
  assert.equal(result.recoverable, false);
  await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
});

test('主动断开服务器后等待重新连接，只恢复原来活动的终端', async (t) => {
  for (const reason of ['user', 'user-plugin-disconnect']) {
    await t.test(reason, async (child) => {
      const { manager, runtime, state, channels } = fixture(child);
      const active = await manager.openTerminal(1, { ...scope, tabId:'active' });
      const stopped = await manager.openTerminal(1, { ...scope, tabId:'stopped' });
      const exited = await manager.openTerminal(1, { ...scope, tabId:'exited' });
      const unknown = await manager.openTerminal(1, { ...scope, tabId:'unknown' });
      await manager.writeTerminal(1, { ...scope, sessionId:active.sessionId, data:'unsent-command-fragment' });
      await manager.closeTerminal(1, { ...scope, sessionId:stopped.sessionId });
      channels[2].emit('exit', 0);
      channels[2].emit('end');
      channels[3].emit('end');
      await new Promise(resolve => setImmediate(resolve));
      state.connected = false;
      runtime.emit('lifecycle', { ...scope, type:'disconnected', reason });
      const closed = await manager.readTerminal(1, { ...scope, sessionId:active.sessionId });
      assert.equal(closed.closeReason, 'user-disconnected');
      assert.equal(closed.recoverable, true);
      await assert.rejects(manager.openTerminal(1, { ...scope, tabId:'active', recoveryOf:active.sessionId }), { code:'SSH_NOT_CONNECTED' });
      assert.equal(channels.length, 4);
      state.connected = true;
      state.generation++;
      runtime.emit('lifecycle', { ...scope, type:'connected', generation:state.generation });
      const next = await manager.openTerminal(1, { ...scope, tabId:'active', recoveryOf:active.sessionId });
      assert.notEqual(next.sessionId, active.sessionId);
      assert.equal(channels[4].writes.length, 0);
      for (const [session, tabId] of [[stopped,'stopped'],[exited,'exited'],[unknown,'unknown']]) {
        assert.equal((await manager.readTerminal(1, { ...scope, sessionId:session.sessionId })).recoverable, false);
        await assert.rejects(manager.openTerminal(1, { ...scope, tabId, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
      }
      assert.equal(channels.length, 5);
    });
  }
});

test('主动断开期间停止恢复或修改配置，重连后不再恢复旧终端', async (t) => {
  for (const action of ['stop', 'configuration', 'credentials']) {
    await t.test(action, async (child) => {
      const { manager, runtime, state, channels } = fixture(child);
      const session = await manager.openTerminal(1, scope);
      state.connected = false;
      runtime.emit('lifecycle', { ...scope, type:'disconnected', reason:'user-plugin-disconnect' });
      if (action === 'stop') await manager.closeTerminal(1, { ...scope, sessionId:session.sessionId });
      if (action === 'configuration') manager.closeScope(scope, 'configuration-changed');
      if (action === 'credentials') state.pluginData = { auth:{type:'agent',username:'changed-user'} };
      runtime.emit('lifecycle', { ...scope, type:'disconnected', reason:'user-plugin-disconnect' });
      state.connected = true;
      state.generation++;
      await assert.rejects(manager.openTerminal(1, { ...scope, recoveryOf:session.sessionId }), { code:'TERMINAL_RECOVERY_STOPPED' });
      assert.equal(channels.length, 1);
    });
  }
});

test('主动断开可关联同轮通道关闭事件，但其他系统断开不获得恢复资格', async (t) => {
  for (const reason of ['user-plugin-disconnect', 'configuration-change', 'stale-connect-result', 'app-exit']) {
    await t.test(reason, async (child) => {
      const { manager, runtime, channels } = fixture(child);
      const session = await manager.openTerminal(1, scope);
      channels[0].emit('end');
      runtime.emit('lifecycle', { ...scope, type:'disconnected', reason });
      assert.equal((await manager.readTerminal(1, { ...scope, sessionId:session.sessionId })).recoverable, reason === 'user-plugin-disconnect');
    });
  }
});
