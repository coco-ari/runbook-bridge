const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);

module.exports = async function testWorkspaceUploadInput({evaluate, click, clickText, until, wait, win, temporaryRoot, imports, writes, confirmCount, snapshot}) {
  const localPaths = ['发布 包.jar', '说明.txt'].map(name => path.join(temporaryRoot, name));
  for (const file of localPaths) fs.writeFileSync(file, 'upload-input-fixture');
  const row = remote => '[role="treeitem"][title=' + JSON.stringify(remote) + ']';
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const beforeWrites = writes.length, beforeConfirm = confirmCount();
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
  const assertReview = async target => {
    await until("document.querySelectorAll('[data-testid=upload-file-row]').length===2", '自动列出两个本地文件');
    assert.equal(await evaluate("document.querySelector('[data-testid=upload-destination-path]').textContent"), target);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-testid=upload-source-path]')].map(node=>node.textContent)"), localPaths);
    assert.equal(confirmCount(), beforeConfirm, '接收文件后仍需明确点击开始上传');
    assert.equal(writes.length, beforeWrites, '接收文件不向终端发送内容');
  };
  const pasteFiles = async selector => evaluate("(() => { const data=new DataTransfer(); for(const file of document.querySelector('#upload-input-fixture').files) data.items.add(file); "+has(selector)+".dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()");
  const drop = async selector => {
    const target = await point(selector), data = {items:[], files:localPaths, dragOperationsMask:1};
    for (const type of ['dragEnter','dragOver']) await debuggerApi.sendCommand('Input.dispatchDragEvent',{type,...target,data});
    await until("document.querySelector('.server-upload-drop-hint')", '显示上传目标提示');
    await snapshot('file-upload-drop-target.png');
    await debuggerApi.sendCommand('Input.dispatchDragEvent',{type:'drop',...target,data});
  };
  try {
    await click('[aria-label="编辑目录路径"]');
    await evaluate("(() => { const input=document.querySelector('[aria-label=目录路径]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/srv'); input.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await clickText('转到');
    await until(has(row('/srv/config')), '上传测试目录就绪');
    await drop(row('/srv/config'));
    await assertReview('/srv/config');
    assert.deepEqual(imports.at(-1).localPaths, localPaths, '真实 Chromium 文件通过隔离 preload 解析路径');
    await cancel();

    // 通过浏览器文件输入建立真实磁盘文件对象，覆盖菜单与快捷键共享的粘贴事件入口。
    await evaluate("(() => { const input=document.createElement('input'); input.type='file'; input.multiple=true; input.id='upload-input-fixture'; input.hidden=true; document.body.appendChild(input); })()");
    const documentNode = await debuggerApi.sendCommand('DOM.getDocument');
    const input = await debuggerApi.sendCommand('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#upload-input-fixture'});
    await debuggerApi.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files:localPaths});
    await click(row('/srv/config'));
    assert.equal(await evaluate("document.activeElement.getAttribute('title')"), '/srv/config', '点击文件夹后焦点留在文件树');
    await pasteFiles(row('/srv/config'));
    await assertReview('/srv/config');
    const beforeDuplicate = imports.length;
    await pasteFiles(row('/srv/config'));
    await wait(100);
    assert.equal(imports.length, beforeDuplicate, '弹窗期间重复粘贴不会替换待确认文件');
    await cancel();

    await drop(row('/srv/example.conf'));
    await assertReview('/srv');
    await cancel();

    // 空白落点使用当前目录；不依赖虚拟列表中最靠近鼠标的文件夹。
    await evaluate("(() => { const data=new DataTransfer(); for(const file of document.querySelector('#upload-input-fixture').files) data.items.add(file); document.querySelector('.server-tree-scroll').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true})); })()");
    await assertReview('/srv/config');
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
      const command = "Add-Type -AssemblyName System.Windows.Forms; $uploadFiles = New-Object System.Collections.Specialized.StringCollection; " +
        localPaths.map(file => "$null = $uploadFiles.Add('" + file.replace(/'/g,"''") + "'); ").join('') +
        "[System.Windows.Forms.Clipboard]::SetFileDropList($uploadFiles)";
      // 异步调用保留 Electron 消息循环，避免剪贴板所有权交接时相互等待。
      await executeFile('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {windowsHide:true,timeout:15000}).catch(() => {
        throw new Error('无法建立原生文件剪贴板测试夹具');
      });
      // 即使浏览器没有交付粘贴事件，快捷键也必须读取原生文件清单。
      await evaluate("window.__blockFilePaste=event=>{event.preventDefault();event.stopImmediatePropagation();};document.addEventListener('paste',window.__blockFilePaste,true)");
      const folderPoint = await point(row('/srv/config'));
      win.webContents.focus();
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...folderPoint});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...folderPoint});
      await wait(250);
      assert.equal(await evaluate("document.activeElement?.getAttribute('title')"), '/srv/config', '真实点击目录后仍保留键盘焦点');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers:['control']});
      await assertReview('/srv/config');
      assert.equal(imports.at(-1).source, 'clipboard', 'Ctrl+V 使用主进程原生文件列表');
      await evaluate("document.removeEventListener('paste',window.__blockFilePaste,true);delete window.__blockFilePaste");
      await cancel();
      await evaluate(has(row('/srv/config')) + '.focus()');
      win.webContents.paste();
      await assertReview('/srv/config');
      assert.equal(imports.at(-1).source, 'clipboard', '菜单粘贴复用原生文件列表');
      await cancel();
      const countBeforeText = imports.length;
      require('electron').clipboard.writeText('/tmp/not-a-file-selection');
      await evaluate(has(row('/srv/config')) + '.focus()');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers:['control']});
      await until("document.querySelector('.server-workspace-error')?.textContent.includes('剪贴板中没有本地文件')", '无文件时明确提示，不再静默');
      assert.equal(imports.length, countBeforeText, '文本路径不能作为本地文件上传');
      await click('[aria-label="收起上传提示"]');
    }
    const expectedShortcut = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
    assert.ok((await evaluate("document.querySelector('.server-file-tree [aria-label=上传文件]').getAttribute('aria-description')")).includes(expectedShortcut));
    assert.equal(confirmCount(), beforeConfirm);
    assert.equal(writes.length, beforeWrites);
  } finally {
    await evaluate("document.removeEventListener('paste',window.__blockFilePaste,true);delete window.__blockFilePaste;document.querySelector('#upload-input-fixture')?.remove()");
    if (!attached) debuggerApi.detach();
  }
};
