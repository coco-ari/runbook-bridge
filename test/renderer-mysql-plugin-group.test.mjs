import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initialPluginEditorState, pluginEditorReducer } from '../renderer/v2/src/features/plugins/plugin-editor-model.ts';
import { emptyPluginDraft } from '../renderer/v2/src/features/plugins/plugin-types.ts';
import { mysqlPluginGroup as rendererGroup } from '../renderer/v2/src/features/plugins/mysql-plugin-group.ts';
import { mysqlPluginGroup, mysqlGroupTags } from '../src/mysql-plugin-group.mjs';

test('前后端分组标识一致，错误或重复标签不合并插件',() => {
  const tags = mysqlGroupTags(['普通标签'],crypto.randomUUID(),'业务组');
  for (const candidate of [tags,[],[...tags,tags[0]],['rbb:mysql-group:invalid'],[tags[0],tags[0]]]) {
    const plugin = {pluginType:'mysql',tags:candidate};
    assert.deepEqual(rendererGroup(plugin),mysqlPluginGroup(plugin));
  }
});

test('数据库多选保留列表，改名保留选择，修改连接或密码清除旧选择和隐式单库',() => {
  const draft = {...emptyPluginDraft('mysql'),target:{host:'db.invalid',port:3306,addressFamily:'ipv4Preferred',database:''}};
  let state = initialPluginEditorState('test',draft);
  state = pluginEditorReducer(state,{type:'databases',result:{databases:['orders','billing'],truncated:false}});
  state = pluginEditorReducer(state,{type:'select-databases',databases:['orders','billing']});
  assert.deepEqual(state.databases,['orders','billing']);
  assert.equal(state.draft.target.database,'orders');
  state = pluginEditorReducer(state,{type:'draft',draft:{...state.draft,displayName:'业务组'}});
  assert.deepEqual(state.selectedDatabases,['orders','billing']);
  const refreshed = pluginEditorReducer(state,{type:'databases',result:{databases:['billing'],truncated:false}});
  assert.deepEqual(refreshed.selectedDatabases,['billing']);
  assert.equal(refreshed.draft.target.database,'billing');
  for (const action of [
    {type:'draft',draft:{...state.draft,target:{...state.draft.target,host:'other.invalid'}}},
    {type:'credentials',credentials:{primary:'synthetic-password',proxy:''}},
  ]) {
    const changed = pluginEditorReducer(state,action);
    assert.deepEqual(changed.selectedDatabases,[]);
    assert.equal(changed.draft.target.database,'');
    assert.deepEqual(changed.databases,[]);
  }
});
