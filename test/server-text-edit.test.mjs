import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadFixture } from './fixtures/upload-ssh-server.mjs';
import { changedRange, textFormat } from '../renderer/v2/src/features/server-workspace/file-editor-model.ts';

async function setup(t,options={}) {
  const f=await createUploadFixture(t,{posixRename:true,...options});
  for(const dir of ['/','/srv']) {f.files.set(dir,Buffer.alloc(0));f.modes.set(dir,0o40755);}
  f.files.set('/srv/example.conf',Buffer.from('\uFEFF# 示例\r\nport = 8080\r\n'));f.modes.set('/srv/example.conf',0o100640);
  await f.broker.connect('fixture',{password:'fixture-password'});
  return {...f,read:()=>f.broker.readWorkspaceText('fixture','/srv/example.conf'),
    save:(expected,content,extra={})=>f.broker.writeWorkspaceText('fixture',{path:'/srv/example.conf',expected,content},extra)};
}

test('真实 SSH 文本保存完整读取、保留 UTF-8 BOM/CRLF 和权限、原子替换', {timeout:60000},async t=>{
  const f=await setup(t), before=await f.read(), content=before.content.replace('8080','9090');
  assert.equal(before.content,'\uFEFF# 示例\r\nport = 8080\r\n');
  await f.save(before,content);
  assert.equal(f.files.get('/srv/example.conf').toString(),content);
  assert.equal(f.modes.get('/srv/example.conf'),0o100640);assert.equal(f.counters.posixRenames,1);assert.equal(f.counters.renames,0);
  assert.equal([...f.files.keys()].some(x=>x.includes('.runbook-edit-')),false);
  await assert.rejects(f.save(before,'later'),{code:'FILE_EDIT_CONFLICT'});
  assert.equal(f.counters.posixRenames,1);
  const current=await f.read();await f.save(current,'');assert.equal(f.files.get('/srv/example.conf').length,0);
});
test('真实 SSH 保存确认后的哈希变化、写入期间远端变化均保留目标', {timeout:60000},async t=>{
  const f=await setup(t),before=await f.read();
  f.files.set('/srv/example.conf',Buffer.from(before.content.replace('8080','7070')));
  await assert.rejects(f.save(before,'new'),{code:'FILE_EDIT_CONFLICT'});assert.equal(f.counters.uploaded,0);
  const current=await f.read();
  f.faults.onWrite=()=>f.files.set('/srv/example.conf',Buffer.from('external modification'));
  await assert.rejects(f.save(current,'new'),{code:'FILE_EDIT_CONFLICT'});
  assert.equal(f.files.get('/srv/example.conf').toString(),'external modification');assert.equal(f.counters.posixRenames,0);
  assert.equal([...f.files.keys()].some(x=>x.includes('.runbook-edit-')),false);
});
test('真实 SSH 不支持原子替换时不截断或删除原文件', {timeout:60000},async t=>{
  const f=await setup(t,{posixRename:false}),before=await f.read();
  await assert.rejects(f.save(before,'new'),{code:'FILE_EDIT_ATOMIC_UNAVAILABLE'});
  assert.equal(f.files.get('/srv/example.conf').toString(),before.content);assert.equal(f.counters.renames,0);
  assert.equal([...f.files.keys()].some(x=>x.includes('.runbook-edit-')),false);
});
test('真实 SSH 拒绝无效编码、超限、二进制、链接和特殊文件', {timeout:60000},async t=>{
  const f=await setup(t);
  for(const [data,code] of [[Buffer.from([0xc3,0x28]),'FILE_EDIT_ENCODING'],[Buffer.from([0]),'FILE_EDIT_ENCODING'],[Buffer.alloc(1048577,65),'FILE_TOO_LARGE']]) {
    f.files.set('/srv/example.conf',data);await assert.rejects(f.read(),{code});
  }
  f.files.set('/srv/example.conf',Buffer.from('ok'));
  for(const mode of [0o120777,0o20600,0o10644,0o140644]) {f.modes.set('/srv/example.conf',mode);await assert.rejects(f.read(),{code:'SOURCE_NOT_ALLOWED'});}
  f.modes.set('/srv/example.conf',0o100644);f.faults.realPaths.set('/srv','/elsewhere');
  await assert.rejects(f.read(),{code:'WORKSPACE_PATH_CHANGED'});assert.equal(f.counters.uploaded,0);
});
test('文本换行保护和有界变更区间覆盖全部修改',()=>{
  assert.deepEqual(textFormat('\uFEFFa\r\nb\r\n'),{body:'a\r\nb\r\n',bom:'\uFEFF',separator:'\r\n',label:'CRLF'});
  assert.throws(()=>textFormat('a\nline\r\n'),/混用/u);
  assert.deepEqual(changedRange('a\nb\nc\nd','a\nB\nc\nD'),{start:2,oldEnd:4,newEnd:4});
  assert.deepEqual(changedRange('a\nb','a\nnew\nb'),{start:2,oldEnd:1,newEnd:2});
  assert.deepEqual(changedRange('a\nb','a\nb'),{start:3,oldEnd:2,newEnd:2});
  const long='same\n'.repeat(100000);assert.equal(changedRange(long+'old',long+'new').start,100001);
});
