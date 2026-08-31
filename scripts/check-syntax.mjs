import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
for (const directory of ['src', 'scripts', 'test']) {
  const entries = await fs.readdir(path.join(root, directory), { recursive: true });
  files.push(...entries
    .filter((entry) => /\.(?:mjs|cjs)$/u.test(entry))
    .map((entry) => path.join(directory, entry)));
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${file}`);
    process.exit(result.status || 1);
  }
}
console.log(`Syntax checked ${files.length} source, script and test files.`);
