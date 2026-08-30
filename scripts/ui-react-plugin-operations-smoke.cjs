const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {
  // This smoke owns the temporary window and exits explicitly.
});

const root = path.resolve(__dirname,'..');
const pagePath = path.join(root,'renderer-build','v2','index.html');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(),'runbook-bridge-plugin-operations-'));
const screenshotDirectoryArgument = process.argv.find((value) => value.startsWith('--screenshot-dir='))
  ?.slice('--screenshot-dir='.length);
const commandLineScreenshotDirectory = app.commandLine.getSwitchValue('screenshot-dir') || null;
const screenshotRoot = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR || screenshotDirectoryArgument || commandLineScreenshotDirectory
  ? path.resolve(
      process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR
      ?? screenshotDirectoryArgument
      ?? commandLineScreenshotDirectory,
    )
  : null;
if (screenshotRoot) {
  const relativeScreenshotPath = path.relative(root,screenshotRoot);
  const screenshotInsideRepository = relativeScreenshotPath === ''
    || (!relativeScreenshotPath.startsWith(`..${path.sep}`)
      && relativeScreenshotPath !== '..'
      && !path.isAbsolute(relativeScreenshotPath));
  if (screenshotInsideRepository) {
    throw new Error('Screenshot evidence must be written outside the repository.');
  }
}
const requestedScreenshotTheme = ['light','dark'].includes(process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME)
  ? process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME
  : null;
const registeredChannels = [];
const readCalls = [];
const mutationCalls = [];
const forbiddenCalls = [];
const externalRequests = [];
const rendererErrors = [];
const rendererErrorDiagnostics = [];
const rendererDiagnosticPromises = [];
const geometryFailures = [];
const focusFailures = [];
const probeRuntimeCalls = [];
let currentStep = 'bootstrap';
let syntheticProbePassword = null;
let isolatedScenario = null;

const PROJECT_ID = 'project-plugin-smoke';
const ENVIRONMENT_ID = 'environment-plugin-smoke';
const SERVER_ID = 'plugin-server-smoke';
const NAVIGATION_PROJECT_ID = 'project-plugin-navigation-smoke';
const EDITOR_SELECTOR = '[data-testid="plugin-editor-workspace"]';
const DISCARD_SELECTOR = '[data-testid="plugin-unsaved-changes-confirmation"]';
const LONG_FINGERPRINT = `SHA256:${'Ab3dEf7x'.repeat(36)}`;

app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));
if (requestedScreenshotTheme) nativeTheme.themeSource = requestedScreenshotTheme;

const ok = (data) => ({ok:true,data});
const clone = (value) => structuredClone(value);

function assessment(phase,label,action = null) {
  return {phase,primaryStatus:{kind:phase,label,action}};
}

const state = {
  projectRevision:4,
  environmentRevision:6,
  nextPreparationNumber:1,
  nextSessionNumber:1,
  plugins:[{
    projectId:PROJECT_ID,
    environmentId:ENVIRONMENT_ID,
    pluginInstanceId:SERVER_ID,
    pluginType:'server',
    displayName:'阶段五连接服务器',
    revision:7,
    configState:'ready',
    target:{host:'server.smoke.invalid',port:22,addressFamily:'ipv4Preferred'},
    auth:{username:'operator',type:'agent'},
    uplink:{type:'direct'},
    sources:[],
    assessment:assessment('disconnected','未连接','connect'),
  }],
  runtime:null,
  confirmations:[
    {
      requestId:'confirmation-standard-smoke',
      projectId:PROJECT_ID,
      environmentId:ENVIRONMENT_ID,
      pluginInstanceId:SERVER_ID,
      capability:'fs.upload',
      capabilityLabel:'上传模拟文件',
      summary:'将无敏感内容的测试文件写入模拟临时目录',
      riskLevel:'write',
      approvalLevel:'standard',
      createdAt:new Date().toISOString(),
      expiresAt:Date.now()+600000,
      presentation:{
        kind:'file-transfer',
        target:'阶段五连接服务器',
        source:'fixture.txt',
        destination:'/tmp/fixture.txt',
        bytes:64,
        overwrite:false,
      },
    },
    {
      requestId:'confirmation-strong-smoke',
      projectId:PROJECT_ID,
      environmentId:ENVIRONMENT_ID,
      pluginInstanceId:SERVER_ID,
      capability:'shell.execute',
      capabilityLabel:'执行模拟 Shell',
      summary:'读取模拟服务状态',
      riskLevel:'critical',
      approvalLevel:'strong',
      createdAt:new Date().toISOString(),
      expiresAt:Date.now()+600000,
      presentation:{
        kind:'shell',
        target:'阶段五连接服务器',
        command:'Get-Service -Name ExampleService',
        workingDirectory:'C:\\Temp',
      },
    },
  ],
  preparations:new Map(),
  sessions:new Map(),
  cancelFailuresRemaining:0,
  deferNextEditCancel:false,
  pendingEditCancel:null,
  deferNextEditSave:false,
  pendingEditSave:null,
  nextEditNeedsImpact:false,
  truncatePluginPreview:false,
  failPluginListRead:false,
  pendingConnect:null,
  rendererPluginConnectCount:0,
  runtimeHostKeyMode:false,
  runtimeChallenges:new Map(),
  nextRuntimeChallenge:1,
  runtimeConfirmFailuresRemaining:0,
  deferNextRuntimeConfirm:false,
  pendingRuntimeConfirm:null,
  deferRuntimeChallenges:false,
  pendingRuntimeChallenges:[],
  environmentLifecycle:null,
  allowPluginDeletion:false,
};

function pluginRuntime(plugin,phase) {
  return {
    pluginInstanceId:plugin.pluginInstanceId,
    phase,
    assessment:assessment(phase,phase === 'connected' ? '已连接' : phase === 'connecting' ? '连接中' : '未连接'),
  };
}

function makeRuntime(serverPhase = 'disconnected',sequence = 1) {
  const plugins = Object.fromEntries(state.plugins.map((plugin) => [
    plugin.pluginInstanceId,
    pluginRuntime(plugin,plugin.pluginInstanceId === SERVER_ID ? serverPhase : 'disconnected'),
  ]));
  const connectedCount = Object.values(plugins).filter((plugin) => plugin.phase === 'connected').length;
  return {
    projectId:PROJECT_ID,
    environmentId:ENVIRONMENT_ID,
    phase:serverPhase === 'connected' ? 'partial' : serverPhase === 'connecting' ? 'connecting' : 'disconnected',
    sequence,
    desiredConnected:serverPhase === 'connected' || serverPhase === 'connecting',
    eligibleCount:state.plugins.length,
    connectedCount,
    errorCount:0,
    blockedCount:0,
    draftCount:0,
    plugins,
    pluginsPartial:false,
  };
}

state.runtime = makeRuntime();

function environmentLifecycleSnapshot(phase,sequence = (state.runtime?.sequence ?? 0)+1) {
  return {
    ...makeRuntime(phase,sequence),
    phase,
    connectedCount:phase === 'connected' ? state.plugins.length : 0,
    plugins:Object.fromEntries(state.plugins.map((plugin) => [plugin.pluginInstanceId,pluginRuntime(plugin,phase)])),
  };
}

function environmentOverview() {
  return {
    projectId:PROJECT_ID,
    environmentId:ENVIRONMENT_ID,
    name:'插件操作模拟环境',
    revision:state.environmentRevision,
    pluginCount:state.plugins.length,
    readyPluginCount:state.plugins.length,
    draftCount:0,
    resourcePreview:state.plugins.filter((plugin) => !state.truncatePluginPreview || plugin.pluginInstanceId !== SERVER_ID).map((plugin) => ({
      projectId:plugin.projectId,
      environmentId:plugin.environmentId,
      pluginInstanceId:plugin.pluginInstanceId,
      pluginType:plugin.pluginType,
      displayName:plugin.displayName,
      revision:plugin.revision,
      configState:plugin.configState,
      assessment:plugin.assessment,
    })),
    resourcePreviewTruncated:state.truncatePluginPreview,
    runtime:state.runtime,
  };
}

function workspaceOverview() {
  return [{
    schemaVersion:2,
    projectId:PROJECT_ID,
    name:'插件阶段业务验证项目',
    revision:state.projectRevision,
    environmentCount:1,
    pluginCount:state.plugins.length,
    environments:[environmentOverview()],
  },{
    schemaVersion:2,
    projectId:NAVIGATION_PROJECT_ID,
    name:'隔离的导航验证项目',
    revision:1,
    environmentCount:0,
    pluginCount:0,
    environments:[],
  }];
}

function findPlugin(pluginInstanceId) {
  return state.plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId) ?? null;
}

function setServerPhase(phase) {
  state.runtime = makeRuntime(phase,(state.runtime?.sequence ?? 0)+1);
  const plugin = findPlugin(SERVER_ID);
  if (plugin) plugin.assessment = assessment(phase,phase === 'connected' ? '已连接' : phase === 'connecting' ? '连接中' : '未连接');
  return state.runtime;
}

function register(channel,handler) {
  registeredChannels.push(channel);
  ipcMain.handle(channel,handler);
}

function registerRead(channel,handler) {
  register(channel,async (_event,...args) => {
    readCalls.push({channel,args:clone(args)});
    if (channel === 'v2:plugin-list' && state.failPluginListRead
      && args[0]?.projectId === PROJECT_ID && args[0]?.environmentId === ENVIRONMENT_ID) {
      return {ok:false,error:{code:'PLUGIN_LIST_READ_FAILED',message:'模拟插件列表刷新失败。'}};
    }
    return ok(clone(await handler(...args)));
  });
}

function registerMutation(channel,handler) {
  register(channel,async (_event,payload) => {
    mutationCalls.push({channel,payload:clone(recordableMutationPayload(channel,payload))});
    return clone(await handler(payload));
  });
}

function assertSyntheticCredentials(value,label) {
  assert.equal(
    syntheticProbePassword === null
      ? value === undefined || Object.keys(value).length === 0
      : value !== null && typeof value === 'object'
        && Object.keys(value).length === 1 && value.password === syntheticProbePassword,
    true,
    `${label} must contain only the expected transient synthetic value`,
  );
}

function recordableMutationPayload(channel,payload) {
  if (channel !== 'v2:plugin-probe' && channel !== 'v2:plugin-create') return payload;
  const field = channel === 'v2:plugin-probe' ? 'temporarySecrets' : 'secrets';
  const {[field]:transientValue,...recordable} = payload;
  assertSyntheticCredentials(transientValue,channel);
  assertNoSensitivePayload(recordable,channel);
  // Secret values are checked in memory only and never copied into mutation evidence.
  return recordable;
}

function registerForbidden(channel) {
  register(channel,async (_event,payload) => {
    forbiddenCalls.push({channel,payload:clone(payload)});
    return {ok:false,error:{code:'PLUGIN_SMOKE_FORBIDDEN',message:'该操作不属于插件业务 smoke。'}};
  });
}

function connectionResult(payload,snapshot,actions = [],operationId = null) {
  return ok({
    outcome:'started',
    snapshot,
    actions,
    planId:payload.planId ?? null,
    operationId,
  });
}

async function registerMockApi() {
  const { PluginProbeManager } = await import('../src/plugin-probe-manager.mjs');
  const { toPublicError } = await import('../src/errors.mjs');
  const probeManager = new PluginProbeManager({
    workspaceStore:{getEnvironment:async (projectId,environmentId) => {
      assert.equal(projectId,PROJECT_ID);
      assert.equal(environmentId,ENVIRONMENT_ID);
      return environmentOverview();
    }},
    mutationCoordinator:{runEnvironmentOperation:async (projectId,environmentId,operation) => {
      assert.equal(projectId,PROJECT_ID);
      assert.equal(environmentId,ENVIRONMENT_ID);
      return operation();
    }},
    credentialUseResolver:{resolve:async ({committedPlugin,temporarySecrets}) => {
      assert.equal(committedPlugin,null,'new plugin probes must never load committed credentials');
      assertSyntheticCredentials(temporarySecrets,'probe resolver input');
      return {
        source:Object.keys(temporarySecrets).length ? 'temporary' : 'none',
        secrets:{...temporarySecrets},
      };
    }},
    validationRuntime:{
      validate:async ({pluginType,purpose,draft,resolvedSecrets}) => {
        assert.equal(draft.projectId,PROJECT_ID);
        assert.equal(draft.environmentId,ENVIRONMENT_ID);
        assert.match(draft.pluginInstanceId,/^diagnostic-edit-/u);
        assertSyntheticCredentials(resolvedSecrets,'probe runtime input');
        probeRuntimeCalls.push({pluginType,purpose,usesTemporaryCredentials:syntheticProbePassword !== null});
        return {reachable:true};
      },
      cleanup:async () => ({cleaned:true}),
    },
  });
  registerRead('v2:project-list',() => workspaceOverview().map(({environments:_,...project}) => project));
  registerRead('v2:workspace-overview',workspaceOverview);
  registerRead('v2:environment-list',(projectId) => projectId === PROJECT_ID ? [environmentOverview()] : []);
  registerRead('v2:environment-status',({projectId,environmentId}) => (
    projectId === PROJECT_ID && environmentId === ENVIRONMENT_ID ? state.runtime : makeRuntime()
  ));
  registerRead('v2:plugin-list',({projectId,environmentId}) => (
    projectId === PROJECT_ID && environmentId === ENVIRONMENT_ID ? state.plugins : []
  ));
  registerRead('v2:plugin-assess',({pluginInstanceId}) => (
    findPlugin(pluginInstanceId)?.assessment ?? assessment('disconnected','未连接','connect')
  ));
  registerRead('v2:plugin-credential-status',() => ({saved:false,fields:{primary:false,proxy:false},legacyAvailable:false}));
  registerRead('v2:plugin-databases',() => ({databases:[],truncated:false}));
  registerRead('v2:audit-list',() => []);
  registerRead('v2:confirmation-list',() => state.confirmations);
  registerRead('v2:runbook-read',() => ({content:'# 插件操作模拟环境',hash:'0'.repeat(64),revision:state.environmentRevision}));
  registerRead('v2:quick-question-opening-get',() => ({text:'只读检查模拟环境。',defaultText:'只读检查模拟环境。',revision:1}));
  registerRead('v2:quick-question-list',() => ({schemaVersion:1,projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,revision:1,items:[]}));

  registerMutation('v2:plugin-probe',async (payload) => {
    try {
      return ok(await probeManager.probePluginDraft(payload,{ownerId:'renderer:plugin-smoke'}));
    } catch (error) {
      return {ok:false,error:toPublicError(error)};
    }
  });
  registerMutation('v2:plugin-create',(payload) => {
    const input = payload.input;
    const plugin = {
      ...clone(input),
      projectId:payload.projectId,
      environmentId:payload.environmentId,
      revision:1,
      configState:'ready',
      assessment:assessment('disconnected','未连接','connect'),
    };
    state.plugins.push(plugin);
    state.environmentRevision += 1;
    state.runtime = makeRuntime('disconnected',(state.runtime?.sequence ?? 0)+1);
    return ok(plugin);
  });
  registerMutation('v2:plugin-delete',(payload) => {
    assert.equal(state.allowPluginDeletion,true,'deletion is only allowed in the explicit re-add regression');
    exactKeys(payload,['projectId','environmentId','pluginInstanceId'],'plugin deletion');
    assert.equal(payload.projectId,PROJECT_ID);
    assert.equal(payload.environmentId,ENVIRONMENT_ID);
    assert.ok(findPlugin(payload.pluginInstanceId),'deletion must target an existing scoped plugin');
    state.plugins = state.plugins.filter((plugin) => plugin.pluginInstanceId !== payload.pluginInstanceId);
    state.environmentRevision += 1;
    state.runtime = makeRuntime('disconnected',(state.runtime?.sequence ?? 0)+1);
    return ok({deletedPluginInstanceId:payload.pluginInstanceId});
  });
  registerMutation('v2:plugin-connection-edit-prepare',(payload) => {
    exactKeys(payload,['projectId','environmentId','pluginInstanceId','expectedRevision'],'edit preparation');
    assert.equal(payload.projectId,PROJECT_ID,'edit preparation must retain the original project');
    assert.equal(payload.environmentId,ENVIRONMENT_ID,'edit preparation must retain the original environment');
    assert.equal(payload.pluginInstanceId,SERVER_ID,'edit preparation must retain the selected plugin');
    assert.equal(payload.expectedRevision,findPlugin(SERVER_ID).revision,'edit preparation must bind the current revision');
    const prepareToken = `prepare-${state.nextPreparationNumber++}`;
    state.preparations.set(prepareToken,clone(payload));
    const preEditConnectedSet = state.nextEditNeedsImpact ? [SERVER_ID] : [];
    state.nextEditNeedsImpact = false;
    return ok({
      prepareToken,
      affectedIds:[payload.pluginInstanceId],
      preEditConnectedSet,
      activeOperations:{connection:[],workspace:[]},
    });
  });
  registerMutation('v2:plugin-connection-edit-begin',(payload) => {
    exactKeys(payload,['prepareToken'],'edit begin');
    const prepared = state.preparations.get(payload.prepareToken);
    assert.ok(prepared,'edit begin must use a known preparation token');
    const editSessionId = `edit-session-${state.nextSessionNumber++}`;
    state.sessions.set(editSessionId,prepared);
    state.preparations.delete(payload.prepareToken);
    return ok({editSessionId});
  });
  registerMutation('v2:plugin-draft-validate',(payload) => ok({
    requestId:payload.requestId,
    editSessionId:payload.editSessionId,
    draftGeneration:payload.draftGeneration,
    sequence:payload.sequence,
    state:'valid',
    result:{reachable:true},
  }));
  registerMutation('v2:plugin-connection-edit-save',(payload) => {
    const scope = state.sessions.get(payload.editSessionId);
    assert.ok(scope,'edit save must use a known edit session');
    const plugin = findPlugin(scope.pluginInstanceId);
    assert.ok(plugin,'edit save must stay in the prepared plugin scope');
    const commit = () => {
      Object.assign(plugin,clone(payload.patch),{revision:plugin.revision+1});
      state.sessions.delete(payload.editSessionId);
      state.environmentRevision += 1;
      return ok({plugin});
    };
    if (state.deferNextEditSave) {
      state.deferNextEditSave = false;
      return new Promise((resolve) => {
        state.pendingEditSave = {payload:clone(payload),resolve:() => resolve(commit())};
      });
    }
    return commit();
  });
  registerMutation('v2:plugin-connection-edit-cancel',(payload) => {
    const cancel = () => {
      if (state.cancelFailuresRemaining > 0) {
        state.cancelFailuresRemaining -= 1;
        return {ok:false,error:{code:'EDIT_CANCEL_RESTORE_FAILED',message:'模拟编辑会话恢复暂时失败，请重试。'}};
      }
      if (payload.editSessionId) state.sessions.delete(payload.editSessionId);
      if (payload.prepareToken) state.preparations.delete(payload.prepareToken);
      return ok({cancelled:true});
    };
    if (state.deferNextEditCancel) {
      state.deferNextEditCancel = false;
      return new Promise((resolve) => {
        state.pendingEditCancel = {payload:clone(payload),resolve:() => resolve(cancel())};
      });
    }
    return cancel();
  });
  registerMutation('v2:connection-intent',async (payload) => {
    if (state.environmentLifecycle) {
      assert.equal(payload.source,'renderer-environment','environment lifecycle must use the environment controller');
      assert.equal(payload.projectId,PROJECT_ID);
      assert.equal(payload.environmentId,ENVIRONMENT_ID);
      assert.equal(Object.hasOwn(payload,'pluginInstanceId'),false,'environment lifecycle must never impersonate a plugin request');
      assertNoSensitivePayload(payload,'environment lifecycle request');
      const lifecycle = state.environmentLifecycle;
      if (payload.intent === 'connect') {
        lifecycle.connectCount += 1;
        if (lifecycle.connectCount === 1) {
          state.runtime = environmentLifecycleSnapshot('connected');
          return connectionResult(payload,state.runtime,[],'environment-connect-operation');
        }
        assert.equal(lifecycle.connectCount,2,'environment lifecycle has one immediate and one delayed connect');
        state.runtime = environmentLifecycleSnapshot('connecting');
        return new Promise((resolve) => { lifecycle.pending = {payload:clone(payload),resolve}; });
      }
      assert.ok(['disconnect','cancel'].includes(payload.intent),'environment lifecycle rejects unexpected intents');
      if (payload.intent === 'cancel') assert.equal(payload.planId,lifecycle.pending?.payload.planId,'environment cancellation binds its pending plan');
      state.runtime = environmentLifecycleSnapshot('disconnected');
      return connectionResult(payload,state.runtime,[],`environment-${payload.intent}-operation`);
    }
    if (payload.source === 'renderer-plugin-editor') {
      return connectionResult(payload,state.runtime,[],'editor-connect-operation');
    }
    if (state.runtimeHostKeyMode) {
      assert.ok(['renderer-plugin','renderer-environment'].includes(payload.source),'host-key fixtures must use an existing connection source');
      assert.equal(payload.projectId,PROJECT_ID,'runtime host-key request stays in the original project');
      assert.equal(payload.environmentId,ENVIRONMENT_ID,'runtime host-key request stays in the original environment');
      assert.ok(['connect','retry'].includes(payload.intent),'runtime host-key fixture only accepts explicit connection attempts');
      if (payload.source === 'renderer-plugin') assert.equal(payload.pluginInstanceId,SERVER_ID,'runtime host-key plugin request stays in the exact plugin');
      else assert.equal(Object.hasOwn(payload,'pluginInstanceId'),false,'environment requests must not impersonate a plugin request');
      const number = state.nextRuntimeChallenge++;
      const challenge = {
        challengeId:`runtime-host-key-challenge-${number}`,
        planId:payload.planId,
        operationId:`runtime-host-key-operation-${number}`,
        expectedRevision:findPlugin(SERVER_ID).revision,
        pluginInstanceId:SERVER_ID,
        host:`runtime-${number}.smoke.invalid`,
        port:22,
        fingerprint:`${LONG_FINGERPRINT}-${number}`,
        algorithm:'ssh-ed25519',
      };
      state.runtimeChallenges.set(challenge.challengeId,challenge);
      const complete = () => connectionResult(payload,setServerPhase('disconnected'),[{
        code:'SSH_HOST_KEY_CONFIRM_REQUIRED',rootPluginInstanceId:SERVER_ID,
        affectedPluginInstanceIds:[SERVER_ID],details:{hostKeyChallenge:challenge},
      }],challenge.operationId);
      if (state.deferRuntimeChallenges) {
        return new Promise((resolve) => {
          state.pendingRuntimeChallenges.push({payload:clone(payload),challenge,resolve:() => resolve(complete())});
        });
      }
      return complete();
    }
    assert.equal(payload.source,'renderer-plugin');
    if (payload.intent === 'disconnect') {
      return connectionResult(payload,setServerPhase('disconnected'),[],'disconnect-operation');
    }
    if (payload.intent === 'cancel') {
      const result = connectionResult(payload,setServerPhase('disconnected'),[],'cancel-operation');
      const pending = state.pendingConnect;
      state.pendingConnect = null;
      if (pending) setTimeout(() => pending.resolve(
        connectionResult(pending.payload,setServerPhase('connected'),[],'late-connect-operation'),
      ),20);
      return result;
    }
    state.rendererPluginConnectCount += 1;
    if (state.rendererPluginConnectCount === 1) {
      const snapshot = setServerPhase('disconnected');
      const operationId = 'host-key-operation';
      return connectionResult(payload,snapshot,[{
        code:'SSH_HOST_KEY_CONFIRM_REQUIRED',
        rootPluginInstanceId:SERVER_ID,
        affectedPluginInstanceIds:[SERVER_ID],
        details:{hostKeyChallenge:{
          challengeId:'host-key-challenge-smoke',
          planId:payload.planId,
          operationId,
          expectedRevision:findPlugin(SERVER_ID).revision,
          pluginInstanceId:SERVER_ID,
          host:'server.smoke.invalid',
          port:22,
          fingerprint:LONG_FINGERPRINT,
          algorithm:'ssh-ed25519',
        }},
      }],operationId);
    }
    if (state.rendererPluginConnectCount === 2) {
      return connectionResult(payload,setServerPhase('connected'),[],'connect-operation');
    }
    setServerPhase('connecting');
    return new Promise((resolve) => {
      state.pendingConnect = {payload:clone(payload),resolve};
    });
  });
  registerMutation('v2:connection-challenge-confirm',(payload) => {
    assert.equal(state.runtimeHostKeyMode,true,'only explicit runtime host-key confirmation cases may confirm a challenge');
    const challenge = state.runtimeChallenges.get(payload.challengeId);
    assert.ok(challenge,'confirmation must bind a known runtime challenge');
    assertRuntimeHostKeyPayload(payload,challenge);
    const complete = () => {
      if (state.runtimeConfirmFailuresRemaining > 0) {
        state.runtimeConfirmFailuresRemaining -= 1;
        return {ok:false,error:{code:'HOST_KEY_CONFIRM_FAILED',message:'模拟主机指纹确认暂时失败，请重试。'}};
      }
      state.runtimeChallenges.delete(challenge.challengeId);
      return ok({confirmed:true});
    };
    if (state.deferNextRuntimeConfirm) {
      state.deferNextRuntimeConfirm = false;
      return new Promise((resolve) => {
        state.pendingRuntimeConfirm = {payload:clone(payload),resolve:() => resolve(complete())};
      });
    }
    return complete();
  });
  registerMutation('v2:confirmation-approve',(requestId) => {
    state.confirmations = state.confirmations.filter((item) => item.requestId !== requestId);
    return ok({requestId,status:'approved'});
  });
  registerMutation('v2:confirmation-reject',(requestId) => {
    state.confirmations = state.confirmations.filter((item) => item.requestId !== requestId);
    return ok({requestId,status:'rejected'});
  });

  [
    'v2:project-create','v2:project-update','v2:project-delete',
    'v2:quick-question-opening-save','v2:quick-question-save','v2:quick-question-delete','v2:quick-question-copy',
    'v2:environment-create','v2:environment-update','v2:environment-delete','v2:environment-reorder',
    'v2:runbook-save','v2:plugin-update','v2:plugin-metadata-update','v2:plugin-agent-configuration-update',
    'v2:plugin-connection-update','v2:plugin-validation-cancel','v2:plugin-probe-cancel',
    'v2:plugin-credential-migration-confirm','v2:plugin-credential-reveal',
    'v2:audit-clear',
  ].forEach(registerForbidden);
}

function unregisterMockApi() {
  for (const channel of registeredChannels) ipcMain.removeHandler(channel);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve,ms));
}

async function waitUntil(predicate,label,timeoutMs = 10000) {
  const deadline = Date.now()+timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitFor(win,evaluate,label,timeoutMs = 10000) {
  const deadline = Date.now()+timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(evaluate,true)) return;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setExactViewport(win,width,height) {
  const initial = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  if (initial[0] === width && initial[1] === height) return;
  if (win.isMaximized()) {
    win.unmaximize();
    await wait(120);
  }
  win.setContentSize(width,height);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await wait(120);
    const current = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
    if (current[0] === width && current[1] === height) return;
    const [contentWidth,contentHeight] = win.getContentSize();
    // Native Windows bounds may update before Chromium acknowledges a resize.
    // Do not apply a second correction using the previous renderer viewport.
    if (contentWidth === width && contentHeight === height) continue;
    win.setContentSize(
      Math.max(1,contentWidth+width-current[0]),
      Math.max(1,contentHeight+height-current[1]),
    );
  }
  const actual = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  assert.deepEqual(actual,[width,height],`unable to calibrate the Electron content viewport: ${JSON.stringify({
    bounds:win.getBounds(),contentBounds:win.getContentBounds(),maximized:win.isMaximized(),fullscreen:win.isFullScreen(),
  })}`);
}

async function click(win,selector,label = selector) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return false;
    target.click();
    return true;
  })()`,true);
  assert.equal(clicked,true,`${label} is not visible`);
  await wait(80);
}

async function activateTab(win,tab) {
  await ensureNativeKeyboardFocus(win);
  const selector = `[data-detail-tab="${tab}"]`;
  const activated = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return false;
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown',{
      bubbles:true,cancelable:true,code:'Enter',key:'Enter',
    }));
    return true;
  })()`,true);
  assert.equal(activated,true,`${tab} detail tab is not visible`);
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`,
    `${tab} detail tab activation`,
  );
}

async function openPopup(win,selector,label = selector) {
  await ensureNativeKeyboardFocus(win);
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return null;
    target.focus();
    const rect = target.getBoundingClientRect();
    return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
  })()`,true);
  assert.ok(point,`${label} is not visible`);
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
  win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
  await wait(80);
}

async function clickNavigation(win,selector,label) {
  const exposed = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return false;
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return hit instanceof HTMLElement && target.contains(hit)
      && !target.closest('[inert],[aria-hidden="true"]');
  })()`,true);
  assert.equal(exposed,true,`${label} must be reachable without an overlay blocking navigation`);
  await openPopup(win,selector,label);
}

async function viewEnvironmentDetails(win,label) {
  await ensureNativeKeyboardFocus(win);
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-testid="environment-trigger-${ENVIRONMENT_ID}"]');
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return null;
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    if (!(hit instanceof HTMLElement) || !target.contains(hit)
      || target.closest('[inert],[aria-hidden="true"]')) return null;
    target.focus();
    return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
  })()`,true);
  assert.ok(point,`${label} must be reachable without an overlay blocking navigation`);
  // The heading controls accordion visibility. Its context-menu action is the
  // explicit navigation path that still exercises dirty-editor leave guards.
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
  win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'right',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'right',clickCount:1});
  await waitFor(win,`document.querySelector('[role="menu"][data-state="open"]') !== null`,`${label}: environment context menu`);
  await clickText(win,'查看环境','[role="menu"][data-state="open"]');
}

async function clickText(win,text,rootSelector = 'body',roles = 'button,[role="menuitem"],[role="option"]') {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return false;
    const normalize = (value) => String(value ?? '').replace(/\\s+/gu,' ').trim();
    const target = [...root.querySelectorAll(${JSON.stringify(roles)})].find((candidate) => (
      candidate instanceof HTMLElement
      && candidate.getClientRects().length > 0
      && normalize(candidate.textContent) === ${JSON.stringify(text)}
    ));
    if (!target) return false;
    target.click();
    return true;
  })()`,true);
  assert.equal(clicked,true,`visible action ${text} was not found in ${rootSelector}`);
  await wait(80);
}

async function fill(win,selector,value) {
  const actual = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return null;
    target.focus();
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype,'value')?.set;
    setter?.call(target,${JSON.stringify(value)});
    target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    target.dispatchEvent(new Event('change',{bubbles:true}));
    return target.value;
  })()`,true);
  assert.equal(actual === value,true,`unable to fill ${selector}`);
  await wait(70);
}

async function pressTab(win,shift = false) {
  await ensureNativeKeyboardFocus(win);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:shift ? ['shift'] : []});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:shift ? ['shift'] : []});
  await wait(50);
}

async function pressEscape(win) {
  await ensureNativeKeyboardFocus(win);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await wait(70);
}

async function ensureNativeKeyboardFocus(win) {
  if (await win.webContents.executeJavaScript('document.hasFocus()',true)) return;
  // A hidden Windows Electron window can change activeElement without emitting
  // real focusin/out events. Focus the WebContents, not a synthetic FocusEvent.
  win.webContents.focus();
  await waitFor(win,'document.hasFocus() === true','native renderer keyboard focus',2000);
}

async function assertNativeFocusEvents(win) {
  await ensureNativeKeyboardFocus(win);
  await wait(100);
  const focus = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll('button,input,[tabindex]')].find((element) => (
      element instanceof HTMLElement && element !== document.activeElement
      && element.getClientRects().length > 0 && element.tabIndex >= 0
      && !element.matches(':disabled') && !element.closest('[inert],[aria-hidden="true"]')
    ));
    let nativeFocusIn = false;
    const observe = (event) => { nativeFocusIn ||= event.isTrusted && event.target === target; };
    document.addEventListener('focusin',observe,true);
    target?.focus();
    document.removeEventListener('focusin',observe,true);
    return {hasFocus:document.hasFocus(),nativeFocusIn,targetFocused:document.activeElement === target};
  })()`,true);
  assert.deepEqual(focus,{hasFocus:true,nativeFocusIn:true,targetFocused:true},'keyboard checks require real native focus events, not only activeElement changes');
}

async function settleAnimations(win) {
  await win.webContents.executeJavaScript(`(() => {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
  })()`,true);
  await wait(40);
}

async function captureFreshFrame(win) {
  // Windows may return the previous compositor frame immediately after a resize
  // or Portal change. Repaint and await real frames; do not restyle the evidence.
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    true,
  );
  await wait(120);
  return win.webContents.capturePage();
}

async function captureSurfaceEvidence(win,{name,selector,restoreFocusSelector = null}) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  await setExactViewport(win,1280,820);
  await waitFor(
    win,
    `[...document.querySelectorAll(${JSON.stringify(selector)})].some((candidate) => candidate instanceof HTMLElement && candidate.getClientRects().length > 0)`,
    `${name} screenshot surface`,
  );
  const image = await captureFreshFrame(win);
  const result = await win.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const surface = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
    if (!(surface instanceof HTMLElement)) return null;
    const rect = surface.getBoundingClientRect();
    const saveTrigger = document.querySelector('[data-testid="plugin-save-options"]');
    const saveTriggerRect = saveTrigger instanceof HTMLElement
      ? saveTrigger.getBoundingClientRect()
      : null;
    const controls = [...surface.querySelectorAll('button,input,textarea,[role="menuitem"],[role="option"],[role="checkbox"]')]
      .filter(visible);
    const buttons = controls.filter((control) => control instanceof HTMLButtonElement);
    const toastRects = [...document.querySelectorAll('[data-sonner-toast]')]
      .filter(visible)
      .map((toast) => toast.getBoundingClientRect());
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < buttons.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < buttons.length; rightIndex += 1) {
        const left = buttons[leftIndex].getBoundingClientRect();
        const right = buttons[rightIndex].getBoundingClientRect();
        const overlapX = Math.min(left.right,right.right)-Math.max(left.left,right.left);
        const overlapY = Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top);
        if (overlapX > 1 && overlapY > 1) overlaps.push([leftIndex,rightIndex]);
      }
    }
    const insideViewport = (candidate) => candidate.left >= -1 && candidate.top >= -1
      && candidate.right <= window.innerWidth+1 && candidate.bottom <= window.innerHeight+1;
    return {
      viewport:[window.innerWidth,window.innerHeight],
      saveTriggerRect:saveTriggerRect ? {
        left:saveTriggerRect.left,top:saveTriggerRect.top,right:saveTriggerRect.right,bottom:saveTriggerRect.bottom,
      } : null,
      surfaceRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
      surfaceText:String(surface.textContent ?? '').replace(/\\s+/gu,' ').trim().slice(0,240),
      surfaceInside:insideViewport(rect),
      controlsInside:controls.every((control) => insideViewport(control.getBoundingClientRect())),
      clippedButtons:buttons
        .filter((button) => String(button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
        .filter((button) => button.scrollWidth > button.clientWidth+1)
        .map((button) => ({
          label:String(button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\\s+/gu,' ').trim(),
          clientWidth:button.clientWidth,
          scrollWidth:button.scrollWidth,
        })),
      toastButtonOverlaps:buttons.flatMap((button,buttonIndex) => {
        const buttonRect = button.getBoundingClientRect();
        return toastRects.flatMap((toastRect,toastIndex) => (
          Math.min(buttonRect.right,toastRect.right)-Math.max(buttonRect.left,toastRect.left) > 1
          && Math.min(buttonRect.bottom,toastRect.bottom)-Math.max(buttonRect.top,toastRect.top) > 1
            ? [[buttonIndex,toastIndex]]
            : []
        ));
      }),
      overlaps,
      bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
      rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      surfaceOverflow:surface.scrollWidth-surface.clientWidth,
    };
  })()`,true);
  assert.ok(result,`${name} screenshot surface is not visible`);
  assert.deepEqual(result.viewport,[1280,820],`${name} screenshot viewport`);
  assert.equal(
    result.surfaceInside,
    true,
    `${name} surface exceeds the 1280x820 viewport: ${JSON.stringify(result)}`,
  );
  assert.equal(result.controlsInside,true,`${name} control exceeds the 1280x820 viewport`);
  assert.deepEqual(result.clippedButtons,[],`${name} has a clipped button label`);
  assert.deepEqual(result.overlaps,[],`${name} has overlapping buttons`);
  assert.deepEqual(result.toastButtonOverlaps,[],`${name} toast obscures a surface button`);
  assert.ok(result.bodyOverflow <= 1,`${name} causes body horizontal overflow`);
  assert.ok(result.rootOverflow <= 1,`${name} causes document horizontal overflow`);
  assert.ok(result.surfaceOverflow <= 1,`${name} surface has horizontal overflow`);
  const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  fs.writeFileSync(
    path.join(screenshotRoot,`plugin-${name}-${theme}-1280x820.png`),
    image.toPNG(),
  );
  await setExactViewport(win,previousViewport[0],previousViewport[1]);
  if (restoreFocusSelector) {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(restoreFocusSelector)})?.focus()`,
      true,
    );
  }
}

async function assertSurfaceGeometry(win,selector,buttonSelectors = []) {
  // Hidden Electron windows do not advance every CSS animation, so finish
  // Radix transitions before measuring the stable overlay geometry.
  await settleAnimations(win);
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement) === true`,`${selector} initial safety-dialog focus`,2000);
  const result = await win.webContents.executeJavaScript(`(() => {
    const surface = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => (
      candidate instanceof HTMLElement && candidate.getClientRects().length > 0
    ));
    if (!(surface instanceof HTMLElement)) return null;
    const rect = surface.getBoundingClientRect();
    const computed = getComputedStyle(surface);
    const inside = (candidate) => candidate.left >= -1 && candidate.top >= -1
      && candidate.right <= window.innerWidth+1 && candidate.bottom <= window.innerHeight+1;
    const buttons = ${JSON.stringify(buttonSelectors)}.map((buttonSelector) => {
      const button = surface.querySelector(buttonSelector);
      if (!(button instanceof HTMLElement) || button.getClientRects().length === 0) return null;
      const buttonRect = button.getBoundingClientRect();
      return {
        inside:inside(buttonRect),width:buttonRect.width,height:buttonRect.height,
        left:buttonRect.left,top:buttonRect.top,right:buttonRect.right,bottom:buttonRect.bottom,
        centerY:buttonRect.top+buttonRect.height/2,
      };
    });
    return {
      viewport:[window.innerWidth,window.innerHeight],
      surfaceInside:inside(rect),
      surfaceRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
      surfaceStyle:{right:computed.right,transform:computed.transform,animation:computed.animationName,animationPlayState:computed.animationPlayState},
      horizontalOverflow:surface.scrollWidth-surface.clientWidth,
      pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      focusInside:surface.contains(document.activeElement),
      buttons,
    };
  })()`,true);
  assert.ok(result,`${selector} is not visible`);
  assert.deepEqual(result.viewport,[960,640]);
  if (!result.surfaceInside) geometryFailures.push(
    `${selector} exceeds viewport: ${JSON.stringify({rect:result.surfaceRect,style:result.surfaceStyle})}`,
  );
  if (result.pageOverflow > 1) geometryFailures.push(
    `${selector} causes page-level horizontal overflow: ${result.pageOverflow}px`,
  );
  assert.equal(result.focusInside,true,`${selector} does not own focus`);
  for (const [index,button] of result.buttons.entries()) {
    assert.ok(button,'expected overlay button is not visible');
    if (!button.inside) geometryFailures.push(
      `${selector} button ${buttonSelectors[index]} exceeds viewport: ${JSON.stringify(button)}`,
    );
    assert.ok(button.width >= 28 && button.height >= 24,'overlay button has invalid geometry');
  }
  if (result.buttons.length > 1) {
    const centers = result.buttons.map((button) => button.centerY);
    assert.ok(Math.max(...centers)-Math.min(...centers) <= 2,'overlay action buttons are not aligned');
  }
}

async function assertWorkspaceGeometry(win,width = 960,height = 640,settle = true) {
  if (settle) await settleAnimations(win);
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const panel = document.querySelector('#detail-panel');
    const viewport = surface?.querySelector('[data-slot="scroll-area-viewport"]');
    if (!(surface instanceof HTMLElement) || !(panel instanceof HTMLElement)
      || !(viewport instanceof HTMLElement)) return null;
    const rect = surface.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const inside = (candidate,container) => candidate.left >= container.left-1
      && candidate.top >= container.top-1 && candidate.right <= container.right+1
      && candidate.bottom <= container.bottom+1;
    const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
    const controls = ['plugin-save-disconnected','plugin-save-options','plugin-editor-cancel'].map((testId) => {
      const button = surface.querySelector('[data-testid="'+testId+'"]');
      if (!(button instanceof HTMLButtonElement) || !visible(button)) return null;
      const buttonRect = button.getBoundingClientRect();
      return {
        testId,
        inside:inside(buttonRect,rect),
        width:buttonRect.width,height:buttonRect.height,
        centerY:buttonRect.top+buttonRect.height/2,
        clipped:button.scrollWidth > button.clientWidth+1,
      };
    });
    const buttons = [...surface.querySelectorAll('button')].filter(visible);
    const form = surface.querySelector('#plugin-editor-form');
    return {
      viewport:[window.innerWidth,window.innerHeight],
      belongsToDetail:panel.contains(surface),
      insideDetail:inside(rect,panelRect),
      insideWindow:inside(rect,{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight}),
      modal:surface.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]') !== null,
      hidden:surface.closest('[aria-hidden="true"],[inert]') !== null,
      overlays:[...document.querySelectorAll('[data-slot="sheet-overlay"],[data-slot="dialog-overlay"]')].filter(visible).length,
      visibleMains:[...document.querySelectorAll('#detail-main')].filter(visible).length,
      visibleDetailTabs:[...document.querySelectorAll('[data-detail-tab]')].filter(visible).length,
      bodyPointerEvents:getComputedStyle(document.body).pointerEvents,
      formPresent:form instanceof HTMLFormElement,
      scrollAreaHeight:viewport.clientHeight,
      scrollAreaOverflow:viewport.scrollWidth-viewport.clientWidth,
      pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      surfaceOverflow:surface.scrollWidth-surface.clientWidth,
      buttonsOutsideHorizontalBounds:buttons.filter((button) => {
        const buttonRect = button.getBoundingClientRect();
        return buttonRect.left < rect.left-1 || buttonRect.right > rect.right+1;
      }).map((button) => button.dataset.testid ?? button.getAttribute('aria-label') ?? 'unlabelled-button'),
      controls,
    };
  })()`,true);
  assert.ok(geometry,'inline plugin editor must expose a scrollable form in the detail panel');
  assert.deepEqual(geometry.viewport,[width,height],'plugin workspace viewport');
  assert.equal(geometry.belongsToDetail,true,'plugin editor must be mounted inside the third panel');
  assert.equal(geometry.insideDetail,true,'plugin editor must remain inside its detail panel');
  assert.equal(geometry.insideWindow,true,'plugin editor must fit the window');
  assert.equal(geometry.modal,false,'plugin workspace must not use dialog or modal semantics');
  assert.equal(geometry.hidden,false,'plugin workspace must not be hidden or inert');
  assert.equal(geometry.overlays,0,'plugin workspace must not add a Sheet/Dialog overlay');
  assert.equal(geometry.visibleMains,1,'plugin workspace must preserve one visible skip-link main target');
  assert.equal(geometry.visibleDetailTabs,0,'plugin editor is a work mode, not a detail tab overlay');
  assert.notEqual(geometry.bodyPointerEvents,'none','inline editor must keep navigation interactive');
  assert.equal(geometry.formPresent,true);
  assert.ok(geometry.scrollAreaHeight >= 100,'plugin editor body must remain scrollable in a narrow pane');
  assert.ok(geometry.scrollAreaOverflow <= 1,'plugin editor body has horizontal overflow');
  assert.ok(geometry.pageOverflow <= 1,'plugin editor causes page-level horizontal overflow');
  assert.ok(geometry.surfaceOverflow <= 1,'plugin editor surface has horizontal overflow');
  assert.deepEqual(geometry.buttonsOutsideHorizontalBounds,[],'plugin editor buttons escape the detail pane');
  for (const control of geometry.controls) {
    assert.ok(control,'plugin workspace save/cancel controls must remain visible');
    assert.equal(control.inside,true,`${control.testId} must remain inside the workspace`);
    assert.equal(control.clipped,false,`${control.testId} label must not be clipped`);
    assert.ok(control.width >= 28 && control.height >= 28,`${control.testId} has invalid target geometry`);
  }
  assert.ok(Math.abs(geometry.controls[0].centerY-geometry.controls[1].centerY) <= 2,'plugin save split buttons must remain aligned');
}

async function assertWorkspaceKeyboardNavigation(win) {
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.contains(document.activeElement) === true`,'plugin workspace initial focus');
  await win.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const first = [...(workspace?.querySelectorAll('button,input,textarea,[tabindex]') ?? [])].find((element) => (
      element instanceof HTMLElement && element.getClientRects().length > 0
      && element.tabIndex >= 0 && !element.matches(':disabled')
    ));
    first?.focus();
  })()`,true);
  let reachedNavigation = false;
  for (let index = 0; index < 12; index += 1) {
    await pressTab(win,true);
    reachedNavigation = await win.webContents.executeJavaScript(
      `Boolean(document.activeElement?.closest('[data-testid="project-rail"],[data-testid="resource-pane"]'))`,
      true,
    );
    if (reachedNavigation) break;
  }
  assert.equal(reachedNavigation,true,'non-modal editor must allow keyboard navigation back to project/resource panes');
  await win.webContents.executeJavaScript(`document.querySelector('#plugin-host')?.focus()`,true);
  await waitFor(win,`document.activeElement?.id === 'plugin-host'`,'keyboard return to plugin editor');
}

async function capturePluginWorkspaceEvidence(win,name) {
  if (!screenshotRoot) return;
  await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'editor screenshot waits for the existing Sonner toast to disappear naturally',20000);
  fs.mkdirSync(screenshotRoot,{recursive:true});
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
    await setExactViewport(win,width,height);
    await win.webContents.executeJavaScript(`(() => {
      const viewport = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport instanceof HTMLElement) viewport.scrollTop = 0;
    })()`,true);
    const image = await captureFreshFrame(win);
    await assertWorkspaceGeometry(win,width,height,false);
    if (name === 'cancel-failure-retains-draft') await assertPluginEditorErrorVisible(win);
    fs.writeFileSync(path.join(screenshotRoot,`plugin-${name}-${theme}-${width}x${height}.png`),image.toPNG());
  }
  await setExactViewport(win,previousViewport[0],previousViewport[1]);
  await win.webContents.executeJavaScript(`document.querySelector('#plugin-host')?.focus()`,true);
}

async function assertPluginEditorErrorVisible(win) {
  const error = await win.webContents.executeJavaScript(`(() => {
    const error = document.querySelector('[data-testid="plugin-editor-error"]');
    const footer = document.querySelector('[data-testid="plugin-editor-footer"]');
    if (!(error instanceof HTMLElement) || error.getClientRects().length === 0) return null;
    const rect = error.getBoundingClientRect();
    return {
      footerOwned:footer?.contains(error) === true,
      readable:rect.width > 100 && rect.height > 20,
      viewport:[window.innerWidth,window.innerHeight],
      rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},
      inside:rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth+1 && rect.bottom <= window.innerHeight+1,
    };
  })()`,true);
  assert.ok(error,'failed plugin cancellation must keep a visible inline error in the fixed editor footer');
  assert.equal(error.footerOwned,true,'plugin editor errors must not be buried at the end of the scrollable form');
  assert.equal(error.readable,true,'plugin editor footer error must retain a readable visible area');
  assert.equal(error.inside,true,`plugin cancellation error must be inside the current viewport: ${JSON.stringify(error)}`);
}

async function assertFocusLoop(win,selector) {
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement) === true`,`${selector} initial trapped focus`,2000);
  const sequence = [];
  for (const shift of [...Array(24).fill(false),...Array(8).fill(true)]) {
    await pressTab(win,shift);
    sequence.push(await win.webContents.executeJavaScript(`(() => ({
      inside:document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement) === true,
      tag:document.activeElement?.tagName ?? null,
      id:document.activeElement?.id ?? null,
      testId:document.activeElement?.getAttribute?.('data-testid') ?? null,
      text:document.activeElement?.textContent?.replace(/\\s+/gu,' ').trim().slice(0,40) ?? null,
    }))()`,true));
  }
  const focus = await win.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector(${JSON.stringify(selector)});
    return {
      inside:surface instanceof HTMLElement && surface.contains(document.activeElement),
      tag:document.activeElement?.tagName ?? null,
      id:document.activeElement?.id ?? null,
      testId:document.activeElement?.getAttribute?.('data-testid') ?? null,
      text:document.activeElement?.textContent?.replace(/\\s+/gu,' ').trim().slice(0,80) ?? null,
      surfaceState:surface?.getAttribute?.('data-state') ?? null,
      surfaceVisible:surface?.getClientRects?.().length > 0,
      sequence:${JSON.stringify(sequence)},
    };
  })()`,true);
  if (!focus.inside || sequence.some((step) => !step.inside)) {
    const message = `${selector} failed to retain keyboard focus: ${JSON.stringify(focus)}`;
    focusFailures.push(message);
    assert.fail(message);
  }
}

function calls(channel) {
  return mutationCalls.filter((entry) => entry.channel === channel);
}

async function waitForCall(channel,index = 0) {
  await waitUntil(() => calls(channel)[index] !== undefined,`${channel} call ${index+1}`);
  return calls(channel)[index];
}

function exactKeys(value,keys,label) {
  assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),`${label} has unexpected fields`);
}

function assertRuntimeHostKeyPayload(payload,challenge) {
  exactKeys(payload,['challengeId','planId','operationId','expectedRevision','decision'],'runtime host-key confirmation');
  assert.deepEqual(payload,{
    challengeId:challenge.challengeId,
    planId:challenge.planId,
    operationId:challenge.operationId,
    expectedRevision:challenge.expectedRevision,
    decision:'trust-host-key',
  },'runtime host-key confirmation must bind the exact challenge, plan, operation and revision');
  assertNoSensitivePayload(payload,'runtime host-key confirmation');
}

function assertNoSensitivePayload(value,label) {
  const forbidden = /^(?:password|privateKeyPassphrase|proxyPassword|secrets?|temporarySecrets|secretsByPlugin|token|credential)$/iu;
  const visit = (candidate,pathParts) => {
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key,nested] of Object.entries(candidate)) {
      assert.equal(forbidden.test(key),false,`${label} contains sensitive field ${[...pathParts,key].join('.')}`);
      visit(nested,[...pathParts,key]);
    }
  };
  visit(value,[]);
}

async function chooseSelectOption(win,triggerSelector,optionText) {
  await openPopup(win,triggerSelector,`${optionText} select`);
  await waitFor(win,`[...document.querySelectorAll('[role="option"]')].some((item) => item.textContent?.trim() === ${JSON.stringify(optionText)})`,`${optionText} option`);
  await clickText(win,optionText,'body','[role="option"]');
}

async function assertResourceAccordionBounds(win,label) {
  const pluginIds = state.plugins.map((plugin) => plugin.pluginInstanceId);
  await waitFor(win,`(() => {
    const content = document.querySelector('[data-testid="environment-row-${ENVIRONMENT_ID}"] [data-slot="accordion-content"]');
    return content?.getAttribute('data-state') === 'open'
      && ${JSON.stringify(pluginIds)}.every((id) => content.querySelector('[data-testid="plugin-row-'+id+'"]'))
      && content.querySelector('[data-testid="add-plugin-${ENVIRONMENT_ID}"]') !== null;
  })()`,`${label}: all exact plugin rows and add action are mounted in the expanded environment`);
  await settleAnimations(win);
  const bounds = await win.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('[data-testid="environment-row-${ENVIRONMENT_ID}"] [data-slot="accordion-content"]');
    const rect = content.getBoundingClientRect();
    const selectors = [
      ...${JSON.stringify(pluginIds)}.map((id) => '[data-testid="plugin-row-'+id+'"]'),
      '[data-testid="add-plugin-${ENVIRONMENT_ID}"]',
    ];
    return {
      content:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,height:rect.height},
      rows:selectors.map((selector) => {
        const element = content.querySelector(selector);
        const bounds = element.getBoundingClientRect();
        return {
          testId:element.getAttribute('data-testid'),
          top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right,
          unclipped:bounds.height > 0 && bounds.top >= rect.top-1 && bounds.bottom <= rect.bottom+1
            && bounds.left >= rect.left-1 && bounds.right <= rect.right+1,
        };
      }),
    };
  })()`,true);
  assert.equal(bounds.rows.length,pluginIds.length+1,'expanded accordion must contain every scoped plugin plus the add action');
  assert.equal(bounds.rows.every((row) => row.unclipped),true,`${label}: dynamic plugin rows must not be clipped by a stale accordion-content height: ${JSON.stringify(bounds)}`);
}

async function openPluginEditor(win,pluginName,evidenceName = null,{expectImpact = false,returnTab = null} = {}) {
  currentStep = `open-editor:${evidenceName ?? (expectImpact ? 'impact' : 'navigation')}`;
  const projectSelected = await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="${PROJECT_ID}"]')?.getAttribute('aria-current') === 'page'`,true);
  if (!projectSelected) {
    await click(win,`[data-project-id="${PROJECT_ID}"]`,'original plugin project');
    await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]') !== null`,'original project plugin list');
  }
  const pluginVisible = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getClientRects().length > 0`,true);
  if (!pluginVisible) {
    await click(win,`[data-testid="environment-trigger-${ENVIRONMENT_ID}"]`,'expand the original plugin environment');
    await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getClientRects().length > 0`,'original server plugin visible');
  }
  await click(win,`[data-testid="plugin-trigger-${SERVER_ID}"]`,pluginName);
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,'server plugin selection');
  await assertResourceAccordionBounds(win,'entering the existing plugin editor');
  await activateTab(win,returnTab ?? 'overview');
  await waitFor(win,`document.querySelector('[data-testid="plugin-action-edit"]')?.disabled === false`,'plugin details edit action');
  await openPopup(win,'[data-testid="plugin-action-edit"]','edit configuration directly from plugin details');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null`,'plugin editor workspace');
  if (expectImpact) {
    await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,'plugin edit-impact confirmation');
    return;
  }
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-loading"]') === null`,'plugin edit session');
  await assertWorkspaceGeometry(win);
  await assertWorkspaceKeyboardNavigation(win);
  if (evidenceName) await capturePluginWorkspaceEvidence(win,evidenceName);
}

async function createRedisPlugin(win,{name,host,strategy}) {
  currentStep = `create-plugin:${strategy}`;
  const callIndex = calls('v2:plugin-create').length;
  await click(win,`[data-testid="add-plugin-${ENVIRONMENT_ID}"]`,'add plugin');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null`,'new plugin workspace');
  await chooseSelectOption(win,'[aria-label="插件类型"]','Redis');
  await fill(win,'#plugin-display-name',name);
  await fill(win,'#plugin-host',host);
  await assertWorkspaceGeometry(win);
  await assertWorkspaceKeyboardNavigation(win);
  await capturePluginWorkspaceEvidence(win,`new-plugin-${strategy}`);
  if (strategy === 'connect-current') {
    if (screenshotRoot) {
      await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'save-menu toast clearance');
    }
    if (screenshotRoot) await setExactViewport(win,1280,820);
    await openPopup(win,'[data-testid="plugin-save-options"]','plugin save options');
    await waitFor(win,`document.querySelector('[data-testid="plugin-save-and-connect"]') !== null`,'save and connect option');
    await captureSurfaceEvidence(win,{
      name:'new-plugin-save-menu',
      selector:'[role="menu"][data-state="open"]',
      restoreFocusSelector:'[data-testid="plugin-save-and-connect"]',
    });
    await click(win,'[data-testid="plugin-save-and-connect"]','save and connect');
  } else {
    await click(win,'[data-testid="plugin-save-disconnected"]','save disconnected');
  }
  const createCall = await waitForCall('v2:plugin-create',callIndex);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'new plugin workspace close');
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${createCall.payload.input.pluginInstanceId}"]')?.getAttribute('aria-current') === 'page'`,'new plugin save selects the exact created plugin');
  await assertResourceAccordionBounds(win,'after dynamically adding a Redis plugin');
  if (screenshotRoot && strategy === 'connect-current') await setExactViewport(win,960,640);
  return createCall;
}

async function saveExistingPlugin(win,strategy,index) {
  currentStep = `save-existing-plugin:${strategy}`;
  await openPluginEditor(win,'阶段五连接服务器',`existing-plugin-editor-${index+1}`);
  if (strategy === 'stay-disconnected') {
    await click(win,'[data-testid="plugin-save-disconnected"]','save disconnected');
  } else {
    if (screenshotRoot) {
      await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'edit-save-menu toast clearance');
    }
    if (screenshotRoot) await setExactViewport(win,1280,820);
    await openPopup(win,'[data-testid="plugin-save-options"]','plugin save options');
    const selector = strategy === 'connect-current'
      ? '[data-testid="plugin-save-and-connect"]'
      : '[data-testid="plugin-save-and-restore"]';
    await waitFor(win,`document.querySelector(${JSON.stringify(selector)}) !== null`,`${strategy} option`);
    await captureSurfaceEvidence(win,{
      name:`existing-plugin-save-menu-${strategy}`,
      selector:'[role="menu"][data-state="open"]',
      restoreFocusSelector:selector,
    });
    await click(win,selector,strategy);
  }
  const saveCall = await waitForCall('v2:plugin-connection-edit-save',index);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'plugin editor close');
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,'plugin save returns to the exact edited plugin');
  if (screenshotRoot && strategy !== 'stay-disconnected') await setExactViewport(win,960,640);
  return saveCall;
}

function assertEditSavePayload(call,expectedStrategy,expectedRevision,index) {
  const payload = call.payload;
  exactKeys(payload,['editSessionId','patch','expectedRevision','afterCommit','credentialIntent','discardTemporarySecrets'],`edit save ${index}`);
  assert.equal(payload.editSessionId,`edit-session-${index}`);
  assert.equal(payload.expectedRevision,expectedRevision);
  assert.equal(payload.afterCommit,expectedStrategy);
  assert.equal(payload.credentialIntent,'unchanged');
  assert.equal(payload.discardTemporarySecrets,true,'each edit submits only its current credential input');
  assert.deepEqual(payload.patch,{
    target:{host:'server.smoke.invalid',port:22,addressFamily:'ipv4Preferred'},
    auth:{username:'operator',type:'agent'},
    uplink:{type:'direct'},
  });
  assertNoSensitivePayload(payload,`edit save ${index}`);
}

function assertConnectionPayloads() {
  const connectionCalls = calls('v2:connection-intent').filter((entry) => entry.payload.source === 'renderer-plugin');
  assert.equal(connectionCalls.length,5);
  const [challengeConnect,connectedConnect,disconnect,pendingConnect,cancel] = connectionCalls.map((entry) => entry.payload);
  for (const [index,payload] of [challengeConnect,connectedConnect,pendingConnect].entries()) {
    exactKeys(payload,[
      'projectId','environmentId','pluginInstanceId','intent','requestId','source','planId',
    ],`plugin connect ${index+1}`);
    assert.equal(payload.projectId,PROJECT_ID);
    assert.equal(payload.environmentId,ENVIRONMENT_ID);
    assert.equal(payload.pluginInstanceId,SERVER_ID);
    assert.equal(payload.intent,'connect');
    assert.equal(payload.source,'renderer-plugin');
    assert.match(payload.requestId,/^plugin-connection-/u);
    assert.match(payload.planId,/^plugin-plan-/u);
    assertNoSensitivePayload(payload,`plugin connect ${index+1}`);
  }
  exactKeys(disconnect,[
    'projectId','environmentId','pluginInstanceId','intent','requestId','source',
  ],'plugin disconnect');
  assert.deepEqual({
    projectId:disconnect.projectId,
    environmentId:disconnect.environmentId,
    pluginInstanceId:disconnect.pluginInstanceId,
    intent:disconnect.intent,
    source:disconnect.source,
  },{
    projectId:PROJECT_ID,
    environmentId:ENVIRONMENT_ID,
    pluginInstanceId:SERVER_ID,
    intent:'disconnect',
    source:'renderer-plugin',
  });
  assert.match(disconnect.requestId,/^plugin-connection-/u);
  exactKeys(cancel,[
    'projectId','environmentId','pluginInstanceId','intent','requestId','source','planId',
  ],'plugin cancel');
  assert.equal(cancel.projectId,PROJECT_ID);
  assert.equal(cancel.environmentId,ENVIRONMENT_ID);
  assert.equal(cancel.pluginInstanceId,SERVER_ID);
  assert.equal(cancel.intent,'cancel');
  assert.equal(cancel.source,'renderer-plugin');
  assert.match(cancel.requestId,/^plugin-cancel-/u);
  assert.equal(cancel.planId,pendingConnect.planId);
  assertNoSensitivePayload(disconnect,'plugin disconnect');
  assertNoSensitivePayload(cancel,'plugin cancel');
}

async function openScopedEditSession(win,options = {}) {
  const prepareIndex = calls('v2:plugin-connection-edit-prepare').length;
  const beginIndex = calls('v2:plugin-connection-edit-begin').length;
  const expectedRevision = findPlugin(SERVER_ID).revision;
  const editSessionId = `edit-session-${state.nextSessionNumber}`;
  await openPluginEditor(win,'阶段五连接服务器',null,options);
  assert.equal(calls('v2:plugin-connection-edit-prepare').length,prepareIndex+1,'opening a workspace must prepare exactly once');
  assert.equal(calls('v2:plugin-connection-edit-begin').length,beginIndex+1,'opening a workspace must begin exactly once');
  assert.deepEqual(calls('v2:plugin-connection-edit-prepare')[prepareIndex].payload,{
    projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:SERVER_ID,expectedRevision,
  },'editor preparation must preserve exact scope and revision');
  assert.deepEqual(state.sessions.get(editSessionId),{
    projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:SERVER_ID,expectedRevision,
  },'editor session must belong only to the prepared plugin');
  return editSessionId;
}

function assertEditCancellation(call,editSessionId) {
  exactKeys(call.payload,['editSessionId','restorePreEditConnections'],'plugin edit cancellation');
  assert.deepEqual(call.payload,{editSessionId,restorePreEditConnections:true},'leaving must restore the exact edit session');
}

async function assertEditorRetainsScope(win,{host,editSessionId}) {
  const retained = await win.webContents.executeJavaScript(`(() => ({
    workspace:document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null,
    project:document.querySelector('[data-project-id="${PROJECT_ID}"]')?.getAttribute('aria-current'),
    plugin:document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current'),
    host:document.querySelector('#plugin-host')?.value,
  }))()`,true);
  assert.deepEqual(retained,{workspace:true,project:'page',plugin:'page',host},'blocked navigation must retain the editor, exact scope and draft');
  assert.equal(state.sessions.has(editSessionId),true,'blocked navigation must retain the active edit session');
}

async function waitForEditorClosed(win,label) {
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,label);
  await waitFor(win,`(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body
      && active !== document.documentElement && active.getClientRects().length > 0
      && !active.closest('[aria-hidden="true"],[inert]');
  })()`,`${label} restores a visible focus target`);
}

async function assertPluginWorkspaceNavigation(win,otherPluginId) {
  currentStep = 'workspace-navigation';
  // Keep these sessions after the original three save-strategy assertions so
  // their precise session ids, revisions and payload expectations stay intact.
  const initialSaveCount = calls('v2:plugin-connection-edit-save').length;
  const initialCreateCount = calls('v2:plugin-create').length;
  const initialConnectionCount = calls('v2:connection-intent').length;
  const originalHost = findPlugin(SERVER_ID).target.host;
  const originalRevision = findPlugin(SERVER_ID).revision;

  state.truncatePluginPreview = true;
  const boundedRefreshCount = readCalls.filter((entry) => entry.channel === 'v2:workspace-overview').length;
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await waitUntil(() => readCalls.filter((entry) => entry.channel === 'v2:workspace-overview').length > boundedRefreshCount,'bounded overview refresh before plugin cancellation');
  assert.equal(environmentOverview().resourcePreview.some((plugin) => plugin.pluginInstanceId === SERVER_ID),false,'bounded overview must exclude the edited plugin');
  assert.equal(findPlugin(SERVER_ID)?.pluginInstanceId,SERVER_ID,'complete scoped list must still contain the edited plugin');
  const cleanSession = await openScopedEditSession(win,{returnTab:'overview'});
  const cleanCancelIndex = calls('v2:plugin-connection-edit-cancel').length;
  for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
    await setExactViewport(win,width,height);
    await assertWorkspaceGeometry(win,width,height);
  }
  await setExactViewport(win,960,640);
  await click(win,'[data-testid="plugin-editor-cancel"]','return from unchanged plugin workspace');
  await waitForEditorClosed(win,'clean plugin workspace return');
  assertEditCancellation(await waitForCall('v2:plugin-connection-edit-cancel',cleanCancelIndex),cleanSession);
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,cleanCancelIndex+1,'clean return must cancel one exact session');
  assert.equal(state.sessions.has(cleanSession),false);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,true),true,'clean return must preserve plugin selection');
  await waitFor(win,`document.querySelector('[data-detail-tab="overview"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('[data-testid="plugin-connection-panel"]') !== null`,'cancelling outside the bounded preview restores the exact original plugin and tab');
  await waitFor(win,`document.activeElement === document.querySelector('[data-testid="plugin-action-edit"]')`,'cancelling outside the bounded preview restores the original edit trigger');
  state.truncatePluginPreview = false;
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});

  const dirtySession = await openScopedEditSession(win);
  const dirtyHost = 'unsaved-navigation.smoke.invalid';
  const dirtyCancelIndex = calls('v2:plugin-connection-edit-cancel').length;
  await fill(win,'#plugin-host',dirtyHost);
  const dirtyPreparationCount = calls('v2:plugin-connection-edit-prepare').length;
  const dirtyBeginCount = calls('v2:plugin-connection-edit-begin').length;
  const pluginRefreshCount = readCalls.filter((entry) => entry.channel === 'v2:plugin-list').length;
  win.webContents.send('v2:workspace-changed',{
    projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:SERVER_ID,
  });
  await waitUntil(() => readCalls.filter((entry) => entry.channel === 'v2:plugin-list').length > pluginRefreshCount,'background plugin list refresh while editing');
  await wait(100);
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  assert.equal(calls('v2:plugin-connection-edit-prepare').length,dirtyPreparationCount,'background refresh must not restart edit preparation');
  assert.equal(calls('v2:plugin-connection-edit-begin').length,dirtyBeginCount,'background refresh must not restart the edit session');
  await click(win,'[data-testid="detail-collapse"]','collapse editor without leaving');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.hidden === true`,'editor hidden but still mounted');
  assert.equal(state.sessions.has(dirtySession),true,'collapsing must not end the editor session');
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,dirtyCancelIndex,'collapsing must not cancel the editor');
  await click(win,'[data-testid="detail-expand"]','restore plugin editor');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.hidden === false`,'editor visible after expanding');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  await assertWorkspaceGeometry(win);
  await openPopup(win,'[data-testid="plugin-save-options"]','dirty editor save menu');
  await waitFor(win,`document.querySelector('[data-testid="plugin-save-and-connect"]') !== null`,'dirty editor save menu opened');
  await pressEscape(win);
  await waitFor(win,`document.querySelector('[data-testid="plugin-save-and-connect"]') === null`,'Escape closes only the save menu');
  await waitFor(win,`document.activeElement?.getAttribute('data-testid') === 'plugin-save-options'`,'save menu Escape restores its trigger');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  await clickNavigation(win,`[data-testid="plugin-trigger-${otherPluginId}"]`,'navigate to another plugin with an unsaved draft');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'dirty plugin navigation confirmation');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,dirtyCancelIndex,'navigation must not cancel before discard approval');
  await assertFocusLoop(win,DISCARD_SELECTOR);
  await pressEscape(win);
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) === null`,'Escape dismisses only the dirty confirmation');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,dirtyCancelIndex,'Escape must not cancel or leave the edit session');
  await waitFor(win,`document.activeElement?.getAttribute('data-testid') === 'plugin-save-options'`,'Escape from dirty confirmation restores editor focus');
  await clickNavigation(win,`[data-testid="plugin-trigger-${otherPluginId}"]`,'repeat unsaved plugin navigation after Escape');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'dirty confirmation reopened after Escape');
  await clickText(win,'继续编辑',DISCARD_SELECTOR);
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) === null`,'continue editing dirty plugin');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  await waitFor(win,`document.activeElement?.getAttribute('data-testid') === 'plugin-save-options'`,'continue editing restores editor focus');

  state.deferNextEditCancel = true;
  await viewEnvironmentDetails(win,'navigate to the environment from the dirty editor');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'environment dirty-leave confirmation');
  await clickText(win,'放弃更改',DISCARD_SELECTOR);
  await waitUntil(() => state.pendingEditCancel !== null,'pending session cancellation before environment navigation');
  await assertEditorRetainsScope(win,{host:dirtyHost,editSessionId:dirtySession});
  assertEditCancellation(calls('v2:plugin-connection-edit-cancel')[dirtyCancelIndex],dirtySession);
  state.pendingEditCancel.resolve();
  state.pendingEditCancel = null;
  await waitForEditorClosed(win,'approved environment navigation');
  await waitFor(win,`document.querySelector('#detail-main')?.getAttribute('data-selection-kind') === 'environment'`,'environment scope after successful session cancellation');
  assert.equal(state.sessions.has(dirtySession),false);

  const failedSession = await openScopedEditSession(win);
  const failedHost = 'retry-cancel.smoke.invalid';
  const failedCancelIndex = calls('v2:plugin-connection-edit-cancel').length;
  await fill(win,'#plugin-host',failedHost);
  state.cancelFailuresRemaining = 1;
  await clickNavigation(win,`[data-project-id="${NAVIGATION_PROJECT_ID}"]`,'navigate across projects with an unsaved draft');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'cross-project dirty-leave confirmation');
  await clickText(win,'放弃更改',DISCARD_SELECTOR);
  await waitForCall('v2:plugin-connection-edit-cancel',failedCancelIndex);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('无法安全结束编辑会话') === true`,'cancel failure remains visible in the editor');
  await assertPluginEditorErrorVisible(win);
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) === null`,'failed cancellation returns to the unchanged editor');
  await assertEditorRetainsScope(win,{host:failedHost,editSessionId:failedSession});
  assertEditCancellation(calls('v2:plugin-connection-edit-cancel')[failedCancelIndex],failedSession);
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,failedCancelIndex+1,'failed cancellation must not trigger an unmount cleanup retry');
  assert.equal(findPlugin(SERVER_ID).target.host,originalHost,'discard failure must not persist the edited host');
  assert.equal(findPlugin(SERVER_ID).revision,originalRevision,'discard failure must not change the stored revision');
  await capturePluginWorkspaceEvidence(win,'cancel-failure-retains-draft');

  state.deferNextEditCancel = true;
  await clickNavigation(win,`[data-project-id="${NAVIGATION_PROJECT_ID}"]`,'retry cross-project navigation');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'retry discard confirmation');
  await clickText(win,'放弃更改',DISCARD_SELECTOR);
  await waitUntil(() => state.pendingEditCancel !== null,'pending retried session cancellation');
  await assertEditorRetainsScope(win,{host:failedHost,editSessionId:failedSession});
  assertEditCancellation(calls('v2:plugin-connection-edit-cancel')[failedCancelIndex+1],failedSession);
  state.pendingEditCancel.resolve();
  state.pendingEditCancel = null;
  await waitForEditorClosed(win,'successful cross-project cancellation retry');
  await waitFor(win,`document.querySelector('[data-project-id="${NAVIGATION_PROJECT_ID}"]')?.getAttribute('aria-current') === 'page'`,'target project selected only after cancellation succeeded');
  assert.equal(state.sessions.has(failedSession),false);
  assert.equal(calls('v2:plugin-connection-edit-save').length,initialSaveCount,'navigation must not silently save a draft');
  assert.equal(calls('v2:plugin-create').length,initialCreateCount,'navigation must not create a plugin');

  const savingSession = await openScopedEditSession(win);
  const savingCancelIndex = calls('v2:plugin-connection-edit-cancel').length;
  const savingRevision = findPlugin(SERVER_ID).revision;
  state.deferNextEditSave = true;
  await click(win,'[data-testid="plugin-save-disconnected"]','save with a pending commit');
  await waitUntil(() => state.pendingEditSave !== null,'pending plugin save');
  await clickNavigation(win,`[data-project-id="${NAVIGATION_PROJECT_ID}"]`,'attempt project navigation while saving');
  await assertEditorRetainsScope(win,{host:originalHost,editSessionId:savingSession});
  const busyState = await win.webContents.executeJavaScript(`(() => ({
    busy:document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.getAttribute('aria-busy'),
    discard:document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null,
    cancelDisabled:document.querySelector('[data-testid="plugin-editor-cancel"]')?.disabled,
  }))()`,true);
  assert.deepEqual(busyState,{busy:'true',discard:false,cancelDisabled:true},'saving must block leave instead of queuing a dirty prompt');
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,savingCancelIndex,'saving must not cancel the in-flight edit session');
  assertEditSavePayload(calls('v2:plugin-connection-edit-save')[initialSaveCount],'stay-disconnected',savingRevision,Number(savingSession.split('-').at(-1)));
  state.pendingEditSave.resolve();
  state.pendingEditSave = null;
  await waitForEditorClosed(win,'completed pending plugin save');
  await waitFor(win,`document.querySelector('[data-project-id="${PROJECT_ID}"]')?.getAttribute('aria-current') === 'page' && document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,'save returns to the exact plugin instead of executing blocked navigation');
  assert.equal(state.sessions.has(savingSession),false);

  const impactPrepareIndex = calls('v2:plugin-connection-edit-prepare').length;
  const impactBeginIndex = calls('v2:plugin-connection-edit-begin').length;
  const impactCancelIndex = calls('v2:plugin-connection-edit-cancel').length;
  const impactToken = `prepare-${state.nextPreparationNumber}`;
  state.nextEditNeedsImpact = true;
  await openPluginEditor(win,'阶段五连接服务器',null,{expectImpact:true});
  assert.equal(calls('v2:plugin-connection-edit-prepare').length,impactPrepareIndex+1);
  assert.equal(calls('v2:plugin-connection-edit-begin').length,impactBeginIndex,'edit impact must require an explicit decision before beginning');
  await assertFocusLoop(win,'[data-testid="plugin-editor-confirmation"]');
  state.cancelFailuresRemaining = 1;
  await clickText(win,'取消','[data-testid="plugin-editor-confirmation"]');
  await waitForCall('v2:plugin-connection-edit-cancel',impactCancelIndex);
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]')?.textContent?.includes('无法安全取消编辑准备') === true`,'edit impact rejection failure is visible inside the safety confirmation');
  assert.deepEqual(calls('v2:plugin-connection-edit-cancel')[impactCancelIndex].payload,{prepareToken:impactToken},'impact rejection must cancel the exact preparation');
  assert.equal(state.preparations.has(impactToken),true,'failed impact rejection must retain the preparation token for retry');
  assert.equal(calls('v2:plugin-connection-edit-begin').length,impactBeginIndex,'failed rejection must not begin editing');
  await clickText(win,'取消','[data-testid="plugin-editor-confirmation"]');
  await waitForEditorClosed(win,'edit impact rejection retry');
  assert.deepEqual(calls('v2:plugin-connection-edit-cancel')[impactCancelIndex+1].payload,{prepareToken:impactToken},'impact retry must reuse the same preparation');
  assert.equal(state.preparations.has(impactToken),false);
  assert.equal(state.sessions.size,0,'all plugin edit sessions must be saved or safely cancelled');
  assert.equal(state.preparations.size,0,'all plugin edit preparations must be consumed or safely cancelled');
  assert.equal(calls('v2:connection-intent').length,initialConnectionCount,'workspace navigation must not initiate a connection');
}

async function selectRuntimeHostKeyEntry(win,entry) {
  if (entry.kind === 'environment') {
    const selected = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="environment-trigger-${ENVIRONMENT_ID}"]')?.getAttribute('aria-current') === 'page'`,true);
    if (!selected) await viewEnvironmentDetails(win,'select the exact environment for host-key verification');
    await waitFor(win,`document.querySelector('#detail-main')?.getAttribute('data-selection-kind') === 'environment'`,'environment selection for host-key verification');
  } else {
    const pluginVisible = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getClientRects().length > 0`,true);
    if (!pluginVisible) {
      await clickNavigation(win,`[data-testid="environment-trigger-${ENVIRONMENT_ID}"]`,'expand the exact environment for host-key verification');
      await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getClientRects().length > 0`,'host-key plugin row visible');
    }
    await clickNavigation(win,`[data-testid="plugin-trigger-${SERVER_ID}"]`,'select the exact plugin for host-key verification');
    await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,'plugin selection for host-key verification');
  }
  if (entry.panel) await activateTab(win,'overview');
  await waitFor(win,`(() => {
    const trigger = document.querySelector(${JSON.stringify(entry.trigger)});
    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || trigger.getClientRects().length === 0) return false;
    const intent = trigger.getAttribute('data-connection-intent');
    return intent ? ['connect','retry'].includes(intent) : /^(连接|连接全部|重试|重试连接)$/u.test(trigger.textContent?.trim() ?? '');
  })()`,`${entry.name} connection trigger ready`);
}

async function openRuntimeHostKeyChallenge(win,entry) {
  const requestIndex = calls('v2:connection-intent').length;
  const challengeId = `runtime-host-key-challenge-${state.nextRuntimeChallenge}`;
  await openPopup(win,entry.trigger,`${entry.name} explicit connection trigger`);
  const request = (await waitForCall('v2:connection-intent',requestIndex)).payload;
  exactKeys(request,[
    'projectId','environmentId',...(entry.kind === 'plugin' ? ['pluginInstanceId'] : ['expectedRevision']),
    'intent','requestId','source','planId',
  ],`${entry.name} connection intent`);
  assert.equal(request.projectId,PROJECT_ID);
  assert.equal(request.environmentId,ENVIRONMENT_ID);
  assert.equal(request.source,entry.kind === 'plugin' ? 'renderer-plugin' : 'renderer-environment');
  if (entry.kind === 'plugin') assert.equal(request.pluginInstanceId,SERVER_ID);
  else assert.equal(request.expectedRevision,state.environmentRevision);
  assert.match(request.requestId,new RegExp(`^${entry.kind}-connection-`,'u'));
  assert.match(request.planId,new RegExp(`^${entry.kind}-plan-`,'u'));
  const challenge = state.runtimeChallenges.get(challengeId);
  assert.ok(challenge,`${entry.name} must open a fresh challenge`);
  assert.equal(challenge.planId,request.planId,'a new challenge must belong to its own scoped request');
  await waitFor(win,`document.querySelector(${JSON.stringify(entry.dialog)}) !== null`,`${entry.name} host-key dialog`);
  const visible = await win.webContents.executeJavaScript(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((node) => node.getAttribute('data-state') !== 'closed' && node.getClientRects().length > 0);
    const surface = document.querySelector(${JSON.stringify(entry.dialog)});
    return {
      count:dialogs.length,
      exactChallenge:surface?.textContent?.includes(${JSON.stringify(challenge.fingerprint)}) === true,
      exactHost:surface?.textContent?.includes(${JSON.stringify(challenge.host)}) === true,
      previousError:surface?.querySelector('[role="alert"]') !== null,
    };
  })()`,true);
  assert.deepEqual(visible,{count:1,exactChallenge:true,exactHost:true,previousError:false},'a new host-key challenge must not inherit a previous scope, challenge or error');
  assert.equal(calls('v2:connection-intent').length,requestIndex+1,'opening a host-key prompt must issue one explicit scoped intent');
  return challenge;
}

async function assertRuntimeHostKeyClosed(win,entry,label) {
  await waitFor(win,`document.querySelector(${JSON.stringify(entry.dialog)}) === null`,`${label} closes its host-key dialog`);
  await waitFor(win,`document.activeElement === document.querySelector(${JSON.stringify(entry.trigger)})`,`${label} restores the exact connection trigger`);
}

async function assertRuntimeHostKeyGovernance(win) {
  const initialMutationCount = mutationCalls.length;
  const initialConfirmCount = calls('v2:connection-challenge-confirm').length;
  const initialIntentCount = calls('v2:connection-intent').length;
  state.runtimeHostKeyMode = true;
  setServerPhase('disconnected');
  win.webContents.send('v2:environment-status-changed',clone(state.runtime));
  const overviewCount = readCalls.filter((entry) => entry.channel === 'v2:workspace-overview').length;
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await waitUntil(() => readCalls.filter((entry) => entry.channel === 'v2:workspace-overview').length > overviewCount,'host-key governance disconnected runtime refresh');
  await setExactViewport(win,1280,820);

  const entries = [
    {name:'plugin-panel',kind:'plugin',panel:true,trigger:'[data-testid="plugin-connection-primary"]',dialog:'[data-testid="runtime-host-key-confirmation"]'},
    {name:'environment-panel',kind:'environment',panel:true,trigger:'[data-testid="environment-connection-primary"]',dialog:'[data-testid="environment-host-key-confirmation"]'},
    {name:'environment-row',kind:'environment',panel:false,trigger:`[data-testid="environment-connection-${ENVIRONMENT_ID}"]`,dialog:'[data-testid="resource-host-key-confirmation"]'},
    {name:'plugin-row',kind:'plugin',panel:false,trigger:`[data-testid="plugin-connection-${SERVER_ID}"]`,dialog:'[data-testid="resource-host-key-confirmation"]'},
  ];
  for (const entry of entries) {
    currentStep = `host-key:${entry.name}:escape-reject`;
    await selectRuntimeHostKeyEntry(win,entry);
    const confirmIndex = calls('v2:connection-challenge-confirm').length;
    const escaped = await openRuntimeHostKeyChallenge(win,entry);
    await pressEscape(win);
    await assertRuntimeHostKeyClosed(win,entry,`${entry.name} Escape`);
    assert.equal(calls('v2:connection-challenge-confirm').length,confirmIndex,'Escape must never confirm or continue a runtime host-key challenge');

    const rejected = await openRuntimeHostKeyChallenge(win,entry);
    assert.notEqual(rejected.challengeId,escaped.challengeId,'reopening after Escape creates a new scoped challenge');
    await clickText(win,'不信任',entry.dialog);
    await assertRuntimeHostKeyClosed(win,entry,`${entry.name} rejection`);
    assert.equal(calls('v2:connection-challenge-confirm').length,confirmIndex,'Not trust must never confirm or continue a runtime host-key challenge');

    const trusted = await openRuntimeHostKeyChallenge(win,entry);
    currentStep = `host-key:${entry.name}:trust-busy`;
    assert.notEqual(trusted.challengeId,rejected.challengeId,'explicit retry must not reuse a previously rejected challenge');
    state.runtimeConfirmFailuresRemaining = 1;
    state.deferNextRuntimeConfirm = true;
    const doubleClicked = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector(${JSON.stringify(`${entry.dialog} [data-slot="alert-dialog-action"]`)});
      if (!(button instanceof HTMLButtonElement)) return false;
      button.focus();
      button.click();
      button.click();
      return true;
    })()`,true);
    assert.equal(doubleClicked,true,'runtime trust action must be available for duplicate-activation verification');
    await waitUntil(() => state.pendingRuntimeConfirm !== null,`${entry.name} delayed trust confirmation`);
    await pressEscape(win);
    assert.equal(calls('v2:connection-challenge-confirm').length,confirmIndex+1,'double-click plus Escape during trust must send exactly one confirmation');
    assertRuntimeHostKeyPayload(calls('v2:connection-challenge-confirm')[confirmIndex].payload,trusted);
    const pendingDialog = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector(${JSON.stringify(entry.dialog)});
      return {
        present:Boolean(dialog),
        busy:dialog?.getAttribute('aria-busy') === 'true',
        disabled:dialog ? [...dialog.querySelectorAll('button')].every((button) => button.disabled) : false,
        focused:dialog?.contains(document.activeElement) === true,
      };
    })()`,true);
    assert.deepEqual(pendingDialog,{present:true,busy:true,disabled:true,focused:true},'pending trust must keep the same modal open, focused and non-dismissible');
    const pending = state.pendingRuntimeConfirm;
    state.pendingRuntimeConfirm = null;
    pending.resolve();
    await waitFor(win,`document.querySelector(${JSON.stringify(entry.dialog)})?.querySelector('[role="alert"]')?.textContent?.includes('模拟主机指纹确认暂时失败') === true`,`${entry.name} confirmation error remains inside its modal`);
    assert.equal(state.runtimeChallenges.has(trusted.challengeId),true,'failed trust must retain the same challenge for explicit retry');
    await setExactViewport(win,960,640);
    currentStep = `host-key:${entry.name}:failure-geometry-960`;
    await assertSurfaceGeometry(win,entry.dialog,['[data-slot="alert-dialog-cancel"]','[data-slot="alert-dialog-action"]']);
    await assertFocusLoop(win,entry.dialog);
    await captureSurfaceEvidence(win,{
      name:`${entry.name}-host-key-failure`,selector:entry.dialog,
      restoreFocusSelector:`${entry.dialog} [data-slot="alert-dialog-action"]`,
    });
    currentStep = `host-key:${entry.name}:retry`;
    const intentCountBeforeTrustRetry = calls('v2:connection-intent').length;
    await clickText(win,'信任并继续',entry.dialog);
    await waitForCall('v2:connection-challenge-confirm',confirmIndex+1);
    assertRuntimeHostKeyPayload(calls('v2:connection-challenge-confirm')[confirmIndex+1].payload,trusted);
    assert.deepEqual(calls('v2:connection-challenge-confirm')[confirmIndex+1].payload,calls('v2:connection-challenge-confirm')[confirmIndex].payload,'explicit trust retry must reuse the exact challenge payload');
    await assertRuntimeHostKeyClosed(win,entry,`${entry.name} successful trust`);
    assert.equal(calls('v2:connection-challenge-confirm').length,confirmIndex+2,'failed trust retries only after a second explicit click');
    assert.equal(calls('v2:connection-intent').length,intentCountBeforeTrustRetry,'trust retry must not silently start another connection intent');
    assert.equal(state.runtimeChallenges.has(trusted.challengeId),false,'successful trust consumes the exact fixture challenge');
    assert.equal(state.runtimeChallenges.has(escaped.challengeId),true,'later trust must not consume an escaped challenge');
    assert.equal(state.runtimeChallenges.has(rejected.challengeId),true,'later trust must not consume a rejected challenge');
    await setExactViewport(win,1280,820);
  }

  // A legitimate external workspace refresh can remove a resource while its
  // challenge is visible. The removed row must not remain a focus destination.
  const rowEntry = entries[3];
  currentStep = 'host-key:removed-owner';
  await selectRuntimeHostKeyEntry(win,rowEntry);
  const removedChallenge = await openRuntimeHostKeyChallenge(win,rowEntry);
  const beforeRemovalConfirms = calls('v2:connection-challenge-confirm').length;
  const originalIndex = state.plugins.findIndex((plugin) => plugin.pluginInstanceId === SERVER_ID);
  const [removedPlugin] = state.plugins.splice(originalIndex,1);
  state.runtime = makeRuntime('disconnected',state.runtime.sequence+1);
  win.webContents.send('v2:environment-status-changed',clone(state.runtime));
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:SERVER_ID});
  await waitFor(win,`document.querySelector(${JSON.stringify(rowEntry.trigger)}) === null && document.querySelector(${JSON.stringify(rowEntry.dialog)}) === null`,'external refresh removes the host-key trigger and its dialog');
  await waitFor(win,`document.activeElement === document.getElementById('detail-main')`,'removed host-key trigger restores the stable detail-workspace fallback');
  assert.equal(calls('v2:connection-challenge-confirm').length,beforeRemovalConfirms,'removing the challenge owner must not trust a host key');
  assert.equal(state.runtimeChallenges.has(removedChallenge.challengeId),true,'removed scope must not consume its unapproved challenge');
  state.plugins.splice(originalIndex,0,removedPlugin);
  state.runtime = makeRuntime('disconnected',state.runtime.sequence+1);
  win.webContents.send('v2:environment-status-changed',clone(state.runtime));
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  state.runtimeHostKeyMode = false;
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+13,'host-key governance uses exactly thirteen explicit connection requests');
  assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount+8,'host-key governance uses exactly eight explicitly approved confirmation attempts');
  assert.equal(mutationCalls.length,initialMutationCount+21,'host-key cases must not add hidden mutations outside the reviewed intent/confirmation calls');
}

async function assertDeferredHostKeyDialogs(win) {
  process.stdout.write('Checking deferred host-key dialog queue\n');
  const initialMutationCount = mutationCalls.length;
  const initialConfirmCount = calls('v2:connection-challenge-confirm').length;
  const initialIntentCount = calls('v2:connection-intent').length;
  state.runtimeHostKeyMode = true;
  state.deferRuntimeChallenges = true;
  setServerPhase('disconnected');
  win.webContents.send('v2:environment-status-changed',clone(state.runtime));
  const pluginEntry = {name:'queued-plugin-row',kind:'plugin',panel:false,trigger:`[data-testid="plugin-connection-${SERVER_ID}"]`,dialog:'[data-testid="resource-host-key-confirmation"][data-state="open"]'};
  const environmentEntry = {name:'queued-environment-row',kind:'environment',panel:false,trigger:`[data-testid="environment-connection-${ENVIRONMENT_ID}"]`,dialog:'[data-testid="resource-host-key-confirmation"][data-state="open"]'};
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]') !== null`,'restored plugin scope before deferred host-key cases');
  await selectRuntimeHostKeyEntry(win,pluginEntry);

  const metadataDialog = '[data-testid="plugin-metadata-dialog"]';
  await win.webContents.executeJavaScript(`(() => {
    window.__hostKeyModalCounts = [];
    const record = () => window.__hostKeyModalCounts.push(
      [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter((node) => (
        node.getAttribute('data-state') !== 'closed' && node.getClientRects().length > 0
      )).length,
    );
    window.__hostKeyModalObserver = new MutationObserver(record);
    window.__hostKeyModalObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state','hidden']});
    record();
  })()`,true);

  for (const entrySet of [[pluginEntry],[pluginEntry,environmentEntry]]) {
    currentStep = `host-key:deferred:${entrySet.length}-responses`;
    process.stdout.write(`Deferred host-key queue: ${entrySet.length} responses\n`);
    state.pendingRuntimeChallenges = [];
    for (const entry of entrySet) {
      await waitFor(win,`(() => {
        const trigger = document.querySelector(${JSON.stringify(entry.trigger)});
        return trigger instanceof HTMLButtonElement && !trigger.disabled
          && ['connect','retry'].includes(trigger.getAttribute('data-connection-intent'));
      })()`,`${entry.name} deferred trigger ready`);
      await openPopup(win,entry.trigger,`${entry.name} delayed connection attempt`);
    }
    await waitUntil(() => state.pendingRuntimeChallenges.length === entrySet.length,'all scoped host-key responses held until another modal opens');
    const pending = [...state.pendingRuntimeChallenges];
    pending.forEach((response,index) => {
      const entry = entrySet[index];
      exactKeys(response.payload,[
        'projectId','environmentId',...(entry.kind === 'plugin' ? ['pluginInstanceId'] : ['expectedRevision']),
        'intent','requestId','source','planId',
      ],`${entry.name} queued connection request`);
      assert.equal(response.payload.projectId,PROJECT_ID);
      assert.equal(response.payload.environmentId,ENVIRONMENT_ID);
      assert.equal(response.payload.source,entry.kind === 'plugin' ? 'renderer-plugin' : 'renderer-environment');
      assert.ok(['connect','retry'].includes(response.payload.intent));
      assert.match(response.payload.requestId,new RegExp(`^${entry.kind}-connection-`,'u'));
      assert.match(response.payload.planId,new RegExp(`^${entry.kind}-plan-`,'u'));
      assert.equal(response.challenge.planId,response.payload.planId);
      if (entry.kind === 'plugin') assert.equal(response.payload.pluginInstanceId,SERVER_ID);
      else {
        assert.equal(Object.hasOwn(response.payload,'pluginInstanceId'),false);
        assert.equal(response.payload.expectedRevision,state.environmentRevision);
      }
      assertNoSensitivePayload(response.payload,`${entry.name} queued request`);
    });
    await openPopup(win,'button[aria-label="当前范围更多操作"]','open short rename dialog while a host-key response is pending');
    await waitFor(win,`document.querySelector('[role="menu"]') !== null`,'scope menu before queued challenge');
    await clickText(win,'修改名称');
    await waitFor(win,`document.querySelector(${JSON.stringify(metadataDialog)})?.contains(document.activeElement) === true`,'metadata dialog owns focus before late host-key responses');
    process.stdout.write('Deferred host-key queue: metadata dialog focused\n');
    pending.forEach((response) => response.resolve());
    await wait(250);
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector(${JSON.stringify(metadataDialog)});
      return dialog?.contains(document.activeElement) === true
        && document.querySelector('[data-testid="resource-host-key-confirmation"][data-state="open"]') === null;
    })()`,true),true,'late host-key responses must queue without stacking over the active metadata dialog or stealing focus');
    assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount,'queued host-key challenges are never auto-approved');
    await pressEscape(win);
    await waitFor(win,`document.querySelector(${JSON.stringify(metadataDialog)}) === null`,'short metadata dialog closes before queued host-key presentation');
    process.stdout.write('Deferred host-key queue: metadata dialog closed\n');
    const remaining = [...pending];
    while (remaining.length > 0) {
      const selector = '[data-testid="resource-host-key-confirmation"][data-state="open"]';
      await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.contains(document.activeElement) === true`,'the next queued host-key challenge owns one modal focus scope');
      const shownText = await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,true);
      const shownIndex = remaining.findIndex((response) => shownText.includes(response.challenge.fingerprint) && shownText.includes(response.challenge.host));
      assert.ok(shownIndex >= 0,'queued challenge presentation must match one exact pending host, fingerprint and scope');
      const [shown] = remaining.splice(shownIndex,1);
      await clickText(win,'不信任',selector);
      if (remaining.length === 0) {
        await waitFor(win,`document.querySelector('[data-testid="resource-host-key-confirmation"]') === null`,'all queued host-key prompts rejected');
        const trigger = shown.payload.source === 'renderer-plugin' ? pluginEntry.trigger : environmentEntry.trigger;
        await waitFor(win,`document.activeElement === document.querySelector(${JSON.stringify(trigger)})`,'the final queued challenge returns focus to its own exact connection trigger');
      } else {
        await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.textContent?.includes(${JSON.stringify(remaining[0].challenge.fingerprint)}) === true`,'rejecting one challenge presents the other scope without reusing the rejected challenge');
      }
      assert.equal(state.runtimeChallenges.has(shown.challenge.challengeId),true,'rejecting a queued challenge must not consume its approval');
      assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount,'rejecting sequential host-key challenges sends zero confirmations');
    }
  }
  const counts = await win.webContents.executeJavaScript(`(() => {
    window.__hostKeyModalObserver.disconnect();
    const counts = [...window.__hostKeyModalCounts];
    delete window.__hostKeyModalObserver;
    delete window.__hostKeyModalCounts;
    return counts;
  })()`,true);
  assert.ok(counts.some((count) => count === 1),'modal observer must actually observe the short dialog and host-key prompts');
  assert.equal(Math.max(...counts),1,'single and simultaneous late host-key responses must never stack active modal surfaces');
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+3,'queued host-key cases add exactly three explicitly clicked scoped requests');
  assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount,'late and simultaneous host-key rejections send zero trust confirmations');
  assert.equal(mutationCalls.length,initialMutationCount+3,'queued dialogs must not save metadata or cause hidden mutations');
  state.runtimeHostKeyMode = false;
  state.deferRuntimeChallenges = false;
  state.pendingRuntimeChallenges = [];
}

async function assertConnectionTooltipHandoff(win) {
  const initialMutationCount = mutationCalls.length;
  const initialConfirmCount = calls('v2:connection-challenge-confirm').length;
  const initialIntentCount = calls('v2:connection-intent').length;
  state.runtimeHostKeyMode = true;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    process.stdout.write(`Connection tooltip handoff round ${iteration+1}/8\n`);
    for (const kind of ['environment','plugin']) {
      const entry = {
        name:`tooltip-handoff-${kind}-${iteration}`,kind,panel:false,
        trigger:kind === 'environment'
          ? `[data-testid="environment-connection-${ENVIRONMENT_ID}"]`
          : `[data-testid="plugin-connection-${SERVER_ID}"]`,
        dialog:'[data-testid="resource-host-key-confirmation"]',
      };
      await selectRuntimeHostKeyEntry(win,entry);
      for (const dismissal of ['Escape','不信任']) {
        currentStep = `${entry.name}:${dismissal}`;
        await ensureNativeKeyboardFocus(win);
        const blurred = await win.webContents.executeJavaScript(`(() => {
          const main = document.getElementById('detail-main');
          if (!(main instanceof HTMLElement)) return false;
          main.focus({preventScroll:true});
          return document.activeElement === main;
        })()`,true);
        assert.equal(blurred,true,'connection tooltip handoff must first leave the previous trigger through real focus');
        // Radix controlled state compares the next value with the committed
        // prop. Separate blur and focus tasks so a queued close cannot swallow
        // a same-task reopen against the previous open prop.
        await waitFor(win,`document.activeElement === document.getElementById('detail-main')
          && document.querySelector(${JSON.stringify(entry.trigger)})?.getAttribute('data-state') === 'closed'
          && document.querySelector('[data-slot="tooltip-content"]') === null`,
        `${entry.name} previous tooltip close commits before keyboard refocus`);
        const focus = await win.webContents.executeJavaScript(`(() => {
          const target = document.querySelector(${JSON.stringify(entry.trigger)});
          if (!(target instanceof HTMLButtonElement) || target.disabled || target.getClientRects().length === 0) return null;
          let nativeFocusIn = false;
          const observe = (event) => { nativeFocusIn ||= event.isTrusted && event.target === target; };
          document.addEventListener('focusin',observe,true);
          target.focus({preventScroll:true});
          document.removeEventListener('focusin',observe,true);
          return {hasFocus:document.hasFocus(),nativeFocusIn,targetFocused:document.activeElement === target};
        })()`,true);
        assert.deepEqual(focus,{hasFocus:true,nativeFocusIn:true,targetFocused:true},'connection tooltip handoff must start with real keyboard focus on its exact idle trigger');
        await waitFor(win,`(() => {
          const trigger = document.querySelector(${JSON.stringify(entry.trigger)});
          return document.activeElement === trigger
            && [...document.querySelectorAll('[data-slot="tooltip-content"]')].some((tooltip) => (
              tooltip.getAttribute('data-state') !== 'closed' && tooltip.getClientRects().length > 0
              && tooltip.textContent?.includes(trigger?.getAttribute('aria-label') ?? '')
            ));
        })()`,`${entry.name} idle connection tooltip is keyboard-accessible before ${dismissal}`);

        const challenge = await openRuntimeHostKeyChallenge(win,entry);
        const remainingTooltips = await win.webContents.executeJavaScript(`document.querySelectorAll('[data-slot="tooltip-content"]').length`,true);
        assert.equal(remainingTooltips,0,'connection challenge must synchronously unmount all tooltip content, including closing portals');
        if (dismissal === 'Escape') await pressEscape(win);
        else await clickText(win,'不信任',entry.dialog);
        await assertRuntimeHostKeyClosed(win,entry,`${entry.name} ${dismissal}`);
        assert.equal(state.runtimeChallenges.has(challenge.challengeId),true,'tooltip handoff dismissal must not consume an unapproved host-key challenge');
        assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount,'tooltip handoff dismissal must never trust a host key');
      }
    }
  }
  state.runtimeHostKeyMode = false;
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+32,'tooltip handoff exercises eight rounds of both row scopes and both explicit dismissals');
  assert.equal(calls('v2:connection-challenge-confirm').length,initialConfirmCount,'all thirty-two tooltip handoffs send zero trust confirmations');
  assert.equal(mutationCalls.length,initialMutationCount+32,'tooltip handoff adds only thirty-two explicit scoped connection requests');
}

async function assertEnvironmentDetailsLifecycle(win) {
  currentStep = 'environment-details-lifecycle';
  const initialMutationCount = mutationCalls.length;
  const initialIntentCount = calls('v2:connection-intent').length;
  const expectedRevision = state.environmentRevision;
  state.environmentLifecycle = {connectCount:0,pending:null};
  state.runtime = environmentLifecycleSnapshot('disconnected');
  win.webContents.send('v2:environment-status-changed',clone(state.runtime));
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await viewEnvironmentDetails(win,'open environment details for its isolated lifecycle');
  await activateTab(win,'overview');
  const primary = '[data-testid="environment-connection-primary"]';
  const waitAction = (label,reason) => waitFor(win,`(() => {
    const button = document.querySelector(${JSON.stringify(primary)});
    return button instanceof HTMLButtonElement && !button.disabled && button.getClientRects().length > 0
      && button.textContent?.trim() === ${JSON.stringify(label)};
  })()`,reason);
  await waitAction('连接全部','environment details begin disconnected with an explicit connect action');
  assert.equal(mutationCalls.length,initialMutationCount,'opening environment details must not connect automatically');

  await openPopup(win,primary,'connect the current environment explicitly');
  await waitAction('断开全部','environment details expose disconnect after connection succeeds');
  await openPopup(win,primary,'disconnect the current environment explicitly');
  await waitAction('连接全部','environment details return to disconnected after disconnect succeeds');
  await openPopup(win,primary,'start the delayed environment connection');
  await waitUntil(() => state.environmentLifecycle.pending !== null,'the delayed environment request remains in flight');
  await waitAction('取消','environment details expose cancellation during connection');
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+3,'environment lifecycle starts exactly three explicit requests before cancellation');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="environment-connection-refresh"]')?.disabled`,true),true,
    'manual connection refresh is disabled during an environment operation');

  await activateTab(win,'runbook');
  await waitFor(win,`document.querySelector('[data-feature="runbook"]')?.getClientRects().length > 0`,'environment runbook opens without editing');
  await activateTab(win,'overview');
  await waitAction('取消','the same pending environment connection survives tab navigation');
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+3,'environment tab navigation must not repeat connection requests');

  const scopedReads = () => readCalls.filter((entry) => entry.channel === 'v2:plugin-list'
    && entry.args[0]?.projectId === PROJECT_ID && entry.args[0]?.environmentId === ENVIRONMENT_ID).length;
  const readsBeforeFailure = scopedReads();
  state.failPluginListRead = true;
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await waitUntil(() => scopedReads() > readsBeforeFailure,'environment refresh reaches the scoped plugin-list failure');
  await waitFor(win,`document.querySelector('[data-testid="environment-overview-error"]')?.getClientRects().length > 0`,
    'environment details show a refresh failure alongside cached controls');
  await waitAction('取消','failed environment refresh retains the pending cancellation control');
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+3,'failed environment refresh must not restart or cancel its connection');
  state.failPluginListRead = false;
  const readsBeforeRecovery = scopedReads();
  await clickText(win,'重新读取','[data-testid="environment-overview-error"]');
  await waitUntil(() => scopedReads() > readsBeforeRecovery,'environment refresh retry reads the same plugin scope');
  await waitFor(win,`document.querySelector('[data-testid="environment-overview-error"]') === null`,'environment refresh recovers without replacing connection state');
  await waitAction('取消','recovered environment details retain the original pending connection');
  assert.equal(calls('v2:connection-intent').length,initialIntentCount+3,'environment refresh recovery must not create a connection intent');

  await openPopup(win,primary,'cancel the pending environment connection explicitly');
  await waitAction('连接全部','cancelled environment details return to disconnected');
  const pending = state.environmentLifecycle.pending;
  assert.ok(pending,'the delayed environment result remains available after cancellation');
  const readsBeforeLateResult = readCalls.filter((entry) => entry.channel === 'v2:environment-status').length;
  pending.resolve(connectionResult(pending.payload,environmentLifecycleSnapshot('connected'),[],'late-environment-connect-operation'));
  state.environmentLifecycle.pending = null;
  await wait(160);
  await waitAction('连接全部','a late environment connect result cannot overwrite the cancelled state');
  assert.equal(readCalls.filter((entry) => entry.channel === 'v2:environment-status').length,readsBeforeLateResult,
    'a stale environment connect result must not publish runtime or trigger recovery reads');

  const readsBeforeCachedNavigation = scopedReads();
  state.failPluginListRead = true;
  win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
  await waitUntil(() => scopedReads() > readsBeforeCachedNavigation,'cached plugin navigation reaches the scoped read failure');
  await waitFor(win,`document.querySelector('[data-testid="environment-overview-error"]')?.getClientRects().length > 0`,
    'cached environment details report the failed plugin-list refresh');
  const openedCachedPlugin = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="environment-plugin-detail-${SERVER_ID}"]')]
      .filter((button) => button.getClientRects().length > 0);
    if (buttons.length !== 1 || buttons[0].disabled) return false;
    buttons[0].click();
    return true;
  })()`,true);
  assert.equal(openedCachedPlugin,true,'the cached environment plugin list keeps one usable entry for the exact plugin');
  await waitFor(win,`document.querySelector('#detail-main')?.dataset.selectionKind === 'plugin'
    && document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'
    && document.querySelector('[data-testid="plugin-overview"]')?.getClientRects().length > 0
    && document.querySelector('[data-testid="plugin-overview-error"]')?.getClientRects().length > 0`,
  'cached environment plugin navigation opens the exact plugin despite the outstanding read error');
  state.failPluginListRead = false;
  const readsBeforeCachedRecovery = scopedReads();
  await clickText(win,'重新读取','[data-testid="plugin-overview-error"]');
  await waitUntil(() => scopedReads() > readsBeforeCachedRecovery,'cached plugin details retry the exact failed scope');
  await waitFor(win,`document.querySelector('[data-testid="plugin-overview-error"]') === null
    && document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,
  'cached plugin details recover without changing the selected plugin');
  await viewEnvironmentDetails(win,'return from recovered cached plugin details to the environment');
  await activateTab(win,'overview');
  await waitAction('连接全部','cached detail navigation returns to the disconnected environment');
  assert.equal(mutationCalls.length,initialMutationCount+4,'cached plugin navigation and recovery must remain read-only');

  const requests = calls('v2:connection-intent').slice(initialIntentCount).map((entry) => entry.payload);
  assert.deepEqual(requests.map((request) => request.intent),['connect','disconnect','connect','cancel']);
  for (const request of requests) {
    exactKeys(request,[
      'projectId','environmentId','intent','requestId','source',
      ...(request.intent === 'connect' ? ['expectedRevision','planId'] : request.intent === 'cancel' ? ['planId'] : []),
    ],`environment ${request.intent} request`);
    assert.equal(request.projectId,PROJECT_ID);
    assert.equal(request.environmentId,ENVIRONMENT_ID);
    assert.equal(request.source,'renderer-environment');
    assert.match(request.requestId,request.intent === 'cancel' ? /^environment-cancel-/u : /^environment-connection-/u);
    if (request.intent === 'connect') {
      assert.equal(request.expectedRevision,expectedRevision,'environment connect binds the displayed environment revision');
      assert.match(request.planId,/^environment-plan-/u);
    }
    assertNoSensitivePayload(request,'environment lifecycle request');
  }
  assert.notEqual(requests[0].planId,requests[2].planId,'separate environment attempts use separate plans');
  assert.equal(requests[3].planId,requests[2].planId,'environment cancel keeps the delayed connect plan across tabs and refreshes');
  assert.equal(mutationCalls.length,initialMutationCount+4,'environment lifecycle adds only four explicit scoped connection intents');
  state.environmentLifecycle = null;
}

async function deletePluginThroughUi(win,pluginInstanceId) {
  currentStep = 'delete-plugin-before-readd';
  const deletionIndex = calls('v2:plugin-delete').length;
  await click(win,`[data-testid="plugin-trigger-${pluginInstanceId}"]`,'select plugin to delete');
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${pluginInstanceId}"]')?.getAttribute('aria-current') === 'page'`,'delete target selected');
  await openPopup(win,'[data-testid="detail-scope-actions"]','plugin scope menu');
  await clickText(win,'删除插件','body','[role="menuitem"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') !== null`,'plugin deletion confirmation');
  await clickText(win,'删除插件','[data-testid="plugin-delete-dialog"]');
  const deletion = await waitForCall('v2:plugin-delete',deletionIndex);
  assert.equal(deletion.payload.pluginInstanceId,pluginInstanceId);
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null
    && document.querySelector('[data-testid="plugin-trigger-${pluginInstanceId}"]') === null`,'deleted plugin is removed from the workspace');
}

async function assertFirstPluginAfterDeletion(win) {
  currentStep = 'first-plugin-after-deletion';
  process.stdout.write('Checking first-plugin re-add with temporary and absent credentials\n');
  const initialMutationCount = mutationCalls.length;
  const initialPluginCount = state.plugins.length;
  const initialProbeCount = calls('v2:plugin-probe').length;
  const initialRuntimeCount = probeRuntimeCalls.length;
  const initialConnectionCount = calls('v2:connection-intent').length;
  state.allowPluginDeletion = true;
  try {
    for (const plugin of [...state.plugins]) await deletePluginThroughUi(win,plugin.pluginInstanceId);
    for (const pluginType of ['server','redis']) {
      currentStep = `first-plugin-after-deletion:${pluginType}`;
      assert.equal(state.plugins.length,0,'re-add starts only after deleting the last plugin');
      await waitFor(win,`document.querySelector('[data-testid="environment-row-${ENVIRONMENT_ID}"] [data-testid^="plugin-row-"]') === null
        && document.querySelector('[data-testid="add-plugin-${ENVIRONMENT_ID}"]')?.getClientRects().length > 0`,'empty environment retains its add-first-plugin action');
      await click(win,`[data-testid="add-plugin-${ENVIRONMENT_ID}"]`,'add first plugin after deletion');
      await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null`,'first plugin editor opens after deletion');
      await chooseSelectOption(win,'[aria-label="插件类型"]',pluginType === 'server' ? 'Server' : 'Redis');
      await fill(win,'#plugin-display-name',`重新新增 ${pluginType}`);
      await fill(win,'#plugin-host',`${pluginType}-readded.smoke.invalid`);
      if (pluginType === 'server') {
        await fill(win,'#plugin-username','operator');
        syntheticProbePassword = randomBytes(24).toString('hex');
        await fill(win,'#plugin-primary-credential',syntheticProbePassword);
      }

      const probeIndex = calls('v2:plugin-probe').length;
      const createIndex = calls('v2:plugin-create').length;
      await clickText(win,'检查连接',EDITOR_SELECTOR);
      await waitForCall('v2:plugin-probe',probeIndex);
      await waitFor(win,`document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent?.includes('检查通过') === true`,'first plugin connection check succeeds');
      assert.equal(calls('v2:plugin-create').length,createIndex,'checking the first plugin must not persist it');
      assert.equal(state.plugins.length,0,'temporary probe must leave the empty environment unchanged');
      await click(win,'[data-testid="plugin-save-disconnected"]','save first plugin without connecting');
      const created = await waitForCall('v2:plugin-create',createIndex);
      await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null
        && document.querySelector('[data-testid="plugin-trigger-${created.payload.input.pluginInstanceId}"]')?.getAttribute('aria-current') === 'page'`,'saving selects the newly created first plugin');
      syntheticProbePassword = null;
      assert.equal(state.plugins.length,1,'exactly one plugin is persisted after re-add');
      assert.equal(created.payload.input.pluginType,pluginType);
      assert.equal(created.payload.projectId,PROJECT_ID);
      assert.equal(created.payload.environmentId,ENVIRONMENT_ID);
      const probes = calls('v2:plugin-probe').slice(probeIndex);
      assert.equal(probes.length,2,'explicit check and save each use a temporary probe');
      for (const {payload} of probes) {
        assert.equal(payload.projectId,PROJECT_ID);
        assert.equal(payload.environmentId,ENVIRONMENT_ID);
        assert.equal(payload.draft.pluginType,pluginType);
        assert.equal(payload.purpose,pluginType === 'server' ? 'server-auth' : 'resource-access');
        assert.equal(Object.hasOwn(payload,'credentialIntent'),false,'temporary probe must not request saved credential reuse');
        assert.equal(Object.hasOwn(payload,'oneTimeGrant'),false,'temporary probe must not carry a saved-credential grant');
      }
      if (pluginType === 'server') await deletePluginThroughUi(win,created.payload.input.pluginInstanceId);
    }
  } finally {
    syntheticProbePassword = null;
    state.allowPluginDeletion = false;
  }
  assert.equal(calls('v2:plugin-probe').length,initialProbeCount+4);
  assert.deepEqual(probeRuntimeCalls.slice(initialRuntimeCount),[
    {pluginType:'server',purpose:'server-auth',usesTemporaryCredentials:true},
    {pluginType:'server',purpose:'server-auth',usesTemporaryCredentials:true},
    {pluginType:'redis',purpose:'resource-access',usesTemporaryCredentials:false},
    {pluginType:'redis',purpose:'resource-access',usesTemporaryCredentials:false},
  ],'real probe validation reaches the mock runtime with only the explicit temporary credentials');
  assert.equal(calls('v2:connection-intent').length,initialConnectionCount,'checking and saving disconnected never starts a persistent connection');
  assert.equal(mutationCalls.length,initialMutationCount+initialPluginCount+7,'re-add uses only reviewed deletes, four probes and two creates');
}

async function assertSmokeSafety() {
  assert.deepEqual(forbiddenCalls,[]);
  assert.deepEqual(externalRequests,[]);
  await Promise.all(rendererDiagnosticPromises);
  assert.deepEqual(rendererErrors,[],`Renderer console errors are not allowed. ResizeObserver diagnostics: ${JSON.stringify(rendererErrorDiagnostics)}`);
  assert.ok(readCalls.some((entry) => entry.channel === 'v2:workspace-overview'));
  for (const entry of mutationCalls) assertNoSensitivePayload(entry.payload,entry.channel);
  assert.deepEqual(geometryFailures,[],'960x640 security-confirmation/button geometry regressions');
  assert.deepEqual(focusFailures,[],'Radix safety/dirty confirmation focus containment regressions');
}

async function run() {
  assert.ok(fs.existsSync(pagePath),'build:renderer must produce renderer-build/v2/index.html');
  await app.whenReady();
  await registerMockApi();
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    if (!details.url.startsWith('file:') && !details.url.startsWith('devtools:')) {
      externalRequests.push(details.url);
      callback({cancel:true});
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    show:false,
    useContentSize:true,
    width:960,
    height:640,
    webPreferences:{
      preload:path.join(root,'src','preload.cjs'),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      backgroundThrottling:false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-attach-webview',(event) => event.preventDefault());
  win.webContents.on('will-navigate',(event) => event.preventDefault());
  win.webContents.on('console-message',(_event,level,message) => {
    if (level >= 2) rendererErrors.push(message);
    if (message.includes('ResizeObserver loop')) {
      const step = currentStep;
      const diagnostic = win.webContents.executeJavaScript(`(() => ({
        viewport:[window.innerWidth,window.innerHeight],
        active:{tag:document.activeElement?.tagName,testId:document.activeElement?.getAttribute('data-testid') ?? null},
        dialogs:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((dialog) => ({
          testId:dialog.getAttribute('data-testid'),state:dialog.getAttribute('data-state'),
          width:dialog.getBoundingClientRect().width,height:dialog.getBoundingClientRect().height,
        })),
        panels:[...document.querySelectorAll('[data-slot="resizable-panel"]')].map((panel) => ({
          id:panel.id,width:panel.getBoundingClientRect().width,height:panel.getBoundingClientRect().height,
        })),
      }))()`,true).then((snapshot) => {
        rendererErrorDiagnostics.push({step,message,...snapshot});
      }).catch(() => {
        rendererErrorDiagnostics.push({step,message,snapshotUnavailable:true});
      });
      rendererDiagnosticPromises.push(diagnostic);
    }
  });

  try {
    await win.loadFile(pagePath);
    await setExactViewport(win,960,640);
    if (screenshotRoot) win.show();
    await waitFor(win,`document.querySelector('[data-shell-ready="true"]') !== null`,'React App Shell mount');
    if (requestedScreenshotTheme) {
      await waitFor(
        win,
        `document.documentElement.dataset.theme === ${JSON.stringify(requestedScreenshotTheme)}`,
        `${requestedScreenshotTheme} screenshot theme`,
      );
    }
    await waitFor(win,`document.querySelector('[data-environment-id="${ENVIRONMENT_ID}"]') !== null`,'plugin environment');
    await assertNativeFocusEvents(win);

    if (isolatedScenario) {
      await isolatedScenario(win);
      await assertSmokeSafety();
      return;
    }

    if (app.commandLine.hasSwitch('probe-regression-only')) {
      await assertFirstPluginAfterDeletion(win);
      await assertSmokeSafety();
      process.stdout.write(`First-plugin re-add smoke passed (${mutationCalls.length} scoped mutation calls; no credentials logged)\n`);
      return;
    }

    const disconnectedCreate = await createRedisPlugin(win,{
      name:'只保存 Redis',host:'redis-one.smoke.invalid',strategy:'disconnect',
    });
    exactKeys(disconnectedCreate.payload,['projectId','environmentId','input'],'new plugin disconnected save');
    assert.equal(disconnectedCreate.payload.projectId,PROJECT_ID);
    assert.equal(disconnectedCreate.payload.environmentId,ENVIRONMENT_ID);
    assert.deepEqual(disconnectedCreate.payload.input,{
      pluginType:'redis',
      pluginInstanceId:disconnectedCreate.payload.input.pluginInstanceId,
      displayName:'只保存 Redis',
      target:{host:'redis-one.smoke.invalid',port:6379,addressFamily:'ipv4Preferred',db:0},
      auth:{username:''},
      transport:{kind:'direct'},
      tls:{mode:'disabled'},
    });
    assert.match(disconnectedCreate.payload.input.pluginInstanceId,/^redis-[a-z0-9-]+$/u);
    assertNoSensitivePayload(disconnectedCreate.payload,'new plugin disconnected save');

    const connectedCreate = await createRedisPlugin(win,{
      name:'保存并连接 Redis',host:'redis-two.smoke.invalid',strategy:'connect-current',
    });
    exactKeys(connectedCreate.payload,['projectId','environmentId','input'],'new plugin connect save');
    assert.equal(connectedCreate.payload.projectId,PROJECT_ID);
    assert.equal(connectedCreate.payload.environmentId,ENVIRONMENT_ID);
    assert.equal(connectedCreate.payload.input.pluginType,'redis');
    assert.equal(connectedCreate.payload.input.displayName,'保存并连接 Redis');
    assertNoSensitivePayload(connectedCreate.payload,'new plugin connect save');
    const editorConnect = calls('v2:connection-intent').find((entry) => entry.payload.source === 'renderer-plugin-editor');
    assert.ok(editorConnect,'new plugin connect-current must issue an explicit connection intent');
    exactKeys(editorConnect.payload,[
      'projectId','environmentId','pluginInstanceId','intent','requestId','planId','source',
    ],'new plugin editor connection');
    assert.equal(editorConnect.payload.projectId,PROJECT_ID);
    assert.equal(editorConnect.payload.environmentId,ENVIRONMENT_ID);
    assert.equal(editorConnect.payload.pluginInstanceId,connectedCreate.payload.input.pluginInstanceId);
    assert.equal(editorConnect.payload.intent,'connect');
    assert.equal(editorConnect.payload.source,'renderer-plugin-editor');
    assertNoSensitivePayload(editorConnect.payload,'new plugin editor connection');

    assertEditSavePayload(await saveExistingPlugin(win,'stay-disconnected',0),'stay-disconnected',7,1);
    assertEditSavePayload(await saveExistingPlugin(win,'connect-current',1),'connect-current',8,2);
    assertEditSavePayload(await saveExistingPlugin(win,'restore-pre-edit-set',2),'restore-pre-edit-set',9,3);

    await click(win,`[data-testid="plugin-trigger-${SERVER_ID}"]`,'select server plugin');
    await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getAttribute('aria-current') === 'page'`,'stable server selection');
    await wait(400);
    await activateTab(win,'overview');
    try {
      await waitFor(win,`document.querySelector('[data-testid="plugin-connection-panel"]') !== null`,'plugin connection panel');
    } catch (error) {
      const snapshot = await win.webContents.executeJavaScript(`(() => ({
        selection:document.querySelector('#detail-main')?.getAttribute('data-selection-kind'),
        activeTabs:[...document.querySelectorAll('[data-detail-tab]')].map((tab) => ({
          value:tab.getAttribute('data-detail-tab'),state:tab.getAttribute('data-state'),visible:tab.getClientRects().length > 0,
        })),
        detailText:document.querySelector('#detail-main')?.textContent?.replace(/\\s+/gu,' ').trim().slice(0,500),
      }))()`,true);
      throw new Error(`${error.message}: ${JSON.stringify(snapshot)}`);
    }

    await clickText(win,'连接','[data-testid="plugin-connection-panel"]');
    await waitFor(win,`document.querySelector('[data-testid="runtime-host-key-confirmation"]') !== null`,'host-key confirmation');
    await assertSurfaceGeometry(win,'[data-testid="runtime-host-key-confirmation"]',[
      '[data-slot="alert-dialog-cancel"]','[data-slot="alert-dialog-action"]',
    ]);
    await assertFocusLoop(win,'[data-testid="runtime-host-key-confirmation"]');
    const fingerprintGeometry = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[data-testid="runtime-host-key-confirmation"]');
      const fingerprint = [...(dialog?.querySelectorAll('dd') ?? [])].find((item) => item.textContent?.includes('SHA256:'));
      if (!(dialog instanceof HTMLElement) || !(fingerprint instanceof HTMLElement)) return null;
      const rect = fingerprint.getBoundingClientRect();
      return {
        text:fingerprint.textContent,
        wraps:fingerprint.scrollWidth <= fingerprint.clientWidth+1,
        inside:rect.left >= 0 && rect.right <= window.innerWidth+1,
        dialogOverflow:dialog.scrollWidth-dialog.clientWidth,
      };
    })()`,true);
    assert.ok(fingerprintGeometry,'host-key fingerprint must be visible');
    assert.equal(fingerprintGeometry.text,LONG_FINGERPRINT);
    assert.equal(fingerprintGeometry.wraps,true,'long host-key fingerprint must wrap');
    assert.equal(fingerprintGeometry.inside,true,'host-key fingerprint exceeds the viewport');
    assert.ok(fingerprintGeometry.dialogOverflow <= 1,'host-key dialog has horizontal overflow');
    await captureSurfaceEvidence(win,{
      name:'runtime-host-key-confirmation',
      selector:'[data-testid="runtime-host-key-confirmation"]',
      restoreFocusSelector:'[data-slot="alert-dialog-cancel"]',
    });
    await clickText(win,'不信任','[data-testid="runtime-host-key-confirmation"]');
    await waitFor(win,`document.querySelector('[data-testid="runtime-host-key-confirmation"]') === null`,'host-key rejection');
    assert.equal(calls('v2:connection-challenge-confirm').length,0,'rejecting a host key must not confirm it');

    await clickText(win,'连接','[data-testid="plugin-connection-panel"]');
    await waitFor(win,`document.querySelector('[data-testid="plugin-connection-panel"]')?.textContent?.includes('已连接') === true`,'connected plugin');
    await clickText(win,'断开','[data-testid="plugin-connection-panel"]');
    await waitFor(win,`document.querySelector('[data-testid="plugin-connection-panel"]')?.textContent?.includes('未连接') === true`,'disconnected plugin');

    const pendingConnectionCount = calls('v2:connection-intent').length;
    const pendingEditCount = calls('v2:plugin-connection-edit-prepare').length;
    await clickText(win,'连接','[data-testid="plugin-connection-panel"]');
    await waitFor(win,`[...document.querySelectorAll('[data-testid="plugin-connection-panel"] button')].some((button) => button.textContent?.trim() === '取消')`,'connection cancel action');
    assert.equal(calls('v2:connection-intent').length,pendingConnectionCount+1,'connecting from details sends one explicit request');
    const editWhileConnecting = await win.webContents.executeJavaScript(`(() => {
      const edit = document.querySelector('[data-testid="plugin-action-edit"]');
      if (!(edit instanceof HTMLButtonElement)) return null;
      edit.click();
      return edit.disabled;
    })()`,true);
    assert.equal(editWhileConnecting,true,'plugin configuration editing is disabled while connecting');
    assert.equal(calls('v2:plugin-connection-edit-prepare').length,pendingEditCount,'busy edit action must not prepare a competing edit session');
    await activateTab(win,'agent');
    await waitFor(win,`document.querySelector('[data-testid="plugin-agent-access"]')?.getClientRects().length > 0`,'Agent permissions remain a separate view');
    await activateTab(win,'overview');
    await waitFor(win,`document.querySelector('[data-testid="plugin-connection-primary"]')?.textContent?.trim() === '取消' && document.querySelector('[data-testid="plugin-action-edit"]')?.disabled === true`,'pending connection survives leaving and returning to plugin details');
    assert.equal(calls('v2:connection-intent').length,pendingConnectionCount+1,'switching detail tabs must not duplicate a connection request');
    assert.equal(calls('v2:plugin-agent-configuration-update').length,0,'viewing Agent permissions must not modify access');
    const scopedPluginReadCount = () => readCalls.filter((entry) => entry.channel === 'v2:plugin-list'
      && entry.args[0]?.projectId === PROJECT_ID && entry.args[0]?.environmentId === ENVIRONMENT_ID).length;
    const readsBeforeFailure = scopedPluginReadCount();
    state.failPluginListRead = true;
    win.webContents.send('v2:workspace-changed',{projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID});
    await waitUntil(() => scopedPluginReadCount() > readsBeforeFailure,'same-scope plugin refresh reaches the simulated read failure');
    await waitFor(win,`document.querySelector('[data-testid="plugin-overview-error"]')?.getClientRects().length > 0
      && document.querySelector('[data-testid="plugin-connection-primary"]')?.textContent?.trim() === '取消'
      && document.querySelector('[data-testid="plugin-action-edit"]')?.disabled === true`,
    'failed plugin refresh keeps the pending connection controllable');
    assert.equal(calls('v2:connection-intent').length,pendingConnectionCount+1,'failed plugin refresh must not retry or replace the pending connection');
    assert.equal(calls('v2:plugin-connection-edit-prepare').length,pendingEditCount,'failed plugin refresh must not prepare an edit session');
    const readsBeforeRecovery = scopedPluginReadCount();
    state.failPluginListRead = false;
    await clickText(win,'重新读取','[data-testid="plugin-overview-error"]');
    await waitUntil(() => scopedPluginReadCount() > readsBeforeRecovery,'explicit plugin refresh retry reads the original scope');
    await waitFor(win,`document.querySelector('[data-testid="plugin-overview-error"]') === null
      && document.querySelector('[data-testid="plugin-connection-primary"]')?.textContent?.trim() === '取消'
      && document.querySelector('[data-testid="plugin-action-edit"]')?.disabled === true`,
    'successful plugin refresh retains the same pending connection');
    assert.equal(calls('v2:connection-intent').length,pendingConnectionCount+1,'refresh recovery must not duplicate or cancel the pending connection');
    await clickText(win,'取消','[data-testid="plugin-connection-panel"]');
    await waitFor(win,`document.querySelector('[data-testid="plugin-connection-panel"]')?.textContent?.includes('未连接') === true`,'cancelled connection');
    await wait(120);
    assertConnectionPayloads();

    await activateTab(win,'confirmations');
    await waitFor(win,`document.querySelector('[data-feature="confirmations"]') !== null`,'plugin confirmations');
    await waitFor(win,`document.querySelector('[data-confirmation-id="confirmation-standard-smoke"]') !== null`,'standard confirmation');
    const strongGateBefore = await win.webContents.executeJavaScript(`(() => {
      const article = document.querySelector('[data-confirmation-id="confirmation-strong-smoke"]');
      const action = [...(article?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('确认执行一次'));
      return {present:Boolean(action),disabled:action?.disabled ?? null};
    })()`,true);
    assert.deepEqual(strongGateBefore,{present:true,disabled:true},'strong confirmation must be gated before acknowledgement');
    await captureSurfaceEvidence(win,{
      name:'strong-confirmation-gated',
      selector:'[data-confirmation-id="confirmation-strong-smoke"]',
      restoreFocusSelector:'#confirmation-ack-confirmation-strong-smoke',
    });

    await clickText(win,'确认一次','[data-confirmation-id="confirmation-standard-smoke"]');
    await waitForCall('v2:confirmation-approve',0);
    assert.equal(calls('v2:confirmation-approve')[0].payload,'confirmation-standard-smoke');
    assert.equal(calls('v2:confirmation-approve').length,1);

    await click(win,'#confirmation-ack-confirmation-strong-smoke','strong confirmation acknowledgement');
    const strongGateAfter = await win.webContents.executeJavaScript(`(() => {
      const article = document.querySelector('[data-confirmation-id="confirmation-strong-smoke"]');
      const action = [...(article?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('确认执行一次'));
      return action?.disabled ?? null;
    })()`,true);
    assert.equal(strongGateAfter,false,'strong confirmation must unlock only after acknowledgement');
    await captureSurfaceEvidence(win,{
      name:'strong-confirmation-ready',
      selector:'[data-confirmation-id="confirmation-strong-smoke"]',
      restoreFocusSelector:'#confirmation-ack-confirmation-strong-smoke',
    });
    await clickText(win,'确认执行一次','[data-confirmation-id="confirmation-strong-smoke"]');
    await waitForCall('v2:confirmation-approve',1);
    assert.equal(calls('v2:confirmation-approve')[1].payload,'confirmation-strong-smoke');

    await assertPluginWorkspaceNavigation(win,disconnectedCreate.payload.input.pluginInstanceId);

    assert.equal(mutationCalls.length,41,'original plugin save strategies and workspace lifecycle retain the exact forty-one-call baseline');
    process.stdout.write('Plugin save strategies and workspace lifecycle passed (41 exact scoped calls)\n');
    await assertRuntimeHostKeyGovernance(win);
    assert.equal(mutationCalls.length,62,'host-key governance adds only twenty-one reviewed calls to the original plugin baseline');
    process.stdout.write('Runtime host-key entry coverage passed (62 exact scoped calls)\n');
    await assertDeferredHostKeyDialogs(win);
    assert.equal(mutationCalls.length,65,'late challenge queue coverage adds only three explicit connection requests to the sixty-two-call baseline');
    process.stdout.write('Deferred host-key queue passed (65 exact scoped calls)\n');

    await assertConnectionTooltipHandoff(win);
    assert.equal(mutationCalls.length,97,'keyboard tooltip handoff adds thirty-two scoped requests after the complete sixty-five-call plugin baseline');
    process.stdout.write('Connection tooltip handoff passed (97 exact scoped calls)\n');
    await assertEnvironmentDetailsLifecycle(win);
    process.stdout.write('Environment detail lifecycle passed\n');
    await assertFirstPluginAfterDeletion(win);

    await assertSmokeSafety();
    if (screenshotRoot) {
      process.stdout.write(
        'Plugin screenshot coverage excludes TLS challenge, metadata, credential migration, and the synthetic-credential re-add regression; temporary inputs are never captured.\n',
      );
    }
    process.stdout.write(
      `React plugin operations smoke passed (${mutationCalls.length} scoped mutation calls; no credentials logged)\n`,
    );
  } catch (error) {
    await Promise.all(rendererDiagnosticPromises);
    const snapshot = await win.webContents.executeJavaScript(`(() => ({
      viewport:[window.innerWidth,window.innerHeight],
      active:{
        tag:document.activeElement?.tagName,
        id:document.activeElement?.id,
        testId:document.activeElement?.getAttribute?.('data-testid'),
        role:document.activeElement?.getAttribute?.('role'),
        label:document.activeElement?.getAttribute?.('aria-label'),
      },
      mainKind:document.querySelector('#detail-main')?.getAttribute('data-selection-kind'),
      workspace:document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null,
      currentProjects:[...document.querySelectorAll('[data-project-id][aria-current="page"]')].map((element) => element.dataset.projectId),
      currentPlugins:[...document.querySelectorAll('[data-testid^="plugin-trigger-"][aria-current="page"]')].map((element) => element.dataset.testid),
      dialogs:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((element) => ({
        testId:element.getAttribute('data-testid'),
        role:element.getAttribute('role'),
        state:element.getAttribute('data-state'),
        focused:element.contains(document.activeElement),
      })),
      pointerEvents:getComputedStyle(document.body).pointerEvents,
    }))()`,true).catch(() => null);
    throw new Error(`${error.stack ?? error}\nPlugin smoke UI snapshot: ${JSON.stringify(snapshot)}\nResizeObserver diagnostics: ${JSON.stringify(rendererErrorDiagnostics)}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await wait(100);
    unregisterMockApi();
  }
}

module.exports = {
  runScenario:async (scenario) => { isolatedScenario = scenario; return run(); },
  state,PROJECT_ID,ENVIRONMENT_ID,SERVER_ID,EDITOR_SELECTOR,DISCARD_SELECTOR,
  wait,waitFor,waitUntil,click,clickText,fill,openPopup,chooseSelectOption,activateTab,
  assertNoSensitivePayload,
};

// Electron wraps its CommonJS entry, so require.main can differ from this module.
const isDirectEntry = require.main === module || path.resolve(process.argv[1] ?? '') === __filename;
if (isDirectEntry) {
  run()
    .then(async () => {
      await wait(50);
      app.exit(0);
    })
    .catch(async (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      await wait(100);
      app.exit(1);
    });
}
