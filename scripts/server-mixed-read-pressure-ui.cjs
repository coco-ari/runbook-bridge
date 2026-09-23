const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const directories = ['alpha', 'beta', 'gamma'];
const files = ['first.txt', 'second.txt', 'cancel-preview.txt', 'survivor.txt', 'properties.txt', 'cancel-info.txt'];
const previewContent = target => '合成文件内容：' + target + '\n混合读取压力验证\n';

// 三类请求共用四个后台读取名额，所有内容均为合成数据。
exports.createHarness = () => {
  const state = { reads: [], attempts: [], pending: [], active: 0, peak: 0, busy: 0, jobs: [], uploadPolls: 0, hold: new Set(['directory', 'preview', 'info']) };
  const read = async (kind, input, response) => {
    const record = { kind, path: input.path, done: false };
    state.attempts.push(record);
    if (state.active >= 4) {
      state.busy += 1;
      record.code = 'WORKSPACE_BUSY';
      throw Object.assign(new Error('文件读取较多，请稍后重试。'), { code: record.code });
    }
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    state.reads.push(record);
    try {
      if (state.hold.has(kind) && !(kind === 'directory' && input.path === '/')) await new Promise(resolve => state.pending.push({ kind, resolve }));
      return response();
    } finally {
      record.done = true;
      state.active -= 1;
    }
  };
  state.read = input => read('directory', input, () => {
    const root = input.path === '/';
    return { path: input.path, canonicalPath: input.path, snapshotId: randomUUID(), nextCursor: null, truncated: false,
      entries: (root ? [...directories, ...files] : ['item.txt']).map(name => ({ name, path: (root ? '' : input.path) + '/' + name,
        type: root && directories.includes(name) ? 'directory' : 'file', size: 512, mode: 0o100644, mtime: 1 })) };
  });
  state.preview = input => read('preview', input, () => {
    const content = previewContent(input.path);
    const size = Buffer.byteLength(content);
    return { path: input.path, content, size, startByte: 0, endByte: size, mtime: 1, truncated: false, nextCursor: null };
  });
  state.info = input => read('info', input, () => ({ path: input.path, name: input.path.slice(1), canonicalPath: input.path,
    type: 'file', size: 512, mtime: 1, mode: 0o100644, observedAt: Date.now() }));
  state.release = kind => {
    if (kind) state.hold.delete(kind); else state.hold.clear();
    for (const pending of [...state.pending]) if (!kind || pending.kind === kind) {
      state.pending.splice(state.pending.indexOf(pending), 1);
      pending.resolve();
    }
  };
  return state;
};

exports.run = async ({ state, evaluate, click, doubleClick, clickText, until, wait, win }) => {
  assert.equal(win.isVisible(), false, '混合读取专项必须保持原生窗口隐藏');
  const row = target => '[role=treeitem][title=' + JSON.stringify(target) + ']';
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const waitState = async (predicate, label) => {
    for (let index = 0; index < 200 && !predicate(); index += 1) await wait(15);
    assert.ok(predicate(), label);
  };
  const openPreview = async target => {
    await until(has(row(target)), '预览目标文件行存在');
    await evaluate(has(row(target)) + '.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"})');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await until('(() => { const item=' + has(row(target)) + '; if(!item) return false; const rect=item.getBoundingClientRect(); const viewport=item.closest(".server-tree-scroll").getBoundingClientRect(); const x=Math.round(rect.left+65), y=Math.round(rect.top+rect.height/2); return rect.height>0 && x>=viewport.left && x<viewport.right && y>=viewport.top && y<viewport.bottom && document.elementFromPoint(x,y)?.closest("[role=treeitem]")?.getAttribute("title")===' + JSON.stringify(target) + '; })()', '预览双击坐标命中已滚动到可见区域的目标文件');
    await doubleClick(row(target));
    await until(has('.server-file-preview [role=tab][title=' + JSON.stringify(target) + ']'), '预览标签创建');
  };
  const openInfo = async target => {
    await until('!' + has('[role=dialog]'), '旧属性弹窗关闭');
    await evaluate(has(row(target)) + '.scrollIntoView({block:"nearest"})');
    await evaluate('(() => { const item=' + has(row(target)) + '; const rect=item.getBoundingClientRect(); item.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2,clientX:rect.left+70,clientY:rect.top+rect.height/2})); })()');
    await until(has('[role=menu]'), '文件操作菜单出现');
    assert.ok(await evaluate('(() => { const item=[...document.querySelectorAll("[role=menuitem]")].find(item=>item.textContent.trim()==="查看属性"); if(!item || item.getAttribute("aria-disabled")==="true") return false; item.click(); return true; })()'));
    await until(has('[role=dialog]') + '?.textContent.includes(' + JSON.stringify(target) + ')', '属性弹窗创建');
  };
  const previewReady = async target => {
    await click('.server-file-preview [role=tab][title=' + JSON.stringify(target) + ']');
    await until(has('.server-preview-tab-panel:not([hidden]) .server-preview-content') + '?.textContent === ' + JSON.stringify(previewContent(target)), '预览完整内容到达');
  };
  const infoReady = target => until('(() => { const list=' + has('.server-file-properties') + '; if(!list) return false; const values=[...list.querySelectorAll("dd")].map(item=>item.textContent); return values.length===6 && values[0]===' + JSON.stringify(target.slice(1)) + ' && values[1]==="文件" && values[2]==="512 B" && values[4]==="0644" && values[5]===' + JSON.stringify(target) + '; })()', '属性路径、类型、大小和权限正确');
  const counts = () => Object.fromEntries(['directory', 'preview', 'info'].map(kind => [kind, state.reads.filter(item => item.kind === kind).length]));
  const summary = scenarios => ({ scenarios, reads: counts(), peak: state.peak, busy: state.busy, windowVisible: win.isVisible() });
  try {
    await until(has(row('/properties.txt')), '合成根目录就绪');
    for (const name of directories) await click(row('/' + name));
    await waitState(() => state.active === 3, '三个慢目录仍未完成');
    await openPreview('/first.txt');
    await waitState(() => state.active === 4, '目录与首个预览共同占满四个读取名额');
    await openPreview('/second.txt');
    await openInfo('/properties.txt');
    await wait(150);

    if (process.env.RUNBOOK_BRIDGE_MIXED_READ_PRESSURE_BASELINE === '1') {
      assert.deepEqual(state.attempts.filter(item => item.code).map(({ kind, path, code }) => ({ kind, path, code })), [
        { kind: 'preview', path: '/second.txt', code: 'WORKSPACE_BUSY' },
        { kind: 'info', path: '/properties.txt', code: 'WORKSPACE_BUSY' },
      ], '旧构建复现后续预览与属性的忙错误');
      assert.equal(await evaluate(has('[role=dialog] [role=alert]') + '?.textContent.includes("文件读取较多")'), true);
      return { baseline: true, ...summary(1), rejected: state.attempts.filter(item => item.code).map(({ kind, path, code }) => ({ kind, path, code })) };
    }

    assert.equal(state.busy, 0, '超出四个名额的预览和属性应等待，不向后台发送忙请求');
    assert.deepEqual(counts(), { directory: 4, preview: 1, info: 0 }, '等待中的请求尚未进入后台');
    state.release('directory');
    await waitState(() => counts().preview === 2, '目录释放后自动执行第二个预览');
    await wait(150);
    assert.equal(counts().info, 0, '两个预览占用普通读取名额时属性继续等待');
    state.release('preview');
    await waitState(() => counts().info === 1, '预览释放后自动执行等待属性');
    state.release('info');
    await infoReady('/properties.txt');
    await clickText('关闭');
    for (const name of directories) await until(has(row('/' + name + '/item.txt')), '慢目录内容完整显示');
    await previewReady('/first.txt'); await previewReady('/second.txt');
    for (const target of ['/first.txt', '/second.txt']) await click('[aria-label=' + JSON.stringify('关闭' + target) + ']');
    await waitState(() => state.active === 0, '第一轮请求全部完成');

    // 推进 Renderer 缓存年龄，再次形成四个占用和多个等待任务。
    for (const name of directories) await click(row('/' + name));
    await evaluate('window.mixedReadOriginalNow=Date.now; Date.now=()=>window.mixedReadOriginalNow()+31000; undefined;');
    for (const kind of ['directory', 'preview', 'info']) state.hold.add(kind);
    const from = state.reads.length;
    for (const name of directories) await click(row('/' + name));
    await waitState(() => state.active === 3, '第二轮三个慢目录仍未完成');
    await openPreview('/first.txt');
    await waitState(() => state.active === 4, '第二轮四个读取名额被占用');
    await openPreview('/cancel-preview.txt');
    await click('[aria-label="关闭/cancel-preview.txt"]');
    await openPreview('/survivor.txt');
    await openInfo('/cancel-info.txt');
    await clickText('关闭');
    await openInfo('/properties.txt');
    assert.equal(state.busy, 0, '等待取消和新增任务均不产生忙错误');
    assert.deepEqual(state.reads.slice(from).map(({ kind, path }) => ({ kind, path })), [
      ...directories.map(name => ({ kind: 'directory', path: '/' + name })), { kind: 'preview', path: '/first.txt' },
    ], '关闭的预览和属性仍未向后台发送请求');
    state.release('directory');
    await waitState(() => state.reads.slice(from).some(item => item.path === '/survivor.txt'), '后续保留的预览自动恢复');
    await wait(150);
    assert.equal(state.reads.slice(from).filter(item => item.kind === 'info').length, 0, '第二轮两个预览占用普通读取名额时属性继续等待');
    state.release('preview');
    await waitState(() => state.reads.slice(from).filter(item => item.kind === 'info').length === 1, '第二轮预览释放后保留的属性自动恢复');
    state.release('info');
    await infoReady('/properties.txt'); await clickText('关闭');
    await previewReady('/first.txt'); await previewReady('/survivor.txt');
    await waitState(() => state.active === 0, '第二轮请求全部完成');
    assert.ok(state.reads.slice(from).every(item => !['/cancel-preview.txt', '/cancel-info.txt'].includes(item.path)), '关闭等待中的预览和属性后永不补发请求');
    assert.equal(await evaluate('Boolean(' + has('.server-file-preview [role=tab][title="/cancel-preview.txt"]') + ')'), false);
    assert.equal(await evaluate('document.querySelector("[data-testid=server-workspace]").textContent.includes("文件读取较多")'), false);
    assert.equal(state.busy, 0); assert.ok(state.peak <= 4); assert.equal(win.isVisible(), false);
    return { ...summary(2), cancelledBeforeDispatch: 2, survivorRecovered: true };
  } finally {
    state.release();
    await evaluate('if(window.mixedReadOriginalNow){Date.now=window.mixedReadOriginalNow;delete window.mixedReadOriginalNow;}');
  }
};
