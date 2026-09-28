import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopDownloadPicker } from '../src/desktop-download-picker.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'desktop-download-picker-'));
  const dataRoot = path.join(root,'settings');
  const defaultDirectory = path.join(root,'downloads');
  const chosen = path.join(root,'chosen');
  await fs.mkdir(defaultDirectory); await fs.mkdir(chosen);
  const store = new WorkspaceStore(dataRoot);
  const options = [];
  let selection = {canceled:true};
  const config = {dataRoot,defaultDirectory,
    showSaveDialog:async (_window, value) => {options.push(value); return selection;},
    atomicWrite:(file,content) => store.atomicWrite(file,content)};
  const create = () => new DesktopDownloadPicker(config);
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  return {root,chosen,dataRoot,defaultDirectory,options,config,create,select:value => {selection=value;}};
}

test('新下载默认使用最近选择的目录，重建选择器后仍保留，只保存目录', async t => {
  const f = await fixture(t); const picker = f.create();
  const selected = path.join(f.chosen,'renamed.zip');
  f.select({canceled:false,filePath:selected});
  assert.equal(await picker.pick({},'first.zip'),selected);
  assert.equal(f.options[0].defaultPath,path.join(f.defaultDirectory,'first.zip'));
  assert.deepEqual(JSON.parse(await fs.readFile(picker.file,'utf8')),{directory:f.chosen});
  f.select({canceled:true});
  assert.equal(await picker.pick({},'second.zip'),null);
  assert.equal(f.options[1].defaultPath,path.join(f.chosen,'second.zip'));
  await f.create().pick({},'third.zip');
  assert.equal(f.options[2].defaultPath,path.join(f.chosen,'third.zip'));
  assert.deepEqual(f.options[2].properties,['showOverwriteConfirmation']);
});

test('取消或无返回路径不更新最近目录，原任务路径优先于最近目录', async t => {
  const f = await fixture(t); const picker = f.create();
  f.select({canceled:false,filePath:path.join(f.chosen,'first.zip')});
  await picker.pick({},'first.zip');
  const previous = path.join(f.defaultDirectory,'original.zip');
  f.select({canceled:true,filePath:previous});
  await picker.pick({},'original.zip',previous);
  assert.equal(f.options.at(-1).defaultPath,previous);
  f.select({canceled:false});
  assert.equal(await picker.pick({},'missing.zip'),null);
  await f.create().pick({},'next.zip');
  assert.equal(f.options.at(-1).defaultPath,path.join(f.chosen,'next.zip'));
});

test('最近目录不存在、不是目录或偏好损坏时回退系统下载目录', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dataRoot);
  const file = f.create().file;
  const regular = path.join(f.root,'regular');
  await fs.writeFile(regular,'fixture');
  for (const content of ['{', 'null', '{"directory":"relative"}',
    JSON.stringify({directory:path.join(f.root,'removed')}), JSON.stringify({directory:regular})]) {
    await fs.writeFile(file,content);
    await f.create().pick({},'next.zip');
    assert.equal(f.options.at(-1).defaultPath,path.join(f.defaultDirectory,'next.zip'));
  }
});

test('偏好写入失败不阻止下载，本次会话仍记住目录', async t => {
  const f = await fixture(t);
  f.config.atomicWrite = async () => {throw new Error('模拟磁盘不可写');};
  const picker = f.create();
  const selected = path.join(f.chosen,'first.zip');
  f.select({canceled:false,filePath:selected});
  assert.equal(await picker.pick({},'first.zip'),selected);
  f.select({canceled:true});
  await picker.pick({},'next.zip');
  assert.equal(f.options.at(-1).defaultPath,path.join(f.chosen,'next.zip'));
});
