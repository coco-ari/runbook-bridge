import { downloadWorkspaceFile } from './server-download-transfer.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SshBroker } from './ssh-broker.mjs';
import { createConnectionSocket, createProxySocket, waitForConnection } from './proxy.mjs';
import { AppError } from './errors.mjs';
import { BoundedReadScheduler } from './bounded-read-scheduler.mjs';

function scopeKey(projectId, environmentId, pluginInstanceId) {
  return `${projectId}/${environmentId}/${pluginInstanceId}`;
}

function parseScopeKey(value) {
  const [projectId, environmentId, pluginInstanceId, ...rest] = String(value).split('/');
  if (!projectId || !environmentId || !pluginInstanceId || rest.length) throw new AppError('INVALID_ARGUMENT', 'Server 资源作用域无效。');
  return { projectId, environmentId, pluginInstanceId };
}

class ScopedServerStoreAdapter {
  constructor(workspaceStore) {
    this.workspaceStore = workspaceStore;
    this.overrides = new Map();
    this.overrideOwners = new Map();
  }

  setOverride(key, plugin, owner) {
    this.overrides.set(key,plugin);
    this.overrideOwners.set(key, owner);
  }

  clearOverride(key, owner) {
    if (this.overrideOwners.get(key) !== owner) return;
    this.overrides.delete(key);
    this.overrideOwners.delete(key);
  }

  async get(key) {
    const scope = parseScopeKey(key);
    const plugin = this.overrides.get(key) ?? await this.workspaceStore.getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId);
    if (plugin.pluginType !== 'server') throw new AppError('PLUGIN_TYPE_MISMATCH', '目标不是 Server 插件。');
    return {
      id: key,
      name: plugin.displayName,
      ssh: {
        host: plugin.target.host,
        port: plugin.target.port,
        username: plugin.auth.username,
        ...(plugin.target.hostKeyFingerprint ? { hostKeyFingerprint: plugin.target.hostKeyFingerprint } : {}),
      },
      auth: {
        type: plugin.auth.type,
        ...(plugin.auth.privateKeySource === 'vault' ? {privateKeySource:'vault'} : {}),
        ...(plugin.auth.privateKeyPath ? { privateKeyPath: plugin.auth.privateKeyPath } : {}),
        ...(plugin.auth.agentSocket ? { agentSocket: plugin.auth.agentSocket } : {}),
      },
      proxy: plugin.uplink?.type === 'socks5' || plugin.uplink?.type === 'http'
        ? { ...plugin.uplink }
        : { type: 'direct' },
      credentials: { remember: true },
      commandPolicy: { enabled: true, customDeny: [] },
      limits: {
        commandTimeoutSeconds: Math.max(1, Math.ceil((plugin.limits?.timeoutMs ?? 10_000) / 1000)),
        maxUploadMB: 500,
        maxDownloadMB: 100,
        maxDocumentKB: 200,
        maxLogScanMB: 16,
      },
    };
  }

  async update(key, patch) {
    const scope = parseScopeKey(key);
    const override = this.overrides.get(key);
    if (override) {
      this.overrides.set(key,{
        ...override,
        target:{...override.target,...(patch.ssh?.hostKeyFingerprint ? {hostKeyFingerprint:patch.ssh.hostKeyFingerprint} : {})},
      });
      return this.get(key);
    }
    const current = await this.workspaceStore.getPlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId);
    const updated = await this.workspaceStore.updatePlugin(scope.projectId, scope.environmentId, scope.pluginInstanceId, {
      target: {
        ...current.target,
        ...(patch.ssh?.hostKeyFingerprint ? { hostKeyFingerprint: patch.ssh.hostKeyFingerprint } : {}),
      },
    }, current.revision);
    return this.get(scopeKey(updated.projectId, updated.environmentId, updated.pluginInstanceId));
  }

  async appendAudit(key, entry) {
    if (this.overrides.has(key)) return {diagnostic:true};
    const scope = parseScopeKey(key);
    return this.workspaceStore.appendAudit(scope.projectId, {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      pluginInstanceId: scope.pluginInstanceId,
      pluginType: 'server',
      ...entry,
    });
  }

  async readContext(key) {
    const scope = parseScopeKey(key);
    const config = await this.get(key);
    const runbook = await this.workspaceStore.readRunbook(scope.projectId, scope.environmentId);
    return { config, docsHash: runbook.hash, documents: [{ name: 'README.md', content: runbook.content }], truncated: false };
  }

  securityConfigHash(config) {
    return crypto.createHash('sha256').update(JSON.stringify({ ssh: config.ssh, auth: config.auth, proxy: config.proxy, commandPolicy: config.commandPolicy, limits: config.limits })).digest('hex');
  }

  downloadsDir(key) {
    const scope = parseScopeKey(key);
    return path.join(this.workspaceStore.projectDir(scope.projectId), 'downloads', scope.environmentId, scope.pluginInstanceId);
  }
}

export class ServerPluginRuntime extends EventEmitter {
  constructor(workspaceStore, credentialVault, { resolver, vpnGuard } = {}) {
    super();
    this.workspaceStore = workspaceStore;
    this.credentialVault = credentialVault;
    this.resolver = resolver;
    this.vpnGuard = vpnGuard;
    this.adapter = new ScopedServerStoreAdapter(workspaceStore);
    this.broker = new SshBroker(this.adapter);
    this.connectAttempts = new Map();
    this.connectionControllers = new Map();
    this.readScheduler = new BoundedReadScheduler({ maxConcurrent:4, maxPerKey:2 });
    this.downloadScheduler = new BoundedReadScheduler({ maxConcurrent:2 });
    this.broker.setLifecycleHandler((event) => this.emit('lifecycle', { ...event, ...parseScopeKey(event.projectId), resourceKey: event.projectId }));
  }

  key(plugin) {
    return scopeKey(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId);
  }

  status(plugin) {
    return this.broker.status(this.key(plugin));
  }

  async createUplinkSocket(plugin, secrets, { signal = null } = {}) {
    const assertActive = () => {
      if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    };
    if (plugin.uplink?.type === 'socks5' || plugin.uplink?.type === 'http') {
      const candidates = await waitForConnection(() => this.resolver.resolve(plugin.target.host, plugin.target.addressFamily), signal);
      let lastError;
      for (const candidate of candidates) {
        assertActive();
        try {
          return await createProxySocket(
            { ...plugin.uplink, remoteDns: false },
            { host: candidate.address, port: plugin.target.port },
            secrets,
            Math.min(plugin.limits?.timeoutMs ?? 10_000, 15_000),
            { signal, pauseOnConnect: true },
          );
        } catch (error) {
          assertActive();
          lastError = error;
        }
      }
      throw lastError ?? new AppError('ROUTE_UNAVAILABLE', '代理无法连接 Server。');
    }
    const candidates = await waitForConnection(() => this.resolver.resolve(plugin.target.host, plugin.target.addressFamily), signal);
    let lastError;
    for (const candidate of candidates) {
      assertActive();
      try {
        let localAddress;
        if (plugin.uplink?.type === 'windowsVpn') {
          const route = await waitForConnection(() => this.vpnGuard.assertRoute(candidate.address, candidate.family, plugin.uplink.interfaceAlias), signal);
          if (route?.verified !== true || !route.localAddress) throw new AppError('VPN_REQUIRED', '系统 VPN 路由尚未验证。');
          ({ localAddress } = route);
        }
        return await createConnectionSocket(
          { host: candidate.address, port: plugin.target.port, family: candidate.family, ...(localAddress ? { localAddress } : {}) },
          Math.min(plugin.limits?.timeoutMs ?? 10_000, 10_000),
          { signal },
        );
      } catch (error) {
        assertActive();
        if (error instanceof AppError && ['VPN_REQUIRED', 'INVALID_ARGUMENT'].includes(error.code)) throw error;
        lastError = error;
      }
    }
    throw new AppError(lastError?.code === 'ETIMEDOUT' ? 'CONNECT_TIMEOUT' : 'ROUTE_UNAVAILABLE', 'Server 网络不可达。');
  }

  async connect(plugin, suppliedSecrets = {}, { signal = null, attemptToken = null } = {}) {
    if (plugin.pluginType !== 'server' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', 'Server 插件配置不完整。');
    const resource = this.key(plugin);
    const owner = attemptToken ?? Symbol('server-connect');
    this.connectionControllers.get(resource)?.abort();
    const controller = new AbortController();
    this.connectionControllers.set(resource, controller);
    const externalSignal = signal;
    const relayAbort = () => controller.abort();
    signal = controller.signal;
    externalSignal?.addEventListener('abort', relayAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    this.connectAttempts.set(resource, owner);
    let connected = false;
    const assertOwned = () => {
      if (signal?.aborted || this.connectAttempts.get(resource) !== owner) throw new AppError('CONNECT_CANCELLED', '连接已被更新的尝试取代。');
    };
    const transient = plugin.pluginInstanceId.startsWith('diagnostic-');
    const override = transient ? { ...plugin } : null;
    if (override) this.adapter.setOverride(resource, override, controller);
    let sock;
    const abort = () => {
      sock?.destroy();
      if (this.connectAttempts.get(resource) === owner) this.broker.cancelPendingConnection?.(resource);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      assertOwned();
      let saved = null;
      try {
        saved = await waitForConnection(() => this.credentialVault.load(plugin), signal);
      } catch (error) {
        assertOwned();
        if (!Object.keys(suppliedSecrets).length) throw error;
      }
      assertOwned();
      const secrets = { ...(saved ?? {}), ...suppliedSecrets };
      if (plugin.auth.type === 'password' && !secrets.password) {
        throw new AppError('CREDENTIAL_UNAVAILABLE', 'Server 密码尚未保存。');
      }
      sock = await this.createUplinkSocket(plugin, secrets, { signal });
      assertOwned();
      const result = await this.broker.connect(resource,secrets,{sock,signal});
      assertOwned();
      connected = true;
      return result;
    } catch (error) {
      sock?.destroy();
      if (override) this.adapter.clearOverride(resource, controller);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      externalSignal?.removeEventListener('abort', relayAbort);
      if (this.connectionControllers.get(resource) === controller) this.connectionControllers.delete(resource);
      if (!connected && this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
    }
  }

  async disconnect(plugin, reason = 'environment-disconnect') {
    const resource = this.key(plugin);
    const overrideOwner = this.adapter.overrideOwners.get(resource);
    this.connectionControllers.get(resource)?.abort();
    this.connectAttempts.delete(resource);
    try { return await this.broker.disconnect(resource,reason); }
    finally { this.adapter.clearOverride(resource, overrideOwner); }
  }

  forceDisconnect(plugin, reason = 'forced-disconnect', {attemptToken = null} = {}) {
    const resource = this.key(plugin);
    if (attemptToken !== null && this.connectAttempts.get(resource) !== attemptToken) {
      return Promise.resolve({connected:Boolean(this.status(plugin)?.connected),forced:false,stale:true});
    }
    this.connectAttempts.delete(resource);
    this.broker.cancelPendingConnection?.(resource);
    return this.disconnect(plugin, reason);
  }

  async openForward(projectId, environmentId, pluginInstanceId, targetHost, targetPort) {
    return this.broker.openForward(scopeKey(projectId, environmentId, pluginInstanceId), targetHost, targetPort);
  }

  async executeFixed(plugin, command) {
    const resource = this.key(plugin);
    const context = await this.adapter.readContext(resource);
    const authorization = await this.broker.openContext(resource, context.docsHash, 'server-action-runtime', this.adapter.securityConfigHash(context.config));
    return this.broker.execute(resource, authorization.contextToken, command);
  }

  readDocker(plugin, request, options = {}) {
    return this.boundedRead(plugin, () => this.broker.readDocker(this.key(plugin), plugin.target.dockerSocket, request, { ...options, timeoutMs:Math.min(10000, plugin.limits?.timeoutMs ?? 10000) }), { signal:options.signal, cancelCode:'DOCKER_CANCELLED' });
  }

  readWorkspaceMetrics(plugin, kind, options = {}) {
    return this.broker.readWorkspaceMetrics(this.key(plugin), kind, { ...options, timeoutMs:Math.min(3000, plugin.limits?.timeoutMs ?? 3000) });
  }

  openTerminal(plugin, options = {}) {
    return this.broker.openTerminal(this.key(plugin), options);
  }

  listRemoteDirectory(plugin, remotePath, options = {}) {
    return this.boundedRead(plugin, () => this.broker.listRemoteDirectory(this.key(plugin), remotePath, options));
  }

  withWorkspaceReadSession(plugin, operation, options = {}) {
    return this.broker.withWorkspaceReadSession(this.key(plugin), operation, options);
  }

  withRemoteReadSession(plugin, operation, options = {}) {
    return this.boundedRead(plugin, () => this.broker.withRemoteReadSession(this.key(plugin), operation, options));
  }

  statRemotePath(plugin, remotePath) {
    return this.boundedRead(plugin, () => this.broker.statRemotePath(this.key(plugin), remotePath));
  }

  readRemoteRange(plugin, remotePath, start, maxBytes, options = {}) {
    return this.boundedRead(plugin, () => this.broker.readRemoteRange(this.key(plugin), remotePath, start, maxBytes, options));
  }

  readRemoteBuffer(plugin, remotePath, start, maxBytes, options = {}) {
    return this.boundedRead(plugin, () => this.broker.readRemoteBuffer(this.key(plugin), remotePath, start, maxBytes, options));
  }

  downloadWorkspaceFile(plugin, remotePath, destination, expected, options) {
    const resource = this.key(plugin);
    const session = this.broker.requireSession(resource);
    return this.downloadScheduler.run(resource, 1, () => {
      options.signal?.throwIfAborted();
      if (this.broker.requireSession(resource) !== session) throw new AppError('PLUGIN_RECONNECTING', '等待下载期间连接已更新，请重新下载。');
      return downloadWorkspaceFile(this.broker, resource, remotePath, destination, expected, options);
    });
  }

  downloadRemoteFile(plugin, remotePath, localPath, maxBytes) {
    const resource = this.key(plugin);
    const session = this.broker.requireSession(resource);
    return this.downloadScheduler.run(resource,1,() => this.boundedRead(plugin, () => {
      if (this.broker.requireSession(resource) !== session) throw new AppError('PLUGIN_RECONNECTING', '等待下载期间连接已更新，请重新查询。');
      return this.broker.downloadRemoteFile(resource, remotePath, localPath, maxBytes);
    }));
  }

  boundedRead(plugin, operation, options = {}) {
    const resource = this.key(plugin);
    const session = this.broker.requireSession(resource);
    return this.readScheduler.run(resource,1,() => {
      if (this.broker.requireSession(resource) !== session) throw new AppError('PLUGIN_RECONNECTING', '等待读取期间连接已更新，请重新查询。');
      return operation();
    }, options);
  }

  uploadRemoteFile(plugin, localPath, remotePath, precondition, options = {}) {
    return this.broker.uploadRemoteFileApproved(this.key(plugin), localPath, remotePath, precondition, options);
  }

  writeRemoteFile(plugin, remotePath, content, precondition) {
    return this.broker.writeRemoteFileApproved(this.key(plugin), remotePath, content, precondition);
  }

  mutateWorkspacePath(plugin, args, options) {
    return this.broker.mutateWorkspacePathApproved(this.key(plugin), args, options);
  }

  moveRemotePath(plugin, sourcePath, destinationPath, precondition) {
    return this.broker.moveRemotePathApproved(this.key(plugin), sourcePath, destinationPath, precondition);
  }

  deleteRemotePath(plugin, remotePath, precondition) {
    return this.broker.deleteRemotePathApproved(this.key(plugin), remotePath, precondition);
  }

  executeApproved(plugin, command, workingDirectory) {
    return this.broker.executeApproved(this.key(plugin), command, workingDirectory);
  }

  async closeAll() {
    const controllers = [...this.connectionControllers];
    const attempts = [...this.connectAttempts];
    const overrides = [...this.adapter.overrideOwners];
    for (const [, controller] of controllers) controller.abort();
    try { return await this.broker.closeAll(); }
    finally {
      for (const [resource, controller] of controllers) {
        if (this.connectionControllers.get(resource) === controller) this.connectionControllers.delete(resource);
      }
      for (const [resource, owner] of attempts) {
        if (this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
      }
      for (const [resource, owner] of overrides) this.adapter.clearOverride(resource, owner);
    }
  }
}
