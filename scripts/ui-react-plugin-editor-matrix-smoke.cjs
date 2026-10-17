const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { app, ipcMain, nativeTheme } = require('electron');
const smoke = require('./ui-react-plugin-operations-smoke.cjs');
const {
  state,PROJECT_ID,ENVIRONMENT_ID,SERVER_ID,EDITOR_SELECTOR,DISCARD_SELECTOR,
  wait,waitFor,waitUntil,click,clickText,openPopup,fill,chooseSelectOption,activateTab,
  assertNoSensitivePayload,setExactViewport,
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
let retainDraftAfterValidation = false;
let failNextProbeCancel = false;
let failNextDelete = false;
let holdCredentialReveal = false;
let releaseCredentialReveal = null;
let failNextCredentialReveal = false;
let unreadableMysqlCredentials = false;
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
  const [{PluginProbeManager},{PluginEditSessionManager},{WorkspaceMutationCoordinator},{CredentialUseResolver},{workspaceInternals},{AppError,toPublicError},{registerV2Ipc}] = await Promise.all([
    import('../src/plugin-probe-manager.mjs'),import('../src/plugin-edit-session-manager.mjs'),
    import('../src/workspace-mutation-coordinator.mjs'),import('../src/credential-use-resolver.mjs'),
    import('../src/workspace-store.mjs'),import('../src/errors.mjs'),import('../src/ipc-v2.mjs'),
  ]);
  const coordinator = new WorkspaceMutationCoordinator();
  const {mysqlPluginGroup,mysqlGroupMembers,mysqlGroupTags,mysqlSharedConnection,withoutMysqlGroupTags} = await import('../src/mysql-plugin-group.mjs');
  const {bindMysqlConnection,createMysqlConnection} = await import('../src/mysql-connection-profile.mjs');
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
    getPlugin:async (projectId,environmentId,pluginInstanceId) => {
      assertScope({projectId,environmentId});
      const plugin = state.plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
      if (!plugin) throw new AppError('PLUGIN_NOT_FOUND','测试插件不存在。');
      return plugin;
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
  const ownerId = `renderer:${win.webContents.id}`;
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
    if (retainDraftAfterValidation) throw new AppError('FIXTURE_SAVE_RETRY','模拟持久化失败，保留草稿以继续检查输入组合。');
    edits.captureCredentialIntent(payload.editSessionId,{...payload,ownerId});
    edits.beginSave(payload.editSessionId,{ownerId});
    const material = edits.commitMaterial(payload.editSessionId,{ownerId});
    const before = state.plugins.find((plugin) => plugin.pluginInstanceId === material.scope.pluginInstanceId);
    assert.equal(payload.expectedRevision,before.revision);
    if (unreadableMysqlCredentials && mysqlPluginGroup(before)) {
      if (payload.forceCredentialReplacement !== true) {
        edits.saveFailed(payload.editSessionId);
        throw new AppError('CREDENTIAL_REPLACEMENT_INCOMPLETE','合成凭据不可读，旧凭据已保留，需要明确确认替换。');
      }
      unreadableMysqlCredentials = false;
    }
    const next = workspaceInternals.normalizePluginCandidate({...before,...payload.patch},material.scope,before,undefined,{hostKeyTrust:material.hostKeyTrust});
    Object.assign(before,next,{revision:before.revision+1});
    fixtureCredentials.set(before.pluginInstanceId,{
      ...(fixtureCredentials.get(before.pluginInstanceId) ?? {}),...material.temporarySecrets,
    });
    if (mysqlPluginGroup(before)) {
      assert.equal(payload.applyToMysqlGroup,true);
      const original = mysqlGroupMembers(before,state.plugins);
      for (const member of original.filter(item => item !== before)) {
        Object.assign(member,workspaceInternals.normalizePlugin(mysqlSharedConnection(before),material.scope,member));
        fixtureCredentials.set(member.pluginInstanceId,{...fixtureCredentials.get(before.pluginInstanceId)});
      }
      if (payload.databases) {
        for (const member of original.filter(item => !payload.databases.includes(item.target.database))) Object.assign(member,bindMysqlConnection(member,createMysqlConnection(member)));
        for (const database of payload.databases.filter(database => !original.some(item => item.target.database === database))) {
          const child = workspaceInternals.normalizePlugin({...before,pluginInstanceId:`mysql-${randomUUID()}`,target:{...before.target,database}},material.scope);
          state.plugins.push(child);
          fixtureCredentials.set(child.pluginInstanceId,{...fixtureCredentials.get(before.pluginInstanceId)});
        }
      }
    }
    await edits.completeSave(payload.editSessionId,{afterCommit:payload.afterCommit,ownerId});
    state.environmentRevision += 1;
    return {committed:true,plugin:before};
  });
  replace('v2:plugin-create',(payload) => {
    if (retainDraftAfterValidation) throw new AppError('FIXTURE_SAVE_RETRY','模拟持久化失败，保留草稿以继续检查输入组合。');
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
  replace('v2:mysql-plugin-batch-create',payload => {
    assertScope(payload);
    const tags = mysqlGroupTags([],randomUUID(),payload.groupName);
    const plugins = payload.databases.map((database,index) => workspaceInternals.normalizePlugin({...payload.input,tags,
      pluginInstanceId:index === 0 ? payload.input.pluginInstanceId : `mysql-${randomUUID()}`,
      displayName:`${payload.groupName} · ${database}`,target:{...payload.input.target,database}},safeScope(payload)));
    const connection = createMysqlConnection(plugins[0],{name:payload.groupName});
    for (const plugin of plugins) Object.assign(plugin,bindMysqlConnection(plugin,connection));
    state.plugins.push(...plugins);
    for (const plugin of plugins) fixtureCredentials.set(plugin.pluginInstanceId,{...payload.secrets});
    state.environmentRevision += 1;
    return {plugin:plugins[0],plugins,createdCount:plugins.length};
  });
  replace('v2:mysql-plugin-group-describe',payload => {
    const plugin = state.plugins.find(item => item.pluginInstanceId === payload.pluginInstanceId);
    return {...mysqlPluginGroup(plugin),revision:plugin.mysqlConnectionRevision ?? 1,members:mysqlGroupMembers(plugin,state.plugins).map(item => ({...item,database:item.target.database})),connectionInconsistent:false,credentialsInconsistent:false,credentialsUnreadable:false};
  });
  replace('v2:mysql-connection-delete',payload => {
    assertScope(payload);
    const plugin = state.plugins.find(item => item.pluginInstanceId === payload.pluginInstanceId);
    const group = mysqlPluginGroup(plugin);
    const members = mysqlGroupMembers(plugin,state.plugins);
    assert.equal(payload.expectedConnectionId,group.id);
    assert.equal(payload.expectedRevision,plugin.mysqlConnectionRevision ?? 1);
    const versions = items => items.map(({pluginInstanceId,revision}) => ({pluginInstanceId,revision})).sort((a,b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId));
    if (JSON.stringify(versions(members)) !== JSON.stringify(versions(payload.expectedMembers))) throw new AppError('CONFIG_REVISION_CONFLICT','数据库组或成员已变化，请重新打开删除确认。');
    const ids = members.map(item => item.pluginInstanceId);
    state.plugins = state.plugins.filter(item => !ids.includes(item.pluginInstanceId));
    state.environmentRevision += 1;
    for (const id of ids) {
      delete state.runtime.plugins[id];
      win.webContents.send('v2:workspace-changed',{type:'plugin-deleted',projectId:PROJECT_ID,environmentId:ENVIRONMENT_ID,pluginInstanceId:id});
    }
    return {committed:true,deletedPluginInstanceIds:ids,deletedCount:ids.length,credentialsPreserved:true};
  });
  replace('v2:mysql-connection-intent',payload => {
    assertScope(payload);
    const plugin = state.plugins.find(item => item.pluginInstanceId === payload.pluginInstanceId);
    const members = mysqlGroupMembers(plugin,state.plugins);
    assert.ok(members.length > 0);
    const phase = payload.intent === 'connect' ? 'connected' : 'disconnected';
    for (const member of members) {
      state.runtime.plugins[member.pluginInstanceId] = {pluginInstanceId:member.pluginInstanceId,phase,
        assessment:{phase,primaryStatus:{kind:phase,label:phase === 'connected' ? '已连接' : '未连接'}}};
    }
    state.runtime.sequence += 1;
    state.runtime.connectedCount = Object.values(state.runtime.plugins).filter(item => item.phase === 'connected').length;
    state.runtime.eligibleCount = state.plugins.length;
    state.runtime.phase = state.runtime.connectedCount > 0 ? 'partial' : 'disconnected';
    win.webContents.send('v2:environment-status-changed',structuredClone(state.runtime));
    return {outcome:'started'};
  });
  replace('v2:mysql-plugin-group-detach',payload => {
    const plugin = state.plugins.find(item => item.pluginInstanceId === payload.pluginInstanceId);
    plugin.tags = withoutMysqlGroupTags(plugin.tags);
    plugin.revision += 1;
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
  // 数据库发现复用真实 IPC 入口，避免模拟实现绕过编辑门禁而漏报回归。
  let discoverDatabases;
  registerV2Ipc({handle:(channel,handler) => {
    if (channel === 'v2:plugin-databases') discoverDatabases = handler;
  },on:() => undefined},{
    workspaceStore,mutationCoordinator:coordinator,credentialUseResolver:resolver,pluginEditSessionManager:edits,
    connectionManager:{on:() => undefined},confirmationManager:{on:() => undefined},
    mysqlRuntime:{listDatabases:(draft,resolvedSecrets) => runtime.validate({
      pluginType:'mysql',purpose:'resource-discovery',draft,resolvedSecrets,
    })},
  });
  replace('v2:plugin-databases',async (payload,event) => {
    assertScope(payload);
    const result = await discoverDatabases(event,payload);
    if (!result.ok) throw new AppError(result.error.code,result.error.message,result.error.details);
    return result.data;
  });
  replace('v2:plugin-credential-status',(payload) => {
    const saved = fixtureCredentials.get(payload.pluginInstanceId) ?? {};
    return {saved:Object.keys(saved).length > 0,fields:{primary:Boolean(saved.password || saved.privateKeyPassphrase),proxy:Boolean(saved.proxyPassword)},legacyAvailable:false};
  });
  replace('v2:plugin-credential-reveal',async (payload) => {
    assertScope(payload);
    assert.deepEqual(Object.keys(payload).sort(),['environmentId','field','pluginInstanceId','projectId']);
    if (failNextCredentialReveal) {
      failNextCredentialReveal = false;
      throw new AppError('CREDENTIAL_DECRYPT_FAILED','模拟本机凭据无法解密。');
    }
    const value = fixtureCredentials.get(payload.pluginInstanceId)?.[payload.field];
    if (!value) throw new AppError('CREDENTIAL_NOT_FOUND','该密码尚未保存。');
    if (holdCredentialReveal) {
      const gate = deferred();
      releaseCredentialReveal = () => gate.resolve({value});
      return gate.promise;
    }
    return {value};
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

// Exercise the single Save action. A controlled persistence failure keeps the
// draft available for the next input combination, after real validation passed.
async function checkPassed(win) {
  retainDraftAfterValidation = true;
  try {
    await click(win,'[data-testid="plugin-save"]','save validates before persistence');
    await waitFor(win,`document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent?.includes('检查通过') === true && document.querySelector('[data-testid="plugin-editor-error"]')?.textContent.includes('模拟持久化失败')`,'validated draft remains available after persistence failure');
  } finally { retainDraftAfterValidation = false; }
}

async function saveAndClose(win) {
  const createCount = calls.filter((call) => call.channel === 'v2:plugin-create').length;
  await click(win,'[data-testid="plugin-save"]','matrix disconnected save');
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
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('高级设置'));
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
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
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
  await fill(win,'#plugin-host','moved.matrix.invalid');
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
  await click(win,'[data-testid="plugin-save"]','save cleared temporary credential');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'saved credential edit closes');
  assert.equal(fixtureCredentials.get(savedId).password === savedValue,true,'cleared temporary credentials must not overwrite the stored fixture');
  assert.equal(state.plugins.find(plugin => plugin.pluginInstanceId === savedId).target.host,'moved.matrix.invalid');
  runtimeBehavior = null;
}

async function credentialViewMatrix(win) {
  process.stdout.write('Plugin matrix: explicit local credential viewing, cleanup and late-result isolation\n');
  const dialog = '[data-testid="stored-credential-dialog"]';
  const valueSelector = '[data-testid="stored-credential-value"]';
  const viewButton = field => `[data-testid="stored-credential-view-${field}"]`;
  let activeField;
  const openView = async field => {
    activeField = field;
    const inputId = field === 'proxyPassword' ? 'plugin-proxy-credential' : 'plugin-primary-credential';
    const control = await win.webContents.executeJavaScript(`(() => {
      const input = document.getElementById(${JSON.stringify(inputId)});
      const button = document.querySelector(${JSON.stringify(viewButton(field))});
      const group = input?.closest('[data-slot="input-group"]');
      if (!button || !group?.contains(button)) return false;
      const a = input.getBoundingClientRect(), b = button.getBoundingClientRect(), c = group.getBoundingClientRect();
      return button.type === 'button' && button.textContent.trim() === '' && button.getAttribute('aria-label')?.startsWith('查看已保存') && b.left >= a.right && b.right <= c.right && Math.abs(b.top + b.height / 2 - c.top - c.height / 2) < 2;
    })()`,true);
    assert.equal(control,true,'密码查看必须是输入框右侧有可访问名称的图标按钮');
    await click(win,viewButton(field),'explicit saved credential view');
  };
  const closeView = async () => {
    await clickText(win,'隐藏并关闭',dialog);
    await waitFor(win,`document.querySelector(${JSON.stringify(valueSelector)}) === null`,'viewed credential cleared');
    await waitFor(win,`document.querySelector(${JSON.stringify(dialog)}) === null`,'credential dialog closed');
    await waitFor(win,`document.activeElement?.getAttribute('data-testid') === ${JSON.stringify('stored-credential-view-')} + ${JSON.stringify(activeField)}`,'credential eye regains keyboard focus');
  };
  for (const [kind,auth,field] of [
    ['Server','password','password'],['Server','privateKey','privateKeyPassphrase'],
    ['MySQL','password','password'],['Redis','password','password'],
  ]) {
    await openNew(win,kind);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid^="stored-credential-view-"]') === null`,true),true,'新插件不能查看尚未保存的密码');
    if (auth === 'privateKey') {
      await chooseSelectOption(win,'[aria-label="SSH 认证方式"]','私钥');
      await fill(win,'#plugin-private-key','C:\\matrix-fixture\\id_ed25519');
    }
    if (kind === 'MySQL') await fill(win,'#plugin-database','orders');
    const value = randomBytes(24).toString('hex');
    await fill(win,'#plugin-primary-credential',value);
    let proxyValue;
    if (kind === 'Server') {
      await advanced(win);
      await chooseSelectOption(win,'[aria-label="SSH 上行方式"]','SOCKS5 代理');
      await fill(win,'#plugin-proxy-host','proxy.matrix.invalid');
      proxyValue = randomBytes(24).toString('hex');
      await fill(win,'#plugin-proxy-credential',proxyValue);
    }
    const id = await saveAndClose(win);
    const beforeViews = calls.filter(call => call.channel === 'v2:plugin-credential-reveal').length;
    await openPopup(win,'[data-testid="detail-scope-actions"]','saved credential menu');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid^="stored-credential-view-"]') === null`,true),true,'详情菜单不再重复提供密码入口');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,true);
    await waitFor(win,`document.querySelector('[role="menu"]') === null`,'detail menu closed');
    await editPlugin(win,id);
    await waitFor(win,`document.querySelector(${JSON.stringify(viewButton(field))}) !== null`,'saved credential view button');
    assert.equal(calls.filter(call => call.channel === 'v2:plugin-credential-reveal').length,beforeViews,'打开编辑器不自动获取明文');
    const replacement = randomBytes(24).toString('hex');
    await fill(win,'#plugin-primary-credential',replacement);
    await openView(field);
    await waitFor(win,`document.querySelector(${JSON.stringify(valueSelector)})?.value === ${JSON.stringify(value)}`,'correct saved credential displayed');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(valueSelector)}).readOnly && document.querySelector('#plugin-primary-credential').value === ${JSON.stringify(replacement)}`,true),true,'只读查看不会覆盖用户正在输入的新密码');
    await closeView();
    await fill(win,'#plugin-primary-credential','');
    if (proxyValue) {
      await advanced(win);
      await waitFor(win,`document.querySelector(${JSON.stringify(viewButton('proxyPassword'))}) !== null`,'proxy credential menu item');
      await openView('proxyPassword');
      await waitFor(win,`document.querySelector(${JSON.stringify(valueSelector)})?.value === ${JSON.stringify(proxyValue)}`,'correct proxy credential displayed');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#plugin-proxy-credential').value === ''`,true),true);
      await closeView();
    }
    if (kind === 'Redis') {
      failNextCredentialReveal = true;
      await openView(field);
      await waitFor(win,`Boolean(document.querySelector(${JSON.stringify(dialog)})?.querySelector('[role="alert"]'))`,'safe credential view failure');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(valueSelector)}) === null`,true),true);
      await closeView();
      for (const reason of ['close','blur']) {
        holdCredentialReveal = true;
        releaseCredentialReveal = null;
        await openView(field);
        await waitUntil(() => releaseCredentialReveal !== null,'held credential request');
        if (reason === 'close') await closeView();
        else {
          await win.webContents.executeJavaScript('window.dispatchEvent(new Event("blur"))',true);
          await waitFor(win,`document.querySelector(${JSON.stringify(dialog)}) === null`,'backgrounded credential hidden');
        }
        releaseCredentialReveal();
        holdCredentialReveal = false;
        await wait(120);
        assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(dialog)}) === null && document.querySelector(${JSON.stringify(valueSelector)}) === null`,true),true,'迟到明文不得重新显示');
      }
      await openView(field);
      await waitFor(win,`document.querySelector(${JSON.stringify(valueSelector)}) !== null`,'credential timer starts');
      await waitFor(win,`document.querySelector(${JSON.stringify(dialog)}) === null && document.querySelector(${JSON.stringify(valueSelector)}) === null`,'credential timeout clears plaintext',35000);
    }
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#plugin-primary-credential').value === ''`,true),true,'查看不会填入编辑草稿');
    await checkPassed(win);
    assert.equal(calls.at(-1).credentialFields.length,0,'查看不会把已保存明文作为临时凭据发送');
    await click(win,'[data-testid="plugin-editor-cancel"]','close unchanged credential viewer editor');
    await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'viewing leaves editor clean');
    assert.equal(fixtureCredentials.get(id)[field] === value,true,'查看不会覆盖凭据');
  }
}

async function discoveryMatrix(win) {
  process.stdout.write('Plugin matrix: MySQL result envelope, late discovery and tunnel editing\n');
  await openNew(win,'MySQL');
  const beforeInvalid = runtimeCalls.length;
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
  await waitFor(win,`document.querySelector('#plugin-database-error')?.textContent?.includes('数据库') === true`,'missing fixed database rejected');
  assert.equal(runtimeCalls.length,beforeInvalid);
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[data-testid="mysql-batch-databases"]') !== null`,'real discovery envelope becomes selectable options');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}).textContent.includes('前 200 项')`,true),true,'truncated discovery is visibly labelled');
  await clickText(win,'orders','[data-testid="mysql-batch-databases"]','label');
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
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="mysql-batch-databases"]') === null`,true),true,'old discovery does not repopulate options');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}).textContent.includes('Superseded discovery failure fixture')`,true),false,'late discovery errors do not overwrite the changed draft');
  }
  runtimeBehavior = null;
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[data-testid="mysql-batch-databases"]') !== null`,'discovery retry after input changes');
  await clickText(win,'orders','[data-testid="mysql-batch-databases"]','label');
  await advanced(win);
  await chooseSelectOption(win,'[aria-label="连接路径"]','Server 隧道');
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
  await waitFor(win,`document.querySelector('#plugin-tunnel-server-error')?.textContent?.includes('Server') === true`,'missing tunnel target rejected');
  await chooseSelectOption(win,'[aria-label="隧道 Server"]',state.plugins.find((plugin) => plugin.pluginInstanceId === SERVER_ID).displayName);
  await fill(win,'#plugin-database','orders');
  await checkPassed(win);
  assert.equal(runtimeCalls.at(-1).draft.transport.serverPluginInstanceId,SERVER_ID);
  const savedId = await saveAndClose(win);
  await editPlugin(win,savedId);
  const savedBeforeDiscovery = JSON.stringify(state.plugins.find((plugin) => plugin.pluginInstanceId === savedId));
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[aria-label="选择可见数据库"]') !== null`,'editing discovers databases through the real IPC fence');
  assert.equal(runtimeCalls.at(-1).purpose,'resource-discovery');
  assert.equal(runtimeCalls.at(-1).draft.target.database,'');
  assert.equal(runtimeCalls.at(-1).draft.transport.serverPluginInstanceId,SERVER_ID);
  assert.deepEqual(runtimeCalls.at(-1).credentialFields,['password']);
  assert.equal(JSON.stringify(state.plugins.find((plugin) => plugin.pluginInstanceId === savedId)),savedBeforeDiscovery,'读取数据库不得保存编辑草稿');
  await chooseSelectOption(win,'[aria-label="选择可见数据库"]','inventory');
  await checkPassed(win);
  assert.equal(runtimeCalls.at(-1).draft.target.database,'inventory');
  await click(win,'[data-testid="plugin-save"]','save edited MySQL database');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'MySQL edit committed');
}

async function cancellationMatrix(win,{probe,AppError}) {
  process.stdout.write('Plugin matrix: exact cancellation, late success and duplicate save\n');
  await openNew(win,'Redis');
  holdProbeCompletion = true;
  const createsBefore = calls.filter((call) => call.channel === 'v2:plugin-create').length;
  await click(win,'[data-testid="plugin-save"]','begin a save whose probe response is delayed');
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
    const button = document.querySelector('[data-testid="plugin-save"]');
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
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
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
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
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
  await click(win,'[data-testid="plugin-save"]','save checks the draft');
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
  await click(win,'[data-testid="plugin-save"]','save with explicit TLS fallback');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]')?.textContent?.includes('目标不支持 TLS') === true`,'TLS fallback requires approval');
  assert.equal(state.plugins.length,beforeTls);
  await assertPendingTlsDecision(win);
  const beforeTlsRejection = runtimeCalls.length;
  await clickText(win,'取消','[data-testid="plugin-editor-confirmation"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'TLS fallback rejection closes the prompt');
  assert.equal(runtimeCalls.length,beforeTlsRejection,'rejecting TLS fallback must not retry or downgrade the connection');
  assert.equal(state.plugins.length,beforeTls,'rejecting TLS fallback must not save the draft');
  await click(win,'[data-testid="plugin-save"]','request TLS fallback approval again');
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
  await click(win,'[data-testid="plugin-save"]','request TLS fallback before a real authentication failure');
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
  const beforeTrust = state.plugins.length;
  const beforeRuntime = runtimeCalls.length;
  await click(win,'[data-testid="plugin-save"]','自动接受新主机指纹并保存');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'首次指纹自动重试完成保存');
  assert.equal(runtimeCalls.length,beforeRuntime+2);
  assert.equal(state.plugins.length,beforeTrust+1,'新指纹只保存一次');
  assert.equal(state.plugins.at(-1).target.hostKeyFingerprint,fingerprint);
  const editedId = state.plugins.at(-1).pluginInstanceId;
  await editPlugin(win,editedId);
  await fill(win,'#plugin-host','changed.fixture.invalid');
  await click(win,'[data-testid="plugin-save"]','换地址后直接保存');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'换地址后自动处理新指纹');
  assert.equal(state.plugins.find(plugin => plugin.pluginInstanceId === editedId).target.host,'changed.fixture.invalid');
  assert.equal(state.plugins.find(plugin => plugin.pluginInstanceId === editedId).target.hostKeyFingerprint,fingerprint);
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
  await click(win,'[data-testid="plugin-save"]','check a host whose authentication will fail after trust');
  const beforeAuthFailure = state.plugins.length;
  try {
    await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('模拟指纹确认后的认证失败') === true`,'real failure after fingerprint approval remains visible');
  } catch (error) {
    const diagnostic = await win.webContents.executeJavaScript(`({progress:document.querySelector('[data-testid="plugin-validation-progress"]')?.textContent,alerts:[...document.querySelectorAll('[role="alert"]')].map(item => item.textContent)})`,true);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(state.plugins.length,beforeAuthFailure,'failed authentication must not save the plugin');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null`,'failed authentication closes the fingerprint prompt');
  await discard(win);
  runtimeBehavior = null;

  await openNew(win,'Redis');
  failNextCreate = true;
  await click(win,'[data-testid="plugin-save"]','trigger recoverable save failure');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})?.textContent?.includes('模拟保存失败') === true`,'save failure stays visible without closing the draft');
  const savedId = await saveAndClose(win);
  await editPlugin(win,savedId);
  await fill(win,'#plugin-redis-db','7');
  await click(win,'[data-testid="plugin-save"]','save edited Redis DB');
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

async function mysqlGroupsMatrix(win) {
  await openNew(win,'MySQL');
  await fill(win,'#plugin-display-name','批量测试');
  await fill(win,'#plugin-primary-credential',randomBytes(24).toString('hex'));
  await clickText(win,'读取数据库',EDITOR_SELECTOR);
  await waitFor(win,`document.querySelector('[data-testid="mysql-batch-databases"]') !== null`,'读取多选数据库');
  await clickText(win,'inventory','[data-testid="mysql-batch-databases"]','label');
  await clickText(win,'orders','[data-testid="mysql-batch-databases"]','label');
  await waitFor(win,`document.querySelector('[data-testid="plugin-save"]')?.textContent.includes('2 个库')`,'显示批量创建数量');
  await click(win,'[data-testid="plugin-save"]','批量保存');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'批量创建完成');
  const members = state.plugins.slice(-2);
  assert.deepEqual(members.map(item => item.target.database),['inventory','orders']);
  assert.equal(calls.filter(call => call.channel === 'v2:mysql-plugin-batch-create').length,1);
  await waitFor(win,`document.querySelector('[data-testid="mysql-plugin-group"]')?.textContent.includes('2 个库')`,'导航显示插件组');
  await smoke.captureFreshFrame(win);
  await smoke.ensureNativeKeyboardFocus(win);
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="mysql-group-toggle"]').focus()`,true);
  await waitFor(win,`document.activeElement?.dataset.testid === 'mysql-group-toggle'`,'数据库组展开入口获得键盘焦点');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await waitFor(win,`document.querySelector('[data-testid="mysql-group-toggle"]')?.getAttribute('aria-expanded') === 'false'
    && document.querySelector('[data-testid="plugin-trigger-${members[0].pluginInstanceId}"]')?.getClientRects().length === 0`,'键盘收起数据库组');
  await clickText(win,'连接全部','[data-testid="mysql-plugin-group"]');
  assert.equal(calls.filter(call => call.channel === 'v2:mysql-connection-intent').length,1);
  await waitFor(win,`document.querySelector('[data-testid="mysql-group-header"]')?.textContent.includes('已连接 2/2')`,'收起状态可以整组连接');
  const previousTheme = nativeTheme.themeSource;
  for (const theme of ['light','dark']) {
    nativeTheme.themeSource = theme;
    await waitFor(win,`document.documentElement.dataset.theme === '${theme}'`,'数据库组主题跟随');
    for (const width of [960,1280]) {
      await setExactViewport(win,width,820);
      await smoke.captureFreshFrame(win);
      const layout = await win.webContents.executeJavaScript(`(() => {
        const header = document.querySelector('[data-testid="mysql-group-header"]');
        const toggle = header.querySelector('[data-testid="mysql-group-toggle"]');
        const menu = header.querySelector('[data-testid="mysql-group-menu-trigger"]');
        const rect = header.getBoundingClientRect();
        return {overflow:header.scrollWidth > header.clientWidth,
          actionVisible:menu.getBoundingClientRect().right <= rect.right,
          toggleWidth:toggle.getBoundingClientRect().width};
      })()`,true);
      assert.equal(layout.overflow,false,'窄栏中的数据库组不产生横向溢出');
      assert.equal(layout.actionVisible,true,'组操作在窄栏中保持可见');
      assert.ok(layout.toggleWidth > 100,`组名称和展开入口保留足够空间：${JSON.stringify({theme,width,layout})}`);
    }
    if (process.env.RUNBOOK_BRIDGE_GROUP_SCREENSHOT) {
      const file = path.parse(process.env.RUNBOOK_BRIDGE_GROUP_SCREENSHOT);
      for (const view of ['collapsed','expanded']) {
        if (view === 'expanded') await click(win,'[data-testid="mysql-group-toggle"]','展开数据库组');
        await win.webContents.executeJavaScript('document.activeElement?.blur()',true);
        const screenshot = await smoke.captureFreshFrame(win);
        require('node:fs').writeFileSync(path.join(file.dir,`${file.name}-${view}-${theme}.png`),screenshot.toPNG());
      }
      await click(win,'[data-testid="mysql-group-toggle"]','恢复收起状态');
    }
  }
  nativeTheme.themeSource = previousTheme;
  await clickText(win,'断开全部','[data-testid="mysql-plugin-group"]');
  await waitFor(win,`document.querySelector('[data-testid="mysql-group-header"]')?.textContent.includes('未连接')`,'收起状态可以整组断开');
  assert.equal(calls.filter(call => call.channel === 'v2:mysql-connection-intent').length,2);
  await openPopup(win,'[data-testid="mysql-group-menu-trigger"]','数据库组更多操作');
  await clickText(win,'管理连接','[role="menu"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) !== null && document.querySelector('[data-testid="plugin-editor-loading"]') === null`,'菜单进入连接管理');
  if (await win.webContents.executeJavaScript(`document.querySelector('[data-testid="plugin-editor-confirmation"]') !== null`,true)) {
    await clickText(win,'继续编辑','[data-testid="plugin-editor-confirmation"]');
  }
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-confirmation"]') === null && document.querySelector('[data-testid="plugin-editor-loading"]') === null`,'菜单编辑会话就绪');
  await waitFor(win,`document.querySelector('[data-testid="mysql-group-notice"]')?.textContent.includes('2 个库')`,'组编辑影响范围');
  await click(win,'[data-testid="mysql-group-toggle"]','展开数据库组以选择成员');
  if (process.env.RUNBOOK_BRIDGE_GROUP_SCREENSHOT) {
    await setExactViewport(win,1280,820);
    const screenshot = await smoke.captureFreshFrame(win);
    require('node:fs').writeFileSync(process.env.RUNBOOK_BRIDGE_GROUP_SCREENSHOT,screenshot.toPNG());
  }
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#plugin-database') === null`,true),true);
  await fill(win,'#plugin-host','changed.group.invalid');
  await click(win,'[data-testid="plugin-save"]','统一保存组连接');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'组保存完成');
  assert.ok(members.every(item => item.target.host === 'changed.group.invalid'));
  assert.deepEqual(members.map(item => item.target.database),['inventory','orders']);
  await editPlugin(win,members[0].pluginInstanceId);
  const beforeRecovery = members.map(item => item.revision);
  const recoveryCalls = () => calls.filter(call => call.channel === 'v2:plugin-connection-edit-save');
  const callCount = recoveryCalls().length;
  const replacement = randomBytes(24).toString('hex');
  unreadableMysqlCredentials = true;
  await fill(win,'#plugin-primary-credential',replacement);
  await click(win,'[data-testid="plugin-save"]','保存新凭据并等待确认');
  const confirmation = '[data-testid="plugin-editor-confirmation"]';
  await waitFor(win,`document.querySelector(${JSON.stringify(confirmation)})?.textContent.includes('永久替换不可读取的凭据')`,'不可读凭据的替换确认');
  assert.equal(recoveryCalls().at(-1).payload.forceCredentialReplacement,undefined);
  assert.deepEqual(members.map(item => item.revision),beforeRecovery);
  await clickText(win,'取消',confirmation);
  await waitFor(win,`document.querySelector(${JSON.stringify(confirmation)}) === null`,'取消凭据替换后留在编辑器');
  assert.equal(recoveryCalls().length,callCount+1,'取消不能提交强制替换');
  assert.ok(members.every(item => fixtureCredentials.get(item.pluginInstanceId)?.password !== replacement));
  await click(win,'[data-testid="plugin-save"]','重新请求凭据替换');
  await waitFor(win,`document.querySelector(${JSON.stringify(confirmation)})?.textContent.includes('永久替换不可读取的凭据')`,'重新确认凭据替换');
  await clickText(win,'强制替换',confirmation);
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'确认后保存整组凭据');
  assert.equal(recoveryCalls().at(-1).payload.forceCredentialReplacement,true);
  assert.equal(recoveryCalls().length,callCount+3);
  assert.ok(members.every(item => fixtureCredentials.get(item.pluginInstanceId)?.password === replacement));
  process.stdout.write('MySQL 凭据替换确认、取消和整组保存界面回归通过\n');
  await editPlugin(win,members[1].pluginInstanceId);
  await waitFor(win,`document.querySelector('[data-testid="mysql-managed-databases"]')?.textContent.includes('orders')`,'读取待移出的数据库');
  await click(win,'[data-testid="mysql-managed-databases"] [data-database="orders"]','取消关联数据库');
  await click(win,'[data-testid="plugin-save"]','保存取消关联');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'移出分组完成');
  assert.notEqual(members[1].mysqlConnectionId,members[0].mysqlConnectionId);
  await editPlugin(win,members[0].pluginInstanceId);
  await clickText(win,'读取数据库','[data-testid="mysql-group-notice"]');
  await waitFor(win,`document.querySelector('[data-testid="mysql-managed-databases"]')?.textContent.includes('orders')`,'单库读取可扩展数据库');
  await clickText(win,'orders','[data-testid="mysql-managed-databases"]','label');
  await click(win,'[data-testid="plugin-save"]','单库扩展为数据库组');
  await waitFor(win,`document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}) === null`,'扩展保存完成');
  assert.equal(state.plugins.filter(item => item.mysqlConnectionId === members[0].mysqlConnectionId).length,2);
  process.stdout.write('MySQL 共享连接、整组操作、成员移出和单库扩展界面回归通过\n');
  await mysqlGroupDeletionMatrix(win,members[0],members[1]);
}

async function mysqlGroupDeletionMatrix(win,representative,independent) {
  const originalIds = state.plugins.map(item => item.pluginInstanceId);
  const targetIds = state.plugins.filter(item => item.mysqlConnectionId === representative.mysqlConnectionId).map(item => item.pluginInstanceId);
  const dialog = '[data-testid="mysql-connection-delete-dialog"]';
  const openDelete = async () => {
    await openPopup(win,'[data-testid="mysql-group-menu-trigger"]','打开数据库组菜单');
    await clickText(win,'删除整组','[role="menu"]');
    await waitFor(win,`document.querySelector('[data-testid="mysql-delete-members"]')?.children.length === 2`,'列出整组删除范围');
  };
  await openDelete();
  if (process.env.RUNBOOK_BRIDGE_GROUP_DELETE_SCREENSHOT) {
    require('node:fs').writeFileSync(process.env.RUNBOOK_BRIDGE_GROUP_DELETE_SCREENSHOT,(await smoke.captureFreshFrame(win)).toPNG());
  }
  await clickText(win,'取消',dialog);
  await waitFor(win,`document.querySelector('${dialog}') === null`,'取消整组删除');
  assert.deepEqual(state.plugins.map(item => item.pluginInstanceId),originalIds);
  assert.equal(calls.filter(item => item.channel === 'v2:mysql-connection-delete').length,0);
  await openDelete();
  representative.revision += 1;
  await clickText(win,'删除整组',dialog);
  await waitFor(win,`document.querySelector('${dialog}')?.textContent.includes('数据库组或成员已变化')`,'拒绝陈旧删除确认');
  assert.deepEqual(state.plugins.map(item => item.pluginInstanceId),originalIds);
  await clickText(win,'重新读取',dialog);
  await waitFor(win,`document.querySelector('[data-testid="mysql-delete-members"]')?.children.length === 2`,'重新确认最新成员');
  await clickText(win,'删除整组',dialog);
  await waitFor(win,`document.querySelector('${dialog}') === null && document.querySelector('[data-testid="mysql-plugin-group"]') === null`,'整组删除后刷新导航');
  assert.deepEqual(state.plugins.map(item => item.pluginInstanceId),originalIds.filter(id => !targetIds.includes(id)));
  const selector = `[data-testid="plugin-row-${independent.pluginInstanceId}"]`;
  const openSingleDelete = async () => {
    await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      row.scrollIntoView({block:'nearest'});
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:rect.x+24,clientY:rect.y+24}));
    })()`,true);
    await waitFor(win,`document.querySelector('[role="menu"][data-state="open"]') !== null`,'插件右键菜单');
    await clickText(win,'删除插件','[role="menu"]');
    await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]')?.textContent.includes(${JSON.stringify(independent.displayName)})`,'右键删除使用正确插件');
  };
  await openSingleDelete();
  await clickText(win,'取消','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null`,'取消单插件删除');
  assert.ok(state.plugins.includes(independent));
  await openSingleDelete();
  await clickText(win,'删除插件','[data-testid="plugin-delete-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="plugin-delete-dialog"]') === null && document.querySelector(${JSON.stringify(selector)}) === null`,'右键删除刷新导航');
  assert.equal(state.plugins.some(item => item.pluginInstanceId === independent.pluginInstanceId),false);
  assert.ok(state.plugins.some(item => item.pluginInstanceId === SERVER_ID));
  process.stdout.write('插件右键删除、整组确认、取消和版本冲突回归通过\n');
}

async function matrix(win) {
  const {probe,edits,AppError} = await installMatrixApi(win);
  if (app.commandLine.hasSwitch('mysql-groups-only')) {
    await mysqlGroupsMatrix(win);
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    return;
  }
  if (app.commandLine.hasSwitch('database-discovery-only')) {
    await discoveryMatrix(win);
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    for (const call of calls) assertNoSensitivePayload(call,'database discovery evidence');
    for (const call of runtimeCalls) assertNoSensitivePayload(call,'database discovery runtime evidence');
    process.stdout.write('MySQL 数据库发现回归通过：新建、编辑、隧道、已保存凭据、过期结果隔离和选择后保存。\n');
    return;
  }
  if (app.commandLine.hasSwitch('connection-edit-only')) {
    await recoveryMatrix(win,{AppError});
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    process.stdout.write('插件连接编辑回归通过\n');
    return;
  }
  if (app.commandLine.hasSwitch('credential-view-only')) {
    await credentialViewMatrix(win);
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    for (const call of calls) assertNoSensitivePayload(call,'credential view evidence');
    process.stdout.write('Desktop credential view regression passed\n');
    return;
  }
  if (app.commandLine.hasSwitch('dialog-content-only')) {
    await longContentMatrix(win);
    assert.equal(probe.requests.size,0);
    assert.equal(edits.sessions.size,0);
    process.stdout.write('Plugin dialog long-content regression passed\n');
    return;
  }
  await serverMatrix(win);
  await credentialViewMatrix(win);
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
