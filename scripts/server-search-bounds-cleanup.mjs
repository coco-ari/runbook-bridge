import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';

// 仅恢复调用方保存的本次搜索探针目录；逐项验证合成内容，不使用递归删除或远端 Shell。
const host = process.env.RUNBOOK_LIVE_HOST, username = process.env.RUNBOOK_LIVE_USER, password = process.env.RUNBOOK_LIVE_PASSWORD;
const root = process.env.RUNBOOK_LIVE_CLEANUP_ROOT;
delete process.env.RUNBOOK_LIVE_PASSWORD;
assert.equal(net.isIP(host ?? ''), 4); assert.ok(username && password && process.env.RUNBOOK_LIVE_MUTATIONS === 'new-resources-only');
assert.match(root ?? '', /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
const scope = { projectId:'search-cleanup-probe', environmentId:'isolated', pluginInstanceId:'server' };
const plugin = { ...scope, pluginType:'server', configState:'ready', revision:1, displayName:'合成搜索资源清理', target:{host,port:22}, auth:{type:'password',username}, uplink:{type:'direct'}, limits:{timeoutMs:10000,maxBytes:65536}, sources:[],actions:[] };
let audits = 0, stage = 'connection', removed = 0, verified = 0;
const store = { getPlugin:async (...keys) => { assert.deepEqual(keys,Object.values(scope)); return plugin; }, updatePlugin:async (_p,_e,_i,patch) => {Object.assign(plugin,patch);return plugin;}, appendAudit:async()=>{audits+=1;} };
const runtime = new ServerPluginRuntime(store,{load:async()=>null},{resolver:{resolve:async value=>{assert.equal(value,host);return [{address:host,family:4}];}}});
const operations = new ServerOperations(runtime,store), files = new ServerWorkspaceFiles({workspaceStore:store,serverRuntime:runtime,serverOperations:operations});
const owner = 'renderer:search-cleanup-probe', directories = [root,root+'/level-one',root+'/level-one/level-two'];
const expected = new Map();
for (const [depth,directory] of directories.entries()) for(let index=0;index<2;index+=1) {
  const head=`HEAD probe-${depth}-${index}\n`, filler='INFO synthetic filler row 0123456789\n';
  const content=head+filler.repeat(Math.ceil((96*1024-Buffer.byteLength(head))/Buffer.byteLength(filler)))+`TAIL probe-${depth}-${index}\n`;
  expected.set(directory+`/layer-${depth}-${index}.log`,[Buffer.from(content),...(depth===0&&index===0?[Buffer.from(content+'FRESH_GROWTH_MARKER synthetic appended text\n')]:[])]);
}
expected.set(root+'/boundary.txt',[Buffer.from('x'.repeat(1024*1024-1)+'中文跨页标记\nASCII_CONTROL\n')]);
const unexpected = () => Object.assign(new Error('资源不符合本次合成样本，已保留。'),{code:'CLEANUP_UNEXPECTED_ENTRY'});
function descriptor(target) {
  const partial=/\.part-[a-f0-9]{24}$/u.test(target), original=partial?target.replace(/\.part-[a-f0-9]{24}$/u,''):target;
  const bodies=expected.get(original); if(!bodies)throw unexpected(); return {partial,bodies};
}
async function verifyFile(target) {
  const {partial,bodies}=descriptor(target), info=await files.fileInfo(owner,{...scope,path:target});
  if(info.type!=='file'||info.canonicalPath!==target||info.size>Math.max(...bodies.map(body=>body.length)))throw unexpected();
  const read=await runtime.readRemoteBuffer(plugin,target,0,Math.max(1,info.size));
  if(read.canonicalPath!==target||read.truncated||!bodies.some(body=>partial?body.subarray(0,read.content.length).equals(read.content):body.equals(read.content)))throw unexpected();
  verified+=1;
}
async function remove(target,isDirectory) {
  assert.ok(directories.includes(target)||expected.has(target.replace(/\.part-[a-f0-9]{24}$/u,'')));
  for(let attempt=0;attempt<3;attempt+=1) {
    try {
      if(!isDirectory)await verifyFile(target);
      const prepared=await files.prepareFileAction(owner,{...scope,kind:'delete',path:target});
      await files.confirmFileAction(owner,{...scope,operationId:prepared.operationId});removed+=1;return;
    } catch(error) {
      if(error.code==='SOURCE_NOT_FOUND')return;
      if(error.code!=='REMOTE_CHANGED'||attempt===2)throw error;
      console.log(JSON.stringify({status:'cleanup-revalidate',kind:isDirectory?'directory':'file',attempt:attempt+1}));
    }
  }
}
try {
  await assert.rejects(runtime.connect(plugin,{password}),error=>{if(error.code!=='SSH_HOST_KEY_CONFIRM_REQUIRED'||!error.details?.fingerprint)return false;plugin.target.hostKeyFingerprint=error.details.fingerprint;return true;});
  await runtime.connect(plugin,{password});stage='verify';const targets=[],existingDirectories=[];
  for(const directory of directories) {
    let page;try{page=await files.listDirectory(owner,{...scope,path:directory,deferLinks:true,refresh:true});}catch(error){if(error.code==='SOURCE_NOT_FOUND')continue;throw error;}
    assert.equal(page.canonicalPath,directory);assert.equal(page.nextCursor,null);assert.equal(page.truncated,false);assert.ok(page.entries.length<=12);existingDirectories.push(directory);
    for(const entry of page.entries) {
      const target=directory+'/'+entry.name;assert.equal(entry.path,target);
      if(entry.type==='directory'){if(!directories.includes(target)||path.posix.dirname(target)!==directory)throw unexpected();}
      else {if(entry.type!=='file')throw unexpected();await verifyFile(target);targets.push(target);}
    }
  }
  console.log(JSON.stringify({status:'cleanup-verified',files:targets.length,directories:existingDirectories.length,verified}));stage='remove-files';
  for(const target of targets)await remove(target,false);stage='remove-directories';
  for(const directory of existingDirectories.reverse())await remove(directory,true);
  await assert.rejects(runtime.statRemotePath(plugin,root),{code:'SOURCE_NOT_FOUND'});
  console.log(JSON.stringify({status:'cleanup-finished',removed,verified,auditEvents:audits}));
} catch(error) {console.log(JSON.stringify({status:'cleanup-incomplete',stage,code:error.code??error.name,removed,verified}));process.exitCode=1;}
finally {files.dispose();operations.docker.dispose();await runtime.closeAll();}
