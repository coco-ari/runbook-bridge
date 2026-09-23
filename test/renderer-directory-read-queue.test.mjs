import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceReadQueue, workspaceReadQueue } from '../renderer/v2/src/features/server-workspace/workspace-read-queue.ts';

const settle = async () => { for (let index=0;index<12;index+=1) await Promise.resolve(); };
function harness() {
  const queue=createWorkspaceReadQueue(), owner={}, calls=[], releases=[];
  const enqueue=(key,{background=false,kind="directory",resource="",current=()=>true,selected=owner}={}) => queue.run(selected,key,()=>{
    calls.push(key); return new Promise((resolve,reject)=>releases.push({key,resolve,reject}));
  },current,{background,kind,resource});
  const release=key=>releases.find(item=>item.key===key).resolve(key);
  return {queue,owner,calls,releases,enqueue,release};
}

test('多个目录树共享三个读取名额，等待中的展开自动继续', async () => {
  const h=harness(), other={};
  const reads=['one','two','three','four','five'].map((key,index)=>h.enqueue(key,{selected:index%2?other:h.owner}));
  await settle(); assert.deepEqual(h.calls,['one','two','three']);
  h.release('two'); await settle(); assert.deepEqual(h.calls,['one','two','three','four']);
  h.release('one'); h.release('three'); await settle(); assert.equal(h.calls.length,5);
  h.release('four'); h.release('five'); assert.deepEqual(await Promise.all(reads),['one','two','three','four','five']);
});

test('空位优先给用户展开，不被排队的链接补齐占用', async () => {
  const h=harness(); const active=['a','b','c'].map(key=>h.enqueue(key));
  const background=h.enqueue('links',{background:true}), interactive=h.enqueue('click');
  await settle(); h.release('a'); await settle(); assert.equal(h.calls.at(-1),'click');
  h.release('click'); await settle(); assert.equal(h.calls.at(-1),'links');
  for (const key of ['b','c','links']) h.release(key);
  await Promise.all([...active,background,interactive]);
});

test('收起或隐藏只撤销本树排队请求，不影响在途请求及另一棵树', async () => {
  const h=harness(), other={}; const active=['a','b','c'].map(key=>h.enqueue(key));
  const collapsed=h.enqueue('collapsed'), hidden=h.enqueue('hidden'), retained=h.enqueue('retained',{selected:other});
  h.queue.cancel(h.owner,'collapsed'); assert.equal(await collapsed,undefined);
  h.queue.cancel(h.owner); assert.equal(await hidden,undefined);
  await settle(); for(const key of ['a','b','c']) h.release(key);
  await settle(); assert.deepEqual(h.calls,['a','b','c','retained']);h.release('retained');
  assert.deepEqual(await Promise.all([...active,retained]),['a','b','c','retained']);
});

test('快照失效的等待项不发送，失败请求仍释放名额', async () => {
  const h=harness(); const active=['a','b','c'].map(key=>h.enqueue(key));
  let current=true; const obsolete=h.enqueue('obsolete',{current:()=>current}), next=h.enqueue('next');
  current=false; const rejection=assert.rejects(active[0],{message:'合成失败'});
  await settle(); h.releases[0].reject(new Error('合成失败')); await rejection; await settle();
  assert.equal(await obsolete,undefined); assert.deepEqual(h.calls,['a','b','c','next']);
  for(const key of ['b','c','next']) h.release(key); await Promise.all([...active.slice(1),next]);
});

test('同一桌面 API 共享队列，不同 API 相互隔离', () => {
  const api={}; assert.equal(workspaceReadQueue(api),workspaceReadQueue(api));
  assert.notEqual(workspaceReadQueue(api),workspaceReadQueue({}));
});


test('目录与多个预览和属性共用四个名额，全部等待项自动完成', async () => {
  const h=harness(); const directories=['a','b','c','d'].map(key=>h.enqueue(key));
  const files=['preview-one','preview-two','info'].map(key=>h.enqueue(key,{kind:'file'}));
  await settle(); assert.deepEqual(h.calls,['a','b','c','preview-one']);
  h.release('preview-one'); await settle(); assert.equal(h.calls.at(-1),'preview-two');
  h.release('preview-two'); await settle(); assert.equal(h.calls.at(-1),'info');
  h.release('a'); await settle(); assert.equal(h.calls.at(-1),'d');
  for(const key of ['b','c','d','info'])h.release(key);
  assert.equal((await Promise.all([...directories,...files])).length,7);
});

test('每个插件普通文件最多两个，等待关闭不会占用后续名额', async () => {
  const h=harness(), previews={}; const active=['one','two','three','four'].map(key=>h.enqueue(key,{kind:'file'}));
  const closed=h.enqueue('closed',{kind:'file',selected:previews}), next=h.enqueue('next',{kind:'file',selected:previews});
  await settle(); assert.deepEqual(h.calls,['one','two']); h.queue.cancel(previews,'closed'); assert.equal(await closed,undefined);
  h.release('two'); await settle(); assert.equal(h.calls.at(-1),'three');
  h.release('one'); await settle(); assert.equal(h.calls.at(-1),'four');
  h.release('three'); await settle(); assert.equal(h.calls.at(-1),'next');
  for(const key of ['four','next']) h.release(key);
  await Promise.all([...active,next]); assert.equal(h.calls.includes('closed'),false);
});

test('收起父目录可取消全部排队后代，保留相邻路径和其他工作区', async () => {
  const h=harness(), other={}; const active=['a','b','c'].map(key=>h.enqueue(key));
  const cancelled=['read:/srv','read:/srv/child','links:/srv/child'].map(key=>h.enqueue(key));
  const retained=[h.enqueue('read:/srv-other'),h.enqueue('read:/srv/child',{selected:other})];
  h.queue.cancel(h.owner,key=>/^\w+:\/srv(?:\/|$)/u.test(key));
  assert.deepEqual(await Promise.all(cancelled),[undefined,undefined,undefined]);
  await settle(); for(const key of ['a','b','c'])h.release(key); await settle();
  assert.deepEqual(h.calls,['a','b','c','read:/srv-other','read:/srv/child']);
  h.release('read:/srv-other');h.release('read:/srv/child');await Promise.all([...active,...retained]);
});


test('已打开的预览和属性优先于先前排队的目录扫描', async () => {
  const h=harness(); const directories=['a','b','c','d'].map(key=>h.enqueue(key));
  const first=h.enqueue('preview-one',{kind:'file'}), second=h.enqueue('preview-two',{kind:'file'}), info=h.enqueue('info',{kind:'file'});
  await settle(); h.release('a'); await settle(); assert.equal(h.calls.at(-1),'preview-two');
  h.release('b'); await settle(); assert.equal(h.calls.at(-1),'d');
  h.release('preview-one'); await settle(); assert.equal(h.calls.at(-1),'info');
  for(const key of ['c','preview-two','info','d'])h.release(key);
  await Promise.all([...directories,first,second,info]);
});


test('不同插件各保留两个普通读取名额，共用窗口总上限四个', async () => {
  const h=harness(); const reads=['a1','a2','a3','b1','b2','b3'].map(key=>h.enqueue(key,{kind:'file',resource:key[0]}));
  await settle(); assert.deepEqual(h.calls,['a1','a2','b1','b2']);
  h.release('a1'); await settle(); assert.equal(h.calls.at(-1),'a3');
  h.release('b2'); await settle(); assert.equal(h.calls.at(-1),'b3');
  for(const key of ['a2','a3','b1','b3'])h.release(key);await Promise.all(reads);
});
