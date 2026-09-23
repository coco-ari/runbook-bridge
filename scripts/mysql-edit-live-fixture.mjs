import { Client } from 'ssh2';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

export async function createMysqlEditLiveFixture() {
  const host=process.env.RUNBOOK_MYSQL_TEST_HOST,sshPassword=process.env.RUNBOOK_MYSQL_TEST_SSH_PASSWORD;
  if(!host||!sshPassword)throw new Error('必须显式配置已授权测试服务器');
  const known=spawnSync('ssh-keygen',['-F',host,'-f',path.join(os.homedir(),'.ssh','known_hosts')],{encoding:'utf8',windowsHide:true});
  if(known.status!==0)throw new Error('测试主机必须已有可信 SSH 主机密钥');
  const accepted=known.stdout.split(/\r?\n/u).filter(line=>line&&!line.startsWith('#')).map(line=>line.trim().split(/\s+/u)[2]);
  const fixture=JSON.parse(await fs.readFile(process.env.RUNBOOK_MYSQL_FIXTURE_CONFIG??path.join(os.tmpdir(),'runbook-mysql-edit-fixture.json'),'utf8'));
  const decrypted=spawnSync('pwsh',['-NoProfile','-Command','$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}'],{input:fixture.password,encoding:'utf8',windowsHide:true});
  if(decrypted.status!==0)throw new Error('无法读取加密的测试实例凭据');
  const client=new Client(),sockets=new Set(),connections=new Set();
  await new Promise((resolve,reject)=>{
    client.once('ready',resolve);client.once('error',reject);
    client.connect({host,username:process.env.RUNBOOK_MYSQL_TEST_SSH_USER??'root',password:sshPassword,readyTimeout:15000,hostVerifier:key=>accepted.includes(key.toString('base64'))});
  });
  client.on('error',()=>{});
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    client.forwardOut('127.0.0.1',0,'127.0.0.1',fixture.port,(error,stream)=>{
      if(error){socket.destroy();return;}
      stream.on('error',()=>socket.destroy());socket.once('close',()=>stream.destroy());
      socket.pipe(stream).pipe(socket);
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const database='runbook_edit_test_'+crypto.randomBytes(6).toString('hex');
  const options={host:'127.0.0.1',port:server.address().port,user:'root',password:decrypted.stdout,supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false,connectTimeout:10000};
  const connect=async(withDatabase=true)=>{
    const connection=await mysql.createConnection({...options,...(withDatabase?{database}:{})});
    connection.on('error',()=>{});connections.add(connection);return connection;
  };
  let admin;
  try {
    admin=await connect(false);
    await admin.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await admin.query('USE '+database);
  } catch(error) {for(const connection of connections)connection.destroy();for(const socket of sockets)socket.destroy();server.close();client.end();throw error;}
  const close=async()=>{
    try {
      if(!/^runbook_edit_test_[a-f0-9]{12}$/u.test(database))throw new Error('测试库名称校验失败');
      const cleanup=await connect(false);await cleanup.query('DROP DATABASE '+database);
    }finally{
      for(const connection of connections)connection.destroy();
      for(const socket of sockets)socket.destroy();
      await new Promise(resolve=>server.close(resolve));client.end();
    }
  };
  return {admin,connect,close,database,options:{...options,database}};
}
