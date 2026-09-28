import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ServerOperations } from '../src/server-operations.mjs';
import { AppError } from '../src/errors.mjs';
import { LOG_READ_BLOCK_BYTES as blockBytes } from '../src/log-read-checkpoint.mjs';

const plugin = {projectId:'fixture',environmentId:'fixture',pluginInstanceId:'server',revision:1,sources:[]};

function fixture(t, options = {}) {
  const body = Array.from({length:8000},(_,n)=>`合成内容 ${n} filler`).join('\n') + '\nRESUME_OK\n';
  const content = gzipSync(body,{level:0});
  const state = {generation:1,mtime:1,mode:0o100644,path:'/fixture.gz',quota:1,fail:true,requested:[],checkpoints:[],stalled:false};
  const metadata = () => ({type:'file',canonicalPath:state.path,path:state.path,size:content.length,mtime:state.mtime,mode:state.mode});
  const runtime = {withRemoteReadSession:async (_scope, operation) => operation({
    generation:state.generation,statPath:async()=>metadata(),
    readBuffer:async (_path,start,length,{checkpoint}) => {
      assert.equal(start,0);
      assert.equal(length,content.length);
      state.checkpoints.push(checkpoint);
      checkpoint.validate({canonicalPath:state.path,size:content.length,mtime:state.mtime,mode:state.mode});
      const reusedBytes = checkpoint.retainedBytes;
      let receivedBytes = 0;
      let count = 0;
      for(let offset=0;offset<content.length;offset+=blockBytes) {
        if(checkpoint.has(offset)) continue;
        if(state.fail && (state.stalled || count>=state.quota)) {
          throw new AppError('LOG_SEARCH_TIMEOUT','合成超时',{phase:'read',requestedBytes:length,receivedBytes,elapsedMs:20000,
            secret:'不得传播的合成错误正文',content:Buffer.from('不得传播')});
        }
        state.requested.push(offset);
        const chunk=content.subarray(offset,Math.min(offset+blockBytes,content.length));
        checkpoint.retain(offset,chunk);
        receivedBytes+=chunk.length;
        count+=1;
      }
      if(state.closeTimeout) throw new AppError('LOG_SEARCH_TIMEOUT','合成校验超时',{phase:'validation',requestedBytes:length,receivedBytes});
      return {...metadata(),content:Buffer.from(checkpoint.content),receivedBytes,reusedBytes};
    },
  })};
  const operations = new ServerOperations(runtime,{},options);
  t.after(()=>{
    for(const key of operations.logSnapshotCache.entries.keys()) operations.logSnapshotCache.remove(key);
    operations.logSnapshotCache.scheduleExpiry();
  });
  const args = {path:'/fixture.gz',queries:['RESUME_OK'],maxScanBytes:1024*1024,maxExpandedBytes:1024*1024};
  const search = (overrides={},scope=plugin) => operations.searchLogs(scope,{...args,...overrides});
  return {state,operations,args,search,content};
}

test('连续慢页保留块进度且最终匹配完整，诊断不泄露错误正文',async t=>{
  const f=fixture(t);
  let cursor,retained=0,remote=0;
  for(let page=0;page<30;page+=1) {
    const result=await f.search(cursor?{cursor}:{});
    remote+=result.remoteBytesRead;
    if(!result.nextCursor) {
      assert.equal(result.status,'complete');
      assert.deepEqual(result.matches.map(item=>item.text),['RESUME_OK']);
      break;
    }
    assert.equal(result.conclusion,'inconclusive');
    assert.equal(result.coverage.length,0);
    assert.ok(result.interruption.retainedBytes>retained);
    assert.equal(result.interruption.reusedBytes,retained);
    assert.equal(result.interruption.resumeAvailable,true);
    assert.equal(result.interruption.elapsedMs,20000);
    assert.doesNotMatch(JSON.stringify(result),/不得传播|secret|checkpoint/);
    retained=result.interruption.retainedBytes;
    cursor=result.nextCursor;
  }
  assert.equal(remote,f.content.length);
  assert.equal(new Set(f.state.requested).size,f.state.requested.length);
  assert.equal(f.operations.logSearchGate.active,0);
  assert.ok(f.operations.logSnapshotCache.stats().bytes<=64*1024*1024);
});

test('没有任何新字节的续查保留旧断点并明确报告停滞',async t=>{
  const f=fixture(t);
  const first=await f.search();
  f.state.stalled=true;
  const next=await f.search({cursor:first.nextCursor});
  assert.equal(next.remoteBytesRead,0);
  assert.equal(next.interruption.receivedBytes,0);
  assert.equal(next.interruption.retainedBytes,first.interruption.retainedBytes);
  assert.equal(next.interruption.reusedBytes,next.interruption.retainedBytes);
  assert.equal(next.interruption.resumeAvailable,true);
  assert.equal(next.coverage.length,0);
});

test('末次校验超时保留完整压缩输入，续查只校验不再传输',async t=>{
  const f=fixture(t);
  f.state.fail=false;
  f.state.closeTimeout=true;
  const first=await f.search();
  assert.equal(first.interruption.phase,'validation');
  assert.equal(first.interruption.retainedBytes,f.content.length);
  assert.equal(first.coverage.length,0);
  f.state.closeTimeout=false;
  const next=await f.search({cursor:first.nextCursor});
  assert.equal(next.remoteBytesRead,0);
  assert.equal(next.status,'complete');
  assert.equal(next.matchCount,1);
});

for(const change of ['mtime','mode','path']) test(`归档 ${change} 改变时拒绝复用并清零断点`,async t=>{
  const f=fixture(t);
  const first=await f.search();
  const checkpoint=f.state.checkpoints[0];
  if(change==='path') f.state.path='/changed.gz'; else f.state[change]+=1;
  await assert.rejects(f.search({cursor:first.nextCursor}),{code:'SOURCE_CHANGED'});
  assert.equal(f.operations.logSnapshotCache.entries.size,0);
  assert.ok(checkpoint.content.every(byte=>byte===0));
});

test('参数、项目和连接代次不匹配的游标不能触发读取',async t=>{
  const f=fixture(t);
  const first=await f.search();
  const count=f.state.requested.length;
  await assert.rejects(f.search({cursor:first.nextCursor,queries:['different']}),{code:'LOG_CURSOR_MISMATCH'});
  await assert.rejects(f.search({cursor:first.nextCursor},{...plugin,projectId:'other'}),{code:'LOG_CURSOR_MISMATCH'});
  f.state.generation+=1;
  await assert.rejects(f.search({cursor:first.nextCursor}),{code:'LOG_CURSOR_MISMATCH'});
  assert.equal(f.state.requested.length,count);
});

test('缓存过期主动清零，旧游标续查安全重读而不使用失效块',async t=>{
  const f=fixture(t,{logSnapshotCacheTtlMs:30});
  const first=await f.search();
  const checkpoint=f.state.checkpoints[0];
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.ok(checkpoint.content.every(byte=>byte===0));
  assert.equal(f.operations.logSnapshotCache.entries.size,0);
  f.state.fail=false;
  const next=await f.search({cursor:first.nextCursor});
  assert.equal(next.status,'complete');
  assert.equal(next.remoteBytesRead,f.content.length);
});

test('缓存容量不足不保留部分正文，也不假称可以断点续读',async t=>{
  const f=fixture(t,{maxLogSnapshotCacheBytes:16});
  const first=await f.search();
  assert.equal(first.interruption.resumeAvailable,false);
  assert.equal(first.interruption.retainedBytes,0);
  assert.equal(f.operations.logSnapshotCache.stats().bytes,0);
  assert.ok(f.state.checkpoints[0].content.every(byte=>byte===0));
});

test('显式刷新丢弃旧断点，同参数刷新游标仍可继续新断点',async t=>{
  const f=fixture(t);
  await f.search();
  const fresh=await f.search({refresh:true});
  assert.equal(fresh.interruption.reusedBytes,0);
  const next=await f.search({refresh:true,cursor:fresh.nextCursor});
  assert.equal(next.interruption.reusedBytes,blockBytes);
});
