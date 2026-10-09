import { publicSoftwareUpdateError, softwareUpdateError, validateSoftwareUpdateRequest } from './software-update-service.mjs';

export function registerSoftwareUpdateIpc(ipcMain,services) {
  ipcMain.handle('v2:software-update',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw softwareUpdateError('UPDATE_ACCESS_DENIED');
      const service = services.softwareUpdateService;
      if (!service) throw softwareUpdateError('UPDATE_UNAVAILABLE');
      validateSoftwareUpdateRequest(payload);
      const {action,...input} = payload;
      return {ok:true,data:await service.invoke(action,input)};
    } catch (error) {
      // 更新器与网络异常可能包含请求地址或凭据，只返回固定错误文案。
      return {ok:false,error:publicSoftwareUpdateError(error)};
    }
  });
}
