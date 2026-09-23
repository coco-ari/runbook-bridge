import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { setTimeout as delay } from 'node:timers/promises';
import { cpuPercent, metricsCommand, parseDiskMetrics, parseSystemMetrics, readMetricsChannel } from '../src/server-metrics-reader.mjs';
import { ServerWorkspaceMetrics } from '../src/server-workspace-metrics.mjs';
import { ServerWorkspaceManager } from '../src/server-workspace-manager.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

const scope = {projectId:'p',environmentId:'e',pluginInstanceId:'s'};
const system = (later = false) => '__RB_OS__\nLinux\n__RB_CPU__\ncpu ' + (later ? '130 0 60 850 60 0 0 0 40 0' : '100 0 50 800 50 0 0 0 20 0') + '\n__RB_CORES__\n4\n__RB_MEMORY__\nMemTotal: 8000000 kB\nMemAvailable: 3000000 kB\n';
const disks = 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 600 350 64% /\ntmpfs 1000 0 1000 0% /run\n/dev/vdb1 10000 3000 6500 32% /data with space\n';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('CPU 差值排除重复 guest 计数，计数回退和首次采样不显示假百分比', () => {
  const first = parseSystemMetrics(system()), second = parseSystemMetrics(system(true));
  assert.equal(first.cpu.total, 1000);
  assert.equal(first.cpu.cores, 4);
  assert.equal(cpuPercent(first.cpu, second.cpu), 40);
  assert.equal(cpuPercent(null, second.cpu), null);
  assert.equal(cpuPercent(second.cpu, first.cpu), null);
  assert.equal(cpuPercent(first.cpu, first.cpu), null);
  assert.equal(first.memory.percent, 62.5);
  assert.equal(first.memory.used, 5000000 * 1024);
  assert.equal(parseSystemMetrics(system().replace('MemAvailable:', 'Cached:')).memory, null);
  assert.deepEqual(parseSystemMetrics('__RB_OS__\nDarwin\n'), {unsupported:true});
  assert.throws(() => parseSystemMetrics('untrusted output'), {code:'METRICS_INVALID'});
});

test('磁盘解析保留根分区与空格挂载点，过滤临时文件系统并限制列表长度', () => {
  const data = parseDiskMetrics(disks);
  assert.deepEqual(data.items.map(item => item.mount), ['/', '/data with space']);
  assert.equal(data.items[0].total, 1024000);
  assert.equal(data.items[0].percent, 64);
  const many = disks + Array.from({length:70}, (_,i) => '/dev/d' + i + ' 100 50 40 56% /disk-' + i).join('\n');
  const bounded = parseDiskMetrics(many);
  assert.equal(bounded.items.length, 64);
  assert.equal(bounded.items[0].mount, '/');
  assert.equal(bounded.truncated, true);
  assert.throws(() => parseDiskMetrics('Filesystem unavailable'), {code:'METRICS_INVALID'});
});

function channel() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = 0;
  stream.close = () => { stream.closed += 1; stream.emit('close'); };
  stream.destroy = () => {};
  return stream;
}
test('采集超时覆盖打开通道阶段，迟到通道被关闭且不影响共享连接', async () => {
  const client = new EventEmitter();
  let callback;
  client.exec = (_command, options, done) => { assert.equal(options.pty,false); callback = done; };
  const pending = readMetricsChannel(client, 'system', {timeoutMs:10});
  await Promise.all([assert.rejects(pending, {code:'METRICS_TIMEOUT'}), delay(20)]);
  const late = channel();
  callback(null,late);
  assert.equal(late.closed,1);
  assert.equal(client.listenerCount('close'),0);
  assert.equal(client.listenerCount('error'),0);
});

test('采集支持取消、限制标准输出与错误总量，并清理连接监听', async () => {
  for (const scenario of ['abort','output','stderr','error','disconnect','success']) {
    const client = new EventEmitter(), stream = channel(), controller = new AbortController();
    client.exec = (_command, _options, done) => done(null,stream);
    const pending = readMetricsChannel(client,'system',{signal:controller.signal,maxBytes:16});
    if (scenario === 'success') {
      stream.emit('data',Buffer.from('Linux'));
      stream.emit('exit',0);
      stream.emit('close');
      assert.deepEqual(await pending,{stdout:'Linux',exitCode:0});
    } else {
      const failed = assert.rejects(pending,error => {
        assert.ok(!error.message.includes('secret-fixture'));
        return error.code === (scenario === 'abort' ? 'METRICS_CANCELLED' : scenario === 'disconnect' ? 'SSH_NOT_CONNECTED' : ['output','stderr'].includes(scenario) ? 'METRICS_OUTPUT_LIMIT' : 'METRICS_UNAVAILABLE');
      });
      if (scenario === 'abort') controller.abort();
      if (scenario === 'output') stream.emit('data',Buffer.alloc(17));
      if (scenario === 'stderr') { stream.emit('data',Buffer.alloc(8)); stream.stderr.emit('data',Buffer.alloc(9)); }
      if (scenario === 'error') stream.emit('error',new Error('secret-fixture'));
      if (scenario === 'disconnect') client.emit('close');
      await failed;
      assert.equal(stream.closed,1);
    }
    assert.equal(client.listenerCount('close'),0);
    assert.equal(client.listenerCount('error'),0);
  }
});

// ssh2 的 close 事件可能等待未消费流的 end，协议释放需核对通道登记与双向关闭状态。
test('真实本地 SSH 在采样超时或取消后释放迟到通道，共享连接仍可继续读取', { timeout:15000 }, async t => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength:2048,
    privateKeyEncoding:{ type:'pkcs1', format:'pem' },
    publicKeyEncoding:{ type:'spki', format:'pem' },
  }).privateKey;
  const fingerprint = crypto.createHash('sha256').update(ssh2.utils.parseKey(privateKey).getPublicSSH()).digest('hex');
  const connections = new Set();
  let acceptPending, receiveExec, openedStream;
  const server = new ssh2.Server({ hostKeys:[privateKey] }, connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-password') context.accept();
      else context.reject();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('exec', (approve, _reject, info) => {
        assert.equal(info.command, metricsCommand('system'));
        const respond = () => {
          const stream = approve();
          stream.on('error', () => {});
          stream.resume();
          stream.write(system()); stream.stderr.write('fixture-stderr');
          stream.exit(0); stream.end();
          return stream;
        };
        if (receiveExec) {
          const notify = receiveExec; receiveExec = null;
          acceptPending = respond; notify();
        } else respond();
      });
    }));
  });
  const client = new ssh2.Client();
  client.on('error', () => {});
  t.after(async () => {
    client.destroy();
    for (const connection of connections) connection.end();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ready = once(client, 'ready');
  client.connect({ host:'127.0.0.1', port:server.address().port, username:'fixture', password:'fixture-password',
    hostHash:'sha256', hostVerifier:actual => actual === fingerprint });
  await ready; client.setNoDelay(true);
  const originalExec = client.exec;
  client.exec = function(command, options, callback) {
    return originalExec.call(this, command, options, (error, stream) => {
      if (openedStream) { const notify = openedStream; openedStream = null; notify(stream); }
      callback(error, stream);
    });
  };
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await delay(10);
    assert.ok(predicate(), '迟到通道应完成协议关闭并移出连接登记');
  };
  for (const reason of ['timeout', 'cancel']) await t.test(reason, async () => {
    const closeListeners = client.listenerCount('close'), errorListeners = client.listenerCount('error');
    const received = new Promise(resolve => { receiveExec = resolve; });
    const opened = new Promise(resolve => { openedStream = resolve; });
    const controller = new AbortController();
    const pending = readMetricsChannel(client, 'system', { timeoutMs:reason === 'timeout' ? 150 : 5000, signal:controller.signal });
    const rejected = assert.rejects(pending, { code:reason === 'timeout' ? 'METRICS_TIMEOUT' : 'METRICS_CANCELLED' });
    await received;
    if (reason === 'cancel') controller.abort();
    await rejected;
    assert.equal(client.listenerCount('close'), closeListeners);
    assert.equal(client.listenerCount('error'), errorListeners);
    const remote = acceptPending();
    const late = await opened;
    assert.ok(late);
    await waitFor(() => late.incoming.state === 'closed' && late.outgoing.state === 'closed'
      && client._chanMgr.get(late.incoming.id) === undefined
      && remote.incoming.state === 'closed' && remote.outgoing.state === 'closed');
    const recovered = await readMetricsChannel(client, 'system', { timeoutMs:3000 });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.stdout, system());
    assert.equal(client.listenerCount('close'), closeListeners);
    assert.equal(client.listenerCount('error'), errorListeners);
  });
});

function harness(t) {
  let now = 100000;
  const plugin = {...scope,pluginType:'server',revision:1};
  const state = {generation:1,connected:true,systemFailure:false,diskFailure:false,later:false};
  const runtime = new EventEmitter(), audits = [], reads = [];
  runtime.status = () => ({generation:state.generation,connected:state.connected});
  runtime.readWorkspaceMetrics = async (_plugin,kind) => {
    reads.push(kind);
    if (kind === 'system' && state.systemFailure || kind === 'disks' && state.diskFailure) throw Object.assign(new Error('raw-secret-fixture'),{code:'METRICS_TIMEOUT'});
    return {stdout:kind === 'system' ? system(state.later) : disks,exitCode:0};
  };
  const store = {getPlugin:async()=>plugin,appendAudit:async(_id,entry)=>audits.push(entry)};
  const manager = new ServerWorkspaceMetrics({workspaceStore:store,serverRuntime:runtime,requirePlugin:async()=>{if(!state.connected) throw Object.assign(new Error(),{code:'SSH_NOT_CONNECTED'});return plugin;},now:()=>now});
  t.after(()=>manager.dispose());
  return {manager,plugin,state,runtime,store,audits,reads,advance:ms=>{now+=ms;}};
}

test('首次一秒补采，提前请求只等待剩余时间，多窗口按指标合并采样', async t => {
  const h = harness(t);
  const [a,b,disk] = await Promise.all([
    h.manager.read('one',scope), h.manager.read('two',scope),
    h.manager.read('one',scope,'disks'), h.manager.read('two',scope,'disks'),
  ]);
  assert.deepEqual(a,b);
  assert.equal(a.cpu.percent,null);
  assert.equal(a.retryAfterMs,1000);
  assert.equal(disk.retryAfterMs,30000);
  assert.deepEqual(h.reads,['system','disks']);
  h.advance(950);
  const early = await h.manager.read('one',scope);
  assert.equal(early.retryAfterMs,50);
  assert.equal(h.reads.length,2);
  h.advance(early.retryAfterMs);h.state.later=true;
  const next = await h.manager.read('one',scope);
  assert.equal(next.cpu.percent,40);
  assert.equal(next.retryAfterMs,5000);
  h.advance(4999);
  assert.equal((await h.manager.read('one',scope)).retryAfterMs,1);
  assert.deepEqual(h.reads,['system','disks','system']);
  h.advance(1);await h.manager.read('one',scope);
  assert.equal((await h.manager.read('one',scope,'disks')).retryAfterMs,24000);
  h.advance(24000);await h.manager.read('one',scope,'disks');
  assert.deepEqual(h.reads,['system','disks','system','system','disks']);
  h.manager.stop('one',scope);
  assert.equal(h.manager.records.size,1);
  h.manager.stop('two',scope);
  assert.equal(h.manager.records.size,0);
  assert.equal(h.audits.filter(item=>item.type==='server-metrics-start').length,1);
  assert.equal(h.audits.filter(item=>item.type==='server-metrics-stop').length,1);
  assert.ok(!JSON.stringify(h.audits).includes('MemTotal'));
});

test('磁盘失败保留旧值，系统恢复和重连后使用一秒补采重建 CPU 基线', async t => {
  const h = harness(t);
  await h.manager.read('one',scope);
  await h.manager.read('one',scope,'disks');
  h.advance(30000);h.state.diskFailure=true;h.state.later=true;
  const disk = await h.manager.read('one',scope,'disks');
  assert.equal(disk.diskError,'METRICS_TIMEOUT');
  assert.equal(disk.disks.length,2);
  const partial = await h.manager.read('one',scope);
  assert.equal(partial.memory.percent,62.5);
  assert.equal(partial.cpu.percent,null);
  assert.equal(partial.retryAfterMs,1000);
  h.advance(1000);h.state.systemFailure=true;
  const failed = await h.manager.read('one',scope);
  assert.equal(failed.error,'METRICS_TIMEOUT');
  assert.equal(failed.sampledAt,partial.sampledAt);
  assert.equal(failed.retryAfterMs,5000);
  assert.ok(!JSON.stringify(failed).includes('raw-secret-fixture'));
  h.advance(5000);h.state.systemFailure=false;
  const recovered = await h.manager.read('one',scope);
  assert.equal(recovered.cpu.percent,null);
  assert.equal(recovered.retryAfterMs,1000);
  h.state.generation++;
  await assert.rejects(h.manager.read('one',scope),{code:'METRICS_CANCELLED'});
  const reconnected = await h.manager.read('one',scope);
  assert.equal(reconnected.cpu.percent,null);
  assert.equal(reconnected.retryAfterMs,1000);
  assert.equal(reconnected.disks.length,0);
});

test('慢磁盘不阻塞首次内存和一秒 CPU 补采，迟到磁盘不覆盖系统新值', async t => {
  const h = harness(t), original = h.runtime.readWorkspaceMetrics;
  let finishDisk, settled = false;
  h.runtime.readWorkspaceMetrics = (plugin,kind,options) => kind === 'disks'
    ? new Promise(resolve=>{finishDisk=resolve;}) : original(plugin,kind,options);
  const disk = h.manager.read('one',scope,'disks').then(result=>{settled=true;return result;});
  const first = await h.manager.read('one',scope);
  assert.equal(first.memory.percent,62.5);
  assert.equal(first.cpu.percent,null);
  assert.equal(settled,false);
  h.advance(1000);h.state.later=true;
  const second = await h.manager.read('one',scope);
  assert.equal(second.cpu.percent,40);
  assert.equal(settled,false);
  finishDisk({stdout:disks,exitCode:0});
  const completedDisk = await disk;
  assert.equal(completedDisk.cpu.percent,40);
  assert.equal(completedDisk.disks.length,2);
  assert.equal(h.reads.length,2);
});

test('慢系统采样不阻塞磁盘，停止后两个通道的迟到结果均被丢弃', async t => {
  const h = harness(t), original = h.runtime.readWorkspaceMetrics;
  let finishSystem, systemSignal;
  h.runtime.readWorkspaceMetrics = (plugin,kind,options) => kind === 'system'
    ? new Promise(resolve=>{finishSystem=resolve;systemSignal=options.signal;}) : original(plugin,kind,options);
  const pending = h.manager.read('one',scope);
  const disk = await h.manager.read('one',scope,'disks');
  assert.equal(disk.disks.length,2);
  assert.equal(disk.cpu,null);
  const rejected = assert.rejects(pending,{code:'METRICS_CANCELLED'});
  h.manager.stop('one',scope);
  assert.equal(systemSignal.aborted,true);
  finishSystem({stdout:system(),exitCode:0});
  await rejected;
  assert.equal(h.manager.records.size,0);
});

test('隐藏窗口、关闭作用域和退出应用取消在途采样，迟到数据不进入新一代', async t => {
  for (const cancel of ['stop','owner','scope','dispose']) {
    const h = harness(t);
    let complete, signal;
    h.runtime.readWorkspaceMetrics = async (_plugin,_kind,options) => {signal=options.signal;return new Promise(resolve=>{complete=resolve;});};
    const pending = h.manager.read('one',scope);
    await flush();
    const rejected = assert.rejects(pending,{code:'METRICS_CANCELLED'});
    if(cancel==='stop')h.manager.stop('one',scope);
    if(cancel==='owner')h.manager.closeOwner('one');
    if(cancel==='scope')h.manager.closeScope({projectId:'p'});
    if(cancel==='dispose')h.manager.dispose();
    assert.equal(signal.aborted,true);
    complete({stdout:system(),exitCode:0});
    await rejected;
    assert.equal(h.manager.records.size,0);
  }
});

test('读取尚未完成作用域验证时停止，也不会迟到启动采集', async t => {
  const h = harness(t);
  let release;
  h.manager.requirePlugin = () => new Promise(resolve=>{release=resolve;});
  const pending = h.manager.read('one',scope);
  h.manager.stop('one',scope);
  const rejected=assert.rejects(pending,{code:'METRICS_CANCELLED'});
  release(h.plugin);
  await rejected;
  assert.equal(h.reads.length,0);
});

test('不支持的系统只检测一次，命令策略禁止时拒绝执行且不改变 MCP 上下文', async t => {
  const h = harness(t);
  h.runtime.readWorkspaceMetrics=async()=>{h.reads.push('system');return{stdout:'__RB_OS__\nDarwin\n',exitCode:1};};
  assert.equal((await h.manager.read('one',scope)).unsupported,true);
  h.advance(30000);await h.manager.read('one',scope);
  assert.equal(h.reads.length,1);
  const broker = Object.create(SshBroker.prototype), client = new EventEmitter();
  let calls=0;
  client.exec=()=>{calls++;};
  broker.sessions=new Map([['p',{client}]]);
  broker.store={get:async()=>({commandPolicy:{enabled:true,customDeny:['df']}})};
  await assert.rejects(broker.readWorkspaceMetrics('p','disks'),{code:'COMMAND_BLOCKED'});
  await assert.rejects(broker.readWorkspaceMetrics('p','arbitrary'),{code:'INVALID_ARGUMENT'});
  assert.equal(calls,0);
  assert.equal(metricsCommand('disks'),'LC_ALL=C df -P -k -l');
});

test('桌面监控沿用服务器类型、连接和窗口校验，IPC 不接收命令或路径', async t => {
  const runtime = new EventEmitter(), plugin={...scope,pluginType:'mysql'};
  runtime.status=()=>({connected:true,generation:1});
  const store={getPlugin:async()=>plugin,appendAudit:async()=>{}};
  const manager=new ServerWorkspaceManager({workspaceStore:store,serverRuntime:runtime});
  t.after(()=>manager.dispose());
  await assert.rejects(manager.readMetrics('renderer:1',scope),{code:'PLUGIN_TYPE_MISMATCH'});
  const handlers=new Map(),sender=new EventEmitter();
  sender.id=1;sender.mainFrame={};sender.isDestroyed=()=>false;
  registerServerWorkspaceIpc({handle:(name,handler)=>handlers.set(name,handler)},{serverWorkspaceManager:manager,isWorkspaceRenderer:value=>value===sender});
  const event={sender,senderFrame:sender.mainFrame};
  const read=handlers.get('v2:server-workspace-metrics');
  assert.equal((await read(event,{...scope,command:'arbitrary'})).error.code,'INVALID_ARGUMENT');
  assert.equal((await read(event,{...scope,path:'/arbitrary'})).error.code,'INVALID_ARGUMENT');
  for (const kind of ['arbitrary', ['system'], null, 1]) assert.equal((await read(event,{...scope,kind})).error.code,'INVALID_ARGUMENT');
  assert.equal((await read({...event,senderFrame:{}},scope)).error.code,'WORKSPACE_ACCESS_DENIED');
  const stop=handlers.get('v2:server-workspace-stop-metrics');
  assert.deepEqual(await stop(event,scope),{ok:true,data:{stopped:true}});
});

test('采集审计失败时不执行远程命令，失败的未启动记录不占用容量', async t => {
  const h = harness(t);
  h.store.appendAudit=async()=>{throw new Error('audit-secret-fixture');};
  await assert.rejects(h.manager.read('one',scope),{code:'METRICS_AUDIT_UNAVAILABLE'});
  assert.equal(h.reads.length,0);
  assert.equal(h.manager.records.size,0);
});

test('不同服务器缓存隔离，配置变更丢弃在途结果', async t => {
  const h = harness(t);
  h.manager.requirePlugin=async input=>({...h.plugin,...input});
  await h.manager.read('one',scope);
  await h.manager.read('one',{...scope,pluginInstanceId:'other'});
  assert.deepEqual(h.reads,['system','system']);
  h.manager.closeScope(scope);
  assert.equal(h.manager.records.size,1);
  let release;
  h.runtime.readWorkspaceMetrics=async()=>new Promise(resolve=>{release=resolve;});
  h.advance(5000);
  const pending=h.manager.read('one',{...scope,pluginInstanceId:'other'});
  await flush();
  h.state.generation++;
  release({stdout:system(true),exitCode:0});
  await assert.rejects(pending,{code:'METRICS_CANCELLED'});
  assert.equal(h.manager.records.size,0);
});

test('原生窗口最小化时，即使页面请求迟到也拒绝新采样', async () => {
  const handlers=new Map(),sender=new EventEmitter(),calls=[];
  sender.id=1;sender.mainFrame={};sender.isDestroyed=()=>false;
  sender.getOwnerBrowserWindow=()=>({isMinimized:()=>true});
  registerServerWorkspaceIpc({handle:(name,handler)=>handlers.set(name,handler)},{
    serverWorkspaceManager:{stopMetrics:()=>calls.push('stop'),readMetrics:()=>calls.push('read')},
    isWorkspaceRenderer:value=>value===sender,
  });
  const result=await handlers.get('v2:server-workspace-metrics')({sender,senderFrame:sender.mainFrame},scope);
  assert.equal(result.error.code,'METRICS_PAUSED');
  assert.deepEqual(calls,['stop']);
});

test('系统和磁盘同时在途时暂停会取消两者，恢复记录不接收旧响应', async t => {
  const h = harness(t), completions = {}, signals = {};
  h.runtime.readWorkspaceMetrics = (_plugin,kind,options) => new Promise(resolve=>{completions[kind]=resolve;signals[kind]=options.signal;});
  const oldSystem=h.manager.read('one',scope), oldDisk=h.manager.read('one',scope,'disks');
  await flush();
  const rejected=Promise.all([assert.rejects(oldSystem,{code:'METRICS_CANCELLED'}),assert.rejects(oldDisk,{code:'METRICS_CANCELLED'})]);
  h.manager.stop('one',scope);
  assert.equal(signals.system.aborted,true);
  assert.equal(signals.disks.aborted,true);
  h.runtime.readWorkspaceMetrics=async()=>({stdout:system(),exitCode:0});
  const fresh=await h.manager.read('one',scope);
  completions.system({stdout:system(true),exitCode:0});
  completions.disks({stdout:disks,exitCode:0});
  await rejected;
  const current=await h.manager.read('one',scope);
  assert.equal(h.manager.records.size,1);
  assert.equal(current.cpu.percent,fresh.cpu.percent);
  assert.equal(current.disks.length,0);
});

test('两类首轮请求共用启动审计，审计尚未完成时暂停不会执行远程采样', async t => {
  const h = harness(t);
  let finishAudit;
  h.store.appendAudit=async(_id,entry)=>{
    h.audits.push(entry);
    if(entry.type==='server-metrics-start') await new Promise(resolve=>{finishAudit=resolve;});
  };
  const systemRead=h.manager.read('one',scope), diskRead=h.manager.read('one',scope,'disks');
  await flush();
  const rejected=Promise.all([assert.rejects(systemRead,{code:'METRICS_CANCELLED'}),assert.rejects(diskRead,{code:'METRICS_CANCELLED'})]);
  h.manager.stop('one',scope);
  finishAudit();
  await rejected;
  assert.equal(h.reads.length,0);
  assert.deepEqual(h.audits.map(item=>item.type),['server-metrics-start','server-metrics-stop']);
});
