import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBuildMetadata } from '../scripts/build-metadata.mjs';
import { BUILD_INFO } from '../src/package-metadata.mjs';

test('构建指纹稳定反映实际源码且不依赖版本号或生成物', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-build-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const directory of ['src','renderer/v2','build']) await fs.mkdir(path.join(root,directory),{recursive:true});
  for (const file of ['package.json','pnpm-lock.yaml','src/main.mjs','renderer/v2/index.html']) await fs.writeFile(path.join(root,file),'fixture');
  const first = await createBuildMetadata(root);
  await fs.writeFile(path.join(root,'build/runtime.json'),'generated');
  assert.equal((await createBuildMetadata(root)).buildId,first.buildId);
  await fs.writeFile(path.join(root,'src/main.mjs'),'changed');
  assert.notEqual((await createBuildMetadata(root)).buildId,first.buildId);
  assert.equal(first.gitCommit,null);
  assert.equal(BUILD_INFO.buildId,'development');
});
