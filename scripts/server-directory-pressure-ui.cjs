const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// 复现每窗口四个文件读取的服务上限，目录内容均为合成数据。
exports.createHarness = () => {
  const state = { reads:[], pending:[], active:0, peak:0, busy:0, cancelled:0, jobs:[], uploadPolls:0, hold:true };
  state.read = async input => {
    if (state.active >= 4) { state.busy += 1; throw Object.assign(new Error('文件读取较多，请稍后重试。'), {code:'WORKSPACE_BUSY'}); }
    state.active += 1; state.peak = Math.max(state.peak,state.active); state.reads.push(input.path);
    try {
      if (state.hold && input.path !== '/') await new Promise((resolve,reject) => state.pending.push(Object.assign(resolve,{requestId:input.requestId,reject})));
      const names = input.path === '/' ? ['alpha','beta','gamma','delta','epsilon'] : ['item.txt'];
      return { path:input.path,canonicalPath:input.path,snapshotId:randomUUID(),nextCursor:null,truncated:false,
        entries:names.map(name => ({name,path:(input.path === '/' ? '' : input.path)+'/'+name,type:input.path === '/' ? 'directory' : 'file',size:1,mode:0o644,mtime:1})) };
    } finally { state.active -= 1; }
  };
  state.cancel = input => {
    const index=state.pending.findIndex(item=>item.requestId===input.requestId);
    if(index<0)return {cancelled:false};
    const [pending]=state.pending.splice(index,1);state.cancelled+=1;
    pending.reject(Object.assign(new Error('合成目录取消'),{code:'WORKSPACE_READ_CANCELLED'}));
    return {cancelled:true};
  };
  state.release = () => { state.hold=false; for (const resolve of state.pending.splice(0)) resolve(); };
  return state;
};

exports.run = async ({state,evaluate,click,until,wait,win}) => {
  assert.equal(win.isVisible(),false,'并发交互专项必须保持窗口隐藏');
  try {
    await until('Boolean(document.querySelector(\'[role=treeitem][title="/epsilon"]\'))','合成根目录就绪');
    for (const name of ['alpha','beta','gamma','delta','epsilon']) await click('[role=treeitem][title="/'+name+'"]');
    await wait(150);
    assert.equal(state.busy,0,'快速展开五个慢目录不应直接超出服务读取上限');
    assert.ok(state.peak<=3,'目录树应为其他文件交互保留读取名额');
    state.release();
    for (const name of ['alpha','beta','gamma','delta','epsilon']) await until('Boolean(document.querySelector(\'[role=treeitem][title="/'+name+'/item.txt"]\'))','队列完成后显示目录');
    assert.equal(await evaluate('document.querySelector(".server-file-tree").textContent.includes("文件读取较多")'),false);
    const names=['alpha','beta','gamma','delta','epsilon'];
    const collapseAll=async()=>{for(const name of names) if(await evaluate('document.querySelector(\'[role=treeitem][title="/'+name+'"]\').getAttribute("aria-expanded")')==='true') await click('[role=treeitem][title="/'+name+'"]');};
    let clockOffset=0;
    const expire=()=>{clockOffset+=31000;return evaluate('window.directoryOriginalNow ??= Date.now; Date.now=()=>window.directoryOriginalNow()+'+clockOffset+'; undefined;');};
    await collapseAll(); await expire(); state.hold=true;
    let from=state.reads.length;
    for(const name of names) await click('[role=treeitem][title="/'+name+'"]');
    await wait(150); assert.deepEqual(state.reads.slice(from),['/alpha','/beta','/gamma']);
    for(const name of ['delta','epsilon']) await click('[role=treeitem][title="/'+name+'"]');
    state.release(); await wait(150);
    assert.deepEqual(state.reads.slice(from),['/alpha','/beta','/gamma'],'收起排队分支后不补发旧展开请求');
    await evaluate('Date.now=window.directoryOriginalNow; delete window.directoryOriginalNow;');
    await collapseAll(); await expire(); state.hold=true; from=state.reads.length;
    for(const name of names) await click('[role=treeitem][title="/'+name+'"]');
    await click('[data-testid=server-workspace-back]');
    await until('document.querySelector("[data-testid=server-workspace]").hidden','工作区隐藏');
    state.release(); await wait(150);
    assert.deepEqual(state.reads.slice(from),['/alpha','/beta','/gamma'],'隐藏后不继续发送等待中的目录请求');
    await click('[data-testid=plugin-open-workspace]');
    for(const name of names) await until('Boolean(document.querySelector(\'[role=treeitem][title="/'+name+'/item.txt"]\'))','恢复后目录内容可用');
    await until('!document.querySelector(\'[aria-label="刷新目录"]\').disabled','恢复刷新完成');
    assert.ok(state.reads.slice(from).includes('/delta') && state.reads.slice(from).includes('/epsilon'),'恢复后重新读取取消的过期目录');
    // 三个在途慢读取均未回复，收起后应释放名额供新展开使用。
    await collapseAll();await expire();state.hold=true;from=state.reads.length;
    const cancelledBefore=state.cancelled;
    for(const name of ['alpha','beta','gamma'])await click('[role=treeitem][title="/'+name+'"]');
    await wait(150);assert.equal(state.active,3);
    for(const name of ['alpha','beta','gamma'])await click('[role=treeitem][title="/'+name+'"]');
    await click('[role=treeitem][title="/delta"]');
    for(let i=0;i<100&&!state.reads.slice(from).includes('/delta');i+=1)await wait(20);
    assert.ok(state.reads.slice(from).includes('/delta'),'旧读取不回复时，新展开仍能获得空位');
    assert.equal(state.cancelled-cancelledBefore,3);assert.equal(state.active,1);
    assert.equal(await evaluate('document.querySelector(".server-file-tree").textContent.includes("目录读取已取消")'),false);
    state.release();await until('Boolean(document.querySelector(\'[role=treeitem][title="/delta/item.txt"]\'))','取消后的新目录完成');
    assert.equal(state.busy,0); assert.ok(state.peak<=3); assert.equal(win.isVisible(),false);
    return {scenarios:4,cancelled:state.cancelled,reads:state.reads.length,peak:state.peak,busy:state.busy,windowVisible:false};
  } finally { state.release(); await evaluate('if(window.directoryOriginalNow){Date.now=window.directoryOriginalNow;delete window.directoryOriginalNow;}'); }
};
