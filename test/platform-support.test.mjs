import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultDataRoot, brokerEndpoint } from '../src/paths.mjs';
import { packagedPaths } from '../scripts/packaged-paths.cjs';
import { desktopMenuTemplate } from '../src/desktop-menu.mjs';
import { shortcutLabel, privateKeyPathExample } from '../renderer/v2/src/lib/platform.ts';

test('平台默认数据目录保持兼容且桌面和 MCP 使用相同覆盖规则', () => {
  assert.equal(defaultDataRoot({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\mock\\AppData\\Local'},home:'C:\\Users\\mock'}),'C:\\Users\\mock\\AppData\\Local\\AIOpsTool');
  assert.equal(defaultDataRoot({platform:'darwin',env:{LOCALAPPDATA:'ignored'},home:'/Users/mock'}),'/Users/mock/.ai-ops-tool');
  assert.equal(defaultDataRoot({platform:'darwin',env:{AI_OPS_DATA_DIR:'/Users/mock/中文 目录'},home:'/Users/mock'}),'/Users/mock/中文 目录');
  const win = brokerEndpoint('C:\\Users\\Mock\\Data',{platform:'win32'});
  assert.match(win,/^\\\\\.\\pipe\\ai-ops-tool-[a-f0-9]{24}$/u);
  assert.equal(win,brokerEndpoint('c:\\users\\mock\\data',{platform:'win32'}));
});

test('Unix socket 保留短路径，长中文路径隔离到短且按用户区分的目录', () => {
  assert.equal(brokerEndpoint('/Users/mock/.ai-ops-tool',{platform:'darwin',uid:501}),'/Users/mock/.ai-ops-tool/broker.sock');
  const root = '/Users/mock/' + '中文目录'.repeat(30);
  const endpoint = brokerEndpoint(root,{platform:'darwin',uid:501});
  assert.ok(Buffer.byteLength(endpoint) <= 100);
  assert.match(endpoint,/^\/tmp\/ai-ops-tool-501\/[a-f0-9]{24}\.sock$/u);
  assert.equal(endpoint,brokerEndpoint(root,{platform:'darwin',uid:501}));
  assert.notEqual(endpoint,brokerEndpoint(root + '2',{platform:'darwin',uid:501}));
  assert.notEqual(endpoint,brokerEndpoint(root,{platform:'darwin',uid:502}));
  assert.notEqual(brokerEndpoint('/tmp/Case',{platform:'darwin'}),brokerEndpoint('/tmp/case',{platform:'darwin'}));
});

test('包定位支持两种 Mac 架构、中文空格路径和可执行文件入口', () => {
  for (const arch of ['arm64','x64']) {
    const result = packagedPaths(undefined,{platform:'darwin',arch,root:'/tmp/中文 源码'});
    const folder = arch === 'arm64' ? 'mac-arm64' : 'mac';
    assert.equal(result.bundle,'/tmp/中文 源码/dist/' + folder + '/Agent运维工作台.app');
    assert.equal(result.executable,result.bundle + '/Contents/MacOS/Agent运维工作台');
    assert.equal(result.appAsar,result.bundle + '/Contents/Resources/app.asar');
    assert.equal(result.mcpEntrypoint,result.appAsar + '/src/mcp-v2.mjs');
    assert.deepEqual(packagedPaths(result.executable,{platform:'darwin'}),result);
  }
  const installed = packagedPaths('/Applications/Agent运维工作台.app',{platform:'darwin'});
  assert.equal(installed.mcpEntrypoint,'/Applications/Agent运维工作台.app/Contents/Resources/app.asar/src/mcp-v2.mjs');
  const win = packagedPaths('C:\\Program Files\\Agent运维工作台\\Agent运维工作台.exe',{platform:'win32'});
  assert.equal(win.appAsar,'C:\\Program Files\\Agent运维工作台\\resources\\app.asar');
});

test('Mac 菜单与快捷键提示不占用项目新建和命令面板快捷键', () => {
  const menu = desktopMenuTemplate('darwin');
  assert.ok(menu.some(item => item.role === 'editMenu'));
  assert.ok(menu.some(item => item.role === 'appMenu'));
  assert.ok(menu.some(item => item.submenu?.some(child => child.role === 'close')));
  assert.equal(desktopMenuTemplate('win32'),null);
  assert.doesNotMatch(JSON.stringify(menu),/CommandOrControl\+[NKB]/u);
  assert.equal(shortcutLabel('N','MacIntel'),'⌘ N');
  assert.equal(shortcutLabel('↵','MacIntel'),'⌘ ↵');
  assert.equal(shortcutLabel('N','Win32'),'Ctrl N');
  assert.equal(privateKeyPathExample('MacIntel'),'/Users/name/.ssh/id_ed25519');
  assert.equal(privateKeyPathExample('Win32'),'C:\\Users\\name\\.ssh\\id_ed25519');
});
