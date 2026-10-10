export function registerUpdateNotificationsIpc(ipcMain,services) {
  ipcMain.handle('v2:update-center',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw new Error();
      const fields = {status:[],preferences:['notificationMode']};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(fields,payload.action)
        || Object.keys(payload).some(key => !['action',...fields[payload.action]].includes(key))
        || payload.action === 'preferences' && !['app','background','always'].includes(payload.notificationMode)) throw new Error();
      if (!services.updateNotifications) throw new Error();
      const service = services.updateNotifications;
      const data = payload.action === 'preferences' ? await service.preferences(payload.notificationMode) : service.snapshot();
      return {ok:true,data};
    } catch {
      return {ok:false,error:{code:'UPDATE_CENTER_UNAVAILABLE',message:'无法读取或保存更新提醒，请稍后重试。'}};
    }
  });
}
