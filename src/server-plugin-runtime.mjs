import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SshBroker } from './ssh-broker.mjs';
import { createProxySocket } from './proxy.mjs';
import { AppError } from './errors.mjs';

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
  }

  setOverride(key, plugin) {
    this.overrides.set(key,plugin);
  }

  clearOverride(key) {
    this.overrides.delete(key);
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
    this.broker.setLifecycleHandler((event) => this.emit('lifecycle', { ...event, ...parseScopeKey(event.projectId), resourceKey: event.projectId }));
  }

  key(plugin) {
    return scopeKey(plugin.projectId, plugin.environmentId, plugin.pluginInstanceId);
  }

  status(plugin) {
    return this.broker.status(this.key(plugin));
  }

  async createUplinkSocket(plugin, secrets) {
    if (plugin.uplink?.type === 'socks5' || plugin.uplink?.type === 'http') {
      const candidates = await this.resolver.resolve(plugin.target.host, plugin.target.addressFamily);
      let lastError;
      for (const candidate of candidates) {
        try {
          return await createProxySocket(
            { ...plugin.uplink, remoteDns: false },
            { host: candidate.address, port: plugin.target.port },
            secrets,
            Math.min(plugin.limits?.timeoutMs ?? 10_000, 15_000),
          );
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new AppError('ROUTE_UNAVAILABLE', '代理无法连接 Server。');
    }
    const candidates = await this.resolver.resolve(plugin.target.host, plugin.target.addressFamily);
    let lastError;
    for (const candidate of candidates) {
      try {
        let localAddress;
        if (plugin.uplink?.type === 'windowsVpn') {
          ({ localAddress } = await this.vpnGuard.assertRoute(candidate.address, candidate.family, plugin.uplink.interfaceAlias));
        }
        const net = await import('node:net');
        const socket = await new Promise((resolve, reject) => {
          const value = net.default.connect({ host: candidate.address, port: plugin.target.port, family: candidate.family, ...(localAddress ? { localAddress } : {}) });
          const timer = setTimeout(() => {
            value.destroy();
            const error = new Error('timeout');
            error.code = 'ETIMEDOUT';
            reject(error);
          }, Math.min(plugin.limits?.timeoutMs ?? 10_000, 10_000));
          value.once('connect', () => { clearTimeout(timer); resolve(value); });
          value.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
        return socket;
      } catch (error) {
        lastError = error;
      }
    }
    throw new AppError(lastError?.code === 'ETIMEDOUT' ? 'CONNECT_TIMEOUT' : 'ROUTE_UNAVAILABLE', 'Server 网络不可达。');
  }

  async connect(plugin, suppliedSecrets = {}, { signal = null, attemptToken = null } = {}) {
    if (plugin.pluginType !== 'server' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', 'Server 插件配置不完整。');
    const resource = this.key(plugin);
    const owner = attemptToken ?? Symbol('server-connect');
    this.connectAttempts.set(resource, owner);
    let connected = false;
    const assertOwned = () => {
      if (signal?.aborted || this.connectAttempts.get(resource) !== owner) throw new AppError('CONNECT_CANCELLED', '连接已被更新的尝试取代。');
    };
    const transient = plugin.pluginInstanceId.startsWith('diagnostic-');
    if (transient) this.adapter.setOverride(resource,plugin);
    let saved = null;
    try {
      saved = await this.credentialVault.load(plugin);
    } catch (error) {
      if (!Object.keys(suppliedSecrets).length) {
        if (transient) this.adapter.clearOverride(resource);
        if (this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
        throw error;
      }
    }
    try { assertOwned(); }
    catch (error) {
      if (transient) this.adapter.clearOverride(resource);
      if (this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
      throw error;
    }
    const secrets = { ...(saved ?? {}), ...suppliedSecrets };
    if (plugin.auth.type === 'password' && !secrets.password) {
      if (transient) this.adapter.clearOverride(resource);
      if (this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
      throw new AppError('CREDENTIAL_UNAVAILABLE', 'Server 密码尚未保存。');
    }
    let sock;
    const abort = () => {
      sock?.destroy();
      this.broker.cancelPendingConnection?.(resource);
    };
    signal?.addEventListener('abort', abort, { once:true });
    try {
      if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
      sock = await this.createUplinkSocket(plugin,secrets);
      assertOwned();
      const result = await this.broker.connect(resource,secrets,{sock,signal});
      assertOwned();
      connected = true;
      return result;
    } catch (error) {
      sock?.destroy();
      if (transient) this.adapter.clearOverride(resource);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!connected && this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
    }
  }

  async disconnect(plugin, reason = 'environment-disconnect') {
    const resource = this.key(plugin);
    this.connectAttempts.delete(resource);
    try { return await this.broker.disconnect(resource,reason); }
    finally { if (plugin.pluginInstanceId.startsWith('diagnostic-')) this.adapter.clearOverride(resource); }
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

  listRemoteDirectory(plugin, remotePath, options = {}) {
    return this.broker.listRemoteDirectory(this.key(plugin), remotePath, options);
  }

  withRemoteReadSession(plugin, operation) {
    return this.broker.withRemoteReadSession(this.key(plugin), operation);
  }

  statRemotePath(plugin, remotePath) {
    return this.broker.statRemotePath(this.key(plugin), remotePath);
  }

  readRemoteRange(plugin, remotePath, start, maxBytes) {
    return this.broker.readRemoteRange(this.key(plugin), remotePath, start, maxBytes);
  }

  readRemoteBuffer(plugin, remotePath, start, maxBytes) {
    return this.broker.readRemoteBuffer(this.key(plugin), remotePath, start, maxBytes);
  }

  downloadRemoteFile(plugin, remotePath, localPath, maxBytes) {
    return this.broker.downloadRemoteFile(this.key(plugin), remotePath, localPath, maxBytes);
  }

  uploadRemoteFile(plugin, localPath, remotePath, precondition) {
    return this.broker.uploadRemoteFileApproved(this.key(plugin), localPath, remotePath, precondition);
  }

  writeRemoteFile(plugin, remotePath, content, precondition) {
    return this.broker.writeRemoteFileApproved(this.key(plugin), remotePath, content, precondition);
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
    return this.broker.closeAll();
  }
}
