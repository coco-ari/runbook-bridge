import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPluginEditorState, pluginEditorReducer } from '../renderer/v2/src/features/plugins/plugin-editor-model.ts';
import { emptyPluginDraft } from '../renderer/v2/src/features/plugins/plugin-types.ts';

test('会话失效清除临时凭据和验证结果，提示取消退出而不提供恢复', () => {
  const draft = {...emptyPluginDraft('server'),displayName:'未保存的名称'};
  const state = {
    ...initialPluginEditorState('p/e/server',draft),
    editSessionId:'expired',credentials:{primary:'fixture-only',proxy:'fixture-proxy'},
    validation:{requestId:'old',state:'valid',draftGeneration:3,sequence:1,purpose:'server-auth'},
    draftGeneration:3,
  };
  const ended = pluginEditorReducer(state,{type:'failure',error:{
    code:'PLUGIN_EDIT_SESSION_STALE',message:'过期',details:{sessionEnded:true},
  }});
  assert.equal(ended.draft,draft);
  assert.equal(ended.sessionEnded,true);
  assert.equal(ended.editSessionId,null);
  assert.equal(ended.validation,null);
  assert.deepEqual(ended.credentials,{primary:'',proxy:''});
  assert.match(ended.error.message,/本次修改未保存/u);
  assert.match(ended.error.message,/取消/u);
  assert.doesNotMatch(ended.error.message,/恢复|草稿已保留/u);
  const closed = pluginEditorReducer(ended,{type:'closed'});
  assert.equal(closed.phase,'closed');
  assert.deepEqual(closed.credentials,{primary:'',proxy:''});
});

test('普通会话拒绝和未确认的失效错误不能触发安全退出', () => {
  const state = {...initialPluginEditorState('p/e/server',emptyPluginDraft('server')),editSessionId:'active'};
  for (const error of [
    {code:'PLUGIN_EDIT_SESSION_STALE',message:'不属于当前窗口'},
    {code:'INTERNAL_ERROR',message:'失败',details:{sessionEnded:true}},
  ]) {
    const next = pluginEditorReducer(state,{type:'failure',error});
    assert.equal(next.sessionEnded,false);
    assert.equal(next.editSessionId,'active');
  }
});
