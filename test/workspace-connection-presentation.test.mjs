import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceConnectionPresentation, workspaceConnectionNotice } from '../renderer/v2/src/components/workspace/workspace-connection-presentation.ts';

const state = (phase, overrides = {}) => ({phase,operation:null,challenge:null,error:null,...overrides});
test('连接展示区分在途意图、身份确认、失败和未知，不把它们误写为断线', () => {
  for (const [input,label] of [
    [state('disconnected',{operation:{intent:'cancel'}}),'正在取消连接'],
    [state('connected',{operation:{intent:'disconnect'}}),'正在断开'],
    [state('disconnected',{challenge:{},operation:{intent:'connect'}}),'等待身份确认'],
    [state('disconnected',{operation:{intent:'connect'}}),'正在连接'],
    [state('error'),'连接失败'],[state('unknown'),'连接状态待确认'],[state('blocked'),'连接需要处理'],
  ]) {
    const view = workspaceConnectionPresentation(input);
    assert.equal(view.label,label);
    assert.notEqual(view.status,'disconnected');
    assert.ok(!workspaceConnectionNotice(view,'草稿已保留。').startsWith('连接已断开'));
  }
  assert.deepEqual(workspaceConnectionPresentation(state('connected')),{status:'connected',label:'已连接'});
  assert.equal(workspaceConnectionNotice(workspaceConnectionPresentation(state('disconnected')),'标签已保留。'),'连接已断开，标签已保留。');
});
test('服务器自动恢复阶段与手动意图共用显示但不改变输入状态', () => {
  const input = state('disconnected');
  assert.equal(workspaceConnectionPresentation(input,'waiting').label,'等待重连');
  assert.equal(workspaceConnectionPresentation(input,'connecting').label,'正在连接');
  assert.equal(workspaceConnectionPresentation(input,'exhausted').label,'连接失败');
  assert.equal(workspaceConnectionPresentation(input,'action-required').label,'连接需要处理');
  assert.deepEqual(input,state('disconnected'));
});
