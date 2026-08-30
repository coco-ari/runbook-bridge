import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const PLUGIN_SOURCES = [
  'renderer/v2/src/features/plugins/plugin-types.ts',
  'renderer/v2/src/features/plugins/plugin-editor-model.ts',
  'renderer/v2/src/features/plugins/plugin-save-strategy.ts',
  'renderer/v2/src/features/plugins/use-plugin-editor.ts',
  'renderer/v2/src/features/plugins/PluginEditorWorkspace.tsx',
  'renderer/v2/src/features/plugins/PluginEditorConfirmations.tsx',
  'renderer/v2/src/features/plugins/PluginValidationProgress.tsx',
  'renderer/v2/src/features/plugins/PluginAgentAccess.tsx',
  'renderer/v2/src/features/plugins/PluginMetadataDialog.tsx',
  'renderer/v2/src/features/plugins/PluginDeleteDialog.tsx',
  'renderer/v2/src/features/plugins/CredentialMigrationNotice.tsx',
];

test('terminal plugin validation cannot be replaced by late progress',async () => {
  const model = await import(pathToFileURL(path.resolve(
    'renderer/v2/src/features/plugins/plugin-editor-model.ts',
  )).href);
  const base = {
    requestId:'validation-1',purpose:'resource-access',draftGeneration:4,sequence:7,
  };
  const late = {
    requestId:'validation-1',draftGeneration:4,sequence:7,state:'running',
  };
  for (const state of ['valid','failed','cancelled','stale']) {
    const terminal = {...base,state};
    assert.equal(model.mergeValidationProgress(terminal,late),terminal);
  }
  const running = {...base,state:'running'};
  assert.equal(model.mergeValidationProgress(running,{...late,state:'valid'}).state,'valid');
});

test('plugin models emit only explicit secrets and connection fields',async () => {
  const [model,types] = await Promise.all([
    import(pathToFileURL(path.resolve(
      'renderer/v2/src/features/plugins/plugin-editor-model.ts',
    )).href),
    import(pathToFileURL(path.resolve(
      'renderer/v2/src/features/plugins/plugin-types.ts',
    )).href),
  ]);
  const draft = {
    ...types.emptyPluginDraft('server'),
    displayName:'演示服务器',
    target:{host:'server.invalid',port:22,addressFamily:'ipv4Preferred'},
    auth:{username:'operator',type:'password'},
    uplink:{type:'direct'},
  };
  assert.deepEqual(types.collectReplacementSecrets('server','password',{
    primary:'',proxy:'',
  }),{});
  assert.deepEqual(types.collectReplacementSecrets('server','privateKey',{
    primary:'explicit passphrase',proxy:'explicit proxy secret',
  }),{
    privateKeyPassphrase:'explicit passphrase',
    proxyPassword:'explicit proxy secret',
  });
  assert.equal(types.credentialMutationFor({}),'unchanged');
  assert.equal(types.credentialMutationFor({password:'explicit'}),'replace');
  assert.deepEqual(Object.keys(types.connectionPatch(draft)).sort(),[
    'auth','target','uplink',
  ]);
  assert.equal(model.pluginEditorIsDirty(draft,draft,{primary:'',proxy:''}),false);
  assert.equal(model.pluginEditorIsDirty(draft,draft,{primary:'explicit',proxy:''}),true);
  const challenge = model.hostKeyChallengeFromError({
    code:'SSH_HOST_KEY_CONFIRM_REQUIRED',message:'confirm',
    details:{host:'server.invalid',port:22,fingerprint:'SHA256:example'},
  },draft);
  assert.equal(challenge?.fingerprint,'SHA256:example');
  assert.equal(model.hostKeyChallengeFromError({
    code:'SSH_HOST_KEY_CONFIRM_REQUIRED',message:'confirm',
    details:{host:'other.invalid',port:22,fingerprint:'SHA256:wrong'},
  },draft),null);

  const savedWithRuntimeWarning = model.normalizePluginSaveOutcome({
    committed:true,
    plugin:{
      projectId:'project',environmentId:'env',pluginInstanceId:'plugin',
      pluginType:'server',displayName:'Server',revision:4,
    },
    runtimeWarning:{code:'RUNTIME_CLEANUP_FAILED',message:'must not escape'},
  });
  assert.equal(savedWithRuntimeWarning.plugin?.revision,4);
  assert.equal(savedWithRuntimeWarning.runtimeWarning,true);
  assert.equal(savedWithRuntimeWarning.manualReconnectRequired,true);
  assert.equal(Object.hasOwn(savedWithRuntimeWarning,'message'),false);

  const savedWithRecovery = model.normalizePluginSaveOutcome({
    projectId:'project',environmentId:'env',pluginInstanceId:'plugin',
    pluginType:'server',displayName:'Server',revision:5,
    persistenceWarning:{code:'CONFIG_TRANSACTION_CLEANUP_PENDING'},
  });
  assert.equal(savedWithRecovery.persistenceRecoveryPending,true);
  assert.equal(savedWithRecovery.runtimeWarning,false);

  assert.deepEqual(model.normalizePluginDeleteOutcome({
    deleted:true,credentialsPreserved:true,
    runtimeWarning:{code:'RUNTIME_CLEANUP_FAILED',message:'must not escape'},
  },'plugin'),{
    pluginInstanceId:'plugin',runtimeWarning:true,credentialsPreserved:true,
  });
});

test('Renderer save strategies map business choices to the existing IPC contract',async () => {
  const [strategies,bridge] = await Promise.all([
    import(pathToFileURL(path.resolve(
      'renderer/v2/src/features/plugins/plugin-save-strategy.ts',
    )).href),
    fs.readFile('renderer/v2/src/bridge/ai-ops-v2.ts','utf8'),
  ]);
  assert.deepEqual([...strategies.NEW_PLUGIN_SAVE_STRATEGIES],[
    'disconnect','connect-current',
  ]);
  assert.deepEqual([...strategies.EXISTING_PLUGIN_SAVE_STRATEGIES],[
    'disconnect','connect-current','restore-previous',
  ]);
  assert.equal(strategies.pluginSaveStrategyIsAvailable('restore-previous',true),false);
  assert.equal(strategies.pluginSaveStrategyIsAvailable('restore-previous',false),true);
  assert.equal(strategies.editAfterCommitFor('disconnect'),'stay-disconnected');
  assert.equal(strategies.editAfterCommitFor('connect-current'),'connect-current');
  assert.equal(strategies.editAfterCommitFor('restore-previous'),'restore-pre-edit-set');
  assert.equal(strategies.connectionRequestWasAccepted({outcome:'started'}),true);
  assert.equal(strategies.connectionRequestWasAccepted({outcome:'needs-action'}),false);
  const rawContract = bridge.match(
    /export type PluginEditAfterCommit =[\s\S]*?export interface PluginEditSavePayload/u,
  )?.[0] ?? '';
  for (const rawValue of ['stay-disconnected','connect-current','restore-pre-edit-set']) {
    assert.match(rawContract,new RegExp(`"${rawValue}"`,'u'));
  }
  assert.doesNotMatch(rawContract,/\| "connect"\b/u);
});

test('React plugin features preserve scope, credential, and edit-session boundaries', async () => {
  const [types,model,strategies,controller,editor,confirmations,progress,agentAccess,metadata,deletion,migration] =
    await Promise.all(PLUGIN_SOURCES.map((source) => fs.readFile(source,'utf8')));
  const all = [types,model,strategies,controller,editor,confirmations,progress,agentAccess,metadata,deletion,migration].join('\n');

  for (const kind of ['server','mysql','redis']) assert.match(types,new RegExp(`"${kind}"`,'u'));
  for (const field of ['target','auth','uplink','transport','tls']) assert.match(types,new RegExp(field,'u'));
  assert.match(types,/collectReplacementSecrets/u);
  assert.match(types,/credential\.primary\.length > 0/u);
  assert.match(types,/credential\.proxy\.length > 0/u);
  assert.match(types,/credentialMutationFor/u);
  assert.match(types,/Object\.keys\(secrets\)\.length > 0 \? "replace" : "unchanged"/u);
  assert.match(types,/connectionPatch/u);

  assert.match(model,/draftGeneration/u);
  assert.match(model,/sequence/u);
  assert.match(model,/validationMatches/u);
  assert.match(model,/requestId/u);
  assert.match(model,/editSessionId/u);
  assert.match(model,/operationId/u);
  assert.match(model,/configDigest/u);
  assert.match(model,/hostKeyChallengeFromError/u);
  assert.match(model,/host !== draft\.target\.host \|\| port !== draft\.target\.port/u);
  assert.match(model,/normalizePluginSaveOutcome/u);
  assert.match(model,/normalizePluginDeleteOutcome/u);

  assert.match(controller,/preparePluginConnectionEdit/u);
  assert.match(controller,/beginPluginConnectionEdit/u);
  assert.match(controller,/cancelPluginConnectionEdit/u);
  assert.match(controller,/restorePreEditConnections: true/u);
  assert.match(controller,/无法安全结束编辑会话，请重试/u);
  assert.match(controller,/sessionRef\.current === editSessionId/u);
  assert.match(controller,/validatePluginDraft/u);
  assert.match(controller,/probePluginDraft/u);
  assert.match(controller,/cancelPluginValidation/u);
  assert.match(controller,/cancelPluginProbe/u);
  assert.match(controller,/savePluginConnectionEdit/u);
  assert.match(controller,/afterCommit: editAfterCommitFor\(strategy\)/u);
  assert.match(controller,/createPlugin/u);
  assert.match(controller,/requestConnectionIntent/u);
  assert.match(controller,/source: "renderer-plugin-editor"/u);
  assert.match(controller,/pluginInstanceId: outcome\.plugin\.pluginInstanceId/u);
  assert.match(controller,/connectionRequestWasAccepted\(connection\.data\)/u);
  assert.match(controller,/manualReconnectRequired: true/u);
  assert.match(controller,/listPluginDatabases/u);
  assert.match(controller,/stateRef\.current\.draftGeneration !== draftGeneration/u);
  assert.match(controller,/epochRef/u);
  assert.match(controller,/ownerKey/u);
  assert.match(controller,/activeValidationRef/u);
  assert.match(controller,/saveInFlightRef/u);
  assert.match(controller,/credentialPresence/u);
  assert.match(controller,/pendingValidationRetryRef/u);
  assert.match(controller,/pendingSaveStrategyRef/u);
  assert.match(controller,/saveStrategy: PluginSaveStrategy/u);
  assert.match(controller,/persist\(retry\.saveStrategy,false\)/u);
  assert.match(controller,/persist\(pendingSaveStrategyRef\.current,true\)/u);
  assert.match(controller,/applyValidationRecovery/u);
  assert.match(controller,/TLS_UNSUPPORTED/u);
  assert.match(
    controller,
    /runValidation\(\s*retry\.purpose,\s*retry\.saveAfterValidation,\s*retry\.saveStrategy,?\s*\)/u,
  );
  assert.match(controller,/valid && retry\.saveAfterValidation/u);
  assert.match(controller,/pluginEditorIsDirty/u);
  assert.match(model,/pluginEditorIsDirty/u);
  assert.match(controller,/credentials\.primary\.length > 0/u);
  assert.match(controller,/credentials\.proxy\.length > 0/u);
  assert.doesNotMatch(controller,/JSON\.stringify\(credentials\)/u);
  assert.doesNotMatch(controller,/credentialPresence:[\s\S]{0,120}(?:primary: credentials\.primary,|proxy: credentials\.proxy,)/u);
  assert.match(controller,/clear-sensitive/u);
  assert.match(controller,/normalizePluginSaveOutcome/u);
  assert.match(controller,/onSaved\?\.\(\{ \.\.\.outcome, saveStrategy: strategy \}\)/u);
  assert.match(controller,/automaticallyConnects: false/u);
  assert.match(controller,/connectsOnlyWhenExplicitlyRequested: true/u);

  assert.match(strategies,/"disconnect"/u);
  assert.match(strategies,/"connect-current"/u);
  assert.match(strategies,/"restore-previous"/u);
  assert.match(strategies,/disconnect: "stay-disconnected"/u);
  assert.match(strategies,/"restore-previous": "restore-pre-edit-set"/u);
  assert.doesNotMatch(strategies,/afterCommit[^\n]*"connect"/u);

  assert.match(editor,/PluginEditorWorkspace/u);
  assert.doesNotMatch(editor,/SheetContent|SheetHeader|SheetFooter|SheetTitle|components\/ui\/sheet/u);
  assert.match(editor,/data-testid="plugin-editor-workspace"/u);
  assert.match(editor,/data-testid="plugin-editor-scope"/u);
  assert.match(editor,/@container\/editor/u);
  assert.match(editor,/hidden=\{collapsed\}/u);
  assert.match(editor,/id=\{collapsed \? undefined : "detail-main"\}/u);
  assert.match(editor,/onRegisterLeaveGuard\(requestLeave\)/u);
  assert.match(editor,/pendingLeaveRef/u);
  assert.match(editor,/const allowed = await editor\.cancel\(\)/u);
  assert.match(editor,/return allowed/u);
  assert.match(editor,/ButtonGroup/u);
  assert.match(editor,/DropdownMenuContent/u);
  assert.match(editor,/aria-label="插件保存方式"/u);
  assert.match(editor,/aria-label="选择其他保存方式"/u);
  assert.match(editor,/editor\.save\("disconnect"\)/u);
  assert.match(editor,/editor\.save\("connect-current"\)/u);
  assert.match(editor,/editor\.save\("restore-previous"\)/u);
  assert.match(editor,/FieldGroup/u);
  assert.match(editor,/SelectContent/u);
  assert.match(editor,/Collapsible/u);
  assert.match(editor,/PluginEditorConfirmations/u);
  assert.match(editor,/type="password"/u);
  assert.match(editor,/autoComplete="new-password"/u);
  assert.match(editor,/已保存值不会显示/u);
  assert.match(editor,/留空表示保持不变/u);
  assert.match(editor,/保存但不连接/u);
  assert.match(editor,/添加但不连接/u);
  assert.match(editor,/添加并连接/u);
  assert.match(editor,/保存并连接/u);
  assert.match(editor,/保存并恢复连接/u);
  assert.match(editor,/!editor\.isCreating/u);
  assert.match(editor,/@min-\[560px\]\/editor:flex-row/u);
  assert.match(editor,/@min-\[560px\]\/editor:w-auto/u);
  assert.match(editor,/data-testid="plugin-editor-footer"/u);
  assert.match(editor,/<footer[^>]*data-testid="plugin-editor-footer">[\s\S]*?data-testid="plugin-editor-error"[\s\S]*?state\.error\.message/u);
  assert.doesNotMatch(editor.slice(editor.indexOf('<form'),editor.indexOf('</form>')),/data-testid="plugin-editor-error"/u);
  assert.match(editor,/data-testid="plugin-editor-cancel" disabled=\{closeBlocked\}/u);
  assert.match(editor,/plugin-local-change-confirmation/u);
  assert.match(editor,/plugin-unsaved-changes-confirmation/u);
  assert.match(editor,/editor\.isDirty/u);
  assert.match(editor,/if \(closeBlocked \|\| closingRef\.current \|\| pendingLeaveRef\.current\)/u);
  assert.match(editor,/onClick=\{requestClose\}/u);
  assert.match(editor,/void requestLeave\(\)\.then\(\(allowed\) => \{ if \(allowed\) onClosed\(\) \}\)/u);
  assert.match(editor,/清除本次输入的临时凭据/u);
  assert.match(editor,/修改仅作用于当前插件/u);
  assert.match(editor,/\{projectName\}[\s\S]*?\{environmentName\}/u);
  assert.match(editor,/advancedConnectionSummary/u);
  assert.doesNotMatch(editor,/\{scope\.projectId\} \/ \{scope\.environmentId\}/u);
  assert.doesNotMatch(editor,/<ShieldCheck/u);
  assert.match(confirmations,/AlertDialogContent/u);
  assert.match(confirmations,/关闭 TLS 并重试/u);
  assert.match(confirmations,/credential-replacement/u);
  assert.match(progress,/aria-live="polite"/u);
  assert.match(progress,/PURPOSE_LABELS/u);
  assert.doesNotMatch(`${progress}\n${migration}`,/pr-(?:28|32)/u);

  assert.match(agentAccess,/updatePluginAgentConfiguration/u);
  assert.match(agentAccess,/Agent 可执行范围/u);
  assert.match(agentAccess,/Table/u);
  assert.match(agentAccess,/不主动改变网络连接/u);
  for (const id of [
    'plugin-agent-resource-limit-error',
    'plugin-agent-timeout-description',
    'plugin-agent-timeout-error',
  ]) {
    assert.ok((agentAccess.match(new RegExp(id,'gu')) ?? []).length >= 2, `${id} must connect its control and message`);
  }
  assert.match(agentAccess,/error\?\.code === "INVALID_RESOURCE_LIMIT"/u);
  assert.match(agentAccess,/error\?\.code === "INVALID_TIMEOUT"/u);
  assert.match(agentAccess,/saveError \? \([\s\S]*?<Alert variant="destructive">/u);
  assert.doesNotMatch(agentAccess,/<FieldError>\{error\?\.message\}<\/FieldError>/u);
  for (const id of [
    'plugin-display-name-description',
    'plugin-host-error',
    'plugin-port-error',
    'plugin-username-error',
    'plugin-private-key-error',
    'plugin-primary-credential-description',
    'plugin-primary-credential-error',
    'plugin-database-error',
    'plugin-redis-db-error',
    'plugin-proxy-host-error',
    'plugin-proxy-port-error',
    'plugin-proxy-credential-description',
    'plugin-server-vpn-alias-error',
    'plugin-tunnel-server-error',
    'plugin-data-vpn-alias-error',
  ]) {
    assert.ok((editor.match(new RegExp(id,'gu')) ?? []).length >= 2, `${id} must connect its control and message`);
  }
  assert.match(metadata,/updatePluginMetadata/u);
  assert.match(metadata,/if \(!busy\) onOpenChange/u);
  assert.match(metadata,/onInteractOutside/u);
  assert.match(metadata,/expectedRevision/u);
  assert.match(metadata,/不修改连接、凭据、权限或运行状态/u);
  assert.match(deletion,/deletePlugin/u);
  assert.match(deletion,/onEscapeKeyDown/u);
  assert.match(deletion,/dependents/u);
  assert.match(deletion,/event\.preventDefault\(\)/u);
  assert.match(migration,/confirmCredentialMigration/u);
  assert.match(migration,/sourceSha256/u);
  assert.match(migration,/不会向 Renderer 返回明文/u);

  assert.doesNotMatch(all,/window\.confirm|window\.prompt|window\.alert/u);
  assert.doesNotMatch(all,/localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(all,/console\./u);
  assert.doesNotMatch(all,/dangerouslySetInnerHTML/u);
  assert.doesNotMatch(all,/revealCredential/u);
  assert.doesNotMatch(all,/connectPlugin|disconnectPlugin/u);
  assert.doesNotMatch(all,/ipcRenderer|contextBridge/u);
  assert.doesNotMatch(all,/https?:\/\//u);
});

test('plugin workspace permits navigation only after explicit session cleanup succeeds',async () => {
  const controller = await fs.readFile('renderer/v2/src/features/plugins/use-plugin-editor.ts','utf8');
  const cancel = controller.slice(controller.indexOf('  const cancel = useCallback'),controller.indexOf('\n  return {\n    state,'));
  const rejectImpact = controller.slice(controller.indexOf('  const rejectEditImpact = useCallback'),controller.indexOf('  const rejectConfirmation = useCallback'));
  assert.match(controller,/readonly cancel: \(\) => Promise<boolean>/u);
  assert.match(cancel,/cancelPluginConnectionEdit/u);
  assert.match(cancel,/restorePreEditConnections: true/u);
  assert.match(cancel,/return true/u);
  assert.match(cancel,/return false/u);
  assert.doesNotMatch(cancel,/onClosed/u,'failed cleanup must not close or navigate the editor');
  assert.match(rejectImpact,/无法安全取消编辑准备/u);
  assert.ok(
    rejectImpact.indexOf('await api.cancelPluginConnectionEdit({ prepareToken })')
      < rejectImpact.indexOf('preparationRef.current = null'),
    'rejecting edit impact must retain the preparation token until cancellation succeeds',
  );
  const confirmations = await fs.readFile('renderer/v2/src/features/plugins/PluginEditorConfirmations.tsx','utf8');
  assert.match(confirmations,/AlertDialogContent/u);
  assert.match(confirmations,/error/u,'a rejected security action must show its failure within the confirmation surface');
});

test('plugin details compose scoped connection controls without duplicate navigation', async () => {
  const [overview,connectionPanel] = await Promise.all([
    fs.readFile('renderer/v2/src/features/plugins/PluginOverview.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/connections/PluginConnectionPanel.tsx','utf8'),
  ]);

  assert.match(overview,/data-testid="plugin-overview"/u);
  assert.match(overview,/connectionPanel/u);
  assert.match(overview,/capabilityBoundary\(plugin\.pluginType\)/u);
  assert.doesNotMatch(overview,/当前运维范围|onOpenConnection|onOpenAgentAccess|onOpenAudit/u);
  assert.doesNotMatch(overview,/plugin-action-(?:connection|agent|more|audit)/u);
  for (const testId of [
    'plugin-connection-panel','plugin-status-console','plugin-fact-strip',
    'plugin-overview-actions','plugin-connection-primary','plugin-action-edit',
  ]) {
    assert.match(connectionPanel,new RegExp(`data-testid="${testId}"`,'u'));
  }
  assert.match(connectionPanel,/usePluginConnection/u);
  assert.match(connectionPanel,/修改配置/u);
  assert.doesNotMatch(`${overview}\n${connectionPanel}`,/connectPlugin|disconnectPlugin|window\.aiOps/u);
});
