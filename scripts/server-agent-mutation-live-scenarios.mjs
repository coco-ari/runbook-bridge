import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { V2Service } from '../src/v2-service.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';

// 仅使用调用方已创建的随机目录；审批是隔离测试驱动，不改变生产审批规则。
export async function runAgentMutationScenarios({runtime,plugin,operations,store,scope,root,owned,localRoot,localNames,action,measure}) {
  assert.match(root,/^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
  assert.ok(owned.has(root));
  const environment={projectId:scope.projectId,environmentId:scope.environmentId,name:'隔离测试环境'};
  const scopedStore={...store,
    getEnvironment:async(projectId,environmentId)=>{assert.equal(projectId,scope.projectId);assert.equal(environmentId,scope.environmentId);return environment},
    getProject:async projectId=>{assert.equal(projectId,scope.projectId);return {projectId,name:'隔离测试项目'}},
    listPlugins:async(projectId,environmentId)=>{assert.equal(projectId,scope.projectId);assert.equal(environmentId,scope.environmentId);return [plugin]},
    publicPlugin:value=>({pluginInstanceId:value.pluginInstanceId,pluginType:value.pluginType,displayName:value.displayName}),
  };
  const contexts=new EnvironmentContextManager(scopedStore);
  const confirmations=new ConfirmationManager();
  const connections={snapshot:()=>({projectId:scope.projectId,environmentId:scope.environmentId,phase:'connected',sequence:1,
    plugins:{[scope.pluginInstanceId]:{phase:runtime.status(plugin).connected?'connected':'disconnected'}}})};
  const service=new V2Service({workspaceStore:scopedStore,connectionManager:connections,contextManager:contexts,confirmationManager:confirmations,serverOperations:operations});
  const clientInstanceId='owned-agent-probe';
  let params;
  const remote=name=>{
    assert.ok(!name.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\\\0\r\n]/u.test(name));
    return root+'/'+name;
  };
  function guarded(capability,args) {
    const selected=capability==='fs.move'?[args.sourcePath,args.destinationPath]:[args.path??args.remotePath];
    if(capability==='shell.execute') {
      assert.equal(args.command,"printf '%s' 'probe-shell-confirmed'");
      assert.equal(args.workingDirectory,root);
      return;
    }
    assert.ok(['fs.write','fs.upload','fs.move','fs.delete'].includes(capability));
    for(const target of selected) assert.ok(typeof target==='string'&&target.startsWith(root+'/')&&path.posix.normalize(target)===target);
    if(capability==='fs.delete'||capability==='fs.move') assert.ok(owned.has(selected[0]));
    const destination=selected.at(-1);
    if(capability!=='fs.delete') assert.ok(owned.has(path.posix.dirname(destination)));
    if(args.overwrite) assert.ok(owned.has(destination));
    if(capability==='fs.upload') {
      assert.equal(path.dirname(args.localPath),localRoot);
      assert.ok(localNames.has(path.basename(args.localPath)));
    }
  }
  async function pending(capability,args) {
    guarded(capability,args);
    let requestId;
    await assert.rejects(service.invoke(params,capability,args),error=>{
      if(error.code!=='CONFIRMATION_REQUIRED'||!error.details?.requestId)return false;
      requestId=error.details.requestId;return true;
    });
    assert.equal((await service.confirmationStatus({...params,confirmationId:requestId})).status,'awaiting_user');
    return requestId;
  }
  async function approved(capability,args,requestId=undefined) {
    guarded(capability,args);
    requestId??=await pending(capability,args);
    if(capability==='shell.execute') assert.equal(confirmations.pending.get(requestId).approvalLevel,'strong');
    const {approvalToken}=confirmations.approve(requestId);
    const result=await service.invoke({...params,approvalToken},capability,args);
    if(capability==='fs.write'||capability==='fs.upload') owned.add(args.path??args.remotePath);
    if(capability==='fs.delete') owned.delete(args.path);
    if(capability==='fs.move') {
      for(const old of [...owned].filter(value=>value===args.sourcePath||value.startsWith(args.sourcePath+'/'))) {
        owned.delete(old);owned.add(args.destinationPath+old.slice(args.sourcePath.length));
      }
    }
    assert.equal((await service.confirmationStatus({...params,confirmationId:requestId})).status,'succeeded');
    return {result,requestId,approvalToken};
  }
  const read=target=>service.invoke(params,'fs.read',{path:target,maxBytes:65536});
  try {
    const opened=await measure('agent.open-environment-context',()=>service.openEnvironment({...scope,clientInstanceId}));
    params={...scope,clientInstanceId,contextToken:opened.contextToken};
    await measure('agent.context-boundaries',async()=>{
      await assert.rejects(service.invoke({...params,contextToken:'missing'},'fs.read',{path:remote('settings.conf')}),{code:'CONTEXT_REQUIRED'});
      await assert.rejects(service.invoke({...params,clientInstanceId:'other-client'},'fs.read',{path:remote('settings.conf')}),{code:'CLIENT_CONTEXT_MISMATCH'});
      assert.equal((await read(remote('settings.conf'))).content,'probe_enabled=true\nprobe_mode=synthetic\n');
    });
    const target=remote('agent-write.txt'),initial={path:target,content:'first probe 中文\n'};
    await measure('agent.confirmation-deduplicated-and-rejected',async()=>{
      const first=await pending('fs.write',initial);
      assert.equal(await pending('fs.write',initial),first);
      confirmations.reject(first);
      assert.equal((await service.confirmationStatus({...params,confirmationId:first})).status,'rejected');
      await assert.rejects(runtime.statRemotePath(plugin,target),{code:'SOURCE_NOT_FOUND'});
    });
    await measure('agent.write-new-and-confirmed-status',async()=>{
      const {result}=await approved('fs.write',initial);
      assert.equal(result.bytes,Buffer.byteLength(initial.content));
      assert.equal((await read(target)).content,initial.content);
    });
    await measure('agent.reject-unconfirmed-overwrite',()=>assert.rejects(service.invoke(params,'fs.write',{path:target,content:'replacement'}),{code:'TARGET_EXISTS'}));
    const replacement={path:target,content:'second probe content\n',overwrite:true};
    await measure('agent.overwrite-owned-file',async()=>{
      const before=await runtime.statRemotePath(plugin,target);
      await approved('fs.write',replacement);
      const after=await runtime.statRemotePath(plugin,target);
      assert.equal(after.mode,before.mode);
      assert.equal((await read(target)).content,replacement.content);
    });
    await measure('agent.confirmation-parameter-change',async()=>{
      const args={path:remote('agent-parameter.txt'),content:'approved probe text'};
      const requestId=await pending('fs.write',args);
      const {approvalToken}=confirmations.approve(requestId);
      await assert.rejects(service.invoke({...params,approvalToken},'fs.write',{...args,content:'changed probe text'}),{code:'CONFIRMATION_SCOPE_MISMATCH'});
      await assert.rejects(runtime.statRemotePath(plugin,args.path),{code:'SOURCE_NOT_FOUND'});
      assert.equal((await service.confirmationStatus({...params,confirmationId:requestId})).status,'invalidated');
    });
    await measure('agent.confirmation-remote-state-change',async()=>{
      const args={path:target,content:'must not replace newer content',overwrite:true};
      const requestId=await pending('fs.write',args);
      const {approvalToken}=confirmations.approve(requestId);
      await approved('fs.write',{path:target,content:'independently changed probe state with different size\n',overwrite:true});
      await assert.rejects(service.invoke({...params,approvalToken},'fs.write',args),{code:'CONFIRMATION_SCOPE_MISMATCH'});
      assert.equal((await read(target)).content,'independently changed probe state with different size\n');
    });
    await measure('agent.confirmation-single-use',async()=>{
      const args={path:target,content:'once only probe state\n',overwrite:true};
      const {approvalToken}=await approved('fs.write',args);
      await assert.rejects(service.invoke({...params,approvalToken},'fs.write',args),{code:'CONFIRMATION_REQUIRED'});
    });
    await measure('agent.upload-through-gate',async()=>{
      const name='agent-upload.txt';localNames.add(name);
      const localPath=path.join(localRoot,name);
      await fs.writeFile(localPath,'agent upload probe\n',{flag:'wx',mode:0o600});
      await approved('fs.upload',{localPath,remotePath:remote(name)});
      assert.equal((await read(remote(name))).content,'agent upload probe\n');
    });
    await measure('agent.move-owned-file',async()=>{
      await approved('fs.move',{sourcePath:target,destinationPath:remote('agent-moved.txt')});
      assert.equal((await read(remote('agent-moved.txt'))).content,'once only probe state\n');
      await assert.rejects(runtime.statRemotePath(plugin,target),{code:'SOURCE_NOT_FOUND'});
    });
    await measure('agent.move-conflict-rejected',async()=>{
      await assert.rejects(service.invoke(params,'fs.move',{sourcePath:remote('agent-moved.txt'),destinationPath:remote('agent-upload.txt')}),{code:'TARGET_EXISTS'});
      assert.equal((await read(remote('agent-upload.txt'))).content,'agent upload probe\n');
    });
    await measure('agent.move-overwrite-owned-file',async()=>{
      await approved('fs.move',{sourcePath:remote('agent-moved.txt'),destinationPath:remote('agent-upload.txt'),overwrite:true});
      assert.equal((await read(remote('agent-upload.txt'))).content,'once only probe state\n');
    });
    await action('mkdir',root,'agent-directory');
    await approved('fs.write',{path:remote('agent-directory/child.txt'),content:'nested probe\n'});
    await measure('agent.move-nonempty-owned-directory',async()=>{
      await approved('fs.move',{sourcePath:remote('agent-directory'),destinationPath:remote('agent-directory-moved')});
      assert.equal((await read(remote('agent-directory-moved/child.txt'))).content,'nested probe\n');
    });
    await measure('agent.delete-nonempty-rejected',async()=>{
      const args={path:remote('agent-directory-moved')};
      const requestId=await pending('fs.delete',args);
      const {approvalToken}=confirmations.approve(requestId);
      await assert.rejects(service.invoke({...params,approvalToken},'fs.delete',args));
      assert.equal((await service.confirmationStatus({...params,confirmationId:requestId})).status,'failed');
      assert.equal((await read(remote('agent-directory-moved/child.txt'))).content,'nested probe\n');
    });
    await measure('agent.delete-owned-file-and-directory',async()=>{
      await approved('fs.delete',{path:remote('agent-directory-moved/child.txt')});
      await approved('fs.delete',{path:remote('agent-directory-moved')});
      await assert.rejects(runtime.statRemotePath(plugin,remote('agent-directory-moved')),{code:'SOURCE_NOT_FOUND'});
    });
    await measure('agent.shell-strong-confirmation',async()=>{
      const {result}=await approved('shell.execute',{command:"printf '%s' 'probe-shell-confirmed'",workingDirectory:root});
      assert.equal(result.exitCode,0);assert.equal(result.stdout,'probe-shell-confirmed');
    });
    await measure('agent.unknown-capability-rejected',()=>assert.rejects(service.invoke(params,'unknown.probe',{}),{code:'POLICY_DENIED'}));
    await measure('agent.context-invalidated',async()=>{
      contexts.invalidateEnvironment(scope.projectId,scope.environmentId);
      await assert.rejects(read(remote('settings.conf')),{code:'CONTEXT_REQUIRED'});
    });
  } finally {
    contexts.clear();
    confirmations.invalidateEnvironment(scope.projectId,scope.environmentId);
  }
}
