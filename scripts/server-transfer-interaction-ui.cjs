const assert = require('node:assert/strict');

module.exports = async function liveTransfersUi({ evaluate, until, wait, win, probe }) {
  assert.ok(win.isVisible() && !win.isMinimized()); win.focus(); win.webContents.focus();
  const transfer = probe.transfers, samples = [];
  const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const named = (tag, text) => '[...document.querySelectorAll(' + JSON.stringify(tag) + ')].find(item=>item.textContent.trim()===' + JSON.stringify(text) + ' && item.getClientRects().length)';
  const tree = remote => q('[role=treeitem][title=' + JSON.stringify(remote) + ']');
  const task = direction => '[...document.querySelectorAll(".server-upload-row")].find(row=>row.querySelector("strong")?.title===' + JSON.stringify(transfer.name) + ' && row.querySelector(".server-upload-task-target span")?.textContent===' + JSON.stringify(direction === 'upload' ? '上传到' : '下载到') + ')';
  const state = (direction, status) => '(' + task(direction) + ')?.querySelector(".server-upload-task-heading span")?.textContent===' + JSON.stringify(status);
  const progress = direction => '(' + task(direction) + ')?.querySelector("progress")?.value';
  async function mainUntil(check) {
    const deadline = Date.now() + 30000;
    while (!check()) { assert.ok(Date.now() < deadline, '传输状态等待超时'); await wait(20); }
  }
  async function mouse(element, right = false) {
    await until('Boolean(' + element + ') && !(' + element + ').disabled', '等待传输操作');
    await evaluate('(' + element + ').scrollIntoView({block:"nearest"})');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const point = await evaluate('(() => { const r=(' + element + ').getBoundingClientRect();return{x:Math.round(r.left+Math.min(80,r.width/2)),y:Math.round(r.top+r.height/2)} })()');
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: right ? 'right' : 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: right ? 'right' : 'left', clickCount: 1, ...point });
  }
  async function measured(label, element, feedback, done) {
    await evaluate(`(() => {
      const target=${element}; window.transferClick=new Promise((resolve,reject)=>{
        let start, trusted, first;
        const clear=()=>{observer.disconnect();document.removeEventListener('click',clicked,true);clearTimeout(timer)};
        const check=()=>{if(start===undefined)return;if(first===undefined && (${feedback}))first=performance.now()-start;if(${done}){const ms=performance.now()-start;clear();resolve({trusted,feedbackMs:first??ms,doneMs:ms})}};
        const clicked=event=>{if(event.target===target||target.contains(event.target)){start=performance.now();trusted=event.isTrusted;check()}};
        const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        const timer=setTimeout(()=>{clear();reject(new Error('传输界面反馈超时'))},10000);document.addEventListener('click',clicked,true);
      });
    })()`);
    await mouse(element);
    const sample = { label, ...await evaluate('window.transferClick') }; samples.push(sample);
    process.stdout.write(JSON.stringify({ transferUiStep: label, ...sample }) + '\n');
    assert.equal(sample.trusted, true); assert.ok(sample.feedbackMs < 350, '传输操作应及时反馈');
  }
  async function nativeUpload(action) {
    transfer.pick(action);
    const before = transfer.snapshot().pickers.length;
    await mouse(named('button', '上传文件'));
    await mainUntil(() => transfer.snapshot().pickers.length > before);
    assert.equal(transfer.snapshot().pickers.at(-1).error, undefined, '原生文件驱动必须成功');
    win.focus(); win.webContents.focus();
  }
  async function nativeDownload(action, destination) {
    transfer.pick(action, destination);
    const before = transfer.snapshot().pickers.length;
    await until('Boolean(' + tree(probe.target(transfer.name)) + ')', '上传完成后出现真实文件');
    await mouse(tree(probe.target(transfer.name)), true);
    await until('document.querySelector("[role=menu]")', '下载菜单');
    await mouse(named('[role=menuitem]', '下载'));
    await mainUntil(() => transfer.snapshot().pickers.length > before);
    assert.equal(transfer.snapshot().pickers.at(-1).error, undefined, '原生文件驱动必须成功');
    win.focus(); win.webContents.focus();
  }
  const uiProgress = await evaluate(`(() => {
    window.transferUiChanges=[];const old=new Map();
    const observe=()=>{for(const row of document.querySelectorAll('.server-upload-row')){
      if(row.querySelector('strong')?.title!==${JSON.stringify(transfer.name)})continue;
      const direction=row.querySelector('.server-upload-task-target span')?.textContent==='下载到'?'download':'upload';
      const status=row.querySelector('.server-upload-task-heading span')?.textContent, bytes=row.querySelector('progress')?.value;
      const value=status+':'+bytes;if(old.get(direction)===value)continue;old.set(direction,value);
      window.transferUiChanges.push({direction,status,bytes,at:Date.now()});
    }};
    window.transferUiObserver=new MutationObserver(observe);window.transferUiObserver.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});return true;
  })()`);
  assert.equal(uiProgress, true);
  try {
    await mouse(q('[aria-label="编辑目录路径"]'));
    const input = q('[aria-label="目录路径"]');
    await mouse(input);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    win.webContents.insertText(probe.root);
    await until('(' + input + ').value===' + JSON.stringify(probe.root), '目录输入');
    await mouse(named('button', '转到'));
    await until('Boolean(' + tree(probe.target('ui-source.txt')) + ')', '本次目录可见');

    await nativeUpload('cancel');
    await until('!document.querySelector("[role=dialog]") && !(' + named('button', '上传文件') + ')?.disabled', '取消原生上传选择');
    assert.equal(transfer.snapshot().jobs.length, 0); await probe.absent(transfer.name);

    await nativeUpload('select');
    await until('document.querySelector("[data-testid=upload-confirm-submit]")?.disabled===false', '上传预检完成');
    await probe.absent(transfer.name);
    await measured('upload-submit', q('[data-testid=upload-confirm-submit]'), 'document.querySelector("[data-testid=upload-confirm-submit]")?.disabled', 'Boolean(' + task('upload') + ')');
    await until('(' + progress('upload') + ') > 0 && document.querySelector(' + JSON.stringify('[aria-label="暂停上传 ' + transfer.name + '"]') + ')', '真实数据传输并显示进度');
    const pause = q('[aria-label="暂停上传 ' + transfer.name + '"]');
    await measured('upload-pause', pause, state('upload', '正在暂停') + ' || ' + state('upload', '已暂停'), state('upload', '已暂停'));
    const pausedBytes = await transfer.checkPaused();
    const resume = '(' + task('upload') + ') && [...(' + task('upload') + ').querySelectorAll("button")].find(item=>item.textContent.trim()==="继续上传")';
    await measured('upload-resume', resume, '(' + task('upload') + ')?.textContent.includes("正在继续")', state('upload', '正在传输'));
    await until('(' + progress('upload') + ') > ' + pausedBytes, '续传增加进度');
    assert.ok(transfer.snapshot().jobs.some(job => job.direction === 'upload' && job.inFlight));
    await measured('directory-during-upload', tree(probe.target('ui-nonempty')), tree(probe.target('ui-nonempty')) + '?.getAttribute("aria-expanded")==="true"', 'Boolean(' + tree(probe.root + '/ui-nonempty/ui-inside.txt') + ')');
    let concurrentCachedSteps = 0;
    for (let index = 0; index < 6; index += 1) {
      if (!transfer.snapshot().jobs.some(job => job.direction === 'upload' && job.inFlight)) break;
      const branch = tree(probe.target('ui-nonempty'));
      const open = await evaluate(branch + '?.getAttribute("aria-expanded")==="true"');
      const toggled = branch + '?.getAttribute("aria-expanded")===' + JSON.stringify(String(!open));
      await measured('cached-directory-during-upload-' + (index + 1), branch, toggled, toggled);
      // 两端均在传输中才计入并发证据；快速完成的上传不因此被判为产品失败。
      if (transfer.snapshot().jobs.some(job => job.direction === 'upload' && job.inFlight)) concurrentCachedSteps += 1;
    }
    await until(state('upload', '已完成'), '真实上传完成反馈');
    await mainUntil(() => transfer.snapshot().backend.some(item => item.direction === 'upload' && item.status === 'completed'));
    const uploaded = transfer.snapshot().jobs.find(job => job.direction === 'upload');
    assert.equal(uploaded.transferred, transfer.sourceBytes);
    await measured('clear-upload-record', q('[aria-label="移除记录 ' + transfer.name + '"]'), '!' + task('upload'), '!' + task('upload'));
    assert.equal((await probe.summary()).pending, 0);

    await nativeDownload('cancel', 'ui-cancelled.bin');
    await transfer.checkDownload('ui-cancelled.bin', true);
    assert.equal(transfer.snapshot().jobs.filter(job => job.direction === 'download').length, 0);
    await nativeDownload('select', 'ui-cancelled.bin');
    await until('(' + progress('download') + ') > 0 && ' + state('download', '正在传输'), '真实下载进度');
    await measured('download-cancel', q('[aria-label="取消下载 ' + transfer.name + '"]'), state('download', '已取消'), state('download', '已取消'));
    await transfer.checkDownload('ui-cancelled.bin', true);
    await until('Boolean(' + q('[aria-label="移除记录 ' + transfer.name + '"]') + ')', '下载取消已收尾');
    await measured('clear-cancelled-download', q('[aria-label="移除记录 ' + transfer.name + '"]'), '!' + task('download'), '!' + task('download'));

    await nativeDownload('select', 'ui-downloaded.bin');
    await until(state('download', '已完成'), '完整下载完成反馈');
    await transfer.checkDownload('ui-downloaded.bin');
    await mainUntil(() => transfer.snapshot().backend.some(item => item.direction === 'download' && item.status === 'completed'));
    const display = await evaluate('window.transferUiChanges');
    const backend = transfer.snapshot();
    const lags = ['upload', 'download'].map(direction => {
      const done = backend.backend.find(item => item.direction === direction && item.status === 'completed');
      const shown = display.find(item => item.direction === direction && item.status === '已完成');
      assert.ok(done && shown); const ms = shown.at - done.at;
      assert.ok(ms >= -25 && ms < 750, '完成状态应及时显示'); return { direction, completedFeedbackMs: Math.max(0, ms) };
    });
    for (const direction of ['upload', 'download']) assert.ok(display.some(item => item.direction === direction && item.bytes > 0 && item.bytes < transfer.sourceBytes), '可见进度包含中间值');
    assert.equal(backend.pickers.length, 5); assert.equal(backend.pickers.filter(item => item.canceled).length, 2);
    assert.ok(!await evaluate('document.querySelector("[data-testid=upload-job-error], [data-testid=upload-poll-error]")'));
    return { realTransferUi: true, visible: win.isVisible(), nativePickers: backend.pickers.length, canceledPickers: 2,
      bytes: transfer.sourceBytes, pausedBytes, concurrentCachedSteps, progressUpdates: display.length, completedFeedback: lags, samples, integrity: 'sha256-matched' };
  } finally {
    await evaluate('window.transferUiObserver?.disconnect(); delete window.transferUiObserver; delete window.transferUiChanges; delete window.transferClick;');
  }
};
