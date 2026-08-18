import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(testDirectory,'..','renderer','v2','app.js');
const renderer = await fs.readFile(rendererPath,'utf8');

function functionSource(name) {
  const marker = `function ${name}(`;
  let start = renderer.indexOf(marker);
  assert.notEqual(start,-1,`${name} must remain available for renderer regression tests`);
  if (renderer.slice(Math.max(0,start - 6),start) === 'async ') start -= 6;
  const signatureEnd = renderer.indexOf(') {',start);
  assert.notEqual(signatureEnd,-1,`${name} must use a standard function body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < renderer.length; index += 1) {
    const character = renderer[index];
    const next = renderer[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return renderer.slice(start,index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function install(context,names) {
  vm.runInContext(names.map(functionSource).join('\n'),context);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise,rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise,resolve,reject};
}

function selectElement(optionValues = [''],selectedValue = optionValues[0] ?? '') {
  let values = optionValues.map(String);
  let value = values.includes(String(selectedValue)) ? String(selectedValue) : '';
  let html = values.map((item) => `<option value="${item}">${item}</option>`).join('');
  const element = {disabled:false};
  Object.defineProperties(element,{
    innerHTML:{
      get:() => html,
      set(next) {
        html = String(next);
        values = [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].map((match) => match[1]);
        value = values[0] ?? '';
      },
    },
    value:{
      get:() => value,
      set(next) { value = values.includes(String(next)) ? String(next) : ''; },
    },
  });
  return element;
}

function databaseRendererHarness(validatePluginDraft,{selectedDatabase = 'orders',savedDatabase = selectedDatabase} = {}) {
  const busyElement = (textContent = '') => ({
    disabled:false,textContent,attributes:new Set(),
    setAttribute(name) { this.attributes.add(name); },
    removeAttribute(name) { this.attributes.delete(name); },
  });
  const elements = {
    pluginType:{value:'mysql'},pluginDisplayName:{value:'Orders'},pluginHost:{value:'db.internal'},
    pluginPort:{value:'3306'},pluginUsername:{value:'reader'},pluginAddressFamily:{value:'ipv4Preferred'},
    pluginTransport:{value:'direct'},pluginProvider:{value:''},pluginVpnAlias:{value:''},pluginTls:{value:'disabled'},
    pluginPassword:{value:'',dataset:{credentialState:'empty'}},
    pluginDatabase:selectElement(selectedDatabase ? ['',selectedDatabase] : [''],selectedDatabase),
    pluginDatabaseOptions:{innerHTML:''},
    databaseHint:{textContent:''},queryDatabases:busyElement('加载数据库'),savePlugin:busyElement(),
  };
  const state = {
    projectId:'project',environmentId:'environment',
    editingPlugin:{pluginInstanceId:'mysql',pluginType:'mysql',target:{database:savedDatabase}},
    databaseDiscoverySignature:null,databaseCredentialRevision:0,databaseQueryGeneration:0,credentialProbeGeneration:4,
    pluginValidationSequence:0,
    pluginEditSession:{editSessionId:'edit-1',draftGeneration:0,validations:{}},
  };
  const context = vm.createContext({
    state,api:{validatePluginDraft,cancelPluginValidation:async () => ({ok:true,data:{state:'cancelled'}})},
    $:(selector) => elements[selector.slice(1)],
    pluginFormPayload:() => ({
      input:{pluginType:'mysql',displayName:'Orders',target:{host:elements.pluginHost.value,port:3306,database:elements.pluginDatabase.value,addressFamily:'ipv4Preferred'},auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'}},
      secrets:{},credentialIntent:'unchanged',
    }),
    clearPluginFormError:() => {},pluginFormActive:() => true,pluginFormVisible:() => true,
    scopeMatches:(scope) => scope.projectId === state.projectId && scope.environmentId === state.environmentId,
    escapeAttr:(value) => String(value),escapeHtml:(value) => String(value),
  });
  install(context,['call','setElementBusy','editedPasswordValue','pluginValidationPurpose','pluginValidationResultMatches','activePluginValidation','cancelLocalPluginValidation','databaseConnectionSignature','invalidateDatabaseDiscovery','queryDatabases']);
  state.databaseDiscoverySignature = vm.runInContext('databaseConnectionSignature()',context);
  return {context,elements,state};
}

test('database discovery invalidation preserves the selected database and unlocks local work', () => {
  const {context,elements,state} = databaseRendererHarness(async () => ({ok:true,data:{editSessionId:'edit-1',requestId:'validation-1',operationId:'operation-1',purpose:'resource-discovery',draftGeneration:0,configDigest:'digest-1',state:'valid',result:{databases:[],truncated:false}}}));
  elements.queryDatabases.disabled = true;
  elements.queryDatabases.textContent = '查询中…';
  elements.savePlugin.disabled = true;
  elements.pluginHost.value = 'new-db.internal';

  vm.runInContext('invalidateDatabaseDiscovery()',context);

  assert.equal(elements.pluginDatabase.value,'orders');
  assert.equal(elements.pluginDatabase.disabled,false);
  assert.equal(elements.queryDatabases.disabled,false);
  assert.equal(elements.queryDatabases.textContent,'加载数据库');
  assert.equal(elements.savePlugin.disabled,false);
  assert.equal(state.databaseQueryGeneration,1);
  assert.equal(state.databaseDiscoverySignature,null);
  assert.match(elements.databaseHint.textContent,/重新查询/);
});

test('database candidate refresh preserves the current draft selection for empty and changed lists', async () => {
  const responses = [
    {ok:true,data:{editSessionId:'edit-1',requestId:'validation-1',operationId:'operation-1',purpose:'resource-discovery',draftGeneration:0,configDigest:'digest-1',state:'valid',result:{databases:[],truncated:false}}},
    {ok:true,data:{editSessionId:'edit-1',requestId:'validation-2',operationId:'operation-2',purpose:'resource-discovery',draftGeneration:0,configDigest:'digest-1',state:'valid',result:{databases:['analytics'],truncated:false}}},
  ];
  const {context,elements} = databaseRendererHarness(async () => responses.shift(),{
    selectedDatabase:'orders',savedDatabase:'legacy_orders',
  });

  await vm.runInContext('queryDatabases()',context);
  assert.equal(elements.pluginDatabase.value,'orders');

  await vm.runInContext('queryDatabases()',context);
  assert.equal(elements.pluginDatabase.value,'orders');
  assert.match(elements.pluginDatabaseOptions.innerHTML,/analytics/);
});

test('a single discovered database is not selected without an explicit user choice', async () => {
  const {context,elements} = databaseRendererHarness(async () => ({
    ok:true,data:{editSessionId:'edit-1',requestId:'validation-1',operationId:'operation-1',purpose:'resource-discovery',draftGeneration:0,configDigest:'digest-1',state:'valid',result:{databases:['analytics'],truncated:false}},
  }),{selectedDatabase:'',savedDatabase:''});

  await vm.runInContext('queryDatabases()',context);

  assert.equal(elements.pluginDatabase.value,'');
  assert.equal(elements.pluginDatabase.disabled,false);
  assert.match(elements.pluginDatabaseOptions.innerHTML,/analytics/);
});

test('database list permission denial preserves manual input and does not block saving', async () => {
  const {context,elements} = databaseRendererHarness(async () => ({
    ok:false,
    error:{
      code:'MYSQL_DATABASE_LIST_FORBIDDEN',
      message:'database list denied',
      details:{manualInputAllowed:true},
    },
  }),{selectedDatabase:'manual_orders',savedDatabase:'orders'});

  await vm.runInContext('queryDatabases()',context);

  assert.equal(elements.pluginDatabase.value,'manual_orders');
  assert.equal(elements.pluginDatabase.disabled,false);
  assert.equal(elements.savePlugin.disabled,false);
  assert.match(elements.databaseHint.textContent,/手工输入/);
});

test('database discovery failure preserves the selected database and restores form actions', async () => {
  const {context,elements} = databaseRendererHarness(async () => ({
    ok:false,error:{code:'DATABASE_DISCOVERY_FAILED',message:'database discovery denied'},
  }));

  await assert.rejects(vm.runInContext('queryDatabases()',context),/database discovery denied/);

  assert.equal(elements.pluginDatabase.value,'orders');
  assert.equal(elements.queryDatabases.disabled,false);
  assert.equal(elements.queryDatabases.textContent,'加载数据库');
  assert.equal(elements.savePlugin.disabled,false);
});

test('field invalidation cancels database discovery locally and ignores its late result', async () => {
  const response = deferred();
  const {context,elements,state} = databaseRendererHarness(() => response.promise);
  const pending = vm.runInContext('queryDatabases()',context);
  await Promise.resolve();
  assert.equal(elements.queryDatabases.disabled,true);
  assert.equal(elements.savePlugin.disabled,true);

  elements.pluginHost.value = 'new-db.internal';
  vm.runInContext('invalidateDatabaseDiscovery()',context);
  assert.equal(elements.pluginDatabase.value,'orders');
  assert.equal(elements.queryDatabases.disabled,false);
  assert.equal(elements.savePlugin.disabled,false);

  response.resolve({ok:true,data:{editSessionId:'edit-1',requestId:'validation-1',operationId:'operation-1',purpose:'resource-discovery',draftGeneration:0,configDigest:'digest-1',state:'valid',result:{databases:['late_database'],truncated:false}}});
  await pending;

  assert.equal(elements.pluginDatabase.value,'orders');
  assert.doesNotMatch(elements.pluginDatabaseOptions.innerHTML,/late_database/);
  assert.match(elements.databaseHint.textContent,/重新查询/);
  assert.equal(state.databaseDiscoverySignature,null);
});

test('plugin-specific validation actions map to dedicated backend purposes', () => {
  const context = vm.createContext({});
  install(context,['pluginValidationPurpose']);
  assert.equal(vm.runInContext("pluginValidationPurpose('server','validate')",context),'server-auth');
  assert.equal(vm.runInContext("pluginValidationPurpose('mysql','discover')",context),'resource-discovery');
  assert.equal(vm.runInContext("pluginValidationPurpose('mysql','validate')",context),'resource-access');
  assert.equal(vm.runInContext("pluginValidationPurpose('redis','validate')",context),'resource-access');
});

test('only an explicit TLS unsupported result can offer to disable TLS in the current draft', () => {
  const tls = {value:'verifyIdentity'};
  let confirmed = true;
  let changed = 0;
  const context = vm.createContext({
    state:{pluginFormDiagnostic:{errorCode:'TLS_CERTIFICATE_INVALID'}},
    $:(selector) => selector === '#pluginTls' ? tls : null,
    confirm:() => confirmed,
    markPluginDraftChanged:() => { changed += 1; },
    renderPluginForm:() => undefined,
    renderPluginFormDiagnostic:() => undefined,
  });
  install(context,['tlsDisableAvailable','disableTlsInCurrentDraft']);
  assert.equal(vm.runInContext('disableTlsInCurrentDraft()',context),false);
  assert.equal(tls.value,'verifyIdentity');
  context.state.pluginFormDiagnostic.errorCode = 'MYSQL_TLS_NOT_SUPPORTED';
  confirmed = false;
  assert.equal(vm.runInContext('disableTlsInCurrentDraft()',context),false);
  assert.equal(tls.value,'verifyIdentity');
  confirmed = true;
  assert.equal(vm.runInContext('disableTlsInCurrentDraft()',context),true);
  assert.equal(tls.value,'disabled');
  assert.equal(changed,1);
});

test('validation correlation rejects a late session, generation, digest, operation, or sequence', () => {
  const context = vm.createContext({});
  install(context,['pluginValidationResultMatches']);
  context.active = {
    editSessionId:'edit-current',requestId:'validation-7',operationId:'operation-current',
    draftGeneration:4,configDigest:'digest-current',sequence:7,
  };
  context.result = {...context.active,state:'valid'};
  assert.equal(vm.runInContext('pluginValidationResultMatches(active,result)',context),true);
  for (const [field,value] of [
    ['editSessionId','edit-old'],['requestId','validation-6'],['operationId','operation-old'],
    ['draftGeneration',3],['configDigest','digest-old'],['sequence',6],
  ]) {
    context.stale = {...context.result,[field]:value};
    assert.equal(vm.runInContext('pluginValidationResultMatches(active,stale)',context),false,field);
  }
});

test('a progress event arriving after immediate local cancel only triggers backend abort', async () => {
  const cancelled = [];
  const active = {editSessionId:'edit-1',requestId:'validation-1',purpose:'resource-access',draftGeneration:2,sequence:8,operationId:null,configDigest:null,state:'cancelled'};
  const state = {pluginEditSession:{editSessionId:'edit-1',validations:{'resource-access':active}},pluginFormDiagnostic:null};
  const context = vm.createContext({
    state,
    api:{cancelPluginValidation:async (payload) => { cancelled.push(payload); return {ok:true,data:{state:'cancelled'}}; }},
  });
  install(context,['call','pluginValidationResultMatches','applyPluginValidationProgress']);
  context.message = {editSessionId:'edit-1',requestId:'validation-1',purpose:'resource-access',draftGeneration:2,operationId:'operation-late',configDigest:'digest-late',state:'running'};
  vm.runInContext('applyPluginValidationProgress(message)',context);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(active.state,'cancelled');
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)),[{editSessionId:'edit-1',operationId:'operation-late'}]);
});

test('connection editor prepares and confirms impact before beginning the fenced edit session', async () => {
  const calls = [];
  const plugin = {projectId:'project',environmentId:'env',pluginInstanceId:'server',revision:5,displayName:'Server'};
  const state = {projectId:'project',environmentId:'env',pluginId:'server',pluginEditPreparation:null,pluginEditSession:null,pluginValidationSequence:0,detailTabs:{},inlineConfigPluginId:null};
  const context = vm.createContext({
    state,
    api:{
      preparePluginConnectionEdit:async (payload) => {
        calls.push(['prepare',payload]);
        return {ok:true,data:{prepareToken:'prepare-1',affectedIds:['server','orders'],preEditConnectedSet:['server','orders'],activeOperations:{connection:[],workspace:[]}}};
      },
      beginPluginConnectionEdit:async (payload) => {
        calls.push(['begin',payload]);
        return {ok:true,data:{editSessionId:'edit-1',plugin,affectedIds:['server','orders'],preEditConnectedSet:['server','orders'],draftGeneration:0}};
      },
    },
    confirm:(message) => { calls.push(['confirm',message]); return true; },
    populatePluginForm:(value) => calls.push(['populate',value]),
    scopeMatches:(scope) => scope.projectId === state.projectId && scope.environmentId === state.environmentId && scope.pluginInstanceId === state.pluginId,
    pluginStateKey:() => 'plugin-key',
    renderShell:() => calls.push(['populate',plugin]),
  });
  install(context,['call','pluginEditImpactMessage','beginPluginConnectionEditor']);
  context.plugin = plugin;
  assert.equal(await vm.runInContext('beginPluginConnectionEditor(plugin)',context),true);
  assert.deepEqual(calls.map(([name]) => name),['prepare','confirm','begin','populate']);
  assert.equal(state.pluginEditPreparation,null);
  assert.equal(state.pluginEditSession.editSessionId,'edit-1');
  assert.deepEqual(state.pluginEditSession.preEditConnectedSet,['server','orders']);
  assert.match(calls[1][1],/2 个连接/);
});

test('partial runtime preserves a full plugin map, while partial-to-partial replaces the preview', () => {
  const context = vm.createContext({result:null});
  install(context,['runtimeTimestamp','runtimeSnapshotIsCurrent','mergeRuntimeSnapshot']);
  const fullPlugins = Object.fromEntries(Array.from({length:8},(_,index) => [`plugin-${index + 1}`,{
    phase:'connected',
    primaryStatus:{kind:'connected',label:'已连接',action:'disconnect'},
    connectionFingerprint:String(index + 1).padStart(64,'0'),
  }]));
  context.current = {sequence:7,plugins:fullPlugins,pluginsPartial:false,connectedCount:8};
  context.incoming = {sequence:7,plugins:{
    'plugin-1':{phase:'error',primaryStatus:{kind:'connection-error',label:'连接失败',action:'retry'}},
    'plugin-2':{phase:'connected',primaryStatus:{kind:'connected',label:'已连接',action:'disconnect'}},
  },pluginsPartial:true,connectedCount:7};
  assert.equal(vm.runInContext('runtimeSnapshotIsCurrent(incoming,current)',context),true);
  vm.runInContext('result = mergeRuntimeSnapshot(incoming,current);',context);
  assert.equal(Object.keys(context.result.plugins).length,8);
  assert.equal(context.result.plugins['plugin-1'].phase,'error');
  assert.equal(context.result.plugins['plugin-1'].primaryStatus.kind,'connection-error');
  assert.equal(context.result.plugins['plugin-8'].phase,'connected');
  assert.equal(context.result.plugins['plugin-8'].primaryStatus.kind,'connected');
  assert.equal(context.result.plugins['plugin-8'].connectionFingerprint,'8'.padStart(64,'0'));
  assert.equal(context.result.connectedCount,7);
  assert.equal(context.result.pluginsPartial,false);

  context.current = {sequence:8,plugins:{old:{phase:'connected'}},pluginsPartial:true};
  context.incoming = {sequence:9,plugins:{next:{phase:'disconnected'}},pluginsPartial:true};
  assert.equal(vm.runInContext('runtimeSnapshotIsCurrent(incoming,current)',context),true);
  vm.runInContext('result = mergeRuntimeSnapshot(incoming,current);',context);
  assert.deepEqual(Object.keys(context.result.plugins),['next']);
  assert.equal(context.result.pluginsPartial,true);
  context.incoming = {sequence:7,plugins:{stale:{phase:'connected'}},pluginsPartial:true};
  assert.equal(vm.runInContext('runtimeSnapshotIsCurrent(incoming,current)',context),false);
});

test('plugin detail cache keys isolate identical plugin ids across scopes', () => {
  const context = vm.createContext({state:{projectId:'project-a',environmentId:'env',detailTabs:{}}});
  install(context,['pluginStateKey','detailTab']);
  const first = vm.runInContext("pluginStateKey('shared','project-a','env')",context);
  const second = vm.runInContext("pluginStateKey('shared','project-b','env')",context);
  assert.notEqual(first,second);
  context.state.detailTabs[first] = 'audit';
  context.plugin = {projectId:'project-b',environmentId:'env',pluginInstanceId:'shared'};
  assert.equal(vm.runInContext('detailTab(plugin)',context),'connection');
});

test('a pending environment connect can be cancelled and its late response cannot win', async () => {
  const connect = deferred();
  let cancelCalls = 0;
  const state = {
    projectId:'project',environmentId:'environment',projectOverviewActive:false,
    runtimeByScope:{},runtime:null,pluginFormDiagnostic:null,
  };
  const context = vm.createContext({
    state,
    inFlightOperations:new Map(),
    runtimeMutationGenerations:new Map(),
    api:{
      requestConnectionIntent:(payload) => {
        if (payload.intent === 'connect') return connect.promise;
        if (payload.intent === 'cancel') {
          cancelCalls += 1;
          return Promise.resolve({ok:true,data:{
            outcome:'cancelled',planId:payload.planId,operationId:null,actions:[],
            snapshot:{projectId:'project',environmentId:'environment',sequence:2,updatedAt:'2026-01-01T00:00:02.000Z',phase:'disconnected',plugins:{}},
          }});
        }
        throw new Error(`unexpected ${payload.intent}`);
      },
    },
    environmentFor:() => ({revision:1}),
    renderRuntimeOperationSurfaces:() => {},
    refreshWorkspaceOverview:async () => true,
  });
  install(context,[
    'call','scopeKey','scopeMatches','pluginStateCoordinates','operationInFlight','beginOperation','finishOperation',
    'runtimeOperationKey','connectionIntentOwnerKey','newConnectionCommandId','renewRuntimeConnectionIntent',
    'beginRuntimeOperation','runtimeOperationIsLatest','runtimeTimestamp','runtimeSnapshotIsCurrent',
    'mergeRuntimeSnapshot','acceptRuntimeSnapshot','scopeDiagnosticPending','handleEnvironmentRuntimeAction',
  ]);
  const connectTask = vm.runInContext("handleEnvironmentRuntimeAction('connect','project','environment')",context);
  await Promise.resolve();
  const cancelTask = vm.runInContext("handleEnvironmentRuntimeAction('cancel','project','environment')",context);
  await cancelTask;
  assert.equal(cancelCalls,1);
  connect.resolve({ok:true,data:{
    outcome:'started',planId:'late-plan',operationId:null,actions:[],
    snapshot:{projectId:'project',environmentId:'environment',sequence:99,updatedAt:'2026-01-01T00:00:99.000Z',phase:'connected',plugins:{}},
  }});
  await connectTask;
  assert.equal(state.runtime.phase,'disconnected');
  assert.equal(state.runtime.sequence,2);
});

test('plugin cancel inherits the active Connect All plan and targets the observed node operation', () => {
  const context = vm.createContext({
    state:{
      runtimeByScope:{'project/environment':{plugins:{orders:{phase:'connecting',operationId:'operation-orders'}}}},
      connectionIntentOwners:{'project/environment:environment':{requestId:'connect-all',planId:'plan-all',operationId:null}},
    },
    inFlightOperations:new Map(),
    runtimeMutationGenerations:new Map(),
  });
  install(context,[
    'scopeKey','operationInFlight','beginOperation','runtimeOperationKey','connectionIntentOwnerKey',
    'newConnectionCommandId','renewRuntimeConnectionIntent','beginRuntimeOperation',
  ]);

  const operation = vm.runInContext("beginRuntimeOperation('project','environment','cancel','orders')",context);

  assert.equal(operation.planId,'plan-all');
  assert.equal(operation.operationId,'operation-orders');
  assert.equal(operation.ownerInherited,true);
  assert.equal(operation.ownerKey,'project/environment:environment');
});

test('duplicate environment delete confirmation sends one request until its UI transaction finishes', async () => {
  const deletion = deferred();
  let deleteCalls = 0;
  const button = {disabled:false,setAttribute(){},removeAttribute(){}};
  const context = vm.createContext({
    inFlightOperations:new Map(),
    api:{deleteEnvironment:() => { deleteCalls += 1; return deletion.promise; }},
    button,
    completions:0,
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },
  });
  install(context,[
    'call','scopeKey','beginOperation','finishOperation','environmentDeleteOperationKey','deleteEnvironmentOnce',
  ]);
  const first = vm.runInContext("deleteEnvironmentOnce('project','environment',button,async () => { completions += 1; })",context);
  const duplicate = vm.runInContext("deleteEnvironmentOnce('project','environment',button,async () => { completions += 1; })",context);
  assert.equal(button.disabled,true);
  assert.equal(deleteCalls,1);
  assert.equal(await duplicate,false);
  deletion.resolve({ok:true,data:{}});
  assert.equal(await first,true);
  assert.equal(context.completions,1);
  assert.equal(button.disabled,false);
  assert.equal(context.inFlightOperations.size,0);
});

test('environment deletion reports a post-commit refresh failure without retrying the destructive request', async () => {
  let deleteCalls = 0;
  let warning = '';
  const button = {disabled:false,setAttribute(){},removeAttribute(){}};
  const context = vm.createContext({
    inFlightOperations:new Map(),
    api:{deleteEnvironment:async () => { deleteCalls += 1; return {ok:true,data:{credentialsPreserved:true}}; }},
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },
    toast:(value,isError) => { warning = `${isError}:${value}`; },
  });
  install(context,['call','scopeKey','beginOperation','finishOperation','environmentDeleteOperationKey','deleteEnvironmentOnce']);
  context.button = button;
  const deleted = await vm.runInContext("deleteEnvironmentOnce('project','environment',button,async () => { throw new Error('overview unavailable'); })",context);
  assert.equal(deleted,true);
  assert.equal(deleteCalls,1);
  assert.match(warning,/true:环境配置已删除/);
  assert.match(warning,/本机加密凭据仍保留/);
  assert.match(warning,/列表刷新失败/);
});

test('runbook render and a late load preserve an edited draft', async () => {
  const read = deferred();
  const state = {
    projectId:'project',environmentId:'environment',view:'runbook',
    runbookContent:'',runbookDraft:'',runbookRevision:null,runbookScopeKey:null,
    runbookEditing:false,runbookDirty:false,runbookLoading:false,runbookLoadGeneration:0,
  };
  const context = vm.createContext({
    state,
    api:{readRunbook:() => read.promise},
    renderRunbook:() => {},
    activeEnvironment:() => ({revision:1}),
  });
  install(context,['call','scopeKey','loadRunbook','runbookVisibleContent']);
  const load = vm.runInContext('loadRunbook()',context);
  state.runbookDraft = '用户尚未保存的内容';
  state.runbookDirty = true;
  state.runbookEditing = true;
  assert.equal(vm.runInContext('runbookVisibleContent()',context),'用户尚未保存的内容');
  read.resolve({ok:true,data:{content:'服务器上的旧内容'}});
  await load;
  assert.equal(state.runbookDraft,'用户尚未保存的内容');
  assert.equal(state.runbookDirty,true);
  assert.equal(state.runbookEditing,true);
});

test('revealed credentials cannot write into a later scope and leaving only clears revealed plaintext', async () => {
  const reveal = deferred();
  const input = {type:'password',value:'*****',dataset:{credentialState:'stored'}};
  const button = {dataset:{passwordTarget:'pluginPassword'},disabled:false,setAttribute(){},removeAttribute(){}};
  const authType = {value:'password'};
  const state = {projectId:'project-a',environmentId:'env-a',editingPlugin:{pluginInstanceId:'shared',pluginType:'server'},credentialRevealGeneration:0};
  const context = vm.createContext({
    state,
    button,
    api:{revealCredential:() => reveal.promise},
    $:(selector) => selector === '#pluginPassword' ? input : selector === '#pluginAuthType' ? authType : selector.includes('data-password-target') ? button : null,
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },
    updatePasswordToggle:() => {},
    markPasswordStored:() => { input.type = 'password'; input.value = '*****'; input.dataset.credentialState = 'stored'; },
    resetPasswordControl:() => { input.type = 'password'; input.value = ''; input.dataset.credentialState = 'empty'; },
    primaryCredentialField:() => 'password',
    pluginFormVisible:() => true,
  });
  install(context,['call','scopeMatches','clearTransientRevealedCredentials','togglePasswordVisibility']);
  const pending = vm.runInContext('togglePasswordVisibility(button)',context);
  state.projectId = 'project-b';
  state.environmentId = 'env-b';
  vm.runInContext('clearTransientRevealedCredentials()',context);
  reveal.resolve({ok:true,data:{value:'old-secret'}});
  await pending;
  assert.equal(input.value,'*****');
  assert.equal(input.dataset.credentialState,'stored');
  assert.equal(button.disabled,false);

  input.value = 'unsaved-secret';
  input.dataset.credentialState = 'edited';
  vm.runInContext('clearTransientRevealedCredentials()',context);
  assert.equal(input.value,'unsaved-secret');
  assert.equal(input.dataset.credentialState,'edited');
});

test('credential status from another environment cannot mark a reused plugin id as stored', async () => {
  const status = deferred();
  let storedMarks = 0;
  const state = {projectId:'project',environmentId:'env-a',editingPlugin:{pluginInstanceId:'shared'},credentialProbeGeneration:1};
  const context = vm.createContext({
    state,
    api:{credentialStatus:() => status.promise},
    $:() => ({dataset:{credentialState:'empty'}}),
    markPasswordStored:() => { storedMarks += 1; },
    pluginFormVisible:() => true,
  });
  install(context,['call','scopeMatches','loadCredentialIndicators']);
  context.plugin = {projectId:'project',environmentId:'env-a',pluginInstanceId:'shared'};
  const pending = vm.runInContext('loadCredentialIndicators(plugin,1)',context);
  state.environmentId = 'env-b';
  state.credentialProbeGeneration = 2;
  status.resolve({ok:true,data:{fields:{primary:true,proxy:true}}});
  await pending;
  assert.equal(storedMarks,0);
});

test('only explicitly edited non-empty secrets are emitted by the form', () => {
  const inputs = {pluginPassword:{value:'secret',dataset:{credentialState:'revealed'}},pluginProxyPassword:{value:'',dataset:{credentialState:'edited'}}};
  const context = vm.createContext({$:(selector) => inputs[selector.slice(1)]});
  install(context,['editedPasswordValue']);
  assert.equal(vm.runInContext("editedPasswordValue('pluginPassword')",context),'');
  assert.equal(vm.runInContext("editedPasswordValue('pluginProxyPassword')",context),'');
  inputs.pluginPassword.dataset.credentialState = 'edited';
  assert.equal(vm.runInContext("editedPasswordValue('pluginPassword')",context),'secret');
});

test('legacy credential confirmation is scope-bound and never includes plaintext in its IPC payload', async () => {
  let request = null;
  let refreshed = null;
  let message = '';
  let confirmation = '';
  const scope = {projectId:'project',environmentId:'env',pluginInstanceId:'server'};
  const state = {
    projectId:'project',environmentId:'env',credentialProbeGeneration:3,
    editingPlugin:{...scope,revision:7},
    credentialMigration:{
      status:'confirmation-required',scope,expectedRevision:7,sourceSha256:'a'.repeat(64),
      sourceBinding:{host:'old.example',port:22,username:'deploy'},
      currentBinding:{host:'new.example',port:22,username:'deploy'},
      changedFields:{host:true,proxyType:true},
    },
  };
  const button = {isConnected:true};
  const context = vm.createContext({
    state,api:{confirmCredentialMigration:async (payload) => { request = payload; return {ok:true,data:{imported:true,preserved:true}}; }},
    confirm:(value) => { confirmation = value; return true; },scopeMatches:() => true,pluginFormVisible:() => true,
    beginOperation:() => ({token:true}),finishOperation:() => {},setElementBusy:() => {},
    renderCredentialMigrationNotice:() => {},
    loadCredentialIndicators:async (plugin,generation) => { refreshed = {plugin,generation}; },
    toast:(value) => { message = value; },
  });
  install(context,['call','credentialMigrationBindingLabel','credentialMigrationChangedLabels','confirmCredentialMigration']);
  context.button = button;
  await vm.runInContext('confirmCredentialMigration(button)',context);
  assert.deepEqual(JSON.parse(JSON.stringify(request)),{...scope,expectedRevision:7,sourceSha256:'a'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(request),/must-not-leak|old\.example|new\.example/);
  assert.equal(state.credentialMigration,null);
  assert.equal(refreshed.generation,4);
  assert.match(message,/旧凭据已安全沿用/);
  assert.match(confirmation,/旧凭据目标：deploy@old\.example:22/);
  assert.match(confirmation,/当前插件目标：deploy@new\.example:22/);
  assert.match(confirmation,/变化项：主机、代理方式/);
  context.binding = {ssh:{host:'old.example',port:22,username:'deploy',password:'must-not-leak'}};
  assert.equal(vm.runInContext('credentialMigrationBindingLabel(binding)',context),'deploy@old.example:22');
});

test('the unified leave guard preserves edits on cancel and asynchronously releases the owned edit session after confirmation', async () => {
  let allowLeave = false;
  let clearedWith = null;
  const cancelled = [];
  const state = {
    projectId:'project',environmentId:'env',
    runbookContent:'saved',runbookDraft:'draft',runbookDirty:true,runbookEditing:true,
    pluginFormMode:'inline',pluginFormInitial:'initial',inlineConfigPluginId:'plugin',
    pluginFormDiagnostic:{status:'pending',scope:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin'}},
    pluginEditSession:{editSessionId:'edit-1',phase:'editing'},pluginEditPreparation:null,
  };
  const context = vm.createContext({
    state,
    inFlightOperations:new Map(),
    api:{cancelPluginConnectionEdit:async (payload) => { cancelled.push(payload); return {ok:true,data:{cancelled:true}}; }},
    confirm:() => allowLeave,
    pluginFormDirty:() => true,
    clearTransientRevealedCredentials:(options) => { clearedWith = options; },
  });
  install(context,['call','scopeKey','operationInFlight','currentScopeSaveInFlight','cancelOwnedPluginEditSession','mayLeaveCurrentScope','scopeDiagnosticPending']);
  assert.equal(await vm.runInContext('mayLeaveCurrentScope()',context),false);
  assert.equal(state.runbookDraft,'draft');
  assert.equal(state.pluginFormDiagnostic.status,'pending');
  assert.equal(vm.runInContext("scopeDiagnosticPending('project','env')",context),true);
  assert.equal(cancelled.length,0);

  allowLeave = true;
  assert.equal(await vm.runInContext('mayLeaveCurrentScope()',context),true);
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)),[{editSessionId:'edit-1',restorePreEditConnections:true}]);
  assert.equal(state.pluginEditSession,null);
  assert.equal(state.runbookDraft,'saved');
  assert.equal(state.runbookDirty,false);
  assert.equal(state.pluginFormDiagnostic,null);
  assert.equal(clearedWith.discardEdited,true);
  assert.equal(vm.runInContext("scopeDiagnosticPending('project','env')",context),false);
});

test('navigation is blocked without clearing drafts while the current scope is saving', async () => {
  let confirmations = 0;
  let clears = 0;
  let message = '';
  const state = {
    projectId:'project',environmentId:'env',runbookDirty:false,
    pluginFormMode:'inline',pluginFormInitial:'saved',inlineConfigPluginId:'plugin',
  };
  const context = vm.createContext({
    state,
    inFlightOperations:new Map([['plugin-save:project/env:plugin',{}]]),
    confirm:() => { confirmations += 1; return true; },
    pluginFormDirty:() => true,
    clearTransientRevealedCredentials:() => { clears += 1; },
    toast:(value) => { message = value; },
  });
  install(context,['scopeKey','operationInFlight','currentScopeSaveInFlight','mayLeaveCurrentScope']);
  assert.equal(await vm.runInContext('mayLeaveCurrentScope()',context),false);
  assert.equal(confirmations,0);
  assert.equal(clears,0);
  assert.match(message,/正在保存/);
  assert.equal(state.pluginFormInitial,'saved');
  context.inFlightOperations.clear();
  context.inFlightOperations.set('runbook-save:project/env',{});
  assert.equal(await vm.runInContext('mayLeaveCurrentScope()',context),false);
  assert.equal(confirmations,0);
  assert.equal(clears,0);
});

test('a failed plugin save leaves the form draft and credential state untouched', async () => {
  const state = {
    projectId:'project',environmentId:'env',
    editingPlugin:{pluginInstanceId:'plugin',revision:3},
    pluginFormInitial:'draft-signature',pluginFormDiagnostic:{status:'failure'},inlineConfigPluginId:'plugin',
    pluginEditSession:{editSessionId:'edit-1',baseRecordRevision:3,preEditConnectedSet:[],phase:'editing'},
  };
  const context = vm.createContext({
    state,
    inFlightOperations:new Map(),
    pluginFormPayload:() => ({input:{displayName:'Draft'},patch:{target:{host:'draft'}},secrets:{password:'unsaved-secret'},credentialIntent:'replace'}),
    api:{savePluginConnectionEdit:async () => ({ok:false,error:{message:'save failed'}})},
    renderPluginFormDiagnostic:() => {},
    refreshEnvironmentMetadata:async () => { throw new Error('must not refresh after failed save'); },
  });
  install(context,['call','scopeKey','beginOperation','finishOperation','savePlugin']);
  await assert.rejects(vm.runInContext('savePlugin()',context),/save failed/);
  assert.equal(state.pluginFormInitial,'draft-signature');
  assert.equal(state.inlineConfigPluginId,'plugin');
  assert.equal(state.editingPlugin.pluginInstanceId,'plugin');
});

test('a committed plugin save with a runtime warning clears the saved credential draft and warns without retrying', async () => {
  let updateCalls = 0;
  let cleared = null;
  let message = '';
  const state = {
    projectId:'project',environmentId:'env',pluginId:'plugin',selectionKind:'plugin',
    editingPlugin:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin',revision:3},
    pluginFormInitial:'draft-signature',pluginFormDiagnostic:{status:'success'},inlineConfigPluginId:'plugin',detailTabs:{},
    pluginEditSession:{editSessionId:'edit-1',baseRecordRevision:3,preEditConnectedSet:['plugin'],phase:'editing'},
  };
  const context = vm.createContext({
    state,inFlightOperations:new Map(),
    pluginFormPayload:() => ({input:{displayName:'Saved'},patch:{target:{host:'saved'}},secrets:{password:'new-secret'},credentialIntent:'replace'}),
    api:{savePluginConnectionEdit:async () => {
      updateCalls += 1;
      return {ok:true,data:{
        committed:true,
        plugin:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin',revision:4,configState:'ready'},
        runtimeWarning:{code:'RUNTIME_CLEANUP_FAILED'},
      }};
    }},
    renderPluginFormDiagnostic:() => {},
    clearTransientRevealedCredentials:(options) => { cleared = options; },
    refreshEnvironmentMetadata:async () => {},scopeMatches:() => true,loadEnvironment:async () => true,
    pluginDiagnosticAvailable:() => true,pluginDiagnosticConfigurationIssue:() => null,
    pluginStateKey:() => 'plugin-key',renderShell:() => {},toast:(value) => { message = value; },
  });
  install(context,['call','scopeKey','beginOperation','finishOperation','pluginRuntimeWarningMessage','savePlugin']);
  await vm.runInContext('savePlugin()',context);
  assert.equal(updateCalls,1);
  assert.equal(cleared.discardEdited,true);
  assert.equal(state.pluginFormInitial,null);
  assert.equal(state.pluginFormDiagnostic,null);
  assert.equal(state.inlineConfigPluginId,null);
  assert.match(message,/配置和密码已保存/);
  assert.match(message,/连接失败/);
  assert.match(message,/不要重新保存/);
});

test('a committed plugin deletion warning states that deletion succeeded and credentials remain', () => {
  const context = vm.createContext({});
  install(context,['pluginRuntimeWarningMessage']);
  context.result = {runtimeWarning:{code:'RUNTIME_CLEANUP_FAILED'}};
  const message = vm.runInContext("pluginRuntimeWarningMessage(result,'delete','数据库插件')",context);
  assert.match(message,/数据库插件.*已删除/);
  assert.match(message,/本机凭据仍保留/);
  assert.match(message,/手动断开并重新连接环境/);
});

test('a committed plugin save with a pending recovery journal asks for restart without suggesting a retry or reconnect', async () => {
  let cleared = null;
  let message = '';
  const state = {
    projectId:'project',environmentId:'env',pluginId:'plugin',selectionKind:'plugin',
    editingPlugin:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin',revision:3},
    pluginFormInitial:'draft-signature',pluginFormDiagnostic:null,inlineConfigPluginId:'plugin',detailTabs:{},
    pluginEditSession:{editSessionId:'edit-1',baseRecordRevision:3,preEditConnectedSet:[],phase:'editing'},
  };
  const context = vm.createContext({
    state,inFlightOperations:new Map(),
    pluginFormPayload:() => ({input:{displayName:'Saved'},patch:{target:{host:'saved'}},secrets:{password:'new-secret'},credentialIntent:'replace'}),
    api:{savePluginConnectionEdit:async () => ({ok:true,data:{
      committed:true,
      plugin:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin',revision:4,configState:'ready'},
      persistenceWarning:{code:'CONFIG_TRANSACTION_CLEANUP_PENDING',message:'提交记录将在重启后自动完成。'},
    }})},
    renderPluginFormDiagnostic:() => {},
    clearTransientRevealedCredentials:(options) => { cleared = options; },
    refreshEnvironmentMetadata:async () => {},scopeMatches:() => true,loadEnvironment:async () => true,
    pluginDiagnosticAvailable:() => true,pluginDiagnosticConfigurationIssue:() => null,
    pluginStateKey:() => 'plugin-key',renderShell:() => {},toast:(value) => { message = value; },
  });
  install(context,['call','scopeKey','beginOperation','finishOperation','pluginRuntimeWarningMessage','savePlugin']);
  await vm.runInContext('savePlugin()',context);
  assert.equal(cleared.discardEdited,true);
  assert.equal(state.pluginFormInitial,null);
  assert.match(message,/配置和密码已保存/);
  assert.match(message,/重启应用/);
  assert.match(message,/不要重复保存/);
  assert.doesNotMatch(message,/手动断开|重新连接/);
});

test('draft validation pending state is scoped to its plugin and blocks formal connection actions', () => {
  const state = {
    pluginFormDiagnostic:{status:'pending',scope:{projectId:'project',environmentId:'env',pluginInstanceId:'plugin'}},
  };
  const context = vm.createContext({state});
  install(context,['scopeDiagnosticPending']);
  assert.equal(vm.runInContext("scopeDiagnosticPending('project','env','plugin')",context),true);
  assert.equal(vm.runInContext("scopeDiagnosticPending('project','env','other')",context),false);
  state.pluginFormDiagnostic.status = 'success';
  assert.equal(vm.runInContext("scopeDiagnosticPending('project','env','plugin')",context),false);
});

test('draft SSH validation cannot persist an observed fingerprint through the generic plugin update path', () => {
  const source = functionSource('validatePluginDraftAction');
  assert.match(source,/api\.validatePluginDraft/);
  assert.doesNotMatch(source,/api\.updatePlugin/);
  assert.doesNotMatch(source,/confirmAndSaveObservedHostKey/);
});

test('formal host-key confirmation consumes the operation-bound challenge without a second connection plan', async () => {
  let confirmationPayload = null;
  const challenge = {
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',expectedRevision:4,
    projectId:'project',environmentId:'env',pluginInstanceId:'server',
    host:'example.test',port:22,algorithm:'ssh-ed25519',fingerprint:'SHA256:test',
  };
  const context = vm.createContext({
    state:{connectionActionsByScope:{'project/env':[{code:'SSH_HOST_KEY_CONFIRM_REQUIRED',rootPluginInstanceId:'server',affectedPluginInstanceIds:['server'],details:{hostKeyChallenge:challenge}}]}},
    api:{
      confirmConnectionChallenge:async (payload) => {
        confirmationPayload = payload;
        return {ok:true,data:{committed:true,connectionPlan:{planId:'plan-1',outcome:'started'}}};
      },
      requestConnectionIntent:async () => { throw new Error('must not create a second connection plan'); },
      updatePlugin:async () => { throw new Error('must not use generic plugin update'); },
    },
    confirm:() => true,
    runtimeOperationIsLatest:() => true,
  });
  install(context,['call','scopeKey','connectionHostKeyChallenge','confirmRuntimeHostKeyChallenge']);
  context.scope = {projectId:'project',environmentId:'env',pluginInstanceId:'server'};
  const result = await vm.runInContext('confirmRuntimeHostKeyChallenge(scope,{})',context);
  assert.equal(result.connectionPlan.planId,'plan-1');
  assert.deepEqual({...confirmationPayload},{
    challengeId:'challenge-1',planId:'plan-1',operationId:'operation-1',
    expectedRevision:4,decision:'trust-host-key',
  });
  const source = functionSource('confirmRuntimeHostKeyChallenge');
  assert.doesNotMatch(source,/requestConnectionIntent|updatePlugin/u);
});

test('runtime status rendering is coalesced to one animation frame', () => {
  let frame = null;
  let frames = 0;
  let projectRenders = 0;
  let runtimeRenders = 0;
  const context = vm.createContext({
    state:{projectId:'project',environmentId:'env',dragSort:null,sortSaving:false,railRefreshPending:false,projectOverviewActive:false},
    dirtyRuntimeScopes:new Set(),
    runtimeRenderFrame:null,
    requestAnimationFrame:(callback) => { frames += 1; frame = callback; return frames; },
    withUiContinuity:(render) => render(),
    renderProjects:() => { projectRenders += 1; },
    renderProjectOverview:() => {},
    renderRuntime:() => { runtimeRenders += 1; },
  });
  install(context,['scopeKey','scheduleRuntimeRender']);
  context.first = {projectId:'project',environmentId:'env'};
  vm.runInContext('scheduleRuntimeRender(first); scheduleRuntimeRender(first);',context);
  assert.equal(frames,1);
  frame();
  assert.equal(projectRenders,1);
  assert.equal(runtimeRenders,1);
});

test('workspace change bursts share one overview refresh', async () => {
  let refreshes = 0;
  const context = vm.createContext({
    state:{
      projectId:'current',environmentId:'env',projectOverviewActive:false,
      projectOverviewActivityProjectId:null,projectOverviewActivityGeneration:0,
      managedProjectId:null,environmentsByProject:{},dragSort:null,sortSaving:false,railRefreshPending:false,
    },
    queuedWorkspaceChanges:[],
    workspaceChangeRefreshPromise:null,
    refreshWorkspaceOverview:async () => { refreshes += 1; return true; },
    $:() => ({open:false}),
    renderEnvironmentManager:() => {},
    loadEnvironment:async () => false,
    toast:() => {},
    withUiContinuity:(render) => render(),
    renderProjects:() => {},
    renderProjectOverview:() => {},
    renderResourcePane:() => {},
    showError:(error) => { throw error; },
  });
  install(context,['scopeMatches','invalidateWorkspaceActivity','dedupeWorkspaceChanges','drainWorkspaceChanges','queueWorkspaceChange']);
  const first = vm.runInContext("queueWorkspaceChange({type:'project-updated',projectId:'other'})",context);
  const second = vm.runInContext("queueWorkspaceChange({type:'environment-updated',projectId:'other'})",context);
  assert.equal(first,second);
  await first;
  assert.equal(refreshes,1);
});

test('a failed workspace refresh keeps its event batch for the next attempt and unlocks activity refresh', async () => {
  let refreshes = 0;
  let shownErrors = 0;
  let activityRenders = 0;
  const refreshButton = {disabled:true,setAttribute(){},removeAttribute(){}};
  const context = vm.createContext({
    state:{
      projectId:'project',environmentId:'env',projectOverviewActive:true,
      projectOverviewActivityProjectId:'project',projectOverviewActivityGeneration:3,
      projectOverviewActivityEntries:[{id:1}],projectOverviewActivityLoading:true,projectOverviewActivityRefreshing:true,
      managedProjectId:null,environmentsByProject:{},dragSort:null,sortSaving:false,railRefreshPending:false,
    },
    queuedWorkspaceChanges:[],workspaceChangeRefreshPromise:null,
    refreshWorkspaceOverview:async () => {
      refreshes += 1;
      if (refreshes === 1) throw new Error('temporary failure');
      return true;
    },
    $:(selector) => selector === '[data-refresh-overview-activity]' ? refreshButton : {open:false},
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },
    renderProjectOverviewActivity:() => { activityRenders += 1; },
    renderEnvironmentManager:() => {},renderProjects:() => {},renderProjectOverview:() => {},renderResourcePane:() => {},
    loadEnvironment:async () => false,toast:() => {},withUiContinuity:(render) => render(),
    showError:() => { shownErrors += 1; },
  });
  install(context,['scopeMatches','invalidateWorkspaceActivity','dedupeWorkspaceChanges','drainWorkspaceChanges','queueWorkspaceChange']);
  await vm.runInContext("queueWorkspaceChange({type:'environment-updated',projectId:'project',environmentId:'env'})",context);
  assert.equal(refreshes,1);
  assert.equal(shownErrors,1);
  assert.equal(context.queuedWorkspaceChanges.length,1);
  assert.equal(context.state.projectOverviewActivityRefreshing,false);
  assert.equal(refreshButton.disabled,false);
  assert.equal(activityRenders,1);
  await vm.runInContext("queueWorkspaceChange({type:'environment-updated',projectId:'project',environmentId:'env'})",context);
  assert.equal(refreshes,2);
  assert.equal(context.queuedWorkspaceChanges.length,0);
});

test('audit refreshes are singleflight per scope and always restore the refresh button', async () => {
  const audit = deferred();
  let listCalls = 0;
  let renders = 0;
  const button = {disabled:false,setAttribute(){},removeAttribute(){}};
  const state = {
    projectId:'project',environmentId:'env',pluginId:'plugin',selectionKind:'plugin',view:'audit',
    auditLoadGeneration:0,auditEntries:[],
  };
  const context = vm.createContext({
    state,auditLoadPromises:new Map(),button,
    api:{listAudit:() => { listCalls += 1; return audit.promise; }},
    $:(selector) => selector === '#refreshAudit' ? button : null,
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },
    renderAudit:() => { renders += 1; },
  });
  install(context,['call','currentAuditScope','auditScopeKey','auditScopeIsCurrent','syncAuditRefreshBusy','trackAuditLoad','beginAuditLoad','loadAudit']);
  const first = vm.runInContext('loadAudit()',context);
  const duplicate = vm.runInContext('loadAudit()',context);
  assert.equal(listCalls,1);
  assert.equal(button.disabled,true);
  audit.resolve({ok:true,data:{entries:[{id:'entry'}]}});
  await Promise.all([first,duplicate]);
  assert.equal(listCalls,1);
  assert.equal(renders,1);
  assert.equal(state.auditEntries[0].id,'entry');
  assert.equal(button.disabled,false);
  assert.equal(context.auditLoadPromises.size,0);
});

test('clearing audit invalidates an older scan and performs one fresh read afterward', async () => {
  const oldRead = deferred();
  const freshRead = deferred();
  let listCalls = 0;
  const state = {
    projectId:'project',environmentId:'env',pluginId:null,selectionKind:'environment',view:'audit',
    auditLoadGeneration:0,auditEntries:[],
  };
  const button = {disabled:false,setAttribute(){},removeAttribute(){}};
  const context = vm.createContext({
    state,auditLoadPromises:new Map(),
    api:{listAudit:() => (++listCalls === 1 ? oldRead.promise : freshRead.promise)},
    $:(selector) => selector === '#refreshAudit' ? button : null,
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },renderAudit:() => {},
  });
  install(context,[
    'call','currentAuditScope','auditScopeKey','auditScopeIsCurrent','syncAuditRefreshBusy',
    'refreshAuditAfterMutation','trackAuditLoad','beginAuditLoad','loadAudit',
  ]);
  context.scope = {projectId:'project',environmentId:'env',pluginInstanceId:null};
  const oldRequest = vm.runInContext('loadAudit()',context);
  const refresh = vm.runInContext('refreshAuditAfterMutation(scope)',context);
  assert.equal(listCalls,1);
  oldRead.resolve({ok:true,data:{entries:[{id:'stale'}]}});
  await oldRequest;
  await Promise.resolve();
  assert.equal(listCalls,2);
  assert.equal(state.auditEntries.length,0);
  freshRead.resolve({ok:true,data:{entries:[{id:'fresh'}]}});
  await refresh;
  assert.equal(state.auditEntries[0].id,'fresh');
  assert.equal(button.disabled,false);
});

test('returning to a scope with a stale pending audit read starts a fresh read after it settles', async () => {
  const staleRead = deferred();
  const freshRead = deferred();
  let listCalls = 0;
  const state = {
    projectId:'project',environmentId:'env',pluginId:'plugin-a',selectionKind:'plugin',view:'audit',
    auditLoadGeneration:0,auditEntries:[],
  };
  const button = {disabled:false,setAttribute(){},removeAttribute(){}};
  const context = vm.createContext({
    state,auditLoadPromises:new Map(),
    api:{listAudit:() => (++listCalls === 1 ? staleRead.promise : freshRead.promise)},
    $:(selector) => selector === '#refreshAudit' ? button : null,
    setElementBusy:(element,busy) => { element.disabled = Boolean(busy); },renderAudit:() => {},
  });
  install(context,[
    'call','currentAuditScope','auditScopeKey','auditScopeIsCurrent','syncAuditRefreshBusy',
    'trackAuditLoad','beginAuditLoad','loadAudit',
  ]);
  const first = vm.runInContext('loadAudit()',context);
  state.pluginId = 'plugin-b';
  state.auditLoadGeneration += 1;
  state.pluginId = 'plugin-a';
  state.auditLoadGeneration += 1;
  const returned = vm.runInContext('loadAudit()',context);
  const duplicate = vm.runInContext('loadAudit()',context);
  assert.equal(listCalls,1);
  staleRead.resolve({ok:true,data:{entries:[{id:'stale'}]}});
  await first;
  await Promise.resolve();
  assert.equal(listCalls,2);
  assert.equal(state.auditEntries.length,0);
  freshRead.resolve({ok:true,data:{entries:[{id:'fresh'}]}});
  await Promise.all([returned,duplicate]);
  assert.equal(listCalls,2);
  assert.equal(state.auditEntries[0].id,'fresh');
  assert.equal(button.disabled,false);
});

test('confirmation execution cache is bounded while preserving the active feedback item', () => {
  const state = {confirmationExecutions:{},confirmationFeedback:{item:{requestId:'execution-0'}}};
  const context = vm.createContext({state,CONFIRMATION_EXECUTION_CACHE_LIMIT:100});
  install(context,['pruneConfirmationExecutions','rememberConfirmationExecution']);
  for (let index = 0; index < 150; index += 1) {
    context.change = {type:'confirmation-execution',confirmationId:`execution-${index}`,status:'success'};
    vm.runInContext('rememberConfirmationExecution(change)',context);
  }
  assert.equal(Object.keys(state.confirmationExecutions).length,101);
  assert.ok(state.confirmationExecutions['execution-0']);
  assert.ok(state.confirmationExecutions['execution-149']);
  assert.equal(state.confirmationExecutions['execution-1'],undefined);
});

test('isolated project status is explicit and cannot masquerade as an empty healthy project', () => {
  const project = {projectId:'broken',name:'broken',configurationError:{code:'PROJECT_CONFIG_INVALID',message:'项目配置损坏或不完整，已隔离该项目；其他项目仍可正常使用。'}};
  const context = vm.createContext({state:{projects:[project]},projectSummary:() => { throw new Error('isolated projects must not use normal counts'); }});
  install(context,['projectConfigurationError','projectIsIsolated','projectState','projectSubtitle']);
  assert.equal(vm.runInContext("projectState('broken')",context),'failed');
  assert.equal(vm.runInContext("projectSubtitle('broken')",context),'配置损坏，已隔离');
  assert.match(renderer,/data-project-isolated="true"/);
  assert.match(renderer,/configurationError\.message/);
});
