import crypto from 'node:crypto';
import { ServerWorkspaceMetrics } from './server-workspace-metrics.mjs';
import { createTerminalStartup } from './server-terminal-startup.mjs';
import { AppError } from './errors.mjs';
import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';

const READ_BYTES = 64 * 1024;
const OUTPUT_HIGH_WATER = 512 * 1024;
const OUTPUT_LOW_WATER = 128 * 1024;
const INPUT_QUEUE_BYTES = 256 * 1024;
const MAX_SESSIONS = 8;
const RECOVERABLE_CLOSE_REASONS = new Set(['connection-lost', 'channel-error', 'input-timeout', 'user-disconnected']);
const MANUAL_DISCONNECT_REASONS = new Set(['user', 'user-plugin-disconnect']);
const NETWORK_RECONNECT_REASONS = new Set(['network-change', 'network-interface-change', 'system-resume']);

function normalizeScope(payload) {
  const scope = {};
  for (const key of ['projectId', 'environmentId', 'pluginInstanceId']) {
    const value = payload?.[key];
    if (typeof value !== 'string' || !value || value.length > 256 || /[\s/\\\u0000-\u001f\u007f]/u.test(value)) {
      throw new AppError('INVALID_ARGUMENT', '服务器工作区需要完整且有效的项目、环境和插件标识。');
    }
    scope[key] = value;
  }
  return scope;
}

function scopeKey(scope) {
  return `${scope.projectId}/${scope.environmentId}/${scope.pluginInstanceId}`;
}

function ownerKey(ownerId) {
  if (!((Number.isSafeInteger(ownerId) && ownerId > 0) || (typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 256))) {
    throw new AppError('WORKSPACE_OWNER_REQUIRED', '服务器工作区必须由有效桌面窗口打开。');
  }
  return `${typeof ownerId}:${ownerId}`;
}

function dimensions(payload) {
  const cols = payload?.cols ?? 80;
  const rows = payload?.rows ?? 24;
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) {
    throw new AppError('INVALID_ARGUMENT', '终端尺寸必须为 2–500 列、1–300 行。');
  }
  return { cols, rows };
}

function publicSession(record) {
  return { sessionId: record.sessionId, status: record.status, cols: record.cols, rows: record.rows };
}

export class ServerWorkspaceManager {
  constructor({ workspaceStore, serverRuntime, serverOperations }) {
    this.workspaceStore = workspaceStore;
    this.serverRuntime = serverRuntime;
    this.serverOperations = serverOperations;
    this.metrics = new ServerWorkspaceMetrics({ workspaceStore, serverRuntime, requirePlugin:scope => this.requirePlugin(scope) });
    this.sessions = new Map();
    this.ownerEpochs = new Map();
    this.scopeEpochs = new Map();
    this.disposed = false;
    this.lifecycleHandler = (event) => {
      if (event.type !== 'connected') this.closeScope(event,
        event.type === 'lost' || NETWORK_RECONNECT_REASONS.has(event.reason) ? 'connection-lost'
          : MANUAL_DISCONNECT_REASONS.has(event.reason) ? 'user-disconnected' : 'disconnected');
    };
    serverRuntime.on('lifecycle', this.lifecycleHandler);
  }

  readMetrics(ownerId, payload) { return this.metrics.read(ownerKey(ownerId), normalizeScope(payload), payload.kind); }

  stopMetrics(ownerId, payload) { return this.metrics.stop(ownerKey(ownerId), normalizeScope(payload)); }

  async requirePlugin(scope) {
    if (this.disposed) throw new AppError('WORKSPACE_CLOSED', '服务器工作区已经关闭。');
    const plugin = await this.workspaceStore.getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId);
    if (plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', '该工作区只支持 Server 插件。');
    if (!this.serverRuntime.status(plugin)?.connected) throw new AppError('SSH_NOT_CONNECTED', '请先连接服务器，再打开工作区。');
    return plugin;
  }

  async audit(record, type, reason, required = false) {
    try {
      await this.workspaceStore.appendAudit(record.scope.projectId, {
        ...record.scope, pluginType: 'server', type, origin: 'desktop-human',
        actor:type === 'terminal-open' || ['user','user-closed','closed','workspace-closed','window-closed','application-closed'].includes(reason) ? 'user' : 'system',
        pluginNameSnapshot:record.plugin?.displayName,
        sessionId: record.sessionId, generation: record.generation,
        ...(reason ? { reason } : {}),
      });
    } catch {
      // 打开人工终端前必须先留下作用域记录，关闭记录失败时不阻塞资源释放。
      if (required) throw new AppError('TERMINAL_AUDIT_UNAVAILABLE', '无法记录终端会话，请检查本地审计存储后重试。');
    }
  }

  async openTerminal(ownerId, payload) {
    const owner = ownerKey(ownerId);
    const defaultColors = payload?.defaultColors ?? true;
    if (payload?.defaultColors !== undefined && typeof payload.defaultColors !== 'boolean') throw new AppError('INVALID_ARGUMENT', '默认配色设置无效。');
    const tabId = payload?.tabId ?? 'default';
    if (typeof tabId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(tabId)) throw new AppError('INVALID_ARGUMENT', '终端标签标识无效。');
    const recoveryOf = payload?.recoveryOf;
    if (recoveryOf !== undefined && (typeof recoveryOf !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(recoveryOf))) throw new AppError('INVALID_ARGUMENT', '终端恢复标识无效。');
    const ownerEpoch = this.ownerEpochs.get(owner) ?? 0;
    const scope = normalizeScope(payload);
    const scopeKeys = [scope.projectId, `${scope.projectId}/${scope.environmentId}`, scopeKey(scope)];
    const scopeEpochs = scopeKeys.map((key) => this.scopeEpochs.get(key) ?? 0);
    const size = dimensions(payload);
    const plugin = await this.requirePlugin(scope);
    if (this.disposed || (this.ownerEpochs.get(owner) ?? 0) !== ownerEpoch
      || scopeKeys.some((key, index) => (this.scopeEpochs.get(key) ?? 0) !== scopeEpochs[index])) throw new AppError('WORKSPACE_CLOSED', '服务器工作区已经关闭。');
    const key = scopeKey(scope);
    const fingerprint = pluginConnectionFingerprint(plugin);
    const generation = this.serverRuntime.status(plugin).generation;
    const previous = recoveryOf ? this.sessions.get(recoveryOf) : null;
    // 恢复必须沿用原窗口、标签和连接配置，不能将断线前的授权带到其他服务器。
    if (recoveryOf && (!previous || previous.owner !== owner || scopeKey(previous.scope) !== key
      || previous.tabId !== tabId || previous.fingerprint !== fingerprint || !this.canRecover(previous))) {
      throw new AppError('TERMINAL_RECOVERY_STOPPED', '原终端已结束或连接配置已变化，请手动打开新终端。');
    }
    for (const record of this.sessions.values()) {
      if (record.owner !== owner || scopeKey(record.scope) !== key || record.tabId !== tabId) continue;
      if (['opening', 'open'].includes(record.status) && record.fingerprint === fingerprint && record.generation === generation) {
        record.plugin = plugin;
        record.revision = plugin.revision;
        record.nextValidationAt = Date.now() + 1000;
        return record.initializing ? record.opening : publicSession(record);
      }
      if (record === previous) continue;
      this.finish(record, 'replaced');
      this.release(record);
    }
    const owned = [...this.sessions.values()].filter((record) => record.owner === owner && record.status !== 'closed');
    if (owned.length >= MAX_SESSIONS) throw new AppError('TERMINAL_LIMIT_REACHED', '单个窗口最多同时打开 8 个服务器终端。');
    // 已关闭会话只保留有限条，避免反复打开服务器造成内存持续增长。
    const retired = [...this.sessions.values()].filter((record) => record.owner === owner && record.status === 'closed' && record !== previous);
    for (const record of retired.slice(0, Math.max(0, retired.length - MAX_SESSIONS + 1))) this.release(record);
    const record = {
      owner, scope, tabId, defaultColors, initializing: true, ...size, sessionId: crypto.randomUUID(), status: 'opening',
      revision: plugin.revision, fingerprint, generation, recoveryOf: recoveryOf ?? null, closeReason: null, remoteExited: false,
      plugin, nextValidationAt: Date.now() + 1000, validation: null,
      channel: null, chunks: [], queuedBytes: 0, inputBytes: 0, paused: false,
      waiter: null, reading: false, pendingWrites: new Set(), exitCode: null,
    };
    this.sessions.set(record.sessionId, record);
    record.opening = this.start(record, plugin);
    return record.opening;
  }

  async start(record, plugin) {
    try {
      await this.audit(record, 'terminal-open', undefined, true);
      if (this.disposed || record.status === 'closed') throw new AppError('TERMINAL_CLOSED', '终端打开操作已取消。');
      const channel = await this.serverRuntime.openTerminal(plugin, { cols: record.cols, rows: record.rows, defaultColors: record.defaultColors });
      if (this.disposed || record.status === 'closed' || !this.sessions.has(record.sessionId)) {
        channel.on('error', () => undefined);
        channel.destroy();
        throw new AppError('TERMINAL_CLOSED', '终端打开操作已取消。');
      }
      record.channel = channel;
      record.status = 'open';
      record.startup = channel.desktopStartupCommand ? createTerminalStartup(channel.desktopStartupCommand, { identifyShell:channel.desktopTrackDirectory === true }) : null;
      record.onData = (chunk, stderr = false) => {
        let buffer = Buffer.from(chunk);
        if (record.startup) buffer = stderr && !record.startup.done ? Buffer.alloc(0) : record.startup.consume(buffer);
        if (!buffer.length || record.status === 'closed') return;
        record.chunks.push(buffer);
        record.queuedBytes += buffer.length;
        if (record.queuedBytes >= OUTPUT_HIGH_WATER && !record.paused) {
          record.paused = true;
          channel.pause();
          channel.stderr?.pause();
        }
        record.waiter?.();
      };
      channel.on('data', record.onData);
      channel.stderr?.on('data', (chunk) => record.onData(chunk, true));
      channel.on('exit', (code) => {
        record.remoteExited = true;
        if (Number.isInteger(code)) record.exitCode = code;
        if (record.closeReason === 'channel-closed') record.closeReason = 'remote-exit';
      });
      channel.once('end', () => this.finish(record, record.remoteExited ? 'remote-exit' : 'channel-closed', false));
      channel.once('close', (code) => {
        if (Number.isInteger(code)) { record.exitCode = code; record.remoteExited = true; }
        this.finish(record, record.remoteExited ? 'remote-exit' : 'channel-closed', false);
      });
      channel.on('error', () => this.finish(record, 'channel-error'));
      channel.resume();
      channel.stderr?.resume();
      // 完成所有权复核后才发送固定配置；就绪前拒绝人工输入，并复用同一初始化 Promise。
      if (record.startup) await Promise.all([this.writeRecord(record, Buffer.from(record.startup.command)), record.startup.ready]);
      record.shellPid = record.startup?.shellPid ?? null;
      record.startup = null;
      if (record.status === 'closed') throw new AppError('TERMINAL_CLOSED', '终端打开操作已取消。');
      record.initializing = false;
      if (record.recoveryOf) {
        const previous = this.sessions.get(record.recoveryOf);
        if (previous) this.release(previous);
      }
      return publicSession(record);
    } catch (error) {
      this.finish(record, 'open-failed');
      this.release(record);
      if (error instanceof AppError) throw error;
      throw new AppError('TERMINAL_OPEN_FAILED', '无法打开服务器终端。');
    }
  }

  async requireRecord(ownerId, payload, { allowClosed = false } = {}) {
    const owner = ownerKey(ownerId);
    const scope = normalizeScope(payload);
    const record = this.sessions.get(payload?.sessionId);
    if (!record || record.owner !== owner || scopeKey(record.scope) !== scopeKey(scope)) {
      throw new AppError('TERMINAL_SCOPE_MISMATCH', '终端不属于当前窗口或服务器。');
    }
    if (record.status !== 'closed') {
      try {
        const connection = this.serverRuntime.status(record.plugin);
        if (!connection.connected || connection.generation !== record.generation) {
          this.finish(record, 'connection-lost');
          throw new AppError('TERMINAL_CLOSED', '服务器连接已经变化，请重新打开终端。');
        }
        if (Date.now() >= record.nextValidationAt) {
          record.validation ??= this.requirePlugin(scope).finally(() => { record.validation = null; });
          const plugin = await record.validation;
          const currentConnection = this.serverRuntime.status(plugin);
          if (pluginConnectionFingerprint(plugin) !== record.fingerprint) {
            this.finish(record, 'scope-invalidated');
            throw new AppError('TERMINAL_CLOSED', '服务器连接配置已经变化，请重新打开终端。');
          }
          if (!currentConnection.connected || currentConnection.generation !== record.generation) {
            this.finish(record, 'connection-lost');
            throw new AppError('TERMINAL_CLOSED', '服务器连接配置已经变化，请重新打开终端。');
          }
          // 名称和 Agent 策略更新不改变人工会话，仅刷新当前插件记录。
          record.plugin = plugin;
          record.revision = plugin.revision;
          record.nextValidationAt = Date.now() + 1000;
        }
      } catch (error) {
        this.finish(record, 'scope-invalidated');
        if (!allowClosed) throw error;
      }
    }
    if (!allowClosed && (record.status !== 'open' || record.initializing)) throw new AppError('TERMINAL_CLOSED', '终端会话已经结束，请重新打开终端。');
    return record;
  }

  async readTerminal(ownerId, payload) {
    const record = await this.requireRecord(ownerId, payload, { allowClosed: true });
    if (record.reading) throw new AppError('TERMINAL_READ_BUSY', '该终端已有待处理的读取请求。');
    record.reading = true;
    try {
      if (!record.queuedBytes && record.status !== 'closed') {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { record.waiter = null; resolve(); }, 250);
          record.waiter = () => { clearTimeout(timer); record.waiter = null; resolve(); };
        });
      }
      const data = new Uint8Array(Math.min(record.queuedBytes, READ_BYTES));
      let offset = 0;
      while (offset < data.length) {
        const head = record.chunks[0];
        const count = Math.min(head.length, data.length - offset);
        data.set(head.subarray(0, count), offset);
        if (count === head.length) record.chunks.shift();
        else record.chunks[0] = head.subarray(count);
        offset += count;
      }
      record.queuedBytes -= data.length;
      if (record.paused && record.queuedBytes <= OUTPUT_LOW_WATER && record.status !== 'closed') {
        record.paused = false;
        record.channel?.resume();
        record.channel?.stderr?.resume();
      }
      // 先排空 SSH 原始字节，再报告 EOF；UTF-8 的跨包字符由终端解码器拼接。
      const closed = record.status === 'closed' && !record.queuedBytes;
      return { data, status: closed ? 'closed' : 'open', ...(record.exitCode !== null ? { exitCode: record.exitCode } : {}),
        ...(closed ? { closeReason: record.closeReason, recoverable: this.canRecover(record) } : {}) };
    } finally {
      record.reading = false;
    }
  }

  async terminalWorkingDirectory(ownerId, payload) {
    const record = await this.requireRecord(ownerId, payload);
    if (!record.shellPid || typeof record.channel?.desktopReadWorkingDirectory !== 'function') {
      throw new AppError('TERMINAL_DIRECTORY_UNAVAILABLE', '当前终端暂不支持读取工作目录，请输入路径定位。');
    }
    // 目录查询独立于终端输入，并绑定窗口、标签、连接代次；同会话并发请求复用。
    if (!record.directoryRead) {
      record.directoryController = new AbortController();
      record.directoryRead = Promise.resolve().then(() => record.channel.desktopReadWorkingDirectory(record.shellPid, { signal:record.directoryController.signal })).then(async result => {
        record.nextValidationAt = 0;
        await this.requireRecord(ownerId, payload);
        return result;
      }).finally(() => {
        record.directoryController = null;
        record.directoryRead = null;
      });
    }
    return record.directoryRead;
  }

  async writeTerminal(ownerId, payload) {
    const encoding = payload?.encoding ?? 'utf8';
    if (!['utf8', 'binary'].includes(encoding) || typeof payload?.data !== 'string'
      || (encoding === 'binary' && /[^\u0000-\u00ff]/u.test(payload.data))
      || Buffer.byteLength(payload.data, encoding === 'binary' ? 'latin1' : 'utf8') > READ_BYTES) {
      throw new AppError('INVALID_ARGUMENT', '终端输入编码无效或单次输入超过 64 KiB。');
    }
    const record = await this.requireRecord(ownerId, payload);
    const data = Buffer.from(payload.data, encoding === 'binary' ? 'latin1' : 'utf8');
    return this.writeRecord(record, data);
  }

  async writeRecord(record, data) {
    if (record.status === 'closed') throw new AppError('TERMINAL_CLOSED', '终端会话已经结束。');
    if (record.inputBytes + data.length > INPUT_QUEUE_BYTES) throw new AppError('TERMINAL_INPUT_BUSY', '终端正在处理前面的输入，请稍后重试。');
    if (!data.length) return {};
    record.inputBytes += data.length;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const complete = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          record.pendingWrites.delete(complete);
          if (error) {
            this.finish(record, 'channel-error');
            reject(new AppError('TERMINAL_WRITE_FAILED', '终端输入未能完整发送；请检查会话状态后重试。'));
          }
          else resolve();
        };
        record.pendingWrites.add(complete);
        timer = setTimeout(() => { this.finish(record, 'input-timeout'); complete(true); }, 15_000);
        try { record.channel.write(data, complete); }
        catch { complete(true); }
      });
    } finally {
      record.inputBytes -= data.length;
    }
    return {};
  }

  async resizeTerminal(ownerId, payload) {
    const size = dimensions(payload);
    const record = await this.requireRecord(ownerId, payload);
    try { record.channel.setWindow(size.rows, size.cols, 0, 0); }
    catch { throw new AppError('TERMINAL_RESIZE_FAILED', '终端尺寸更新失败。'); }
    Object.assign(record, size);
    return {};
  }

  async closeTerminal(ownerId, payload) {
    const record = await this.requireRecord(ownerId, payload, { allowClosed: true });
    this.finish(record, 'user-closed');
    record.closeReason = 'user-closed';
    for (const pending of this.sessions.values()) {
      if (pending.recoveryOf === record.sessionId) this.finish(pending, 'user-closed');
    }
    return {};
  }

  canRecover(record) {
    return record.status === 'closed' && !record.remoteExited && RECOVERABLE_CLOSE_REASONS.has(record.closeReason);
  }

  finish(record, reason, destroy = true) {
    if (record.status === 'closed') return;
    record.status = 'closed';
    record.closeReason = reason;
    if (reason === 'channel-closed') {
      // 只关联同一轮关闭事件，避免未来断线复活早已结束但没有退出码的 Shell。
      record.pendingConnectionLoss = true;
      record.closeSettlement = setImmediate(() => { record.pendingConnectionLoss = false; record.closeSettlement = null; });
      record.closeSettlement.unref?.();
    }
    record.waiter?.();
    for (const complete of [...record.pendingWrites]) complete(true);
    record.startup?.cancel();
    record.directoryController?.abort();
    if (destroy) {
      try { record.channel?.close(); record.channel?.destroy(); } catch { /* 通道可能已经关闭。 */ }
    }
    void this.audit(record, 'terminal-close', reason);
  }

  release(record) {
    if (record.closeSettlement) clearImmediate(record.closeSettlement);
    record.waiter?.();
    for (const chunk of record.chunks) chunk.fill(0);
    record.chunks = [];
    record.queuedBytes = 0;
    this.sessions.delete(record.sessionId);
  }

  closeScope(scope, reason = 'scope-invalidated') {
    this.metrics.closeScope(scope);
    const key = [scope.projectId, scope.environmentId, scope.pluginInstanceId].filter(Boolean).join('/');
    this.scopeEpochs.set(key, (this.scopeEpochs.get(key) ?? 0) + 1);
    for (const record of this.sessions.values()) {
      if (record.scope.projectId === scope.projectId
        && (!scope.environmentId || record.scope.environmentId === scope.environmentId)
        && (!scope.pluginInstanceId || record.scope.pluginInstanceId === scope.pluginInstanceId)) {
        // SSH 关闭与通道关闭的事件顺序不固定；只保留活动或待恢复会话，不能复活已经退出或主动结束的终端。
        const resumable = RECOVERABLE_CLOSE_REASONS.has(reason);
        if (resumable && !record.remoteExited
          && (this.canRecover(record) || (record.closeReason === 'channel-closed' && record.pendingConnectionLoss))) record.closeReason = reason;
        if (!resumable && record.status === 'closed') record.closeReason = reason;
        this.finish(record, reason);
      }
    }
  }

  closeOwner(ownerId) {
    const owner = ownerKey(ownerId);
    this.metrics.closeOwner(owner);
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const record of this.sessions.values()) {
      if (record.owner !== owner) continue;
      this.finish(record, 'window-closed');
      this.release(record);
    }
  }

  dispose() {
    this.disposed = true;
    this.metrics.dispose();
    this.serverRuntime.removeListener('lifecycle', this.lifecycleHandler);
    for (const record of this.sessions.values()) {
      this.finish(record, 'application-closed');
      this.release(record);
    }
  }
}
