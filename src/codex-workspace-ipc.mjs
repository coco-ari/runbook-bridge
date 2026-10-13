import { AppError,toPublicError } from './errors.mjs';

export function registerCodexWorkspaceIpc(ipcMain,services) {
  const owners = new WeakSet(), runs = new Map();
  const runtime = () => services.codexRuntime ?? services.pluginManager?.runtimes?.codex;
  const runKey = p => JSON.stringify([p.projectId,p.environmentId,p.pluginInstanceId,p.sessionId]);
  ipcMain.handle('v2:codex-workspace',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw new AppError('WORKSPACE_ACCESS_DENIED','仅桌面工作区可以操作 Codex Agent。');
      if (!owners.has(sender)) {
        owners.add(sender);
        const close = () => { for (const [key,run] of runs) if (run.owner === sender) { void runtime()?.stop(run.plugin,run.id).catch(() => runtime()?.disconnect(run.plugin)); runs.delete(key); } };
        sender.once('destroyed',close); sender.on('render-process-gone',close); sender.on('did-start-navigation',(_event,_url,inPlace,mainFrame) => { if (mainFrame && !inPlace) close(); });
      }
      if (!payload || !['status','models','login','cancel-login','logout','new','read','send','stop','answer','delete'].includes(payload.operation)
        || ![payload.projectId,payload.environmentId,payload.pluginInstanceId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)) throw new AppError('INVALID_ARGUMENT','Agent 工作区请求无效。');
      const r = runtime(); if (!r) throw new AppError('WORKSPACE_UNAVAILABLE','Codex Agent 暂不可用。');
      services.mutationCoordinator?.assertEnvironmentAvailable(payload.projectId,payload.environmentId);
      const plugin = await services.workspaceStore.getPlugin(payload.projectId,payload.environmentId,payload.pluginInstanceId);
      if (plugin.pluginType !== 'codex') throw new AppError('PLUGIN_TYPE_MISMATCH','目标不是 Codex Agent 插件。');
      if (plugin.revision !== payload.expectedRevision) throw new AppError('CODEX_WORKSPACE_STALE','Agent 配置已变化，请重新打开工作区。');
      const key = runKey(payload); let run = runs.get(key);
      if (run && (await r.readSession(plugin,payload.sessionId)).status !== 'running') { runs.delete(key); run = null; }
      if (['send','stop','answer','delete'].includes(payload.operation) && run && run.owner !== sender) throw new AppError('WORKSPACE_ACCESS_DENIED','该会话由另一个工作区操作。');
      let data;
      switch (payload.operation) {
        case 'status': data = await r.workspaceStatus(plugin); break;
        case 'models': data = await r.models(plugin); break;
        case 'login': case 'cancel-login': case 'logout': data = await r.login(plugin,payload.operation); break;
        case 'new': data = await r.newSession(plugin,{sourcePluginIds:payload.sourcePluginIds,model:payload.model}); break;
        case 'read': data = await r.readSession(plugin,payload.sessionId); break;
        case 'send':
          runs.set(key,{owner:sender,plugin,id:payload.sessionId});
          try { data = await r.send(plugin,payload.sessionId,payload.text); }
          catch (e) { runs.delete(key); throw e; }
          break;
        case 'stop': data = await r.stop(plugin,payload.sessionId); break;
        case 'answer': data = await r.answer(plugin,payload.sessionId,payload.approvalId,payload.answers); break;
        case 'delete': data = await r.removeSession(plugin,payload.sessionId); runs.delete(key); break;
      }
      if (sender.isDestroyed?.()) throw new AppError('CODEX_WORKSPACE_STALE','工作区已关闭。');
      return {ok:true,data};
    } catch (e) { return {ok:false,error:toPublicError(e instanceof AppError ? e : new AppError('CODEX_WORKSPACE_FAILED','Agent 工作区操作失败，请检查本地数据和连接状态。'))}; }
  });
}
