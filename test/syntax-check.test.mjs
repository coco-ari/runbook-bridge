import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('syntax checks discover nested source, scripts and tests and reject invalid files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-syntax-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'test/helpers']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  const script = path.join(root, 'scripts/check-syntax.mjs');
  await fs.copyFile(new URL('../scripts/check-syntax.mjs', import.meta.url), script);
  await fs.writeFile(path.join(root, 'src/main.mjs'), 'export const valid = true;');
  await fs.writeFile(path.join(root, 'test/helpers/fixture.cjs'), 'module.exports = true;');
  await fs.writeFile(path.join(root, 'src/ignored.md'), 'This is not JavaScript.');
  const run = () => spawnSync(process.execPath, [script], {
    cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true,
  });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Syntax checked 3 source, script and test files/u);

  for (const relative of ['src/main.mjs', 'scripts/extra.cjs', 'test/helpers/fixture.cjs']) {
    const file = path.join(root, relative);
    await fs.writeFile(file, 'const = ;');
    const invalid = run();
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /SyntaxError/u);
    assert.ok(invalid.stderr.includes(`Syntax check failed: ${path.normalize(relative)}`));
    await fs.writeFile(file, 'const valid = true;');
  }
});
