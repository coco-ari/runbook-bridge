export function registerUpdateNotificationsIpc(ipcMain,services) {
  ipcMain.handle('v2:update-center',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw new Error();
      const fields = {status:[],read:['ids'],snooze:['ids','duration'],preferences:['notificationMode']};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(fields,payload.action)
        || Object.keys(payload).some(key => !['action',...fields[payload.action]].includes(key))
        || ['read','snooze'].includes(payload.action) && (!Array.isArray(payload.ids) || payload.ids.length > 4096 || payload.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))
        || payload.action === 'snooze' && !['hour','tomorrow','cancel'].includes(payload.duration)
        || payload.action === 'preferences' && !['app','background','always'].includes(payload.notificationMode)) throw new Error();
      if (!services.updateNotifications) throw new Error();
      const service = services.updateNotifications;
      const data = payload.action === 'read' ? await service.read(payload.ids)
        : payload.action === 'snooze' ? await service.snooze(payload.ids,payload.duration)
          : payload.action === 'preferences' ? await service.preferences(payload.notificationMode) : service.snapshot();
      return {ok:true,data};
    } catch {
      return {ok:false,error:{code:'UPDATE_CENTER_UNAVAILABLE',message:'无法读取或保存更新提醒，请稍后重试。'}};
    }
  });
}
