import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { parse } from 'yaml';
import { macBuildArguments } from '../scripts/build-mac.mjs';

test('Mac 构建拒绝错误主机和不支持的架构', () => {
  assert.throws(() => macBuildArguments({platform:'win32',arch:'arm64',env:{}}),/Mac/u);
  assert.throws(() => macBuildArguments({platform:'darwin',arch:'ia32',env:{}}),/arm64/u);
});

test('未公证 Mac 构建通道只产出待验收文件，保留双架构与完整更新验证',async () => {
  const content = await fs.readFile(new URL('../.github/workflows/cloud-macos-package.yml',import.meta.url),'utf8');
  const workflow = parse(content);
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
  assert.deepEqual(workflow.permissions,{contents:'read'});
  const job = workflow.jobs.package;
  assert.equal(job.env.AI_OPS_MAC_RELEASE,'0');
  assert.deepEqual(job.strategy.matrix.include.map(item => item.arch).sort(),['arm64','x64']);
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  for (const required of ['pnpm run check','pnpm test','pnpm run test:ui','--software-update-only','--update-center-only','scripts/verify-package.mjs','scripts/packaged-mcp-smoke.mjs','scripts/packaged-ui-smoke.cjs','scripts/install-upgrade-regression.cjs','scripts/prepare-cloud-update.mjs']) assert.ok(commands.includes(required),required);
  assert.doesNotMatch(content,/secrets\.|gh release|--publish always|stapler/);
  assert.match(job.steps.at(-1).with.name,/manual-unnotarized$/);
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
