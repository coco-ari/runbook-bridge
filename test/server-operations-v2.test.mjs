import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { ServerOperations } from '../src/server-operations.mjs';

const plugin={projectId:'p1',environmentId:'e1',pluginInstanceId:'s1',pluginType:'server',limits:{maxBytes:65536},actions:[{actionId:'service.status',serviceId:'orders',displayName:'Orders',unit:'orders.service'},{actionId:'filesystem.usage',mountId:'data',displayName:'Data',mountPath:'/srv/data'}],sources:[]};

const CRC32_TABLE = Array.from({ length:256 }, (_, index) => {
  let value=index;
  for(let bit=0;bit<8;bit+=1) value=(value&1)===1 ? 0xedb88320^(value>>>1) : value>>>1;
  return value>>>0;
});

function crc32(content){
  let value=0xffffffff;
  for(const byte of content) value=CRC32_TABLE[(value^byte)&0xff]^(value>>>8);
  return (value^0xffffffff)>>>0;
}

function createZip(entries){
  const localParts=[];
  const centralParts=[];
  let localOffset=0;
  for(const item of entries){
    const name=Buffer.from(item.name,'utf8');
    const content=Buffer.from(item.content??'');
    const compressed=deflateRawSync(content);
    const checksum=crc32(content);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(8,8);
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(compressed.length,18);
    local.writeUInt32LE(content.length,22);
    local.writeUInt16LE(name.length,26);
    localParts.push(local,name,compressed);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE((3<<8)|20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x800,8);
    central.writeUInt16LE(8,10);
    central.writeUInt32LE(checksum,16);
    central.writeUInt32LE(compressed.length,20);
    central.writeUInt32LE(content.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt32LE((0o100644*0x10000)>>>0,38);
    central.writeUInt32LE(localOffset,42);
    centralParts.push(central,name);
    localOffset+=local.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12);
  end.writeUInt32LE(localOffset,16);
  return Buffer.concat([...localParts,directory,end]);
}

function remoteFile(name,canonicalPath,content,mtime=1){
  return {name,canonicalPath,isDirectory:false,isFile:true,isSymbolicLink:false,size:Buffer.from(content).length,mtime};
}

function remoteDirectory(name,canonicalPath){
  return {name,canonicalPath,isDirectory:true,isFile:false,isSymbolicLink:false,size:0,mtime:0};
}

function createRemoteLogRuntime({files,directories={},readCanonicalPaths={},readDelayMs=0}){
  const stored=new Map(Object.entries(files).map(([remotePath,value])=>[
    remotePath,
    {
      content:Buffer.from(value?.content??value),
      mtime:Number(value?.mtime??1),
    },
  ]));
  const calls={stats:[],sessions:0,lists:[],reads:[],activeReads:0,maxActiveReads:0};
  const statPath=async(remotePath)=>{
    calls.stats.push(remotePath);
    const file=stored.get(remotePath);
    if(file) return {path:remotePath,canonicalPath:remotePath,type:'file',size:file.content.length,mtime:file.mtime,mode:0o100644};
    if(Object.hasOwn(directories,remotePath)) return {path:remotePath,canonicalPath:remotePath,type:'directory',size:0,mtime:0,mode:0o040755};
    const error=new Error('not found');
    error.code='SOURCE_NOT_FOUND';
    throw error;
  };
  const runtime={
    statRemotePath:async(_plugin,remotePath)=>statPath(remotePath),
    withRemoteReadSession:async(_plugin,operation)=>{
      calls.sessions+=1;
      return operation({
        statPath,
        listDirectory:async(remotePath)=>{
          calls.lists.push(remotePath);
          return directories[remotePath]??[];
        },
        readBuffer:async(remotePath,start,maxBytes)=>{
          calls.reads.push({remotePath,start,maxBytes});
          calls.activeReads+=1;
          calls.maxActiveReads=Math.max(calls.maxActiveReads,calls.activeReads);
          try{
            if(readDelayMs>0) await new Promise((resolve)=>setTimeout(resolve,readDelayMs));
            const file=stored.get(remotePath);
            assert.ok(file,`unexpected read: ${remotePath}`);
            const content=file.content.subarray(start,Math.min(file.content.length,start+maxBytes));
            return {
              canonicalPath:readCanonicalPaths[remotePath]??remotePath,
              content,
              startByte:start,
              endByte:start+content.length,
              size:file.content.length,
              mtime:file.mtime,
              truncated:start+content.length<file.content.length,
            };
          }finally{
            calls.activeReads-=1;
          }
        },
      });
    },
  };
  const updateFile=(remotePath,value)=>{
    stored.set(remotePath,{
      content:Buffer.from(value?.content??value),
      mtime:Number(value?.mtime??1),
    });
  };
  return {runtime,calls,updateFile};
}

test('Server operations map actionId to fixed commands and reject arbitrary parameters', () => {
  const operations=new ServerOperations({},{});
  assert.equal(operations.commandFor(plugin,'service.status',{serviceId:'orders'}),'LC_ALL=C systemctl --no-pager --full status -- orders.service');
  assert.equal(operations.commandFor(plugin,'filesystem.usage',{mountId:'data'}),'LC_ALL=C df -P -B1 -- /srv/data');
  assert.throws(()=>operations.commandFor(plugin,'service.status',{serviceId:'orders',command:'rm -rf /'}),(error)=>error.code==='INVALID_ARGUMENT');
  assert.throws(()=>operations.commandFor(plugin,'bash',{}),(error)=>error.code==='POLICY_DENIED');
});

test('log tools reject configuration handles while config reads return sensitive content unchanged', async () => {
  const content='username=app\npassword=supersecret\nnormal=value';
  const runtime={readRemoteRange:async()=>({content,startByte:0,endByte:Buffer.byteLength(content),size:Buffer.byteLength(content),truncated:false,mtime:7})};
  const operations=new ServerOperations(runtime,{});
  const configSource={sourceId:'config',displayName:'Config',kind:'config',root:'/etc/app',patterns:['*.conf'],maxFileBytes:1024};
  const scopedPlugin={...plugin,sources:[configSource]};
  const fileId=operations.rememberFile(scopedPlugin,configSource,{canonicalPath:'/etc/app/app.conf',size:Buffer.byteLength(content),mtime:7});
  await assert.rejects(()=>operations.readLog(scopedPlugin,{fileId}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  await assert.rejects(()=>operations.searchLogs(scopedPlugin,{fileIds:[fileId],contains:'secret'}),(error)=>error.code==='SOURCE_NOT_ALLOWED');
  let cursor=null;
  let combined='';
  do {
    const page=await operations.readConfig(scopedPlugin,{fileId,cursor,maxBytes:5});
    combined+=page.content;
    cursor=page.nextCursor;
  } while(cursor);
  assert.match(combined,/supersecret/);
  assert.doesNotMatch(combined,/\[REDACTED\]/);
});

test('recursive file discovery reuses one remote read session', async () => {
  let sessions=0;
  let activeListings=0;
  let maxActiveListings=0;
  const listed=[];
  const directories={
    '/logs':[
      {name:'api',canonicalPath:'/logs/api',isDirectory:true,isFile:false,isSymbolicLink:false},
      {name:'manage',canonicalPath:'/logs/manage',isDirectory:true,isFile:false,isSymbolicLink:false},
      {name:'root.log',canonicalPath:'/logs/root.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:10,mtime:3},
    ],
    '/logs/api':[
      {name:'today.log',canonicalPath:'/logs/api/today.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:20,mtime:4},
    ],
    '/logs/manage':[],
  };
  const runtime={
    withRemoteReadSession:async(_plugin,operation)=>{
      sessions+=1;
      return operation({
        listDirectory:async(remotePath)=>{
          listed.push(remotePath);
          activeListings+=1;
          maxActiveListings=Math.max(maxActiveListings,activeListings);
          await new Promise((resolve)=>setTimeout(resolve,2));
          activeListings-=1;
          return directories[remotePath] ?? [];
        },
        readRange:async()=>{throw new Error('unexpected read');},
      });
    },
  };
  const operations=new ServerOperations(runtime,{});
  const result=await operations.findFiles(plugin,{path:'/logs',pattern:'*.log',maxDepth:2,maxResults:10});
  assert.equal(sessions,1);
  assert.equal(maxActiveListings,2);
  assert.deepEqual(listed,['/logs','/logs/api','/logs/manage']);
  assert.deepEqual(result.files.map((file)=>file.path),['/logs/root.log','/logs/api/today.log']);
});

test('file search shares one remote read session across discovery and reads', async () => {
  let sessions=0;
  let reads=0;
  const runtime={
    withRemoteReadSession:async(_plugin,operation)=>{
      sessions+=1;
      return operation({
        listDirectory:async()=>[
          {name:'app.log',canonicalPath:'/logs/app.log',isDirectory:false,isFile:true,isSymbolicLink:false,size:25,mtime:5},
        ],
        readRange:async(remotePath,start)=>{
          reads+=1;
          assert.equal(remotePath,'/logs/app.log');
          assert.equal(start,0);
          return {canonicalPath:remotePath,content:'INFO boot\nERROR failed\n',startByte:0,endByte:23,size:23,truncated:false,mtime:5};
        },
      });
    },
  };
  const operations=new ServerOperations(runtime,{});
  const result=await operations.searchFiles(plugin,{path:'/logs',pattern:'*.log',contains:'ERROR',maxDepth:1,maxFiles:5,maxMatches:5,maxScanBytes:65536});
  assert.equal(sessions,1);
  assert.equal(reads,1);
  assert.equal(result.matchCount,1);
  assert.equal(result.matches[0].text,'ERROR failed');
});

test('legacy fileIds and contains search keeps the original result fields', async () => {
  const content=Buffer.from('INFO ready\nERROR failed\n');
  const source={sourceId:'logs',displayName:'Logs',kind:'log',root:'/logs',patterns:['*.log'],maxFileBytes:1024*1024};
  const scopedPlugin={...plugin,sources:[source]};
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/app.log':{content,mtime:7}}});
  const operations=new ServerOperations(runtime,{});
  const fileId=operations.rememberFile(scopedPlugin,source,{canonicalPath:'/logs/app.log',size:content.length,mtime:7});

  const result=await operations.searchLogs(scopedPlugin,{
    fileIds:[fileId],
    contains:'ERROR',
    maxLines:5,
    maxFiles:100,
    maxScanBytes:9 * 1024 * 1024,
  });

  assert.equal(calls.sessions,1);
  assert.equal(calls.reads.length,1);
  assert.equal(result.matchCount,1);
  assert.equal(result.scannedFiles,1);
  assert.equal(result.scannedBytes,content.length);
  assert.equal(result.truncated,false);
  assert.equal(result.limitsApplied.maxLines,5);
  assert.equal(result.limitsApplied.maxMatches,5);
  assert.equal(result.limitsApplied.maxFiles,100);
  assert.equal(result.limitsApplied.maxScanBytes,9 * 1024 * 1024);
  assert.equal(result.matches[0].fileId,fileId);
  assert.equal(result.matches[0].relativePath,'app.log');
  assert.equal(result.matches[0].lineOffset,1);
  assert.equal(result.matches[0].text,'ERROR failed');
  assert.deepEqual(result.selection,{type:'fileIds',fileIds:[fileId],includeArchives:true});
});

test('path directory recursively scans plain, gzip, and ZIP logs once for queries any', async () => {
  const plain=Buffer.from('INFO ready\nERROR plain\n');
  const gzip=gzipSync(Buffer.from('WARN timeout in gzip\n'));
  const zip=createZip([{name:'worker.log',content:'ERROR zip timeout\n'}]);
  const ignored=Buffer.from('ERROR ignored markdown\n');
  const directories={
    '/logs':[
      remoteFile('app.log','/logs/app.log',plain,4),
      remoteFile('archive.log.gz','/logs/archive.log.gz',gzip,3),
      remoteDirectory('nested','/logs/nested'),
      remoteFile('README.md','/logs/README.md',ignored,5),
    ],
    '/logs/nested':[
      remoteFile('logs.zip','/logs/nested/logs.zip',zip,2),
    ],
  };
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/logs/app.log':{content:plain,mtime:4},
      '/logs/archive.log.gz':{content:gzip,mtime:3},
      '/logs/nested/logs.zip':{content:zip,mtime:2},
      '/logs/README.md':{content:ignored,mtime:5},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs',
    queries:['ERROR','timeout'],
    matchMode:'any',
    maxDepth:2,
    maxFiles:10,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.deepEqual(calls.stats,['/logs']);
  assert.equal(calls.sessions,1);
  assert.deepEqual(calls.lists,['/logs','/logs/nested']);
  assert.deepEqual(calls.reads.map(({remotePath})=>remotePath).sort(),[
    '/logs/app.log',
    '/logs/archive.log.gz',
    '/logs/nested/logs.zip',
  ]);
  assert.equal(result.query.mode,'any');
  assert.equal(result.query.count,2);
  assert.equal(result.filesConsidered,3);
  assert.equal(result.scannedFiles,3);
  assert.equal(result.archivesScanned,2);
  assert.equal(result.matchCount,3);
  assert.equal(result.totalMatches,3);
  assert.deepEqual(result.matches.find(({archiveMember})=>archiveMember==='archive.log').matchedQueries,['timeout']);
  assert.deepEqual(result.matches.find(({archiveMember})=>archiveMember==='worker.log').matchedQueries,['ERROR','timeout']);
  assert.equal(result.matches.some(({path})=>path.endsWith('README.md')),false);
});

test('sourceId selection enforces source patterns and matches archives after removing their suffix', async () => {
  const orders=gzipSync(Buffer.from('needle in orders\n'));
  const debug=gzipSync(Buffer.from('needle in debug\n'));
  const wrongExtension=gzipSync(Buffer.from('needle in text\n'));
  const directories={
    '/registered':[
      remoteFile('orders-2026.log.gz','/registered/orders-2026.log.gz',orders,5),
      remoteFile('debug.log.gz','/registered/debug.log.gz',debug,4),
      remoteFile('orders-2026.txt.gz','/registered/orders-2026.txt.gz',wrongExtension,3),
    ],
  };
  const source={sourceId:'runtime',displayName:'Runtime',kind:'log',root:'/registered',patterns:['orders-*.log'],maxFileBytes:1024*1024};
  const scopedPlugin={...plugin,sources:[source]};
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/registered/orders-2026.log.gz':{content:orders,mtime:5},
      '/registered/debug.log.gz':{content:debug,mtime:4},
      '/registered/orders-2026.txt.gz':{content:wrongExtension,mtime:3},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(scopedPlugin,{
    sourceId:'runtime',
    pattern:'orders-2026.log',
    queries:['needle'],
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.deepEqual(calls.reads.map(({remotePath})=>remotePath),['/registered/orders-2026.log.gz']);
  assert.equal(result.filesConsidered,1);
  assert.equal(result.matchCount,1);
  assert.equal(result.matches[0].relativePath,'orders-2026.log.gz');
  assert.equal(result.matches[0].archiveMember,'orders-2026.log');
  assert.deepEqual(result.selection,{
    type:'sourceId',
    sourceId:'runtime',
    pattern:'orders-2026.log',
    root:'/registered',
    includeArchives:true,
  });
});

test('sourceId selection excludes files above the registered source maxFileBytes', async () => {
  const small=Buffer.from('needle\n');
  const oversized=Buffer.from('needle in an oversized source file\n');
  const directories={'/registered':[
    remoteFile('small.log','/registered/small.log',small,2),
    remoteFile('oversized.log','/registered/oversized.log',oversized,3),
  ]};
  const source={sourceId:'runtime',displayName:'Runtime',kind:'log',root:'/registered',patterns:['*.log'],maxFileBytes:small.length};
  const scopedPlugin={...plugin,sources:[source]};
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/registered/small.log':{content:small,mtime:2},
      '/registered/oversized.log':{content:oversized,mtime:3},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(scopedPlugin,{
    sourceId:'runtime',
    queries:['needle'],
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.deepEqual(calls.reads.map(({remotePath})=>remotePath),['/registered/small.log']);
  assert.equal(result.filesConsidered,1);
  assert.equal(result.matchCount,1);
});

test('matchMode all and caseSensitive are forwarded to the single-pass snapshot search', async () => {
  const content=Buffer.from('ERROR timeout exact\nerror timeout folded\nERROR only\n');
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/case.log':{content,mtime:8}}});
  const operations=new ServerOperations(runtime,{});

  const exact=await operations.searchLogs(plugin,{
    path:'/logs/case.log',
    queries:['ERROR','timeout'],
    matchMode:'all',
    caseSensitive:true,
    maxScanBytes:65536,
  });
  const folded=await operations.searchLogs(plugin,{
    path:'/logs/case.log',
    queries:['ERROR','timeout'],
    matchMode:'all',
    caseSensitive:false,
    maxScanBytes:65536,
  });

  assert.equal(exact.matchCount,1);
  assert.equal(exact.matches[0].lineNumber,1);
  assert.deepEqual(exact.matches[0].matchedQueries,['ERROR','timeout']);
  assert.equal(folded.matchCount,2);
  assert.deepEqual(folded.matches.map(({lineNumber})=>lineNumber),[1,2]);
  assert.equal(folded.query.caseSensitive,false);
  assert.equal(calls.reads.length,1);
});

test('a second search with different queries reuses the cached snapshot without readBuffer', async () => {
  const content=Buffer.from('alpha only\nbeta only\n');
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/cache.log':{content,mtime:9}}});
  const operations=new ServerOperations(runtime,{});

  const first=await operations.searchLogs(plugin,{path:'/logs/cache.log',queries:['alpha'],maxScanBytes:65536});
  const second=await operations.searchLogs(plugin,{path:'/logs/cache.log',queries:['beta'],maxScanBytes:65536});

  assert.equal(first.matches[0].text,'alpha only');
  assert.equal(first.cache.hits,0);
  assert.equal(first.cache.misses,1);
  assert.equal(second.matches[0].text,'beta only');
  assert.equal(second.cache.hits,1);
  assert.equal(second.cache.misses,0);
  assert.equal(second.cache.savedRemoteBytes,content.length);
  assert.equal(second.remoteBytesRead,0);
  assert.equal(calls.reads.length,1);
});

test('expired snapshots are actively zeroed and removed without another cache access', async () => {
  const content=Buffer.from('short lived\n');
  const {runtime}=createRemoteLogRuntime({files:{'/logs/expiring.log':{content,mtime:9}}});
  const operations=new ServerOperations(runtime,{}, {logSnapshotCacheTtlMs:20});

  await operations.searchLogs(plugin,{path:'/logs/expiring.log',queries:['short'],maxScanBytes:65536});
  assert.equal(operations.logSnapshotCache.entries.size,1);
  await new Promise((resolve)=>setTimeout(resolve,60));
  assert.equal(operations.logSnapshotCache.entries.size,0);
});

test('fileId cache reuse revalidates the remote file snapshot before returning old content', async () => {
  const original=Buffer.from('alpha only\n');
  const source={sourceId:'logs',displayName:'Logs',kind:'log',root:'/logs',patterns:['*.log'],maxFileBytes:1024*1024};
  const scopedPlugin={...plugin,sources:[source]};
  const {runtime,calls,updateFile}=createRemoteLogRuntime({files:{'/logs/cache.log':{content:original,mtime:9}}});
  const operations=new ServerOperations(runtime,{});
  const fileId=operations.rememberFile(scopedPlugin,source,{canonicalPath:'/logs/cache.log',size:original.length,mtime:9});

  const first=await operations.searchLogs(scopedPlugin,{fileIds:[fileId],contains:'alpha',maxScanBytes:65536});
  assert.equal(first.matchCount,1);
  updateFile('/logs/cache.log',{content:Buffer.from('bravo only\n'),mtime:10});
  await assert.rejects(
    operations.searchLogs(scopedPlugin,{fileIds:[fileId],contains:'alpha',maxScanBytes:65536}),
    (error)=>error.code==='SOURCE_CHANGED',
  );

  assert.equal(calls.reads.length,1);
  assert.equal(calls.stats.filter((remotePath)=>remotePath==='/logs/cache.log').length,2);
});

test('searches for the same plugin queue instead of expanding large snapshots concurrently', async () => {
  const first=Buffer.from('needle first\n');
  const second=Buffer.from('needle second\n');
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/logs/first.log':{content:first,mtime:1},
      '/logs/second.log':{content:second,mtime:2},
    },
    readDelayMs:25,
  });
  const operations=new ServerOperations(runtime,{});

  const [left,right]=await Promise.all([
    operations.searchLogs(plugin,{path:'/logs/first.log',queries:['needle'],maxScanBytes:65536}),
    operations.searchLogs(plugin,{path:'/logs/second.log',queries:['needle'],maxScanBytes:65536}),
  ]);

  assert.equal(left.matchCount,1);
  assert.equal(right.matchCount,1);
  assert.equal(calls.maxActiveReads,1);
});

test('directory discovery counts matching logs rather than the first 1000 unrelated files', async () => {
  const content=Buffer.from('needle survives\n');
  const unrelated=Array.from({length:1000},(_,index)=>
    remoteFile(`note-${index}.md`,`/mixed/note-${index}.md`,Buffer.from('ignored'),index));
  const directories={'/mixed':[...unrelated,remoteFile('app.log','/mixed/app.log',content,2000)]};
  const {runtime,calls}=createRemoteLogRuntime({files:{'/mixed/app.log':{content,mtime:2000}},directories});
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/mixed',
    queries:['needle'],
    maxDepth:0,
    maxFiles:10,
    maxScanBytes:65536,
  });

  assert.equal(result.matchCount,1);
  assert.deepEqual(calls.reads.map(({remotePath})=>remotePath),['/mixed/app.log']);
});

test('directory search rejects a file whose canonical path changes before read', async () => {
  const content=Buffer.from('secret\n');
  const directories={'/logs':[remoteFile('app.log','/logs/app.log',content,1)]};
  const {runtime}=createRemoteLogRuntime({
    files:{'/logs/app.log':{content,mtime:1}},
    directories,
    readCanonicalPaths:{'/logs/app.log':'/etc/secret'},
  });
  const operations=new ServerOperations(runtime,{});

  await assert.rejects(
    operations.searchLogs(plugin,{path:'/logs',queries:['secret'],maxScanBytes:65536}),
    (error)=>error.code==='SOURCE_CHANGED',
  );
});

test('tail-only matches identify line numbers as relative to the scanned tail', async () => {
  const content=Buffer.concat([Buffer.alloc(70_000,0x78),Buffer.from('\nneedle\n')]);
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/large.log':{content,mtime:3}}});
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs/large.log',
    queries:['needle'],
    maxScanBytes:131072,
    maxExpandedBytes:65536,
  });

  assert.equal(result.matchCount,1);
  assert.equal(result.matches[0].lineNumberScope,'scannedTail');
  assert.ok(result.matches[0].scanStartByte>0);
  assert.deepEqual(calls.reads.map(({start,maxBytes})=>({start,maxBytes})),[
    {start:0,maxBytes:4},
    {start:content.length-65536,maxBytes:65536},
  ]);
  assert.equal(result.coverage[0].scannedBytes,65536);
  assert.equal(result.coverage[0].probeBytesRead,4);
  assert.ok(result.truncationReasons.includes('fileTailOnly'));
});

test('searchLogs rejects ambiguous selectors and ambiguous or missing query input before remote I/O', async () => {
  const source={sourceId:'logs',displayName:'Logs',kind:'log',root:'/logs',patterns:['*.log'],maxFileBytes:1024};
  const scopedPlugin={...plugin,sources:[source]};
  const {runtime,calls}=createRemoteLogRuntime({files:{},directories:{'/logs':[]}});
  const operations=new ServerOperations(runtime,{});
  const invalid=[
    {path:'/logs',sourceId:'logs',queries:['needle']},
    {path:'/logs'},
    {path:'/logs',contains:'needle',queries:['needle']},
  ];

  for(const args of invalid){
    await assert.rejects(operations.searchLogs(scopedPlugin,args),(error)=>error.code==='INVALID_ARGUMENT');
  }
  assert.equal(calls.stats.length,0);
  assert.equal(calls.sessions,0);
  assert.equal(calls.reads.length,0);
});

test('archive limits and dangerous ZIP members are surfaced as skipped and truncated', async () => {
  const limited=createZip([
    {name:'one.log',content:'hit one\n'},
    {name:'two.log',content:'hit two\n'},
  ]);
  const dangerous=createZip([
    {name:'safe.log',content:'hit safe\n'},
    {name:'../escape.log',content:'hit escape\n'},
  ]);
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/logs/limited.zip':{content:limited,mtime:10},
      '/logs/dangerous.zip':{content:dangerous,mtime:11},
    },
  });
  const operations=new ServerOperations(runtime,{});

  const rejected=await operations.searchLogs(plugin,{
    path:'/logs/limited.zip',
    queries:['hit'],
    maxArchiveEntries:1,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });
  const partial=await operations.searchLogs(plugin,{
    path:'/logs/dangerous.zip',
    queries:['hit'],
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.equal(rejected.truncated,true);
  assert.deepEqual(rejected.truncationReasons,['archiveRejected']);
  assert.equal(rejected.skipped.length,1);
  assert.equal(rejected.skipped[0].code,'LOG_ARCHIVE_ENTRY_LIMIT');
  assert.equal(rejected.scannedFiles,0);
  assert.equal(partial.truncated,true);
  assert.ok(partial.truncationReasons.includes('archiveEntriesSkipped'));
  assert.equal(partial.matchCount,1);
  assert.equal(partial.matches[0].archiveMember,'safe.log');
  assert.deepEqual(partial.skipped,[{
    path:'/logs/dangerous.zip',
    archiveMember:'../escape.log',
    code:'LOG_ARCHIVE_ENTRY_UNSAFE_PATH_SKIPPED',
  }]);
  assert.equal(calls.reads.length,2);
});

test('maxArchiveEntries is a total request budget across multiple archives', async () => {
  const first=createZip([{name:'first.log',content:'hit first\n'}]);
  const second=createZip([{name:'second.log',content:'hit second\n'}]);
  const directories={'/logs':[
    remoteFile('first.zip','/logs/first.zip',first,2),
    remoteFile('second.zip','/logs/second.zip',second,1),
  ]};
  const {runtime}=createRemoteLogRuntime({
    files:{
      '/logs/first.zip':{content:first,mtime:2},
      '/logs/second.zip':{content:second,mtime:1},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs',
    queries:['hit'],
    maxArchiveEntries:1,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.equal(result.archivesScanned,1);
  assert.equal(result.archiveEntriesScanned,1);
  assert.equal(result.matchCount,1);
  assert.ok(result.skipped.some(({code})=>code==='ARCHIVE_ENTRY_BUDGET_EXHAUSTED'));
  assert.ok(result.truncationReasons.includes('maxArchiveEntries'));
});

test('failed ZIP work consumes the total archive-entry budget before the next archive', async () => {
  const failing=createZip([
    {name:'first.log',content:'hit first\n'},
    {name:'oversized.log',content:Buffer.alloc(100_000,0x78)},
  ]);
  const valid=createZip([{name:'later.log',content:'hit later\n'}]);
  const directories={'/logs':[
    remoteFile('failing.zip','/logs/failing.zip',failing,2),
    remoteFile('valid.zip','/logs/valid.zip',valid,1),
  ]};
  const {runtime}=createRemoteLogRuntime({
    files:{
      '/logs/failing.zip':{content:failing,mtime:2},
      '/logs/valid.zip':{content:valid,mtime:1},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs',
    queries:['hit'],
    maxArchiveEntries:2,
    maxScanBytes:65536,
    maxExpandedBytes:200000,
  });

  assert.equal(result.archiveEntriesScanned,2);
  assert.equal(result.matchCount,0);
  assert.ok(result.skipped.some(({code})=>code==='LOG_ARCHIVE_COMPRESSION_RATIO'));
  assert.ok(result.skipped.some(({code})=>code==='ARCHIVE_ENTRY_BUDGET_EXHAUSTED'));
  assert.ok(result.truncationReasons.includes('maxArchiveEntries'));
});

test('includeArchives false rejects magic-detected archives and does not reuse an enabled cache entry', async () => {
  const disguised=gzipSync(Buffer.from('hidden needle\n'));
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/disguised.log':{content:disguised,mtime:4}}});
  const operations=new ServerOperations(runtime,{});

  const enabled=await operations.searchLogs(plugin,{
    path:'/logs/disguised.log',
    queries:['needle'],
    includeArchives:true,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });
  const disabled=await operations.searchLogs(plugin,{
    path:'/logs/disguised.log',
    queries:['needle'],
    includeArchives:false,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.equal(enabled.matchCount,1);
  assert.equal(disabled.matchCount,0);
  assert.deepEqual(disabled.skipped,[{path:'/logs/disguised.log',code:'ARCHIVES_EXCLUDED'}]);
  assert.equal(disabled.cache.hits,0);
  assert.equal(calls.reads.length,2);
});

test('includeArchives false detects a disguised archive before a tail-only read', async () => {
  const disguised=Buffer.alloc(70_000);
  disguised.writeUInt32LE(0x04034b50,0);
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/large.log':{content:disguised,mtime:5}}});
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs/large.log',
    queries:['needle'],
    includeArchives:false,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.equal(result.matchCount,0);
  assert.deepEqual(result.skipped,[{path:'/logs/large.log',code:'ARCHIVES_EXCLUDED'}]);
  assert.deepEqual(calls.reads,[{remotePath:'/logs/large.log',start:0,maxBytes:4}]);
});

test('a magic-only archive cannot bypass an exhausted request entry budget', async () => {
  const known=gzipSync(Buffer.from('hit known\n'));
  const disguised=gzipSync(Buffer.from('hit disguised\n'));
  const directories={'/logs':[
    remoteFile('known.log.gz','/logs/known.log.gz',known,2),
    remoteFile('disguised.log','/logs/disguised.log',disguised,1),
  ]};
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/logs/known.log.gz':{content:known,mtime:2},
      '/logs/disguised.log':{content:disguised,mtime:1},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs',
    queries:['hit'],
    maxArchiveEntries:1,
    maxScanBytes:65536,
    maxExpandedBytes:65536,
  });

  assert.equal(result.archiveEntriesScanned,1);
  assert.equal(result.matchCount,1);
  assert.equal(result.matches[0].path,'/logs/known.log.gz');
  assert.ok(result.skipped.some(({path,code})=>
    path==='/logs/disguised.log' && code==='ARCHIVE_ENTRY_BUDGET_EXHAUSTED'));
  assert.deepEqual(calls.reads.map(({remotePath,start,maxBytes})=>({remotePath,start,maxBytes})),[
    {remotePath:'/logs/known.log.gz',start:0,maxBytes:known.length},
    {remotePath:'/logs/disguised.log',start:0,maxBytes:4},
  ]);
});

test('a large magic-only gzip is fully planned as an archive instead of searching its compressed tail', async () => {
  const expanded=Buffer.alloc(65536);
  let seed=0x12345678;
  for(let index=0;index<expanded.length;index+=1){
    seed^=seed<<13;
    seed^=seed>>>17;
    seed^=seed<<5;
    expanded[index]=seed&0xff;
  }
  Buffer.from('\nneedle\n').copy(expanded,expanded.length-8);
  const disguised=gzipSync(expanded,{level:1});
  assert.ok(disguised.length>65536);
  const {runtime,calls}=createRemoteLogRuntime({files:{'/logs/disguised.log':{content:disguised,mtime:6}}});
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs/disguised.log',
    queries:['needle'],
    maxScanBytes:131072,
    maxExpandedBytes:65536,
  });

  assert.equal(result.matchCount,1);
  assert.equal(result.archivesScanned,1);
  assert.equal(result.matches[0].archiveMember,'disguised.log');
  assert.deepEqual(calls.reads.map(({start,maxBytes})=>({start,maxBytes})),[
    {start:0,maxBytes:4},
    {start:0,maxBytes:disguised.length},
  ]);
});

test('a plain-file type probe that exhausts the scan budget truncates instead of reporting SOURCE_CHANGED', async () => {
  const first=Buffer.alloc(65532,0x61);
  const second=Buffer.from('ordinary');
  const directories={'/logs':[
    remoteFile('first.log','/logs/first.log',first,2),
    remoteFile('second.log','/logs/second.log',second,1),
  ]};
  const {runtime,calls}=createRemoteLogRuntime({
    files:{
      '/logs/first.log':{content:first,mtime:2},
      '/logs/second.log':{content:second,mtime:1},
    },
    directories,
  });
  const operations=new ServerOperations(runtime,{});

  const result=await operations.searchLogs(plugin,{
    path:'/logs',
    queries:['needle'],
    maxScanBytes:65536,
    maxExpandedBytes:131072,
  });

  assert.equal(result.matchCount,0);
  assert.equal(result.scannedBytes,65536);
  assert.ok(result.truncationReasons.includes('maxScanBytes'));
  assert.deepEqual(calls.reads.map(({remotePath,start,maxBytes})=>({remotePath,start,maxBytes})),[
    {remotePath:'/logs/first.log',start:0,maxBytes:first.length},
    {remotePath:'/logs/second.log',start:0,maxBytes:4},
  ]);
});
