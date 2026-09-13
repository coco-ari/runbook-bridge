import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemVpnGuard, WindowsVpnGuard, RouteManager } from '../src/route-manager.mjs';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';

const networkInterfaces = () => ({ utun9:[
  { address:'192.0.2.10', family:'IPv4', internal:false },
  { address:'2001:db8::10', family:'IPv6', internal:false },
] });
const output = (name = 'utun9', flags = 'UP,GATEWAY,HOST,DONE') => 'route to: 198.51.100.20\n  interface: ' + name + '\n      flags: <' + flags + '>\n';
const vpnRequired = (error) => error.code === 'VPN_REQUIRED';

test('macOS 按解析后的地址族查询实际选路并绑定指定网卡', async () => {
  const calls = [];
  const guard = new SystemVpnGuard({ platform:'darwin', networkInterfaces, exec:async (...args) => {
    calls.push(args);
    return {stdout:output()};
  } });
  for (const [family, address, localAddress] of [[4, '198.51.100.20', '192.0.2.10'], [6, '2001:db8::20', '2001:db8::10']]) {
    assert.deepEqual(await guard.assertRoute(address,family,'utun9'), {localAddress, interfaceAlias:'utun9', verified:true});
    const [command,args,options] = calls.at(-1);
    assert.equal(command,'/sbin/route');
    assert.deepEqual(args,['-n','get',family === 4 ? '-inet' : '-inet6',address]);
    assert.equal(options.shell,undefined);
    assert.equal(options.env.LC_ALL,'C');
    assert.equal(options.timeout,5_000);
    assert.equal(options.maxBuffer,64 * 1024);
  }
});

test('macOS 拒绝错误出口、重复或缺失字段、黑洞和关闭的路由', async () => {
  for (const stdout of [output('en0'), output('UTUN9'), '', 'interface: utun9', output() + 'interface: utun9\n',
    output('utun9','UP,BLACKHOLE'), output('utun9','UP,REJECT'), output('utun9','GATEWAY')]) {
    const guard = new SystemVpnGuard({ platform:'darwin', networkInterfaces, exec:async () => ({stdout}) });
    await assert.rejects(guard.assertRoute('198.51.100.20',4,'utun9'),vpnRequired);
  }
});

test('VPN 验证异常保持稳定错误且不暴露命令输出', async () => {
  const guard = new SystemVpnGuard({ platform:'darwin', networkInterfaces, exec:async () => { throw new Error('mock private output'); } });
  await assert.rejects(guard.assertRoute('198.51.100.20',4,'utun9'),(error) => vpnRequired(error) && !error.message.includes('mock private output'));
});

test('VPN 在输入、网卡、地址族或平台不符时不运行系统命令', async () => {
  let commands = 0;
  const exec = async () => { commands++; return {stdout:output()}; };
  const guard = new SystemVpnGuard({ platform:'darwin', networkInterfaces, exec });
  for (const [address,family,alias] of [['example.invalid',4,'utun9'],['198.51.100.20;id',4,'utun9'],
    ['198.51.100.20',6,'utun9'],['198.51.100.20',4,''],['198.51.100.20',4,'utun9\n'],['198.51.100.20',4,'en0']]) {
    await assert.rejects(guard.assertRoute(address,family,alias));
  }
  const missingFamily = new SystemVpnGuard({ platform:'darwin', networkInterfaces:() => ({utun9:[networkInterfaces().utun9[0]]}), exec });
  await assert.rejects(missingFamily.assertRoute('2001:db8::20',6,'utun9'),vpnRequired);
  const unsupported = new SystemVpnGuard({ platform:'linux', networkInterfaces, exec });
  await assert.rejects(unsupported.assertRoute('198.51.100.20',4,'utun9'),vpnRequired);
  assert.equal(commands,0);
});

test('Windows 继续验证 Find-NetRoute 并保持旧导出兼容', async () => {
  assert.equal(WindowsVpnGuard,SystemVpnGuard);
  const guard = new SystemVpnGuard({ platform:'win32', networkInterfaces, exec:async (command,args) => {
    assert.equal(command,'powershell.exe');
    assert.match(args.at(-1),/Find-NetRoute -RemoteIPAddress '198\.51\.100\.20'/u);
    return {stdout:'UTUN9\r\n'};
  } });
  assert.equal((await guard.assertRoute('198.51.100.20',4,'utun9')).verified,true);
  guard.exec = async () => ({stdout:'Ethernet'});
  await assert.rejects(guard.assertRoute('198.51.100.20',4,'utun9'),vpnRequired);
});

test('数据库和 Server 均拒绝验证器返回未验证的本地地址', async () => {
  const resolver = {resolve:async () => [{address:'198.51.100.20',family:4}]};
  const vpnGuard = {assertRoute:async () => ({localAddress:'192.0.2.10',verified:false})};
  let connections = 0;
  const manager = new RouteManager({resolver,vpnGuard,connect:async () => { connections++; return {}; }});
  await assert.rejects(manager.openDirect({target:{host:'mock.invalid',port:3306},transport:{kind:'windowsVpn',interfaceAlias:'utun9'}}),vpnRequired);
  assert.equal(connections,0);
  const runtime = new ServerPluginRuntime({}, {}, {resolver,vpnGuard});
  await assert.rejects(runtime.createUplinkSocket({target:{host:'mock.invalid',port:22},uplink:{type:'windowsVpn',interfaceAlias:'utun9'}},{}),vpnRequired);
});

test('macOS 使用真实内核路由查询验证命令协议，不发送网络数据', {skip:process.platform !== 'darwin'}, async () => {
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const os = await import('node:os');
  const { stdout } = await promisify(execFile)('/sbin/route',['-n','get','-inet','192.0.2.1'],{
    timeout:5_000,maxBuffer:64 * 1024,env:{...process.env,LC_ALL:'C'},
  });
  const alias = /^\s*interface:\s*(\S+)\s*$/mu.exec(stdout)?.[1];
  assert.ok(alias,'Mac Runner 必须提供可查询的 IPv4 出口');
  const route = await new SystemVpnGuard().assertRoute('192.0.2.1',4,alias);
  assert.equal(route.verified,true);
  assert.ok(os.networkInterfaces()[alias].some(item => item.address === route.localAddress && !item.internal));
});
