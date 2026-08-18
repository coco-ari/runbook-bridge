import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPluginConnectionAdapter,
  pluginConnectionAdapters,
} from '../src/plugin-connection-adapters.mjs';

function server(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',displayName:'Server',
    configState:'ready',target:{host:'app.internal',port:22,addressFamily:'ipv4Only'},
    auth:{type:'password',username:'deploy'},uplink:{type:'direct'},tunnelProvider:true,
    policy:{status:'auto'},limits:{timeoutMs:10_000},...overrides,
  };
}

function mysql(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',displayName:'MySQL',
    configState:'ready',target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'required'},
    policy:{select:'auto'},limits:{maxRows:100},...overrides,
  };
}

function redis(overrides = {}) {
  return {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'redis-1',pluginType:'redis',displayName:'Redis',
    configState:'ready',target:{host:'cache.internal',port:6379,db:0,addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    patterns:[{patternId:'orders',pattern:'orders:*'}],policy:{read:'auto'},limits:{maxKeys:100},...overrides,
  };
}

test('all plugin adapters assess complete committed configurations without side effects', () => {
  assert.deepEqual(Object.keys(pluginConnectionAdapters).sort(), ['mysql','redis','server']);
  for (const plugin of [server(),mysql(),redis()]) {
    const frozen = structuredClone(plugin);
    const assessment = getPluginConnectionAdapter(plugin.pluginType).assessConfiguration(plugin,'connection');
    assert.deepEqual(assessment,{state:'complete',issues:[]});
    assert.deepEqual(plugin,frozen);
  }
  assert.throws(() => getPluginConnectionAdapter('unknown'),/Unsupported plugin type/u);
});

test('Server returns stable field issues for target, authentication, and route prerequisites', () => {
  const adapter = getPluginConnectionAdapter('server');
  const plugin = server({
    target:{host:'',port:70_000,addressFamily:'invalid'},
    auth:{type:'privateKey',username:'',privateKeyPath:''},
    uplink:{type:'http',host:'',port:0},
  });
  const result = adapter.assessConfiguration(plugin,'server-auth');
  assert.equal(result.state,'invalid');
  assert.deepEqual(result.issues.map(({field,code}) => [field,code]),[
    ['target.host','REQUIRED'],
    ['target.port','INVALID_PORT'],
    ['target.addressFamily','INVALID_ADDRESS_FAMILY'],
    ['auth.username','REQUIRED'],
    ['auth.privateKeyPath','REQUIRED'],
    ['uplink.host','REQUIRED'],
    ['uplink.port','INVALID_PORT'],
  ]);
});

test('MySQL discovery does not require a database while connection and resource access do', () => {
  const adapter = getPluginConnectionAdapter('mysql');
  const plugin = mysql({target:{...mysql().target,database:''}});
  assert.deepEqual(adapter.assessConfiguration(plugin,'resource-discovery'),{state:'complete',issues:[]});
  for (const purpose of ['connection','resource-access','health-check']) {
    const result = adapter.assessConfiguration(plugin,purpose);
    assert.equal(result.state,'incomplete');
    assert.deepEqual(result.issues.map(({field,code}) => [field,code]),[['target.database','REQUIRED']]);
  }
  const invalid = adapter.assessConfiguration(mysql({
    target:{host:'',port:-1,database:'orders',addressFamily:'bad'},
    auth:{username:''},transport:{kind:'windowsVpn'},tls:{mode:'bogus'},
  }),'resource-discovery');
  assert.equal(invalid.state,'invalid');
  assert.deepEqual(invalid.issues.map(({field,code}) => [field,code]),[
    ['target.host','REQUIRED'],
    ['target.port','INVALID_PORT'],
    ['target.addressFamily','INVALID_ADDRESS_FAMILY'],
    ['auth.username','REQUIRED'],
    ['transport.interfaceAlias','REQUIRED'],
    ['tls.mode','INVALID_TLS_MODE'],
  ]);
});

test('Redis defaults a missing logical DB to 0 and rejects nonzero Cluster databases', () => {
  const adapter = getPluginConnectionAdapter('redis');
  const legacy = redis({target:{host:'cache.internal',port:6379,addressFamily:'ipv4Only'}});
  assert.deepEqual(adapter.resourceScope(legacy),{
    state:'selected-unverified',kind:'redis-logical-db',value:0,
  });
  assert.deepEqual(adapter.resourceScope(legacy,{verified:true}),{
    state:'verified',kind:'redis-logical-db',value:0,
  });
  const cluster = adapter.assessConfiguration(redis({
    mode:'cluster',target:{...redis().target,db:2},
  }),'connection');
  assert.equal(cluster.state,'invalid');
  assert.deepEqual(cluster.issues.map(({field,code}) => [field,code]),[
    ['target.db','REDIS_CLUSTER_DB_UNSUPPORTED'],
  ]);
  const invalid = adapter.assessConfiguration(redis({target:{...redis().target,db:16}}),'connection');
  assert.deepEqual(invalid.issues.map(({field,code}) => [field,code]),[['target.db','INVALID_REDIS_DB']]);
});

test('resource scopes distinguish missing, selected-unverified, verified, and not-required', () => {
  const serverAdapter = getPluginConnectionAdapter('server');
  const mysqlAdapter = getPluginConnectionAdapter('mysql');
  assert.deepEqual(serverAdapter.resourceScope(server()),{state:'not-required',kind:null,value:null});
  assert.deepEqual(mysqlAdapter.resourceScope(mysql({target:{...mysql().target,database:''}})),{
    state:'missing',kind:'mysql-database',value:null,
  });
  assert.deepEqual(mysqlAdapter.resourceScope(mysql()),{
    state:'selected-unverified',kind:'mysql-database',value:'orders',
  });
  assert.deepEqual(mysqlAdapter.resourceScope(mysql(),{verified:true}),{
    state:'verified',kind:'mysql-database',value:'orders',
  });
});

test('credential identity excludes display and resource scope but includes the security path', () => {
  const adapter = getPluginConnectionAdapter('mysql');
  const original = mysql();
  const resourceOnly = mysql({
    displayName:'Renamed',
    target:{...original.target,database:'billing'},
    policy:{select:'confirm'},
  });
  assert.deepEqual(adapter.credentialIdentity(resourceOnly),adapter.credentialIdentity(original));

  const secured = mysql({
    target:{...original.target,database:'billing'},
    transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'},
    tls:{mode:'verifyIdentity'},
  });
  assert.notDeepEqual(adapter.credentialIdentity(secured),adapter.credentialIdentity(original));

  const redisAdapter = getPluginConnectionAdapter('redis');
  assert.deepEqual(
    redisAdapter.credentialIdentity(redis({target:{...redis().target,db:5},patterns:[]})),
    redisAdapter.credentialIdentity(redis()),
  );

  const serverAdapter = getPluginConnectionAdapter('server');
  const firstKey = server({auth:{type:'privateKey',username:'deploy',privateKeyPath:'C:\\keys\\first.pem'}});
  const secondKey = server({auth:{type:'privateKey',username:'deploy',privateKeyPath:'C:\\keys\\second.pem'}});
  assert.notDeepEqual(serverAdapter.credentialIdentity(firstKey),serverAdapter.credentialIdentity(secondKey));
});

test('validation digests are purpose-specific and stable', () => {
  const adapter = getPluginConnectionAdapter('mysql');
  const original = mysql();
  const databaseChanged = mysql({target:{...original.target,database:'billing'}});
  const hostChanged = mysql({target:{...original.target,host:'db-new.internal'}});
  assert.match(adapter.validationDigest(original,'resource-discovery'),/^[a-f0-9]{64}$/u);
  assert.equal(
    adapter.validationDigest(databaseChanged,'resource-discovery'),
    adapter.validationDigest(original,'resource-discovery'),
  );
  assert.notEqual(
    adapter.validationDigest(databaseChanged,'resource-access'),
    adapter.validationDigest(original,'resource-access'),
  );
  assert.notEqual(
    adapter.validationDigest(hostChanged,'resource-discovery'),
    adapter.validationDigest(original,'resource-discovery'),
  );
  assert.notEqual(
    adapter.validationDigest(original,'resource-discovery'),
    adapter.validationDigest(original,'resource-access'),
  );
});

test('dependency references and changed-path classification use the shared domain rules', () => {
  const adapter = getPluginConnectionAdapter('mysql');
  const direct = mysql();
  const tunneled = mysql({transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'}});
  assert.deepEqual(adapter.dependencyRefs(direct),[]);
  assert.deepEqual(adapter.dependencyRefs(tunneled),['server-1']);
  assert.equal(adapter.classifyChangedPath('target.database',{before:direct,after:direct}),'session-affecting');
  assert.equal(adapter.classifyChangedPath('transport.kind',{before:direct,after:tunneled}),'dependency-affecting');
});

test('validation adapters preserve edit-session ownership metadata through the runtime boundary', async () => {
  const draft = mysql();
  let received;
  const metadata = {
    editSessionId:'edit-1',operationId:'operation-1',draftGeneration:7,
    configDigest:'a'.repeat(64),requestId:'request-1',
  };
  const result = await getPluginConnectionAdapter('mysql').validate({
    draft,
    purpose:'resource-access',
    resolvedSecrets:{password:'temporary'},
    signal:new AbortController().signal,
    runtimeFacade:{validate:async (payload) => { received = payload; return {ok:true}; }},
    ...metadata,
  });

  assert.deepEqual(result,{ok:true});
  assert.equal(received.pluginType,'mysql');
  assert.equal(received.draft,draft);
  assert.deepEqual(received.resolvedSecrets,{password:'temporary'});
  for (const [key,value] of Object.entries(metadata)) assert.equal(received[key],value);
});
