import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.mjs';
import { CredentialUseResolver } from '../src/credential-use-resolver.mjs';

function mysql(overrides = {}) {
  const base = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',
    displayName:'Orders',revision:1,configState:'ready',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'required'},
    policy:{describe:'auto',select:'auto',explain:'auto'},limits:{timeoutMs:10000},
  };
  return {
    ...base,...overrides,
    target:{...base.target,...(overrides.target ?? {})},
    auth:{...base.auth,...(overrides.auth ?? {})},
    transport:{...base.transport,...(overrides.transport ?? {})},
    tls:{...base.tls,...(overrides.tls ?? {})},
    policy:{...base.policy,...(overrides.policy ?? {})},
  };
}

function redis(overrides = {}) {
  const base = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'redis-1',pluginType:'redis',
    displayName:'Cache',revision:1,configState:'ready',
    target:{host:'redis.internal',port:6379,db:0,addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    patterns:[{patternId:'all',pattern:'*',displayName:'All'}],
    policy:{scan:'auto',read:'auto',ttl:'auto'},limits:{timeoutMs:5000},
  };
  return {
    ...base,...overrides,
    target:{...base.target,...(overrides.target ?? {})},
    auth:{...base.auth,...(overrides.auth ?? {})},
    transport:{...base.transport,...(overrides.transport ?? {})},
    tls:{...base.tls,...(overrides.tls ?? {})},
  };
}

function vaultHarness({loadError = null} = {}) {
  const calls = {load:0,save:0,saveMerged:0,clear:0};
  const vault = {
    normalizeSecrets:(_plugin,secrets) => Object.fromEntries(
      Object.entries(secrets ?? {}).filter(([,value]) => String(value ?? '')),
    ),
    load:async () => {
      calls.load += 1;
      if (loadError) throw loadError;
      return {password:'saved-password',tlsPassphrase:'saved-tls'};
    },
    save:async () => { calls.save += 1; },
    saveMerged:async () => { calls.saveMerged += 1; },
    clear:async () => { calls.clear += 1; },
  };
  return {vault,calls};
}

test('same credential identity reuses saved credentials across resource and Agent-only changes', async () => {
  const {vault,calls} = vaultHarness();
  const resolver = new CredentialUseResolver(vault);
  for (const [committedPlugin,draft] of [
    [mysql(),mysql({displayName:'Renamed',target:{database:'archive'},policy:{select:'confirm'}})],
    [redis(),redis({target:{db:5},patterns:[{patternId:'orders',pattern:'orders:*',displayName:'Orders'}]})],
  ]) {
    const resolved = await resolver.resolve({
      committedPlugin,draft,credentialIntent:'unchanged',purpose:'resource-access',caller:'main',
    });
    assert.equal(resolved.source,'saved');
    assert.deepEqual(resolved.secrets,{password:'saved-password',tlsPassphrase:'saved-tls'});
  }
  assert.equal(calls.load,2);
  assert.deepEqual({...calls,load:0},{load:0,save:0,saveMerged:0,clear:0});
});

test('identity and security-path changes reject unchanged without reading or writing the vault', async () => {
  for (const draft of [
    mysql({target:{host:'other.internal'}}),
    mysql({target:{port:3307}}),
    mysql({auth:{username:'other'}}),
    mysql({tls:{mode:'disabled'}}),
    mysql({transport:{kind:'windowsVpn',interfaceAlias:'VPN'}}),
  ]) {
    const {vault,calls} = vaultHarness();
    const resolver = new CredentialUseResolver(vault);
    await assert.rejects(
      () => resolver.resolve({
        committedPlugin:mysql(),draft,credentialIntent:'unchanged',
        purpose:'resource-discovery',caller:'main',
      }),
      (error) => error.code === 'CREDENTIAL_REBIND_REQUIRED',
    );
    assert.deepEqual(calls,{load:0,save:0,saveMerged:0,clear:0});
  }
});

test('non-empty temporary replacement has priority and empty replacement remains unchanged', async () => {
  const {vault,calls} = vaultHarness();
  const resolver = new CredentialUseResolver(vault);
  const replaced = await resolver.resolve({
    committedPlugin:mysql(),draft:mysql({target:{host:'other.internal'}}),
    credentialIntent:'replace',temporarySecrets:{password:'new-password',tlsPassphrase:''},
    purpose:'resource-discovery',caller:'main',
  });
  assert.equal(replaced.source,'temporary');
  assert.deepEqual(replaced.secrets,{password:'new-password'});
  assert.equal(calls.load,0);

  await assert.rejects(
    () => resolver.resolve({
      committedPlugin:mysql(),draft:mysql({target:{host:'other.internal'}}),
      credentialIntent:'replace',temporarySecrets:{password:''},
      purpose:'resource-discovery',caller:'main',
    }),
    (error) => error.code === 'CREDENTIAL_REBIND_REQUIRED',
  );
  assert.deepEqual(calls,{load:0,save:0,saveMerged:0,clear:0});
});

test('explicit rebind loads the committed binding and unreadable credentials remain untouched', async () => {
  const readable = vaultHarness();
  const resolver = new CredentialUseResolver(readable.vault);
  const rebound = await resolver.resolve({
    committedPlugin:mysql(),draft:mysql({target:{host:'other.internal'}}),
    credentialIntent:{mode:'rebind-existing'},purpose:'health-check',caller:'main',
  });
  assert.equal(rebound.source,'rebound');
  assert.equal(rebound.secrets.password,'saved-password');
  assert.equal(readable.calls.load,1);

  const unreadableError = new AppError('CREDENTIAL_DECRYPT_FAILED','unreadable');
  const unreadable = vaultHarness({loadError:unreadableError});
  await assert.rejects(
    () => new CredentialUseResolver(unreadable.vault).resolve({
      committedPlugin:mysql(),draft:mysql({target:{database:'archive'}}),
      credentialIntent:'unchanged',purpose:'resource-access',caller:'main',
    }),
    (error) => error === unreadableError,
  );
  assert.deepEqual(unreadable.calls,{load:1,save:0,saveMerged:0,clear:0});
});

test('partial temporary replacement merges saved fields only for an unchanged credential identity',async () => {
  const {vault,calls} = vaultHarness();
  const resolver = new CredentialUseResolver(vault);
  const result = await resolver.resolve({
    committedPlugin:mysql(),draft:mysql({target:{database:'archive'}}),
    temporarySecrets:{password:'replacement'},credentialIntent:'replace',
    purpose:'resource-access',caller:'main',
  });
  assert.deepEqual(result.secrets,{password:'replacement',tlsPassphrase:'saved-tls'});
  assert.equal(calls.load,1);
  const probe = await resolver.resolve({
    committedPlugin:null,draft:mysql(),temporarySecrets:{password:'replacement'},
    purpose:'resource-access',caller:'main',
  });
  assert.deepEqual(probe.secrets,{password:'replacement'});
  const changedIdentity = await resolver.resolve({
    committedPlugin:mysql(),draft:mysql({target:{host:'other.invalid'}}),
    temporarySecrets:{password:'replacement'},purpose:'resource-access',caller:'main',
  });
  assert.deepEqual(changedIdentity.secrets,{password:'replacement'});
  assert.equal(calls.load,1);
});

test('explicit temporary values still validate when same-identity saved credentials are unavailable',async () => {
  for (const loadError of [
    ...['CREDENTIAL_BINDING_MISMATCH','CREDENTIAL_DECRYPT_FAILED','CREDENTIAL_ENCRYPTION_UNAVAILABLE','CREDENTIAL_STORE_INVALID']
      .map((code) => new AppError(code,'Test vault unavailable.')),
    Object.assign(new Error('Test credential file unavailable.'),{code:'EACCES'}),
  ]) {
    const {vault,calls} = vaultHarness({loadError});
    const result = await new CredentialUseResolver(vault).resolve({
      committedPlugin:mysql(),draft:mysql(),temporarySecrets:{password:'replacement'},
      credentialIntent:'replace',purpose:'resource-access',caller:'main',
    });
    assert.deepEqual(result.secrets,{password:'replacement'});
    assert.deepEqual(calls,{load:1,save:0,saveMerged:0,clear:0});
  }
});

test('one-time grants bind session, generation, purpose, digest, and single consumption', async () => {
  const {vault,calls} = vaultHarness();
  const resolver = new CredentialUseResolver(vault,{now:() => 1000});
  const draft = mysql({target:{host:'other.internal'}});
  const grant = resolver.createOneTimeGrant({
    editSessionId:'edit-1',draftGeneration:3,purpose:'resource-discovery',draft,ttlMs:5000,
  });
  const resolved = await resolver.resolve({
    committedPlugin:mysql(),draft,credentialIntent:'unchanged',oneTimeGrant:grant,
    editSessionId:'edit-1',draftGeneration:3,purpose:'resource-discovery',caller:'main',
  });
  assert.equal(resolved.source,'one-time-grant');
  assert.equal(calls.load,1);
  await assert.rejects(
    () => resolver.resolve({
      committedPlugin:mysql(),draft,credentialIntent:'unchanged',oneTimeGrant:grant,
      editSessionId:'edit-1',draftGeneration:3,purpose:'resource-discovery',caller:'main',
    }),
    (error) => error.code === 'CREDENTIAL_GRANT_INVALID',
  );

  for (const mutation of [
    {editSessionId:'edit-2'},
    {draftGeneration:4},
    {purpose:'health-check'},
    {draft:mysql({target:{host:'third.internal'}})},
  ]) {
    const nextDraft = mutation.draft ?? draft;
    const nextGrant = resolver.createOneTimeGrant({
      editSessionId:'edit-1',draftGeneration:3,purpose:'resource-discovery',draft,ttlMs:5000,
    });
    await assert.rejects(
      () => resolver.resolve({
        committedPlugin:mysql(),draft:nextDraft,credentialIntent:'unchanged',oneTimeGrant:nextGrant,
        editSessionId:'edit-1',draftGeneration:3,purpose:'resource-discovery',caller:'main',
        ...mutation,
      }),
      (error) => error.code === 'CREDENTIAL_GRANT_INVALID',
    );
  }
  assert.equal(calls.load,1,'invalid and late grant ownership never reaches the vault');
  assert.deepEqual({...calls,load:0},{load:0,save:0,saveMerged:0,clear:0});
});

test('resolver never releases secrets to a renderer caller', async () => {
  const {vault,calls} = vaultHarness();
  await assert.rejects(
    () => new CredentialUseResolver(vault).resolve({
      committedPlugin:mysql(),draft:mysql(),credentialIntent:'unchanged',
      purpose:'health-check',caller:'renderer',
    }),
    (error) => error.code === 'CREDENTIAL_ACCESS_DENIED',
  );
  assert.deepEqual(calls,{load:0,save:0,saveMerged:0,clear:0});
});
