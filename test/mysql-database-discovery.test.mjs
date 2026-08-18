import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MysqlPluginRuntime, mysqlRuntimeInternals } from '../src/mysql-plugin-runtime.mjs';

test('MySQL connection failures identify the field or network layer that needs correction', () => {
  const plugin = {target:{host:'db.example.test',port:3306,database:'orders'}};
  const dns = mysqlRuntimeInternals.mysqlConnectError(Object.assign(new Error('getaddrinfo failed'),{code:'ENOTFOUND'}),plugin);
  assert.equal(dns.code,'MYSQL_DNS_LOOKUP_FAILED');
  assert.match(dns.message,/db\.example\.test/);
  const timeout = mysqlRuntimeInternals.mysqlConnectError(Object.assign(new Error('timed out'),{code:'ETIMEDOUT'}),plugin);
  assert.equal(timeout.code,'CONNECT_TIMEOUT');
  assert.match(timeout.message,/公网\/内网地址.*白名单/);
  const database = mysqlRuntimeInternals.mysqlConnectError(Object.assign(new Error('unknown database'),{code:'ER_BAD_DB_ERROR'}),plugin);
  assert.equal(database.code,'DATABASE_NOT_FOUND');
  assert.match(database.message,/orders.*重新查询数据库/);
  const unsupportedTls = mysqlRuntimeInternals.mysqlConnectError(Object.assign(new Error('server does not support secure connection'),{code:'HANDSHAKE_NO_SSL_SUPPORT'}),plugin);
  assert.equal(unsupportedTls.code,'MYSQL_TLS_NOT_SUPPORTED');
  assert.match(unsupportedTls.message,/TLS.*关闭/);
  const invalidCertificate = mysqlRuntimeInternals.mysqlConnectError(Object.assign(new Error('certificate expired'),{code:'CERT_HAS_EXPIRED'}),plugin);
  assert.equal(invalidCertificate.code,'TLS_CERTIFICATE_INVALID');
});

test('MySQL TLS probe does not require a database and never retries in plaintext', async () => {
  const attempts = [];
  const routeManager = {
    createRelay:async () => ({host:'127.0.0.1',port:41240,generation:10}),
    closeRelay:async () => undefined,
  };
  const runtime = new MysqlPluginRuntime(routeManager,{load:async()=>null},{
    client:{createConnection:async (options) => {
      attempts.push(options);
      throw Object.assign(new Error('no secure transport'),{code:'HANDSHAKE_NO_SSL_SUPPORT'});
    }},
  });
  const draft = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'diagnostic-edit-tls',pluginType:'mysql',configState:'draft',
    target:{host:'db.internal',port:3306,database:'',addressFamily:'ipv4Only'},auth:{username:'reader'},
    transport:{kind:'direct'},tls:{mode:'required'},limits:{timeoutMs:5000},
  };

  await assert.rejects(
    () => runtime.connect(draft,{password:'secret'},{validationPurpose:'tls-probe',attemptToken:'tls-1'}),
    (error) => error.code === 'MYSQL_TLS_NOT_SUPPORTED',
  );
  assert.equal(attempts.length,1);
  assert.equal(attempts[0].database,undefined);
  assert.equal(typeof attempts[0].ssl,'object');
});

test('MySQL database discovery returns visible non-system databases and releases the temporary route', async () => {
  const calls = [];
  const routeManager = {
    createRelay: async () => { calls.push('relay:create'); return { host: '127.0.0.1', port: 41234, generation: 1 }; },
    closeRelay: async () => { calls.push('relay:close'); },
  };
  const connection = {
    query: async ({ sql }) => {
      assert.equal(sql, 'SHOW DATABASES');
      return [[
        { Database: 'mysql' }, { Database: 'member_archive' }, { Database: 'information_schema' },
        { Database: 'member' }, { Database: 'member' }, { Database: 'performance_schema' },
      ]];
    },
    end: async () => { calls.push('connection:end'); },
  };
  const client = { createConnection: async (options) => {
    assert.equal(options.database, undefined);
    assert.equal(options.user, 'reader');
    assert.equal(options.password, 'secret');
    return connection;
  } };
  const runtime = new MysqlPluginRuntime(routeManager, { load: async () => null }, { client });
  const plugin = {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-discovery-1', pluginType:'mysql', configState:'draft',
    target:{ host:'db.internal', port:3306, database:'', addressFamily:'ipv4Preferred' }, auth:{ username:'reader' },
    transport:{ kind:'direct' }, tls:{ mode:'disabled' }, limits:{ timeoutMs:5000 },
  };
  assert.deepEqual(await runtime.listDatabases(plugin, { password:'secret' }), {
    databases:['member','member_archive'], truncated:false,
  });
  assert.deepEqual(calls, ['relay:create','connection:end','relay:close']);
});

test('MySQL direct discovery uses the resolved target stream without a loopback relay', async () => {
  const stream = new EventEmitter();
  stream.destroy = () => undefined;
  const calls = [];
  const routeManager = {
    createStreamRoute: async () => {
      calls.push('stream:create');
      return {stream,generation:9};
    },
    createRelay: async () => {
      throw new Error('direct MySQL must not use the loopback relay');
    },
    closeRelay: async (_plugin, generation) => calls.push(`route:close:${generation}`),
  };
  const runtime = new MysqlPluginRuntime(routeManager,{load:async()=>null},{
    client:{
      createConnection:async(options)=>{
        assert.equal(options.stream,stream);
        assert.equal(options.host,'db.example.test');
        return {
          query:async()=>[[{Database:'orders'}]],
          end:async()=>calls.push('connection:end'),
        };
      },
    },
  });
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-direct',pluginType:'mysql',configState:'draft',
    target:{host:'db.example.test',port:3306,database:'',addressFamily:'ipv4Preferred'},auth:{username:'root'},
    transport:{kind:'direct'},tls:{mode:'disabled'},limits:{timeoutMs:5000},
  };

  assert.deepEqual(await runtime.listDatabases(plugin,{password:'secret'}),{databases:['orders'],truncated:false});
  assert.deepEqual(calls,['stream:create','connection:end','route:close:9']);
});

test('SHOW DATABASES denial is a manual-selection outcome and never hides route cleanup', async () => {
  const calls = [];
  const routeManager = {
    createRelay:async () => ({host:'127.0.0.1',port:41237,generation:7}),
    closeRelay:async (_plugin,generation) => { calls.push(`route:close:${generation}`); },
  };
  const runtime = new MysqlPluginRuntime(routeManager,{load:async()=>null},{
    client:{createConnection:async () => ({
      query:async ({sql}) => {
        calls.push(sql);
        throw Object.assign(new Error('command denied'),{code:'ER_SPECIFIC_ACCESS_DENIED_ERROR'});
      },
      end:async () => { calls.push('connection:end'); },
    })},
  });
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-manual',pluginType:'mysql',configState:'draft',
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},auth:{username:'reader'},
    transport:{kind:'direct'},tls:{mode:'required'},limits:{timeoutMs:5000},
  };

  await assert.rejects(
    () => runtime.listDatabases(plugin,{password:'secret'}),
    (error) => error.code === 'MYSQL_DATABASE_LIST_FORBIDDEN'
      && error.details?.manualInputAllowed === true,
  );
  assert.deepEqual(calls,['SHOW DATABASES','connection:end','route:close:7']);
});

test('formal MySQL connect verifies the driver-selected database without interpolating its name', async () => {
  const database = "orders`; USE mysql; --";
  const calls = [];
  let connectionOptions;
  const routeManager = {
    createRelay:async () => ({host:'127.0.0.1',port:41238,generation:8}),
    closeRelay:async () => undefined,
  };
  const runtime = new MysqlPluginRuntime(routeManager,{load:async()=>({password:'secret'})},{
    client:{createConnection:async (options) => {
      connectionOptions = options;
      return {
        query:async ({sql}) => {
          calls.push(sql);
          if (sql === 'SELECT DATABASE() AS ai_ops_database') return [[{ai_ops_database:database}],[]];
          return [[{ai_ops_health:1}],[]];
        },
        end:async () => undefined,
      };
    }},
  });
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-fixed',pluginType:'mysql',configState:'ready',revision:1,
    target:{host:'db.internal',port:3306,database,addressFamily:'ipv4Only'},auth:{username:'reader'},
    transport:{kind:'direct'},tls:{mode:'required'},limits:{timeoutMs:5000,maxRows:100,maxBytes:1048576},
  };

  assert.equal((await runtime.connect(plugin)).connected,true);
  assert.equal(connectionOptions.database,database);
  assert.deepEqual(calls,['SELECT DATABASE() AS ai_ops_database','SELECT 1 AS ai_ops_health']);
  assert.equal(calls.some((sql) => /\bUSE\b/iu.test(sql)),false);
});

test('formal MySQL connect rejects a driver session bound to a different database', async () => {
  const routeManager = {
    createRelay:async () => ({host:'127.0.0.1',port:41239,generation:9}),
    closeRelay:async () => undefined,
  };
  const runtime = new MysqlPluginRuntime(routeManager,{load:async()=>({password:'secret'})},{
    client:{createConnection:async () => ({
      query:async ({sql}) => sql === 'SELECT DATABASE() AS ai_ops_database'
        ? [[{ai_ops_database:'wrong_database'}],[]]
        : [[{ai_ops_health:1}],[]],
      end:async () => undefined,
    })},
  });
  const plugin = {
    projectId:'p1',environmentId:'e1',pluginInstanceId:'mysql-fixed-mismatch',pluginType:'mysql',configState:'ready',revision:1,
    target:{host:'db.internal',port:3306,database:'orders',addressFamily:'ipv4Only'},auth:{username:'reader'},
    transport:{kind:'direct'},tls:{mode:'required'},limits:{timeoutMs:5000,maxRows:100,maxBytes:1048576},
  };

  await assert.rejects(
    () => runtime.connect(plugin),
    (error) => error.code === 'MYSQL_DATABASE_ACCESS_DENIED',
  );
  assert.equal(runtime.status(plugin).connected,false);
});

test('MySQL runtime accepts a write-capable account while Agent SQL remains read-only', async () => {
  const calls = [];
  const routeManager = {
    createRelay: async () => ({ host:'127.0.0.1', port:41235, generation:1 }),
    closeRelay: async () => { calls.push('relay:close'); },
  };
  const connection = {
    query: async ({ sql }) => {
      calls.push(sql);
      if (sql === 'SHOW GRANTS FOR CURRENT_USER') throw new Error('grant inspection must not run');
      if (sql === 'SELECT DATABASE() AS ai_ops_database') return [[{ai_ops_database:'app'}],[]];
      return [[], []];
    },
    end: async () => { calls.push('connection:end'); },
  };
  const client = { createConnection: async () => connection };
  const runtime = new MysqlPluginRuntime(routeManager, { load: async () => ({password:'root-secret'}) }, { client });
  const plugin = {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-root', pluginType:'mysql', configState:'ready', revision:1,
    target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Preferred'}, auth:{username:'root'},
    transport:{kind:'direct'}, tls:{mode:'disabled'}, limits:{timeoutMs:5000,maxRows:100,maxBytes:1048576},
  };
  assert.equal((await runtime.connect(plugin)).connected, true);
  assert.deepEqual(calls, ['relay:close','SELECT DATABASE() AS ai_ops_database','SELECT 1 AS ai_ops_health']);
  await assert.rejects(() => runtime.queryReadonly(plugin, 'UPDATE users SET admin = 1'), (error) => error.code === 'HARD_POLICY_DENIED');
  await runtime.disconnect(plugin);
  assert.deepEqual(calls, ['relay:close','SELECT DATABASE() AS ai_ops_database','SELECT 1 AS ai_ops_health','connection:end','relay:close']);
});

test('MySQL query timeout evicts the dead session and reports the connection loss', async () => {
  const calls = [];
  const lifecycle = [];
  const routeManager = {
    createRelay: async () => ({ host:'127.0.0.1', port:41236, generation:1 }),
    closeRelay: async () => { calls.push('relay:close'); },
  };
  const rawConnection = new EventEmitter();
  rawConnection.destroy = () => { calls.push('connection:destroy'); };
  let queryCount = 0;
  const connection = {
    connection: rawConnection,
    query: async ({ sql }) => {
      calls.push(sql);
      queryCount += 1;
      if (queryCount === 1) return [[{ai_ops_database:'app'}], []];
      if (queryCount === 2) return [[], []];
      const error = new Error('Query inactivity timeout');
      error.code = 'PROTOCOL_SEQUENCE_TIMEOUT';
      throw error;
    },
    end: async () => { calls.push('connection:end'); },
  };
  const runtime = new MysqlPluginRuntime(
    routeManager,
    { load: async () => ({password:'reader-secret'}) },
    { client:{createConnection:async()=>connection} },
  );
  runtime.on('lifecycle', (event) => lifecycle.push(event));
  const plugin = {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'mysql-timeout', pluginType:'mysql', configState:'ready', revision:1,
    target:{host:'db.internal',port:3306,database:'app',addressFamily:'ipv4Preferred'}, auth:{username:'reader'},
    transport:{kind:'direct'}, tls:{mode:'disabled'}, limits:{timeoutMs:5000,maxRows:100,maxBytes:1048576},
  };

  assert.equal((await runtime.connect(plugin)).connected, true);
  await assert.rejects(
    () => runtime.queryReadonly(plugin, 'SELECT 1'),
    (error) => error.code === 'DATABASE_QUERY_TIMEOUT' && /连接已关闭/.test(error.message),
  );

  assert.equal(runtime.status(plugin).connected, false);
  assert.equal(calls.includes('connection:destroy'), true);
  assert.equal(calls.filter((call) => call === 'relay:close').length, 2);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].type, 'lost');
  assert.equal(lifecycle[0].error.code, 'DATABASE_QUERY_TIMEOUT');
});
