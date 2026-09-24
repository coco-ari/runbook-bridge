import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginConfigurationService } from '../src/plugin-configuration-service.mjs';
import { normalizePlugin } from '../src/plugin-config-model.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { AppError } from '../src/errors.mjs';

function fixture({credentialFailure = false, reconnectFailure = false, credentialIntent = 'replace'} = {}) {
  const scope = {projectId:'test-project', environmentId:'test-env', pluginInstanceId:'test-mysql'};
  const before = normalizePlugin({
    pluginType:'mysql', pluginInstanceId:scope.pluginInstanceId,
    target:{host:'before.invalid', database:'sample'}, auth:{username:'sample'},
  }, scope);
  const after = normalizePlugin({target:{host:'after.invalid'}}, scope, before);
  const events = [];
  let persisted = before;
  const service = createPluginConfigurationService({
    workspaceStore:{
      preparePluginConnectionUpdate: async () => ({before, after, change:{kind:'session-affecting'}}),
      commitPluginSnapshot: async (plugin, revision) => {
        assert.equal(revision, before.revision);
        events.push('commit'); persisted = plugin; return plugin;
      },
      restorePluginSnapshot: async (plugin, revision) => {
        assert.equal(revision, after.revision);
        events.push('rollback'); persisted = plugin;
      },
      appendAudit: async () => events.push('audit'),
      publicPlugin: plugin => ({pluginInstanceId:plugin.pluginInstanceId, revision:plugin.revision}),
    },
    mutationCoordinator:new WorkspaceMutationCoordinator(),
    connectionManager:{
      beginConfigurationMutation: () => { events.push('fence'); return 'mutation'; },
      endConfigurationMutation: (_p, _e, _token, options) => events.push(options?.restore ? 'restore-fence' : 'end-fence'),
      configurationChanged: async () => events.push('configuration-changed'),
    },
    configTransactionJournal:{
      prepare: async () => { events.push('journal'); return {}; },
      complete: async () => events.push('journal-complete'),
    },
    credentialVault:{saveMerged: async () => {
      events.push('credentials');
      if (credentialFailure) throw new AppError('TEST_VAULT_FAILURE', '测试凭据写入失败。');
    }},
    contextManager:{invalidateEnvironment: () => events.push('invalidate-context')},
    confirmationManager:{invalidatePlugin: () => events.push('invalidate-approvals')},
    pluginEditSessionManager:{
      beginSave: (_id, options) => assert.equal(options.ownerId, 'renderer:1'),
      commitMaterial: () => ({scope, baseRecordRevision:before.revision, credentialIntent,
        temporarySecrets:credentialIntent === 'replace' ? {password:'test-only-placeholder'} : {}}),
      completeSave: async () => {
        events.push('complete-save');
        if (reconnectFailure) throw new AppError('TEST_RECONNECT_FAILURE', '测试重连失败。');
        return {outcome:'started'};
      },
      saveFailed: () => events.push('save-failed'),
    },
  });
  const save = (extra = {}) => service.savePluginConnectionEdit({
    editSessionId:'edit-test', expectedRevision:before.revision, patch:{target:after.target}, ...extra,
  }, {ownerId:'renderer:1'});
  return {save, events, before, after, persisted:() => persisted};
}

test('保存服务直接拒绝版本冲突，不进入持久化或凭据事务', async () => {
  const state = fixture();
  await assert.rejects(state.save({expectedRevision:999}), {code:'CONFIG_REVISION_CONFLICT'});
  assert.deepEqual(state.events, ['save-failed']);
  assert.equal(state.persisted(), state.before);
});

test('保存服务拒绝没有明确凭据意图的认证目标变更', async () => {
  const state = fixture({credentialIntent:'unchanged'});
  await assert.rejects(state.save(), {code:'PLUGIN_CREDENTIAL_REBIND_REQUIRED'});
  assert.deepEqual(state.events, ['save-failed']);
});

test('凭据事务失败时回滚配置并恢复连接变更围栏', async () => {
  const state = fixture({credentialFailure:true});
  await assert.rejects(state.save(), {code:'TEST_VAULT_FAILURE'});
  assert.equal(state.persisted(), state.before);
  assert.deepEqual(state.events, [
    'fence', 'journal', 'commit', 'credentials', 'rollback', 'journal-complete', 'restore-fence', 'save-failed',
  ]);
});

test('配置已提交但重连失败时返回成功提交与运行时警告，不再次回滚', async () => {
  const state = fixture({reconnectFailure:true});
  const result = await state.save();
  assert.equal(result.committed, true);
  assert.equal(result.runtimeWarning.code, 'TEST_RECONNECT_FAILURE');
  assert.equal(state.persisted(), state.after);
  assert.equal(state.events.includes('rollback'), false);
  assert.equal(state.events.includes('save-failed'), false);
  assert.equal(state.events.includes('invalidate-context'), true);
  assert.equal(state.events.includes('invalidate-approvals'), true);
  assert.equal(state.events.includes('audit'), true);
  assert.doesNotMatch(JSON.stringify(result), /test-only-placeholder/);
});
