import assert from 'node:assert/strict';
import test from 'node:test';
import { planUploadFile, uploadDecisions } from '../src/server-upload-conflicts.mjs';

test('冲突选择支持原型同名文件，不接受伪造路径和继承的默认策略', () => {
  const names = ['__proto__', 'constructor', 'toString'];
  const choices = uploadDecisions(names.map(name => ({name,action:'skip'})), names);
  for (const name of names) { assert.equal(Object.hasOwn(choices,name),true); assert.equal(choices[name],'skip'); }
  assert.deepEqual(uploadDecisions(undefined,['constructor']),{});
  assert.deepEqual(uploadDecisions(undefined,names,choices), choices);
  assert.throws(() => uploadDecisions([{name:'__proto__',action:'skip',path:'/other'}],names),{code:'INVALID_ARGUMENT'});
});

test('副本命名保留复合扩展名、处理无扩展名并避开批次内名称', async () => {
  for (const [name, expected] of [['backup.tar.gz','backup (2).tar.gz'],['.env','.env (2)'],['README','README (2)']]) {
    const reserved = new Set([name,expected.replace('(2)','(1)')]);
    const file = { name };
    const result = await planUploadFile(file,{action:'keep-both',directory:'/srv',reserved,
      snapshot:async target => ({exists:target==='/srv/'+name,type:'file',size:7,mtime:1})});
    assert.equal(result.remotePath,'/srv/'+expected);
    assert.equal(result.target.exists,false);
    assert.equal(file.remote.size,7);
    assert.equal(reserved.has(expected),true);
  }
});

test('同名文件夹只能跳过或保留两份，不能作为覆盖目标', async () => {
  const snapshot = async target => ({exists:target==='/srv/app',type:'directory',size:0,mtime:1});
  for(const action of ['pending','overwrite']) await assert.rejects(planUploadFile({name:'app'},{action,directory:'/srv',reserved:new Set(),snapshot}),{code:'PATH_INVALID'});
  const skip=await planUploadFile({name:'app'},{action:'skip',directory:'/srv',reserved:new Set(),snapshot});
  const copy=await planUploadFile({name:'app'},{action:'keep-both',directory:'/srv',reserved:new Set(),snapshot});
  assert.equal(skip.action,'skip'); assert.equal(copy.remotePath,'/srv/app (1)');
});
