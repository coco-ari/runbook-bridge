import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import YAML from 'yaml';

const { CdpClient, assertUpgradeSnapshot } = createRequire(import.meta.url)('../scripts/install-upgrade-regression.cjs');

function migrationSnapshots() {
  const id = 'eecf1af1-cc08-4594-8af8-545b58322466';
  const old = {schemaVersion:1,projectId:'test',environmentId:'test',pluginInstanceId:'mysql-one',pluginType:'mysql',displayName:'测试数据库',revision:3,
    target:{host:'127.0.0.1',port:3306,database:'test_db'},auth:{username:'test'},transport:{kind:'direct'},tls:{mode:'disabled'},permissions:{read:true},limits:{maxRows:10}};
  const environment = {schemaVersion:1,revision:4,pluginOrder:['mysql-one','server-one'],updatedAt:'2026-01-01'};
  const oldKey = 'test/test/mysql-one';
  const newKey = `test/test/mysql-connection-${id}`;
  const unchanged = {ciphertext:'b3RoZXI='};
  const migrated = {pluginType:'mysql',bindingHash:'a'.repeat(64),ciphertext:'dGVzdA=='};
  const {auth,transport,tls,...rest} = old;
  const current = {...rest,schemaVersion:2,revision:4,mysqlConnectionId:id,target:{database:'test_db'},tags:[]};
  const currentEnvironment = {...environment,schemaVersion:2,revision:5,updatedAt:'2026-01-02',mysqlConnections:[{connectionId:id,name:old.displayName,revision:1,target:{host:'127.0.0.1',port:3306},auth,transport,tls}]};
  const serialize = value => Buffer.from(YAML.stringify(value));
  const vault = entries => Buffer.from(JSON.stringify({schemaVersion:1,entries}));
  const before = new Map([['mysql',serialize(old)],['environment',serialize(environment)],['server',Buffer.from('unchanged')],
    ...['primary','backup'].map(file => [file,vault({[oldKey]:{ciphertext:'b2xk'},other:unchanged})])]);
  const after = new Map([['mysql',serialize(current)],['environment',serialize(currentEnvironment)],['server',Buffer.from('unchanged')],
    ...['primary','backup'].map(file => [file,vault({[newKey]:migrated,other:unchanged})])]);
  return {before,after,options:{mysqlFile:'mysql',environmentFile:'environment',vaultFiles:['primary','backup']}};
}

test('安装迁移回归接受精确的共享连接迁移和同版本原样保留', () => {
  const {before,after,options} = migrationSnapshots();
  assert.equal(assertUpgradeSnapshot(before,after,options),true);
  assert.equal(assertUpgradeSnapshot(after,new Map(after),options),false);
});

test('安装迁移回归拒绝数据库、权限、连接或其他凭据被意外改写', async t => {
  for (const [name,file,mutate] of [
    ['数据库','mysql',value => {value.target.database = 'other_db';}],
    ['权限','mysql',value => {value.permissions.read = false;}],
    ['连接','environment',value => {value.mysqlConnections[0].target.port = 3307;}],
    ['其他凭据','primary',value => {delete value.entries.other;}],
    ['备份凭据','backup',value => {Object.values(value.entries)[0].ciphertext = 'Y2hhbmdlZA==';}],
  ]) await t.test(name, () => {
    const {before,after,options} = migrationSnapshots();
    const value = YAML.parse(after.get(file).toString());
    mutate(value);
    after.set(file,Buffer.from(file === 'primary' || file === 'backup' ? JSON.stringify(value) : YAML.stringify(value)));
    assert.throws(() => assertUpgradeSnapshot(before,after,options));
  });
});

class Socket extends EventTarget {
  send(message) { this.sent = JSON.parse(message); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(result) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:this.sent.id,result})}));
  }
}

test('安装回归的浏览器请求超时后释放等待项，迟到回复不影响后续请求',async () => {
  const socket = new Socket();
  const client = new CdpClient(socket,{timeoutMs:20});
  await assert.rejects(client.call('Runtime.evaluate'),/浏览器请求超时：Runtime.evaluate/u);
  assert.equal(client.pending.size,0);
  socket.reply({stale:true});
  const next = client.call('Browser.close');
  socket.reply({closed:true});
  assert.deepEqual(await next,{closed:true});
  assert.equal(client.pending.size,0);
  client.close();
});

test('安装回归的浏览器连接关闭时拒绝请求并清理超时计时器',async () => {
  const socket = new Socket();
  const client = new CdpClient(socket,{timeoutMs:1000});
  const pending = client.call('Runtime.evaluate');
  client.close();
  await assert.rejects(pending,/CDP connection closed/u);
  assert.equal(client.pending.size,0);
});
