import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'ssh2';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';
import { RedisPluginRuntime } from '../src/redis-plugin-runtime.mjs';
import { DesktopMysqlEditor } from '../src/desktop-mysql-editor.mjs';
import { DesktopRedisEditor } from '../src/desktop-redis-editor.mjs';

// 仅显式传入授权测试主机时运行；服务只绑定回环地址，经验证主机密钥的 SSH 隧道访问。
const host=process.env.RUNBOOK_TEST_HOST,password=process.env.RUNBOOK_TEST_PASSWORD;
if(!host||!password)throw new Error('必须显式配置授权测试服务器。');
const known=spawnSync('ssh-keygen',['-F',host,'-f',path.join(os.homedir(),'.ssh','known_hosts')],{encoding:'utf8',windowsHide:true});
const keys=known.stdout.split(/\r?\n/u).filter(line=>line&&!line.startsWith('#')).map(line=>line.trim().split(/\s+/u)[2]);
if(!keys.length)throw new Error('缺少可信 SSH 主机密钥。');
const ssh=new Client(),sockets=new Set(),servers=[],connections=[];
const suffix=crypto.randomBytes(6).toString('hex'),container='runbook-write-test-'+suffix;
const database='runbook_write_test',dbPassword=crypto.randomBytes(24).toString('hex');
let redisStream,redisAdmin,mysqlEditor,redisEditor,created=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function execute(command,input=''){
  return new Promise((resolve,reject)=>ssh.exec(command,(error,stream)=>{
    if(error){reject(new Error('测试服务器命令无法执行。'));return;}
    let output='';stream.on('data',chunk=>{output+=chunk;if(output.length>65536)stream.close();});
    stream.stderr.on('data',()=>{});stream.on('close',code=>code===0?resolve(output.trim()):reject(new Error('测试服务器命令执行失败。')));stream.end(input);
  }));
}
async function tunnel(port){
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    ssh.forwardOut('127.0.0.1',0,'127.0.0.1',port,(error,stream)=>{if(error){socket.destroy();return;}stream.on('error',()=>socket.destroy());socket.on('close',()=>stream.destroy());socket.pipe(stream).pipe(socket);});
  });servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;
}
const scope={projectId:'live-fixture',environmentId:'isolated',pluginInstanceId:'mysql'};
const audit={appendAudit:async()=>{}};
try{
  await new Promise((resolve,reject)=>{ssh.once('ready',resolve);ssh.once('error',()=>reject(new Error('SSH 连接失败。')));ssh.connect({host,username:process.env.RUNBOOK_TEST_USER??'root',password,readyTimeout:15000,hostVerifier:key=>keys.includes(key.toString('base64'))});});
  ssh.on('error',()=>{});
  // 使用已安装的镜像创建独立实例，不访问现有业务容器或数据。
  await execute('docker image inspect mysql:8.4 --format "{{.Id}}"');
  await execute('docker run -d --rm --name '+container+' -p 127.0.0.1::3306 --env-file /dev/stdin mysql:8.4', 'MYSQL_ROOT_PASSWORD='+dbPassword+'\nMYSQL_ROOT_HOST=%\n');created=true;
  const mapping=await execute('docker port '+container+' 3306/tcp'),mysqlPort=Number(mapping.split(':').at(-1));
  assert.ok(Number.isInteger(mysqlPort)&&mysqlPort>0);
  const localMysql=await tunnel(mysqlPort);
  let admin;
  for(let attempt=0;attempt<50;attempt++){
    try{admin=await mysql.createConnection({host:'127.0.0.1',port:localMysql,user:'root',password:dbPassword,connectTimeout:2000,supportBigNumbers:true,bigNumberStrings:true});break;}catch{await pause(1000);}
  }
  if(!admin)throw new Error('隔离 MySQL 实例未能及时启动。');connections.push(admin);
  await admin.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4');await admin.query('USE '+database);
  await admin.query("CREATE TABLE items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(100) NOT NULL, optional TEXT, amount DECIMAL(20,4) DEFAULT 1.2500, generated_value INT GENERATED ALWAYS AS (CHAR_LENGTH(label)) STORED) ENGINE=InnoDB");
  await admin.query("INSERT INTO items (id,label,optional) VALUES (9007199254740993,'original',NULL),(9007199254740994,'second','')");
  await admin.query("CREATE USER 'fixture_writer'@'%' IDENTIFIED BY ?",[dbPassword]);await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE,TRIGGER ON "+database+".* TO 'fixture_writer'@'%'");
  await admin.query("GRANT PROCESS ON *.* TO 'fixture_writer'@'%'");
  const connection=await mysql.createConnection({host:'127.0.0.1',port:localMysql,user:'fixture_writer',password:dbPassword,database,supportBigNumbers:true,bigNumberStrings:true});connections.push(connection);
  const runtime=new MysqlPluginRuntime({closeRelay:async()=>{}},{});runtime.sessions.set('live-fixture/isolated/mysql',{connection});
  const plugin={...scope,revision:1,pluginType:'mysql',displayName:'隔离验证',target:{database},limits:{maxRows:100,maxBytes:1048576,timeoutMs:5000}};
  mysqlEditor=new DesktopMysqlEditor(runtime,audit);
  const opened=await mysqlEditor.open('live',plugin,{sql:'SELECT id,label FROM items'});
  const full=await mysqlEditor.row('live',plugin,{editId:opened.editId,rowId:opened.rows[0].rowId});assert.equal(full.values.amount,'1.2500');assert.equal(full.values.optional,null);
  const plan=mysqlEditor.prepare('live',plugin,{editId:opened.editId,changes:[{kind:'delete',rowId:opened.rows[0].rowId},{rowId:opened.rows[1].rowId,values:{label:'updated'}},{kind:'insert',rowId:'new-draft',values:{label:'新增测试',optional:''}}]});
  const committed=await mysqlEditor.commit('live',plugin,{editId:opened.editId,planId:plan.planId});assert.equal(committed.status,'success',committed.error?.message);
  const [rows]=await admin.query('SELECT * FROM items ORDER BY id');assert.equal(rows.length,2);assert.equal(rows[0].label,'updated');assert.equal(rows[1].label,'新增测试');assert.equal(rows[1].amount,'1.2500');assert.equal(rows[1].optional,'');
  const snapshot=await mysqlEditor.open('live',plugin,{sql:'SELECT * FROM items'});await mysqlEditor.row('live',plugin,{editId:snapshot.editId,rowId:snapshot.rows[0].rowId});
  const blocked=mysqlEditor.prepare('live',plugin,{editId:snapshot.editId,changes:[{kind:'delete',rowId:snapshot.rows[0].rowId}]});await admin.query('UPDATE items SET optional=? WHERE id=?',['external',rows[0].id]);
  assert.equal((await mysqlEditor.commit('live',plugin,{editId:snapshot.editId,planId:blocked.planId})).error.code,'MYSQL_EDIT_CONFLICT');
  await admin.query('CREATE DATABASE runbook_write_reference');
  await admin.query('CREATE TABLE runbook_write_reference.children (id INT PRIMARY KEY,parent_id BIGINT UNSIGNED,FOREIGN KEY(parent_id) REFERENCES '+database+'.items(id) ON DELETE CASCADE) ENGINE=InnoDB');
  const deleteFirst=async(table)=>{
    const snapshot=await mysqlEditor.open('live',plugin,{sql:'SELECT * FROM `'+table+'`'});
    await mysqlEditor.row('live',plugin,{editId:snapshot.editId,rowId:snapshot.rows[0].rowId});
    const plan=mysqlEditor.prepare('live',plugin,{editId:snapshot.editId,changes:[{kind:'delete',rowId:snapshot.rows[0].rowId}]});
    return mysqlEditor.commit('live',plugin,{editId:snapshot.editId,planId:plan.planId});
  };
  assert.equal((await deleteFirst('items')).error.code,'MYSQL_EDIT_READONLY','不可见的跨库级联必须被阻止');
  await admin.query('DROP DATABASE runbook_write_reference');
  await admin.query('CREATE TABLE `中文父表` (id INT PRIMARY KEY) ENGINE=InnoDB');await admin.query('INSERT INTO `中文父表` VALUES (1)');
  await admin.query('CREATE TABLE `中文子表` (id INT PRIMARY KEY,parent_id INT,FOREIGN KEY(parent_id) REFERENCES `中文父表`(id) ON DELETE CASCADE) ENGINE=InnoDB');
  assert.equal((await deleteFirst('中文父表')).error?.code,'MYSQL_EDIT_READONLY','中文表名的级联必须被阻止');
  await admin.query("CREATE TRIGGER fixture_insert BEFORE INSERT ON items FOR EACH ROW SET NEW.optional='trigger'");
  const insertCheck=async()=>{const snapshot=await mysqlEditor.open('live',plugin,{sql:'SELECT * FROM items'});const plan=mysqlEditor.prepare('live',plugin,{editId:snapshot.editId,changes:[{kind:'insert',rowId:'guard-draft',values:{label:'blocked'}}]});return mysqlEditor.commit('live',plugin,{editId:snapshot.editId,planId:plan.planId});};
  assert.equal((await insertCheck()).error.code,'MYSQL_EDIT_READONLY');await admin.query('DROP TRIGGER fixture_insert');
  await admin.query("REVOKE TRIGGER ON "+database+".* FROM 'fixture_writer'@'%'");assert.equal((await insertCheck()).error.code,'MYSQL_EDIT_READONLY');
  await admin.query("GRANT TRIGGER ON "+database+".* TO 'fixture_writer'@'%'");
  await admin.query("REVOKE PROCESS ON *.* FROM 'fixture_writer'@'%'");
  // MySQL 全局权限变更在新连接中生效，以新会话验证缺少 PROCESS 的账号。
  connection.destroy();
  const restricted=await mysql.createConnection({host:'127.0.0.1',port:localMysql,user:'fixture_writer',password:dbPassword,database,supportBigNumbers:true,bigNumberStrings:true});connections.push(restricted);
  runtime.sessions.set('live-fixture/isolated/mysql',{connection:restricted});
  assert.equal((await deleteFirst('items')).error?.code,'MYSQL_EDIT_READONLY');
  process.stdout.write('MySQL 8.4：完整行复制读取、混合事务、自增、默认值、NULL/空字符串、精确整数及冲突保护通过。\n');
  const redisPort=Number(await execute(`python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'`));
  assert.ok(Number.isInteger(redisPort)&&redisPort>0);
  await new Promise((resolve,reject)=>ssh.exec('redis-server --bind 127.0.0.1 --port '+redisPort+' --save "" --appendonly no --protected-mode yes',(error,stream)=>{if(error){reject(error);return;}redisStream=stream;stream.on('data',()=>{});stream.stderr.on('data',()=>{});resolve();}));
  const localRedis=await tunnel(redisPort);
  for(let attempt=0;attempt<15;attempt++){
    const client=createClient({socket:{host:'127.0.0.1',port:localRedis,reconnectStrategy:false},database:3,RESP:2});client.on('error',()=>{});
    try{await client.connect();redisAdmin=client;break;}catch{client.destroy();await pause(300);}
  }
  if(!redisAdmin)throw new Error('隔离 Redis 实例启动失败。');
  const redisPlugin={...scope,pluginInstanceId:'redis',pluginType:'redis',revision:1,displayName:'隔离验证',target:{db:3},patterns:[{patternId:'fixture',pattern:'fixture:*'}],limits:{timeoutMs:5000,maxValueBytes:65536}};
  const redisRuntime=new RedisPluginRuntime({},{});redisRuntime.sessions.set('live-fixture/isolated/redis',{workspaceOptions:{socket:{host:'127.0.0.1',port:localRedis},database:3},workspaceReaders:new Set()});
  redisEditor=new DesktopRedisEditor(redisRuntime,audit);
  const open=(mode,key)=>redisEditor.open('live',redisPlugin,{mode,key,patternId:'fixture'});
  const save=async(session,value,expiry={mode:'keep'},format='text')=>{const plan=redisEditor.prepare('live',redisPlugin,{editId:session.editId,value,format,expiry});return redisEditor.commit('live',redisPlugin,{editId:session.editId,planId:plan.planId});};
  assert.equal((await save(await open('create','fixture:json'),'{"id":9007199254740993}',{mode:'relative',milliseconds:60000},'json')).status,'success');
  const before=await redisAdmin.pTTL('fixture:json');await pause(30);
  assert.equal((await save(await open('update','fixture:json'),'changed')).status,'success');assert.ok(await redisAdmin.pTTL('fixture:json')<=before);
  await assert.rejects(open('create','fixture:json'),{code:'REDIS_KEY_EXISTS'});
  const collision=await open('update','fixture:json');await redisAdmin.set('fixture:json','external');assert.equal((await save(collision,'overwrite')).error.code,'REDIS_EDIT_CONFLICT');
  await redisAdmin.set('fixture:expires','short',{PX:100});const expires=await open('update','fixture:expires');await pause(150);assert.equal((await save(expires,'late')).error.code,'REDIS_EDIT_CONFLICT');
  await redisAdmin.hSet('fixture:hash','field','value');await redisAdmin.rPush('fixture:list','value');await redisAdmin.sAdd('fixture:set','value');await redisAdmin.zAdd('fixture:zset',{score:1,value:'member'});
  for(const key of ['fixture:json','fixture:hash','fixture:list','fixture:set','fixture:zset']){const session=await open('delete',key),plan=redisEditor.prepare('live',redisPlugin,{editId:session.editId});assert.equal((await redisEditor.commit('live',redisPlugin,{editId:session.editId,planId:plan.planId})).status,'success');assert.equal(await redisAdmin.exists(key),0);}
  process.stdout.write('Redis：新增防覆盖、JSON 原文、TTL 保留、并发/过期冲突和五种类型单 Key 删除通过。\n');
}finally{
  mysqlEditor?.closeOwner('live');redisEditor?.dispose();
  if(redisAdmin){try{await redisAdmin.sendCommand(['SHUTDOWN','NOSAVE']);}catch{}try{redisAdmin.destroy();}catch{}}
  redisStream?.signal('TERM');redisStream?.close();
  for(const connection of connections)connection.destroy();
  if(created){await execute('docker rm -f '+container).catch(()=>{process.stderr.write('隔离 MySQL 容器清理失败，请检查测试容器。\n');process.exitCode=1;});}
  for(const socket of sockets)socket.destroy();for(const server of servers)await new Promise(resolve=>server.close(resolve));ssh.end();
}
