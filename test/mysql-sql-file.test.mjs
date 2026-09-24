import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveMysqlSqlFile } from '../src/mysql-sql-file.mjs';
test('SQL 导出仅写入保存对话框选定文件，取消不写入',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mysql-sql-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'selected.sql'),payload={fileName:'选中行.sql',sql:"SELECT '中文😀';\n"};
  assert.deepEqual(await saveMysqlSqlFile(payload,async name=>{assert.equal(name,payload.fileName);return file;}),{saved:true});
  assert.equal(await fs.readFile(file,'utf8'),payload.sql);
  assert.deepEqual(await saveMysqlSqlFile(payload,async()=>null),{saved:false});
  assert.deepEqual(await fs.readdir(root),['selected.sql']);
});
test('拒绝渲染进程提供路径、超限内容及无效名称，错误不泄露本地路径',async()=>{
  const payload={fileName:'selected.sql',sql:'SELECT 1;'};
  for(const bad of [{...payload,path:'elsewhere'},{...payload,fileName:'../data.sql'},{...payload,sql:'中'.repeat(1400000)},{...payload,sql:''}]){
    await assert.rejects(saveMysqlSqlFile(bad,()=>{throw Error('不应调用');}),{code:'INVALID_ARGUMENT'});
  }
  await assert.rejects(saveMysqlSqlFile(payload,async()=> 'invalid\u0000path'),error=>error.code==='SQL_EXPORT_FAILED'&&!error.message.includes('path'));
});
test('选择文件期间窗口失效时拒绝写入',async()=>{
  let active=true;
  await assert.rejects(saveMysqlSqlFile({fileName:'selected.sql',sql:'SELECT 1;'},async()=>{active=false;return 'must-not-write.sql';},()=>{if(!active)throw Error('窗口失效');}),/窗口失效/u);
});
