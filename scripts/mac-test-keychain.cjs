const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function keychainPaths(stdout) {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    assert.match(line, /^"[^"\r\n]+"$/, '无法解析系统钥匙串路径');
    return line.slice(1, -1);
  });
}

async function createMacTestKeychain({ root, bundles, run, env = process.env, platform = process.platform }) {
  if (env.AI_OPS_MAC_TEST_KEYCHAIN !== '1') return null;
  assert.equal(platform, 'darwin', '临时钥匙串仅用于 Mac 回归');
  assert.equal(env.GITHUB_ACTIONS, 'true', '临时钥匙串仅用于隔离的 GitHub Runner');
  assert.ok(env.RUNNER_TEMP, '缺少 Runner 临时目录');
  const temporary = await fs.realpath(os.tmpdir());
  const resolvedRoot = await fs.realpath(root);
  const relative = path.relative(temporary, resolvedRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '测试目录必须位于 Runner 临时目录');
  assert.ok(path.basename(root).startsWith('ai-ops-install-regression-'), '无效的安装回归目录');
  assert.equal(bundles.length, 2, '只允许授权旧版和新版两个测试构建');
  for (const bundle of bundles) {
    assert.ok(bundle.endsWith('.app'), '测试授权对象必须是应用包');
    await fs.access(bundle);
  }
  const keychain = path.join(resolvedRoot, 'install-regression.keychain-db');
  const security = async args => {
    try {
      return await run('/usr/bin/security', args, { timeoutMs: 20_000 });
    } catch {
      // 不把命令参数或系统输出写入错误，避免测试密码进入日志。
      throw new Error(`临时测试钥匙串操作失败：${args[0]}`);
    }
  };
  async function signature(bundle) {
    const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { timeoutMs: 20_000 });
    const hash = result.stderr.match(/^CDHash=([a-f0-9]{40})$/m)?.[1];
    assert.ok(hash, '测试应用缺少有效代码签名摘要');
    return hash;
  }
  const expectedUpgradeSignature = await signature(bundles[1]);
  const originalSignature = await signature(bundles[0]);
  const originalDefault = keychainPaths((await security(['default-keychain', '-d', 'user'])).stdout);
  const originalSearch = keychainPaths((await security(['list-keychains', '-d', 'user'])).stdout);
  assert.equal(originalDefault.length, 1, '缺少原始默认钥匙串');
  let created = false;
  let restored = false;
  async function restore() {
    if (restored) return;
    const failures = [];
    // 即使某一步失败，也要尝试恢复搜索列表并删除本次创建的测试钥匙串。
    for (const args of [
      ['default-keychain', '-d', 'user', '-s', originalDefault[0]],
      ['list-keychains', '-d', 'user', '-s', ...originalSearch],
      ...(created ? [['delete-keychain', keychain]] : []),
    ]) {
      try { await security(args); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '临时测试钥匙串清理失败');
    restored = true;
  }
  try {
    const password = crypto.randomBytes(32).toString('base64');
    const encryptionKey = crypto.randomBytes(24).toString('base64');
    await security(['create-keychain', '-p', password, keychain]);
    created = true;
    await security(['set-keychain-settings', '-t', '1800', keychain]);
    await security(['unlock-keychain', '-p', password, keychain]);
    await security(['default-keychain', '-d', 'user', '-s', keychain]);
    await security(['list-keychains', '-d', 'user', '-s', keychain]);
    // 仅预授权两个测试构建，仍使用 Electron safeStorage 和真实系统钥匙串。
    await security(['add-generic-password', '-a', 'AI 运维工具', '-s', 'AI 运维工具 Safe Storage',
      '-w', encryptionKey, '-T', bundles[0], '-T', bundles[1], keychain]);
    // 临时签名还受代码摘要分区限制，只允许两个精确摘要，不授权任意应用。
    await security(['set-generic-password-partition-list', '-a', 'AI 运维工具', '-s', 'AI 运维工具 Safe Storage',
      '-S', [...new Set([originalSignature, expectedUpgradeSignature])].map(hash => `cdhash:${hash}`).join(','),
      '-k', password, keychain]);
    return {
      restore,
      async authorizeUpgrade(bundle) {
        assert.equal(bundle, bundles[0], '新版必须覆盖到同一测试安装位置');
        assert.equal(await signature(bundle), expectedUpgradeSignature, '覆盖后的签名必须与候选新版相同');
        // 在实际覆盖路径更新测试授权，合成密钥保持不变，模拟用户允许新版访问。
        await security(['add-generic-password', '-U', '-a', 'AI 运维工具', '-s', 'AI 运维工具 Safe Storage',
          '-w', encryptionKey, '-T', bundle, keychain]);
        await security(['set-generic-password-partition-list', '-a', 'AI 运维工具', '-s', 'AI 运维工具 Safe Storage',
          '-S', `cdhash:${expectedUpgradeSignature}`, '-k', password, keychain]);
      },
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

module.exports = { createMacTestKeychain, keychainPaths };
