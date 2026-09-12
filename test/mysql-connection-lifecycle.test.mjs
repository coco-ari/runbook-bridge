import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import mysql from 'mysql2';
import { createMysqlConnection, guardMysqlConnection, endMysqlConnection } from '../src/mysql-connection.mjs';
import { MysqlPluginRuntime, mysqlRuntimeInternals } from '../src/mysql-plugin-runtime.mjs';

function shutdownError() {
  return Object.assign(new Error('shutdown EINVAL'), {code:'EINVAL', syscall:'shutdown'});
}

class ClosingSocket extends Duplex {
  shutdowns = 0;
  _read() {}
  _write(_chunk, _encoding, callback) { callback(); }
  _final(callback) {
    this.shutdowns += 1;
    callback(shutdownError());
  }
}

const plugin = {
  projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-1', pluginType:'mysql',
  configState:'ready', revision:1, target:{host:'db.example.test',port:3306,database:'app'},
  auth:{username:'reader'}, transport:{kind:'direct'}, tls:{mode:'disabled'},
  limits:{timeoutMs:5000,maxRows:100,maxBytes:1048576},
};

function fixture({onQuery, onEnd} = {}) {
  const connections = [];
  const lifecycle = [];
  const closedRoutes = [];
  let generation = 0;
  let activeGeneration = null;
  const routeManager = {
    createStreamRoute:async () => {
      const stream = new ClosingSocket();
      activeGeneration = ++generation;
      return {stream,generation};
    },
    closeRelay:async (_plugin, expected = null) => {
      if (expected !== null && activeGeneration !== expected) return;
      if (activeGeneration !== null) closedRoutes.push(activeGeneration);
      activeGeneration = null;
    },
  };
  const runtime = new MysqlPluginRuntime(routeManager, {load:async () => ({password:'test-only'})}, {
    client:{createConnection:async ({stream}) => {
      const raw = new EventEmitter();
      raw.stream = stream;
      const connection = {
        connection:raw, ended:0, queries:[],
        query:async (request) => {
          connection.queries.push(request.sql);
          if (onQuery) await onQuery(raw, request);
          if (request.sql === 'SELECT DATABASE() AS ai_ops_database') return [[{ai_ops_database:'app'}]];
          if (request.sql === 'SHOW DATABASES') return [[{Database:'app'}]];
          return [[{ai_ops_health:1}]];
        },
        end:async () => {
          connection.ended += 1;
          if (onEnd) await onEnd(raw);
        },
      };
      connections.push(connection);
      return connection;
    }},
  });
  runtime.on('lifecycle', (event) => lifecycle.push(event));
  return {runtime,connections,lifecycle,closedRoutes,activeGeneration:() => activeGeneration};
}

test('真实 mysql2 握手断线不会再次 shutdown，并接住迟到的 EINVAL', async () => {
  const stream = new ClosingSocket();
  const pending = createMysqlConnection({
    stream,user:'reader',password:'test-only',connectTimeout:1000,
  });
  // 模拟底层句柄先关闭、驱动随后收到 close 的事件顺序，不建立网络连接。
  stream.emit('close');
  await assert.rejects(pending, (error) => error.code === 'PROTOCOL_CONNECTION_LOST');
  assert.equal(stream.destroyed,true);
  assert.equal(stream.shutdowns,0);
  assert.doesNotThrow(() => stream.emit('error',shutdownError()));
  await nextTurn();
});

test('真实 mysql2 握手网络失败保留原始错误，后续关闭错误不会逃逸', async () => {
  const stream = new ClosingSocket();
  const pending = createMysqlConnection({stream,user:'reader',connectTimeout:1000});
  const original = Object.assign(new Error('test reset'),{code:'ECONNRESET'});
  stream.emit('error',original);
  await assert.rejects(pending,(error) => error === original);
  assert.doesNotThrow(() => stream.emit('error',shutdownError()));
  assert.equal(stream.shutdowns,0);
  await nextTurn();
});

test('空闲 MySQL 断线只失效一次，旧连接迟到事件不影响重连会话', async () => {
  const f = fixture();
  await f.runtime.connect(plugin);
  const old = f.connections[0].connection;
  old.stream.emit('close');
  assert.equal(f.runtime.status(plugin).connected,false);
  await nextTurn();
  assert.equal(f.lifecycle.length,1);
  assert.equal(f.lifecycle[0].error.code,'ROUTE_UNAVAILABLE');
  assert.match(f.lifecycle[0].error.message,/MySQL 连接已经中断/);
  assert.equal(old.stream.shutdowns,0);
  await f.runtime.connect(plugin);
  const newGeneration = f.activeGeneration();
  old.emit('error',shutdownError());
  old.emit('end');
  old.stream.emit('error',shutdownError());
  await nextTurn();
  assert.equal(f.lifecycle.length,1);
  assert.equal(f.activeGeneration(),newGeneration);
  assert.equal(f.runtime.status(plugin).connected,true);
  assert.equal(f.connections[1].connection.stream.destroyed,false);
  await f.runtime.disconnect(plugin);
});

test('MySQL 初始化查询间隙的后台错误不能被健康查询的成功结果掩盖', async () => {
  const f = fixture({onQuery:(raw) => raw.emit('error',shutdownError())});
  await assert.rejects(f.runtime.connect(plugin),(error) => error.code === 'ROUTE_UNAVAILABLE');
  assert.equal(f.runtime.status(plugin).connected,false);
  assert.equal(f.connections[0].queries.length,1);
  assert.equal(f.connections[0].connection.stream.destroyed,true);
  assert.equal(f.lifecycle.length,0);
  assert.equal(f.activeGeneration(),null);
  await nextTurn();
});

test('临时数据库发现的后台断线返回友好错误并释放路由', async () => {
  const f = fixture({onQuery:(raw) => raw.emit('error',shutdownError())});
  await assert.rejects(
    f.runtime.listDatabases(plugin,{password:'test-only'}),
    (error) => error.code === 'ROUTE_UNAVAILABLE' && !error.message.includes('EINVAL'),
  );
  assert.equal(f.activeGeneration(),null);
  assert.equal(f.runtime.sessions.size,0);
  assert.equal(f.lifecycle.length,0);
  assert.doesNotThrow(() => f.connections[0].connection.emit('error',shutdownError()));
  await nextTurn();
});

test('主动断开期间和之后的 Socket 错误不会发布断线重连事件', async () => {
  const f = fixture({onEnd:(raw) => raw.stream.emit('error',shutdownError())});
  await f.runtime.connect(plugin);
  const raw = f.connections[0].connection;
  await f.runtime.disconnect(plugin);
  raw.emit('error',shutdownError());
  raw.stream.emit('error',shutdownError());
  await nextTurn();
  assert.equal(f.lifecycle.length,0);
  assert.equal(f.runtime.status(plugin).connected,false);
  assert.equal(raw.stream.destroyed,true);
  assert.equal(raw.stream.shutdowns,0);
  assert.equal(f.activeGeneration(),null);
});

test('查询报告 Socket shutdown 失败时废弃会话且不泄露驱动文本', async () => {
  let fail = false;
  const f = fixture({onQuery:() => {
    if (fail) throw Object.assign(shutdownError(), {message:'private driver detail',syscall:'shutdown'});
  }});
  await f.runtime.connect(plugin);
  fail = true;
  await assert.rejects(f.runtime.health(plugin),(error) => error.code === 'ROUTE_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(f.lifecycle.length,1);
  assert.equal(f.runtime.status(plugin).connected,false);
  assert.equal(f.activeGeneration(),null);
});

test('仅 Socket shutdown 的 EINVAL 被归类为断线，普通无效参数不重试', () => {
  assert.equal(mysqlRuntimeInternals.mysqlError(shutdownError()).code,'ROUTE_UNAVAILABLE');
  assert.equal(mysqlRuntimeInternals.invalidatesSession(shutdownError()),true);
  const other = Object.assign(new Error('invalid option'),{code:'EINVAL',syscall:'other'});
  assert.equal(mysqlRuntimeInternals.mysqlError(other).code,'DATABASE_OPERATION_FAILED');
  assert.equal(mysqlRuntimeInternals.invalidatesSession(other),false);
});

test('TLS 替换后的流在活跃查询出错时先释放句柄并保留查询错误', async () => {
  const originalStream = new ClosingSocket();
  const raw = mysql.createConnection({stream:originalStream,isServer:true,connectTimeout:0});
  const guard = guardMysqlConnection(raw);
  const secureStream = new ClosingSocket();
  raw.stream = secureStream;
  secureStream.on('error',(error) => raw._handleNetworkError(error));
  raw.emit('connect');
  const query = raw.promise().query('SELECT 1');
  const original = Object.assign(new Error('test query reset'),{code:'ECONNRESET'});
  secureStream.emit('error',original);
  await assert.rejects(query,(error) => error.code === 'ECONNRESET');
  assert.equal(guard.error,original);
  assert.equal(secureStream.destroyed,true);
  assert.equal(secureStream.shutdowns,0);
  originalStream.destroy();
  await nextTurn();
});

test('真实 mysql2 关闭过程中发生流错误时仍先销毁底层句柄', async () => {
  const stream = new ClosingSocket();
  const raw = mysql.createConnection({stream,isServer:true,connectTimeout:0});
  const guard = guardMysqlConnection(raw);
  let losses = 0;
  guard.onLost = () => { losses += 1; };
  await endMysqlConnection({
    connection:raw,
    end:async () => stream.emit('error',Object.assign(new Error('test closing reset'),{code:'ECONNABORTED'})),
  });
  assert.equal(losses,0);
  assert.equal(stream.destroyed,true);
  assert.equal(stream.shutdowns,0);
  await nextTurn();
});

test('旧路由清理晚于重连完成时不会补发失效通知', async () => {
  const f = fixture();
  await f.runtime.connect(plugin);
  const originalClose = f.runtime.routeManager.closeRelay;
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  f.runtime.routeManager.closeRelay = async (target, generation) => {
    if (generation === 1) await cleanup;
    return originalClose(target,generation);
  };
  f.connections[0].connection.emit('error',shutdownError());
  assert.equal(f.lifecycle.length,1);
  await f.runtime.connect(plugin);
  releaseCleanup();
  await nextTurn();
  assert.equal(f.lifecycle.length,1);
  assert.equal(f.runtime.status(plugin).connected,true);
  assert.equal(f.activeGeneration(),2);
  await f.runtime.disconnect(plugin);
});
