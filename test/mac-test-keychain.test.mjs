import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { createMacTestKeychain, keychainPaths } = createRequire(import.meta.url)('../scripts/mac-test-keychain.cjs');

async function fixture(t, failOperation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-install-regression-keychain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundles = ['old.app', 'new.app'].map(name => path.join(root, name));
  const signatures = new Map([[bundles[0], 'a'.repeat(40)], [bundles[1], 'b'.repeat(40)]]);
  await Promise.all(bundles.map(bundle => fs.mkdir(bundle)));
  const calls = [];
  const options = {
    root, bundles, platform: 'darwin',
    env: { AI_OPS_MAC_TEST_KEYCHAIN: '1', GITHUB_ACTIONS: 'true', RUNNER_TEMP: os.tmpdir() },
    async run(command, args) {
      if (command === '/usr/bin/codesign') return { stdout: '', stderr: `CDHash=${signatures.get(args.at(-1))}\n` };
      assert.equal(command, '/usr/bin/security');
      calls.push(args);
      if (failOperation?.(args)) throw new Error('仅用于测试的敏感错误内容');
      if (args[0] === 'default-keychain' && args.length === 3) return { stdout: '    "/mock/login.keychain-db"' };
      if (args[0] === 'list-keychains' && args.length === 3) return { stdout: '    "/mock/login.keychain-db"\n    "/mock/other.keychain-db"' };
      return { stdout: '' };
    },
  };
  return { calls, options, signatures };
}

test('测试钥匙串必须显式启用且只能在隔离 Mac Runner 内运行', async t => {
  const { options, calls } = await fixture(t);
  assert.equal(await createMacTestKeychain({ ...options, env: {} }), null);
  await assert.rejects(createMacTestKeychain({ ...options, platform: 'win32' }), /Mac/u);
  await assert.rejects(createMacTestKeychain({ ...options, env: { ...options.env, GITHUB_ACTIONS: 'false' } }), /Runner/u);
  await assert.rejects(createMacTestKeychain({ ...options, root: os.tmpdir() }), /临时目录/u);
  assert.equal(calls.length, 0);
});

test('测试钥匙串仅授权两个构建，结束时恢复原始默认项和搜索列表', async t => {
  const { options, calls, signatures } = await fixture(t);
  const keychain = await createMacTestKeychain(options);
  const add = calls.find(args => args[0] === 'add-generic-password');
  assert.deepEqual(add.filter((value, index) => add[index - 1] === '-T'), options.bundles);
  assert.ok(!calls.flat().includes('-A'));
  assert.deepEqual(add.slice(1, 5), ['-a', 'AI 运维工具', '-s', 'AI 运维工具 Safe Storage']);
  await assert.rejects(keychain.authorizeUpgrade(options.bundles[1]), /同一测试安装位置/u);
  await assert.rejects(keychain.authorizeUpgrade(options.bundles[0]), /签名必须/u);
  signatures.set(options.bundles[0], signatures.get(options.bundles[1]));
  await keychain.authorizeUpgrade(options.bundles[0]);
  const partition = calls.find(args => args[0] === 'set-generic-password-partition-list');
  assert.equal(partition[partition.indexOf('-S') + 1], `cdhash:${'a'.repeat(40)},cdhash:${'b'.repeat(40)}`);
  assert.equal(calls.filter(args => args[0] === 'add-generic-password').length, 1);
  assert.ok(!calls.flat().includes('-U'));
  await keychain.restore();
  assert.deepEqual(calls.at(-3), ['default-keychain', '-d', 'user', '-s', '/mock/login.keychain-db']);
  assert.deepEqual(calls.at(-2), ['list-keychains', '-d', 'user', '-s', '/mock/login.keychain-db', '/mock/other.keychain-db']);
  assert.equal(calls.at(-1)[0], 'delete-keychain');
  assert.equal(path.dirname(calls.at(-1)[1]), await fs.realpath(options.root));
  const count = calls.length;
  await keychain.restore();
  assert.equal(calls.length, count);
});

test('初始化失败仍恢复钥匙串配置，错误不包含系统敏感输出', async t => {
  const { options, calls } = await fixture(t, args => args[0] === 'add-generic-password');
  await assert.rejects(createMacTestKeychain(options), error => {
    assert.equal(error.message, '临时测试钥匙串操作失败：add-generic-password');
    return true;
  });
  assert.equal(calls.at(-1)[0], 'delete-keychain');
  assert.deepEqual(calls.at(-2).slice(4), ['/mock/login.keychain-db', '/mock/other.keychain-db']);
});

test('恢复默认项失败仍尝试恢复搜索列表和删除测试钥匙串', async t => {
  const { options, calls } = await fixture(t, args => args[0] === 'default-keychain' && args[4] === '/mock/login.keychain-db');
  const keychain = await createMacTestKeychain(options);
  await assert.rejects(keychain.restore(), /清理失败/u);
  assert.equal(calls.at(-1)[0], 'delete-keychain');
  assert.deepEqual(calls.at(-2).slice(4), ['/mock/login.keychain-db', '/mock/other.keychain-db']);
});

test('系统钥匙串列表拒绝不完整或额外命令文本', () => {
  assert.deepEqual(keychainPaths('    "/mock/有空 格.keychain-db"\n'), ['/mock/有空 格.keychain-db']);
  assert.throws(() => keychainPaths('"/mock/path" trailing'), /无法解析/u);
});
