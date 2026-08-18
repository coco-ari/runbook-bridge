import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginConnectionViewModel } from '../renderer/v2/connection-view-model.js';

test('structured primary status wins over contradictory legacy fields', () => {
  const plugin = {
    pluginInstanceId:'mysql-1',pluginType:'mysql',configState:'draft',
    assessment:{
      configuration:{state:'complete',issues:[]},
      runtime:{phase:'connected',reason:null,sequence:9,operationId:'operation-1'},
      primaryStatus:{kind:'connected',label:'已连接',action:'disconnect'},
      configState:'ready',phase:'connected',
    },
  };
  const result = pluginConnectionViewModel(plugin,{phase:'error',reason:'OLD_RUNTIME'});
  assert.deepEqual(result,{
    kind:'connected',label:'已连接',action:'disconnect',stateClass:'connected',
    phase:'connected',configurationState:'complete',usesAssessment:true,
  });
});

test('runtime assessment is newer than the list copy and remains authoritative', () => {
  const plugin = {
    pluginInstanceId:'server-1',pluginType:'server',configState:'ready',
    assessment:{
      configuration:{state:'complete',issues:[]},runtime:{phase:'disconnected'},
      primaryStatus:{kind:'disconnected',label:'未连接',action:'connect'},
    },
  };
  const runtime = {
    phase:'error',configuration:{state:'complete',issues:[]},runtime:{phase:'error'},
    primaryStatus:{kind:'connection-error',label:'连接失败：SSH_AUTH_FAILED',action:'retry'},
  };
  assert.deepEqual(pluginConnectionViewModel(plugin,runtime),{
    kind:'connection-error',label:'连接失败：SSH_AUTH_FAILED',action:'retry',stateClass:'error',
    phase:'error',configurationState:'complete',usesAssessment:true,
  });
});

test('legacy configState and phase remain a one-version fallback', () => {
  assert.deepEqual(pluginConnectionViewModel({configState:'draft'},{phase:'connected'}),{
    kind:'needs-configuration',label:'待配置',action:'continue-configuration',stateClass:'draft',
    phase:'connected',configurationState:'incomplete',usesAssessment:false,
  });
  assert.deepEqual(pluginConnectionViewModel({configState:'ready'},{phase:'error'}),{
    kind:'connection-error',label:'连接失败',action:'retry',stateClass:'error',
    phase:'error',configurationState:'complete',usesAssessment:false,
  });
});
