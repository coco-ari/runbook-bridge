import { AppError, toPublicError } from './errors.mjs';
import { SOURCE_HASH, sourcePath } from './source-protocol.mjs';

export function registerSourceWorkspaceIpc(ipcMain,services) {
  const owners = new Map(), installed = new WeakSet();
  const runtime = () => services.sourceRuntime ?? services.pluginManager?.runtimes?.source;
  function invalidate(owner) {
    const state = owners.get(owner);
    if (!state) return;
    state.active = false; for (const release of state.leases.values()) release();
    owners.delete(owner); runtime()?.closeOwner(owner);
  }
  function ownerFor(event) {
    const sender = event?.sender;
    if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw new AppError('WORKSPACE_ACCESS_DENIED','仅桌面工作区可以操作源码。');
    const owner = `renderer:${sender.id}`;
    if (!installed.has(sender)) {
      installed.add(sender); sender.once('destroyed',() => invalidate(owner)); sender.on('render-process-gone',() => invalidate(owner));
      sender.on('did-start-navigation',(_event,_url,inPlace,mainFrame) => { if (mainFrame && !inPlace) invalidate(owner); });
    }
    if (!owners.has(owner)) owners.set(owner,{active:true,leases:new Map()});
    return owner;
  }
  ipcMain.handle('v2:source-workspace',async (event,payload) => {
    try {
      const owner = ownerFor(event), state = owners.get(owner);
      if (!payload || !['status','check','update','cancel','manifest','read','search','cleanup','open-directory','release'].includes(payload.operation)
        || ![payload.projectId,payload.environmentId,payload.pluginInstanceId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)) throw new AppError('INVALID_ARGUMENT','源码工作区请求无效。');
      if (!runtime()) throw new AppError('WORKSPACE_UNAVAILABLE','源码工作区暂不可用。');
      const scopeKey = JSON.stringify([payload.projectId,payload.environmentId,payload.pluginInstanceId]);
      if (payload.operation === 'release') {
        state.leases.get(scopeKey)?.(); state.leases.delete(scopeKey); runtime().cancel(payload,owner);
        return {ok:true,data:{released:true}};
      }
      services.mutationCoordinator?.assertEnvironmentAvailable(payload.projectId,payload.environmentId);
      const plugin = await services.workspaceStore.getPlugin(payload.projectId,payload.environmentId,payload.pluginInstanceId);
      if (plugin.pluginType !== 'source') throw new AppError('PLUGIN_TYPE_MISMATCH','目标不是源码插件。');
      if (payload.expectedRevision !== plugin.revision) throw new AppError('SOURCE_WORKSPACE_STALE','源码配置已变化，请重新打开工作区。');
      const assertOwner = () => { if (!state.active || event.sender.isDestroyed?.()) throw new AppError('SOURCE_WORKSPACE_STALE','源码工作区已关闭。'); };
      assertOwner();
      const op = payload.operation, r = runtime(); let data;
      if (op === 'status') data = await r.workspaceStatus(plugin);
      else if (op === 'check') data = await r.check(plugin);
      else if (op === 'cancel') data = r.cancel(plugin,owner);
      else if (op === 'update') {
        if (!SOURCE_HASH.test(payload.snapshotId ?? '')) throw new AppError('INVALID_ARGUMENT','请选择已发布的源码版本。');
        data = await r.update(plugin,payload.snapshotId,{owner,assertCurrent:assertOwner});
        services.contextManager?.invalidateEnvironment(plugin.projectId,plugin.environmentId);
        await services.workspaceStore.appendAudit(plugin.projectId,{type:'source-updated',environmentId:plugin.environmentId,pluginInstanceId:plugin.pluginInstanceId,actor:'user',result:'success',snapshotId:data.snapshotId}).catch(() => {});
      } else if (op === 'cleanup') data = await r.store.cleanup(plugin);
      else {
        if (!SOURCE_HASH.test(payload.snapshotId ?? '')) throw new AppError('INVALID_ARGUMENT','请先下载源码版本。');
        const manifest = await r.store.manifest(plugin,payload.snapshotId); assertOwner();
        if (state.leases.size >= 64 && !state.leases.has(scopeKey)) throw new AppError('SOURCE_BUSY','源码工作区数量过多。');
        state.leases.get(scopeKey)?.(); state.leases.set(scopeKey,r.store.acquire(plugin,payload.snapshotId));
        if (op === 'manifest') data = manifest;
        else if (op === 'read') {
          sourcePath(payload.path);
          const bytes = await r.store.read(plugin,payload.snapshotId,payload.path);
          const text = bytes.toString('utf8'), binary = bytes.includes(0) || !Buffer.from(text).equals(bytes);
          data = {path:payload.path,size:bytes.length,binary,text:binary ? null : text};
        } else if (op === 'search') data = await r.store.search(plugin,payload.snapshotId,payload.query,{content:payload.content === true});
        else if (op === 'open-directory') {
          const directory = r.store.summary(plugin,manifest).directory;
          if (!services.openSourceDirectory) throw new AppError('WORKSPACE_UNAVAILABLE','打开目录功能暂不可用。');
          await services.openSourceDirectory(directory); data = {opened:true};
        }
      }
      assertOwner(); return {ok:true,data};
    } catch (error) { return {ok:false,error:toPublicError(error)}; }
  });
}
