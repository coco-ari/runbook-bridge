import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMysqlRowWriteSafe } from '../src/mysql-row-write-policy.mjs';

test('触发器元数据不可见时拒绝空结果，不猜测为无触发器',async()=>{
  let calls=0;
  await assert.rejects(assertMysqlRowWriteSafe(async()=>{calls++;return [[]];},'fixture','items',new Set(['insert'])),{code:'MYSQL_EDIT_READONLY'});
  assert.equal(calls,1);
});
test('外键元数据权限不足或隐藏的跨库级联均拒绝删除',async()=>{
  for(const denied of [true,false]){
    const query=async sql=>{
      if(sql.includes('effective_grants'))return [[{PRIVILEGE_TYPE:'TRIGGER'}]];
      if(sql.includes('TRIGGERS'))return [[]];
      assert.ok(sql.includes('INNODB_FOREIGN'));
      if(denied)throw new Error('fixture-sensitive-error');
      return [[{TYPE:1}]];
    };
    await assert.rejects(assertMysqlRowWriteSafe(query,'fixture','items',new Set(['delete'])),error=>error.code==='MYSQL_EDIT_READONLY'&&!error.message.includes('fixture-sensitive'));
  }
});
test('新增只检查新增触发器，删除检查级联并使用参数绑定表名',async()=>{
  const calls=[];
  const query=async(sql,params)=>{calls.push({sql,params});return sql.includes('effective_grants')?[[{PRIVILEGE_TYPE:'TRIGGER'}]]:sql.includes('TRIGGERS')?[[{EVENT_MANIPULATION:'UPDATE'}]]:[[]];};
  await assertMysqlRowWriteSafe(query,'fixture','items',new Set(['insert']));assert.equal(calls.length,2);
  await assertMysqlRowWriteSafe(query,'fixture','items',new Set(['delete']));assert.deepEqual(calls.at(-1).params,['fixture/items']);
});
