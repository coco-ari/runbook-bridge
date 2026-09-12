import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';

const scope = {projectId:'project',environmentId:'environment'};
const ok = data => ({ok:true,data});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}
function runtime(sequence,phase = 'connected',extra = {}) {
  return {...scope,sequence,phase,plugins:{server:{phase}},...extra};
}
function challengeAction(planId,operationId = 'operation-server') {
  return {
    code:'SSH_HOST_KEY_CONFIRM_REQUIRED',rootPluginInstanceId:'server',affectedPluginInstanceIds:['server'],
    details:{hostKeyChallenge:{
      challengeId:'challenge',planId,operationId,expectedRevision:1,pluginInstanceId:'server',
      host:'server.invalid',port:22,fingerprint:'SHA256:fixture',algorithm:'ssh-ed25519',
    }},
  };
}
function result(payload,snapshot,actions = []) {
  return {outcome:'started',planId:payload.planId ?? null,operationId:null,snapshot,actions};
}

// Run the production hook with a deterministic hook lifecycle. The harness
// supplies only React scheduling primitives; all connection decisions and
// async callbacks are executed from the actual TypeScript source.
async function harness(options = {}) {
  const model = await import(pathToFileURL(path.resolve('renderer/v2/src/features/connections/connection-model.ts')).href);
  const source = stripTypeScriptTypes(await fs.readFile('renderer/v2/src/features/connections/use-connection-intent.ts','utf8'))
    .replace(/^import[\s\S]*?from "[^"]+"\s*$/gmu,'')
    .replace(/^export /gmu,'');
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let current;
  let props = {api:{},...scope,pluginInstanceId:'server',source:'test',runtime:runtime(1,'disconnected'),...options};
  const same = (left,right) => left && right && left.length === right.length && left.every((value,index) => Object.is(value,right[index]));
  const hook = runInNewContext(`${source}\nuseConnectionIntentController`,{
    ...model,
    useState(initial) {
      const index = cursor++;
      const slot = slots[index] ??= {value:typeof initial === 'function' ? initial() : initial};
      return [slot.value,next => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value,slot.value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef(initial) { return slots[cursor++] ??= {current:initial}; },
    useCallback(callback,deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps,deps)) slots[index] = {callback,deps};
      return slots[index].callback;
    },
    useEffect(callback,deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps,deps)) {
        const previous = slots[index];
        const slot = slots[index] = {deps};
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = callback(); });
      }
    },
  });
  const flush = () => {
    for (let count = 0; dirty || effects.length; count += 1) {
      assert.ok(count < 30,'hook render loop must settle');
      dirty = false;
      cursor = 0;
      current = hook(props);
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    }
    return current;
  };
  flush();
  return {
    get current() { return flush(); },
    update(patch) { props = {...props,...patch}; dirty = true; return flush(); },
    flush,
  };
}

test('connection hook rejects older runtime props and delayed refresh snapshots',async () => {
  const read = deferred();
  const published = [];
  const h = await harness({api:{environmentStatus:() => read.promise},runtime:runtime(10),onRuntime:value => published.push(value)});
  h.update({runtime:runtime(8,'connecting')});
  assert.equal(h.current.state.runtime.sequence,10);
  const pending = h.current.refresh();
  h.update({runtime:runtime(12)});
  read.resolve(ok(runtime(9,'connecting')));
  await pending;
  assert.equal(h.current.state.runtime.sequence,12);
  assert.equal(h.current.state.phase,'connected');
  assert.deepEqual(published,[],'late snapshots cannot be rebroadcast to the workspace');
});

test('connection hook ignores refresh failures superseded by pushed state or another refresh',async () => {
  const reads = [deferred(),deferred(),deferred()];
  let index = 0;
  const h = await harness({api:{environmentStatus:() => reads[index++].promise},runtime:runtime(10)});
  const first = h.current.refresh();
  h.update({runtime:runtime(11)});
  reads[0].resolve({ok:false,error:{code:'CONNECTION_FAILED',message:'old status read failed'}});
  await first;
  assert.equal(h.current.state.phase,'connected');
  assert.equal(h.current.state.error,null);
  const second = h.current.refresh();
  const third = h.current.refresh();
  reads[2].resolve(ok(runtime(12)));
  await third;
  reads[1].resolve({ok:false,error:{code:'CONNECTION_FAILED',message:'superseded read failed'}});
  await second;
  assert.equal(h.current.state.runtime.sequence,12);
  assert.equal(h.current.state.error,null);
});

test('late connection completion ends its operation without regressing runtime or reopening an old host-key challenge',async () => {
  const request = deferred();
  let payload;
  const published = [];
  const h = await harness({api:{requestConnectionIntent:value => { payload = value; return request.promise; }},onRuntime:value => published.push(value)});
  const pending = h.current.connect();
  h.update({runtime:runtime(6)});
  request.resolve(ok(result(payload,runtime(4,'failed'),[challengeAction(payload.planId)])));
  await pending;
  assert.equal(h.current.state.runtime.sequence,6);
  assert.equal(h.current.state.phase,'connected');
  assert.equal(h.current.state.operation,null);
  assert.equal(h.current.state.challenge,null);
  assert.equal(h.current.state.actions.length,0);
  assert.deepEqual(published,[]);
});

test('late host-key confirmation cannot replace a newer connection snapshot',async () => {
  const trust = deferred();
  let planId;
  const h = await harness({api:{
    requestConnectionIntent:async payload => {
      planId = payload.planId;
      return ok(result(payload,runtime(2,'failed'),[challengeAction(planId)]));
    },
    confirmConnectionChallenge:() => trust.promise,
  }});
  await h.current.connect();
  assert.equal(h.current.state.challenge?.challengeId,'challenge');
  const pending = h.current.trustHostKey();
  h.update({runtime:runtime(8)});
  trust.resolve(ok({connectionPlan:{...result({planId},runtime(5,'connecting')),operationId:'resumed-operation'}}));
  await pending;
  assert.equal(h.current.state.runtime.sequence,8);
  assert.equal(h.current.state.phase,'connected');
  assert.equal(h.current.state.challenge,null);
});

test('cancelling a connection still fences its late completion and preserves exact plan ownership',async () => {
  const request = deferred();
  let connectPayload;
  const payloads = [];
  const h = await harness({api:{requestConnectionIntent:payload => {
    payloads.push(payload);
    if (payload.intent === 'connect') { connectPayload = payload; return request.promise; }
    return Promise.resolve(ok(result(payload,runtime(3,'disconnected'))));
  }}});
  const connect = h.current.connect();
  await h.current.cancel();
  request.resolve(ok(result(connectPayload,runtime(9))));
  await connect;
  assert.equal(h.current.state.phase,'disconnected');
  assert.equal(h.current.state.runtime.sequence,3);
  assert.equal(payloads[1].planId,payloads[0].planId);
  assert.equal(payloads[1].pluginInstanceId,'server');
  assert.equal(payloads[1].intent,'cancel');
});

test('scope switches fence delayed reads and connection operations',async () => {
  const read = deferred();
  const request = deferred();
  let payload;
  const published = [];
  const h = await harness({api:{environmentStatus:() => read.promise,requestConnectionIntent:value => { payload = value; return request.promise; }},onRuntime:value => published.push(value)});
  const refresh = h.current.refresh();
  const connect = h.current.connect();
  h.update({environmentId:'next-environment',runtime:runtime(1,'disconnected',{environmentId:'next-environment'})});
  read.resolve(ok(runtime(100)));
  request.resolve(ok(result(payload,runtime(101))));
  await Promise.all([refresh,connect]);
  assert.equal(h.current.state.runtime.environmentId,'next-environment');
  assert.equal(h.current.state.phase,'disconnected');
  assert.deepEqual(published,[]);
});

test('被动 MySQL 断线显示公共错误，恢复和重连状态清除旧提示',async () => {
  const error = {code:'ROUTE_UNAVAILABLE',message:'MySQL 连接已经中断，将按环境连接策略重试。'};
  const failed = sequence => runtime(sequence,'failed',{plugins:{mysql:{
    pluginInstanceId:'mysql',phase:'error',error:{...error,details:{diagnostic:'不应进入提示'},stack:'不应展示的错误堆栈'},
    stack:'驱动诊断堆栈',
  }}});
  const h = await harness({pluginInstanceId:'mysql',runtime:failed(2)});
  assert.deepEqual(h.current.state.error,error);
  assert.equal(h.current.state.phase,'error');
  h.update({runtime:runtime(3,'reconnecting',{plugins:{mysql:{phase:'reconnecting',error}}})});
  assert.equal(h.current.state.phase,'connecting');
  assert.equal(h.current.state.error,null);
  h.update({runtime:failed(4)});
  assert.deepEqual(h.current.state.error,error);
  h.update({runtime:runtime(5,'connected',{plugins:{mysql:{phase:'connected',error}}})});
  assert.equal(h.current.state.error,null);
  h.update({runtime:failed(4)});
  assert.equal(h.current.state.phase,'connected');
  assert.equal(h.current.state.error,null,'过期的断线通知不能覆盖已经恢复的连接');
});

test('手动重试期间不显示旧断线提示，重试失败后显示最新公共错误',async () => {
  const error = {code:'ROUTE_UNAVAILABLE',message:'MySQL 连接已经中断，将按环境连接策略重试。'};
  const failed = sequence => runtime(sequence,'failed',{plugins:{mysql:{phase:'error',error}}});
  const request = deferred();
  let payload;
  const h = await harness({pluginInstanceId:'mysql',runtime:failed(2),api:{
    requestConnectionIntent:value => { payload = value; return request.promise; },
  }});
  const retry = h.current.retry();
  h.update({runtime:failed(3)});
  assert.equal(h.current.state.phase,'connecting');
  assert.equal(h.current.state.error,null);
  assert.equal(h.current.state.operation.intent,'retry');
  request.resolve(ok(result(payload,failed(4))));
  await retry;
  assert.equal(h.current.state.operation,null);
  assert.equal(h.current.state.phase,'error');
  assert.deepEqual(h.current.state.error,error);
});

test('状态刷新保留当前插件公共错误且拒绝其它范围或无效错误',async () => {
  const error = {code:'DATABASE_QUERY_TIMEOUT',message:'MySQL 操作超时，当前连接已关闭。'};
  let snapshot = runtime(3,'failed',{plugins:{mysql:{phase:'error',error}}});
  const h = await harness({pluginInstanceId:'mysql',api:{environmentStatus:async () => ok(snapshot)}});
  await h.current.refresh();
  assert.deepEqual(h.current.state.error,error);
  snapshot = runtime(4,'failed',{plugins:{mysql:{pluginInstanceId:'another-plugin',phase:'error',error}}});
  await h.current.refresh();
  assert.equal(h.current.state.error,null);
  h.update({runtime:runtime(5,'failed',{plugins:{mysql:{environmentId:'another-environment',phase:'error',error}}})});
  assert.equal(h.current.state.error,null);
  h.update({runtime:runtime(6,'failed',{plugins:{mysql:{phase:'error',error:{code:'ROUTE_UNAVAILABLE',details:{message:'原始诊断'}}}}})});
  assert.equal(h.current.state.error,null,'无公共 message 时不能从诊断详情拼接提示');
  h.update({pluginInstanceId:undefined,runtime:runtime(7,'failed',{plugins:{mysql:{phase:'error',error}}})});
  assert.equal(h.current.state.error,null,'环境面板不能借用任意插件的错误作为环境错误');
});
