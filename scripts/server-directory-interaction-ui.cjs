const assert = require('node:assert/strict');

module.exports = async function measureVisibleDirectory({evaluate, win, until, targetPath='/srv/config'}) {
  assert.ok(win.isVisible() && !win.isMinimized(), '测量窗口必须实际可见');
  win.focus(); win.webContents.focus();
  const samples = [];
  await evaluate(`(() => {
    window.directoryLongTasks = [];
    window.directoryLongTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.directoryLongTasks.push(entry.duration);
    });
    window.directoryLongTaskObserver.observe({type:'longtask'});
  })()`);
  try {
    for (let index=0; index<30; index+=1) {
      const point = await evaluate(`(() => {
        const selector=${JSON.stringify('[role=treeitem][title="'+targetPath+'"]')};
        const row=document.querySelector(selector);
        const expected=row.getAttribute('aria-expanded') !== 'true' ? 'true' : 'false';
        const bounds=row.getBoundingClientRect();
        window.directoryClickSample=new Promise((resolve,reject) => {
          let started, trusted;
          const cleanup=() => {observer.disconnect();row.removeEventListener('click',clicked,true);clearTimeout(timer)};
          const timer=setTimeout(() => {cleanup();reject(new Error('可见目录点击未响应'))},3000);
          const clicked=event => {started=performance.now();trusted=event.isTrusted};
          const observer=new MutationObserver(() => {
            if(started===undefined || row.getAttribute('aria-expanded')!==expected) return;
            observer.disconnect();
            const commitMs=performance.now()-started;
            // 两次帧回调之间提供一次绘制机会，不等同显示器实际呈现时间。
            requestAnimationFrame(() => requestAnimationFrame(() => {
              cleanup();resolve({trusted,commitMs,twoFramesMs:performance.now()-started});
            }));
          });
          row.addEventListener('click',clicked,true);
          observer.observe(row,{attributes:true,attributeFilter:['aria-expanded']});
        });
        return {x:Math.round(bounds.left+Math.min(70,bounds.width/2)),y:Math.round(bounds.top+bounds.height/2)};
      })()`);
      win.webContents.sendInputEvent({type:'mouseMove',...point});
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      samples.push(await evaluate('window.directoryClickSample'));
    }
    const state=await evaluate(`({
      visibility:document.visibilityState,focused:document.hasFocus(),
      longTasks:window.directoryLongTasks,renderedRows:document.querySelectorAll('[role=treeitem]').length
    })`);
    assert.ok(samples.every(item=>item.trusted), '全部样本来自可信鼠标输入');
    assert.equal(state.visibility,'visible');
    const summarize=key => {
      const values=samples.map(item=>item[key]).sort((a,b)=>a-b);
      return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*0.95)-1],maxMs:values.at(-1)};
    };
    return {samples:samples.length,windowVisible:win.isVisible(),...state,commit:summarize('commitMs'),twoFrames:summarize('twoFramesMs')};
  } finally {
    await evaluate('window.directoryLongTaskObserver.disconnect(); delete window.directoryLongTaskObserver; delete window.directoryLongTasks; delete window.directoryClickSample;');
  }
};
