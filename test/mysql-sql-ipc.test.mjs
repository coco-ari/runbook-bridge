import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerMysqlEditIpc } from '../src/mysql-edit-ipc.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { AppError } from '../src/errors.mjs';
import { OperationGate } from '../src/operation-gate.mjs';
import { auditAction, auditCategory, auditErrorSummary } from '../src/audit-record.mjs';

const scope = {projectId:'fixture-project', environmentId:'fixture-environment', pluginInstanceId:'fixture-mysql'};
const request = {...scope, documentId:'fixture-query', operation:'prepare', mode:'atomic', sql:'SELECT * FROM items'};

test('SQL IPC 拒绝非受信桌面主框架，导航和窗口销毁释放独立事务', async () => {
  const handlers = new Map(), closed = [], calls = [];
  let trusted = true, resolve, started;
  const ready = new Promise(done => { started = done; });
  registerMysqlEditIpc({handle:(name, handler) => handlers.set(name, handler)}, {
    isWorkspaceRenderer:() => trusted,
    v2Service:{mysqlSql:{closeOwner:async owner => {closed.push(owner);}}, invokeDesktopMysqlSql:async (owner, payload, assertOwner) => {
      calls.push({owner, payload}); assertOwner(); started();
      await new Promise(done => {resolve = done;}); assertOwner(); return {};
    }},
  });
  const sender = new EventEmitter(); Object.assign(sender, {id:37, mainFrame:{}, isDestroyed:() => false});
  const event = {sender, senderFrame:sender.mainFrame}, invoke = handlers.get('v2:mysql-sql');
  assert.equal((await invoke({...event, senderFrame:{}}, request)).error.code, 'WORKSPACE_ACCESS_DENIED');
  trusted = false;
  assert.equal((await invoke(event, request)).error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(calls.length, 0); trusted = true;
  const pending = invoke(event, request); await ready;
  sender.emit('did-start-navigation', {}, 'file://synthetic-reload', false, true); resolve();
  assert.equal((await pending).error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.deepEqual(closed, ['renderer:37']);
  sender.emit('destroyed');
  assert.deepEqual(closed, ['renderer:37', 'renderer:37']);
});

test('SQL 服务绑定完整插件作用域和实际环境，断连后仍可核实和释放', async () => {
  const plugin = {...scope, pluginType:'mysql', configState:'ready', target:{host:'database.fixture.invalid', port:3306, database:'fixture', addressFamily:'ipv4Only'}, auth:{username:'fixture'}, transport:{kind:'direct'}, tls:{mode:'required'}, limits:{maxRows:100,maxBytes:65536,timeoutMs:3000}, revision:1};
  const environment = {environmentType:'production', revision:2};
  let connected = true, stable = true;
  const calls = [], locks = [];
  const receiver = {
    workspaceStore:{getPlugin:async () => plugin, getEnvironment:async () => environment},
    connectionManager:{assertConfigurationStable() { if (!stable) throw new AppError('CONFIGURATION_CHANGED', '配置变化'); }},
    assertPluginConnected() { if (!connected) throw new AppError('PLUGIN_NOT_CONNECTED', '未连接'); },
    mutationCoordinator:{async runEnvironmentOperation(projectId, environmentId, run) { locks.push([projectId, environmentId]); return run(); }},
    mysqlSql:{prepare(owner, target, actualEnvironment, payload) { calls.push(['prepare', owner, target, actualEnvironment, payload]); return {}; },
      status(owner, target, documentId) { calls.push(['status', owner, target, documentId]); return {}; },
      release(owner, target, documentId) { calls.push(['release', owner, target, documentId]); return {}; }},
  };
  const invoke = payload => V2Service.prototype.invokeDesktopMysqlSql.call(receiver, 'fixture-window', payload);
  connected = false;
  await assert.rejects(invoke(request), {code:'PLUGIN_NOT_CONNECTED'});
  await invoke({...scope, documentId:request.documentId, operation:'status'});
  await invoke({...scope, documentId:request.documentId, operation:'release'});
  connected = true; stable = false;
  await assert.rejects(invoke(request), {code:'CONFIGURATION_CHANGED'});
  stable = true; plugin.environmentId = 'wrong-environment';
  await assert.rejects(invoke(request), {code:'SCOPE_MISMATCH'});
  plugin.environmentId = scope.environmentId;
  await invoke(request);
  assert.deepEqual(calls.map(call => call[0]), ['status','release','prepare']);
  assert.equal(calls[2][3], environment);
  assert.deepEqual(locks, Array.from({length:4}, () => [scope.projectId, scope.environmentId]));
  await assert.rejects(invoke({...request, environmentType:'test'}), {code:'INVALID_ARGUMENT'});
});

test('SQL 桌面扩展不允许 Agent 获取写入、批量执行或事务能力', () => {
  const gate = new OperationGate();
  for (const capability of ['sql','execute','insert','update','delete','commit','rollback']) {
    assert.throws(() => gate.authorize({plugin:{...scope, pluginType:'mysql', agent:{}}, capability, args:{sql:'UPDATE items SET label=1'}, origin:'agent'}));
  }
});

test('SQL 操作记录区分查询、写入和事务，未知结果不能描述为普通可重试失败', () => {
  for (const [action, category] of [['read','read'],['write','change'],['begin','session'],['commit','change'],['rollback','change']]) {
    const key = 'mysql.sql.' + action;
    assert.equal(auditAction({auditAction:key}), key);
    assert.equal(auditCategory(key), category);
  }
  assert.match(auditErrorSummary('MYSQL_SQL_OUTCOME_UNKNOWN'), /勿重复执行/u);
});
