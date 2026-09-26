import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MysqlPluginRuntime, mysqlRuntimeInternals } from '../src/mysql-plugin-runtime.mjs';
import { guardMysqlConnection } from '../src/mysql-connection.mjs';
import { AppError } from '../src/errors.mjs';

const configuration = {
  projectId:'fixture-project', environmentId:'fixture-test', pluginInstanceId:'fixture-mysql', pluginType:'mysql',
  configState:'ready', revision:'fixture-revision',
  target:{host:'db.example.test',port:3306,database:'fixture'},
  auth:{username:'fixture-user'}, transport:{kind:'direct'}, tls:{mode:'verifyIdentity'},
  limits:{timeoutMs:5000,maxRows:100,maxBytes:65536},
};

class Socket extends EventEmitter {
  destroyed = false;
  destroys = 0;
  destroy() {
    if (this.destroyed) return;
    this.destroys += 1;
    this.destroyed = true;
    this.emit('close');
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
}

function makeConnection(stream = new Socket(), query) {
  const raw = new EventEmitter();
  raw.stream = stream;
  const connection = {
    connection:raw, requests:[], ends:0,
    query:async (request) => {
      connection.requests.push(request);
      return query ? query(request) : [[{ai_ops_database:'fixture'}],[]];
    },
    end:async () => { connection.ends += 1; },
  };
  return connection;
}

function fixture({load, openTarget, createConnection, query} = {}) {
  const plugin = structuredClone(configuration);
  const loads = [];
  const opened = [];
  const options = [];
  const connections = [];
  const closedRoutes = [];
  const mainRoutes = [];
  const lifecycle = [];
  const runtime = new MysqlPluginRuntime({
    openTarget:async (value) => {
      opened.push(value);
      return openTarget ? openTarget(value) : new Socket();
    },
    createStreamRoute:async (value) => {
      mainRoutes.push(value);
      return {stream:new Socket(),generation:mainRoutes.length + 10};
    },
    closeRelay:async (...args) => { closedRoutes.push(args); },
  }, {
    load:async (value) => {
      loads.push(value);
      return load ? load(value) : {password:'synthetic-password',caPem:'synthetic-ca'};
    },
  }, {client:{createConnection:async (value) => {
    options.push(value);
    const connection = createConnection ? await createConnection(value) : makeConnection(value.stream,query);
    connections.push(connection);
    return connection;
  }}});
  const parent = {connection:makeConnection(),bindingHash:plugin.revision,closing:false,routeGeneration:9,attemptToken:Symbol('fixture-parent')};
  runtime.sessions.set(mysqlRuntimeInternals.key(plugin),parent);
  guardMysqlConnection(parent.connection);
  runtime.on('lifecycle', (value) => lifecycle.push(value));
  return {runtime,plugin,parent,loads,opened,options,connections,closedRoutes,mainRoutes,lifecycle};
}

test('SQL 标签拥有独立物理流，保留固定库、严格 TLS 和单语句选项', async () => {
  const f = fixture();
  f.plugin.transport = {kind:'serverTunnel',serverPluginInstanceId:'fixture-server'};
  const first = await f.runtime.openSqlConnection(f.plugin,f.parent);
  const second = await f.runtime.openSqlConnection(f.plugin,f.parent);
  assert.notEqual(first.connection,second.connection);
  assert.notEqual(first.connection,f.parent.connection);
  assert.equal(f.mainRoutes.length,0);
  assert.equal(f.closedRoutes.length,0);
  assert.deepEqual(f.opened,[f.plugin,f.plugin]);
  for (const options of f.options) {
    assert.equal(options.database,'fixture');
    assert.equal(options.host,'db.example.test');
    assert.equal(options.multipleStatements,false);
    assert.equal(options.namedPlaceholders,false);
    assert.equal(options.ssl.rejectUnauthorized,true);
    assert.equal(options.ssl.servername,'db.example.test');
    assert.equal(options.ssl.ca,'synthetic-ca');
  }
  assert.equal(f.runtime.sqlConnections.size,2);
  let notified = 0;
  first.onLost = () => { notified += 1; };
  await first.connection.query({sql:'START TRANSACTION'});
  assert.equal(f.parent.connection.requests.length,0);
  assert.equal(second.connection.requests.length,1);
  first.close();
  first.close();
  assert.equal(first.connection.connection.stream.destroys,1);
  assert.equal(second.connection.connection.stream.destroyed,false);
  assert.equal(f.parent.connection.connection.stream.destroyed,false);
  assert.equal(f.runtime.require(f.plugin),f.parent);
  assert.equal(f.runtime.sqlConnections.size,1);
  assert.equal(notified,0);
  assert.throws(() => first.assertActive(),{code:'MYSQL_SQL_SESSION_CLOSED'});
  second.assertActive();
  second.close();
});

test('SQL 子连接断线只通知一次，不失效主连接、兄弟标签或主路由', async () => {
  const f = fixture();
  const first = await f.runtime.openSqlConnection(f.plugin,f.parent);
  const second = await f.runtime.openSqlConnection(f.plugin,f.parent);
  const errors = [];
  first.onLost = (error) => errors.push(error);
  first.connection.connection.emit('error',Object.assign(new Error('private-driver-details'),{code:'ECONNRESET'}));
  assert.equal(errors.length,1);
  assert.equal(errors[0].code,'ROUTE_UNAVAILABLE');
  assert.doesNotMatch(errors[0].message,/private-driver/);
  assert.equal(f.runtime.status(f.plugin).connected,true);
  assert.equal(f.lifecycle.length,0);
  assert.equal(f.closedRoutes.length,0);
  assert.equal(f.runtime.sqlConnections.size,1);
  second.assertActive();
  assert.doesNotThrow(() => first.connection.connection.emit('error',new Error('late-error')));
  assert.equal(errors.length,1);
  second.close();
});

for (const action of ['disconnect','forceDisconnect','invalidateSession','closeAll']) {
  test(`${action} 同时关闭 SQL 子连接，回调抛错也不影响其他标签清理`, async () => {
    const f = fixture();
    const first = await f.runtime.openSqlConnection(f.plugin,f.parent);
    const second = await f.runtime.openSqlConnection(f.plugin,f.parent);
    const errors = [];
    first.onLost = () => { throw new Error('callback-failure'); };
    second.onLost = (error) => errors.push(error);
    if (action === 'invalidateSession') await f.runtime.invalidateSession(f.plugin,f.parent,new AppError('ROUTE_UNAVAILABLE','fixture failure'));
    else if (action === 'closeAll') await f.runtime.closeAll();
    else await f.runtime[action](f.plugin);
    assert.equal(first.connection.connection.stream.destroyed,true);
    assert.equal(second.connection.connection.stream.destroyed,true);
    assert.equal(f.runtime.sqlConnections.size,0);
    assert.equal(errors.length,1);
    assert.equal(errors[0].code,'MYSQL_SQL_SESSION_STALE');
    assert.throws(() => second.assertActive(),{code:'MYSQL_SQL_SESSION_STALE'});
  });
}

test('过期强制断开不得影响新的父会话及其 SQL 子连接', async () => {
  const f = fixture();
  const child = await f.runtime.openSqlConnection(f.plugin,f.parent);
  const result = await f.runtime.forceDisconnect(f.plugin,'test',{attemptToken:Symbol('stale')});
  assert.equal(result.stale,true);
  assert.equal(f.runtime.sqlConnections.size,1);
  child.assertActive();
  child.close();
});

test('SQL 会话在网络前校验父连接、配置版本和完整作用域', async () => {
  const f = fixture();
  await assert.rejects(f.runtime.openSqlConnection(f.plugin,{}),{code:'MYSQL_SQL_SESSION_STALE'});
  await assert.rejects(f.runtime.openSqlConnection({...f.plugin,revision:'changed'},f.parent),{code:'MYSQL_SQL_SESSION_STALE'});
  await assert.rejects(f.runtime.openSqlConnection({...f.plugin,environmentId:'other-env'},f.parent),{code:'PLUGIN_NOT_CONNECTED'});
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.runtime.openSqlConnection(f.plugin,f.parent,{signal:cancelled.signal}),{code:'MYSQL_SQL_CANCELLED'});
  assert.equal(f.loads.length,0);
  assert.equal(f.opened.length,0);
  assert.equal(f.runtime.sqlConnections.size,0);
});

test('每次使用 SQL 子连接都重验配置版本、父会话及连接守卫', async () => {
  for (const change of ['revision','replacement','guard']) {
    const f = fixture();
    const child = await f.runtime.openSqlConnection(f.plugin,f.parent);
    if (change === 'revision') f.plugin.revision = 'changed';
    if (change === 'replacement') f.runtime.sessions.set(mysqlRuntimeInternals.key(f.plugin),{...f.parent});
    if (change === 'guard') guardMysqlConnection(f.parent.connection).error = {code:'ECONNRESET'};
    assert.throws(() => child.assertActive(),{code:change === 'guard' ? 'ROUTE_UNAVAILABLE' : 'MYSQL_SQL_SESSION_STALE'});
    assert.equal(child.connection.connection.stream.destroyed,true);
    assert.equal(f.runtime.sqlConnections.size,0);
  }
});

for (const phase of ['credentials','route','handshake','database']) {
  for (const action of ['abort','closeAll']) {
    test(`${phase} 未完成时 ${action} 立即取消，迟到句柄全部释放`, {timeout:3000}, async () => {
      const wait = deferred();
      const entered = deferred();
      const stream = new Socket();
      const secureStream = new Socket();
      const lateConnection = makeConnection(secureStream);
      const f = fixture({
        load:phase === 'credentials' ? () => { entered.resolve(); return wait.promise; } : undefined,
        openTarget:phase === 'route' ? () => { entered.resolve(); return wait.promise; } : () => stream,
        createConnection:phase === 'handshake' ? () => { entered.resolve(); return wait.promise; } : undefined,
        query:phase === 'database' ? () => { entered.resolve(); return wait.promise; } : undefined,
      });
      const controller = new AbortController();
      const pending = f.runtime.openSqlConnection(f.plugin,f.parent,{signal:controller.signal});
      const rejected = assert.rejects(pending,{code:action === 'abort' ? 'MYSQL_SQL_CANCELLED' : 'MYSQL_SQL_SESSION_STALE'});
      await entered.promise;
      assert.equal(f.runtime.sqlConnections.size,1);
      if (action === 'abort') controller.abort();
      else await f.runtime.closeAll();
      await rejected;
      assert.equal(f.runtime.sqlConnections.size,0);
      if (phase === 'credentials') wait.resolve({password:'synthetic-password'});
      if (phase === 'route') wait.resolve(stream);
      if (phase === 'handshake') wait.resolve(lateConnection);
      if (phase === 'database') wait.resolve([[{ai_ops_database:'fixture'}],[]]);
      await nextTurn();
      if (phase === 'credentials') assert.equal(f.opened.length,0);
      else assert.equal(stream.destroyed,true);
      if (phase === 'handshake') assert.equal(secureStream.destroyed,true);
      assert.equal(f.runtime.sqlConnections.size,0);
      if (action === 'abort') assert.equal(f.runtime.require(f.plugin),f.parent);
    });
  }
}

test('父连接重连取消旧 SQL 开路由，迟到成功不能覆盖新主连接', async () => {
  const wait = deferred();
  const entered = deferred();
  const f = fixture({openTarget:() => { entered.resolve(); return wait.promise; }});
  const pending = f.runtime.openSqlConnection(f.plugin,f.parent);
  const rejected = assert.rejects(pending,{code:'MYSQL_SQL_SESSION_STALE'});
  await entered.promise;
  await f.runtime.connect(f.plugin);
  await rejected;
  const current = f.runtime.require(f.plugin);
  const stream = new Socket();
  wait.resolve(stream);
  await nextTurn();
  assert.equal(stream.destroyed,true);
  assert.equal(f.runtime.require(f.plugin),current);
  assert.notEqual(current,f.parent);
  assert.equal(current.connection.connection.stream.destroyed,false);
  assert.equal(f.runtime.sqlConnections.size,0);
  await f.runtime.disconnect(f.plugin);
});

test('固定数据库验证不通过时销毁子连接，主连接不受影响', async () => {
  const f = fixture({query:async () => [[{ai_ops_database:'different-database'}],[]]});
  await assert.rejects(f.runtime.openSqlConnection(f.plugin,f.parent),{code:'MYSQL_DATABASE_ACCESS_DENIED'});
  assert.equal(f.connections[0].connection.stream.destroyed,true);
  assert.equal(f.runtime.require(f.plugin),f.parent);
  assert.equal(f.runtime.sqlConnections.size,0);
});

test('取消后迟到的握手失败被接住且不泄露原始驱动信息', async () => {
  const wait = deferred();
  const entered = deferred();
  const f = fixture({createConnection:() => { entered.resolve(); return wait.promise; }});
  const controller = new AbortController();
  const pending = f.runtime.openSqlConnection(f.plugin,f.parent,{signal:controller.signal});
  const rejected = assert.rejects(pending,{code:'MYSQL_SQL_CANCELLED'});
  await entered.promise;
  controller.abort();
  await rejected;
  wait.reject(new Error('synthetic-private-driver-detail'));
  await nextTurn();
  assert.equal(f.runtime.sqlConnections.size,0);
  assert.equal(f.runtime.require(f.plugin),f.parent);
});

test('子连接初始化认证失败脱敏并释放流，主连接仍可使用', async () => {
  const stream = new Socket();
  const f = fixture({openTarget:() => stream,createConnection:async () => {
    throw Object.assign(new Error('synthetic-private-driver-detail'),{code:'ER_ACCESS_DENIED_ERROR'});
  }});
  await assert.rejects(f.runtime.openSqlConnection(f.plugin,f.parent), (error) => {
    assert.equal(error.code,'AUTHENTICATION_FAILED');
    assert.doesNotMatch(error.message,/private-driver/);
    return true;
  });
  assert.equal(stream.destroyed,true);
  assert.equal(f.runtime.sqlConnections.size,0);
  assert.equal(f.runtime.require(f.plugin),f.parent);
  assert.doesNotThrow(() => stream.emit('error',new Error('late-error')));
});

test('子连接创建前的父守卫错误不暴露原始驱动文本', async () => {
  const f = fixture();
  guardMysqlConnection(f.parent.connection).error = Object.assign(new Error('synthetic-private-driver-detail'),{code:'ECONNRESET'});
  await assert.rejects(f.runtime.openSqlConnection(f.plugin,f.parent), (error) => {
    assert.equal(error.code,'ROUTE_UNAVAILABLE');
    assert.doesNotMatch(error.message,/private-driver/);
    return true;
  });
  assert.equal(f.loads.length,0);
  assert.equal(f.runtime.sqlConnections.size,0);
});

test('已打开的 SQL 会话取消仅关闭该标签并报告一次', async () => {
  const f = fixture();
  const controller = new AbortController();
  const child = await f.runtime.openSqlConnection(f.plugin,f.parent,{signal:controller.signal});
  let notifications = 0;
  child.onLost = (error) => { assert.equal(error.code,'MYSQL_SQL_CANCELLED'); notifications += 1; };
  controller.abort();
  await nextTurn();
  assert.equal(notifications,1);
  assert.equal(child.connection.connection.stream.destroyed,true);
  assert.equal(f.runtime.require(f.plugin),f.parent);
  assert.equal(f.runtime.sqlConnections.size,0);
});
