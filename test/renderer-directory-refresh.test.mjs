import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { createDirectoryReader } from '../renderer/v2/src/features/server-workspace/directory-read-controller.ts';
import { createWorkspaceReadQueue } from '../renderer/v2/src/features/server-workspace/workspace-read-queue.ts';
import { parentRemotePath, serverEntryType, unwrapWorkspaceResult, isWorkspacePathStale, workspaceErrorMessage } from '../renderer/v2/src/features/server-workspace/workspace-model.ts';

// 执行组件中的真实读取与刷新函数，受控提交保留 React 延迟批量更新这一边界。
const filename = new URL('../renderer/v2/src/features/server-workspace/ServerFileTree.tsx', import.meta.url);
const source = fs.readFileSync(filename, 'utf8');
function componentFunction(name, context) {
  const declaration = '  const ' + name + ' = ';
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, '组件函数必须保持完整：' + name);
  let expression = source.slice(start + declaration.length, end + 4);
  if (expression.startsWith('useCallback(')) expression = expression.slice('useCallback('.length);
  const code = stripTypeScriptTypes('(' + expression + ')');
  return vm.runInContext(code, context);
}
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function harness(selected = '/alpha') {
  let serial = 0, directories;
  const names = new Map([['/', ['alpha', 'beta']], ['/alpha', ['nested', 'old.txt']], ['/alpha/nested', ['old.txt']], ['/beta', ['old.txt']]]);
  const page = (path, changes = {}) => ({ path, canonicalPath: path, snapshotId: 'snapshot-' + ++serial,
    entries: (names.get(path) ?? []).map(name => ({ path: (path === '/' ? '' : path) + '/' + name, name, type: name.endsWith('.txt') ? 'file' : 'directory', size: 1, mtime: 1, mode: 0o644 })),
    nextCursor: null, truncated: false, ...changes });
  directories = Object.fromEntries([...names.keys()].map(path => [path, { page: page(path), loading: false, loadedAt: Date.now() }]));
  const paths = new Set(['/']);
  for (let path = selected; path !== '/'; path = parentRemotePath(path)) paths.add(path);
  const commits = [], calls = [], targets = { current: new Set([...paths].sort((a, b) => a.length - b.length)) };
  const queue = createWorkspaceReadQueue();
  const environment = { Error, Promise, Map, Set, Date, Math, Boolean, Number,
    mountedRef: { current: true }, connectedRef: { current: true }, visibleRef: { current: true }, root: '/', rootRef: { current: '/' }, pathRef: { current: selected },
    directoriesRef: { current: directories }, requestsRef: { current: new Map() }, requestSequenceRef: { current: 0 },
    refreshGenerationRef: { current: 0 }, refreshingRef: { current: false }, pendingVisibilityRefreshRef: { current: false },
    refreshTargetsRef: targets, readOwner: {}, readQueue: queue, scope: { projectId: 'p', environmentId: 'e', pluginInstanceId: 's' },
    parentRemotePath, serverEntryType, unwrapWorkspaceResult, isWorkspacePathStale, workspaceErrorMessage,
    needsDirectoryRead: state => !state?.page || Date.now() - (state.loadedAt ?? 0) >= 30000,
    setDirectories: update => commits.push(update), setRefreshing: () => {}, setRefreshResumeEpoch: () => {},
    api: { serverWorkspaceListDirectory: input => new Promise((resolve, reject) => calls.push({ input, resolve, reject, done: false })) },
  };
  environment.directoryReader = createDirectoryReader(environment.api, environment.scope);
  const context = vm.createContext(environment);
  environment.invalidate = componentFunction('invalidate', context);
  environment.load = componentFunction('load', context);
  const refresh = componentFunction('refreshVisibleDirectories', context);
  const flush = () => {
    while (commits.length) directories = commits.shift()(directories);
    environment.directoriesRef.current = directories;
    const visible = new Set(['/']);
    for (const path of [...paths].sort((a, b) => a.length - b.length)) {
      if (path === '/') continue;
      const parent = parentRemotePath(path);
      if (visible.has(parent) && directories[parent]?.page?.entries.some(entry => entry.path === path && serverEntryType(entry) === 'directory')) visible.add(path);
    }
    targets.current = visible;
  };
  const step = async () => { for (let i = 0; i < 3; i++) { await settle(); flush(); } };
  const pending = path => { const call = calls.find(value => !value.done && value.input.path === path); assert.ok(call, '存在待返回请求：' + path); call.done = true; return call; };
  return { environment, queue, calls, page, refresh, load: environment.load, step, flush, state: () => directories,
    expand: (...values) => { for (const value of values) paths.add(value); flush(); },
    reply: (path, changes) => pending(path).resolve({ ok: true, data: page(path, changes) }),
    reject: (path, code = 'SOURCE_NOT_FOUND') => pending(path).reject(Object.assign(new Error('合成读取失败'), { code })),
    fresh: path => ({ entries: [{ path: path + '/fresh.txt', name: 'fresh.txt', type: 'file' }] }),
  };
}
const hasFresh = (h, path = '/alpha') => h.state()[path]?.page?.entries.some(entry => entry.name === 'fresh.txt') ?? false;

test('当前目录与根同时读取，子页先完成仍等待根验证后发布', async () => {
  const h = harness(), reading = h.refresh(); await h.step();
  assert.deepEqual(h.calls.map(call => call.input.path), ['/', '/alpha']);
  h.reply('/alpha', h.fresh('/alpha')); await h.step(); assert.equal(hasFresh(h), false);
  h.reply('/'); await reading; await h.step(); assert.equal(hasFresh(h), true);
  assert.equal(h.environment.refreshingRef.current, false);
});

test('根先完成时仍等待当前目录的实际响应', async () => {
  const h = harness(), reading = h.refresh(); await h.step(); h.reply('/'); await h.step();
  assert.equal(hasFresh(h), false); h.reply('/alpha', h.fresh('/alpha')); await reading; await h.step();
  assert.equal(hasFresh(h), true);
});

test('深层预取等待根和中间祖先完整确认，不重复读取当前目录', async () => {
  const h = harness('/alpha/nested'), reading = h.refresh(); await h.step();
  assert.deepEqual(h.calls.map(call => call.input.path), ['/', '/alpha/nested']);
  h.reply('/alpha/nested', h.fresh('/alpha/nested')); h.reply('/'); await h.step();
  assert.equal(hasFresh(h, '/alpha/nested'), false); h.reply('/alpha'); await reading; await h.step();
  assert.equal(hasFresh(h, '/alpha/nested'), true);
  assert.equal(h.calls.filter(call => call.input.path === '/alpha/nested').length, 1);
});

for (const [name, changes] of [['父目录删除当前分支', { entries: [] }], ['父目录变成链接目标', { canonicalPath: '/new-target' }]]) test(name + '时预备结果不得复活缓存', async () => {
  const h = harness('/alpha/nested'), reading = h.refresh(); await h.step();
  h.reply('/alpha/nested', h.fresh('/alpha/nested')); h.reply('/'); await h.step();
  h.reply('/alpha', changes); await reading; await h.step();
  assert.equal(hasFresh(h, '/alpha/nested'), false); assert.equal(h.state()['/alpha/nested'], undefined);
  assert.equal(h.environment.requestsRef.current.size, 0);
});

test('根失败时不发布已准备的子页并解除刷新等待', async () => {
  const h = harness(), reading = h.refresh(); await h.step(); h.reply('/alpha', h.fresh('/alpha')); h.reject('/', 'SOURCE_ACCESS_DENIED');
  await reading; await h.step(); assert.equal(hasFresh(h), false); assert.equal(h.state()['/alpha'].loadedAt, 0);
  assert.equal(h.environment.refreshingRef.current, false);
});

test('根删除分支时迟到预取错误不创建孤立错误节点', async () => {
  const h = harness(), reading = h.refresh(); await h.step(); h.reject('/alpha'); h.reply('/', { entries: [] });
  await reading; await h.step(); assert.equal(h.state()['/alpha'], undefined); assert.equal(h.calls.length, 2);
});

test('隐藏及刷新代次变化会丢弃预备结果并保留过期状态', async () => {
  const h = harness(), reading = h.refresh(); await h.step(); h.reply('/alpha', h.fresh('/alpha')); await h.step();
  h.environment.visibleRef.current = false; h.environment.refreshGenerationRef.current += 1;
  h.reply('/'); await reading; await h.step(); assert.equal(hasFresh(h), false); assert.equal(h.state()['/alpha'].loadedAt, 0);
});

test('被新祖先请求取代的验证不能发布旧预取结果', async () => {
  const h = harness(), reading = h.refresh(); await h.step(); h.reply('/'); await h.step();
  const newer = h.load('/'); await h.step(); h.reply('/alpha', h.fresh('/alpha')); await reading; await h.step();
  assert.equal(hasFresh(h), false); h.reject('/', 'SOURCE_ACCESS_DENIED'); await newer; await h.step(); assert.equal(hasFresh(h), false);
});

test('排队预取因改选取消后不自动降级为绕过屏障的普通读取', async () => {
  const h = harness(); const releases = [];
  const occupied = ['one', 'two'].map(key => h.queue.run({}, key, () => new Promise(resolve => releases.push(resolve)), () => true));
  await h.step(); const reading = h.refresh(); await h.step(); assert.deepEqual(h.calls.map(call => call.input.path), ['/']);
  h.environment.pathRef.current = '/beta'; releases[0](); await h.step();
  assert.equal(h.state()['/alpha'].resumeRead, false); assert.equal(h.calls.length, 1);
  h.reply('/'); await reading; releases[1](); await Promise.all(occupied); await h.step();
  assert.equal(h.environment.refreshingRef.current, false);
});

test('刷新后的父页没有可选快照编号时仍发布已验证的当前目录', async () => {
  const h = harness(), reading = h.refresh(); await h.step();
  h.reply('/', { snapshotId: undefined }); await h.step();
  h.reply('/alpha', h.fresh('/alpha')); await reading; await h.step();
  assert.equal(hasFresh(h), true); assert.notEqual(h.state()['/alpha'].loadedAt, 0);
  assert.equal(h.environment.refreshingRef.current, false);
});

test('没有快照编号的父页也必须匹配请求代次，不能发布旧预取', async () => {
  const h = harness(), reading = h.refresh(); await h.step();
  h.reply('/', { snapshotId: undefined }); await h.step();
  const newer = h.load('/'); await h.step();
  h.reply('/alpha', h.fresh('/alpha')); await reading; await h.step();
  assert.equal(hasFresh(h), false);
  h.reply('/', { snapshotId: undefined }); await newer; await h.step();
  assert.equal(hasFresh(h), false); assert.equal(h.state()['/alpha'].loadedAt, 0);
});


test('手动展开优先于刷新队列中其他已展开分支，不提高在途上限', async () => {
  const h = harness('/'); h.expand('/alpha','/beta');
  const releases = [];
  const occupied = ['one','two'].map(key => h.queue.run({}, key, () => new Promise(resolve => releases.push(resolve)), () => true));
  await h.step();
  const refreshing = h.refresh(); await h.step(); h.reply('/'); await h.step();
  assert.deepEqual(h.calls.map(call => call.input.path), ['/','/beta']);
  const clicked = h.load('/alpha/nested'); await h.step();
  releases[0](); await h.step();
  try {
    assert.equal(h.calls.at(-1).input.path, '/alpha/nested', '新展开不能排在旧的其他分支刷新之后');
    assert.ok(h.calls.filter(call => !call.done).length <= 2, '另一个在途占位仍计入三个目录名额');
  } finally {
    releases[1]();
    for (let i=0;i<8;i++) {
      for (const call of h.calls.filter(call => !call.done)) h.reply(call.input.path);
      await h.step();
    }
    await Promise.all([...occupied,refreshing,clicked]);
  }
  assert.equal(h.environment.refreshingRef.current,false);
  assert.equal(h.calls.filter(call => call.input.path === '/alpha').length,1,'后台刷新最终仍完成且不重复');
});
