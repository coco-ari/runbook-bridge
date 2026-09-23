const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// 仅提供合成目录与可控制的迟到响应，不连接网络或打开原生窗口。
exports.createHarness = function createHarness() {
  const state = { reads:[], pending:[], holdRoot:false, holdLinks:false, links:false, peakLinks:0, jobs:[], uploadPolls:0, nested:false, paginatedPath:null, holdPlain:null, overrides:new Map(), peakReads:0 };
  state.read = async input => {
    const record = { path:input.path, cursor:input.cursor, links:Boolean(input.resolveLinks), done:false }; state.reads.push(record);
    const links = state.links, override = state.overrides.get(input.path);
    state.peakReads = Math.max(state.peakReads, state.reads.filter(item => !item.done).length);
    if (record.links) state.peakLinks = Math.max(state.peakLinks, state.reads.filter(item => item.links && !item.done).length);
    if ((state.holdRoot && input.path === '/' && !record.links) || (state.holdLinks && record.links) || (!record.links && state.holdPlain?.path === input.path && (state.holdPlain.cursor === undefined || state.holdPlain.cursor === input.cursor))) await new Promise((resolve,reject) => state.pending.push({ record, resolve:error => { if (error) { record.done=true; reject(error); } else resolve(); } }));
    const names = input.path === '/' ? ['alpha','beta','gamma'] : ['item.txt', ...(state.nested && ['/alpha','/beta'].includes(input.path) ? ['nested'] : []), ...(links ? ['shortcut'] : [])];
    const entries = names.map(name => ({ name, path:(input.path === '/' ? '' : input.path) + '/' + name,
      type:input.path === '/' || name === 'nested' ? 'directory' : name === 'shortcut' ? 'symlink' : 'file', size:1, mode:0o644, mtime:1,
      ...(name === 'shortcut' && record.links ? { linkTarget:'/fixture-target', linkTargetType:'file' } : {}) }));
    record.done = true;
    return { path:input.path, canonicalPath:input.path, snapshotId:input.snapshotId ?? randomUUID(), entries, nextCursor:state.paginatedPath === input.path && !input.cursor ? '200' : null, truncated:false, metadataPending:links && input.path !== '/' && !record.links, ...override };
  };
  state.release = (links, one = false, error = null, path = null) => {
    for (const pending of [...state.pending]) if (pending.record.links === links && (path === null || pending.record.path === path)) {
      state.pending.splice(state.pending.indexOf(pending), 1); pending.resolve(error); if (one) break;
    }
  };
  return state;
};

exports.run = async function run({ state, evaluate, click, until, wait, win }) {
  assert.equal(win.isVisible(), false, '目录生命周期专项必须保持原生窗口隐藏');
  const tree = name => '[role=treeitem][title="/' + name + '"]';
  const waitState = async predicate => { for (let i=0;i<200 && !predicate();i+=1) await wait(15); assert.ok(predicate(), '受控目录请求应在期限内收敛'); };
  const idle = () => until("!document.querySelector('[aria-label=\"刷新目录\"]').disabled", '目录刷新结束');
  const root = () => click('[aria-label="根目录"]');
  let clockOffset=0;
  const expireDirectories = () => { clockOffset+=31000; return evaluate('window.directoryOriginalNow ??= Date.now; Date.now=()=>window.directoryOriginalNow()+'+clockOffset+'; undefined;'); };
  const expanded = async (name, desired) => {
    if (await evaluate('document.querySelector('+JSON.stringify(tree(name))+').getAttribute("aria-expanded")') !== String(desired)) await click(tree(name));
    await until('document.querySelector('+JSON.stringify(tree(name))+').getAttribute("aria-expanded") === '+JSON.stringify(String(desired)), '展开状态更新');
    if (desired) await until('Boolean(document.querySelector('+JSON.stringify(tree(name + '/item.txt'))+'))', '目录内容到达');
  };
  const pauseRefresh = async () => { await idle(); state.holdRoot=true; const index=state.reads.length; await click('[aria-label="刷新目录"]'); await waitState(() => state.pending.some(item => !item.record.links)); return index; };
  const releaseRoot = () => { state.holdRoot=false; state.release(false); };
  const back = async () => { await click('[data-testid=server-workspace-back]'); await until('document.querySelector("[data-testid=server-workspace]").hidden', '工作区隐藏'); };
  const reopen = async () => { await click('[data-testid=plugin-open-workspace]'); await until('!document.querySelector("[data-testid=server-workspace]").hidden', '工作区重新显示'); };
  const plainPaths = from => state.reads.slice(from).filter(item => !item.links).map(item => item.path).sort();
  const queued = name => until('[...document.querySelectorAll('+JSON.stringify('[data-upload-path="/'+name+'"]')+')].some(row => row.textContent.includes("读取中"))', '目录读取已进入等待队列');
  try {
    await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha'))+'))', '合成目录就绪');
    for (const name of ['alpha','beta','gamma']) await expanded(name,true);
    await root(); await idle();
    let from=await pauseRefresh();
    await expanded('beta',false); await expanded('gamma',false); await root();
    releaseRoot(); await idle();
    assert.deepEqual(plainPaths(from), ['/','/alpha'], '收起的分支不继续排队刷新');

    for (const name of ['beta','gamma']) await expanded(name,true);
    await root(); from=await pauseRefresh();
    await back(); releaseRoot(); await idle();
    assert.deepEqual(plainPaths(from), ['/'], '隐藏工作区后只等待已发出的请求收尾');
    await reopen(); await idle();

    // 推进 Renderer 的缓存年龄，保留真实 Promise 调度和 IPC；不改变后台时钟。
    await expireDirectories();
    from=await pauseRefresh(); await back(); await reopen();
    await expanded('gamma',false); await root(); releaseRoot(); await idle();
    assert.deepEqual(plainPaths(from), ['/','/','/alpha','/beta'], '快速返回后重新读取已取消的根，旧响应不复活已收起分支');

    await expanded('gamma',true); await root();
    state.links=true; state.holdLinks=true; from=state.reads.length;
    await click('[aria-label="刷新目录"]'); await idle();
    await waitState(() => state.pending.filter(item => item.record.links).length === 2);
    await back(); const started=state.reads.filter(item => item.links).length;
    const first=state.pending.find(item => item.record.links).record;
    state.release(true,true); await waitState(() => first.done); await wait(250);
    assert.equal(state.reads.filter(item => item.links).length, started, '隐藏时完成一个链接请求也不补发下一页');
    await reopen(); await waitState(() => state.reads.filter(item => item.links).length === started+1);
    state.holdLinks=false; state.release(true); await waitState(() => state.pending.length===0 && state.reads.every(item => item.done));
    assert.equal(state.peakLinks,2, '恢复后仍保持两个链接页请求上限');

    state.holdLinks=true; await click('[aria-label="刷新目录"]'); await idle();
    await waitState(() => state.pending.filter(item => item.record.links).length === 2);
    await back(); from=state.reads.length;
    const expired=state.pending.find(item => item.record.links).record;
    state.release(true,true,Object.assign(new Error('合成目录快照过期'),{code:'WORKSPACE_DIRECTORY_EXPIRED'}));
    await waitState(() => expired.done); await wait(250);
    assert.deepEqual(plainPaths(from), [], '隐藏期间的迟到过期错误不触发目录重读');
    await reopen(); await waitState(() => plainPaths(from).includes(expired.path));
    state.holdLinks=false; state.release(true); await waitState(() => state.pending.length===0 && state.reads.every(item => item.done));
    state.links=false; await root(); await click('[aria-label="刷新目录"]'); await idle();
    for (const [scenario, holdRefresh] of [false,true].entries()) {
      state.jobs=['alpha','beta'].map(name => ({jobId:'hidden-upload-'+scenario+'-'+name, name:'changed.txt', path:'/'+name+'/changed.txt', bytes:1, transferred:0, direction:'upload', status:'running', canPause:true, phase:'uploading'}));
      const polled=state.uploadPolls; await waitState(() => state.uploadPolls>polled); await wait(100);
      if (holdRefresh) await pauseRefresh();
      await back(); from=state.reads.length;
      state.jobs=state.jobs.map((job,index) => index ? job : {...job,status:'completed',transferred:1,canRemove:true,canPause:false});
      let poll=state.uploadPolls; await waitState(() => state.uploadPolls>poll); await wait(150);
      state.jobs=state.jobs.map(job => ({...job,status:'completed',transferred:1,canRemove:true,canPause:false}));
      poll=state.uploadPolls; await waitState(() => state.uploadPolls>poll); await wait(250);
      assert.deepEqual(plainPaths(from), [], '隐藏期间连续完成上传只标记目录过期');
      await reopen(); if (holdRefresh) releaseRoot(); await idle();
      await waitState(() => plainPaths(from).includes('/alpha') && plainPaths(from).includes('/beta'));
      assert.deepEqual(plainPaths(from), ['/','/alpha','/beta'], '返回后合并补齐两批上传目录，迟到旧响应不能清除过期标记');
    }
    // 两个链接补齐占位、根刷新占位，真实展开请求必须等待后再接受收起取消。
    state.nested=true; state.links=true; state.holdLinks=true;
    await click('[aria-label="刷新目录"]'); await idle();
    await waitState(() => state.pending.filter(item => item.record.links).length === 2);
    from=await pauseRefresh();
    await click(tree('alpha/nested')); await until('document.querySelector('+JSON.stringify(tree('alpha/nested'))+').getAttribute("aria-expanded") === "true"', '子目录已排队展开'); await queued('alpha/nested');
    await expanded('alpha',false); releaseRoot(); await idle();
    assert.ok(!plainPaths(from).includes('/alpha/nested'), '收起祖先撤销尚未发出的子目录读取');

    from=state.reads.length; await expanded('alpha',true);
    await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha/nested/item.txt'))+'))', '重新展开祖先后自动恢复子目录');
    assert.equal(plainPaths(from).filter(path => path === '/alpha/nested').length, 1, '恢复被取消的子目录只读取一次');
    // 已恢复的子缓存先过期，后续收起断言才能覆盖真正排队的读取。
    await expireDirectories();
    from=await pauseRefresh();
    await click(tree('alpha/nested')); await click(tree('alpha/nested'));
    await until('document.querySelector('+JSON.stringify(tree('alpha/nested'))+').getAttribute("aria-expanded") === "true"', '再次展开子目录已排队'); await queued('alpha/nested');
    await click(tree('alpha/nested')); releaseRoot(); await idle();
    assert.ok(!plainPaths(from).includes('/alpha/nested'), '收起本目录撤销尚未发出的读取');

    from=await pauseRefresh(); await click(tree('alpha/nested')); await click(tree('beta/nested'));
    await queued('alpha/nested'); await queued('beta/nested');
    await click('[aria-label="收起所有目录"]'); releaseRoot(); await idle();
    assert.ok(!plainPaths(from).some(path => path.endsWith('/nested')), '全部收起撤销排队的所有子目录读取');
    state.holdLinks=false; state.release(true); await waitState(() => state.pending.length===0 && state.reads.every(item => item.done));
    state.links=false; state.nested=false;

    // 普通目录的迟到失效错误和分页过期，也必须在隐藏时停止补发。
    await expireDirectories();
    state.holdPlain={path:'/alpha'}; await click(tree('alpha'));
    await waitState(() => state.pending.some(item => item.record.path === '/alpha' && !item.record.links));
    await back(); from=state.reads.length; state.holdPlain=null;
    state.release(false,true,Object.assign(new Error('合成目录已删除'),{code:'SOURCE_NOT_FOUND'}),'/alpha');
    await waitState(() => state.pending.length===0); await wait(250);
    assert.deepEqual(plainPaths(from), [], '隐藏时普通目录失效不补发父目录读取');
    await reopen(); await idle(); await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha/item.txt'))+'))', '返回后恢复失效目录');
    assert.ok(plainPaths(from).includes('/'), '返回后重新核对失效目录的父目录');

    state.paginatedPath='/alpha'; await click('[aria-label="刷新目录"]'); await idle();
    state.holdPlain={path:'/alpha',cursor:'200'};
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "加载更多").click(); undefined;');
    await waitState(() => state.pending.some(item => item.record.path === '/alpha' && item.record.cursor === '200'));
    await back(); from=state.reads.length; state.holdPlain=null;
    state.release(false,true,Object.assign(new Error('合成目录快照过期'),{code:'WORKSPACE_DIRECTORY_EXPIRED'}),'/alpha');
    await waitState(() => state.pending.length===0); await wait(250);
    assert.deepEqual(plainPaths(from), [], '隐藏时分页过期不补发第一页读取');
    state.paginatedPath=null; await reopen(); await idle();
    await waitState(() => plainPaths(from).includes('/alpha'));
    const setPage = (directory, names, canonicalPath = directory) => state.overrides.set(directory, { canonicalPath,
      entries:names.map(name => ({ name, path:directory + '/' + name, type:name === 'nested' ? 'directory' : 'file', size:1, mode:0o644, mtime:1 })) });
    const absent = name => evaluate('!document.querySelector('+JSON.stringify(tree(name))+')');
    const releaseDirectory = (directory, error = null) => {
      if (directory === '/') state.holdRoot=false;
      if (state.holdPlain?.path === directory) state.holdPlain=null;
      state.release(false,false,error,directory);
    };
    const selectFresh = async (deep = false) => {
      state.overrides.clear(); state.nested=true;
      await root(); await click('[aria-label="收起所有目录"]'); await click('[aria-label="刷新目录"]'); await idle();
      await expireDirectories();
      await expanded('alpha',true);
      if (deep) await expanded('alpha/nested',true);
    };

    // 当前目录先返回也不能提前显示；根和当前目录必须在同一等待期间开始读取。
    await selectFresh(); setPage('/alpha',['item.txt','nested','fresh-direct.txt']);
    state.holdRoot=true; from=state.reads.length; await click('[aria-label="刷新目录"]');
    await waitState(() => state.pending.some(item => item.record.path === '/') && state.reads.slice(from).some(item => item.path === '/alpha' && item.done));
    assert.equal(await absent('alpha/fresh-direct.txt'),true,'根仍在读取时不发布准备好的子页');
    releaseDirectory('/'); await idle(); await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha/fresh-direct.txt'))+'))','根验证后显示当前目录');
    assert.equal(plainPaths(from).filter(path => path === '/alpha').length,1,'预取成功不重复读取当前目录');

    // 深层目录须等中间祖先也完成确认，不能把根成功当成整条路径已验证。
    await selectFresh(true); setPage('/alpha/nested',['item.txt','fresh-deep.txt']);
    state.holdRoot=true; state.holdPlain={path:'/alpha'}; from=state.reads.length;
    await click('[aria-label="刷新目录"]'); await waitState(() => state.reads.slice(from).some(item => item.path === '/alpha/nested' && item.done));
    assert.equal(await absent('alpha/nested/fresh-deep.txt'),true);
    releaseDirectory('/'); await waitState(() => state.pending.some(item => item.record.path === '/alpha'));
    assert.equal(await absent('alpha/nested/fresh-deep.txt'),true,'中间祖先未完成时仍不发布');
    releaseDirectory('/alpha'); await idle(); await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha/nested/fresh-deep.txt'))+'))','完整祖先链验证后发布');
    assert.equal(plainPaths(from).filter(path => path === '/alpha/nested').length,1);

    for (const changedTarget of [false,true]) {
      await selectFresh(true); setPage('/alpha/nested',['item.txt','rejected.txt']);
      setPage('/alpha',changedTarget ? ['item.txt','nested'] : [],changedTarget ? '/different-target' : '/alpha');
      state.holdRoot=true; state.holdPlain={path:'/alpha'}; from=state.reads.length;
      await click('[aria-label="刷新目录"]'); await waitState(() => state.reads.slice(from).some(item => item.path === '/alpha/nested' && item.done));
      releaseDirectory('/'); await waitState(() => state.pending.some(item => item.record.path === '/alpha'));
      releaseDirectory('/alpha'); await idle();
      assert.equal(await absent('alpha/nested/rejected.txt'),true,'父目录删除或改向后不能复活预备子页');
    }

    await selectFresh(); setPage('/alpha',['item.txt','rejected-root.txt']);
    state.holdRoot=true; from=state.reads.length; await click('[aria-label="刷新目录"]');
    await waitState(() => state.reads.slice(from).some(item => item.path === '/alpha' && item.done));
    releaseDirectory('/',Object.assign(new Error('合成根目录权限拒绝'),{code:'SOURCE_ACCESS_DENIED'})); await idle();
    assert.equal(await absent('alpha/rejected-root.txt'),true,'根读取失败时不发布预备子页');

    await selectFresh(); setPage('/alpha',['item.txt','fresh-return.txt']);
    state.holdRoot=true; from=state.reads.length; await click('[aria-label="刷新目录"]');
    await waitState(() => state.reads.slice(from).some(item => item.path === '/alpha' && item.done));
    await back(); releaseDirectory('/'); await idle();
    assert.equal(await absent('alpha/fresh-return.txt'),true,'隐藏后不发布旧批次准备结果');
    await reopen(); await idle(); await until('Boolean(document.querySelector('+JSON.stringify(tree('alpha/fresh-return.txt'))+'))','返回后以新请求刷新过期目录');
    assert.equal(plainPaths(from).filter(path => path === '/alpha').length,2,'返回后仅补一次新的当前目录读取');
    assert.ok(state.peakReads<=3,'目录请求始终受现有三个名额限制');
    assert.equal(state.peakLinks,2); assert.equal(win.isVisible(),false);
    return { scenarios:19, peakReads:state.peakReads, reads:state.reads.length, linkReads:state.reads.filter(item => item.links).length, peakLinks:state.peakLinks, windowVisible:false };
  } finally {
    state.overrides.clear(); state.holdRoot=state.holdLinks=false; state.holdPlain=null; state.release(false); state.release(true);
    await evaluate('if(window.directoryOriginalNow){Date.now=window.directoryOriginalNow;delete window.directoryOriginalNow;}');
  }
};
