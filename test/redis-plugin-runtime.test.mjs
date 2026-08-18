import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisPluginRuntime } from '../src/redis-plugin-runtime.mjs';

function plugin() {
  return {
    projectId:'p1', environmentId:'e1', pluginInstanceId:'redis', pluginType:'redis', displayName:'Legacy Redis',
    configState:'ready', revision:1,
    target:{host:'redis.example',port:6379,db:11,addressFamily:'ipv4Only'},
    auth:{username:''}, transport:{kind:'direct'}, tls:{mode:'disabled'},
    patterns:[{patternId:'all',pattern:'*'}], limits:{timeoutMs:5000,maxKeys:100,maxValueBytes:65536},
  };
}

test('Redis connects with RESP2 and leaves reconnect ownership to the environment manager', async () => {
  let options;
  const client={
    isOpen:true,
    on:()=>{},
    connect:async()=>{},
    ping:async()=>'PONG',
    quit:async()=>{},
  };
  const routeManager={
    createRelay:async()=>({host:'127.0.0.1',port:49152,generation:1}),
    closeRelay:async()=>{},
  };
  const credentialVault={load:async()=>({password:'secret'})};
  const runtime=new RedisPluginRuntime(routeManager,credentialVault,{factory:(value)=>{ options=value; return client; }});

  const result=await runtime.connect(plugin());
  assert.equal(result.connected,true);
  assert.equal(options.RESP,2,'legacy Redis must not receive a HELLO handshake');
  assert.equal(options.maintNotifications,'disabled');
  assert.equal(options.socket.reconnectStrategy,false,'driver retries would hide the real connection error');
  assert.equal(options.password,'secret');
  assert.equal(options.database,11);
});
