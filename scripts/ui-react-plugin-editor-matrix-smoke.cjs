const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { app, ipcMain } = require('electron');
const smoke = require('./ui-react-plugin-operations-smoke.cjs');
const {
  state,PROJECT_ID,ENVIRONMENT_ID,SERVER_ID,EDITOR_SELECTOR,DISCARD_SELECTOR,
  wait,waitFor,waitUntil,click,clickText,openPopup,fill,chooseSelectOption,activateTab,
  assertNoSensitivePayload,setExactViewport,captureSurfaceEvidence,
} = smoke;

const calls = [];
const runtimeCalls = [];
const fixtureCredentials = new Map();
let runtimeBehavior = null;
let holdEditProgress = false;
let holdProbeCompletion = false;
const heldEditProgress = [];
let heldProbeReply = null;
let failNextCreate = false;
let failNextProbeCancel = false;
let failNextDelete = false;
const LONG_DIALOG_ERROR = `模拟操作失败：${'ContinuousFixtureDiagnostic'.repeat(60)}`;
const ok = (data) => ({ok:true,data});
const safeScope = (payload) => ({projectId:payload.projectId,environmentId:payload.environmentId});

function assertScope(payload) {
  assert.equal(payload.projectId,PROJECT_ID);
  assert.equal(payload.environmentId,ENVIRONMENT_ID);
}

function secretFields(value) {
  return Object.keys(value ?? {}).sort();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done,fail) => { resolve = done; reject = fail; });
  return {promise,resolve,reject};
}

async function installMatrixApi(win) {
  const [{PluginProbeManager},{PluginEditSessionManager},{WorkspaceMutationCoordinator},{CredentialUseResolver},{workspaceInternals},{AppError,toPublicError}] = await Promise.all([
    import('../src/plugin-probe-manager.mjs'),import('../src/plugin-edit-session-manager.mjs'),
    import('../src/workspace-mutation-coordinator.mjs'),import('../src/credential-use-resolver.mjs'),
    import('../src/workspace-store.mjs'),import('../src/errors.mjs'),
  ]);
  const coordinator = new WorkspaceMutationCoordinator();
  const resolver = new CredentialUseResolver({
    normalizeSecrets:(_draft,values) => Object.fromEntries(Object.entries(values ?? {}).filter(([,value]) => typeof value === 'string' && value.length > 0)),
    load:async (plugin) => ({...(fixtureCredentials.get(plugin.pluginInstanceId) ?? {})}),
  });
  const runtime = {
    validate:async (input) => {
      const {resolvedSecrets,...metadata} = input;
      const record = {
        pluginType:metadata.pluginType,purpose:metadata.purpose,
        draft:structuredClone(metadata.draft),credentialFields:secretFields(resolvedSecrets),
      };
      assertNoSensitivePayload(record,'matrix runtime metadata');
      runtimeCalls.push(record);
      if (runtimeBehavior) return runtimeBehavior(input);
      return input.purpose === 'resource-discovery'
        ? {databases:['inventory','orders'],truncated:true}
        : {reachable:true};
    },
    cleanup:async () => ({cleaned:true}),
  };
  const workspaceStore = {
    getEnvironment:async (projectId,environmentId) => {
      assertScope({projectId,environmentId});
      return {projectId,environmentId};
    },
    listPlugins:async (projectId,environmentId) => {
      assertScope({projectId,environmentId});
      return state.plugins;
    },
  };
  const probe = new PluginProbeManager({workspaceStore,mutationCoordinator:coordinator,credentialUseResolver:resolver,validationRuntime:runtime});
  const edits = new PluginEditSessionManager({
    workspaceStore,mutationCoordinator:coordinator,credentialUseResolver:resolver,validationRuntime:runtime,
    connectionManager:{
      snapshot:() => state.runtime,
      disconnectForConfigurationEdit:async () => ({connectedBefore:[]}),
    },
  });
  const ownerId = 'renderer:plugin-matrix';
  const replace = (channel,handler) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel,async (event,payload) => {
      const {secrets,temporarySecrets,...metadata} = payload ?? {};
      assertNoSensitivePayload(metadata,channel);
      calls.push({channel,payload:structuredClone(metadata),credentialFields:secretFields(temporarySecrets ?? secrets)});
      try { return ok(await handler(payload,event)); }
      catch (error) { return {ok:false,error:toPublicError(error)}; }
    });
  };
  replace('v2:plugin-probe',async (payload,event) => {
    assertScope(payload);
    const result = await probe.probePluginDraft(payload,{
      ownerId,onProgress:(progress) => {
        if (!holdProbeCompletion || progress.state === 'running') event.sender.send('v2:plugin-probe-progress',progress);
      },
    });
    if (holdProbeCompletion) {
      const gate = deferred();
      heldProbeReply = () => gate.resolve(result);
      return gate.promise;
    }
    return result;
  });
  replace('v2:plugin-probe-cancel',(payload) => {
    if (failNextProbeCancel) {
      failNextProbeCancel = false;
      throw new AppError('FIXTURE_CANCEL_FAILED','模拟取消暂时失败，请重试。');
    }
    return probe.cancelPluginProbe(payload,{ownerId});
  });
  replace('v2:plugin-connection-edit-prepare',(payload) => edits.preparePluginConnectionEdit({...payload,ownerId}));
  replace('v2:plugin-connection-edit-begin',(payload) => edits.beginPluginConnectionEdit({...payload,ownerId}));
  replace('v2:plugin-draft-validate',(payload,event) => edits.validatePluginDraft({
    ...payload,ownerId,onProgress:(progress) => {
      const send = () => event.sender.send('v2:plugin-validation-progress',progress);
      if (holdEditProgress) heldEditProgress.push(send);
      else send();
    },
  }));
  replace('v2:plugin-validation-cancel',(payload) => edits.cancelPluginValidation({...payload,ownerId}));
  replace('v2:plugin-connection-edit-cancel',(payload) => payload.prepareToken
    ? edits.cancelPreparation(payload.prepareToken,{ownerId})
    : edits.cancelPluginConnectionEdit({...payload,ownerId}));
  replace('v2:plugin-connection-edit-save',async (payload) => {
    edits.captureCredentialIntent(payload.editSessionId,{...payload,ownerId});
    edits.beginSave(payload.editSessionId,{ownerId});
    const material = edits.commitMaterial(payload.editSessionId,{ownerId});
    const before = state.plugins.find((plugin) => plugin.pluginInstanceId === material.scope.pluginInstanceId);
    assert.equal(payload.expectedRevision,before.revision);
    const next = workspaceInternals.normalizePluginCandidate({...before,...payload.patch},material.scope,before);
    Object.assign(before,next,{revision:before.revision+1});
    fixtureCredentials.set(before.pluginInstanceId,{
      ...(fixtureCredentials.get(before.pluginInstanceId) ?? {}),...material.temporarySecrets,
    });
    await edits.completeSave(payload.editSessionId,{afterCommit:payload.afterCommit,ownerId});
    state.environmentRevision += 1;
    return {committed:true,plugin:before};
  });
  replace('v2:plugin-create',(payload) => {
    assertScope(payload);
    if (failNextCreate) {
      failNextCreate = false;
      throw new AppError('FIXTURE_SAVE_FAILED','模拟保存失败，请重试。');
    }
    const plugin = workspaceInternals.normalizePlugin(payload.input,safeScope(payload));
    Object.assign(plugin,safeScope(payload),{revision:1,configState:'ready',assessment:{phase:'disconnected',primaryStatus:{kind:'disconnected',label:'未连接',action:'connect'}}});
    state.plugins.push(plugin);
    fixtureCredentials.set(plugin.pluginInstanceId,{...(payload.secrets ?? {})});
    state.environmentRevision += 1;
    return plugin;
  });
  replace('v2:plugin-delete',(payload) => {
    assertScope(payload);
    assert.ok(state.plugins.some((plugin) => plugin.pluginInstanceId === payload.pluginInstanceId));
    if (failNextDelete) {
      failNextDelete = false;
      throw new AppError('FIXTURE_DELETE_FAILED',LONG_DIALOG_ERROR);
    }
    state.plugins = state.plugins.filter((plugin) => plugin.pluginInstanceId !== payload.pluginInstanceId);
    state.environmentRevision += 1;
    return {deleted:true,credentialsPreserved:true};
  });
  replace('v2:plugin-metadata-update',(payload) => {
    assertScope(payload);
    assert.ok(state.plugins.some((plugin) => plugin.pluginInstanceId === payload.pluginInstanceId));
    throw new AppError('CONFIG_REVISION_CONFLICT',LONG_DIALOG_ERROR);
  });
  replace('v2:plugin-databases',async (payload) => {
    assertScope(payload);
    const result = payload.editSessionId
      ? await edits.validatePluginDraft({
          ...payload,draft:payload.input,purpose:'resource-discovery',requestId:randomBytes(8).toString('hex'),ownerId,
        })
      : await probe.probePluginDraft({
          ...safeScope(payload),draft:payload.input,temporarySecrets:payload.temporarySecrets,
          purpose:'resource-discovery',formInstanceId:'matrix-discovery',requestId:randomBytes(8).toString('hex'),
          draftGeneration:payload.draftGeneration,sequence:calls.length,
        },{ownerId});
    return result.result;
  });
  replace('v2:plugin-credential-status',(payload) => {
    const saved = fixtureCredentials.get(payload.pluginInstanceId) ?? {};
    return {saved:Object.keys(saved).length > 0,fields:{primary:Boolean(saved.password || saved.privateKeyPassphrase),proxy:Boolean(saved.proxyPassword)},legacyAvailable:false};
  });
  return {probe,edits,AppError};
}

async function openNew(win,kind) {
  await click(win,`[data-testid="add-plugin-${ENVIRONMENT_ID}"]`,'add matrix plugin');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null`,'matrix editor');
  await chooseSelectOption(win,'[aria-label="插件类型"]',kind);
  await fill(win,'#plugin-display-name',`${kind} matrix fixture`);
  await fill(win,'#plugin-host',`${kind.toLowerCase()}.matrix.invalid`);
  if (kind !== 'Redis') await fill(win,'#plugin-username','operator');
}

async function checkPassed(win) {
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent?.includes('检查通过') === true`,'matrix validation success');
}

async function saveAndClose(win) {
  const createCount = calls.filter((call) => call.channel === 'v2:plugin-create').length;
  await click(win,'[data-testid="plugin-save-disconnected"]','matrix disconnected save');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'matrix save closes');
  assert.equal(calls.filter((call) => call.channel === 'v2:plugin-create').length,createCount+1);
  return state.plugins.at(-1).pluginInstanceId;
}

async function discard(win) {
  await click(win,'[data-testid="plugin-editor-cancel"]','close matrix draft');
  await waitFor(win,`document.querySelector(${JSON.stringify(DISCARD_SELECTOR)}) !== null`,'matrix discard confirmation');
  await clickText(win,'放弃更改',DISCARD_SELECTOR);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'matrix draft discarded');
}

async function advanced(win) {
  const trigger = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('高级连接设置'));
    if (!button) return false;
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    return true;
  })()`,true);
  assert.equal(trigger,true);
  await wait(80);
}

async function editPlugin(win,pluginInstanceId) {
  await click(win,`[data-testid="plugin-trigger-${pluginInstanceId}"]`,'matrix plugin select');
  await activateTab(win,'overview');
  await waitFor(win,`document.querySelector('[data-testid="plugin-action-edit"]')?.disabled === false`,'matrix edit action');
  await click(win,'[data-testid="plugin-action-edit"]','matrix edit');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null && document.querySelector('[data-testid="plugin-editor-loading"]') === null`,'matrix edit preparation ready');
  if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,true)) {
    await clickText(win,'继续编辑','[data-testid="plugin-editor-confirmation"]');
  }
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null && document.querySelector('[data-testid="plugin-editor-loading"]') === null`,'matrix edit session ready');
}

async function serverMatrix(win) {
  process.stdout.write('Plugin matrix: Server authentication, proxy defaults and saved credentials\n');
  await openNew(win,'Server');
  const beforeInvalid = runtimeCalls.length;
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('#plugin-primary-credential-error')?.textContent?.includes('SSH 密码') === true`,'missing Server password rejected');
  assert.equal(runtimeCalls.length,beforeInvalid);
  await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','SSH Agent');
  await advanced(win);
  for (const [label,port] of [['SOCKS5 代理',1080],['HTTP 代理',8080]]) {
    await chooseSelectOption(win,'[aria-label="SSH 上行方式"]',label);
    const cleared = await win.webContents.executeJavaScript(`document.querySelector('#plugin-proxy-credential')?.value === ''`,true);
    assert.equal(cleared,true,'switching proxy type must discard the previous hidden credential');
    await fill(win,'#plugin-proxy-host','proxy.matrix.invalid');
    await checkPassed(win);
    assert.equal(runtimeCalls.at(-1).draft.uplink.port,port,'displayed proxy default is actually sent');
    assert.deepEqual(runtimeCalls.at(-1).credentialFields,[]);
    await fill(win,'#plugin-proxy-credential',randomBytes(24).toString('hex'));
  }
  await chooseSelectOption(win,'[aria-label="SSH 上行方式"]','直接连接');
  await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','私钥');
  await fill(win,'#plugin-private-key','C:\\matrix-fixture\\id_ed25519');
  await fill(win,'#plugin-primary-credential',randomBytes(24).toString('hex'));
  await checkPassed(win);
  assert.deepEqual(runtimeCalls.at(-1).credentialFields,['privateKeyPassphrase']);
  await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','SSH Agent');
  await waitFor(win,`document.querySelector('[data-testid="plugin-local-change-confirmation"]') !== null`,'auth change confirmation');
  await clickText(win,'确认更改','[data-testid="plugin-local-change-confirmation"]');
  await checkPassed(win);
  assert.deepEqual(runtimeCalls.at(-1).credentialFields,[],'Agent auth does not send hidden primary or proxy credentials');
  await saveAndClose(win);

  await openNew(win,'Server');
  const savedValue = randomBytes(24).toString('hex');
  await fill(win,'#plugin-primary-credential',savedValue);
  const savedId = await saveAndClose(win);
  await editPlugin(win,savedId);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#plugin-primary-credential')?.value === ''`,true),true,'saved credentials are never displayed');
  await checkPassed(win);
  assert.deepEqual(runtimeCalls.at(-1).credentialFields,['password']);
  await fill(win,'#plugin-primary-credential',randomBytes(24).toString('hex'));
  await checkPassed(win);
  await fill(win,'#plugin-primary-credential','');
  runtimeBehavior = async (input) => {
    assert.equal(input.resolvedSecrets.password === savedValue,true,'clearing temporary input returns validation to the saved credential');
    return {reachable:true};
  };
  await checkPassed(win);
  await click(win,'[data-testid="plugin-save-disconnected"]','save cleared temporary credential');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'saved credential edit closes');
  assert.equal(fixtureCredentials.get(savedId).password === savedValue,true,'cleared temporary credentials must not overwrite the stored fixture');
  runtimeBehavior = null;
}

async function discoveryMatrix(win) {
  process.stdout.write('Plugin matrix: MySQL result envelope, late discovery and tunnel editing\n');
  await openNew(win,'MySQL');
  const beforeInvalid = runtimeCalls.length;
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('#plugin-database-error')?.textContent?.includes('数据库') === true`,'missing fixed database rejected');
  assert.equal(runtimeCalls.length,beforeInvalid);
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[aria-label="选择可见数据库"]') !== null`,'real discovery envelope becomes selectable options');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}).textContent.includes('前 200 项')`,true),true,'truncated discovery is visibly labelled');
  await chooseSelectOption(win,'[aria-label="选择可见数据库"]','orders');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#plugin-database').value === 'orders'`,true),true);

  for (const change of ['host','credential','failure']) {
    const gate = deferred();
    runtimeBehavior = () => gate.promise;
    if (change !== 'host') await fill(win,'#plugin-primary-credential',randomBytes(24).toString('hex'));
    const start = runtimeCalls.length;
    await clickText(win,'读取数据库',EDITOR_SELECTOR);
    await waitUntil(() => runtimeCalls.length === start+1,'deferred discovery reaches real manager');
    if (change === 'host') await fill(win,'#plugin-host','changed.mysql.matrix.invalid');
    else await fill(win,'#plugin-primary-credential',randomBytes(24).toString('hex'));
    await waitFor(win,`[...document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR+' button')})].some((button) => button.textContent.trim() === '读取数据库' && !button.disabled)`,'editing a discovery input releases its controls');
    if (change === 'failure') gate.reject(new Error('Superseded discovery failure fixture'));
    else gate.resolve({databases:['stale-result'],truncated:false});
    await wait(150);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="选择可见数据库"]') === null`,true),true,'old discovery does not repopulate options');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}).textContent.includes('Superseded discovery failure fixture')`,true),false,'late discovery errors do not overwrite the changed draft');
  }
  runtimeBehavior = null;
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[aria-label="选择可见数据库"]') !== null`,'discovery retry after input changes');
  await chooseSelectOption(win,'[aria-label="选择可见数据库"]','orders');
  await advanced(win);
  await chooseSelectOption(win,'[aria-label="连接路径"]','Server 隧道');
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('#plugin-tunnel-server-error')?.textContent?.includes('Server') === true`,'missing tunnel target rejected');
  await chooseSelectOption(win,'[aria-label="隧道 Server"]',state.plugins.find((plugin) => plugin.pluginInstanceId === SERVER_ID).displayName);
  await checkPassed(win);
  assert.equal(runtimeCalls.at(-1).draft.transport.serverPluginInstanceId,SERVER_ID);
  const savedId = await saveAndClose(win);
  await editPlugin(win,savedId);
  await fill(win,'#plugin-database','inventory');
  await checkPassed(win);
  assert.equal(runtimeCalls.at(-1).draft.target.database,'inventory');
  await click(win,'[data-testid="plugin-save-disconnected"]','save edited MySQL database');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'MySQL edit committed');
}

async function cancellationMatrix(win,{probe,AppError}) {
  process.stdout.write('Plugin matrix: exact cancellation, late success and duplicate save\n');
  await openNew(win,'Redis');
  holdProbeCompletion = true;
  const createsBefore = calls.filter((call) => call.channel === 'v2:plugin-create').length;
  await click(win,'[data-testid="plugin-save-disconnected"]','begin a save whose probe response is delayed');
  await waitUntil(() => heldProbeReply !== null,'probe finishes before its IPC response is delivered');
  assert.equal(probe.requests.size,0);
  await clickText(win,'取消检查','[data-testid="plugin-validation-progress"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent?.includes('已取消') === true`,'cancelled probe UI');
  heldProbeReply();
  heldProbeReply = null;
  holdProbeCompletion = false;
  await wait(150);
  assert.equal(calls.filter((call) => call.channel === 'v2:plugin-create').length,createsBefore,'late probe success after cancellation must not save');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null`,true),true);
  const duplicateStart = calls.filter((call) => call.channel === 'v2:plugin-probe').length;
  await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-testid="plugin-save-disconnected"]');
    button.click();button.click();
  })()`,true);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'duplicate save activation completes once');
  assert.equal(calls.filter((call) => call.channel === 'v2:plugin-create').length,createsBefore+1);
  assert.equal(calls.filter((call) => call.channel === 'v2:plugin-probe').length,duplicateStart+1);

  await editPlugin(win,SERVER_ID);
  holdEditProgress = true;
  runtimeBehavior = ({signal}) => new Promise((_resolve,reject) => {
    signal.addEventListener('abort',() => reject(signal.reason ?? new AppError('PLUGIN_VALIDATION_CANCELLED','fixture cancellation')),{once:true});
  });
  const runtimeBefore = runtimeCalls.length;
  const wrongRouteBefore = calls.filter((call) => call.channel === 'v2:plugin-probe-cancel').length;
  const editCancelBefore = calls.filter((call) => call.channel === 'v2:plugin-validation-cancel').length;
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitUntil(() => runtimeCalls.length === runtimeBefore+1,'real edit validation is running before progress reaches Renderer');
  await clickText(win,'取消检查','[data-testid="plugin-validation-progress"]');
  assert.equal(calls.filter((call) => call.channel === 'v2:plugin-probe-cancel').length,wrongRouteBefore,'existing edits never cancel through the new-plugin probe API');
  holdEditProgress = false;
  heldEditProgress.splice(0).forEach((send) => send());
  await waitUntil(() => calls.filter((call) => call.channel === 'v2:plugin-validation-cancel').length === editCancelBefore+1,'queued edit cancellation binds the received operation ID');
  await waitFor(win,`document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent?.includes('已取消') === true`,'cancelled edit remains cancelled after late progress');
  runtimeBehavior = null;
  await checkPassed(win);
  await click(win,'[data-testid="plugin-editor-cancel"]','close unchanged edit after cancellation retry');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'edit cleanup releases its exact session');

  await openNew(win,'Redis');
  runtimeBehavior = ({signal}) => new Promise((_resolve,reject) => {
    signal.addEventListener('abort',() => reject(signal.reason),{once:true});
  });
  failNextProbeCancel = true;
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitUntil(() => probe.requests.size === 1,'cancellable new-plugin runtime');
  await clickText(win,'取消检查','[data-testid="plugin-validation-progress"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('模拟取消暂时失败') === true`,'cancel failure is visible and retryable');
  await discard(win);
  await waitUntil(() => probe.requests.size === 0,'closing after a failed cancellation still cleans up the probe');
  runtimeBehavior = null;
}

async function recoveryMatrix(win,{AppError}) {
  process.stdout.write('Plugin matrix: TLS/host-key approvals, invalid Redis DB and save retry\n');
  await openNew(win,'Redis');
  await fill(win,'#plugin-redis-db','16');
  const invalidBefore = runtimeCalls.length;
  await clickText(win,'检查连接',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('#plugin-redis-db-error')?.textContent?.includes('15') === true`,'out-of-range Redis DB rejected');
  assert.equal(runtimeCalls.length,invalidBefore);
  await fill(win,'#plugin-redis-db','3');
  await advanced(win);
  await chooseSelectOption(win,'[aria-label="TLS 模式"]','必须加密');
  runtimeBehavior = async ({draft}) => {
    if (draft.tls.mode !== 'disabled') throw new AppError('TLS_UNSUPPORTED','fixture target does not support TLS');
    return {reachable:true};
  };
  const beforeTls = state.plugins.length;
  await click(win,'[data-testid="plugin-save-disconnected"]','save with explicit TLS fallback');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]')?.textContent?.includes('目标不支持 TLS') === true`,'TLS fallback requires approval');
  assert.equal(state.plugins.length,beforeTls);
  await assertPendingTlsDecision(win);
  const beforeTlsRejection = runtimeCalls.length;
  await clickText(win,'取消','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'TLS fallback rejection closes the prompt');
  assert.equal(runtimeCalls.length,beforeTlsRejection,'rejecting TLS fallback must not retry or downgrade the connection');
  assert.equal(state.plugins.length,beforeTls,'rejecting TLS fallback must not save the draft');
  await click(win,'[data-testid="plugin-save-disconnected"]','request TLS fallback approval again');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,'fresh TLS approval');
  assert.equal(runtimeCalls.at(-1).draft.tls.mode,'required','rejected TLS fallback preserves encryption');
  await clickText(win,'关闭 TLS 并重试','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'approved TLS fallback retries and saves');
  assert.equal(state.plugins.at(-1).target.db,3);
  assert.equal(state.plugins.at(-1).tls.mode,'disabled');
  runtimeBehavior = null;

  await openNew(win,'MySQL');
  await fill(win,'#plugin-database','fixture');
  await advanced(win);
  await chooseSelectOption(win,'[aria-label="TLS 模式"]','必须加密');
  runtimeBehavior = async ({draft}) => {
    if (draft.tls.mode !== 'disabled') throw new AppError('TLS_UNSUPPORTED','fixture target does not support TLS');
    throw new AppError('MYSQL_AUTH_FAILED','模拟 TLS 确认后的认证失败');
  };
  const beforeTlsFailure = state.plugins.length;
  await click(win,'[data-testid="plugin-save-disconnected"]','request TLS fallback before a real authentication failure');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,'MySQL TLS fallback approval');
  await assertPendingTlsDecision(win);
  await clickText(win,'关闭 TLS 并重试','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-error"]')?.textContent.includes('模拟 TLS 确认后的认证失败') === true`,'real errors after approved TLS fallback remain visible');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'TLS prompt closes after a failed approved retry');
  assert.equal(state.plugins.length,beforeTlsFailure,'failed TLS retry must not save the plugin');
  await discard(win);
  runtimeBehavior = null;

  await openNew(win,'Server');
  await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','SSH Agent');
  const fingerprint = `SHA256:${'Ab3dEf7x'.repeat(5)}Ab3`;
  runtimeBehavior = async ({draft}) => {
    if (draft.target.hostKeyFingerprint !== fingerprint) throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','fixture fingerprint requires approval',{
      host:draft.target.host,port:draft.target.port,fingerprint,algorithm:'ssh-ed25519',
    });
    return {reachable:true};
  };
  await click(win,'[data-testid="plugin-save-disconnected"]','save with explicit host-key trust');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]')?.textContent?.includes('确认服务器指纹') === true`,'host-key draft challenge');
  await assertDraftHostKeyConfirmation(win,fingerprint);
  const beforeTrust = state.plugins.length;
  const beforeRejectRuntime = runtimeCalls.length;
  await clickText(win,'取消','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'draft host-key rejection closes the prompt');
  assert.equal(state.plugins.length,beforeTrust,'rejecting a fingerprint must not save the draft');
  assert.equal(runtimeCalls.length,beforeRejectRuntime,'rejecting a fingerprint must not retry the connection');
  await click(win,'[data-testid="plugin-save-disconnected"]','request fingerprint approval again');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,'fresh host-key approval');
  assert.equal(runtimeCalls.at(-1).draft.target.hostKeyFingerprint,undefined,'rejecting a fingerprint must not trust it');
  await clickText(win,'信任此指纹','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'trusted fingerprint retries and saves');
  assert.equal(state.plugins.length,beforeTrust+1,'explicit fingerprint approval saves exactly once');
  assert.equal(state.plugins.at(-1).target.hostKeyFingerprint,fingerprint);
  runtimeBehavior = null;

  await openNew(win,'Server');
  await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','SSH Agent');
  await fill(win,'#plugin-host',`${'w'.repeat(63)}.${'m'.repeat(63)}.${'a'.repeat(63)}.invalid`);
  runtimeBehavior = async ({draft}) => {
    if (draft.target.hostKeyFingerprint !== fingerprint) throw new AppError('SSH_HOST_KEY_CONFIRM_REQUIRED','fixture fingerprint requires approval',{
      host:draft.target.host,port:draft.target.port,fingerprint,algorithm:'ssh-ed25519',
    });
    throw new AppError('SSH_AUTH_FAILED','模拟指纹确认后的认证失败');
  };
  await click(win,'[data-testid="plugin-save-disconnected"]','check a host whose authentication will fail after trust');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,'authentication fixture fingerprint approval');
  await assertDraftHostKeyConfirmation(win,fingerprint,{capture:false});
  const beforeAuthFailure = state.plugins.length;
  await clickText(win,'信任此指纹','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('模拟指纹确认后的认证失败') === true`,'real failure after fingerprint approval remains visible');
  assert.equal(state.plugins.length,beforeAuthFailure,'failed authentication must not save the plugin');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'failed authentication closes the fingerprint prompt');
  await discard(win);
  runtimeBehavior = null;

  await openNew(win,'Redis');
  failNextCreate = true;
  await click(win,'[data-testid="plugin-save-disconnected"]','trigger recoverable save failure');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('模拟保存失败') === true`,'save failure stays visible without closing the draft');
  const savedId = await saveAndClose(win);
  await editPlugin(win,savedId);
  await fill(win,'#plugin-redis-db','7');
  await click(win,'[data-testid="plugin-save-disconnected"]','save edited Redis DB');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'Redis edit committed');
  assert.equal(state.plugins.find((plugin) => plugin.pluginInstanceId === savedId).target.db,7);
}

async function assertPendingTlsDecision(win) {
  const presentation = await win.webContents.executeJavaScript(`({
    error:document.querySelector('[data-testid="plugin-editor-confirmation"] [role="alert"]') !== null,
    progress:document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent,
  })`,true);
  assert.equal(presentation.error,false,'TLS fallback is a pending decision, not an operation failure');
  assert.match(presentation.progress,/等待确认/u);
  assert.doesNotMatch(presentation.progress,/检查失败|指纹|fixture target/u);
}

async function assertDraftHostKeyConfirmation(win,fingerprint,{capture = true} = {}) {
  const selector = '[data-testid="plugin-editor-confirmation"]';
  for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
    await setExactViewport(win,width,height);
    await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true);
    const geometry = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector(${JSON.stringify(selector)});
      const rect = dialog.getBoundingClientRect();
      const inside = (child) => child.left >= rect.left-1 && child.right <= rect.right+1
        && child.top >= rect.top-1 && child.bottom <= rect.bottom+1;
      const parts = [...dialog.querySelectorAll('[data-slot="alert-dialog-header"],[data-slot="alert-dialog-description"],[data-slot="alert-dialog-footer"],button')];
      const description = dialog.querySelector('[data-slot="alert-dialog-description"]');
      const range = document.createRange();
      range.selectNodeContents(description);
      return {
        insideViewport:rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        contentInside:parts.every((part) => inside(part.getBoundingClientRect())),
        textInside:[...range.getClientRects()].every(inside),
        horizontalOverflow:dialog.scrollWidth-dialog.clientWidth,
        fingerprintVisible:description.textContent.includes(${JSON.stringify(fingerprint)}),
        errorVisible:dialog.querySelector('[role="alert"]') !== null,
        progress:document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent,
      };
    })()`,true);
    assert.equal(geometry.insideViewport,true,`draft host-key dialog stays inside ${width}x${height}`);
    assert.equal(geometry.contentInside,true,'draft host-key content and buttons must stay inside the dialog');
    assert.equal(geometry.textInside,true,'draft host-key fingerprint must wrap inside the dialog');
    assert.ok(geometry.horizontalOverflow <= 1,'draft host-key dialog must not overflow horizontally');
    assert.equal(geometry.fingerprintVisible,true,'the full fingerprint must remain available for verification');
    assert.equal(geometry.errorVisible,false,'waiting for initial fingerprint approval is not an operation failure');
    assert.match(geometry.progress,/等待确认/u);
    assert.doesNotMatch(geometry.progress,/检查失败|fixture fingerprint requires approval/u);
  }
  if (capture) {
    await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'previous fixture save notification expires before the approval screenshot');
    await captureSurfaceEvidence(win,{name:'draft-host-key-confirmation',selector});
  }
  await setExactViewport(win,960,640);
}

async function deleteMatrixPlugin(win,pluginInstanceId) {
  await click(win,`[data-testid="plugin-trigger-${pluginInstanceId}"]`,'select exact deletion target');
  await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${pluginInstanceId}"]')?.getAttribute('aria-current') === 'page'`,'deletion scope selected');
  await openPopup(win,'[data-testid="detail-scope-actions"]','matrix scoped actions');
  await clickText(win,'删除插件','body','[role="menuitem"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') !== null`,'matrix delete confirmation');
  await clickText(win,'删除插件','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null && document.querySelector('[data-testid="plugin-trigger-${pluginInstanceId}"]') === null`,'confirmed deletion refreshes the exact scope');
  assert.equal(state.plugins.some((plugin) => plugin.pluginInstanceId === pluginInstanceId),false);
}

async function assertLongDialogContent(win,selector,expectedText) {
  for (const [width,height] of [[960,640],[1280,820]]) {
    await setExactViewport(win,width,height);
    await win.webContents.capturePage();
    const geometry = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector(${JSON.stringify(selector)});
      const bounds = dialog.getBoundingClientRect();
      const texts = [...dialog.querySelectorAll('[data-slot="alert-dialog-title"],[data-slot="alert-dialog-description"],[data-slot="alert-description"],[data-slot="field-error"],[data-slot="item-title"]')];
      const insideX = (rect) => rect.left >= bounds.left-1 && rect.right <= bounds.right+1;
      return {
        insideViewport:bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
        overflow:dialog.scrollWidth-dialog.clientWidth,
        overflowingParts:[...dialog.querySelectorAll('[data-slot]')].filter((element) => element.scrollWidth > element.clientWidth+1).map((element) => ({slot:element.dataset.slot,width:element.clientWidth,scrollWidth:element.scrollWidth,display:getComputedStyle(element).display,wrap:getComputedStyle(element).overflowWrap})),
        fullText:dialog.textContent.includes(${JSON.stringify(expectedText)}),
        textInside:texts.every((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return element.scrollWidth <= element.clientWidth+1 && [...range.getClientRects()].every(insideX);
        }),
      };
    })()`,true);
    assert.equal(geometry.insideViewport,true,'long plugin dialog stays within the viewport');
    assert.ok(geometry.overflow <= 1,`long plugin dialog has no horizontal overflow: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.fullText,true,'long plugin text must not be truncated or removed');
    assert.equal(geometry.textInside,true,'long plugin names and errors wrap within the dialog');
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.querySelector('[data-slot="alert-dialog-footer"],[data-slot="dialog-footer"]')?.scrollIntoView({block:'end'})`,true);
    const actionsReachable = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector(${JSON.stringify(selector)});
      return [...dialog.querySelectorAll('[data-slot="alert-dialog-footer"] button,[data-slot="dialog-footer"] button')].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && (button.disabled || button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)));
      });
    })()`,true);
    assert.equal(actionsReachable,true,'long plugin dialog actions remain reachable by scrolling');
  }
  await setExactViewport(win,960,640);
}

async function longContentMatrix(win) {
  process.stdout.write('Plugin matrix: long deletion titles, delete errors and metadata errors\n');
  const longName = 'W'.repeat(120);
  let dependent = state.plugins.find((plugin) => plugin.transport?.serverPluginInstanceId === SERVER_ID);
  if (!dependent) {
    await openNew(win,'Redis');
    await advanced(win);
    await chooseSelectOption(win,'[aria-label="连接路径"]','Server 隧道');
    await chooseSelectOption(win,'[aria-label="隧道 Server"]',state.plugins.find((plugin) => plugin.pluginInstanceId === SERVER_ID).displayName);
    const dependentId = await saveAndClose(win);
    dependent = state.plugins.find((plugin) => plugin.pluginInstanceId === dependentId);
  }
  assert.ok(dependent,'the matrix contains a Server tunnel dependent');
  const originalDependentName = dependent.displayName;
  dependent.displayName = longName;
  const listFixtures = Array.from({length:6},(_,index) => ({...structuredClone(dependent),pluginInstanceId:`dialog-list-fixture-${index}`,displayName:`Dependent fixture ${index}`}));
  state.plugins.push(...listFixtures);
  const reloadFixtures = async () => {
    await win.loadFile(path.join(__dirname,'..','renderer-build','v2','index.html'));
    await waitFor(win,`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]') !== null`,'reloaded plugin fixtures');
  };
  await reloadFixtures();
  await click(win,`[data-testid="plugin-trigger-${SERVER_ID}"]`,'select Server with a long-name dependent');
  await openPopup(win,'[data-testid="detail-scope-actions"]','blocked Server deletion actions');
  await clickText(win,'删除插件','body','[role="menuitem"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]')?.textContent.includes('暂时不能删除') === true`,'dependent blocks Server deletion');
  const dependencyList = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[data-testid="plugin-delete-dialog"]');
    const viewport = dialog.querySelector('[data-slot="scroll-area-viewport"]');
    const item = dialog.querySelector('[data-slot="item-title"]');
    return {height:viewport.clientHeight,contentHeight:viewport.scrollHeight,disabled:dialog.querySelector('[data-slot="alert-dialog-action"]').disabled,itemWidth:item.clientWidth,itemScrollWidth:item.scrollWidth,itemLength:item.textContent.length};
  })()`,true);
  assert.equal(dependencyList.disabled,true,'long names must not bypass Server dependency protection');
  assert.ok(dependencyList.height <= 128 && dependencyList.contentHeight > dependencyList.height,`long dependency lists must use a bounded, scrollable viewport: ${JSON.stringify(dependencyList)}`);
  await assertLongDialogContent(win,'[data-testid="plugin-delete-dialog"]',longName);
  await clickText(win,'取消','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null`,'cancel blocked Server deletion');
  dependent.displayName = originalDependentName;
  state.plugins = state.plugins.filter((plugin) => !listFixtures.includes(plugin));
  await reloadFixtures();
  await openNew(win,'Redis');
  await fill(win,'#plugin-display-name',longName);
  const pluginInstanceId = await saveAndClose(win);
  const openDelete = async () => {
    await click(win,`[data-testid="plugin-trigger-${pluginInstanceId}"]`,'select long-name plugin');
    await openPopup(win,'[data-testid="detail-scope-actions"]','long-name plugin actions');
    await clickText(win,'删除插件','body','[role="menuitem"]');
    await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') !== null`,'long-name deletion confirmation');
  };
  await openDelete();
  await assertLongDialogContent(win,'[data-testid="plugin-delete-dialog"]',longName);
  failNextDelete = true;
  await clickText(win,'删除插件','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"] [role="alert"]') !== null`,'long plugin deletion error');
  await assertLongDialogContent(win,'[data-testid="plugin-delete-dialog"]',LONG_DIALOG_ERROR);
  await clickText(win,'取消','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null`,'cancel failed plugin deletion');
  assert.ok(state.plugins.some((plugin) => plugin.pluginInstanceId === pluginInstanceId),'a failed delete and cancellation retain the plugin');
  await openPopup(win,'[data-testid="detail-scope-actions"]','long-name plugin metadata actions');
  await clickText(win,'修改名称','body','[role="menuitem"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-metadata-dialog"]') !== null`,'plugin metadata dialog');
  await fill(win,'#plugin-metadata-name','Changed fixture name');
  await clickText(win,'保存名称','[data-testid="plugin-metadata-dialog"]');
  await waitFor(win,`document.querySelector('#plugin-metadata-name-error')?.textContent.includes('模拟操作失败') === true`,'long plugin metadata error');
  await assertLongDialogContent(win,'[data-testid="plugin-metadata-dialog"]',LONG_DIALOG_ERROR);
  await clickText(win,'取消','[data-testid="plugin-metadata-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-metadata-dialog"]') === null`,'cancel failed plugin rename');
  assert.equal(state.plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId).displayName,longName,'failed metadata update preserves the plugin name');
}

async function deletionMatrix(win) {
  process.stdout.write('Plugin matrix: all plugin kinds delete/re-add, then first MySQL in an empty environment\n');
  for (const [type,label] of [['mysql','MySQL'],['redis','Redis'],['server','Server']]) {
    const before = state.plugins.findLast((plugin) => plugin.pluginType === type);
    await deleteMatrixPlugin(win,before.pluginInstanceId);
    await openNew(win,label);
    if (type === 'server') await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','SSH Agent');
    if (type === 'mysql') await fill(win,'#plugin-database','orders');
    const nextId = await saveAndClose(win);
    assert.notEqual(nextId,before.pluginInstanceId,'re-add must not reuse a deleted plugin identity or its credentials');
    assert.deepEqual(secretFields(fixtureCredentials.get(nextId)),[]);
  }
  // Delete dependents first so the UI's Server dependency guard remains intact.
  const remaining = [...state.plugins].sort((left,right) => Number(left.pluginType === 'server')-Number(right.pluginType === 'server'));
  for (const plugin of remaining) await deleteMatrixPlugin(win,plugin.pluginInstanceId);
  assert.equal(state.plugins.length,0);
  await openNew(win,'MySQL');
  await fill(win,'#plugin-database','first_database');
  await checkPassed(win);
  const pluginInstanceId = await saveAndClose(win);
  assert.equal(state.plugins.length,1);
  assert.equal(state.plugins[0].pluginInstanceId,pluginInstanceId);
  assert.equal(state.plugins[0].pluginType,'mysql');
}

async function matrix(win) {
  const {probe,edits,AppError} = await installMatrixApi(win);
  if (app.commandLine.hasSwitch('dialog-content-only')) {
    await longContentMatrix(win);
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    process.stdout.write('Plugin dialog long-content regression passed\n');
    return;
  }
  await serverMatrix(win);
  await discoveryMatrix(win);
  await cancellationMatrix(win,{probe,edits,AppError});
  await recoveryMatrix(win,{AppError});
  await longContentMatrix(win);
  await deletionMatrix(win);
  assert.equal(probe.requests.size,0,'all temporary probes are cleaned up');
  assert.equal(edits.sessions.size,0,'all edit sessions are committed or cancelled');
  for (const call of calls) assertNoSensitivePayload(call,'matrix evidence');
  for (const call of runtimeCalls) assertNoSensitivePayload(call,'matrix runtime evidence');
  process.stdout.write(`Plugin editor matrix passed (${calls.length} scoped IPC calls; ${runtimeCalls.length} real-manager validations; no credentials logged)\n`);
}

smoke.runScenario(matrix).then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
