import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

// 真实界面专项仅开放固定系统目录读取，其他界面操作仍使用合成数据。
export async function openLiveDirectoryProbe(scope) {
  const host=process.env.RUNBOOK_LIVE_HOST, username=process.env.RUNBOOK_LIVE_USER, password=process.env.RUNBOOK_LIVE_PASSWORD;
  delete process.env.RUNBOOK_LIVE_PASSWORD;
  assert.ok(net.isIP(host ?? '') === 4 && username && password, '只读目录实测需要显式连接信息');
  assert.ok(!process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR, '真实目录专项禁止保存截图');
  const plugin={...scope,pluginType:'server',configState:'ready',revision:1,displayName:'授权目录实测',
    target:{host,port:22},auth:{type:'password',username},uplink:{type:'direct'},limits:{timeoutMs:10000,maxBytes:65536},sources:[],actions:[]};
  const store={
    getPlugin:async(...keys)=>{assert.deepEqual(keys,Object.values(scope));return plugin},
    updatePlugin:async(_project,_environment,_id,patch)=>{Object.assign(plugin,patch);return plugin},
    appendAudit:async()=>{},
    readRunbook:async()=>({content:'',hash:'0'.repeat(64)}),
  };
  const runtime=new ServerPluginRuntime(store,{load:async()=>null},{resolver:{resolve:async value=>{
    assert.equal(value,host);return[{address:host,family:4}];
  }}});
  const operations=new ServerOperations(runtime,store);
  const files=new ServerWorkspaceFiles({workspaceStore:store,serverRuntime:runtime,serverOperations:operations});
  const reads=[], readSessions=[];
  const withSession=runtime.withWorkspaceReadSession.bind(runtime);
  // 分别记录通道取得与协议操作耗时，输出不包含目标路径或远端正文。
  runtime.withWorkspaceReadSession=async(selected,operation,options)=>{
    const started=performance.now(), phases=[];
    const result={openMs:null,phases,status:'pending'};
    readSessions.push(result);
    try {
      const value=await withSession(selected,reader=>{
        result.openMs=Math.round((performance.now()-started)*10)/10;
        const wrapped={...reader};
        for(const key of ['statPath','listDirectoryEntries']) wrapped[key]=async(...args)=>{
          const at=performance.now();
          try{return await reader[key](...args)}
          finally{phases.push({step:key,ms:Math.round((performance.now()-at)*10)/10})}
        };
        return operation(wrapped);
      },options);
      result.status='passed';return value;
    }catch(error){result.status='failed';result.code=error.code ?? error.name;throw error}
    finally{result.ms=Math.round((performance.now()-started)*10)/10}
  };
  const allowed=new Set(['/','/usr','/usr/bin']);
  const dispose=async()=>{files.dispose();operations.docker.dispose();await runtime.broker.closeAll()};
  try {
    await assert.rejects(runtime.connect(plugin,{password}),error=>{
      if(error.code!=='SSH_HOST_KEY_CONFIRM_REQUIRED'||!error.details?.fingerprint)return false;
      plugin.target.hostKeyFingerprint=error.details.fingerprint;return true;
    });
    await runtime.connect(plugin,{password});
    const listDirectory=async (ownerId,input) => {
        assert.ok(allowed.has(input.path), '真实目录专项拒绝范围以外的路径');
        const started=performance.now();
        const result=await files.listDirectory(ownerId,input);
        reads.push({kind:input.resolveLinks?'metadata':input.snapshotId?'snapshot':'directory',ms:Math.round((performance.now()-started)*10)/10});
        return result;
    };
    return {
      register(ipcMain,isWorkspaceRenderer) {
        // 只安装真实目录接口，沿用生产参数和主框架身份检查；其余接口仍由合成测试提供。
        registerServerWorkspaceIpc({handle:(name,callback)=>{if(name==='v2:server-workspace-list-directory')ipcMain.handle(name,callback)}},{
          isWorkspaceRenderer,serverWorkspaceFiles:{listDirectory,closeOwner:ownerId=>files.closeOwner(ownerId)},
        });
      },
      summary:()=>({reads:[...reads],readSessions}),
      dispose,
    };
  } catch(error) {
    await dispose();
    throw Object.assign(new Error('授权目录实测连接失败'),{code:error.code ?? error.name});
  }
}
