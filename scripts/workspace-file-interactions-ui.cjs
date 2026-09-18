const assert = require('node:assert/strict');

module.exports = async function testWorkspaceFileInteractions({evaluate,click,doubleClick,clickText,until,wait,win,previewReads,writes,opened,errors}) {
  const row = path => '[role="treeitem"][title=' + JSON.stringify(path) + ']';
  const panel = '.server-terminal-tab-panel:not([hidden])';
  const terminal = panel + ' .server-terminal-container';
  const quote = path => "'" + path.replace(/'/g, "'\"'\"'") + "'";
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  await until(has(row('/srv')), '拖拽测试根目录');
  await click(row('/srv'));
  await until(has(row('/srv/example.conf')), '文件夹单击展开');
  assert.equal(await evaluate("[...document.querySelectorAll('.server-workspace button')].some(button => button.textContent.includes('填入终端'))"), false, '移除填入终端按钮');

  const beforePreview = previewReads.length;
  await click(row('/srv/example.conf'));
  assert.equal(await evaluate(has(row('/srv/example.conf')) + ".getAttribute('aria-selected')"), 'true');
  await wait(160);
  assert.equal(previewReads.length, beforePreview, '单击文件只选中');
  await doubleClick(row('/srv/example.conf'));
  await until("document.querySelector('.server-file-preview pre')", '双击文件打开预览');
  assert.equal(previewReads.length, beforePreview + 1, '双击只读取一次');
  await click('[aria-label="关闭文件预览"]');
  await evaluate(has(row('/srv/example.log')) + ".focus()");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  await wait(120);
  assert.equal(previewReads.length, beforePreview + 1, '空格只选中文件');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until("document.querySelector('.server-file-preview pre')", 'Enter 保留键盘预览');
  assert.equal(previewReads.length, beforePreview + 2);
  await click('[aria-label="关闭文件预览"]');

  const debuggerApi = win.webContents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  let intercepted = null;
  const onMessage = (_event,method,params) => { if (method === 'Input.dragIntercepted') intercepted = params.data; };
  const point = async selector => {
    const value = await evaluate("(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); if (!element) return null; element.scrollIntoView({block:'nearest'}); const rect = element.getBoundingClientRect(); return {x:Math.round(rect.left + Math.min(75,rect.width / 2)),y:Math.round(rect.top + Math.min(45,rect.height / 2))}; })()");
    assert.ok(value, selector);
    await wait(60);
    return value;
  };
  const beginDrag = async source => {
    const start = await point(source);
    intercepted = null;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
    await debuggerApi.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...start});
    for (const delta of [8,18,30]) {
      await debuggerApi.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:start.x+delta,y:start.y});
      if (intercepted) break;
    }
    const deadline = Date.now() + 3000;
    while (!intercepted && Date.now() < deadline) await wait(20);
    assert.ok(intercepted, '原生鼠标启动目录树拖拽：' + source);
    return intercepted;
  };
  const drop = async (data,{cancel=false,accepted=true}={}) => {
    const target = await point(terminal);
    for (const type of ['dragEnter','dragOver']) await debuggerApi.sendCommand('Input.dispatchDragEvent',{type,...target,data});
    if (accepted) await until(has(terminal + '[data-path-drag-over=true]'), '有效路径拖拽显示终端边框');
    else assert.equal(await evaluate(has(terminal) + ".hasAttribute('data-path-drag-over')"), false, '无效拖拽不显示接受反馈');
    await debuggerApi.sendCommand('Input.dispatchDragEvent',{type:cancel?'dragCancel':'drop',...target,data});
    await debuggerApi.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...target});
    await until("!document.querySelector('[data-path-drag-over=true]')", '结束拖拽清除提示');
    await wait(180);
  };
  const dragPath = async (path,options) => drop(await beginDrag(row(path)),options);
  const assertWrite = (before,path,sessionId) => {
    assert.equal(writes.length, before + 1, '每次拖拽只发送一次');
    assert.equal(writes.at(-1).sessionId, sessionId, '仅写入当前终端');
    assert.equal(writes.at(-1).data.replace(/^\x1b\[200~|\x1b\[201~$/g,''), quote(path), '完整路径转义且不附加执行回车');
  };
  if (!alreadyAttached) debuggerApi.attach('1.3');
  debuggerApi.on('message',onMessage);
  try {
    // 原生鼠标触发拖拽，由 Chromium 接管投放，避免测试进入系统拖拽循环。
    await debuggerApi.sendCommand('Input.setInterceptDrags',{enabled:true});
    const currentSession = opened.at(-1);
    const previewCount = previewReads.length;
    const currentDirectory = await evaluate("document.querySelector('.server-file-current-path').textContent");
    for (const path of ['/srv/example.conf','/srv/config','/srv/带空格目录 ',"/srv/带 空格'$(echo literal).conf"]) {
      const before = writes.length;
      await dragPath(path);
      assertWrite(before,path,currentSession);
    }
    assert.equal(previewReads.length, previewCount, '拖拽不打开文件内容');
    assert.equal(await evaluate(has(row('/srv/config')) + ".getAttribute('aria-expanded')"), 'false', '拖拽不展开目录');
    assert.equal(await evaluate("document.querySelector('.server-file-current-path').textContent"), currentDirectory, '拖拽不改变浏览路径或上传目标');

    const beforeCancel = writes.length;
    await dragPath('/srv/example.conf',{cancel:true});
    assert.equal(writes.length, beforeCancel, '取消拖拽不发送路径');
    await drop({items:[{mimeType:'text/plain',data:'/external\ncommand'}],dragOperationsMask:1},{accepted:false});
    await drop({items:[{mimeType:'application/x-runbook-workspace-path',data:'forged'}],dragOperationsMask:1},{accepted:false});
    assert.equal(writes.length, beforeCancel, '外部文本与失效标识不进入终端');

    await click('[aria-label="新增终端"]');
    await until(has(panel + ' .xterm-rows') + "?.textContent.includes('operator@demo')", '第二个终端就绪');
    const secondSession = opened.at(-1), beforeSecond = writes.length;
    await dragPath('/srv/example.conf');
    assertWrite(beforeSecond,'/srv/example.conf',secondSession);
    const activeClose = await evaluate("document.querySelector('.server-terminal-tabs [role=tab][aria-selected=true]').parentElement.querySelector('button[aria-label^=关闭]').getAttribute('aria-label')");
    await click('[aria-label=' + JSON.stringify(activeClose) + ']');
    await wait(180);
    assert.equal(writes.length, beforeSecond + 1, '切回其他标签不重放路径');

    await clickText('结束会话');
    await until(has(panel) + "?.textContent.includes('会话已结束')", '结束终端');
    const beforeClosed = writes.length;
    await dragPath('/srv/example.conf',{accepted:false});
    await clickText('打开终端');
    await until(has(panel + ' .xterm-rows') + "?.textContent.includes('operator@demo')", '重新打开终端');
    await wait(180);
    assert.equal(writes.length, beforeClosed, '结束期间的拖拽不会在重新打开后补发');
    assert.deepEqual(errors, [], '双击和拖拽无 Renderer 错误');
  } finally {
    await debuggerApi.sendCommand('Input.setInterceptDrags',{enabled:false});
    debuggerApi.removeListener('message',onMessage);
    if (!alreadyAttached) debuggerApi.detach();
  }
};
