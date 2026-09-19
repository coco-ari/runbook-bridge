import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readTerminalDirectoryChannel } from '../src/server-terminal-directory.mjs';
import { createTerminalStartup } from '../src/server-terminal-startup.mjs';
import { normalizeWorkspaceLocation, workspaceLocationAncestors } from '../renderer/v2/src/features/server-workspace/workspace-location.ts';

function clientFixture(chunks, { code = 0, stderr = [] } = {}) {
  const client = new EventEmitter();
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.resume = () => {};
  stream.stderr.resume = () => {};
  stream.close = () => { stream.closed = true; };
  stream.destroy = () => { stream.closed = true; };
  client.calls = [];
  client.exec = (command, options, accept) => {
    client.calls.push({ command, options });
    accept(null, stream);
    queueMicrotask(() => {
      for (const chunk of chunks) stream.emit('data', Buffer.from(chunk));
      for (const chunk of stderr) stream.stderr.emit('data', Buffer.from(chunk));
      stream.emit('close', code);
    });
  };
  return { client, stream };
}

test('终端目录查询只读取绑定进程的 cwd，保留中文和路径末尾空格', async () => {
  const value = '/srv/日志 目录 ';
  const raw = Buffer.from(value + '\n');
  const { client, stream } = clientFixture([raw.subarray(0, 7), raw.subarray(7)]);
  assert.deepEqual(await readTerminalDirectoryChannel(client, 1234), { path:value });
  assert.deepEqual(client.calls, [{ command:'command readlink -- /proc/1234/cwd', options:{ pty:false } }]);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(stream.closed, true);
});

test('终端目录查询拒绝任意进程表达式、异常输出和超限数据，错误不回显内容', async () => {
  for (const pid of [0, -1, 1.5, 2147483648, '123', '123; echo forbidden']) {
    const { client } = clientFixture(['/srv\n']);
    assert.throws(() => readTerminalDirectoryChannel(client, pid), { code:'TERMINAL_DIRECTORY_UNAVAILABLE' });
    assert.equal(client.calls.length, 0);
  }
  for (const [output, options] of [
    ['relative\n', {}], ['/srv\ninjected\n', {}], ['/srv\0x\n', {}],
    ['/srv\n', { code:1 }], ['/srv', {}], [Buffer.from([47, 255, 10]), {}],
    ['/' + 'x'.repeat(4097) + '\n', {}], ['/srv\n', { stderr:['private-operational-marker'.repeat(300)] }],
  ]) {
    const { client } = clientFixture([output], options);
    await assert.rejects(readTerminalDirectoryChannel(client, 42), error => {
      assert.ok(error.code.startsWith('TERMINAL_DIRECTORY_'));
      assert.ok(!error.message.includes('private-operational-marker'));
      assert.ok(!error.message.includes('injected'));
      return true;
    });
  }
});

test('终端目录超时和取消只关闭查询通道，迟到回调无法恢复查询', async () => {
  const client = new EventEmitter();
  let accept;
  client.exec = (_command, _options, callback) => { accept = callback; };
  await assert.rejects(readTerminalDirectoryChannel(client, 42, { timeoutMs:10 }), { code:'TERMINAL_DIRECTORY_TIMEOUT' });
  const late = clientFixture([]).stream;
  accept(null, late);
  assert.equal(late.closed, true);
  const controller = new AbortController();
  const pending = readTerminalDirectoryChannel(client, 42, { signal:controller.signal });
  controller.abort();
  await assert.rejects(pending, { code:'TERMINAL_CLOSED' });
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
});

test('启动元数据跨所有分包边界读取进程号，并完整保留提示符与后续用户输出', async () => {
  for (let split = 0; split < 120; split += 1) {
    const startup = createTerminalStartup(':', { identifyShell:true });
    const token = startup.command.match(/runbook-ready:([a-f0-9]{32})/u)[1];
    const markers = Buffer.from('\x1b]runbook-shell:' + token + ':12345\x07\x1b]runbook-ready:' + token + '\x07');
    assert.ok(startup.command.includes('"$$"'), '启动命令必须读取当前 Shell 的进程号');
    assert.equal(startup.consume(Buffer.from(startup.command)).length, 0);
    assert.equal(startup.shellPid, null);
    const first = startup.consume(markers.subarray(0, split));
    const second = startup.consume(Buffer.concat([markers.subarray(split), Buffer.from('提示符😀')]));
    await startup.ready;
    assert.equal(startup.shellPid, 12345);
    assert.equal(Buffer.concat([first, second]).toString(), '提示符😀');
    const unchanged = Buffer.from('\x1b]runbook-shell:' + token + ':999\x07');
    assert.deepEqual(startup.consume(unchanged), unchanged);
    assert.equal(startup.shellPid, 12345);
  }
});

test('错误会话标记和非法进程号不能作为终端目录查询身份', async () => {
  for (const value of ['-1', '1;ls', '2147483648', '\xb1', '']) {
    const startup = createTerminalStartup(':', { identifyShell:true });
    const token = startup.command.match(/runbook-ready:([a-f0-9]{32})/u)[1];
    startup.consume(Buffer.from('\x1b]runbook-shell:other:42\x07\x1b]runbook-shell:' + token + ':' + value + '\x07\x1b]runbook-ready:' + token + '\x07', 'latin1'));
    await startup.ready;
    assert.equal(startup.shellPid, null);
  }
});

test('目录树定位路径保持绝对根与有界祖先链，精确保留空格和特殊字符', () => {
  assert.equal(normalizeWorkspaceLocation('/srv//./a/../日志 '), '/srv/日志 ');
  assert.equal(normalizeWorkspaceLocation("/srv/带 空格'$(echo literal).conf"), "/srv/带 空格'$(echo literal).conf");
  assert.deepEqual(workspaceLocationAncestors('/srv/config/example.conf'), ['/', '/srv', '/srv/config']);
  assert.deepEqual(workspaceLocationAncestors('/'), ['/']);
  for (const path of ['relative', '', '/srv\0x', '/srv\nx', '/' + '中'.repeat(1400)]) {
    assert.throws(() => normalizeWorkspaceLocation(path));
  }
  assert.throws(() => workspaceLocationAncestors('/' + Array(32).fill('nested').join('/')));
});
