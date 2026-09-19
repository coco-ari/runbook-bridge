const assert = require('node:assert/strict');

module.exports = async function testWorkspaceLocations({ evaluate, click, until, wait, win, setViewport, snapshot, terminalSessions, directoryState, writes, previewReads, errors }) {
  await setViewport(1440, 920);
  const button = '[aria-label="定位终端当前目录"]';
  const row = target => '.server-tree-row[title=' + JSON.stringify(target) + ']';
  const selected = target => 'document.querySelector(' + JSON.stringify(row(target)) + ')?.getAttribute("aria-selected")==="true"';
  const pathTitle = 'document.querySelector(".server-path-breadcrumbs")?.title';
  const activeTab = '.server-terminal-tabs [role=tab][aria-selected=true]';
  const session = async () => {
    const panel = await evaluate('document.querySelector(' + JSON.stringify(activeTab) + ').getAttribute("aria-controls")');
    return [...terminalSessions.entries()].find(([, item]) => item.status === 'open' && panel.endsWith('-panel-' + item.tabId))?.[0];
  };
  const enterPath = async target => {
    if (!(await evaluate('!!document.querySelector(".server-path-editor")'))) await click('[aria-label="编辑目录路径"]');
    await evaluate('document.querySelector("[aria-label=目录路径]").select()');
    win.webContents.focus();
    await win.webContents.insertText(target);
    await until('document.querySelector("[aria-label=目录路径]")?.value===' + JSON.stringify(target), '路径输入完成');
    win.webContents.sendInputEvent({ type:'keyDown', keyCode:'Enter' });
    win.webContents.sendInputEvent({ type:'char', keyCode:'\r' });
    win.webContents.sendInputEvent({ type:'keyUp', keyCode:'Enter' });
    await wait(80);
  };
  const locate = async target => {
    await enterPath(target);
    try { await until(selected(target), '输入路径定位：' + target); }
    catch (error) {
      const state = await evaluate('({input:document.querySelector("[aria-label=目录路径]")?.value, path:document.querySelector(".server-path-breadcrumbs")?.title, error:document.querySelector(".server-file-tree [role=status]")?.textContent, rows:[...document.querySelectorAll(".server-tree-row")].map(e=>({title:e.title,selected:e.getAttribute("aria-selected")}))})');
      throw new Error(error.message + '：' + JSON.stringify(state));
    }
  };
  await until('!document.querySelector(' + JSON.stringify(button) + ')?.disabled', '活动终端可以定位');
  await click('[aria-label="根目录"]');

  // 使用原生鼠标单击面包屑右侧空白，避免只验证程序化点击。
  const point = await evaluate('(() => { const e=document.querySelector(".server-path-breadcrumbs"); const r=e.getBoundingClientRect(); const x=Math.round(r.right-4), y=Math.round(r.top+r.height/2); return {x,y,blank:document.elementFromPoint(x,y)===e}; })()');
  assert.ok(point.blank, '路径右侧有可点击空白');
  win.webContents.focus();
  win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x:point.x, y:point.y });
  win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:point.x, y:point.y });
  await until('document.activeElement?.getAttribute("aria-label")==="目录路径"', '单击空白进入路径输入');
  await locate('/srv/config/example.conf');
  assert.equal(await evaluate(pathTitle), '/srv/config');
  const beforePreview = previewReads.length;
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/srv')) + ')?.getAttribute("aria-level")'), '1');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/srv/config')) + ')?.getAttribute("aria-level")'), '2');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/srv/config/example.conf')) + ')?.getAttribute("aria-level")'), '3');
  await click('.server-path-breadcrumbs button[title="定位到 /srv"]');
  await until(selected('/srv'), '面包屑保留根目录并高亮');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/srv/config')) + ')?.getAttribute("aria-expanded")'), 'true');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/usr')) + ')?.getAttribute("aria-level")'), '1');
  await locate('/srv/config');
  await click('[aria-label="上级目录"]');
  await until(selected('/srv'), '上级按钮只改变选择');
  assert.equal(previewReads.length, beforePreview, '路径定位不自动预览文件');
  await locate('/srv/带空格目录 ');
  assert.equal(await evaluate(pathTitle), '/srv/带空格目录 ');
  await locate('/.env.example');
  assert.equal(await evaluate('document.querySelector("[aria-label=显示隐藏文件]").getAttribute("aria-pressed")'), 'true');
  await locate('/file-999.txt');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(row('/file-999.txt')) + ')?.getAttribute("aria-level")'), '1');
  await locate('/srv/config/example.conf');
  await enterPath('/missing-location/example.conf');
  await until('document.querySelector(".server-file-tree [role=status]")?.textContent.includes("未找到")', '不存在的路径明确报错');
  assert.ok(await evaluate(selected('/srv/config/example.conf')), '定位失败保留原选择');
  await snapshot('server-workspace-path-location.png');

  const firstTitle = await evaluate('document.querySelector(' + JSON.stringify(activeTab) + ').title');
  const first = await session();
  assert.ok(first);
  const writesBefore = writes.length;
  terminalSessions.get(first).cwd = '/srv/config';
  await click(button);
  await until(selected('/srv/config'), '定位当前终端目录');
  assert.equal(directoryState.requests.at(-1).sessionId, first);
  terminalSessions.get(first).cwd = '/etc/config';
  await click(button);
  await until(selected('/etc/config'), '再次点击读取最新工作目录');
  assert.equal(writes.length, writesBefore, '查询不向终端发送命令');

  await click('[aria-label="新增终端"]');
  await until('!document.querySelector(' + JSON.stringify(button) + ')?.disabled', '新增终端会话就绪');
  const second = await session();
  assert.ok(second && second !== first);
  const secondTitle = await evaluate('document.querySelector(' + JSON.stringify(activeTab) + ').title');
  terminalSessions.get(second).cwd = '/home/config';
  await click(button);
  await until(selected('/home/config'), '第二个终端使用自己的目录');
  assert.equal(directoryState.requests.at(-1).sessionId, second);
  await click('.server-terminal-tabs [role=tab][title=' + JSON.stringify(firstTitle) + ']');
  await click(button);
  await until(selected('/etc/config'), '切回原终端定位原会话');

  terminalSessions.get(first).cwd = '/opt/config/config/config';
  await click(button);
  await click('.server-terminal-tabs [role=tab][title=' + JSON.stringify(secondTitle) + ']');
  await wait(800);
  assert.ok(await evaluate(selected('/etc/config')), '目录响应已到达但祖先仍加载时，切换标签也取消定位');
  await click('.server-terminal-tabs [role=tab][title=' + JSON.stringify(firstTitle) + ']');
  directoryState.delay = 500;
  terminalSessions.get(first).cwd = '/srv/config';
  await click(button);
  await click('.server-terminal-tabs [role=tab][title=' + JSON.stringify(secondTitle) + ']');
  await wait(600);
  assert.ok(await evaluate(selected('/etc/config')), '切换标签后忽略旧目录结果');
  await click(button);
  await click('[aria-label="编辑目录路径"]');
  await wait(600);
  assert.ok(await evaluate('!!document.querySelector(".server-path-editor")'), '编辑路径时迟到结果不能关闭输入框');
  await locate('/srv');
  await click(button);
  await locate('/etc');
  await wait(600);
  assert.ok(await evaluate(selected('/etc')), '手动导航优先于在途目录查询');
  await click(button);
  await click('[aria-label=' + JSON.stringify('关闭' + secondTitle) + ']');
  await wait(600);
  assert.ok(await evaluate(selected('/etc')), '关闭标签后忽略该会话目录结果');
  directoryState.delay = 0;
  directoryState.fail = true;
  await click(button);
  await until('document.querySelector(".server-file-tree [role=status]")?.textContent.includes("无法读取")', '不支持目录查询时提示');
  directoryState.fail = false;
  assert.equal(writes.length, writesBefore, '所有目录查询均不写入终端');
  assert.deepEqual(errors, [], '路径定位没有渲染错误');
  await locate('/srv/config');
  await snapshot('server-workspace-terminal-location.png');
};
