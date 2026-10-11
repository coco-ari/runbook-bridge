import assert from 'node:assert/strict';
import test from 'node:test';
import {pluginSaveFeedback,readPluginRecovery,recoveryTargetIds} from '../renderer/v2/src/features/plugins/plugin-save-feedback.ts';

const plugin = {projectId:'project',environmentId:'env',pluginInstanceId:'server',pluginType:'server',displayName:'模拟服务器',revision:1};
const runtime = (phases,sequence=10,scope=plugin) => ({projectId:scope.projectId,environmentId:scope.environmentId,phase:'partial',sequence,plugins:Object.fromEntries(Object.entries(phases).map(([id,phase])=>[id,{phase}]))});
const saved = (phases,extra={}) => ({
  plugin,runtimeWarning:false,persistenceRecoveryPending:false,manualReconnectRequired:false,saveStrategy:'restore-previous',
  recovery:readPluginRecovery({connectionPlan:{outcome:'started',snapshot:runtime(phases)}},plugin,['server','db']),...extra,
});

test('save feedback requires every original connection to be confirmed and does not equate started with success',()=>{
  for (const [phases,state] of [
    [{server:'connecting',db:'disconnected'},'recovering'],
    [{server:'connected',db:'connecting'},'recovering'],
    [{server:'connected',db:'error'},'partial'],
    [{server:'blocked',db:'disconnected'},'not-restored'],
    [{server:'disconnected',db:'disconnected'},'not-restored'],
    [{server:'connected'},'unknown'],
    [{server:'connected',db:'future-phase'},'unknown'],
    [{server:'connected',db:'connected'},'restored'],
  ]) {
    const feedback=pluginSaveFeedback(saved(phases));
    assert.equal(feedback.state,state);
    assert.equal(feedback.title,'插件配置已保存');
  }
});

test('only a newer snapshot in the exact environment updates recovery evidence',()=>{
  const outcome=saved({server:'connecting',db:'connecting'});
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'connected'},9)).state,'recovering');
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'connected'},10)).state,'recovering');
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'connected'},11,{...plugin,environmentId:'other'})).state,'recovering');
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'connected'},11)).state,'restored');
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'error'},12)).state,'partial');
  assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected',db:'connected'},11),true).state,'unknown');
});

test('unknown recovery stays unknown even if a cached runtime is connected',()=>{
  for (const value of [{},{connectionPlan:null},{connectionPlan:{outcome:'started'}},{connectionPlan:{outcome:'future-result',snapshot:runtime({server:'connected'})}},{connectionPlan:{outcome:'started',snapshot:runtime({server:'connected'},10,{...plugin,projectId:'other'})}}]) {
    const outcome=saved({}, {recovery:readPluginRecovery(value,plugin,['server'])});
    assert.equal(pluginSaveFeedback(outcome,runtime({server:'connected'},100)).state,'unknown');
  }
  assert.equal(pluginSaveFeedback(saved({},{recovery:readPluginRecovery({},plugin,null)})).state,'unknown');
  assert.equal(pluginSaveFeedback(saved({},{recovery:readPluginRecovery({},plugin,[])})).state,'not-needed');
});

test('warnings remain actionable without copying backend text into notices',()=>{
  const outcome=saved({server:'connected',db:'connected'});
  for (const warning of ['runtimeWarning','manualReconnectRequired','persistenceRecoveryPending']) {
    assert.equal(pluginSaveFeedback({...outcome,[warning]:true}).tone,'warning');
    assert.equal(pluginSaveFeedback({...outcome,[warning]:true}).state,'unknown');
  }
  const recovery=readPluginRecovery({connectionPlan:{outcome:'needs-action',actions:[{message:'not-for-ui'}],snapshot:{...runtime({server:'connected',db:'error'}),message:'not-for-ui'}}},plugin,['server','db']);
  assert.equal(JSON.stringify(recovery).includes('not-for-ui'),false);
  assert.equal(pluginSaveFeedback({...outcome,recovery}).state,'partial');
  assert.deepEqual(recoveryTargetIds(['server','server','db']),['server','db']);
  assert.equal(recoveryTargetIds(['server',null]),null);
});
