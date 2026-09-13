import assert from 'node:assert/strict';
import test from 'node:test';
import { macBuildArguments } from '../scripts/build-mac.mjs';

test('Mac 构建拒绝错误主机和不支持的架构', () => {
  assert.throws(() => macBuildArguments({platform:'win32',arch:'arm64',env:{}}),/Mac/u);
  assert.throws(() => macBuildArguments({platform:'darwin',arch:'ia32',env:{}}),/arm64/u);
});

test('开发包使用显式临时签名且不发布，正式包缺少签名公证时必须失败', () => {
  const dev = macBuildArguments({platform:'darwin',arch:'arm64',env:{}});
  assert.ok(dev.includes('--arm64'));
  assert.ok(dev.includes('-c.mac.identity=-'));
  assert.ok(dev.includes('-c.mac.notarize=false'));
  assert.deepEqual(dev.slice(2,4),['--publish','never']);
  for (const env of [{AI_OPS_MAC_RELEASE:'1'}, {AI_OPS_MAC_RELEASE:'1',CSC_LINK:'mock-certificate'}]) {
    assert.throws(() => macBuildArguments({platform:'darwin',arch:'x64',env}));
  }
  const release = macBuildArguments({platform:'darwin',arch:'x64',env:{
    AI_OPS_MAC_RELEASE:'1',CSC_LINK:'mock-certificate',
    APPLE_ID:'mock@example.invalid',APPLE_APP_SPECIFIC_PASSWORD:'mock-only',APPLE_TEAM_ID:'mock-team',
  }});
  assert.ok(release.includes('--x64'));
  assert.ok(release.includes('-c.forceCodeSigning=true'));
  assert.ok(release.includes('-c.mac.notarize=true'));
  assert.ok(!release.some(value => value.includes('hardenedRuntime=false') || value.includes('identity=-')));
  assert.ok(!release.some(value => value.includes('mock')));
});
