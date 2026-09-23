import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerRequest, dockerCommand, normalizeDockerSocket, parseDockerResult, readDockerChannel } from '../src/server-docker-reader.mjs';
import { ServerDockerManager } from '../src/server-docker-manager.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';
import { tools } from '../src/mcp-tool-contract.mjs';
import { capabilityRule } from '../src/operation-gate.mjs';
import { workspaceInternals } from '../src/workspace-store.mjs';

const scope = { projectId:'docker-project', environmentId:'test-env', pluginInstanceId:'server-one' };
const id = 'a'.repeat(64);
const container = number => ({ id:number.toString(16).padStart(64,'0'), name:'fixture-' + number, image:'example.invalid/app:fixture', state:'running', status:'Up 1 minute', ports:'', project:number % 2 ? 'fixture-compose' : '', service:'api' });
const raw = value => ({ stdout:typeof value === 'string' ? value : JSON.stringify(value), stderr:'', exitCode:0, truncated:false });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('固定命令绑定 Unix Socket，只接受完整容器 ID、有界参数与明确时区', () => {
  assert.equal(normalizeDockerSocket(), '/var/run/docker.sock');
  assert.equal(normalizeDockerSocket('/run/user/1000/../1000/docker.sock'), '/run/user/1000/docker.sock');
  for (const socket of ['tcp://example.invalid:2375', 'relative.sock', '/run/a\nb', 0, null]) assert.throws(() => normalizeDockerSocket(socket), {code:'INVALID_ARGUMENT'});
  for (const value of ['web', 'a'.repeat(12), id + ';whoami', '--help']) assert.throws(() => dockerRequest('inspect', {containerId:value}), {code:'INVALID_ARGUMENT'});
  for (const input of [{lines:2001}, {maxBytes:262145}, {maxBytes:0}, {since:'2026-01-01'}, {since:'2026-01-02T00:00:00Z',until:'2026-01-01T00:00:00Z'}, {command:'whoami'}]) {
    assert.throws(() => dockerRequest('logs', {containerId:id, ...input}), {code:'INVALID_ARGUMENT'});
  }
  const args = dockerRequest('logs', {containerId:id,since:'2026-01-01T08:00:00+08:00'});
  assert.equal(args.since, '2026-01-01T00:00:00.000Z');
  const command = dockerCommand('/run/docker.sock', args);
  assert.match(command, /-u DOCKER_CONTEXT/u);
  assert.match(command, /--host 'unix:\/\/\/run\/docker.sock'/u);
  assert.match(command, /logs --timestamps --tail 200/u);
  assert.doesNotMatch(command, /sudo|--follow|--details/u);
  const quoted = dockerCommand("/run/a'b.sock", dockerRequest('list'));
  assert.ok(quoted.includes("'unix:///run/a'\"'\"'b.sock'"));
  // Docker 的 inspect 模板会将缺失的 Health 键视为错误，需通过 index 安全读取。
  const inspect = dockerCommand(undefined, dockerRequest('inspect', {containerId:id}));
  assert.match(inspect, /\{\{with index \.State "Health"\}\}/u);
  assert.throws(() => dockerRequest('exec', {}), {code:'INVALID_ARGUMENT'});
});

test('容器列表保留 Compose 信息并明确标记条目及字节截断', () => {
  const items = Array.from({length:1001}, (_,index) => container(index + 1));
  const result = parseDockerResult(dockerRequest('list'), raw(items.map(item => JSON.stringify(item)).join('\n') + '\n'));
  assert.equal(result.items.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].project, 'fixture-compose');
  const partial = parseDockerResult(dockerRequest('list'), { ...raw(JSON.stringify(items[0]) + '\n{"id":'), truncated:true, exitCode:null });
  assert.equal(partial.items.length, 1);
  assert.equal(partial.truncated, true);
  assert.throws(() => parseDockerResult(dockerRequest('list'), raw('{}')), {code:'DOCKER_INVALID_OUTPUT'});
});

test('稳定错误不带出服务器错误正文，同名容器不会冒充原 ID', () => {
  for (const [stderr, code] of [['No such container: fixture-secret','DOCKER_CONTAINER_NOT_FOUND'], ['permission denied fixture-secret','DOCKER_PERMISSION_DENIED'], ['docker: command not found fixture-secret','DOCKER_NOT_INSTALLED'], ['driver error fixture-secret','DOCKER_UNAVAILABLE']]) {
    assert.throws(() => parseDockerResult(dockerRequest('inspect', {containerId:id}), { ...raw(''), exitCode:1, stderr }), error => error.code === code && !error.message.includes('fixture-secret'));
  }
  assert.throws(() => parseDockerResult(dockerRequest('inspect',{containerId:id}),raw({id:'b'.repeat(64),state:'running'})), {code:'DOCKER_INVALID_OUTPUT'});
  const absent = parseDockerResult(dockerRequest('stats',{containerId:id}),raw(''));
  assert.equal(absent.available,false);
  const stats = parseDockerResult(dockerRequest('stats',{containerId:id}),raw({ID:id,CPUPerc:'5%',MemUsage:'2MiB / 1GiB',MemPerc:'1%',NetIO:'0B / 0B',BlockIO:'0B / 0B',PIDs:'2'}));
  assert.equal(stats.cpu,'5%');
});

function channel() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = 0;
  stream.close = () => { stream.closed++; stream.emit('close'); };
  stream.destroy = () => {};
  return stream;
}

test('取消与超时覆盖建立通道阶段，迟到通道关闭且不关闭共享 SSH', async () => {
  for (const mode of ['cancel','timeout']) {
    const client = new EventEmitter(), controller = new AbortController();
    let callback;
    client.exec = (_command, options, done) => { assert.equal(options.pty,false); callback = done; };
    const pending = readDockerChannel(client, undefined, dockerRequest('list'), {signal:controller.signal,timeoutMs:10});
    const rejected = assert.rejects(pending,{code:mode === 'cancel' ? 'DOCKER_CANCELLED' : 'DOCKER_TIMEOUT'});
    if (mode === 'cancel') controller.abort();
    await Promise.all([rejected,delay(20)]);
    const late = channel();
    callback(null,late);
    assert.equal(late.closed,1);
    assert.equal(client.listenerCount('close'),0);
    assert.equal(client.listenerCount('error'),0);
  }
});

test('日志保留 stdout 和 stderr，超限关闭通道，小上限仍识别权限错误', async () => {
  const client = new EventEmitter(), stream = channel();
  client.exec = (_command,_options,callback) => callback(null,stream);
  const request = dockerRequest('logs',{containerId:id,maxBytes:16});
  const pending = readDockerChannel(client,undefined,request);
  stream.emit('data',Buffer.from('stdout\n'));
  stream.stderr.emit('data',Buffer.from('stderr\n'));
  stream.emit('data',Buffer.alloc(9000,120));
  const result = parseDockerResult(request,await pending);
  assert.equal(Buffer.byteLength(result.content),16);
  assert.ok(result.content.includes('stdout\nstderr\n'));
  assert.equal(result.truncated,true);
  assert.equal(stream.closed,1);
  const errorStream = channel();
  client.exec = (_command,_options,callback) => callback(null,errorStream);
  const tiny = dockerRequest('logs',{containerId:id,maxBytes:1});
  const errorPending = readDockerChannel(client,undefined,tiny);
  errorStream.stderr.emit('data',Buffer.from('permission denied'));
  errorStream.emit('exit',1); errorStream.emit('close');
  const errorRaw = await errorPending;
  assert.throws(() => parseDockerResult(tiny,errorRaw), {code:'DOCKER_PERMISSION_DENIED'});
});

function fixture(t, count = 55) {
  const runtime = new EventEmitter();
  const plugin = { ...scope, pluginType:'server', configState:'ready', revision:1, target:{host:'host.example.invalid',port:22}, auth:{username:'fixture',type:'agent'}, uplink:{type:'direct'} };
  const state = {connected:true,generation:1,reads:0,audits:[]};
  const store = { getPlugin:async () => plugin, appendAudit:async (_project, item) => state.audits.push(item) };
  runtime.status = () => ({connected:state.connected,generation:state.generation});
  runtime.readDocker = async () => { state.reads++; return raw(Array.from({length:count}, (_,i) => JSON.stringify(container(i + 1))).join('\n') + '\n'); };
  const manager = new ServerDockerManager({workspaceStore:store,serverRuntime:runtime});
  t.after(() => manager.dispose());
  return {manager,runtime,plugin,store,state};
}

test('分页快照绑定窗口、作用域、连接代次和 Socket，后续页不会再次访问服务器', async t => {
  const {manager,state,plugin} = fixture(t);
  const first = await manager.read('renderer:1',{...scope,kind:'list'});
  assert.equal(first.items.length,50);
  assert.equal(first.total,55);
  const second = await manager.read('renderer:1',{...scope,kind:'list',cursor:first.nextCursor});
  assert.equal(second.items.length,5);
  assert.equal(second.nextCursor,null);
  assert.equal(state.reads,1);
  await assert.rejects(manager.read('renderer:2',{...scope,kind:'list',cursor:first.nextCursor}),{code:'DOCKER_CURSOR_EXPIRED'});
  await assert.rejects(manager.read('renderer:1',{...scope,environmentId:'other-env',kind:'list',cursor:first.nextCursor}),{code:'DOCKER_CURSOR_EXPIRED'});
  state.generation++;
  await assert.rejects(manager.read('renderer:1',{...scope,kind:'list',cursor:first.nextCursor}),{code:'DOCKER_CURSOR_EXPIRED'});
  state.generation--;
  plugin.target.dockerSocket = '/run/user/1000/docker.sock';
  await assert.rejects(manager.read('renderer:1',{...scope,kind:'list',cursor:first.nextCursor}),{code:'DOCKER_CURSOR_EXPIRED'});
  assert.doesNotMatch(JSON.stringify(state.audits),/example\.invalid\/app|fixture-compose|stdout/u);
});

test('关闭窗口或配置变化时阻止初始化后的迟到读取', async t => {
  for (const reason of ['owner','scope']) {
    const {manager,store,state} = fixture(t);
    let release;
    const original = store.getPlugin;
    store.getPlugin = () => new Promise(resolve => { release = async () => resolve(await original()); });
    const pending = manager.read('renderer:1',{...scope,kind:'list'});
    if (reason === 'owner') manager.closeOwner('renderer:1');
    else manager.closeScope(scope);
    await release();
    await assert.rejects(pending,{code:'DOCKER_CANCELLED'});
    assert.equal(state.reads,0);
  }
});

test('取消仅命中所属窗口与请求，断连和 Socket 变化拒绝迟到结果', async t => {
  for (const reason of ['cancel','socket','lifecycle','generation']) {
    const {manager,runtime,plugin,state} = fixture(t);
    let release, signal;
    runtime.readDocker = async (_plugin,_request,options) => { signal = options.signal; return new Promise(resolve => { release = () => resolve(raw('')); }); };
    const pending = manager.read('renderer:1',{...scope,kind:'list',requestId:'request-one'});
    while (!release) await flush();
    manager.cancel('renderer:2',{...scope,requestId:'request-one'});
    assert.equal(signal.aborted,false);
    if (reason === 'cancel') manager.cancel('renderer:1',{...scope,requestId:'request-one'});
    if (reason === 'socket') plugin.target.dockerSocket = '/run/changed.sock';
    if (reason === 'lifecycle') runtime.emit('lifecycle',{...scope,type:'disconnected'});
    if (reason === 'generation') state.generation++;
    release();
    await assert.rejects(pending,{code:'DOCKER_CANCELLED'});
  }
});

test('Docker 失败不修改 SSH 状态，审计失败时不开始远端读取', async t => {
  const {manager,state,runtime,store} = fixture(t);
  runtime.readDocker = async () => ({...raw(''),exitCode:1,stderr:'Cannot connect to Docker daemon'});
  await assert.rejects(manager.read('renderer:1',{...scope,kind:'list'}),{code:'DOCKER_UNAVAILABLE'});
  assert.equal(state.connected,true);
  store.appendAudit = async () => { throw new Error('audit unavailable'); };
  await assert.rejects(manager.read('renderer:1',{...scope,kind:'list'}));
  assert.equal(state.reads,0);
});

test('读取通道执行既有命令策略，不能通过结构化 Docker 绕过禁止项', async () => {
  const store = {get:async () => ({commandPolicy:{enabled:true,customDeny:['docker']}})};
  const broker = new SshBroker(store);
  let executed = false;
  broker.sessions.set('fixture',{generation:1,client:{exec:() => {executed = true;}}});
  await assert.rejects(broker.readDocker('fixture',undefined,dockerRequest('list')), {code:'COMMAND_BLOCKED'});
  assert.equal(executed,false);
});

test('Docker Socket 变化使环境上下文失效，旧配置继续使用默认值', async () => {
  const plugin = {...scope,pluginType:'server',target:{host:'host.example.invalid',port:22},auth:{username:'fixture'}};
  const store = {getEnvironment:async () => scope,readRunbook:async () => ({hash:'fixture',content:'fixture'}),listPlugins:async () => [plugin]};
  const manager = new EnvironmentContextManager(store);
  const opened = await manager.open(scope.projectId,scope.environmentId,'agent-one');
  await manager.verify(scope.projectId,scope.environmentId,scope.pluginInstanceId,opened.contextToken,'agent-one');
  plugin.target.dockerSocket = '/run/user/1000/docker.sock';
  await assert.rejects(manager.verify(scope.projectId,scope.environmentId,scope.pluginInstanceId,opened.contextToken,'agent-one'),{code:'CONTEXT_STALE'});
});

test('桌面 Docker IPC 仅允许已登记主框架，最小化时不采样，销毁后清理所属窗口', async () => {
  const calls = [], handlers = new Map();
  const sender = new EventEmitter();
  sender.id = 7; sender.mainFrame = {}; sender.isDestroyed = () => false;
  let minimized = false;
  sender.getOwnerBrowserWindow = () => ({isMinimized:() => minimized});
  const services = {isWorkspaceRenderer: value => value === sender,serverDocker:{
    read:async (...args) => {calls.push(args); return {items:[]};},
    closeOwner:owner => calls.push(['closed',owner]),
  }};
  registerServerWorkspaceIpc({handle:(name,fn) => handlers.set(name,fn)},services);
  const read = handlers.get('v2:server-docker-read');
  assert.equal((await read({sender,senderFrame:{}},{...scope,kind:'list'})).error.code,'WORKSPACE_ACCESS_DENIED');
  assert.equal((await read({sender,senderFrame:sender.mainFrame},{...scope,kind:'list',command:'docker ps'})).error.code,'INVALID_ARGUMENT');
  minimized = true;
  assert.equal((await read({sender,senderFrame:sender.mainFrame},{...scope,kind:'stats',containerId:id})).error.code,'DOCKER_PAUSED');
  minimized = false;
  assert.equal((await read({sender,senderFrame:sender.mainFrame},{...scope,kind:'list'})).ok,true);
  assert.equal(calls[0][0],'renderer:7');
  sender.emit('destroyed');
  assert.deepEqual(calls[1],['closed','renderer:7']);
});

test('四个新增 MCP 工具均为有作用域的只读接口，参数不允许任意命令', () => {
  const names = ['server_docker_list_containers','server_docker_inspect_container','server_docker_read_logs','server_docker_container_stats'];
  for (const name of names) {
    const tool = tools.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint,true);
    assert.equal(tool.inputSchema.additionalProperties,false);
    for (const key of ['projectId','environmentId','pluginInstanceId','contextToken']) assert.ok(tool.inputSchema.required.includes(key));
    assert.equal(tool.inputSchema.properties.command,undefined);
  }
  for (const capability of ['docker.list','docker.inspect','docker.logs','docker.stats']) assert.equal(capabilityRule('server',capability).decision,'auto');
});

test('Server 配置往返保留自定义 Socket，旧配置无需迁移且拒绝非法值', () => {
  const input = {pluginType:'server',pluginInstanceId:scope.pluginInstanceId,displayName:'测试服务器',target:{host:'host.example.invalid'},auth:{username:'fixture',type:'agent'}};
  const legacy = workspaceInternals.normalizePlugin(input,scope);
  assert.equal(legacy.target.dockerSocket,undefined);
  const configured = workspaceInternals.normalizePlugin({target:{dockerSocket:'/run/user/1000/docker.sock'}},scope,legacy);
  assert.equal(configured.target.dockerSocket,'/run/user/1000/docker.sock');
  assert.equal(workspaceInternals.normalizePlugin({},scope,configured).target.dockerSocket,configured.target.dockerSocket);
  assert.equal(workspaceInternals.normalizePlugin({target:{dockerSocket:''}},scope,configured).target.dockerSocket,undefined);
  for (const socket of [0,null,'tcp://host.example.invalid:2375','relative.sock']) {
    assert.throws(() => workspaceInternals.normalizePlugin({target:{dockerSocket:socket}},scope,legacy),{code:'INVALID_ARGUMENT'});
  }
});

test('Docker 在等待队列内取消后立即移除，不占用后续请求且不调用 Broker', async t => {
  const { manager, runtime, store, state, plugin } = fixture(t);
  const actual = new ServerPluginRuntime(store, { load:async () => null });
  const session = {}; let brokerCalls = 0;
  actual.broker.requireSession = () => session;
  actual.broker.readDocker = async (_key, _socket, _request, options) => {
    brokerCalls += 1;
    if (options.signal?.aborted) throw Object.assign(new Error('fixture cancelled'), { code:'DOCKER_CANCELLED' });
    return raw('');
  };
  runtime.readDocker = actual.readDocker.bind(actual);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const active = [1,2].map(() => actual.boundedRead(plugin, () => gate));
  const pending = manager.read('renderer:1', { ...scope, kind:'list', requestId:'queued-cancel' });
  const rejected = assert.rejects(pending, { code:'DOCKER_CANCELLED' }); rejected.catch(() => undefined);
  try {
    for (let index = 0; index < 50 && !actual.readScheduler.queue.length; index++) await flush();
    assert.equal(actual.readScheduler.active, 2);
    assert.equal(actual.readScheduler.queue.length, 1);
    manager.cancel('renderer:1', { ...scope, requestId:'queued-cancel' });
    await flush();
    assert.equal(actual.readScheduler.queue.length, 0, '取消应立即移除排队请求');
    assert.equal(manager.pending.size, 0, '不必等待前面两个读取完成即可反馈取消');
    assert.equal(actual.readScheduler.active, 2, '取消排队请求不提前释放其他读取的并发名额');
  } finally {
    release(); await Promise.all(active); await pending.catch(() => undefined);
  }
  await rejected;
  assert.equal(brokerCalls, 0, '已取消的排队请求不进入 SSH Broker');
  assert.equal(state.connected, true);
  const next = await manager.read('renderer:1', { ...scope, kind:'list', requestId:'after-cancel' });
  assert.deepEqual(next.items, []); assert.equal(brokerCalls, 1);
});
