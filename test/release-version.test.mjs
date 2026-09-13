import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const script = fileURLToPath(new URL('../scripts/verify-release-version.mjs', import.meta.url));
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

function runVersionCheck(...arguments_) {
  return spawnSync(process.execPath, [script, ...arguments_], { encoding: 'utf8' });
}

test('release version check accepts only the package version tag', () => {
  const expected = `v${manifest.version}`;
  const result = runVersionCheck(expected);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Release version verified: ${expected}`), result.stdout);
});

test('release version check rejects a mismatched or missing ref with an actionable error', () => {
  const expected = `v${manifest.version}`;
  const mismatched = runVersionCheck(`${expected}-wrong`);
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /does not match package\.json version/u);
  assert.ok(mismatched.stderr.includes(`expected exactly "${expected}"`), mismatched.stderr);

  const missing = runVersionCheck();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /exactly one explicit tag\/ref name argument/u);
});

test('release workflow passes github.ref_name through an environment variable before install and build', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /RELEASE_REF_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}/u);
  assert.match(workflow, /run:\s*node scripts\/verify-release-version\.mjs "\$RELEASE_REF_NAME"/u);
  assert.doesNotMatch(workflow, /run:[^\r\n]*\$\{\{\s*github\.ref_name/u);

  const verification = workflow.indexOf('node scripts/verify-release-version.mjs');
  assert.ok(verification >= 0);
  assert.ok(verification < workflow.indexOf('- name: Install dependencies'));
  assert.ok(verification < workflow.indexOf('- name: Build Windows installer'));
});


test('预发布工作流等待三平台验证完成后发布，保留 Latest 和校验值保护', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(item => [item.platform,item.arch]),[
    ['win32','x64'],['darwin','arm64'],['darwin','x64'],
  ]);
  assert.equal(workflow.jobs.publish.needs,'build');
  const buildSteps = workflow.jobs.build.steps;
  assert.ok(buildSteps.some(step => step.run?.includes('scripts/prepare-release-assets.mjs')));
  assert.ok(buildSteps.some(step => step.run?.includes('scripts/packaged-mcp-smoke.mjs')));
  assert.ok(buildSteps.some(step => step.env?.AI_OPS_MAC_RELEASE === '1'));
  const publish = workflow.jobs.publish.steps.at(-1);
  assert.equal(publish.env.RELEASE_TAG,'$' + '{{ github.ref_name }}');
  assert.ok(publish.run.includes('[[ "$RELEASE_TAG" == *-* ]]'));
  assert.ok(publish.run.includes('--prerelease --latest=false'));
  assert.ok(publish.run.includes('release/* --verify-tag'));
  assert.ok(publish.run.includes('Release already exists; preserving published assets.'));
  const assets = await fs.readFile(new URL('../scripts/prepare-release-assets.mjs',import.meta.url),'utf8');
  assert.ok(assets.includes("createHash('sha256')"));
  assert.ok(assets.includes("name + '.sha256'"));
});
