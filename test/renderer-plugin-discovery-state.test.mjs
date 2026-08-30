import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPluginEditorState, pluginEditorReducer } from '../renderer/v2/src/features/plugins/plugin-editor-model.ts';
import { emptyPluginDraft, emptyServerUplink, validatePluginDraft } from '../renderer/v2/src/features/plugins/plugin-types.ts';
import { PluginProbeManager } from '../src/plugin-probe-manager.mjs';

function loadingDiscovery() {
  const draft = {
    ...emptyPluginDraft('mysql'),
    target:{host:'mysql.fixture.invalid',port:3306,addressFamily:'ipv4Preferred',database:''},
    auth:{username:'fixture-reader'},
  };
  const editing = pluginEditorReducer(initialPluginEditorState('project/environment/new',draft),{
    type:'reset',ownerKey:'project/environment/new',draft,
  });
  return pluginEditorReducer(editing,{type:'databases-loading'});
}

test('changing a MySQL draft releases discovery controls and discards results tied to its prior generation',() => {
  const state = loadingDiscovery();
  const next = pluginEditorReducer(state,{
    type:'draft',draft:{...state.draft,target:{...state.draft.target,host:'changed.fixture.invalid'}},
  });
  assert.equal(next.databasesLoading,false,'a stale discovery must not keep the Read Databases action disabled');
  assert.deepEqual(next.databases,[]);
  assert.equal(next.draftGeneration,state.draftGeneration+1);
});

test('replacing an already nonempty credential invalidates database discovery without exposing the value',() => {
  const state = loadingDiscovery();
  const next = pluginEditorReducer(state,{type:'credentials',credentials:{primary:'fixture-only',proxy:''}});
  assert.equal(next.databasesLoading,false,'credential changes must release a superseded discovery');
  assert.deepEqual(next.databases,[]);
  assert.equal(next.draftGeneration,state.draftGeneration+1);
});

test('MySQL discovery consumes the runtime result envelope and exposes its truncation state',() => {
  const next = pluginEditorReducer(loadingDiscovery(),{
    type:'databases',result:{databases:['inventory','orders'],truncated:true},
  });
  assert.deepEqual(next.databases,['inventory','orders']);
  assert.equal(next.databasesLoading,false);
  assert.equal(next.databasesTruncated,true);
});

test('new Server proxy drafts submit the same valid default port that the form displays',() => {
  const manager = new PluginProbeManager();
  for (const [type,port] of [['socks5',1080],['http',8080]]) {
    const draft = {
      ...emptyPluginDraft('server'),
      target:{host:'server.fixture.invalid',port:22,addressFamily:'ipv4Preferred'},
      auth:{username:'operator',type:'agent'},
      uplink:{...emptyServerUplink(type),host:'proxy.fixture.invalid'},
    };
    assert.equal(draft.uplink.port,port);
    assert.deepEqual(validatePluginDraft(draft),[]);
    const normalized = manager.normalizeRequest({
      projectId:'project',environmentId:'environment',formInstanceId:'form',requestId:`proxy-${type}`,
      purpose:'server-auth',draftGeneration:1,sequence:1,draft,
    },'renderer:fixture');
    assert.equal(normalized.candidate.uplink.port,port);
  }
});
