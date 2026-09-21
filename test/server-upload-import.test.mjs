import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
function harness() {
  const paths = new WeakMap(), calls = [];
  let api;
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value.v2; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, data: { reviewId: 'fixture' } }; } },
    webUtils: { getPathForFile: file => {
      if (!file || typeof file !== 'object') throw Error('不应暴露的底层文件错误');
      return paths.get(file) ?? '';
    } },
  }) });
  return { paths, calls, api };
}
const scope = { projectId: 'fixture', environmentId: 'test', pluginInstanceId: 'server', path: '/srv' };

test('粘贴和拖入文件只在 preload 中解析磁盘路径，保持文件顺序和远端作用域', async () => {
  const h = harness();
  const files = [{ name: '发布包.jar' }, { name: '带 空格.txt' }];
  h.paths.set(files[0], '/Users/example/发布包.jar');
  h.paths.set(files[1], 'C:\\fixture\\带 空格.txt');
  const result = await h.api.serverWorkspaceImportUpload({ ...scope, localPaths: ['forged'] }, files);
  assert.equal(result.ok, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), ['v2:server-workspace-import-upload', {
    ...scope, localPaths: ['/Users/example/发布包.jar', 'C:\\fixture\\带 空格.txt'],
  }]);
});

test('拒绝文本路径、伪造路径对象、内存文件和越界数量，不能调用主进程', async () => {
  const h = harness();
  for (const input of [[], Array(21).fill({}), null, 'file']) {
    assert.equal((await h.api.serverWorkspaceImportUpload(scope, input)).error.code, 'INVALID_ARGUMENT');
  }
  for (const input of [['/tmp/fixture'], [{ path: '/tmp/fixture', name: 'fixture' }], [{}], [null]]) {
    const result = await h.api.serverWorkspaceImportUpload(scope, input);
    assert.equal(result.error.code, 'UPLOAD_SOURCE_UNAVAILABLE');
    assert.ok(!JSON.stringify(result).includes('底层文件错误'));
  }
  const overridden = [{}];
  overridden.map = () => ['/tmp/forged'];
  assert.equal((await h.api.serverWorkspaceImportUpload(scope, overridden)).error.code, 'UPLOAD_SOURCE_UNAVAILABLE', '数组自定义方法不能跳过文件对象校验');
  const valid = {};
  h.paths.set(valid, '/tmp/valid');
  assert.equal((await h.api.serverWorkspaceImportUpload(scope, [valid, {}])).ok, false, '混合来源整批拒绝，不静默遗漏');
  assert.equal(h.calls.length, 0);
});
