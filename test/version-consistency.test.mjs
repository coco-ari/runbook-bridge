import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { APP_VERSION } from '../src/package-metadata.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json is the runtime version source and README mirrors it', async () => {
  assert.equal(APP_VERSION, manifest.version);

  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const documentedVersion = readme.match(/^当前代码包版本：`([^`]+)`/mu)?.[1];
  assert.equal(documentedVersion, manifest.version);
});

test('the default upgrade-regression installer name derives from package.json', async () => {
  const source = await fs.readFile(new URL('../scripts/install-upgrade-regression.cjs', import.meta.url), 'utf8');
  assert.match(source, /Setup \$\{manifest\.version\}\.exe/u);
  assert.doesNotMatch(source, /Setup 1\.0\.\d+\.exe/u);
});
