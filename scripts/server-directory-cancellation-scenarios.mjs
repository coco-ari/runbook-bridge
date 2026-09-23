import assert from 'node:assert/strict';

// 只取消本探针自己发出的目录读取，不关闭 SSH、不创建文件或变更服务端配置。
export async function probeDirectoryCancellation({runtime,files,plugin,scope,owner,measure}) {
  const client=runtime.broker.requireSession(runtime.key(plugin)).client, original=client.sftp;
  const decorated=new WeakSet(),restore=[];
  let armed=false,requested=false,started=0,cancelledMs=null;
  const decorate=channel=>{
    if(!channel||decorated.has(channel))return;decorated.add(channel);
    const read=channel.readdir;
    channel.readdir=function(...args){
      const value=read.apply(this,args);
      if(armed&&!requested){requested=true;queueMicrotask(()=>{started=performance.now();files.cancelDirectoryRead(owner,{...scope,requestId:'directory-cancel-probe'});});}
      return value;
    };
    restore.push(()=>{channel.readdir=read;});
  };
  client.sftp=function(callback){return original.call(this,(error,channel)=>{decorate(channel);callback(error,channel);});};
  for(const channel of runtime.broker.requireSession(runtime.key(plugin)).workspaceReads?.entries.keys()??[])decorate(channel);
  try {
    await measure('directory-cancel.in-flight',async()=>{
      armed=true;
      const reading=files.listDirectory(owner,{...scope,path:'/usr/bin',deferLinks:true,requestId:'directory-cancel-probe'});
      await assert.rejects(reading,{code:'WORKSPACE_READ_CANCELLED'});
      cancelledMs=Math.round((performance.now()-started)*10)/10;armed=false;
      assert.equal(requested,true);assert.equal(files.readCounts.get(owner)??0,0);assert.equal(files.directoryRequests.size,0);
      assert.equal(runtime.status(plugin).connected,true);
    });
    await measure('directory-cancel.read-after-recovery',async()=>{
      const page=await files.listDirectory(owner,{...scope,path:'/',deferLinks:true,requestId:'directory-after-cancel'});
      assert.ok(Array.isArray(page.entries)&&page.entries.length<=200);
      assert.equal(runtime.status(plugin).connected,true);assert.equal(files.directoryRequests.size,0);
    });
    console.log(JSON.stringify({feature:'directory-cancel.summary',status:'observed',readIssued:requested,cancelledMs,connected:true,recovered:true}));
  } finally {armed=false;client.sftp=original;for(const reset of restore.reverse())reset();}
}
