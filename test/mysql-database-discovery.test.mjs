import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';

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
