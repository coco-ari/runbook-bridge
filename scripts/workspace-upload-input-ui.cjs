const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testWorkspaceUploadInput({evaluate, click, clickText, until, wait, win, temporaryRoot, scope, fileClipboardControl, imports, writes, uploadCount, confirmCount, snapshot}) {
  const localPaths = ['发布 包.jar', '说明.txt'].map(name => path.join(temporaryRoot, name));
  for (const file of localPaths) fs.writeFileSync(file, 'upload-input-fixture');
  const row = remote => '[role="treeitem"][title=' + JSON.stringify(remote) + ']';
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const beforeWrites = writes.length, beforeConfirm = confirmCount(), beforeUploads = uploadCount();
  let clipboardFixture = null;
  const debuggerApi = win.webContents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach('1.3');
  const point = async selector => {
    await evaluate(has(selector) + ".scrollIntoView({block:'nearest'})");
    await wait(60);
    return evaluate("(() => { const rect=" + has(selector) + ".getBoundingClientRect(); return {x:Math.round(rect.left+Math.min(75,rect.width/2)),y:Math.round(rect.top+rect.height/2)}; })()");
  };
  const cancel = async () => {
    await clickText('取消');
    await until("!document.querySelector('[data-testid=upload-confirm-submit]')", '取消文件上传清单');
  };
  const assertReview = async (target, beforeImport) => {
    await until("document.querySelectorAll('[data-testid=upload-file-row]').length===2", '自动列出两个本地文件');
    assert.equal(await evaluate("document.querySelector('[data-testid=upload-destination-path]').textContent"), target);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-testid=upload-source-path]')].map(node=>node.textContent)"), localPaths);
    if (beforeImport !== undefined) assert.equal(imports.length, beforeImport + 1, '每次文件入口只导入一次');
    const {source, ...payload} = imports.at(-1);
    assert.deepEqual(payload, {...scope,path:target,localPaths}, '文件入口保留精确作用域、目录和完整两文件顺序');
    assert.equal(confirmCount(), beforeConfirm, '接收文件后仍需明确点击开始上传');
    assert.equal(writes.length, beforeWrites, '接收文件不向终端发送内容');
    assert.equal(uploadCount(), beforeUploads, '确认前不建立上传任务');
  };
  const pasteFiles = async selector => evaluate("(() => { const data=new DataTransfer(); for(const file of document.querySelector('#upload-input-fixture').files) data.items.add(file); const target="+has(selector)+", event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});target.dispatchEvent(event);return {trusted:event.isTrusted,targetMatches:event.target===target,defaultPrevented:event.defaultPrevented}; })()");
  const drop = async selector => {
    const beforeImport = imports.length;
    const target = await point(selector), data = {items:[], files:localPaths, dragOperationsMask:1};
    for (const type of ['dragEnter','dragOver']) await debuggerApi.sendCommand('Input.dispatchDragEvent',{type,...target,data});
    await until("document.querySelector('.server-upload-drop-hint')", '显示上传目标提示');
    await snapshot('file-upload-drop-target.png');
    await debuggerApi.sendCommand('Input.dispatchDragEvent',{type:'drop',...target,data});
    return beforeImport;
  };
  const focusFolder = async () => {
    win.webContents.focus();
    await evaluate(has(row('/srv/config')) + '.focus()');
    await until('document.hasFocus() && document.activeElement === ' + has(row('/srv/config')), '文件粘贴目标获得实际焦点');
    assert.equal(await evaluate("document.activeElement?.getAttribute('title')"), '/srv/config', '原生快捷键目标严格保持目录行');
  };
  const nativePasteShortcut = async () => {
    await focusFolder();
    await evaluate("(() => { const target=" + has(row('/srv/config')) + "; window.__uploadFileShortcut=null; window.__uploadFileShortcutEvent=null; window.__uploadFileShortcutListener=event=>{ if(event.key.toLowerCase()!=='v'||!event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return; const state={trusted:event.isTrusted,targetMatches:event.target===target,defaultPrevented:false};window.__uploadFileShortcut=state;window.__uploadFileShortcutEvent=event;queueMicrotask(()=>{state.defaultPrevented=event.defaultPrevented;}); };document.addEventListener('keydown',window.__uploadFileShortcutListener,true); })()");
    const reads = fileClipboardControl.reads(), beforeImport = imports.length;
    try {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers:['control']});
      // 捕获阶段的微任务可能先于 React 捕获处理器，独立任务读取原事件的最终阻止状态。
      await until('window.__uploadFileShortcut?.trusted && window.__uploadFileShortcut.targetMatches && window.__uploadFileShortcutEvent?.defaultPrevented', '原生 Ctrl+V 由当前目录接收并阻止默认粘贴');
      const eventState = await evaluate('({trusted:window.__uploadFileShortcut?.trusted,targetMatches:window.__uploadFileShortcut?.targetMatches,defaultPrevented:window.__uploadFileShortcutEvent?.defaultPrevented,sampledPrevented:window.__uploadFileShortcut?.defaultPrevented})');
      assert.deepEqual({trusted:eventState.trusted,targetMatches:eventState.targetMatches,defaultPrevented:eventState.defaultPrevented}, {trusted:true,targetMatches:true,defaultPrevented:true}, '保留可信快捷键和精确目标');
      if (eventState.sampledPrevented !== eventState.defaultPrevented) process.stdout.write('文件快捷键事件时序：' + JSON.stringify(eventState) + '\n');
      return {reads,beforeImport};
    } catch (error) {
      const scopeKey = JSON.stringify([scope.projectId,scope.environmentId,scope.pluginInstanceId]);
      const diagnostic = await evaluate("(() => { const target=" + has(row('/srv/config')) + ", workspace=target?.closest('.server-workspace'), tree=target?.closest('.server-file-tree');return {documentFocused:document.hasFocus(),activeIsTarget:document.activeElement===target,activeWithinTree:Boolean(tree?.contains(document.activeElement)),targetConnected:Boolean(target?.isConnected),targetVisible:Boolean(target?.getClientRects().length),workspaceVisible:Boolean(workspace&&!workspace.hidden&&workspace.getClientRects().length),scopeMatches:workspace?.dataset.workspaceKey===" + JSON.stringify(scopeKey) + ",dialogPresent:[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some(node=>node.getClientRects().length>0),eventReceived:Boolean(window.__uploadFileShortcutEvent),trusted:Boolean(window.__uploadFileShortcut?.trusted),targetMatches:Boolean(window.__uploadFileShortcut?.targetMatches),sampledPrevented:Boolean(window.__uploadFileShortcut?.defaultPrevented),finalPrevented:Boolean(window.__uploadFileShortcutEvent?.defaultPrevented)}; })()");
      process.stderr.write('文件快捷键状态诊断：' + JSON.stringify({...diagnostic,hostFocused:win.webContents.isFocused(),readerCalls:fileClipboardControl.reads()-reads,importCalls:imports.length-beforeImport,confirmCalls:confirmCount()-beforeConfirm,uploadTasks:uploadCount()-beforeUploads}) + '\n');
      throw error;
    } finally {
      await evaluate("document.removeEventListener('keydown',window.__uploadFileShortcutListener,true);delete window.__uploadFileShortcutListener;delete window.__uploadFileShortcut;delete window.__uploadFileShortcutEvent");
    }
  };
  try {
    await click('[aria-label="编辑目录路径"]');
    await evaluate("(() => { const input=document.querySelector('[aria-label=目录路径]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/srv'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await clickText('转到');
    await until(has(row('/srv/config')), '上传测试目录就绪');
    await assertReview('/srv/config', await drop(row('/srv/config')));
    assert.deepEqual(imports.at(-1).localPaths, localPaths, '真实 Chromium 文件通过隔离 preload 解析路径');
    await cancel();

    // 通过浏览器文件输入建立真实磁盘文件对象，覆盖菜单与快捷键共享的粘贴事件入口。
    await evaluate("(() => { const input=document.createElement('input'); input.type='file'; input.multiple=true; input.id='upload-input-fixture'; input.hidden=true; document.body.appendChild(input); })()");
    const documentNode = await debuggerApi.sendCommand('DOM.getDocument');
    const input = await debuggerApi.sendCommand('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#upload-input-fixture'});
    await debuggerApi.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files:localPaths});
    await click(row('/srv/config'));
    assert.equal(await evaluate("document.activeElement.getAttribute('title')"), '/srv/config', '点击文件夹后焦点留在文件树');
    const beforeFilePaste = imports.length;
    await pasteFiles(row('/srv/config'));
    await assertReview('/srv/config', beforeFilePaste);
    const beforeDuplicate = imports.length;
    await pasteFiles(row('/srv/config'));
    await wait(100);
    assert.equal(imports.length, beforeDuplicate, '弹窗期间重复粘贴不会替换待确认文件');
    await cancel();

    await assertReview('/srv', await drop(row('/srv/example.conf')));
    await cancel();

    // 空白落点使用当前目录；不依赖虚拟列表中最靠近鼠标的文件夹。
    const beforeBlankDrop = imports.length;
    await evaluate("(() => { const data=new DataTransfer(); for(const file of document.querySelector('#upload-input-fixture').files) data.items.add(file); document.querySelector('.server-tree-scroll').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true})); })()");
    await assertReview('/srv/config', beforeBlankDrop);
    await cancel();

    const ignored = imports.length;
    await evaluate("(() => { const data=new DataTransfer(); data.setData('text/plain','/tmp/not-an-upload'); "+has(row('/srv/config'))+".dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()");
    await click('[aria-label="编辑目录路径"]');
    await pasteFiles('[aria-label="目录路径"]');
    await wait(80);
    assert.equal(imports.length, ignored, '纯文本和路径输入框的粘贴不触发上传');
    await clickText('转到');
    await until(has(row('/srv/config')), '退出路径编辑');

    await evaluate("(() => { const data=new DataTransfer(); data.items.add(new File(['fixture'],'截图.png')); "+has(row('/srv/config'))+".dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()");
    await until("document.querySelector('.server-workspace-error')?.textContent.includes('暂不支持截图')", '内存文件提供明确提示');
    assert.equal(imports.length, ignored, '内存文件未进入主进程');
    await click('[aria-label="收起上传提示"]');

    if (process.platform === 'win32') {
      // 此环境已证明系统文件剪贴板夹具不可用；只接管测试 IPC，不读写宿主剪贴板。
      clipboardFixture = fileClipboardControl.activateFixture(localPaths);
      const beforeFixtureReads = fileClipboardControl.reads();
      process.stdout.write(JSON.stringify({fileClipboardMode:'fixture',osFileClipboardIntegration:'unverified',nativeMenuPasteIntegration:'unverified'}) + '\n');
      // 即使浏览器没有交付粘贴事件，可信快捷键也必须单次调用同一个文件读取边界。
      await evaluate("window.__blockFilePaste=event=>{event.preventDefault();event.stopImmediatePropagation();};document.addEventListener('paste',window.__blockFilePaste,true)");
      const shortcut = await nativePasteShortcut();
      await assertReview('/srv/config', shortcut.beforeImport);
      assert.equal(fileClipboardControl.reads(), shortcut.reads + 1, 'Ctrl+V 仅读取一次主进程文件列表');
      assert.equal(imports.at(-1).source, 'clipboard', 'Ctrl+V 使用限定主进程文件读取边界');
      await evaluate("document.removeEventListener('paste',window.__blockFilePaste,true);delete window.__blockFilePaste");
      await cancel();
      await focusFolder();
      const beforeObjectImport = imports.length, beforeObjectReads = fileClipboardControl.reads();
      // 合成事件仍携带真实磁盘 File 对象；只能验证 preload 导入，不声明原生菜单集成通过。
      assert.deepEqual(await pasteFiles(row('/srv/config')), {trusted:false,targetMatches:true,defaultPrevented:true}, '合成文件粘贴模式明确且进入当前目录');
      await assertReview('/srv/config', beforeObjectImport);
      assert.equal(imports.at(-1).source, undefined, '文件对象仍由 preload 解析完整路径');
      assert.equal(fileClipboardControl.reads(), beforeObjectReads, '文件对象导入不绕回剪贴板读取器');
      await cancel();
      const countBeforeText = imports.length;
      clipboardFixture.setEmpty();
      const emptyShortcut = await nativePasteShortcut();
      await until("document.querySelector('.server-workspace-error')?.textContent.includes('剪贴板中没有本地文件')", '无文件时明确提示，不再静默');
      assert.equal(fileClipboardControl.reads(), emptyShortcut.reads + 1, '空文件列表也仅读取一次');
      assert.equal(imports.length, countBeforeText, '文本路径不能作为本地文件上传');
      assert.equal(fileClipboardControl.reads(), beforeFixtureReads + 2, '两次可信快捷键各读取一次，无重复读取');
      await click('[aria-label="收起上传提示"]');
    }
    const expectedShortcut = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
    assert.ok((await evaluate("document.querySelector('.server-file-tree [aria-label=上传文件]').getAttribute('aria-description')")).includes(expectedShortcut));
    assert.equal(confirmCount(), beforeConfirm);
    assert.equal(writes.length, beforeWrites);
    assert.equal(uploadCount(), beforeUploads);
  } finally {
    clipboardFixture?.restore();
    await evaluate("document.removeEventListener('paste',window.__blockFilePaste,true);delete window.__blockFilePaste;document.removeEventListener('keydown',window.__uploadFileShortcutListener,true);delete window.__uploadFileShortcutListener;delete window.__uploadFileShortcut;delete window.__uploadFileShortcutEvent;document.querySelector('#upload-input-fixture')?.remove()");
    if (!attached) debuggerApi.detach();
  }
};
