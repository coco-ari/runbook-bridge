export function registerUpdateNotificationsIpc(ipcMain,services) {
  ipcMain.handle('v2:update-center',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw new Error();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['status','read'].includes(payload.action)
        || Object.keys(payload).some(key => !['action',...(payload.action === 'read' ? ['ids'] : [])].includes(key))
        || payload.action === 'read' && (!Array.isArray(payload.ids) || payload.ids.length > 4096 || payload.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new Error();
      if (!services.updateNotifications) throw new Error();
      return {ok:true,data:payload.action === 'read' ? await services.updateNotifications.read(payload.ids) : services.updateNotifications.snapshot()};
    } catch {
      return {ok:false,error:{code:'UPDATE_CENTER_UNAVAILABLE',message:'无法读取或保存更新提醒，请稍后重试。'}};
    }
  });
}
