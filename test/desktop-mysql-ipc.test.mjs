import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { AppError } from '../src/errors.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';
import { OperationGate } from '../src/operation-gate.mjs';
import { PluginManager } from '../src/plugin-manager.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { WorkspaceMutationCoordinator } from '../src/workspace-mutation-coordinator.mjs';

const scope = {projectId:'project-a',environmentId:'testing',pluginInstanceId:'mysql-a'};

function harness({phase = 'connected', plugin: overrides = {}, query: executeQuery, appendAudit} = {}) {
  const plugin = {
    ...scope, pluginType:'mysql', displayName:'测试数据库', configState:'ready', revision:1,
    target:{host:'database.invalid',port:3306,database:'example',addressFamily:'ipv4Only'},
    auth:{username:'readonly'},transport:{kind:'direct'},tls:{mode:'required'},
    limits:{maxRows:500,maxBytes:65_536,timeoutMs:2500}, ...overrides,
  };
  const queries = [];
  const audits = [];
  const authorizations = [];
  const tables = ['alpha','beta','gamma'];
  const runtime = new MysqlPluginRuntime({closeRelay:async () => undefined}, {});
  runtime.sessions.set('project-a/testing/mysql-a', {connection:{
    query:async (request) => {
      queries.push(request);
      if (executeQuery) return executeQuery(request);
      if (request.sql.includes('TABLE_NAME IN')) return [[{TABLE_NAME:request.values[1],TABLE_TYPE:'BASE TABLE'}],[]];
      if (request.sql.includes('information_schema.TABLES')) {
        const [,limit,offset] = request.values;
        return [tables.slice(offset,offset + limit).map((name) => ({TABLE_NAME:name,TABLE_TYPE:'BASE TABLE'})),[]];
      }
      if (request.sql.includes('information_schema.COLUMNS')) {
        return [[{COLUMN_NAME:'id',COLUMN_TYPE:'int',IS_NULLABLE:'NO',COLUMN_KEY:'PRI',COLUMN_DEFAULT:null,EXTRA:''}],[]];
      }
      return [[{id:1}], [{name:'id',table:'alpha',type:3}]];
    },
  }});
  const workspaceStore = {
    getPlugin:async (projectId,environmentId,pluginInstanceId) => {
      if (projectId !== scope.projectId || environmentId !== scope.environmentId || pluginInstanceId !== scope.pluginInstanceId) {
        throw new AppError('PLUGIN_NOT_FOUND','当前范围内未找到插件。');
      }
      return plugin;
    },
    appendAudit:async (_projectId,event) => {audits.push(event); await appendAudit?.(event);},
  };
  const connectionManager = {
    on:() => undefined,
    snapshot:() => ({plugins:{'mysql-a':{phase}}}),
    assertConfigurationStable:() => undefined,
  };
  const gate = new OperationGate();
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  const services = {
    workspaceStore, connectionManager, mutationCoordinator, mysqlRuntime:runtime,
    pluginManager:new PluginManager({mysqlRuntime:runtime}),
    contextManager:new EnvironmentContextManager(workspaceStore),
    confirmationManager:{on:() => undefined},
    operationGate:{authorize:(request) => {authorizations.push(request); return gate.authorize(request);}},
  };
  services.v2Service = new V2Service(services);
  const handlers = new Map();
  registerV2Ipc({handle:(name,handler) => handlers.set(name,handler),on:() => undefined},services);
  const invoke = (operation,payload = {}) => handlers.get(`v2:mysql-${operation}`)({}, {...scope,...payload});
  return {invoke,plugin,queries,audits,authorizations,...services};
}

test('desktop MySQL preload exposes only explicit database operations', async () => {
  let api;
  const calls = [];
  const context = {
    require:() => ({
      contextBridge:{exposeInMainWorld:(_name,value) => {api=value.v2;}},
      ipcRenderer:{invoke:(...args) => {calls.push(args); return Promise.resolve({ok:true});}},
    }),
  };
  vm.runInNewContext(await fs.readFile(new URL('../src/preload.cjs',import.meta.url),'utf8'),context);
  for (const [method,channel] of [
    ['mysqlListTables','mysql-list-tables'],
    ['mysqlDescribeTable','mysql-describe-table'],
    ['mysqlPreviewTable','mysql-preview-table'],
    ['mysqlQueryReadonly','mysql-query-readonly'],
  ]) {
    await api[method](scope);
    assert.deepEqual(calls.at(-1),[`v2:${channel}`,scope]);
  }
  assert.equal(api.invokeDesktopMysql,undefined);
  assert.equal(api.invoke,undefined);
});

test('desktop table pagination and structure stay within the configured database and share user audit', async () => {
  const h = harness();
  const first = await h.invoke('list-tables',{limit:2});
  assert.deepEqual(first,{ok:true,data:{tables:[
    {name:'alpha',type:'BASE TABLE',queryable:true},
    {name:'beta',type:'BASE TABLE',queryable:true},
  ],nextCursor:'2',truncated:true,cache:{hit:false,ageMs:0,ttlMs:60000}}});
  const second = await h.invoke('list-tables',{limit:2,cursor:first.data.nextCursor});
  assert.equal(second.data.tables[0].name,'gamma');
  assert.equal(second.data.nextCursor,null);
  const structure = await h.invoke('describe-table',{table:'alpha'});
  assert.deepEqual(structure.data,{table:'alpha',columns:[{name:'id',type:'int',nullable:false,key:'PRI',default:null,extra:null}],truncated:false,cache:{hit:false,ageMs:0,ttlMs:60000}});
  assert.ok(h.queries.every((query) => query.values[0] === 'example' && query.timeout === 2500));
  assert.equal(h.authorizations.length,3);
  assert.equal(h.audits.length,6);
  assert.match(h.audits.at(-1).auditTarget,/表 alpha/u);
  assert.ok(h.audits.every((audit) => audit.actor === 'user'));
});

test('desktop SELECT retains parameters, configured limits and excludes SQL or returned data from audit', async () => {
  const h = harness();
  const sql = 'SELECT id FROM alpha WHERE id = ?';
  const result = await h.invoke('query-readonly',{sql,params:['parameter-marker']});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.data.rows,[{id:1}]);
  assert.match(h.audits.at(-1).auditTarget,/表 alpha/u);
  assert.equal(h.audits.at(-1).rowCount,1);
  assert.deepEqual(result.data.limitsApplied,{maxRows:500,maxBytes:65_536,timeoutMs:2500});
  assert.match(h.queries.at(-1).sql,/LIMIT 501/u);
  assert.deepEqual(h.queries.at(-1).values,['parameter-marker']);
  assert.equal(typeof result.data.durationMs,'number');
  assert.ok(!JSON.stringify(h.audits).includes(sql));
  assert.ok(!JSON.stringify(h.audits).includes('parameter-marker'));
  assert.ok(!JSON.stringify(h.audits).includes('"id":1'));
});

test('desktop preview caps rows at 100 and respects a lower configured row or byte limit', async () => {
  for (const [maxRows,maxBytes,expectedRows] of [[500,65_536,100],[5,65_536,5],[500,20,2]]) {
    const h = harness({
      plugin:{limits:{maxRows,maxBytes,timeoutMs:700}},
      query:async (request) => request.sql.includes('information_schema')
        ? [[{TABLE_NAME:'alpha',TABLE_TYPE:'BASE TABLE'}],[]]
        : [Array.from({length:101},(_,id) => ({id})),[{name:'id',type:3}]],
    });
    const result = await h.invoke('preview-table',{table:'alpha'});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.data.rowCount,expectedRows);
    assert.equal(result.data.truncated,true);
    assert.match(h.audits.at(-1).auditTarget,/表 alpha/u);
    assert.equal(h.audits.at(-1).rowCount,expectedRows);
    assert.equal(h.audits.at(-1).truncated,true);
    assert.deepEqual(result.data.limitsApplied,{maxRows:Math.min(maxRows,100),maxBytes,timeoutMs:700});
    assert.equal(h.plugin.limits.maxRows,maxRows);
  }
});

test('desktop operations fail closed for disconnected, wrong-type, incomplete and mismatched scopes', async () => {
  const cases = [
    [{phase:'disconnected'}, {}, 'PLUGIN_NOT_CONNECTED'],
    [{phase:'reconnecting'}, {}, 'PLUGIN_RECONNECTING'],
    [{plugin:{pluginType:'redis'}}, {}, 'PLUGIN_TYPE_MISMATCH'],
    [{plugin:{configState:'incomplete'}}, {}, 'PLUGIN_CONFIGURATION_INCOMPLETE'],
    [{plugin:{target:{host:'database.invalid',port:3306,database:''}}}, {}, 'PLUGIN_CONFIGURATION_INCOMPLETE'],
    [{plugin:{environmentId:'elsewhere'}}, {}, 'SCOPE_MISMATCH'],
    [{}, {projectId:'other-project'}, 'PLUGIN_NOT_FOUND'],
    [{}, {environmentId:'other-environment'}, 'PLUGIN_NOT_FOUND'],
    [{}, {pluginInstanceId:'other-plugin'}, 'PLUGIN_NOT_FOUND'],
  ];
  for (const [options,payload,code] of cases) {
    const h = harness(options);
    const result = await h.invoke('list-tables',payload);
    assert.equal(result.error.code,code);
    assert.equal(h.queries.length,0);
    assert.equal(h.audits.at(-1).result,'blocked');
    assert.equal(h.audits.at(-1).actor,'user');
  }
});

test('desktop IPC rejects destination, policy and limit overrides and malformed operation arguments', async () => {
  const h = harness();
  for (const [operation,payload] of [
    ['list-tables',{database:'other'}],
    ['list-tables',{host:'another.invalid'}],
    ['list-tables',{capability:'select'}],
    ['list-tables',{cursor:'-1'}],
    ['list-tables',{limit:201}],
    ['list-tables',{limit:1.5}],
    ['preview-table',{table:'alpha',maxRows:5000}],
    ['describe-table',{table:''}],
    ['describe-table',{table:'alpha\0'}],
    ['query-readonly',{sql:''}],
    ['query-readonly',{sql:'x'.repeat(65_537)}],
    ['query-readonly',{sql:'SELECT 1',policyApproved:true}],
    ['query-readonly',{sql:'SELECT 1',contextToken:'forged'}],
  ]) {
    assert.equal((await h.invoke(operation,payload)).error.code,'INVALID_ARGUMENT');
  }
  assert.equal(h.queries.length,0);
});

test('desktop queries reuse SQL policy against writes, multiple statements, cross-database access and dangerous functions', async () => {
  const h = harness();
  for (const sql of [
    'UPDATE alpha SET id = 1',
    'DELETE FROM alpha',
    'SELECT * FROM other.alpha',
    'SELECT * FROM alpha; SELECT * FROM beta',
    'SELECT * FROM alpha FOR UPDATE',
    'SELECT SLEEP(2)',
    'SELECT @@version',
  ]) {
    const result = await h.invoke('query-readonly',{sql});
    assert.equal(result.error.code,'HARD_POLICY_DENIED',sql);
  }
  assert.equal(h.queries.length,0);
  assert.equal(h.audits.filter((event) => event.result === 'error').length,7);
});

test('desktop table preview rejects a view and escapes table names before SQL parsing', async () => {
  const h = harness({query:async () => [[{TABLE_NAME:'alpha',TABLE_TYPE:'VIEW'}],[]]});
  const view = await h.invoke('preview-table',{table:'alpha'});
  assert.equal(view.error.code,'HARD_POLICY_DENIED');
  assert.equal(h.queries.length,1);
  const injection = await h.invoke('preview-table',{table:'alpha`; DELETE FROM alpha; --'});
  assert.equal(injection.ok,false);
  assert.ok(h.queries.every((request) => request.sql.includes('information_schema')));
});

test('desktop operations respect edit fences and keep an environment reader until query completion', async () => {
  let release;
  const h = harness({query:() => new Promise((resolve) => {release=() => resolve([[],[]]);})});
  h.mutationCoordinator.installEnvironmentEditFence('project-a','testing','edit-1');
  assert.equal((await h.invoke('list-tables')).error.code,'PLUGIN_EDIT_BUSY');
  assert.equal(h.queries.length,0);
  h.mutationCoordinator.releaseEnvironmentFence('edit-1');
  const pending = h.invoke('list-tables');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.mutationCoordinator.environmentActivitySnapshot('project-a','testing').readers,1);
  let mutationRan = false;
  const mutation = h.mutationCoordinator.enqueueEnvironmentMutation('project-a','testing',async () => {mutationRan=true;});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutationRan,false);
  release();
  assert.equal((await pending).ok,true);
  await mutation;
  assert.equal(mutationRan,true);
});

test('desktop operation preserves safe driver errors and fails closed when initial audit cannot be written', async () => {
  const h = harness({query:async () => {throw Object.assign(new Error('untrusted-driver-text'),{code:'ETIMEDOUT'});}});
  const result = await h.invoke('query-readonly',{sql:'SELECT 1'});
  assert.equal(result.ok,false);
  assert.ok(!JSON.stringify(result).includes('untrusted-driver-text'));
  assert.ok(!JSON.stringify(h.audits).includes('untrusted-driver-text'));
  assert.equal(h.mysqlRuntime.status(h.plugin).connected,false);
  const noAudit = harness({appendAudit:async () => {throw new Error('audit unavailable');}});
  assert.equal((await noAudit.invoke('list-tables')).error.code,'INTERNAL_ERROR');
  assert.equal(noAudit.queries.length,0);
});

test('desktop access does not bypass the MCP environment context or change its audit actor', async () => {
  const h = harness();
  await assert.rejects(
    () => h.v2Service.invoke({...scope,actor:'user'},'select',{sql:'SELECT 1'}),
    (error) => error.code === 'CONTEXT_REQUIRED',
  );
  assert.equal(h.queries.length,0);
  assert.equal(h.audits.at(-1).actor,'agent');
});
