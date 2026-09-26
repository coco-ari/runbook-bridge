import { cloudError } from './cloud-config-crypto.mjs';
import { toPublicError } from './errors.mjs';

const ACTIONS = {
  status:[],bind:['url','password','remember','name'],create:['serviceUrl','adminToken','password','remember','name'],unbind:['repositoryId'],
  catalog:['snapshotId','repositoryId'],prepare:['direction','projectIds','snapshotId','repositoryId'],confirm:['planId','choices'],prepareRestore:['backupId'],
  check:['repositoryId'],visibility:['repositoryId','projectIds','visible'],preferences:['checkIntervalMinutes'],sync:['repositoryId','direction','projectId'],
  renameRepository:['repositoryId','name'],projectHistory:['repositoryId','projectId'],
  prepareProjectOperation:['repositoryId','projectId','operation','snapshotId','versionId'],confirmProjectOperation:['planId'],
};
export function registerCloudConfigIpc(ipcMain,services) {
  const installed = new WeakSet();
  ipcMain.handle('v2:cloud-config',async (event,payload) => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) throw cloudError('ACCESS_DENIED','云配置只能由当前桌面主窗口操作。');
      const service = services.cloudConfigService;
      if (!service) throw cloudError('UNAVAILABLE','云配置服务尚未就绪。');
      const owner = `renderer:${sender.id}`;
      if (!installed.has(sender)) {
        installed.add(sender);
        sender.once('destroyed',() => service.closeOwner(owner));
        sender.on('render-process-gone',() => service.closeOwner(owner));
        sender.on('did-start-navigation',(_event,_url,inPlace,mainFrame) => { if (mainFrame && !inPlace) service.closeOwner(owner); });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(ACTIONS,payload.action) || Object.keys(payload).some(key => key !== 'action' && !ACTIONS[payload.action].includes(key))) throw cloudError('INVALID_ARGUMENT','云配置请求参数无效。');
      const {action,...input} = payload;
      return {ok:true,data:await service.invoke(owner,action,input)};
    } catch (error) {
      // 外部配置验证器的错误详情可能含输入值，因此仅公开固定的云配置错误。
      if (!error?.code?.startsWith('CLOUD_')) return {ok:false,error:{code:'CLOUD_OPERATION_FAILED',message:'云配置操作失败，请检查项目配置、网络和本机安全存储。'}};
      return {ok:false,error:toPublicError(error)};
    }
  });
}
