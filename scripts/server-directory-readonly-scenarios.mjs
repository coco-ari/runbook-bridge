import assert from 'node:assert/strict';

// 只读取固定系统目录，条目与链接目标仅保留在内存，诊断只输出数量。
export async function probeDirectoryPages({ runtime, files, plugin, scope, owner, measure }) {
  const remotePath = '/usr/bin';
  const client = runtime.broker.requireSession(runtime.key(plugin)).client, originalSftp = client.sftp;
  const decorated = new WeakSet(), restorations = [], counters = { opens:0, enumerations:0, contentReads:0 };
  const decorate = channel => {
    if (!channel || decorated.has(channel)) return;
    decorated.add(channel);
    for (const [method, counter] of [['opendir','opens'], ['readdir','enumerations'], ['read','contentReads']]) {
      const original = channel[method];
      channel[method] = function(...args) { counters[counter] += 1; return original.apply(this, args); };
      restorations.push(() => { channel[method] = original; });
    }
  };
  client.sftp = function(callback) {
    return originalSftp.call(this, (error, channel) => { decorate(channel); callback(error, channel); });
  };
  // 组合专项可能已经取得空闲通道；计数必须包含复用通道，并在结束时撤销包装。
  for (const channel of runtime.broker.requireSession(runtime.key(plugin)).workspaceReads?.entries.keys() ?? []) decorate(channel);
  const read = payload => files.listDirectory(owner, { ...scope, path:remotePath, deferLinks:true, ...payload });
  const identity = entries => entries.map(({ name, path, type }) => ({ name, path, type }));
  const pages = [], seenNames = new Set();
  try {
    let page = await measure('directory.pages.first', () => read({}));
    const snapshotId = page.snapshotId, enumerationCount = counters.enumerations;
    assert.equal(counters.opens, 1); assert.ok(enumerationCount > 0);
    for (let index = 0; ; index += 1) {
      assert.ok(index < 50, '目录分页不能超过一万条上限');
      assert.equal(page.snapshotId, snapshotId); assert.equal(page.canonicalPath, remotePath);
      assert.ok(page.entries.length <= 200);
      for (const entry of page.entries) {
        assert.ok(!seenNames.has(entry.name), '完整分页不得重复条目'); seenNames.add(entry.name);
      }
      pages.push({ cursor:String(index * 200), page });
      if (page.nextCursor === null) break;
      assert.equal(page.entries.length, 200); assert.equal(page.nextCursor, String((index + 1) * 200));
      const cursor = page.nextCursor;
      page = await measure('directory.pages.next.' + (index + 1), () => read({ snapshotId, cursor }));
      assert.equal(counters.enumerations, enumerationCount, '续页不能再次枚举目录');
      assert.equal(counters.opens, 1);
    }
    await measure('directory.pages.revisit-first-and-last', async () => {
      for (const selected of pages.length > 1 ? [pages[0], pages.at(-1)] : [pages[0]]) {
        const repeated = await read({ snapshotId, cursor:selected.cursor });
        assert.deepEqual(repeated, selected.page);
      }
      assert.equal(counters.enumerations, enumerationCount);
    });
    const selected = pages.find(item => item.page.metadataPending);
    let resolvedLinks = 0;
    if (selected) {
      await measure('directory.pages.link-metadata-stable-order', async () => {
        const enriched = await read({ snapshotId, cursor:selected.cursor, resolveLinks:true });
        assert.equal(enriched.metadataPending, false); assert.equal(enriched.nextCursor, selected.page.nextCursor);
        assert.deepEqual(identity(enriched.entries), identity(selected.page.entries));
        const links = enriched.entries.filter(entry => entry.type === 'symlink');
        assert.ok(links.length > 0); assert.ok(links.every(entry => typeof entry.linkTargetType === 'string'));
        resolvedLinks = links.length;
        assert.deepEqual(await read({ snapshotId, cursor:selected.cursor }), enriched);
        assert.equal(counters.enumerations, enumerationCount); assert.equal(counters.opens, 1);
      });
    } else console.log(JSON.stringify({ feature:'directory.pages.link-metadata-stable-order', status:'not-covered', reason:'no-links-in-snapshot' }));
    await measure('directory.pages.reject-other-owner', async () => {
      await assert.rejects(files.listDirectory(owner + '-other', { ...scope, path:remotePath, deferLinks:true, snapshotId, cursor:'0' }), { code:'WORKSPACE_DIRECTORY_EXPIRED' });
      assert.equal(counters.enumerations, enumerationCount);
    });
    await measure('directory.pages.refresh-expires-old-snapshot', async () => {
      const refreshed = await read({}); assert.notEqual(refreshed.snapshotId, snapshotId);
      assert.equal(counters.opens, 2); assert.ok(counters.enumerations > enumerationCount);
      await assert.rejects(read({ snapshotId, cursor:'0' }), { code:'WORKSPACE_DIRECTORY_EXPIRED' });
      assert.equal(counters.contentReads, 0, '目录与链接属性查询不得读取文件正文');
    });
    console.log(JSON.stringify({ feature:'directory.pages.summary', status:'observed', pages:pages.length, entries:seenNames.size,
      resolvedLinks, complete:!pages.at(-1).page.truncated, ...counters }));
    if (pages.length < 2) console.log(JSON.stringify({ feature:'directory.pages.multiple-pages', status:'not-covered', reason:'fewer-than-two-pages' }));
  } finally { client.sftp = originalSftp; for (const restore of restorations.reverse()) restore(); }
}

// 使用生产目录队列和真实服务预算，仅读固定目录及系统版本文件，输出仅含计数与时间。
export async function probeDirectoryQueue({ files, scope, owner, measure, mixed = false }) {
  const { createWorkspaceReadQueue } = await import('../renderer/v2/src/features/server-workspace/workspace-read-queue.ts');
  const queue = createWorkspaceReadQueue(), queueOwner = {}, records = [];
  let active = 0, peakDirectories = 0, peakFileReads = 0, activeOrdinary = 0, peakOrdinary = 0, timer, current = true;
  const round = value => Math.round(value * 10) / 10;
  try {
    await measure(mixed ? 'files.mixed-reads' : 'directory.queue.with-preview', async () => {
      const started = performance.now();
      const requests = ['/usr/bin','/usr/lib','/etc','/var','/tmp'].map((remotePath,index) => queue.run(queueOwner,String(index),async () => {
        const begin = performance.now(); active += 1; peakDirectories = Math.max(peakDirectories,active);
        try {
          const pending = files.listDirectory(owner,{...scope,path:remotePath,deferLinks:true});
          peakFileReads = Math.max(peakFileReads,files.readCounts.get(owner) ?? 0);
          const page = await pending; assert.ok(Array.isArray(page.entries) && page.entries.length <= 200);
          records.push({kind:'directory',index,queuedMs:round(begin-started),readMs:round(performance.now()-begin),entries:page.entries.length});
        } finally { active -= 1; }
      },() => current));
      // 三个目录已借出名额后发起预览，验证第四个文件读取仍能进入服务。
      await Promise.resolve(); assert.equal(active,3);
      const readFile = (kind,index,operation,validate) => queue.run(queueOwner,kind+index,async () => {
        const begin=performance.now(); activeOrdinary+=1; peakOrdinary=Math.max(peakOrdinary,activeOrdinary);
        try {
          const pending=operation(); peakFileReads=Math.max(peakFileReads,files.readCounts.get(owner) ?? 0);
          validate(await pending);
          records.push({kind,index,queuedMs:round(begin-started),readMs:round(performance.now()-begin)});
        } finally {activeOrdinary-=1;}
      },()=>current,{kind:'file'});
      const nonempty = value => assert.ok(typeof value.content === 'string' && value.content.length > 0);
      const fileReads=[readFile('preview',0,()=>files.readFile(owner,{...scope,path:'/etc/os-release'}),nonempty)];
      if (mixed) {
        fileReads.push(readFile('preview',1,()=>files.readFile(owner,{...scope,path:'/etc/hostname'}),nonempty));
        fileReads.push(readFile('info',0,()=>files.fileInfo(owner,{...scope,path:'/usr/bin'}),value=>assert.equal(value.type,'directory')));
      }
      const settled = Promise.allSettled([...requests,...fileReads]);
      const deadline = new Promise((_resolve,reject) => {timer=setTimeout(() => reject(Object.assign(new Error('目录并发采样超过时限'),{code:'DIRECTORY_QUEUE_PROBE_TIMEOUT'})),260_000);});
      const results = await Promise.race([settled,deadline]);
      const failure = results.find(result => result.status === 'rejected'); if(failure) throw failure.reason;
      assert.equal(records.length,mixed ? 8 : 6); assert.equal(peakDirectories,3); assert.equal(peakFileReads,4); assert.ok(peakOrdinary <= 2);
      assert.equal(files.readCounts.get(owner) ?? 0,0);
      console.log(JSON.stringify({feature:'directory.queue.summary',status:'observed',peakDirectories,peakFileReads,peakOrdinary,records}));
    });
  } finally {current=false;queue.cancel(queueOwner);clearTimeout(timer);}
}
