import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryBookmarksKey, MAX_DIRECTORY_BOOKMARKS, parseDirectoryBookmarks, updateDirectoryBookmark } from '../renderer/v2/src/features/server-workspace/directory-bookmarks.ts';

const scope={projectId:'p',environmentId:'e',pluginInstanceId:'s'};
function storage() {
  const data=new Map();
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
}
test('目录收藏完整隔离项目、环境和服务器，组合标识没有碰撞', () => {
  const keys=[
    scope, {...scope,projectId:'other'}, {...scope,environmentId:'other'}, {...scope,pluginInstanceId:'other'},
    {projectId:'a/b',environmentId:'c',pluginInstanceId:'d'},
    {projectId:'a',environmentId:'b/c',pluginInstanceId:'d'},
  ].map(directoryBookmarksKey);
  assert.equal(new Set(keys).size,keys.length);
});
test('收藏精确保留中文、空格及链接路径，重复添加去重，移除不影响其他服务器', () => {
  const store=storage();
  const key=directoryBookmarksKey(scope);
  const other=directoryBookmarksKey({...scope,pluginInstanceId:'other'});
  updateDirectoryBookmark(store,other,'/other',true);
  updateDirectoryBookmark(store,key,'/日志/带 空格',true);
  updateDirectoryBookmark(store,key,'/日志/带 空格',true);
  updateDirectoryBookmark(store,key,'/current/../logs',true);
  assert.deepEqual(parseDirectoryBookmarks(store.getItem(key)),['/日志/带 空格','/current/../logs']);
  updateDirectoryBookmark(store,key,'/日志/带 空格',false);
  assert.deepEqual(parseDirectoryBookmarks(store.getItem(key)),['/current/../logs']);
  assert.deepEqual(parseDirectoryBookmarks(store.getItem(other)),['/other']);
});
test('收藏限制数量、路径和存储数据大小，损坏数据不被静默覆盖', () => {
  const store=storage(),key=directoryBookmarksKey(scope);
  for(let i=0;i<MAX_DIRECTORY_BOOKMARKS;i++) updateDirectoryBookmark(store,key,'/dir-'+i,true);
  const previous=store.getItem(key);
  assert.throws(()=>updateDirectoryBookmark(store,key,'/overflow',true),/最多收藏/);
  assert.equal(store.getItem(key),previous);
  updateDirectoryBookmark(store,key,'/dir-0',true);
  updateDirectoryBookmark(store,key,'/dir-0',false);
  updateDirectoryBookmark(store,key,'/replacement',true);
  for(const value of ['relative','/a\nb','/a\0b','/'+'x'.repeat(4096)]) assert.throws(()=>updateDirectoryBookmark(store,key,value,true));
  for(const raw of ['{','{}','[1]','["relative"]','["/a\\n"]',' '.repeat(512*1024+1)]) assert.throws(()=>parseDirectoryBookmarks(raw));
  store.setItem(key,'invalid-data');
  assert.throws(()=>updateDirectoryBookmark(store,key,'/new',true));
  assert.equal(store.getItem(key),'invalid-data');
});
test('收藏保存失败向调用方报告，不伪装为已保存', () => {
  assert.throws(()=>updateDirectoryBookmark({getItem:()=>null,setItem:()=>{throw Error('存储不可写');}},'key','/srv',true),/存储不可写/);
  assert.deepEqual(parseDirectoryBookmarks(null),[]);
});
