import { AppError, toPublicError } from './errors.mjs';
import { prepareRedisWorkspaceRequest } from './redis-workspace-manager.mjs';

export function registerRedisWorkspaceIpc(ipcMain, services) {
  const installed = new WeakSet();
  const owners = new Map();
  const invalidateOwner = (owner) => {
    const state = owners.get(owner);
    if (state) state.active = false;
    owners.delete(owner);
    manager()?.closeOwner(owner);
  };
  const manager = () => services.v2Service?.redisWorkspaceManager;
  const ownerFor = (event) => {
    const sender = event?.sender;
    if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.() || !sender.mainFrame
      || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) {
      throw new AppError('WORKSPACE_ACCESS_DENIED', '仅当前桌面工作区可以读取 Redis。');
    }
    const owner = 'renderer:' + sender.id;
    if (!installed.has(sender)) {
      installed.add(sender);
      sender.once('destroyed', () => invalidateOwner(owner));
      sender.on('render-process-gone', () => invalidateOwner(owner));
      sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) invalidateOwner(owner);
      });
    }
    if (!owners.has(owner)) owners.set(owner, { active: true, scopes: new Map() });
    return owner;
  };
  for (const operation of ['scan', 'inspect', 'read', 'release']) {
    ipcMain.handle('v2:redis-workspace-' + operation, async (event, payload) => {
      try {
        const owner = ownerFor(event);
        prepareRedisWorkspaceRequest(payload, operation);
        if (!manager()) throw new AppError('WORKSPACE_UNAVAILABLE', 'Redis 工作区暂不可用。');
        const state = owners.get(owner);
        const scope = JSON.stringify([payload.projectId, payload.environmentId, payload.pluginInstanceId]);
        if (operation === 'release') {
          state.scopes.delete(scope);
          return { ok: true, data: manager().release(owner, payload) };
        }
        if (!state.scopes.has(scope)) {
          if (state.scopes.size >= 64) throw new AppError('READ_BUSY', '工作区数量已达上限，请关闭已有工作区。');
          state.scopes.set(scope, {});
        }
        const ticket = state.scopes.get(scope);
        const assertOwner = () => {
          if (!state.active || state.scopes.get(scope) !== ticket || event.sender.isDestroyed?.()) throw new AppError('REDIS_WORKSPACE_STALE', '工作区已关闭，请重新打开。');
        };
        const data = await services.v2Service.invokeDesktopRedis(owner, payload, operation, assertOwner);
        return { ok: true, data };
      } catch (error) { return { ok: false, error: toPublicError(error) }; }
    });
  }
}
