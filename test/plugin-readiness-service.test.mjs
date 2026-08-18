import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginAssessmentService, assessPlugin } from '../src/plugin-readiness-service.mjs';

function server(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',displayName:'Server',
    revision:4,configState:'ready',target:{host:'app.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'deploy'},uplink:{type:'direct'},tunnelProvider:true,
    policy:{status:'auto'},limits:{timeoutMs:10_000},...overrides,
  };
}

function mysql(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',displayName:'MySQL',
    revision:2,configState:'ready',target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'required'},
    policy:{select:'auto'},limits:{maxRows:100},...overrides,
  };
}

function runtime(plugin, phase = 'disconnected', overrides = {}) {
  return {
    phase,reason:null,sequence:7,operationId:null,
    plugins:{
      [plugin.pluginInstanceId]:{
        pluginInstanceId:plugin.pluginInstanceId,
        phase,reason:null,sequence:7,operationId:null,
      },
    },
    ...overrides,
  };
}

test('assessment returns the orthogonal state model with legacy fallbacks', () => {
  const plugin = server();
  const result = assessPlugin({
    plugin,
    environmentPlugins:[plugin],
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin),
  });
  assert.deepEqual(result.scope,{projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1'});
  assert.equal(result.recordRevision,4);
  assert.match(result.connectionFingerprint,/^[a-f0-9]{64}$/u);
  assert.match(result.agentFingerprint,/^[a-f0-9]{64}$/u);
  assert.deepEqual(result.persistence,{state:'committed',dirty:false,warning:null});
  assert.deepEqual(result.configuration,{state:'complete',issues:[]});
  assert.deepEqual(result.credential,{state:'available',editIntent:'unchanged'});
  assert.deepEqual(result.dependency,{state:'ready',providerPluginInstanceId:null});
  assert.deepEqual(result.resourceScope,{state:'not-required',kind:null,value:null});
  assert.deepEqual(Object.keys(result.validationByPurpose),[
    'tls-probe','server-auth','resource-discovery','resource-access','health-check',
  ]);
  assert.ok(Object.values(result.validationByPurpose).every((value) => value === null));
  assert.deepEqual(result.runtime,{
    phase:'disconnected',reason:null,sequence:7,operationId:null,
  });
  assert.equal(result.providerRuntimeBlock,null);
  assert.equal(result.agent.availability,'unavailable');
  assert.deepEqual(result.edit,{state:'viewing',editSessionId:null});
  assert.deepEqual(result.primaryStatus,{kind:'disconnected',label:'未连接',action:'connect'});
  assert.equal(result.configState,'ready');
  assert.equal(result.phase,'disconnected');
});

test('configuration issues and resource scope stay separate', () => {
  const plugin = mysql({
    configState:'draft',
    target:{host:'db.internal',port:3306,database:'',addressFamily:'ipv4Only'},
  });
  const result = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin),
  });
  assert.equal(result.persistence.state,'committed');
  assert.equal(result.configuration.state,'incomplete');
  assert.deepEqual(result.configuration.issues.map(({field,code}) => [field,code]),[
    ['target.database','REQUIRED'],
  ]);
  assert.deepEqual(result.resourceScope,{state:'missing',kind:'mysql-database',value:null});
  assert.equal(result.agent.availability,'unavailable');
  assert.ok(result.agent.issues.some((item) => item.code === 'PLUGIN_CONFIGURATION_INCOMPLETE'));
  assert.deepEqual(result.primaryStatus,{kind:'needs-configuration',label:'需要配置（1 项）',action:'continue-configuration'});
  assert.equal(result.configState,'draft');
});

test('Provider configuration and Provider runtime failures are different dimensions', () => {
  const provider = server();
  const plugin = mysql({transport:{kind:'serverTunnel',serverPluginInstanceId:provider.pluginInstanceId}});
  const runtimeSnapshot = runtime(plugin,'disconnected',{
    plugins:{
      [plugin.pluginInstanceId]:{phase:'disconnected',reason:null,sequence:9,operationId:null},
      [provider.pluginInstanceId]:{phase:'error',reason:'SSH_AUTH_FAILED',sequence:8,operationId:'provider-op'},
    },
  });
  const result = assessPlugin({
    plugin,
    environmentPlugins:[provider,plugin],
    credentialSummary:{state:'available'},
    runtimeSnapshot,
  });
  assert.deepEqual(result.dependency,{state:'ready',providerPluginInstanceId:'server-1'});
  assert.deepEqual(result.providerRuntimeBlock,{
    providerPluginInstanceId:'server-1',phase:'error',reason:'SSH_AUTH_FAILED',operationId:'provider-op',
  });
  assert.equal(result.primaryStatus.kind,'disconnected');

  const missing = assessPlugin({plugin,environmentPlugins:[plugin]});
  assert.deepEqual(missing.dependency,{state:'provider-missing',providerPluginInstanceId:'server-1'});
  assert.deepEqual(missing.primaryStatus,{kind:'dependency-blocked',label:'依赖不可用',action:'view-provider'});

  const disabledProvider = server({tunnelProvider:false});
  const disabled = assessPlugin({plugin,environmentPlugins:[disabledProvider,plugin]});
  assert.deepEqual(disabled.dependency,{state:'capability-disabled',providerPluginInstanceId:'server-1'});

  const incompleteProvider = server({target:{host:'',port:22,addressFamily:'ipv4Only'},configState:'draft'});
  const incomplete = assessPlugin({plugin,environmentPlugins:[incompleteProvider,plugin]});
  assert.deepEqual(incomplete.dependency,{state:'provider-incomplete',providerPluginInstanceId:'server-1'});
});

test('credential safety blocks have priority over ordinary configuration and runtime states', () => {
  const plugin = mysql({
    configState:'draft',
    target:{host:'',port:3306,database:'',addressFamily:'ipv4Only'},
  });
  const result = assessPlugin({
    plugin,
    credentialSummary:{state:'unreadable'},
    persistenceSummary:{state:'committed',dirty:true,warning:{code:'OLD_CIPHERTEXT_PRESERVED'}},
    runtimeSnapshot:runtime(plugin,'error'),
  });
  assert.equal(result.configuration.state,'incomplete');
  assert.equal(result.credential.state,'unreadable');
  assert.deepEqual(result.persistence.warning,{code:'OLD_CIPHERTEXT_PRESERVED'});
  assert.deepEqual(result.primaryStatus,{kind:'credential-recovery',label:'凭据需要恢复',action:'view-recovery'});
});

test('fixed database verification and connected runtime jointly gate Agent availability', () => {
  const plugin = mysql();
  const disconnected = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'disconnected'),
  });
  assert.equal(disconnected.resourceScope.state,'selected-unverified');
  assert.equal(disconnected.agent.availability,'unavailable');

  const connected = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'connected'),
  });
  assert.equal(connected.resourceScope.state,'verified');
  assert.deepEqual(connected.agent,{
    availability:'ready',activity:'idle',approval:'none',issues:[],
  });
  assert.deepEqual(connected.primaryStatus,{kind:'connected',label:'已连接',action:'disconnect'});

  const selectedOnly = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    resourceVerified:false,
    runtimeSnapshot:runtime(plugin,'connected'),
  });
  assert.equal(selectedOnly.resourceScope.state,'selected-unverified');
  assert.equal(selectedOnly.agent.availability,'unavailable');
  assert.ok(selectedOnly.agent.issues.some((item) => item.code === 'PLUGIN_RESOURCE_VALIDATION_REQUIRED'));
});

test('edit and runtime status priorities are deterministic', () => {
  const plugin = server();
  const editing = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'error'),
    editSummary:{state:'editing',editSessionId:'edit-1'},
  });
  assert.deepEqual(editing.primaryStatus,{kind:'editing',label:'正在修改连接配置',action:null});

  const saving = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'connected'),
    editSummary:{state:'saving',editSessionId:'edit-1'},
  });
  assert.deepEqual(saving.primaryStatus,{kind:'saving',label:'正在保存',action:null});

  const failed = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'error',{plugins:{
      [plugin.pluginInstanceId]:{phase:'error',reason:'AUTHENTICATION_FAILED',sequence:11,operationId:'op-1'},
    }}),
  });
  assert.deepEqual(failed.primaryStatus,{
    kind:'connection-error',label:'连接失败：AUTHENTICATION_FAILED',action:'retry',
  });
});

test('validation state is cloned and assessment never calls passed infrastructure objects', () => {
  const plugin = mysql();
  const validation = {
    state:'valid',operationId:'validation-1',draftGeneration:3,configDigest:'a'.repeat(64),
    startedAt:'start',completedAt:'end',error:null,
  };
  const infrastructure = new Proxy({}, {
    get() { throw new Error('pure assessment must not access infrastructure'); },
  });
  const service = new PluginAssessmentService();
  const result = service.assess({
    plugin,
    environmentPlugins:[plugin],
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin),
    validationByPurpose:{'resource-access':validation},
    workspaceStore:infrastructure,
    credentialVault:infrastructure,
    connectionManager:infrastructure,
  });
  assert.deepEqual(result.validationByPurpose['resource-access'],validation);
  result.validationByPurpose['resource-access'].state = 'failed';
  assert.equal(validation.state,'valid');
});

test('assessment validation and warning summaries cannot echo secret-bearing input fields', () => {
  const plugin = mysql();
  const result = assessPlugin({
    plugin,
    persistenceSummary:{
      warning:{code:'PERSISTENCE_WARNING',message:'Cleanup pending',password:'warning-secret'},
    },
    validationByPurpose:{
      'resource-access':{
        state:'failed',operationId:'validation-2',draftGeneration:4,configDigest:'c'.repeat(64),
        startedAt:'start',completedAt:'end',
        temporarySecrets:{password:'validation-secret'},
        error:{code:'MYSQL_DATABASE_ACCESS_DENIED',message:'Access denied',details:{password:'detail-secret'}},
      },
    },
  });
  assert.deepEqual(result.persistence.warning,{code:'PERSISTENCE_WARNING',message:'Cleanup pending'});
  assert.deepEqual(result.validationByPurpose['resource-access'],{
    state:'failed',operationId:'validation-2',draftGeneration:4,configDigest:'c'.repeat(64),
    startedAt:'start',completedAt:'end',
    error:{code:'MYSQL_DATABASE_ACCESS_DENIED',message:'Access denied'},
  });
  assert.doesNotMatch(JSON.stringify(result),/warning-secret|validation-secret|detail-secret|temporarySecrets/u);
});

test('a partial runtime preview never makes a full environment plugin disappear', () => {
  const provider = server();
  const plugin = mysql({transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'}});
  const result = assessPlugin({
    plugin,
    environmentPlugins:[provider,plugin],
    credentialSummary:{state:'available'},
    runtimeSnapshot:{
      phase:'connected',sequence:15,pluginsPartial:true,
      plugins:{[provider.pluginInstanceId]:{phase:'connected',sequence:15}},
    },
  });
  assert.equal(result.scope.pluginInstanceId,'mysql-1');
  assert.equal(result.dependency.state,'ready');
  assert.equal(result.runtime.phase,'disconnected');
});

test('legacy committed drafts and future sidecar drafts keep distinct persistence semantics', () => {
  const incomplete = mysql({
    configState:'draft',
    target:{host:'db.internal',port:3306,database:'',addressFamily:'ipv4Only'},
  });
  const legacy = assessPlugin({plugin:incomplete});
  assert.equal(legacy.persistence.state,'committed');
  assert.equal(legacy.configState,'draft');

  for (const state of ['saved-draft','edit-draft']) {
    const draft = assessPlugin({
      plugin:mysql(),
      persistenceSummary:{state},
      credentialSummary:{state:'available'},
      runtimeSnapshot:runtime(mysql(),'connected'),
    });
    assert.equal(draft.persistence.state,state);
    assert.equal(draft.configuration.state,'complete');
    assert.equal(draft.configState,'draft');
    assert.equal(draft.runtime.phase,'disconnected');
    assert.equal(draft.resourceScope.state,'selected-unverified');
    assert.equal(draft.agent.availability,'unavailable');
    assert.deepEqual(draft.primaryStatus,{kind:'draft',label:'草稿',action:'continue-configuration'});
  }
});

test('a tunnel transport without a Provider reference is dependency-missing', () => {
  const plugin = mysql({transport:{kind:'serverTunnel'}});
  const result = assessPlugin({plugin,environmentPlugins:[plugin]});
  assert.deepEqual(result.dependency,{state:'provider-missing',providerPluginInstanceId:null});
  assert.equal(result.configuration.state,'incomplete');
});

test('a same-id Provider from another scope is not accepted as a dependency', () => {
  const plugin = mysql({transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'}});
  const wrongEnvironment = server({environmentId:'e2'});
  const result = assessPlugin({plugin,environmentPlugins:[wrongEnvironment,plugin]});
  assert.deepEqual(result.dependency,{state:'provider-incomplete',providerPluginInstanceId:'server-1'});
});

test('legacy runtime phases are normalized only inside the new runtime dimension', () => {
  const plugin = mysql();
  const waiting = assessPlugin({
    plugin,
    runtimeSnapshot:{sequence:12,plugins:{'mysql-1':{phase:'waitingDependency',reason:'PROVIDER_PENDING'}}},
  });
  assert.equal(waiting.phase,'waitingDependency');
  assert.equal(waiting.runtime.phase,'connecting');
  assert.equal(waiting.runtime.reason,'PROVIDER_PENDING');

  const blocked = assessPlugin({
    plugin,
    runtimeSnapshot:{sequence:13,plugins:{'mysql-1':{phase:'blocked',reason:'PLUGIN_DEPENDENCY_BLOCKED'}}},
  });
  assert.equal(blocked.phase,'blocked');
  assert.equal(blocked.runtime.phase,'error');
});

test('temporary validation never upgrades formal resource scope or configuration', () => {
  const plugin = mysql();
  const result = assessPlugin({
    plugin,
    credentialSummary:{state:'available'},
    runtimeSnapshot:runtime(plugin,'disconnected'),
    validationByPurpose:{
      'resource-access':{
        state:'valid',operationId:'temporary-op',draftGeneration:2,configDigest:'b'.repeat(64),
        startedAt:'start',completedAt:'end',error:null,
      },
    },
  });
  assert.equal(result.configuration.state,'complete');
  assert.equal(result.resourceScope.state,'selected-unverified');
  assert.equal(result.agent.availability,'unavailable');
  assert.equal(result.primaryStatus.kind,'disconnected');
});

test('assessment whitelists credential state and persistence blocking controls priority', () => {
  const plugin = server();
  const normalized = assessPlugin({
    plugin,
    credentialSummary:{state:'secret-value',editIntent:'renderer-choice',password:'do-not-copy'},
  });
  assert.deepEqual(normalized.credential,{state:'unknown',editIntent:'unchanged'});
  assert.doesNotMatch(JSON.stringify(normalized),/do-not-copy|secret-value|renderer-choice/u);

  const blocked = assessPlugin({
    plugin,
    credentialSummary:{state:'unreadable'},
    persistenceSummary:{
      state:'committed',
      warning:{code:'CONFIG_TRANSACTION_RECOVERY_REQUIRED'},
      blocking:true,
    },
  });
  assert.deepEqual(blocked.primaryStatus,{
    kind:'persistence-blocked',label:'配置存储需要恢复',action:'view-recovery',
  });
});
