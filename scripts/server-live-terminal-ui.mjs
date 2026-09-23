import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { clipboard } from 'electron';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

// 只开启无历史、无启动配置的本次 PTY；页面输入必须逐字匹配测试预先登记的内容。
export async function openLiveTerminalUiProbe(scope) {
  const host = process.env.RUNBOOK_LIVE_HOST, username = process.env.RUNBOOK_LIVE_USER, password = process.env.RUNBOOK_LIVE_PASSWORD;
  delete process.env.RUNBOOK_LIVE_PASSWORD;
  assert.ok(net.isIP(host ?? '') === 4 && username && password);
  assert.ok(!process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR, '真实终端专项禁止截图');
  const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '隔离终端实测',
    target: { host, port: 22 }, auth: { type: 'password', username }, uplink: { type: 'direct' }, limits: { timeoutMs: 10000, maxBytes: 65536 }, sources: [], actions: [] };
  let auditEvents = 0, closed = false, clipboardTouched = false, lastClipboard = '', copyExpected = '';
  const store = {
    getPlugin: async (...keys) => { assert.deepEqual(keys, Object.values(scope)); return plugin; },
    updatePlugin: async (_project, _environment, _id, patch) => Object.assign(plugin, patch),
    appendAudit: async (_project, entry) => { assert.ok(!JSON.stringify(entry).includes(password)); auditEvents += 1; },
  };
  const runtime = new ServerPluginRuntime(store, { load: async () => null }, { resolver: { resolve: async value => {
    assert.equal(value, host); return [{ address: host, family: 4 }];
  } } });
  const operations = new ServerOperations(runtime, store);
  const manager = new ServerWorkspaceManager({ workspaceStore: store, serverRuntime: runtime, serverOperations: operations });
  const formats = clipboard.availableFormats();
  const clipboardSupported = formats.every(format => ['text/plain', 'text/html', 'text/rtf', 'image/png', 'image/bmp'].includes(format));
  const savedClipboard = clipboardSupported ? { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() } : null;
  const events = [], sessions = new Map(), expected = new Map(), output = new Map(), decoders = new Map();
  let writes = 0, writeBytes = 0, clipboardReads = 0, clipboardCopies = 0;
  const checkScope = input => { for (const [key, value] of Object.entries(scope)) assert.equal(input[key], value); };
  const adapters = {};
  for (const method of ['openTerminal', 'readTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal', 'terminalWorkingDirectory']) {
    adapters[method] = async (owner, input) => {
      checkScope(input);
      if (method === 'writeTerminal') {
        const remaining = expected.get(input.sessionId) ?? '';
        assert.ok((input.encoding ?? 'utf8') === 'utf8' && typeof input.data === 'string' && input.data.length > 0);
        assert.ok(remaining.startsWith(input.data), '拒绝未登记的真实终端输入');
        expected.set(input.sessionId, remaining.slice(input.data.length)); writes += 1; writeBytes += Buffer.byteLength(input.data);
      }
      const start = performance.now();
      const result = await manager[method](owner, input);
      if (method === 'openTerminal') {
        sessions.set(result.sessionId, { owner, tabId: input.tabId });
        decoders.set(result.sessionId, new TextDecoder());
      }
      if (method === 'readTerminal') {
        const text = decoders.get(input.sessionId).decode(result.data, { stream: true });
        const content = (output.get(input.sessionId) ?? '') + text;
        assert.ok(content.length <= 512 * 1024, '实测终端输出必须有界');
        assert.ok(!content.includes(password), '终端不得包含应用管理的凭据');
        output.set(input.sessionId, content);
      } else if (method !== 'writeTerminal') events.push({ method, ms: performance.now() - start,
        ...(method === 'resizeTerminal' ? { sessionId: input.sessionId, cols: input.cols, rows: input.rows, at: Date.now() } : {}) });
      return result;
    };
  }
  adapters.requireRecord = (...args) => manager.requireRecord(...args);
  adapters.closeOwner = owner => manager.closeOwner(owner);
  const dispose = async () => {
    if (closed) return; closed = true;
    let clipboardRestored = !clipboardTouched;
    try {
      manager.dispose(); operations.docker.dispose(); await runtime.broker.closeAll();
      assert.equal(manager.sessions.size, 0);
    } finally {
      // 用户若在测试期间更新剪贴板，保留用户的新内容；会话清理失败也仍尝试恢复。
      if (clipboardTouched && clipboard.readText() === lastClipboard) { clipboard.write(savedClipboard); clipboardRestored = true; }
    }
    process.stdout.write(JSON.stringify({ liveTerminalUiCleanup: 'passed', auditEvents, clipboardRestored }) + '\n');
  };
  try {
    await assert.rejects(runtime.connect(plugin, { password }), error => {
      if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
      plugin.target.hostKeyFingerprint = error.details.fingerprint; return true;
    });
    await runtime.connect(plugin, { password });
    const client = runtime.broker.requireSession(runtime.key(plugin)).client;
    client.shell = (window, callback) => client.exec("env INPUTRC=/dev/null HISTFILE= HISTSIZE=0 HISTFILESIZE=0 PS1='probe> ' PS2='probe-cont> ' PROMPT_COMMAND= /bin/bash --noprofile --norc -i", { pty: window }, callback);
    return {
      register(ipcMain, isWorkspaceRenderer) {
        registerServerWorkspaceIpc({ handle: (name, callback) => {
          if (!name.startsWith('v2:server-terminal-')) return;
          ipcMain.removeHandler(name); ipcMain.handle(name, callback);
        } }, { isWorkspaceRenderer, serverWorkspaceManager: adapters, terminalClipboard: {
          readText() { assert.ok(clipboardSupported && clipboardTouched); const text = clipboard.readText(); assert.ok(text === lastClipboard, '剪贴板已被测试以外的操作更新'); clipboardReads += 1; return text; },
          writeText(text) { assert.ok(clipboardSupported && copyExpected && text === copyExpected, '只复制已核对的合成选区'); clipboard.writeText(text); lastClipboard = text; clipboardTouched = true; clipboardCopies += 1; },
        } });
      },
      snapshot: () => ({ events: [...events], writes, writeBytes, clipboardReads, clipboardCopies, clipboardSupported,
        sessions: [...sessions].map(([sessionId, value]) => ({ sessionId, tabId: value.tabId, status: manager.sessions.get(sessionId)?.status })),
        pendingInput: [...expected.values()].reduce((sum, value) => sum + value.length, 0) }),
      expect(sessionId, text) { assert.ok(sessions.has(sessionId)); assert.ok(!expected.get(sessionId), '上一批实测输入尚未发送完'); expected.set(sessionId, text); },
      lastReportedSize(sessionId) { const match = [...(output.get(sessionId) ?? '').matchAll(/(?:^|[\r\n])(\d{1,3}) (\d{1,3})(?:[\r\n]|$)/gu)].at(-1); return match ? { rows: Number(match[1]), cols: Number(match[2]) } : null; },
      hasOutput(sessionId, text) { return Boolean(output.get(sessionId)?.includes(text)); },
      setClipboard(text) { assert.ok(clipboardSupported && !text.includes(password)); clipboard.writeText(text); lastClipboard = text; clipboardTouched = true; },
      expectCopy(text) { copyExpected = text; },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw Object.assign(new Error('真实终端专项初始化失败'), { code: error.code ?? error.name });
  }
}
