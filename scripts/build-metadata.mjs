import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function createBuildMetadata(root) {
  const files = ['package.json', 'pnpm-lock.yaml'];
  for (const directory of ['src', 'renderer/v2']) {
    const entries = await fs.readdir(path.join(root, directory), { recursive:true, withFileTypes:true });
    for (const entry of entries) {
      if (entry.isFile()) files.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
    }
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await fs.readFile(path.join(root, file))).update('\0');
  let gitCommit = null;
  let dirty = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse','HEAD'], { cwd:root, encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','ignore'] }).trim();
    dirty = Boolean(execFileSync('git', ['status','--porcelain','--untracked-files=no'], { cwd:root, encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','ignore'] }).trim());
  } catch {
    // 源码归档没有 Git 信息时仍以内容指纹标识构建。
  }
  return { buildId:hash.digest('hex'), gitCommit, dirty, builtAt:new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const metadata = await createBuildMetadata(root);
  await fs.mkdir(path.join(root, 'build'), { recursive:true });
  await fs.writeFile(path.join(root, 'build/runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(`构建标识：${metadata.buildId.slice(0, 12)}`);
}
