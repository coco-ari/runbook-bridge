import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/errors.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { CredentialUseResolver } from '../src/credential-use-resolver.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { EnvironmentConnectionManager } from '../src/environment-connection-manager.mjs';
import { PluginConfigTransactionJournal } from '../src/plugin-config-transaction.mjs';
import { PluginCredentialVault } from '../src/plugin-credential-vault.mjs';
import { PluginEditSessionManager } from '../src/plugin-edit-session-manager.mjs';
import { PluginManager } from '../src/plugin-manager.mjs';
import { PluginProbeManager } from '../src/plugin-probe-manager.mjs';
import { PluginValidationRuntime } from '../src/plugin-validation-runtime.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { V2Service } from '../src/v2-service.mjs';

const secret = () => crypto.randomBytes(24).toString('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise,resolve};
};

// Persistence, credential resolution, edit fences, probes, connection plans and
// IPC use production classes. Only the external network drivers are replaced.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-plugin-lifecycle-'));
  const store = new WorkspaceStore(root);
  await store.init({migrateLegacy:false});
  const project = await store.createProject({name:'Lifecycle tests'});
  const [environment] = await store.listEnvironments(project.projectId);
  const scope = {projectId:project.projectId,environmentId:environment.environmentId};
  const key = crypto.randomBytes(32);
  const encryption = {
    isEncryptionAvailable:() => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
      const ciphertext = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));
      decipher.setAuthTag(value.subarray(12,28));
      return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');
    },
  };
  const vault = new PluginCredentialVault(root,encryption);
  const journal = new PluginConfigTransactionJournal(root,store,vault);
  const coordinator = new WorkspaceMutationCoordinator();
  const connections = new Map();
  const attempts = [];
  let beforeNetwork = null;
  const runtime = {
    async connect(plugin,temporary = {},options = {}) {
      const diagnostic = plugin.pluginInstanceId.startsWith('diagnostic-edit-');
      const secrets = diagnostic ? {...temporary} : {...(await vault.load(plugin) ?? {}),...temporary};
      attempts.push({plugin:structuredClone(plugin),secretFields:Object.keys(secrets).sort(),diagnostic});
      await beforeNetwork?.(plugin,options);
      if (options.signal?.aborted) throw new AppError('CONNECT_CANCELLED','Test connection cancelled.');
      const primary = plugin.pluginType === 'server'
        ? plugin.auth.type === 'password' ? 'password' : null
        : plugin.auth?.username ? 'password' : null;
      if (primary && !secrets[primary]) throw new AppError('AUTHENTICATION_FAILED','A required credential is missing.');
      if (plugin.uplink?.username && !secrets.proxyPassword) throw new AppError('AUTHENTICATION_FAILED','Proxy credential is missing.');
      if (plugin.tls?.mode === 'verifyIdentity' && !secrets.caPem) throw new AppError('TLS_CERTIFICATE_INVALID','Test CA is missing.');
      connections.set(plugin.pluginInstanceId,{connected:true});
      return {connected:true};
    },
    async listDatabases(plugin,temporary,options) {
      await runtime.connect(plugin,temporary,options);
      await runtime.disconnect(plugin);
      return {databases:['app','archive'],truncated:false};
    },
    status:() => ({connected:true}),
    health:async () => ({healthy:true}),
    disconnect:async (plugin) => { connections.delete(plugin.pluginInstanceId); return {connected:false}; },
    closeAll:async () => { connections.clear(); },
  };
  const pluginManager = new PluginManager({serverRuntime:runtime,mysqlRuntime:runtime,redisRuntime:runtime});
  const connectionManager = new EnvironmentConnectionManager(store,pluginManager,{
    mutationCoordinator:coordinator,configurationJournal:journal,retryDelays:[],
  });
  const resolver = new CredentialUseResolver(vault);
  const validationRuntime = new PluginValidationRuntime({pluginManager,mysqlRuntime:runtime});
  const edits = new PluginEditSessionManager({
    workspaceStore:store,connectionManager,mutationCoordinator:coordinator,
    credentialUseResolver:resolver,validationRuntime,
  });
  const probes = new PluginProbeManager({
    workspaceStore:store,mutationCoordinator:coordinator,
    credentialUseResolver:resolver,validationRuntime,configurationJournal:journal,
  });
  const sender = Object.assign(new EventEmitter(),{id:42,isDestroyed:() => false,send:() => undefined});
  const handlers = new Map();
  const contextManager = new EnvironmentContextManager(store);
  const confirmationManager = {on:() => undefined,invalidatePlugin:() => undefined};
  const service = new V2Service({
    workspaceStore:store,connectionManager,pluginManager,contextManager,confirmationManager,
    credentialVault:vault,mutationCoordinator:coordinator,
  });
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},{
    workspaceStore:store,connectionManager,credentialVault:vault,configTransactionJournal:journal,
    mutationCoordinator:coordinator,credentialUseResolver:resolver,pluginEditSessionManager:edits,
    pluginProbeManager:probes,pluginManager,mysqlRuntime:runtime,
    contextManager,confirmationManager,
  });
  const invoke = (name,payload) => handlers.get(`v2:${name}`)({sender},payload);
  const success = async (name,payload) => {
    const result = await invoke(name,payload);
    assert.equal(result.ok,true,`${name}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
    return result.data;
  };
  const begin = async (plugin) => {
    const preview = await success('plugin-connection-edit-prepare',{
      ...scope,pluginInstanceId:plugin.pluginInstanceId,expectedRevision:plugin.revision,
    });
    return success('plugin-connection-edit-begin',{prepareToken:preview.prepareToken});
  };
  t.after(async () => {
    edits.invalidateOwner('renderer:42');
    probes.invalidateOwner('renderer:42');
    await connectionManager.closeAll();
    await fs.rm(root,{recursive:true,force:true});
  });
  return {root,store,vault,journal,scope,coordinator,edits,probes,connectionManager,connections,attempts,sender,service,contextManager,
    invoke,success,begin,setBeforeNetwork:(callback) => { beforeNetwork = callback; }};
}

function configuration(pluginType,overrides = {}) {
  return {
    pluginType,pluginInstanceId:`${pluginType}-fixture`,displayName:`${pluginType} fixture`,
    target:{host:`${pluginType}.invalid`,...(pluginType === 'mysql' ? {database:'app'} : {}),...(pluginType === 'redis' ? {db:0} : {})},
    auth:pluginType === 'server' ? {type:'password',username:'tester'} : {username:'tester'},
    ...(pluginType === 'server' ? {uplink:{type:'direct'}} : {transport:{kind:'direct'},tls:{mode:'disabled'}}),
    ...overrides,
  };
}

function credentials(input) {
  return input.pluginType === 'server'
    ? {password:secret(),privateKeyPassphrase:secret(),proxyPassword:secret()}
    : {password:secret(),tlsPassphrase:secret(),caPem:secret(),clientCertPem:secret(),clientKeyPem:secret()};
}

function probePayload(scope,input,secrets = {}) {
  return {...scope,formInstanceId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    purpose:input.pluginType === 'server' ? 'server-auth' : 'resource-access',
    draftGeneration:1,sequence:1,draft:input,temporarySecrets:secrets};
}

test('real IPC lifecycle matrix covers auth, proxy, VPN, tunnel, TLS, edits, delete and first re-add', async (t) => {
  const cases = [];
  for (const type of ['password','privateKey','agent']) {
    for (const uplink of [
      {type:'direct'},
      {type:'http',host:'proxy.invalid',username:'proxy-user'},
      {type:'socks5',host:'proxy.invalid',username:'proxy-user'},
      {type:'windowsVpn',interfaceAlias:'Test VPN'},
    ]) cases.push(configuration('server',{
      auth:{type,username:'tester',...(type === 'privateKey' ? {privateKeyPath:'C:/test/unused-key'} : {})},uplink,
    }));
  }
  for (const pluginType of ['mysql','redis']) {
    for (const transport of [
      {kind:'direct'}, {kind:'windowsVpn',interfaceAlias:'Test VPN'},
      {kind:'serverTunnel',serverPluginInstanceId:'provider'},
    ]) {
      for (const mode of ['disabled','preferred','required','verifyIdentity']) {
        cases.push(configuration(pluginType,{transport,tls:{mode}}));
      }
    }
  }
  for (const input of cases) {
    await t.test([input.pluginType,input.auth.type,input.uplink?.type,input.transport?.kind,input.tls?.mode].filter(Boolean).join('/'),async (t) => {
      const f = await fixture(t);
      const secrets = credentials(input);
      let provider = null;
      if (input.transport?.kind === 'serverTunnel') {
        provider = await f.success('plugin-create',{...f.scope,input:configuration('server',{pluginInstanceId:'provider'}),secrets:{password:secret()}});
      }
      const preview = await f.success('plugin-probe',probePayload(f.scope,input,secrets));
      assert.equal(preview.state,'valid');
      assert.equal(f.connections.size,0);
      assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,provider ? 1 : 0);
      let plugin = await f.success('plugin-create',{...f.scope,input,secrets});
      const connected = await f.success('plugin-connect',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(connected.plugins[plugin.pluginInstanceId].phase,'connected');
      const before = await fs.readFile(f.store.pluginPath(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId));
      const session = await f.begin(plugin);
      const validated = await f.success('plugin-draft-validate',{
        editSessionId:session.editSessionId,draftGeneration:1,purpose:input.pluginType === 'server' ? 'server-auth' : 'resource-access',
        requestId:crypto.randomUUID(),draft:plugin,temporarySecrets:{},credentialIntent:'unchanged',
      });
      assert.equal(validated.state,'valid');
      await f.success('plugin-connection-edit-cancel',{editSessionId:session.editSessionId,restorePreEditConnections:true});
      assert.equal(f.connections.has(plugin.pluginInstanceId),true);
      assert.deepEqual(await fs.readFile(f.store.pluginPath(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId)),before);
      const second = await f.begin(plugin);
      const patch = plugin.pluginType === 'server'
        ? {target:{host:'changed-server.invalid'}}
        : {target:plugin.pluginType === 'mysql' ? {database:'archive'} : {db:3}};
      const saved = await f.success('plugin-connection-edit-save',{
        editSessionId:second.editSessionId,expectedRevision:plugin.revision,patch,
        credentialIntent:plugin.pluginType === 'server' ? 'rebind-existing' : 'unchanged',temporarySecrets:{},afterCommit:'connect-current',
      });
      assert.equal(saved.committed,true);
      assert.equal(saved.runtimeWarning,null);
      plugin = await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId);
      assert.deepEqual(await f.vault.load(plugin),secrets);
      await f.success('plugin-delete',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(f.connections.has(plugin.pluginInstanceId),false);
      if (provider) await f.success('plugin-delete',{...f.scope,pluginInstanceId:provider.pluginInstanceId});
      assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,0);
      const freshInput = configuration(input.pluginType,{pluginInstanceId:`${input.pluginType}-fresh`});
      await f.success('plugin-probe',probePayload(f.scope,freshInput,credentials(freshInput)));
      const fresh = await f.success('plugin-create',{...f.scope,input:freshInput,secrets:credentials(freshInput)});
      assert.equal(fresh.revision,1);
      assert.equal(f.edits.sessions.size,0);
      assert.equal(f.probes.requests.size,0);
      assert.equal(f.coordinator.environmentFence(f.scope.projectId,f.scope.environmentId),null);
    });
  }
});

test('create rollback leaves neither a catalog entry nor a plugin file after credential or index write failure',async (t) => {
  for (const failingWrite of ['credential','environment-index']) {
    await t.test(failingWrite,async (t) => {
      const f = await fixture(t);
      const input = configuration('mysql');
      const restoreSave = f.vault.save.bind(f.vault);
      const restoreWrite = f.store.writeYaml.bind(f.store);
      if (failingWrite === 'credential') f.vault.save = async () => { throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE','Test write failure.'); };
      else f.store.writeYaml = async (file,...args) => {
        if (file === f.store.environmentPath(f.scope.projectId,f.scope.environmentId)) throw Object.assign(new Error('Test index failure.'),{code:'EIO'});
        return restoreWrite(file,...args);
      };
      const failed = await f.invoke('plugin-create',{...f.scope,input,secrets:credentials(input)});
      assert.equal(failed.ok,false);
      assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,0);
      await assert.rejects(fs.access(f.store.pluginPath(f.scope.projectId,f.scope.environmentId,input.pluginInstanceId)),{code:'ENOENT'});
      f.vault.save = restoreSave;
      f.store.writeYaml = restoreWrite;
      await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
    });
  }
});

test('editing only one credential validates with unchanged saved fields and saves exactly the same merged values',async (t) => {
  for (const input of [
    configuration('server',{uplink:{type:'http',host:'proxy.invalid',username:'proxy-user'}}),
    configuration('mysql',{tls:{mode:'verifyIdentity'}}),
    configuration('redis',{tls:{mode:'verifyIdentity'}}),
  ]) await t.test(input.pluginType,async (t) => {
    const f = await fixture(t);
    const secrets = credentials(input);
    const plugin = await f.success('plugin-create',{...f.scope,input,secrets});
    const session = await f.begin(plugin);
    const replacements = input.pluginType === 'server' ? {proxyPassword:secret()} : {password:secret()};
    await f.success('plugin-draft-validate',{
      editSessionId:session.editSessionId,draftGeneration:1,purpose:input.pluginType === 'server' ? 'server-auth' : 'resource-access',
      requestId:crypto.randomUUID(),draft:plugin,temporarySecrets:replacements,credentialIntent:'replace',
    });
    await f.success('plugin-connection-edit-save',{
      editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{},
      temporarySecrets:replacements,credentialIntent:'replace',afterCommit:'stay-disconnected',
    });
    const current = await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId);
    assert.deepEqual(await f.vault.load(current),{...secrets,...replacements});
  });
});

test('clearing a validated temporary password returns subsequent validation and save to the persistent credential',async (t) => {
  const f = await fixture(t);
  const input = configuration('mysql');
  const original = credentials(input);
  const plugin = await f.success('plugin-create',{...f.scope,input,secrets:original});
  const session = await f.begin(plugin);
  const validation = {
    editSessionId:session.editSessionId,purpose:'resource-access',draft:plugin,
    discardTemporarySecrets:true,
  };
  await f.success('plugin-draft-validate',{
    ...validation,requestId:'with-replacement',draftGeneration:1,
    temporarySecrets:{password:secret()},credentialIntent:'replace',
  });
  assert.equal(f.edits.sessionSummary(session.editSessionId).hasTemporarySecrets,true);
  await f.success('plugin-draft-validate',{
    ...validation,requestId:'after-clear',draftGeneration:2,credentialIntent:'unchanged',
  });
  assert.equal(f.edits.sessionSummary(session.editSessionId).hasTemporarySecrets,false);
  const saved = await f.success('plugin-connection-edit-save',{
    editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{},
    discardTemporarySecrets:true,credentialIntent:'unchanged',afterCommit:'stay-disconnected',
  });
  assert.equal(saved.changed,false);
  assert.deepEqual(await f.vault.load(plugin),original);
});

test('unreadable credentials require explicit replacement on save but allow a complete new validation',async (t) => {
  for (const complete of [false,true]) await t.test(complete ? 'complete replacement' : 'partial replacement',async (t) => {
    const f = await fixture(t);
    const input = configuration('mysql',{tls:{mode:'verifyIdentity'}});
    const plugin = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
    const original = await fs.readFile(f.vault.file);
    const decrypt = f.vault.encryption.decryptString;
    f.vault.encryption.decryptString = () => { throw new Error('Test decryption failure.'); };
    const session = await f.begin(plugin);
    const replacement = complete ? credentials(input) : {password:secret()};
    const checked = await f.invoke('plugin-draft-validate',{
      editSessionId:session.editSessionId,draftGeneration:1,purpose:'resource-access',
      requestId:'unreadable-vault-check',draft:plugin,temporarySecrets:replacement,credentialIntent:'replace',
    });
    assert.equal(checked.ok,complete);
    if (!complete) assert.equal(checked.error.code,'TLS_CERTIFICATE_INVALID');
    const save = {
      editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{},
      temporarySecrets:replacement,credentialIntent:'replace',afterCommit:'stay-disconnected',
    };
    const failed = await f.invoke('plugin-connection-edit-save',save);
    assert.equal(failed.ok,false);
    assert.equal(failed.error.code,'CREDENTIAL_REPLACEMENT_INCOMPLETE');
    assert.deepEqual(await fs.readFile(f.vault.file),original);
    assert.equal((await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId)).revision,plugin.revision);
    assert.equal(f.edits.sessionSummary(session.editSessionId).phase,'editing');
    const committed = await f.success('plugin-connection-edit-save',{...save,forceCredentialReplacement:true});
    assert.equal(committed.committed,true);
    f.vault.encryption.decryptString = decrypt;
    const current = await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId);
    assert.deepEqual(await f.vault.load(current),replacement);
  });
});

test('revision conflicts, identity changes and invalid drafts leave the edit session retryable and stored bytes untouched',async (t) => {
  const f = await fixture(t);
  const input = configuration('mysql');
  const plugin = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
  const original = await fs.readFile(f.vault.file);
  const session = await f.begin(plugin);
  const payload = {editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{},afterCommit:'stay-disconnected'};
  for (const [change,code] of [
    [{expectedRevision:0},'CONFIG_REVISION_CONFLICT'],
    [{patch:{target:{database:''}}},'PLUGIN_CONFIGURATION_INCOMPLETE'],
    [{patch:{target:{host:'other.invalid'}}},'PLUGIN_CREDENTIAL_REBIND_REQUIRED'],
  ]) {
    const failed = await f.invoke('plugin-connection-edit-save',{...payload,...change});
    assert.equal(failed.ok,false);
    assert.equal(failed.error.code,code);
    assert.equal(f.edits.sessionSummary(session.editSessionId).phase,'editing');
    assert.deepEqual(await fs.readFile(f.vault.file),original);
    assert.equal((await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId)).revision,plugin.revision);
  }
  await f.success('plugin-connection-edit-save',{
    ...payload,patch:{target:{host:'other.invalid'}},credentialIntent:'rebind-existing',
  });
  assert.equal(f.edits.sessionSummary(session.editSessionId),null);
});

test('duplicate concurrent creates cannot overwrite a committed plugin or its credentials',async (t) => {
  const f = await fixture(t);
  const input = configuration('mysql');
  const firstSecrets = credentials(input);
  const [first,second] = await Promise.all([
    f.invoke('plugin-create',{...f.scope,input,secrets:firstSecrets}),
    f.invoke('plugin-create',{...f.scope,input,secrets:credentials(input)}),
  ]);
  assert.equal(first.ok,true);
  assert.equal(second.ok,false);
  assert.equal(second.error.code,'PLUGIN_ALREADY_EXISTS');
  assert.deepEqual(await f.vault.load(first.data),firstSecrets);
  assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,1);
});

test('dependent protection prevents deleting a provider without losing its active edit session',async (t) => {
  const f = await fixture(t);
  const providerInput = configuration('server',{pluginInstanceId:'provider'});
  const provider = await f.success('plugin-create',{...f.scope,input:providerInput,secrets:credentials(providerInput)});
  const child = configuration('mysql',{transport:{kind:'serverTunnel',serverPluginInstanceId:'provider'}});
  await f.success('plugin-create',{...f.scope,input:child,secrets:credentials(child)});
  const session = await f.begin(provider);
  const result = await f.invoke('plugin-delete',{...f.scope,pluginInstanceId:provider.pluginInstanceId});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'PLUGIN_HAS_DEPENDENTS');
  assert.equal(f.edits.sessionSummary(session.editSessionId)?.phase,'editing');
  await f.success('plugin-connection-edit-cancel',{editSessionId:session.editSessionId,restorePreEditConnections:false});
});

test('cancelled and superseded IPC probes clean up without persisting anything or reviving obsolete results',async (t) => {
  const f = await fixture(t);
  const input = configuration('mysql');
  const started = deferred();
  const release = deferred();
  let first = true;
  f.setBeforeNetwork(async () => {
    if (!first) return;
    first = false;
    started.resolve();
    await release.promise;
  });
  const oldPayload = probePayload(f.scope,input,credentials(input));
  const pending = f.invoke('plugin-probe',oldPayload);
  await started.promise;
  const newer = f.invoke('plugin-probe',{
    ...oldPayload,requestId:'newer',draftGeneration:2,sequence:2,
    draft:{...input,target:{...input.target,database:'archive'}},
  });
  release.resolve();
  const stale = await pending;
  assert.equal(stale.ok,false);
  assert.equal(stale.error.code,'PLUGIN_VALIDATION_STALE');
  assert.equal((await newer).ok,true);
  const finalStart = deferred();
  const finalRelease = deferred();
  f.setBeforeNetwork(async () => { finalStart.resolve(); await finalRelease.promise; });
  const cancelPayload = probePayload(f.scope,input,credentials(input));
  const cancelledRequest = f.invoke('plugin-probe',cancelPayload);
  await finalStart.promise;
  await f.success('plugin-probe-cancel',{requestId:cancelPayload.requestId,formInstanceId:cancelPayload.formInstanceId});
  finalRelease.resolve();
  const cancelled = await cancelledRequest;
  assert.equal(cancelled.ok,false);
  assert.equal(cancelled.error.code,'PLUGIN_VALIDATION_CANCELLED');
  assert.equal(f.connections.size,0);
  assert.equal(f.probes.requests.size,0);
  assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,0);
});

test('plugins that do not need a password can probe, save, connect and re-add with no credential envelope',async (t) => {
  for (const input of [
    configuration('server',{auth:{type:'agent',username:'tester'}}),
    configuration('server',{auth:{type:'privateKey',username:'tester',privateKeyPath:'C:/test/unused-key'}}),
    configuration('redis',{auth:{username:''}}),
  ]) await t.test(`${input.pluginType}/${input.auth.type ?? 'no-auth'}`,async (t) => {
    const f = await fixture(t);
    await f.success('plugin-probe',probePayload(f.scope,input));
    const plugin = await f.success('plugin-create',{...f.scope,input});
    assert.equal(await f.vault.load(plugin),null);
    const connected = await f.success('plugin-connect',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
    assert.equal(connected.plugins[plugin.pluginInstanceId].phase,'connected');
    await f.success('plugin-delete',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
    const recreated = await f.success('plugin-create',{...f.scope,input});
    assert.equal(recreated.pluginInstanceId,plugin.pluginInstanceId);
    assert.equal(await f.vault.load(recreated),null);
  });
});

test('recreated plugins get fresh credential identities through GUI and MCP after plugin, environment and project deletion',async (t) => {
  for (const entrypoint of ['GUI','MCP']) {
    for (const deletion of ['plugin','environment','project']) {
      await t.test(`${entrypoint}/${deletion}`,async (t) => {
        const f = await fixture(t);
        const input = configuration('mysql',{pluginInstanceId:undefined,displayName:'Saved database'});
        const savedSecrets = credentials(input);
        const original = await f.success('plugin-create',{...f.scope,input,secrets:savedSecrets});
        const primary = await fs.readFile(f.vault.file);
        const backup = await fs.readFile(f.vault.backupFile);
        await f.success('plugin-delete',{...f.scope,pluginInstanceId:original.pluginInstanceId});
        if (deletion === 'environment') {
          await f.success('environment-create',{projectId:f.scope.projectId,input:{name:'Spare environment'}});
          await f.success('environment-delete',f.scope);
          await f.success('environment-create',{
            projectId:f.scope.projectId,input:{environmentId:f.scope.environmentId,name:'Restored environment'},
          });
        } else if (deletion === 'project') {
          await f.success('project-delete',{projectId:f.scope.projectId});
          await f.success('project-create',{
            projectId:f.scope.projectId,name:'Restored project',environmentId:f.scope.environmentId,
          });
        }
        // An explicitly requested internal identity remains exact and may not
        // revive historical credentials, even when a replacement was supplied.
        for (const secrets of [undefined,credentials(input)]) {
          const refused = await f.invoke('plugin-create',{
            ...f.scope,input:{...input,pluginInstanceId:original.pluginInstanceId},secrets,
          });
          assert.equal(refused.ok,false);
          assert.equal(refused.error.code,'PLUGIN_ALREADY_EXISTS');
          assert.equal(refused.error.details.reason,'credentials-preserved');
        }
        let created;
        if (entrypoint === 'GUI') created = await f.success('plugin-create',{...f.scope,input});
        else {
          const context = await f.contextManager.open(f.scope.projectId,f.scope.environmentId,'lifecycle-mcp');
          const result = await f.service.addPlugin({
            ...f.scope,contextToken:context.contextToken,clientInstanceId:'lifecycle-mcp',
            pluginType:'mysql',displayName:input.displayName,
            configuration:{host:input.target.host,username:input.auth.username,database:'app',tlsMode:'disabled'},
          });
          created = await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,result.plugin.pluginInstanceId);
        }
        assert.notEqual(created.pluginInstanceId,original.pluginInstanceId);
        assert.equal(created.displayName,original.displayName);
        assert.equal(await f.vault.load(created),null);
        assert.deepEqual(await f.vault.load(original),savedSecrets);
        assert.deepEqual(await fs.readFile(f.vault.file),primary);
        assert.deepEqual(await fs.readFile(f.vault.backupFile),backup);
        assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,1);
      });
    }
  }
});

test('historical-credential isolation does not allow a duplicate automatic identity while its original plugin exists',async (t) => {
  const f = await fixture(t);
  const input = configuration('mysql',{pluginInstanceId:undefined,displayName:'Existing database'});
  const original = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
  const duplicated = await f.invoke('plugin-create',{...f.scope,input});
  assert.equal(duplicated.ok,false);
  assert.equal(duplicated.error.code,'PLUGIN_ALREADY_EXISTS');
  const context = await f.contextManager.open(f.scope.projectId,f.scope.environmentId,'lifecycle-mcp');
  await assert.rejects(f.service.addPlugin({
    ...f.scope,contextToken:context.contextToken,clientInstanceId:'lifecycle-mcp',
    pluginType:'mysql',displayName:input.displayName,
    configuration:{host:input.target.host,username:input.auth.username,database:'app',tlsMode:'disabled'},
  }),{code:'PLUGIN_ALREADY_EXISTS'});
  assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,1);
  assert.ok(await f.vault.load(original));
});

test('refused project deletion preserves connections, pending recovery and active editor drafts',async (t) => {
  for (const reason of ['connected','recovery']) await t.test(reason,async (t) => {
    const f = await fixture(t);
    const first = configuration('mysql');
    const plugin = await f.success('plugin-create',{...f.scope,input:first,secrets:credentials(first)});
    const second = configuration('redis');
    const other = await f.success('plugin-create',{...f.scope,input:second,secrets:credentials(second)});
    const session = await f.begin(plugin);
    f.edits.captureCredentialIntent(session.editSessionId,{temporarySecrets:{password:secret()},ownerId:'renderer:42'});
    if (reason === 'connected') {
      // Begin and cancel the edit around the ordinary connection API, then
      // reopen it while an unrelated plugin remains connected.
      await f.success('plugin-connection-edit-cancel',{editSessionId:session.editSessionId,restorePreEditConnections:false});
      await f.success('plugin-connect',{...f.scope,pluginInstanceId:other.pluginInstanceId});
      const reopened = await f.begin(plugin);
      session.editSessionId = reopened.editSessionId;
      f.edits.captureCredentialIntent(session.editSessionId,{temporarySecrets:{password:secret()},ownerId:'renderer:42'});
    } else {
      f.journal.blockedScopes.set(`${f.scope.projectId}/${f.scope.environmentId}/${plugin.pluginInstanceId}`,{file:'test-unresolved'});
    }
    const result = await f.invoke('project-delete',{projectId:f.scope.projectId});
    assert.equal(result.ok,false);
    assert.equal(result.error.code,reason === 'connected' ? 'PROJECT_CONNECTED' : 'CONFIG_TRANSACTION_RECOVERY_REQUIRED');
    assert.equal(f.edits.sessionSummary(session.editSessionId)?.hasTemporarySecrets,true);
    assert.equal(f.coordinator.projectsDeleting.has(f.scope.projectId),false);
    assert.equal((await f.store.listPlugins(f.scope.projectId,f.scope.environmentId)).length,2);
    if (reason === 'connected') assert.equal(f.connections.has(other.pluginInstanceId),true);
    else f.journal.blockedScopes.clear();
    await f.success('plugin-connection-edit-cancel',{editSessionId:session.editSessionId,restorePreEditConnections:false});
    await f.success('plugin-connect',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
    assert.equal(f.connections.has(plugin.pluginInstanceId),true);
  });
});

test('refused nonempty or last-environment deletion does not discard the open plugin editor',async (t) => {
  for (const reason of ['last-environment','nonempty']) await t.test(reason,async (t) => {
    const f = await fixture(t);
    if (reason === 'nonempty') await f.success('environment-create',{projectId:f.scope.projectId,input:{name:'Other environment'}});
    const input = configuration('mysql');
    const plugin = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
    const session = await f.begin(plugin);
    f.edits.captureCredentialIntent(session.editSessionId,{temporarySecrets:{password:secret()},ownerId:'renderer:42'});
    const result = await f.invoke('environment-delete',f.scope);
    assert.equal(result.ok,false);
    assert.equal(result.error.code,reason === 'nonempty' ? 'ENVIRONMENT_NOT_EMPTY' : 'POLICY_DENIED');
    assert.equal(f.edits.sessionSummary(session.editSessionId)?.hasTemporarySecrets,true);
    await f.success('plugin-connection-edit-cancel',{editSessionId:session.editSessionId,restorePreEditConnections:false});
  });
});

test('password-authenticated Servers can switch to credential-free SSH Agent without rebinding any credential for validation',async (t) => {
  for (const uplink of [
    {type:'direct'}, {type:'windowsVpn',interfaceAlias:'Test VPN'},
    {type:'http',host:'proxy.invalid',username:''}, {type:'socks5',host:'proxy.invalid',username:''},
  ]) await t.test(uplink.type,async (t) => {
    const f = await fixture(t);
    const input = configuration('server');
    const savedSecrets = credentials(input);
    const plugin = await f.success('plugin-create',{...f.scope,input,secrets:savedSecrets});
    const session = await f.begin(plugin);
    const checked = await f.success('plugin-draft-validate',{
      editSessionId:session.editSessionId,draftGeneration:1,purpose:'server-auth',requestId:'switch-to-agent',
      draft:{...plugin,auth:{...plugin.auth,type:'agent'},uplink},
      discardTemporarySecrets:true,credentialIntent:'unchanged',
    });
    assert.equal(checked.state,'valid');
    assert.deepEqual(f.attempts.at(-1).secretFields,[]);
    await f.success('plugin-connection-edit-save',{
      editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{auth:{type:'agent'},uplink},
      discardTemporarySecrets:true,credentialIntent:'unchanged',afterCommit:'stay-disconnected',
    });
    const current = await f.store.getPlugin(f.scope.projectId,f.scope.environmentId,plugin.pluginInstanceId);
    assert.equal(current.auth.type,'agent');
    assert.deepEqual(await f.vault.load(current),savedSecrets,'inactive fields are preserved by the ordinary save transaction');
    const editingAgain = await f.begin(current);
    const backToPassword = await f.invoke('plugin-connection-edit-save',{
      editSessionId:editingAgain.editSessionId,expectedRevision:current.revision,
      patch:{auth:{type:'password'}},discardTemporarySecrets:true,credentialIntent:'unchanged',
    });
    assert.equal(backToPassword.ok,false);
    assert.equal(backToPassword.error.code,'PLUGIN_CREDENTIAL_REBIND_REQUIRED');
  });
});

test('SSH Agent with an authenticated proxy still requires explicit credential reuse after switching identities',async (t) => {
  const f = await fixture(t);
  const input = configuration('server');
  const plugin = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
  const session = await f.begin(plugin);
  const uplink = {type:'http',host:'proxy.invalid',username:'proxy-user'};
  const checked = await f.invoke('plugin-draft-validate',{
    editSessionId:session.editSessionId,draftGeneration:1,purpose:'server-auth',requestId:'switch-to-proxied-agent',
    draft:{...plugin,auth:{...plugin.auth,type:'agent'},uplink},
    discardTemporarySecrets:true,credentialIntent:'unchanged',
  });
  assert.equal(checked.ok,false);
  assert.equal(checked.error.code,'CREDENTIAL_REBIND_REQUIRED');
  const saved = await f.invoke('plugin-connection-edit-save',{
    editSessionId:session.editSessionId,expectedRevision:plugin.revision,patch:{auth:{type:'agent'},uplink},
    discardTemporarySecrets:true,credentialIntent:'unchanged',
  });
  assert.equal(saved.ok,false);
  assert.equal(saved.error.code,'PLUGIN_CREDENTIAL_REBIND_REQUIRED');
});

test('deleting the last connected plugin clears environment intent and permits explicit re-add and project deletion',async (t) => {
  for (const pluginType of ['server','mysql','redis']) await t.test(pluginType,async (t) => {
    const f = await fixture(t);
    const input = configuration(pluginType);
    const plugin = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
    await f.success('plugin-connect',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
    await f.success('plugin-delete',{...f.scope,pluginInstanceId:plugin.pluginInstanceId});
    const empty = await f.connectionManager.status(f.scope.projectId,f.scope.environmentId);
    assert.equal(empty.phase,'disconnected');
    assert.equal(empty.desiredConnected,false);
    assert.deepEqual(empty.plugins,{});
    assert.deepEqual(empty.manualDisconnected,{});
    const freshInput = configuration(pluginType,{pluginInstanceId:`${pluginType}-new`});
    const fresh = await f.success('plugin-create',{...f.scope,input:freshInput,secrets:credentials(freshInput)});
    assert.equal(f.connections.size,0,'re-adding must not revive a deleted connection intent');
    const added = await f.connectionManager.status(f.scope.projectId,f.scope.environmentId);
    assert.equal(added.desiredConnected,false);
    assert.equal(added.plugins[fresh.pluginInstanceId].phase,'disconnected');
    await f.success('plugin-delete',{...f.scope,pluginInstanceId:fresh.pluginInstanceId});
    await f.success('project-delete',{projectId:f.scope.projectId});
  });
});

test('plugin deletion retains another connected or retrying branch until the catalog becomes empty',async (t) => {
  for (const remaining of ['connected','retrying']) await t.test(remaining,async (t) => {
    const f = await fixture(t);
    const input = configuration('mysql');
    const first = await f.success('plugin-create',{...f.scope,input,secrets:credentials(input)});
    const secondInput = configuration('redis');
    const second = await f.success('plugin-create',{...f.scope,input:secondInput,secrets:credentials(secondInput)});
    await f.success('plugin-connect',{...f.scope,pluginInstanceId:first.pluginInstanceId});
    await f.success('plugin-connect',{...f.scope,pluginInstanceId:second.pluginInstanceId});
    const key = f.connectionManager.key(f.scope.projectId,f.scope.environmentId);
    if (remaining === 'retrying') {
      f.connectionManager.retryDelays = [60_000];
      await f.connectionManager.pluginLost(f.scope.projectId,f.scope.environmentId,second.pluginInstanceId,new AppError('ROUTE_UNAVAILABLE','Test network loss.'));
      assert.equal(f.connectionManager.retryTimers.has(key),true);
    }
    await f.success('plugin-delete',{...f.scope,pluginInstanceId:first.pluginInstanceId});
    const retained = await f.connectionManager.status(f.scope.projectId,f.scope.environmentId);
    assert.equal(retained.desiredConnected,true);
    assert.equal(retained.plugins[second.pluginInstanceId].phase,remaining === 'connected' ? 'connected' : 'error');
    if (remaining === 'retrying') assert.equal(f.connectionManager.retryTimers.has(key),true);
    await f.success('plugin-delete',{...f.scope,pluginInstanceId:second.pluginInstanceId});
    const empty = await f.connectionManager.status(f.scope.projectId,f.scope.environmentId);
    assert.equal(empty.desiredConnected,false);
    assert.equal(empty.phase,'disconnected');
    assert.equal(f.connectionManager.retryTimers.has(key),false);
    assert.deepEqual(empty.manualDisconnected,{});
    await f.success('project-delete',{projectId:f.scope.projectId});
  });
});
