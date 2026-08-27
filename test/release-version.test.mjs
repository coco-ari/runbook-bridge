import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
  assert.match(workflow, /run:\s*node scripts\/verify-release-version\.mjs "\$env:RELEASE_REF_NAME"/u);
  assert.doesNotMatch(workflow, /run:[^\r\n]*\$\{\{\s*github\.ref_name/u);

  const verification = workflow.indexOf('node scripts/verify-release-version.mjs');
  assert.ok(verification >= 0);
  assert.ok(verification < workflow.indexOf('- name: Install dependencies'));
  assert.ok(verification < workflow.indexOf('- name: Build Windows installer'));
});
