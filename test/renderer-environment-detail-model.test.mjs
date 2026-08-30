import assert from 'node:assert/strict';
import test from 'node:test';
import {buildEnvironmentDetailModel} from '../renderer/v2/src/features/environments/environment-detail-model.ts';

const scope = {projectId:'project-one',environmentId:'environment-one'};

function plugin(id,overrides = {}) {
  return {
    pluginInstanceId:id,displayName:id,pluginType:'server',configState:'ready',
    revision:1,status:'disconnected',...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    ...scope,phase:'disconnected',sequence:1,plugins:{},pluginsPartial:false,
    connectedCount:0,blockedCount:0,errorCount:0,draftCount:0,eligibleCount:0,
    ...overrides,
  };
}

function environment(plugins,overrides = {}) {
  return {
    ...scope,name:'测试环境',revision:1,status:'disconnected',
    pluginCount:plugins.length,readyPluginCount:plugins.length,draftCount:0,
    resourcePreview:plugins,resourcePreviewTruncated:false,
    runtime:{...runtime(),plugins:[],desiredConnected:false,status:'disconnected'},
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('environment detail prefers the complete catalog and treats unknown configuration conservatively',() => {
  const plugins = [
    plugin('plugin-one'),
    plugin('plugin-two',{configState:'draft'}),
    plugin('plugin-three',{configState:'unknown'}),
    plugin('plugin-four'),
  ];
  const preview = environment(plugins.slice(0,1),{
    pluginCount:9,resourcePreviewTruncated:true,draftCount:8,
  });
  const model = buildEnvironmentDetailModel({environment:preview,plugins,runtime:null});
  assert.deepEqual(model.rows.map((row) => row.plugin.pluginInstanceId),plugins.map((item) => item.pluginInstanceId));
  assert.equal(model.summary.total,4,'a stale overview count must not override the loaded catalog');
  assert.equal(model.summary.draft,2,'unknown configuration must not appear complete');
  assert.equal(model.partial,false,'a full catalog supersedes a truncated preview');
  assert.match(model.rows[2].description,/配置状态未知/u);

  const empty = buildEnvironmentDetailModel({environment:preview,plugins:[],runtime:null});
  assert.deepEqual(empty.rows,[],'an empty loaded catalog must not revive the old preview');
  assert.equal(empty.summary.total,0);
  assert.equal(empty.summary.draft,0);
});

test('preview-only detail retains whole-environment totals and draft information',() => {
  const preview = environment([plugin('plugin-one')],{
    pluginCount:12,draftCount:4,resourcePreviewTruncated:true,
  });
  const model = buildEnvironmentDetailModel({
    environment:preview,plugins:null,
    runtime:runtime({draftCount:2,pluginsPartial:true}),
  });
  assert.equal(model.rows.length,1);
  assert.equal(model.summary.total,12);
  assert.equal(model.summary.draft,4,'a partial snapshot cannot claim all unseen configuration is ready');
  assert.equal(model.partial,true);
});

test('foreign project and environment runtimes cannot change rows, dependencies or counts',() => {
  const plugins = [plugin('plugin-one'),plugin('server-one')];
  for (const foreignScope of [
    {projectId:'project-other'},
    {environmentId:'environment-other'},
  ]) {
    const model = buildEnvironmentDetailModel({
      environment:environment(plugins),plugins,
      runtime:runtime({
        ...foreignScope,phase:'connected',connectedCount:2,errorCount:2,
        plugins:{'plugin-one':{
          phase:'connected',providerPluginInstanceId:'server-one',
          reason:'SYNTHETIC_PRIVATE_REASON',error:{message:'SYNTHETIC_PRIVATE_MESSAGE'},
        }},
      }),
    });
    assert.equal(model.rows[0].status,'disconnected');
    assert.equal(model.rows[0].providerName,null);
    assert.match(model.rows[0].description,/状态尚未更新/u);
    assert.equal(model.summary.connected,0);
    assert.equal(model.summary.error,0);
    assert.equal(model.partial,true);
    assert.doesNotMatch(JSON.stringify(model),/SYNTHETIC_PRIVATE/u);
  }
});

test('runtime node ids and nested scopes must match before a node affects display',() => {
  const plugins = [plugin('plugin-one',{status:'error'}),plugin('server-one')];
  const rejectedNodes = [
    {pluginInstanceId:'plugin-other'},
    {projectId:'project-other'},
    {environmentId:'environment-other'},
    {scope:{...scope,pluginInstanceId:'plugin-other'}},
    {assessment:{scope:{...scope,environmentId:'environment-other',pluginInstanceId:'plugin-one'}}},
  ];
  for (const rejected of rejectedNodes) {
    const model = buildEnvironmentDetailModel({
      environment:environment(plugins),plugins,
      runtime:runtime({plugins:{'plugin-one':{
        phase:'connected',providerPluginInstanceId:'server-one',...rejected,
      }}}),
    });
    assert.equal(model.rows[0].status,'error','the last normalized plugin status is retained');
    assert.equal(model.rows[0].providerName,null);
    assert.match(model.rows[0].description,/状态尚未更新/u);
    assert.equal(model.partial,true);
  }
});

test('partial runtime nodes do not lower aggregate connected or error totals',() => {
  const plugins = Array.from({length:10},(_,index) => plugin(`plugin-${index}`,{
    status:index === 9 ? 'connected' : 'disconnected',
  }));
  const model = buildEnvironmentDetailModel({
    environment:environment(plugins),plugins,
    runtime:runtime({
      phase:'partial',pluginsPartial:true,connectedCount:5,errorCount:2,blockedCount:8,
      plugins:{'plugin-0':{phase:'waitingDependency'}},
    }),
  });
  assert.equal(model.summary.total,10);
  assert.equal(model.summary.connected,5);
  assert.equal(model.summary.error,2);
  assert.equal(model.summary.waitingDependency,1);
  assert.equal(model.rows[9].status,'connected');
  assert.match(model.rows[9].description,/状态尚未更新/u);
  assert.equal(model.partial,true);
});

test('waiting dependencies exclude credential, host-key and unknown blocking reasons',() => {
  const plugins = ['waiting-one','provider-blocked','credential-blocked','host-key-blocked','other-blocked']
    .map((id) => plugin(id));
  const model = buildEnvironmentDetailModel({
    environment:environment(plugins),plugins,
    runtime:runtime({blockedCount:5,plugins:{
      'waiting-one':{phase:'waitingDependency'},
      'provider-blocked':{phase:'blocked',reason:'TUNNEL_PROVIDER_UNAVAILABLE'},
      'credential-blocked':{phase:'blocked',reason:'CREDENTIAL_UNAVAILABLE'},
      'host-key-blocked':{phase:'blocked',reason:'SSH_HOST_KEY_CONFIRM_REQUIRED'},
      'other-blocked':{phase:'blocked',reason:'SYNTHETIC_UNRECOGNIZED_REASON'},
    }}),
  });
  assert.equal(model.summary.waitingDependency,2);
  assert.match(model.rows[2].description,/凭据不可用/u);
  assert.match(model.rows[3].description,/确认服务器指纹/u);
  assert.match(model.rows[4].description,/重新确认/u);
  assert.doesNotMatch(JSON.stringify(model),/SYNTHETIC_UNRECOGNIZED_REASON/u);
});

test('dependency names come only from the current plugin catalog',() => {
  const plugins = [
    plugin('database-one',{pluginType:'mysql'}),
    plugin('server-one',{displayName:'当前环境 Server'}),
    plugin('database-two',{pluginType:'mysql'}),
  ];
  for (const [providerId,expectedName] of [
    ['server-one','当前环境 Server'],
    ['foreign-server',null],
    ['database-one',null],
    ['database-two',null],
    [null,null],
  ]) {
    const model = buildEnvironmentDetailModel({
      environment:environment(plugins),plugins,
      runtime:runtime({plugins:{
        'database-one':{
          phase:'waitingDependency',providerPluginInstanceId:providerId,
          providerName:'SYNTHETIC_RAW_PROVIDER',displayName:'SYNTHETIC_RAW_PLUGIN',
        },
        'foreign-server':{phase:'connected',displayName:'SYNTHETIC_RAW_PROVIDER'},
      }}),
    });
    assert.equal(model.rows[0].providerName,expectedName);
    assert.equal(model.rows.length,3,'runtime-only nodes must not add a new directory entry');
    if (!expectedName) assert.match(model.rows[0].description,/依赖插件暂不可用/u);
    assert.doesNotMatch(JSON.stringify(model),/SYNTHETIC_RAW/u);
  }
});

test('known runtime reasons produce fixed descriptions without operational payloads',() => {
  const cases = [
    ['config','disconnected','PLUGIN_CONFIG_INCOMPLETE','配置未完善'],
    ['fingerprint','blocked','SSH_HOST_KEY_CONFIRM_REQUIRED','确认服务器指纹'],
    ['credential','error','CREDENTIAL_BINDING_MISMATCH','凭据不可用'],
    ['failure','error','SYNTHETIC_PRIVATE_REASON','连接失败'],
    ['connecting','connecting',null,'正在连接'],
    ['reconnecting','reconnecting','NETWORK_RECONNECTING','正在重新连接'],
    ['disconnecting','disconnecting','CONNECT_CANCELLED','正在断开连接'],
    ['manual','disconnected','USER_DISCONNECTED','已手动断开'],
    ['cancelled','disconnected','CONNECT_CANCELLED','连接已取消'],
  ];
  const plugins = cases.map(([id]) => plugin(`plugin-${id}`));
  const model = buildEnvironmentDetailModel({
    environment:environment(plugins),plugins,
    runtime:runtime({plugins:Object.fromEntries(cases.map(([id,phase,reason]) => [
      `plugin-${id}`,{
        phase,reason,message:'SYNTHETIC_PRIVATE_MESSAGE',credential:'SYNTHETIC_PRIVATE_CREDENTIAL',
        error:{code:'SYNTHETIC_PRIVATE_CODE',message:'SYNTHETIC_PRIVATE_MESSAGE',details:{value:'SYNTHETIC_PRIVATE_DETAILS'}},
      },
    ]))}),
  });
  for (const [index,entry] of cases.entries()) assert.ok(model.rows[index].description.includes(entry[3]));
  assert.doesNotMatch(JSON.stringify(model),/SYNTHETIC_PRIVATE|"error":\{|"credential":|"details":/u);
});

test('unknown phases and contradictory assessments cannot claim a connected plugin',() => {
  const plugins = [plugin('plugin-unknown'),plugin('plugin-disconnected'),plugin('plugin-blocked')];
  const model = buildEnvironmentDetailModel({
    environment:environment(plugins),plugins,
    runtime:runtime({plugins:{
      'plugin-unknown':{phase:'SYNTHETIC_UNKNOWN_PHASE',assessment:{primaryStatus:{kind:'connected'}}},
      'plugin-disconnected':{phase:'disconnected',assessment:{primaryStatus:{kind:'connected'}}},
      'plugin-blocked':{phase:'blocked',reason:'TUNNEL_PROVIDER_UNAVAILABLE',assessment:{primaryStatus:{kind:'disconnected'}}},
    }}),
  });
  assert.equal(model.rows[0].status,'disconnected');
  assert.match(model.rows[0].description,/连接状态未知/u);
  assert.equal(model.rows[1].status,'disconnected');
  assert.equal(model.rows[2].status,'blocked');
  assert.doesNotMatch(JSON.stringify(model),/SYNTHETIC_UNKNOWN_PHASE/u);
});

test('aggregate fallback is scoped, bounded, and does not mistake absent counters for zero',() => {
  const plugins = Array.from({length:6},(_,index) => plugin(`plugin-${index}`));
  const currentEnvironment = environment(plugins);
  currentEnvironment.runtime = {...currentEnvironment.runtime,connectedCount:4,errorCount:2};
  const incoming = runtime({pluginsPartial:true,connectedCount:undefined,errorCount:undefined});
  const model = buildEnvironmentDetailModel({environment:currentEnvironment,plugins,runtime:incoming});
  assert.equal(model.summary.connected,4);
  assert.equal(model.summary.error,2);

  const foreignCache = {...currentEnvironment,runtime:{...currentEnvironment.runtime,projectId:'project-other'}};
  const safe = buildEnvironmentDetailModel({environment:foreignCache,plugins,runtime:null});
  assert.equal(safe.summary.connected,0);
  assert.equal(safe.summary.error,0);

  const bounded = buildEnvironmentDetailModel({
    environment:currentEnvironment,plugins,runtime:runtime({connectedCount:100,errorCount:100}),
  });
  assert.equal(bounded.summary.connected,6);
  assert.equal(bounded.summary.error,6);
});

test('building environment details never mutates frozen caller inputs',() => {
  const plugins = [plugin('database-one',{pluginType:'mysql'}),plugin('server-one')];
  const input = deepFreeze({
    environment:environment(plugins),plugins,
    runtime:runtime({plugins:{
      'database-one':{phase:'waitingDependency',providerPluginInstanceId:'server-one'},
      'server-one':{phase:'connecting'},
    }}),
  });
  const before = JSON.stringify(input);
  const first = buildEnvironmentDetailModel(input);
  const second = buildEnvironmentDetailModel(input);
  assert.deepEqual(first,second);
  assert.equal(JSON.stringify(input),before);
});
