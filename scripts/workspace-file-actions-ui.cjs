const assert = require('node:assert/strict');
const { clipboard } = require('electron');

module.exports = async function fileActionsUi({evaluate,click,clickText,until,wait,win,fileActionCalls,uploadRevisions,selectUploads,confirmCount,snapshot}) {
  const saved = {text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage()};
  const row = value => '[role="treeitem"][title=' + JSON.stringify(value) + ']';
  const has = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const enterPath = async value => {
    await click('[aria-label="编辑目录路径"]');
    await setValue('[aria-label="目录路径"]', value);
    await clickText('转到');
  };
  const setValue = async (selector, value, tag='input') => {
    await evaluate("(() => { const element=document.querySelector("+JSON.stringify(selector)+"); Object.getOwnPropertyDescriptor("+(tag==='select'?'HTMLSelectElement':'HTMLInputElement')+".prototype,'value').set.call(element,"+JSON.stringify(value)+"); element.dispatchEvent(new Event('"+(tag==='select'?'change':'input')+"',{bubbles:true})); })()");
    await wait(80);
  };
  const menu = async value => {
    await until(has(row(value)), '等待菜单目标');
    await until("!document.querySelector('[role=dialog]')", '等待弹窗关闭');
    await wait(300);
    await evaluate(has(row(value))+".scrollIntoView({block:'nearest'})");
    await wait(180);
    await until("(() => { const element="+has(row(value))+"; if(!element)return false; const r=element.getBoundingClientRect(); return document.elementFromPoint(Math.round(r.left+80),Math.round(r.top+r.height/2))?.closest('[role=treeitem]')?.title==="+JSON.stringify(value)+"; })()", '等待目标行可交互');
    const point = await evaluate("(() => { const element=document.querySelector("+JSON.stringify(row(value))+"); if(!element)return null; const r=element.getBoundingClientRect(); return {x:Math.round(r.left+80),y:Math.round(r.top+r.height/2)}; })()");
    assert.ok(point,'右键目标存在');
    assert.equal(await evaluate('document.elementFromPoint('+point.x+','+point.y+')?.closest("[role=treeitem]")?.title'),value,'右键坐标准确命中当前目录行');
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point});
    await until("document.querySelector('[role=menu]')", '文件右键菜单');
  };
  const choose = async label => {
    assert.ok(await evaluate("(() => { const item=[...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent.trim()==="+JSON.stringify(label)+"); if(!item||item.getAttribute('aria-disabled')==='true') return false; item.click(); return true; })()"), '菜单操作：'+label);
    await wait(100);
  };
  const ready = async () => until("document.querySelector('[aria-label=\"批量处理同名文件\"]')?.disabled === false && !document.querySelector('[data-testid=upload-review-progress]') && !document.querySelector('.server-upload-review-error')", '冲突预检完成');
  try {
    await enterPath('/srv');
    await until(has(row('/srv/example.conf')), '测试目录');
    await click(row('/srv/example.log'));
    await menu('/srv/example.conf'); await choose('复制名称');
    await until("!document.querySelector('[role=menu]')", '关闭复制菜单');
    assert.ok(clipboard.readText()==='example.conf','复制右键所在文件名称');
    await menu('/srv/example.conf'); await choose('复制完整路径');
    assert.ok(clipboard.readText()==='/srv/example.conf','复制路径使用右键目标');
    await menu('/srv/example.conf'); await choose('查看属性');
    await until("document.querySelector('.server-file-properties')?.textContent.includes('256 B')", '实时属性');
    assert.equal(fileActionCalls.at(-1).path,'/srv/example.conf');
    await snapshot('file-context-properties.png');
    await clickText('关闭');

    await menu('/srv/example.conf'); await choose('新建文件夹');
    await setValue('[aria-label="文件夹名称"]','菜单新建目录');
    await clickText('检查并继续');
    await until("document.querySelector('[role=dialog]')?.textContent.includes('/srv/菜单新建目录')",'展示创建目标');
    assert.equal(await evaluate('Boolean('+has(row('/srv/菜单新建目录'))+')'),false,'检查名称不写入');
    await clickText('确认新建');
    await until(has(row('/srv/菜单新建目录')),'创建后刷新并定位');
    await menu('/srv/菜单新建目录'); await choose('重命名');
    await setValue('[aria-label="新名称"]','菜单改名目录');
    await clickText('检查并继续'); await clickText('确认重命名');
    await until(has(row('/srv/菜单改名目录')),'目录改名后定位新路径');
    await until('!'+has(row('/srv/菜单新建目录')),'移除旧目录行');

    await enterPath('/srv'); await until(has(row('/srv/example.conf')),'返回原目录');
    await menu('/srv/example.conf'); await choose('重命名');
    await setValue('[aria-label="新名称"]','example.log'); await clickText('检查并继续');
    await until("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('已存在')",'重名明确提示');
    await clickText('取消');
    await menu('/srv/example.conf'); await choose('重命名');
    await setValue('[aria-label="新名称"]','example-backup.conf');
    await clickText('检查并继续'); await clickText('确认重命名');
    await until(has(row('/srv/example-backup.conf')),'文件改名后选中新文件');
    await evaluate(has(row('/srv/example-backup.conf'))+'.focus()');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'F10',modifiers:['shift']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'F10',modifiers:['shift']});
    await until("document.querySelector('[role=menu]')",'键盘打开菜单');
    await choose('查看属性'); await until("document.querySelector('.server-file-properties')",'键盘菜单属性'); await clickText('关闭');

    selectUploads(['conflict-a.txt','conflict-b.txt','conflict-c.tar.gz']);
    await clickText('上传文件'); await ready();
    const before = confirmCount();
    await setValue('[aria-label="批量处理同名文件"]','keep-both','select'); await ready();
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=upload-resolved-path]').length"),3,'批量保留两份逐项预览');
    await setValue('[aria-label="处理同名文件 conflict-a.txt"]','skip','select'); await ready();
    await setValue('[aria-label="处理同名文件 conflict-b.txt"]','overwrite','select'); await ready();
    assert.ok(await evaluate("document.querySelector('.server-upload-dialog[data-state=open]').textContent.includes('512 B')"),'源目标元数据展示');
    assert.equal(confirmCount(),before,'改变冲突策略不提前开始上传');
    assert.ok(uploadRevisions.at(-1).decisions.some(item=>item.name==='conflict-b.txt'&&item.action==='overwrite'));
    await snapshot('upload-conflict-policies.png');
    await click('[role=dialog] input[type=checkbox]');
    await clickText('开始上传 2 个文件');
    await until("!document.querySelector('[role=dialog]')",'提交混合策略');
    assert.equal(confirmCount(),before+1);
    await until("document.querySelector('.server-upload-tray')?.textContent.includes('conflict-c (1).tar.gz')",'显示固定副本任务路径');

    selectUploads(['all-skipped.txt']);
    await clickText('上传文件'); await ready();
    await setValue('[aria-label="批量处理同名文件"]','skip','select'); await ready();
    await clickText('完成（全部跳过）');
    await until("!document.querySelector('[role=dialog]')",'全部跳过正常关闭');

    const deleteDialog = '[data-testid="file-delete-dialog"][data-state="open"]';
    const deleteReady = () => until("document.querySelector("+JSON.stringify(deleteDialog)+")?.textContent.includes('普通文件')", '删除预检完成');
    await enterPath('/srv');
    await menu('/srv/example-backup.conf'); await choose('删除…'); await deleteReady();
    assert.equal(await evaluate("document.activeElement?.textContent.trim()"),'取消','删除弹窗默认聚焦取消');
    assert.ok(await evaluate(has(deleteDialog)+".textContent.includes('工作区验证服务器')"),'展示当前服务器');
    assert.equal(await evaluate("document.querySelector('[data-testid=file-delete-path]').textContent"),'/srv/example-backup.conf','显示准确删除路径');
    assert.ok(await evaluate(has(deleteDialog)+".textContent.includes('无法撤销')"),'明确永久删除');
    assert.ok(await evaluate(has(row('/srv/example-backup.conf'))),'预检不删除文件');
    const actionsBeforeCancel=fileActionCalls.length;
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until('!'+has(deleteDialog),'默认回车取消');
    assert.equal(fileActionCalls.length,actionsBeforeCancel,'默认回车不提交删除');
    assert.ok(await evaluate(has(row('/srv/example-backup.conf'))),'取消保留文件');

    await menu('/srv/example-backup.conf'); await choose('删除…'); await deleteReady();
    await snapshot('file-delete-confirm.png');
    await clickText('永久删除');
    await until('!'+has(row('/srv/example-backup.conf')),'删除文件后刷新');
    assert.equal(fileActionCalls.at(-1).kind,'delete');
    assert.ok(fileActionCalls.at(-1).operationId,'执行使用确认凭证');

    await menu('/srv/菜单改名目录'); await choose('删除…');
    await until(has(deleteDialog)+".textContent.includes('空文件夹')",'展示空目录预检结果');
    await clickText('永久删除');
    await until('!'+has(row('/srv/菜单改名目录')),'删除空目录后刷新');

    await menu('/srv/config'); await choose('删除…');
    await until(has(deleteDialog)+".textContent.includes('文件夹非空')",'非空目录拒绝删除');
    assert.equal(await evaluate("Array.from(document.querySelectorAll("+JSON.stringify(deleteDialog+" button")+")).some(item=>item.textContent.trim()==='永久删除')"),false,'预检失败没有删除按钮');
    await clickText('取消');
    assert.ok(await evaluate(has(row('/srv/config'))),'非空目录保留');
  } finally { clipboard.write(saved); }
};
