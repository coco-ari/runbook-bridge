import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

const scope = { projectId: 'clipboard-project', environmentId: 'test', pluginInstanceId: 'server' };
async function fixture(t) {
  const runtime = new EventEmitter();
  const state = { connected: true, generation: 1, destroyed: false, clipboard: '示例第一行\n示例第二行', reads: 0, writes: 0 };
  runtime.status = () => state;
  runtime.openTerminal = async () => new Duplex({ read() {}, write(_data, _encoding, done) { done(); } });
  const manager = new ServerWorkspaceManager({ serverRuntime: runtime, workspaceStore: {
    getPlugin: async () => ({ ...scope, pluginType: 'server', revision: 1 }), appendAudit: async () => {},
  } });
  t.after(() => manager.dispose());
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => state.destroyed });
  const event = { sender, senderFrame: sender.mainFrame };
  const handlers = new Map();
  const adapter = { readText() { state.reads += 1; return state.clipboard; }, writeText(text) { state.writes += 1; state.clipboard = text; } };
  registerServerWorkspaceIpc({ handle: (name, action) => handlers.set(name, action) }, {
    serverWorkspaceManager: manager, terminalClipboard: adapter, isWorkspaceRenderer: selected => selected === sender,
  });
  const session = await manager.openTerminal('renderer:1', { ...scope, defaultColors: false });
  const payload = { ...scope, sessionId: session.sessionId, action: 'paste' };
  const invoke = (input = payload, source = event) => handlers.get('v2:server-terminal-clipboard')(source, input);
  return { state, manager, sender, event, adapter, payload, invoke };
}

test('终端剪贴板支持多行文本，拒绝跨会话、额外字段及非主框架', async t => {
  const h = await fixture(t);
  assert.equal((await h.invoke()).data.text, h.state.clipboard);
  assert.deepEqual(await h.invoke({ ...h.payload, action: 'copy', text: '复制第一行\n复制第二行' }), { ok: true, data: {} });
  assert.equal(h.state.clipboard, '复制第一行\n复制第二行');
  for (const input of [
    { ...h.payload, sessionId: 'other' }, { ...h.payload, environmentId: 'other' },
    { ...h.payload, action: 'execute' }, { ...h.payload, text: 'injected' }, { ...h.payload, command: 'injected' },
  ]) assert.equal((await h.invoke(input)).ok, false);
  assert.equal((await h.invoke(h.payload, { ...h.event, senderFrame: {} })).error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(h.state.reads, 1);
  assert.equal(h.state.writes, 1);
});

test('剪贴板访问检查连接换代与窗口销毁，超限及适配器错误不泄漏内容', async t => {
  const h = await fixture(t);
  h.state.clipboard = '中'.repeat(30000);
  assert.equal((await h.invoke()).error.code, 'CLIPBOARD_TOO_LARGE');
  assert.equal((await h.invoke({ ...h.payload, action: 'copy', text: 'a'.repeat(1024 * 1024 + 1) })).error.code, 'INVALID_ARGUMENT');
  h.adapter.readText = () => { throw Error('EXAMPLE_PRIVATE_CLIPBOARD'); };
  const failed = await h.invoke();
  assert.equal(failed.error.code, 'CLIPBOARD_UNAVAILABLE');
  assert.ok(!JSON.stringify(failed).includes('EXAMPLE_PRIVATE_CLIPBOARD'));
  h.state.generation += 1;
  assert.equal((await h.invoke()).error.code, 'TERMINAL_CLOSED');
  h.state.destroyed = true;
  assert.equal((await h.invoke()).error.code, 'WORKSPACE_ACCESS_DENIED');
});

test('会话检查等待期间窗口销毁，拒绝读取剪贴板', async t => {
  const h = await fixture(t);
  const original = h.manager.requireRecord.bind(h.manager);
  h.manager.requireRecord = async (...args) => { const record = await original(...args); h.state.destroyed = true; return record; };
  assert.equal((await h.invoke()).error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(h.state.reads, 0);
});
