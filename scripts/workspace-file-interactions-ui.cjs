const assert = require('node:assert/strict');

module.exports = async function testWorkspaceFileInteractions({evaluate,click,doubleClick,clickText,until,wait,win,previewReads,writes,terminalSessions,errors}) {
  const row = path => '[role="treeitem"][title=' + JSON.stringify(path) + ']';
  const panel = '.server-workspace:not([hidden]) .server-terminal-tab-panel:not([hidden])[data-input-active=true]';
  const terminal = panel + ' .server-terminal-container';
  const quote = path => "'" + path.replace(/'/g, "'\"'\"'") + "'";
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const paneState = () => evaluate("(() => { const panes = [...document.querySelectorAll(" + JSON.stringify(panel) + ")], pane = panes[0], section = pane?.querySelector('[data-session-status]'), target = pane?.querySelector('.server-terminal-container'), rect = target?.getBoundingClientRect(), tabId = pane?.dataset.terminalId; return {connected:Boolean(pane?.closest('.server-workspace')?.querySelector('.server-workspace-header [data-status=connected]')),activePaneCount:panes.length,tabId:tabId === 'default' || /^[0-9a-f-]{36}$/i.test(tabId ?? '') ? tabId : null,status:['idle','opening','open','closed','waiting'].includes(section?.dataset.sessionStatus) ? section.dataset.sessionStatus : null,visible:Boolean(pane?.getClientRects().length),dialogPresent:Boolean(document.querySelector('[role=dialog]:not([hidden]),[role=alertdialog]:not([hidden])')),rect:rect ? {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)} : null}; })()");
  const bindCurrentSession = async label => {
    const state = await paneState();
    assert.equal(state.connected, true, label + '：服务器保持已连接');
    assert.equal(state.activePaneCount, 1, label + '：唯一可见活动终端');
    assert.equal(state.visible, true, label + '：当前终端可见');
    assert.equal(state.status, 'open', label + '：当前人工会话已打开');
    assert.ok(state.tabId, label + '：标签使用测试终端标识');
    // 打开记录包含历史已结束会话，必须按当前窗格标签与打开状态精确绑定。
    const matches = [...terminalSessions].filter(([, session]) => session.tabId === state.tabId && session.status === 'open');
    assert.equal(matches.length, 1, label + '：标签唯一绑定一个打开的会话');
    assert.match(matches[0][0], /^terminal-\d+$/, label + '：使用合成会话标识');
    return {tabId:state.tabId,sessionId:matches[0][0]};
  };
  await until(has(panel), '拖拽准备当前活动终端');
  const initialState = await paneState();
  assert.equal(initialState.connected, true, '拖拽准备必须先连接服务器');
  assert.equal(initialState.activePaneCount, 1, '拖拽准备唯一可见活动终端');
  assert.equal(initialState.visible, true, '拖拽准备终端实际可见');
  assert.ok(initialState.tabId, '拖拽准备有效终端标签');
  const beforePreparation = writes.length;
  // 前序监控会主动断开服务器；只在测试入口由人工按钮重新打开原标签，负例不自动恢复。
  if (initialState.status === 'closed') {
    await until(has(panel + ' [data-testid=terminal-ended-actions] button') + '?.disabled === false', '人工重开入口可用');
    await click(panel + ' [data-testid=terminal-ended-actions] button');
  }
  await until(has(panel + ' [data-session-status=open]'), '拖拽准备人工终端已打开');
  const initialBinding = await bindCurrentSession('初始拖拽终端');
  assert.equal(initialBinding.tabId, initialState.tabId, '准备只重开原活动标签');
  assert.equal(writes.length, beforePreparation, '准备终端不发送输入');
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
    if (accepted) {
      try { await until(has(terminal + '[data-path-drag-over=true]'), '有效路径拖拽显示终端边框'); }
      catch (error) {
        process.stderr.write('文件拖拽状态诊断：' + JSON.stringify(await paneState()) + '\n');
        throw error;
      }
    }
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
    const currentBinding = await bindCurrentSession('预览关闭后拖拽终端');
    assert.deepEqual(currentBinding, initialBinding, '文件预览关闭后返回原人工会话');
    const currentSession = currentBinding.sessionId;
    const previewCount = previewReads.length;
    const currentDirectory = await evaluate("document.querySelector('.server-path-breadcrumbs').title");
    for (const path of ['/srv/example.conf','/srv/config','/srv/带空格目录 ',"/srv/带 空格'$(echo literal).conf"]) {
      const before = writes.length;
      await dragPath(path);
      assertWrite(before,path,currentSession);
    }
    assert.equal(previewReads.length, previewCount, '拖拽不打开文件内容');
    assert.equal(await evaluate(has(row('/srv/config')) + ".getAttribute('aria-expanded')"), 'false', '拖拽不展开目录');
    assert.equal(await evaluate("document.querySelector('.server-path-breadcrumbs').title"), currentDirectory, '拖拽不改变浏览路径或上传目标');

    const beforeCancel = writes.length;
    await dragPath('/srv/example.conf',{cancel:true});
    assert.equal(writes.length, beforeCancel, '取消拖拽不发送路径');
    await drop({items:[{mimeType:'text/plain',data:'/external\ncommand'}],dragOperationsMask:1},{accepted:false});
    await drop({items:[{mimeType:'application/x-runbook-workspace-path',data:'forged'}],dragOperationsMask:1},{accepted:false});
    assert.equal(writes.length, beforeCancel, '外部文本与失效标识不进入终端');

    await click('[aria-label="新增终端"]');
    await until(has(panel) + '?.dataset.terminalId !== ' + JSON.stringify(currentBinding.tabId) + ' && Boolean(' + has(panel) + ')', '新增终端切换到独立活动标签');
    await until(has(panel + ' [data-session-status=open]'), '第二个终端会话已打开');
    await until(has(panel + ' .xterm-rows') + "?.textContent.includes('operator@demo')", '第二个终端就绪');
    const secondBinding = await bindCurrentSession('第二个拖拽终端');
    assert.notEqual(secondBinding.tabId, currentBinding.tabId, '新增终端使用独立标签');
    assert.notEqual(secondBinding.sessionId, currentSession, '新增终端绑定独立会话');
    const secondSession = secondBinding.sessionId, beforeSecond = writes.length;
    await dragPath('/srv/example.conf');
    assertWrite(beforeSecond,'/srv/example.conf',secondSession);
    const activeClose = await evaluate("document.querySelector('.server-terminal-tabs [role=tab][aria-selected=true]').parentElement.querySelector('button[aria-label^=关闭]').getAttribute('aria-label')");
    await click('[aria-label=' + JSON.stringify(activeClose) + ']');
    await until(has(panel) + '?.dataset.terminalId === ' + JSON.stringify(currentBinding.tabId), '关闭第二终端返回原标签');
    assert.deepEqual(await bindCurrentSession('关闭第二终端后'), currentBinding, '返回原标签仍绑定原会话');
    await wait(180);
    assert.equal(writes.length, beforeSecond + 1, '切回其他标签不重放路径');

    await clickText('结束会话');
    await until(has(panel + ' [data-session-status=closed]'), '人工结束当前会话状态');
    await until(has(panel) + "?.textContent.includes('会话已结束')", '结束终端');
    const beforeClosed = writes.length;
    await dragPath('/srv/example.conf',{accepted:false});
    await click(panel + ' [data-testid=terminal-ended-actions] button');
    await until(has(panel + ' [data-session-status=open]'), '手动重开后会话状态已打开');
    await until(has(panel + ' .xterm-rows') + "?.textContent.includes('operator@demo')", '重新打开终端');
    const reopenedBinding = await bindCurrentSession('负例后手动重开终端');
    assert.equal(reopenedBinding.tabId, currentBinding.tabId, '负例后手动重开原标签');
    assert.notEqual(reopenedBinding.sessionId, currentSession, '手动重开建立新会话');
    await wait(180);
    assert.equal(writes.length, beforeClosed, '结束期间的拖拽不会在重新打开后补发');
    assert.deepEqual(errors, [], '双击和拖拽无 Renderer 错误');
  } finally {
    await debuggerApi.sendCommand('Input.setInterceptDrags',{enabled:false});
    debuggerApi.removeListener('message',onMessage);
    if (!alreadyAttached) debuggerApi.detach();
  }
};
