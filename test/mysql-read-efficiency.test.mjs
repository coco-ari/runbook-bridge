import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';

const plugin = { projectId:'fixture', environmentId:'test', pluginInstanceId:'mysql', revision:1, target:{database:'fixture'}, limits:{timeoutMs:1000,maxBytes:65536,maxRows:100} };
const sessionKey = 'fixture/test/mysql';

test('元数据选项在访问数据库前验证，索引超出剩余预算仍保留字段', async () => {
  let reads = 0;
  const runtime = fixture(async request => {
    reads += 1;
    if (request.sql.includes('TABLE_TYPE')) return [[{TABLE_NAME:'orders',TABLE_TYPE:'BASE TABLE'}]];
    if (request.sql.includes('STATISTICS')) return [[{INDEX_NAME:'x'.repeat(300)}]];
    return [[{COLUMN_NAME:'id',COLUMN_TYPE:'int',IS_NULLABLE:'NO'}]];
  });
  await assert.rejects(runtime.searchSchema(plugin,{keywords:['order'],refresh:'true'}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(runtime.describeTable(plugin,'orders',{includeIndexes:'true'}),{code:'INVALID_ARGUMENT'});
  assert.equal(reads,0);
  const result = await runtime.describeTable({...plugin,limits:{...plugin.limits,maxBytes:150}},'orders',{includeIndexes:true});
  assert.equal(result.columns[0].name,'id');
  assert.deepEqual(result.indexes,[]);
  assert.equal(result.truncated,true);
});
function fixture(query, options) {
  const runtime = new MysqlPluginRuntime({ closeRelay:async () => {} }, {}, options);
  runtime.sessions.set(sessionKey, { connection:{ query, destroy() {} }, closing:false });
  return runtime;
}

test('相同 Schema 搜索只读一次元数据，刷新和重连后重新读取', async () => {
  let reads = 0;
  const query = async () => { reads += 1; await delay(10); return [[{match_kind:'table',table_name:'orders',table_comment:''}]]; };
  const runtime = fixture(query);
  const args = {keywords:['order']};
  const results = await Promise.all([runtime.searchSchema(plugin,args),runtime.searchSchema(plugin,args)]);
  assert.equal(reads,1);
  assert.equal(results[1].cache.hit,true);
  await runtime.searchSchema(plugin,{...args,refresh:true});
  assert.equal(reads,2);
  runtime.sessions.set(sessionKey,{ connection:{query}, closing:false });
  await runtime.searchSchema(plugin,args);
  assert.equal(reads,3);
  runtime.sessions.clear();
  await assert.rejects(runtime.searchSchema(plugin,args), error => error.code === 'PLUGIN_NOT_CONNECTED');
});

test('自动 Schema 搜索先查表，字段兜底使用固定库和准确表名', async () => {
  const queries = [];
  const runtime = fixture(async request => { queries.push(request); return [[]]; });
  const result = await runtime.searchSchema(plugin,{keywords:['missing'],table:'orders'});
  assert.equal(queries.length,2);
  assert.doesNotMatch(queries[0].sql,/information_schema\.COLUMNS/);
  assert.match(queries[1].sql,/information_schema\.COLUMNS/);
  assert.match(queries[1].sql,/t\.TABLE_NAME = \?/);
  assert.deepEqual(queries[1].values.slice(0,2),['fixture','orders']);
  assert.equal(result.searchedIn,'all');
});

test('缓存只用于展示元数据，业务查询仍重新验证基础表且不复用结果', async () => {
  let queries = 0;
  let allowed = true;
  const runtime = fixture(async request => {
    queries += 1;
    if (request.sql.includes('TABLE_TYPE FROM')) return [[{TABLE_NAME:'orders',TABLE_TYPE:allowed ? 'BASE TABLE' : 'VIEW'}]];
    return [[{id:1}],[]];
  });
  await runtime.queryReadonly(plugin,'SELECT id FROM orders');
  await runtime.queryReadonly(plugin,'SELECT id FROM orders');
  assert.equal(queries,4);
  allowed = false;
  await assert.rejects(runtime.queryReadonly(plugin,'SELECT id FROM orders'), error => error.code === 'HARD_POLICY_DENIED');
  assert.equal(queries,5);
});

test('元数据超时返回阶段和下一步，错误不包含驱动文本', async () => {
  const runtime = fixture(async () => { throw Object.assign(new Error('private-driver-text'), {code:'ETIMEDOUT'}); });
  await assert.rejects(runtime.searchSchema(plugin,{keywords:['order']}), error => error.code === 'DATABASE_QUERY_TIMEOUT' && error.details.phase === 'metadata' && error.details.operation === 'search_tables' && !JSON.stringify(error).includes('private-driver-text'));
  assert.equal(runtime.sessions.size,0);
});

test('同一连接的查询并发受限，排队超时不触发额外数据库请求', async () => {
  let queries = 0;
  const runtime = fixture(async () => { queries += 1; await delay(40); return [[]]; },{queueTimeoutMs:10});
  const first = runtime.querySession(plugin,{sql:'SELECT 1'});
  await assert.rejects(runtime.querySession(plugin,{sql:'SELECT 2'}), error => error.code === 'READ_BUSY');
  await first;
  assert.equal(queries,1);
  assert.equal(runtime.sessions.size,1);
});

test('同时查询同一张表仅合并在途检查，后续查询仍重新验证', async () => {
  let checks = 0;
  let queries = 0;
  const runtime = fixture(async request => {
    if (request.sql.includes('TABLE_TYPE FROM')) {
      checks += 1;
      await delay(10);
      return [[{TABLE_NAME:'orders',TABLE_TYPE:'BASE TABLE'}]];
    }
    queries += 1;
    return [[{id:1}],[]];
  });
  await Promise.all([runtime.queryReadonly(plugin,'SELECT id FROM orders'),runtime.queryReadonly(plugin,'SELECT id FROM orders')]);
  assert.equal(checks,1);
  assert.equal(queries,2);
  await runtime.queryReadonly(plugin,'SELECT id FROM orders');
  assert.equal(checks,2);
  assert.equal(queries,3);
});

test('在途检查拒绝视图且失败后不缓存，重连后的查询不能复用旧检查', async () => {
  let allow = false;
  let checks = 0;
  let queries = 0;
  const runtime = fixture(async request => {
    if (request.sql.includes('TABLE_TYPE FROM')) {
      checks += 1;
      await delay(10);
      return [[{TABLE_NAME:'orders',TABLE_TYPE:allow ? 'BASE TABLE' : 'VIEW'}]];
    }
    queries += 1;
    return [[{id:1}],[]];
  });
  const rejected = await Promise.allSettled([runtime.queryReadonly(plugin,'SELECT id FROM orders'),runtime.queryReadonly(plugin,'SELECT id FROM orders')]);
  assert.ok(rejected.every(result => result.status === 'rejected' && result.reason.code === 'HARD_POLICY_DENIED'));
  assert.equal(checks,1);
  assert.equal(queries,0);
  allow = true;
  await runtime.queryReadonly(plugin,'SELECT id FROM orders');
  assert.equal(checks,2);
  let release;
  const previous = runtime.sessions.get(sessionKey);
  previous.connection.query = async () => { await new Promise(resolve => { release = resolve; }); return [[{TABLE_NAME:'orders',TABLE_TYPE:'BASE TABLE'}]]; };
  const stale = runtime.queryReadonly(plugin,'SELECT id FROM orders');
  while (!release) await delay(1);
  runtime.sessions.set(sessionKey,{connection:{query:async () => { queries += 1; return [[]]; }},closing:false});
  release();
  await assert.rejects(stale,{code:'PLUGIN_RECONNECTING'});
  assert.equal(queries,1);
});

test('查询前表检查超时明确指出业务 SQL 尚未执行', async () => {
  let calls = 0;
  const runtime = fixture(async () => { calls += 1; throw Object.assign(new Error('private-driver-text'),{code:'ETIMEDOUT'}); });
  await assert.rejects(runtime.queryReadonly(plugin,'SELECT id FROM orders'), error =>
    error.code === 'DATABASE_QUERY_TIMEOUT' && error.details.phase === 'metadata'
    && error.details.operation === 'table_check' && /查询尚未执行/.test(error.details.guidance)
    && !JSON.stringify(error).includes('private-driver-text'));
  assert.equal(calls,1);
});

test('表检查完成后连接再次切换时也不会执行 SQL', async () => {
  let queries = 0;
  const runtime = fixture(async () => [[{TABLE_NAME:'orders',TABLE_TYPE:'BASE TABLE'}]]);
  const check = runtime.assertBaseTables.bind(runtime);
  runtime.assertBaseTables = async (...args) => {
    const session = await check(...args);
    runtime.sessions.set(sessionKey,{connection:{query:async () => { queries += 1; return [[]]; }},closing:false});
    return session;
  };
  await assert.rejects(runtime.queryReadonly(plugin,'SELECT id FROM orders'),{code:'PLUGIN_RECONNECTING'});
  assert.equal(queries,0);
});

test('实际 SQL 超时保留执行计划建议，不误报成表检查超时', async () => {
  const runtime = fixture(async request => {
    if (request.sql.includes('TABLE_TYPE FROM')) return [[{TABLE_NAME:'orders',TABLE_TYPE:'BASE TABLE'}]];
    throw Object.assign(new Error('private-driver-text'),{code:'ETIMEDOUT'});
  });
  await assert.rejects(runtime.queryReadonly(plugin,'SELECT id FROM orders'), error =>
    error.code === 'DATABASE_QUERY_TIMEOUT' && error.details.operation === 'query'
    && /mysql_explain/.test(error.details.guidance) && !/查询尚未执行/.test(error.details.guidance));
});
