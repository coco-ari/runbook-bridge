import { saveMysqlSqlFile } from './mysql-sql-file.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { prepareMysqlEditRequest } from './desktop-mysql-editor.mjs';

export function registerMysqlEditIpc(ipcMain, services) {
  const installed=new WeakSet(),owners=new Map();
  const invalidate=owner=>{
    const state=owners.get(owner);
    if(state)state.active=false;
    owners.delete(owner);
    services.v2Service?.mysqlEditor?.closeOwner(owner);
  };
  const ownerFor=event=>{
    const sender=event?.sender;
    if(!sender||!Number.isInteger(sender.id)||sender.isDestroyed?.()||!sender.mainFrame
      ||event.senderFrame!==sender.mainFrame||services.isWorkspaceRenderer?.(sender)!==true) {
      throw new AppError('WORKSPACE_ACCESS_DENIED','只有当前桌面工作区可以编辑数据库。');
    }
    const owner='renderer:'+sender.id;
    if(!installed.has(sender)){
      installed.add(sender);
      sender.once('destroyed',()=>invalidate(owner));
      sender.on('render-process-gone',()=>invalidate(owner));
      sender.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)invalidate(owner);});
    }
    if(!owners.has(owner))owners.set(owner,{active:true});
    return owner;
  };
  ipcMain.handle('v2:mysql-export-save',async(event,payload)=>{
    try {
      const owner=ownerFor(event),state=owners.get(owner);
      const assertOwner=()=>{if(!state.active||owners.get(owner)!==state||event.sender.isDestroyed?.())throw new AppError('WORKSPACE_ACCESS_DENIED','导出窗口已关闭或重新加载。');};
      return {ok:true,data:await saveMysqlSqlFile(payload,typeof services.pickMysqlExportPath==='function'?name=>services.pickMysqlExportPath(event.sender,name):undefined,assertOwner)};
    } catch(error) { return {ok:false,error:toPublicError(error)}; }
  });
  for(const operation of ['open','row','prepare','commit','status','release']){
    ipcMain.handle('v2:mysql-edit-'+operation,async(event,payload)=>{
      try{
        const owner=ownerFor(event),state=owners.get(owner);
        prepareMysqlEditRequest(payload,operation);
        const assertOwner=()=>{
          if(!state.active||owners.get(owner)!==state||event.sender.isDestroyed?.())throw new AppError('MYSQL_EDIT_STALE','编辑窗口已关闭或重新加载。');
        };
        return {ok:true,data:await services.v2Service.invokeDesktopMysqlEdit(owner,payload,operation,assertOwner)};
      }catch(error){return {ok:false,error:toPublicError(error)};}
    });
  }
}
