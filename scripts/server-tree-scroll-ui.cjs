const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// 全部目录与文件均为合成数据，不读取真实服务器。
const longName = 'z-' + '中文宽文件名称-'.repeat(9) + 'WWWW-backup.tar.gz';
const linkTarget = '/synthetic/' + 'long-target-directory/'.repeat(5) + 'target.conf';
exports.createHarness = () => ({
  jobs: [], uploadPolls: 0,
  async read(input) {
    const entry = (name, type = 'file', extra = {}) => ({ name, path: (input.path === '/' ? '' : input.path) + '/' + name, type, size: 10, mode: 0o644, mtime: 1, ...extra });
    const entries = input.path === '/' ? [entry('alpha', 'directory'), entry('short.txt')]
      : input.path === '/alpha' ? [entry('nested', 'directory'), entry('a-shortcut', 'symlink', { linkTarget, linkTargetType: 'file' }),
        ...Array.from({ length: 180 }, (_, index) => entry('file-' + String(index).padStart(3, '0') + '.txt')), entry(longName)]
      : [entry(longName)];
    return { path: input.path, canonicalPath: input.path, snapshotId: input.snapshotId ?? randomUUID(), entries, nextCursor: null, truncated: false, metadataPending: false };
  },
});

exports.run = async ({ evaluate, click, until, wait, win }) => {
  const tree = 'document.querySelector(".server-tree-scroll")';
  const row = name => '[role=treeitem][title="' + name + '"]';
  const metrics = () => evaluate(`(() => {
    const tree = ${tree};
    return { width: tree.clientWidth, content: tree.scrollWidth, left: tree.scrollLeft, top: tree.scrollTop,
      mounted: tree.querySelectorAll('[role=treeitem]').length,
      toolbar: document.querySelector('.server-file-toolbar').getBoundingClientRect().left,
      navigation: document.querySelector('.server-file-navigation').getBoundingClientRect().left };
  })()`);
  const scroll = async (top, left = 0) => {
    await evaluate(`${tree}.scrollTo({top:${top},left:${left}})`);
    await until(`(() => { const tree=${tree}, first=tree.querySelector('[data-tree-index]'); return first && Number(first.dataset.treeIndex) <= Math.floor(tree.scrollTop / 32) && Number(first.dataset.treeIndex) >= Math.max(0, Math.floor(tree.scrollTop / 32) - 8); })()`, '虚拟窗口跟随真实滚动');
    await wait(80);
  };
  await until('Boolean(document.querySelector(' + JSON.stringify(row('/alpha')) + '))', '合成根目录就绪');
  assert.equal((await metrics()).content, (await metrics()).width, '短名称不出现无意义横向滚动');
  await click(row('/alpha'));
  await until(`${tree}.scrollWidth > ${tree}.clientWidth + 400`, '未挂载的长名称也撑出横向滚动范围');
  assert.equal(await evaluate(`${tree}.querySelectorAll('[role=treeitem][tabindex="0"]').length`), 1, '虚拟树只有一个条目 Tab 入口');
  assert.equal(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(row('/alpha'))});return e.getAttribute('aria-posinset')==='1'&&e.getAttribute('aria-setsize')==='2'})()`),true,'树条目提供逻辑兄弟位置和集合大小');
  await evaluate(`document.querySelector(${JSON.stringify(row('/alpha'))}).focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
  await until(`document.activeElement?.title === '/alpha/nested'`, '右键方向进入已展开目录的首个子项');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))");
  await until("document.activeElement?.title === '/alpha'", '左键方向回到父目录');
  win.webContents.focus();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await wait(100);
  assert.equal(await evaluate(`${tree}.contains(document.activeElement)`),false,'Tab 不遍历目录条目和下载按钮');
  const initial = await metrics();
  assert.ok(initial.mounted < 80, '仍然使用虚拟列表');
  assert.equal(await evaluate('Boolean(document.querySelector(' + JSON.stringify(row('/alpha/' + longName)) + '))'), false, '最长名称初始处于虚拟窗口外');
  await scroll(99999, 99999);
  await until('Boolean(document.querySelector(' + JSON.stringify(row('/alpha/' + longName)) + '))', '纵向滚动挂载长名称');
  const end = await metrics();
  assert.equal(end.content, initial.content, '虚拟窗口切换不改变横向宽度');
  assert.ok(end.left > 0 && end.top > 0, '两个方向可同时滚动');
  assert.equal(end.toolbar, initial.toolbar, '工具栏固定');
  assert.equal(end.navigation, initial.navigation, '路径栏固定');
  const assertNameVisible = async () => {
    const bounds = await evaluate(`(() => {
      const tree = ${tree}, name = document.querySelector(${JSON.stringify(row('/alpha/' + longName))}).querySelector('.server-tree-name');
      return { right: name.getBoundingClientRect().right, viewportRight: tree.getBoundingClientRect().left + tree.clientWidth, left: tree.getBoundingClientRect().left, top: name.getBoundingClientRect().top, bottom: name.getBoundingClientRect().bottom, viewportTop: tree.getBoundingClientRect().top, viewportBottom: tree.getBoundingClientRect().top + tree.clientHeight,
        width: name.clientWidth, full: name.scrollWidth, overflow: getComputedStyle(name).textOverflow };
    })()`);
    assert.ok(bounds.right > bounds.left, '文件名尾部位于可见范围');
    assert.ok(bounds.top >= bounds.viewportTop && bounds.bottom <= bounds.viewportBottom, '长文件行纵向可见');
    assert.ok(bounds.right <= bounds.viewportRight, '滚动到右端可看到文件名尾部');
    assert.equal(bounds.width, bounds.full, '完整名称没有内部裁切');
    assert.equal(bounds.overflow, 'clip', '目录树名称不使用省略号');
  };
  await assertNameVisible();
  await click(row('/alpha/' + longName));
  assert.equal((await metrics()).left, end.left, '选择行不重置横向位置');
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp',bubbles:true}))`);
  await wait(150);
  assert.equal((await metrics()).left, end.left, '键盘上下移动保留横向位置');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}))");
  await until("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='下载')",'单入口仍能通过 Shift+F10 获取下载操作');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until("!document.querySelector('[role=menu]')",'文件操作菜单关闭');
  await scroll(0, 99999);
  assert.equal(await evaluate(`${tree}.contains(document.activeElement) && document.activeElement.getAttribute('role')==='treeitem'`),true,'屏外活动节点保留焦点，不因虚拟滚动落到 body');
  assert.equal((await metrics()).content, initial.content, '最长行卸载后保留滚动范围');
  assert.equal(await evaluate(`(() => { const label=document.querySelector('.server-tree-link-target'); return label.clientWidth === label.scrollWidth && getComputedStyle(label).textOverflow === 'clip'; })()`), true, '链接目标完整显示');
  await scroll(0);
  await click(row('/alpha/nested'));
  await until('Boolean(document.querySelector(' + JSON.stringify(row('/alpha/nested/' + longName)) + '))', '深层目录展开');
  assert.ok((await metrics()).content >= initial.content + 18, '目录深度计入内容宽度');
  await click(row('/alpha/nested'));
  await click('[aria-label="切换到详情列表"]');
  await until('Boolean(document.querySelector(".server-file-tree[data-view=details]"))', '详情列表就绪');
  assert.equal((await metrics()).content, (await metrics()).width, '详情列表保留原有列布局');
  await click('[aria-label="切换到目录树"]');
  await until(`${tree}.scrollWidth > ${tree}.clientWidth + 400`, '返回目录树恢复横向范围');
  for (const zoom of [1, 1.25]) {
    win.setContentSize(1000, 750);
    win.webContents.setZoomFactor(zoom);
    await wait(200);
    await scroll(99999, 99999);
    await assertNameVisible();
  }
  await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  win.webContents.invalidate();
  await wait(180);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const artifact = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR
    ? path.resolve(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR, 'server-tree-horizontal-scroll.png')
    : path.resolve(__dirname, '../artifacts/server-tree-horizontal-scroll.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  win.webContents.setZoomFactor(1);
  win.setContentSize(1440, 920);
  await scroll(0);
  await click('[aria-label="收起所有目录"]');
  await until(`${tree}.scrollWidth === ${tree}.clientWidth`, '收起长名称分支后移除横向滚动');
  assert.equal((await metrics()).left, 0, '宽度缩小后横向位置归零');
  assert.equal(await evaluate(`${tree}.querySelectorAll('[role=treeitem][tabindex="0"]').length`),1,'收起后的树仍有可达单入口');
  return { scenarios: 12, virtualRows: initial.mounted, contentWidth: initial.content, windowVisible: win.isVisible() };
};
