import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPluginChange,
  pluginAgentFingerprint,
  pluginConnectionFingerprint,
  pluginSemanticProjection,
} from '../src/plugin-change-classifier.mjs';

function server(overrides = {}) {
  return {
    schemaVersion:1,projectId:'p1',environmentId:'e1',pluginInstanceId:'server-1',pluginType:'server',
    displayName:'Application server',description:'primary',tags:['prod'],displayOrder:1,
    revision:4,updatedAt:'2026-08-18T00:00:00.000Z',configState:'ready',
    target:{host:'app.internal',port:22,addressFamily:'ipv4Only',hostKeyFingerprint:'SHA256:old'},
    auth:{type:'password',username:'deploy'},uplink:{type:'direct'},tunnelProvider:true,
    sources:[{sourceId:'logs',displayName:'Logs',path:'/var/log/app.log'}],
    actions:[{actionId:'service.status',serviceName:'app.service',displayName:'Status'}],
    policy:{status:'auto',logs:'auto'},limits:{timeoutMs:10_000,maxBytes:262_144},
    ...overrides,
  };
}

function mysql(overrides = {}) {
  return {
    schemaVersion:1,projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-1',pluginType:'mysql',
    displayName:'Orders database',revision:2,updatedAt:'2026-08-18T00:00:00.000Z',configState:'ready',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'required'},
    policy:{select:'auto',describe:'auto'},limits:{maxRows:100,maxBytes:1_048_576,timeoutMs:10_000,maxConcurrency:1},
    ...overrides,
  };
}

function redis(overrides = {}) {
  return {
    schemaVersion:1,projectId:'p1',environmentId:'e1',pluginInstanceId:'redis-1',pluginType:'redis',
    displayName:'Orders cache',revision:3,updatedAt:'2026-08-18T00:00:00.000Z',configState:'ready',
    target:{host:'cache.internal',port:6379,db:0,addressFamily:'ipv4Only'},
    auth:{username:'reader'},transport:{kind:'direct'},tls:{mode:'disabled'},
    patterns:[{patternId:'orders',pattern:'orders:*',displayName:'Orders'}],
    policy:{scan:'auto',read:'auto'},limits:{maxKeys:100,maxValueBytes:65_536,timeoutMs:5_000,maxConcurrency:1},
    ...overrides,
  };
}

function changed(value, path, replacement) {
  const output = structuredClone(value);
  const parts = path.split('.');
  let target = output;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = replacement;
  return output;
}

test('record bookkeeping and normalization-equivalent objects classify as none', () => {
  const before = server();
  const after = {
    ...structuredClone(before),
    revision:99,
    updatedAt:'later',
    target:{addressFamily:'ipv4Only',port:22,hostKeyFingerprint:'SHA256:old',host:'app.internal'},
  };
  assert.deepEqual(classifyPluginChange({before,after}), {
    kind:'none',changedPaths:[],affectedPluginInstanceIds:[],credentialMutation:'none',
  });
  assert.deepEqual(pluginSemanticProjection(before), pluginSemanticProjection(after));
});

test('metadata and Agent fields have distinct change kinds and fingerprint impact', () => {
  const before = server();
  for (const [path,value] of [
    ['displayName','Renamed'],['description','new description'],['tags',['critical']],['displayOrder',9],
  ]) {
    const after = changed(before,path,value);
    const result = classifyPluginChange({before,after});
    assert.equal(result.kind,'metadata',path);
    assert.deepEqual(result.changedPaths,[path]);
    assert.equal(pluginConnectionFingerprint(after),pluginConnectionFingerprint(before),path);
    assert.equal(pluginAgentFingerprint(after),pluginAgentFingerprint(before),path);
  }
  for (const [path,value] of [
    ['policy.logs','confirm'],['sources',[]],['actions',[]],['limits.timeoutMs',20_000],
  ]) {
    const after = changed(before,path,value);
    const result = classifyPluginChange({before,after});
    assert.equal(result.kind,'agent-policy-scope',path);
    assert.equal(pluginConnectionFingerprint(after),pluginConnectionFingerprint(before),path);
    assert.notEqual(pluginAgentFingerprint(after),pluginAgentFingerprint(before),path);
  }
});

test('connection fields for every plugin type are session-affecting', () => {
  const cases = [
    [server(),'target.host','new.internal'],
    [server(),'target.port',2202],
    [server(),'target.addressFamily','ipv6Only'],
    [server(),'target.hostKeyFingerprint','SHA256:new'],
    [server(),'auth.username','root'],
    [server(),'auth.type','agent'],
    [server(),'uplink',{type:'windowsVpn',interfaceAlias:'VPN'}],
    [mysql(),'target.host','new-db.internal'],
    [mysql(),'target.port',3307],
    [mysql(),'target.database','billing'],
    [mysql(),'target.addressFamily','ipv6Preferred'],
    [mysql(),'auth.username','reporter'],
    [mysql(),'tls.mode','verifyIdentity'],
    [redis(),'target.host','new-cache.internal'],
    [redis(),'target.port',6380],
    [redis(),'target.db',4],
    [redis(),'target.addressFamily','ipv6Only'],
    [redis(),'auth.username','cache-reader'],
    [redis(),'tls.mode','required'],
  ];
  for (const [before,path,value] of cases) {
    const after = changed(before,path,value);
    const result = classifyPluginChange({before,after});
    assert.equal(result.kind,'session-affecting',`${before.pluginType}:${path}`);
    assert.ok(result.changedPaths.some((item) => item === path || item.startsWith(`${path}.`)),path);
    assert.notEqual(pluginConnectionFingerprint(after),pluginConnectionFingerprint(before),path);
  }
});

test('provider references, capability, and provider connection changes with dependents are dependency-affecting', () => {
  const tunneled = mysql({transport:{kind:'serverTunnel',serverPluginInstanceId:'server-1'}});
  const direct = mysql();
  assert.equal(classifyPluginChange({before:direct,after:tunneled}).kind,'dependency-affecting');

  const provider = server();
  const disabled = changed(provider,'tunnelProvider',false);
  assert.equal(classifyPluginChange({before:provider,after:disabled}).kind,'dependency-affecting');

  const moved = changed(provider,'target.host','provider-new.internal');
  const result = classifyPluginChange({
    before:provider,
    after:moved,
    dependentPluginInstanceIds:['mysql-1','redis-1','mysql-1'],
  });
  assert.equal(result.kind,'dependency-affecting');
  assert.deepEqual(result.affectedPluginInstanceIds,['server-1','mysql-1','redis-1']);
});

test('credential intent is authoritative and can never classify as none or metadata', () => {
  for (const credentialMutation of ['replace','rebind-existing','clear-explicit']) {
    const result = classifyPluginChange({before:mysql(),after:mysql(),credentialMutation});
    assert.equal(result.kind,'session-affecting',credentialMutation);
    assert.deepEqual(result.changedPaths,[]);
    assert.deepEqual(result.affectedPluginInstanceIds,['mysql-1']);
    assert.equal(result.credentialMutation,credentialMutation);
  }
  assert.throws(
    () => classifyPluginChange({before:mysql(),after:mysql(),credentialMutation:'renderer-says-none'}),
    /credential mutation/u,
  );
});

test('fingerprints are stable across key order and isolate connection from Agent configuration', () => {
  const before = redis();
  const reordered = {
    ...structuredClone(before),
    target:{db:0,addressFamily:'ipv4Only',port:6379,host:'cache.internal'},
    policy:{read:'auto',scan:'auto'},
  };
  assert.match(pluginConnectionFingerprint(before),/^[a-f0-9]{64}$/u);
  assert.match(pluginAgentFingerprint(before),/^[a-f0-9]{64}$/u);
  assert.equal(pluginConnectionFingerprint(before),pluginConnectionFingerprint(reordered));
  assert.equal(pluginAgentFingerprint(before),pluginAgentFingerprint(reordered));

  const patternsChanged = changed(before,'patterns',[{patternId:'billing',pattern:'billing:*',displayName:'Billing'}]);
  assert.equal(pluginConnectionFingerprint(patternsChanged),pluginConnectionFingerprint(before));
  assert.notEqual(pluginAgentFingerprint(patternsChanged),pluginAgentFingerprint(before));

  const dbChanged = changed(before,'target.db',3);
  assert.notEqual(pluginConnectionFingerprint(dbChanged),pluginConnectionFingerprint(before));
  assert.equal(pluginAgentFingerprint(dbChanged),pluginAgentFingerprint(before));

  const clusterMode = {...structuredClone(before),mode:'cluster'};
  assert.equal(classifyPluginChange({before,after:clusterMode}).kind,'session-affecting');
  assert.notEqual(pluginConnectionFingerprint(clusterMode),pluginConnectionFingerprint(before));
});
