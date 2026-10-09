import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/errors.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { PluginEditSessionManager } from '../src/plugin-edit-session-manager.mjs';
import { createPluginConfigurationService } from '../src/plugin-configuration-service.mjs';

async function fixture(t, fingerprint = 'SHA256:new-fixture') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'plugin-host-key-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'指纹回归',environmentName:'测试'});
  const [environment] = await store.listEnvironments(project.projectId);
  const scope = {projectId:project.projectId,environmentId:environment.environmentId,pluginInstanceId:'server'};
  const before = await store.createPlugin(scope.projectId,scope.environmentId,{
    pluginInstanceId:'server',pluginType:'server',displayName:'合成服务器',
    target:{host:'old.example.invalid',port:22,hostKeyFingerprint:'SHA256:old-fixture'},
    auth:{type:'agent',username:'fixture'},uplink:{type:'direct'},
  });
  const coordinator = new WorkspaceMutationCoordinator();
  const attempts = [];
  const reconnects = [];
  const connectionManager = {
    snapshot:() => ({plugins:{server:{phase:'disconnected'}}}),
    disconnectForConfigurationEdit:async () => ({connectedBefore:[]}),
    configurationChanged:async () => ({}),
    requestConnectionIntent:async payload => {
      reconnects.push(await store.getPlugin(scope.projectId,scope.environmentId,'server'));
      payload.onPlanStarted?.();
      return {outcome:'started'};
    },
  };
  const manager = new PluginEditSessionManager({
    workspaceStore:store,connectionManager,mutationCoordinator:coordinator,
    credentialUseResolver:{resolve:async () => ({secrets:{}})},
    validationRuntime:{
      validate:async ({draft}) => {
        attempts.push(draft);
        if (!draft.target.hostKeyFingerprint) {
          throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','确认合成指纹',{fingerprint});
        }
        assert.equal(draft.target.hostKeyFingerprint,fingerprint);
        return {connected:true};
      },
      cleanup:async () => {},
    },
  });
  t.after(() => manager.invalidateAll({allowSaving:true}));
  const preparation = await manager.preparePluginConnectionEdit({...scope,expectedRevision:before.revision,ownerId:'renderer:fixture'});
  const session = await manager.beginPluginConnectionEdit({prepareToken:preparation.prepareToken,ownerId:'renderer:fixture'});
  const service = createPluginConfigurationService({
    workspaceStore:store,connectionManager,mutationCoordinator:coordinator,pluginEditSessionManager:manager,
    credentialVault:{saveMerged:async () => {}},contextManager:{},confirmationManager:{},
  });
  const validate = (draft,draftGeneration) => manager.validatePluginDraft({
    editSessionId:session.editSessionId,ownerId:'renderer:fixture',purpose:'server-auth',
    requestId:`request-${draftGeneration}`,draft,draftGeneration,discardTemporarySecrets:true,
  });
  const save = (draft,extra = {}) => service.savePluginConnectionEdit({
    editSessionId:session.editSessionId,expectedRevision:before.revision,
    patch:{target:draft.target,auth:draft.auth,uplink:draft.uplink},
    discardTemporarySecrets:true,afterCommit:'connect-current',...extra,
  },{ownerId:'renderer:fixture'});
  return {before,scope,session,store,manager,attempts,reconnects,validate,save,fingerprint};
}

for (const change of ['host','port']) {
  for (const fingerprint of ['SHA256:new-fixture','SHA256:old-fixture']) {
    test(`更换 ${change} 后确认一次即可保存并按新配置重连：${fingerprint}`,async t => {
      const h = await fixture(t,fingerprint);
      const target = {...h.before.target,[change]:change === 'host' ? 'new.example.invalid' : 2222};
      const draft = {...h.before,target};
      await assert.rejects(h.validate(draft,1),{code:'SSH_HOST_KEY_CONFIRM_REQUIRED'});
      const accepted = {...draft,target:{...target,hostKeyFingerprint:fingerprint}};
      await h.validate(accepted,2);
      assert.equal(h.attempts.length,2);
      assert.equal(h.attempts[0].target.hostKeyFingerprint,undefined);
      assert.equal(h.attempts[1].target.hostKeyFingerprint,fingerprint);
      assert.deepEqual((await h.store.getPlugin(h.scope.projectId,h.scope.environmentId,'server')).target,h.before.target);
      const result = await h.save(accepted);
      assert.equal(result.committed,true);
      const saved = await h.store.getPlugin(h.scope.projectId,h.scope.environmentId,'server');
      assert.equal(saved.target[change],target[change]);
      assert.equal(saved.target.hostKeyFingerprint,fingerprint);
      assert.equal(h.reconnects.length,1);
      assert.deepEqual(h.reconnects[0].target,saved.target);
      assert.equal(h.manager.sessionSummary(h.session.editSessionId),null);
    });
  }
}

test('指纹确认不能用于另一个地址或已经跳过的草稿代次',async t => {
  for (const stale of ['address','generation']) {
    const h = await fixture(t);
    const draft = {...h.before,target:{...h.before.target,host:'new.example.invalid'}};
    await assert.rejects(h.validate(draft,1),{code:'SSH_HOST_KEY_CONFIRM_REQUIRED'});
    const changed = {...draft,target:{...draft.target,hostKeyFingerprint:h.fingerprint,
      ...(stale === 'address' ? {host:'other.example.invalid'} : {})}};
    await assert.rejects(h.validate(changed,stale === 'generation' ? 3 : 2),{code:'SSH_HOST_KEY_CONFIRM_REQUIRED'});
    assert.equal(h.attempts.at(-1).target.hostKeyFingerprint,undefined);
  }
});

test('保存端不接受请求伪造的信任依据或与验证不同的目标',async t => {
  for (const confirmed of [false,true]) {
    const h = await fixture(t);
    const draft = {...h.before,target:{...h.before.target,host:'new.example.invalid',hostKeyFingerprint:h.fingerprint}};
    if (confirmed) {
      await assert.rejects(h.validate(draft,1),{code:'SSH_HOST_KEY_CONFIRM_REQUIRED'});
      await h.validate(draft,2);
    }
    const changed = {...draft,target:{...draft.target,host:'other.example.invalid'}};
    await h.save(changed,{hostKeyTrust:{fingerprint:h.fingerprint,binding:'forged'}});
    const saved = await h.store.getPlugin(h.scope.projectId,h.scope.environmentId,'server');
    assert.equal(saved.target.hostKeyFingerprint,undefined);
  }
});
