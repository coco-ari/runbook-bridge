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

test('Redis TLS and Logical DB failures never retry with plaintext or DB 0', async () => {
  for (const scenario of [
    {
      error:Object.assign(new Error('certificate expired'),{code:'CERT_HAS_EXPIRED'}),
      expectedCode:'TLS_CERTIFICATE_INVALID',
    },
    {
      error:Object.assign(new Error('wrong version number'),{code:'ERR_SSL_WRONG_VERSION_NUMBER'}),
      expectedCode:'TLS_NOT_SUPPORTED',
    },
    {
      error:new Error('ERR select is not allowed'),
      expectedCode:'PLUGIN_UNAVAILABLE',
    },
  ]) {
    const attempts = [];
    const routeManager = {
      createRelay:async () => ({host:'127.0.0.1',port:49153,generation:2}),
      closeRelay:async () => undefined,
    };
    const runtime = new RedisPluginRuntime(routeManager,{load:async()=>({password:'secret'})},{
      factory:(options) => {
        attempts.push(options);
        return {
          on:()=>{},
          connect:async () => { throw scenario.error; },
          disconnect:async () => undefined,
          destroy:()=>undefined,
        };
      },
    });
    const value = plugin();
    value.tls = {mode:'required'};

    await assert.rejects(
      () => runtime.connect(value),
      (error) => error.code === scenario.expectedCode,
    );
    assert.equal(attempts.length,1);
    assert.equal(attempts[0].database,11);
    assert.equal(attempts[0].socket.tls,true);
  }
});
