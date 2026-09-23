const assert = require('node:assert/strict');

// 仅在可见窗口发送可信鼠标输入；度量从输入事件到 DOM 状态变化，不混入测试轮询等待。
module.exports = async function liveFileActionsUi({ evaluate, until, wait, win, probe }) {
  assert.ok(win.isVisible() && !win.isMinimized());
  win.focus(); win.webContents.focus();
  const samples = [];
  const blurBaseline = process.env.RUNBOOK_BRIDGE_FILE_UI_BLUR_BASELINE === '1';
  if (blurBaseline) await evaluate(`(() => { const style=document.createElement('style'); style.id='file-ui-probe-style'; style.textContent='[data-slot=dialog-overlay] {backdrop-filter:blur(var(--blur-xs,4px)) !important}'; document.head.appendChild(style); })()`);
  const row = name => '[role=treeitem][title=' + JSON.stringify(probe.target(name)) + ']';
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const button = text => '[...document.querySelectorAll("[role=dialog] button")].find(item=>item.textContent.trim()===' + JSON.stringify(text) + ')';
  const menuItem = text => '[...document.querySelectorAll("[role=menuitem]")].find(item=>item.textContent.trim()===' + JSON.stringify(text) + ')';
  const dialog = 'document.querySelector("[role=dialog]")';
  async function mouse(element, right = false) {
    const point = await evaluate('(() => { const el=' + element + '; if(!el || el.disabled) return null; el.scrollIntoView({block:"nearest"}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+Math.min(80,r.width/2)),y:Math.round(r.top+r.height/2)}; })()');
    assert.ok(point, '可见输入目标必须存在且可用');
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: right ? 'right' : 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: right ? 'right' : 'left', clickCount: 1, ...point });
  }
  async function clickMeasured(label, element, feedback, done, right = false) {
    await until('Boolean(' + element + ') && !(' + element + ').disabled', '等待操作按钮');
    await evaluate('(' + element + ').scrollIntoView({block:"nearest"})');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await evaluate(`(() => {
      const element=${element};
      window.fileUiSample=new Promise((resolve,reject)=>{
        let started, trusted, feedbackMs, previousFrame, maxFrameMs=0, frame;
        const type=${JSON.stringify(right ? 'contextmenu' : 'click')};
        const cleanup=()=>{observer.disconnect();document.removeEventListener(type,input,true);clearTimeout(timer);cancelAnimationFrame(frame)};
        const timer=setTimeout(()=>{cleanup();reject(new Error('真实文件界面响应超时'))},10000);
        const input=event=>{if(element===event.target || element.contains(event.target)){started=performance.now();trusted=event.isTrusted;check()}};
        const check=()=>{
          if(started===undefined)return;
          if(feedbackMs===undefined && (${feedback}))feedbackMs=performance.now()-started;
          if(${done}){const doneMs=performance.now()-started;cleanup();resolve({trusted,feedbackMs:feedbackMs??doneMs,doneMs,maxFrameMs})}
        };
        const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        const tick=now=>{if(previousFrame!==undefined)maxFrameMs=Math.max(maxFrameMs,now-previousFrame);previousFrame=now;frame=requestAnimationFrame(tick)};
        frame=requestAnimationFrame(tick);document.addEventListener(type,input,true);
      });
    })()`);
    await mouse(element, right);
    const result = await evaluate('window.fileUiSample');
    process.stdout.write(JSON.stringify({ fileUiStep: label, ...result }) + '\n');
    assert.equal(result.trusted, true, '测量必须由可信输入触发');
    assert.ok(result.feedbackMs < 250, '界面应及时反馈：' + label);
    assert.ok(result.doneMs < 3000, '当前内网场景操作应在三秒内完成：' + label);
    samples.push({ label, ...result });
  }
  async function menu(name) {
    await until('Boolean(' + query(row(name)) + ')', '等待本次文件行');
    await until('!' + dialog, '等待对话框关闭');
    await wait(100);
    await clickMeasured('context-menu', query(row(name)), 'document.querySelector("[role=menu]")', 'document.querySelector("[role=menu]")', true);
  }
  async function setName(label, value) {
    const element = query('[aria-label=' + JSON.stringify(label) + ']');
    await until('Boolean(' + element + ')', '等待名称输入');
    await mouse(element);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    win.webContents.insertText(value);
    await until('(' + element + ').value===' + JSON.stringify(value), '名称输入完成');
  }
  const busy = dialog + '?.textContent.includes("正在处理")';
  const ready = text => '(' + button(text) + ') && !(' + button(text) + ').disabled';
  const alert = text => 'document.querySelector("[role=dialog] [role=alert]")?.textContent.includes(' + JSON.stringify(text) + ')';
  async function begin(name, action, inputLabel, value) {
    await menu(name);
    await clickMeasured(action + '-dialog', menuItem(action), dialog, dialog);
    await setName(inputLabel, value);
  }
  async function close(label = '取消') {
    await clickMeasured('dialog-close', button(label), '!'+dialog+' || '+dialog+'?.dataset.state==="closed"', '!'+dialog);
  }
  async function checkAndConfirm(kind, name) {
    const confirm = kind === 'mkdir' ? '确认新建' : '确认重命名';
    await clickMeasured(kind + '-preflight', button('检查并继续'), busy, ready(confirm));
    await probe.absent(name);
    await clickMeasured(kind + '-confirm-and-tree', button(confirm), busy, '!' + dialog + ' && Boolean(' + query(row(name)) + ')');
    assert.ok(['file', 'directory'].includes(await probe.present(name)));
  }
  const originalCounts = probe.summary().events.length;
  await mouse(query('[aria-label="编辑目录路径"]'));
  await setName('目录路径', probe.root);
  await mouse('[...document.querySelectorAll("button")].find(item=>item.textContent.trim()==="转到")');
  await until('Boolean(' + query(row('ui-source.txt')) + ')', '本次合成文件可见');
  await menu('ui-source.txt');
  await clickMeasured('properties-read', menuItem('查看属性'), dialog, 'Boolean(document.querySelector(".server-file-properties dd"))');
  await close('关闭');

  await begin('ui-source.txt', '新建文件夹', '文件夹名称', 'ui-中文 空格');
  await checkAndConfirm('mkdir', 'ui-中文 空格');
  await begin('ui-中文 空格', '重命名', '新名称', 'ui-folder-renamed');
  await checkAndConfirm('rename', 'ui-folder-renamed');
  await probe.absent('ui-中文 空格');

  await begin('ui-source.txt', '重命名', '新名称', 'ui-existing.txt');
  await clickMeasured('rename-conflict', button('检查并继续'), busy, alert('已存在'));
  assert.equal(await probe.present('ui-source.txt'), 'file'); assert.equal(await probe.present('ui-existing.txt'), 'file');
  await close();

  await begin('ui-source.txt', '新建文件夹', '文件夹名称', 'ui-cancelled');
  await clickMeasured('mkdir-cancel-preflight', button('检查并继续'), busy, ready('确认新建'));
  await close(); await probe.absent('ui-cancelled');
  for (let attempt = 0; probe.summary().pending && attempt < 100; attempt += 1) await wait(20);
  assert.equal(probe.summary().pending, 0, '取消后无待执行操作');

  await begin('ui-source.txt', '重命名', '新名称', 'ui-renamed.txt');
  await checkAndConfirm('rename', 'ui-renamed.txt'); await probe.absent('ui-source.txt');
  await menu('ui-renamed.txt');
  await clickMeasured('delete-preflight-cancel', menuItem('删除…'), dialog, ready('永久删除'));
  assert.equal(await evaluate('document.activeElement?.textContent.trim()'), '取消');
  await close(); assert.equal(await probe.present('ui-renamed.txt'), 'file');

  await menu('ui-nonempty');
  await clickMeasured('delete-nonempty', menuItem('删除…'), dialog, alert('非空'));
  assert.equal(await evaluate('Boolean(' + button('永久删除') + ')'), false);
  await close(); assert.equal(await probe.present('ui-nonempty'), 'directory');

  for (const name of ['ui-renamed.txt', 'ui-folder-renamed']) {
    await menu(name);
    await clickMeasured('delete-preflight', menuItem('删除…'), dialog, ready('永久删除'));
    await clickMeasured('delete-confirm-and-tree', button('永久删除'), busy, '!' + dialog + ' && !' + query(row(name)));
    await probe.absent(name);
  }
  await evaluate('delete window.fileUiSample');
  const summary = probe.summary();
  assert.equal(summary.pending, 0);
  assert.ok(summary.events.length > originalCounts);
  assert.deepEqual(summary.events.filter(item => item.status === 'rejected').map(item => item.code).sort(), ['DIRECTORY_NOT_EMPTY', 'TARGET_EXISTS']);
  await evaluate('document.getElementById("file-ui-probe-style")?.remove()');
  return { visible: win.isVisible(), blurBaseline, samples, ...summary };
};
