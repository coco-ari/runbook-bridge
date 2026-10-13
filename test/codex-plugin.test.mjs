import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexProcess } from '../src/codex-process.mjs';
import { CodexPluginRuntime,agentPermissions } from '../src/codex-plugin-runtime.mjs';
import { normalizePlugin } from '../src/plugin-config-model.mjs';
import { BrokerServer } from '../src/broker-server.mjs';
import { registerCodexWorkspaceIpc } from '../src/codex-workspace-ipc.mjs';
import { EventEmitter } from 'node:events';
const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs',import.meta.url));
const waitFor = async fn => { const end=Date.now()+4000; while(Date.now()<end) {const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}assert.fail('等待状态超时'); };
async function setup(t,mode='custom') {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-runtime-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const plugin=normalizePlugin({pluginType:'codex',pluginInstanceId:'agent',target:{authMode:mode,model:'test-model',baseUrl:'https://model.example.invalid'}},{projectId:'p',environmentId:'e'});
 const configs=[];
 const runtime=new CodexPluginRuntime(root,{load:async()=>({apiKey:'fixture-api-key-not-real'})},{workspaceStore:{getPlugin:async()=>plugin},processFactory:options=>{configs.push(options);return new CodexProcess({...options,spawnImpl:(_exe,_args,opts)=>spawn(process.execPath,[fixture],opts)});},resolveExecutable:async()=>({executable:process.execPath,version:'fixture'}),openExternal:async url=>assert.equal(new URL(url).hostname,'auth.openai.com')});
 t.after(()=>runtime.closeAll()); await runtime.connect(plugin);return {root,plugin,runtime,configs};
}
test('Codex 子进程流式会话、恢复、停止、崩溃和密钥隔离',async t=>{
 const {root,plugin,runtime,configs}=await setup(t);
 assert.equal(configs[0].env.AI_OPS_MODEL_API_KEY,'fixture-api-key-not-real');
 const config=await fs.readFile(path.join(configs[0].env.CODEX_HOME,'config.toml'),'utf8');
 assert.doesNotMatch(config,/fixture-api-key/);assert.match(config,/inherit = "none"/);assert.match(config,/default_permissions = "ai_ops"/);
 const session=await runtime.newSession(plugin);await runtime.send(plugin,session.id,'查看代码');
 await waitFor(async()=> (await runtime.readSession(plugin,session.id)).status==='completed');
 let conversation=await runtime.readSession(plugin,session.id);assert.match(JSON.stringify(conversation),/正在分析源码。建议检查配置。/);
 await runtime.send(plugin,session.id,'leak');await waitFor(async()=> (await runtime.readSession(plugin,session.id)).status==='completed');
 assert.doesNotMatch(JSON.stringify(await runtime.readSession(plugin,session.id)),/fixture-api-key/);
 await runtime.disconnect(plugin);await runtime.connect(plugin);
 await runtime.send(plugin,session.id,'wait');await waitFor(()=>runtime.require(plugin).records.get(session.id).turnId);
 await runtime.stop(plugin,session.id);await waitFor(async()=> (await runtime.readSession(plugin,session.id)).status==='interrupted');
 await assert.rejects(runtime.send(plugin,session.id,'crash'),{code:'CODEX_DISCONNECTED'});
 await waitFor(()=>!runtime.status(plugin).connected);
 const files=await fs.readdir(root);assert.deepEqual(files,['codex-agent']);
});
test('官方登录、模型和用户问题；本地提权请求拒绝',async t=>{
 const {plugin,runtime}=await setup(t,'chatgpt');const session=await runtime.newSession(plugin);
 await assert.rejects(runtime.send(plugin,session.id,'hello'),{code:'CODEX_LOGIN_REQUIRED'});
 await runtime.login(plugin,'login');await waitFor(()=>runtime.require(plugin).account.authenticated);
 assert.equal((await runtime.models(plugin))[0].model,'test-model');
 await runtime.send(plugin,session.id,'ask');const current=await waitFor(async()=>{const c=await runtime.readSession(plugin,session.id);return c.approvals.length&&c;});
 await assert.rejects(runtime.answer(plugin,'other',current.approvals[0].id,{choice:'日志'}),{code:'CODEX_APPROVAL_EXPIRED'});
 await runtime.answer(plugin,session.id,current.approvals[0].id,{choice:'日志'});await waitFor(async()=> (await runtime.readSession(plugin,session.id)).status==='completed');
 await runtime.send(plugin,session.id,'escape');await waitFor(async()=> (await runtime.readSession(plugin,session.id)).status==='completed');
 assert.match(JSON.stringify(await runtime.readSession(plugin,session.id)),/拒绝扩大本地访问权限/);
 await runtime.login(plugin,'logout');assert.equal(runtime.require(plugin).account.authenticated,false);
});
test('内置 Agent Broker 限定项目环境、撤销授权且禁止配置修改',async()=>{
 let active=true;const seen=[];
 const broker=new BrokerServer({dataRoot:'/tmp/unused',token:'global-fixture',v2Service:{listProjects:async()=>({projects:[{projectId:'p'},{projectId:'q'}]}),listEnvironments:async()=>({environments:[{environmentId:'e'},{environmentId:'f'}]}),openEnvironment:async p=>{seen.push(p);return {ok:true};}}});
 const grant=broker.issueAgentGrant({projectId:'p',environmentId:'e',pluginInstanceId:'agent',assertCurrent:async()=>{if(!active)throw Object.assign(new Error(),{code:'BROKER_UNAUTHORIZED'});}});const auth=broker.agentGrants.get(grant.token);
 assert.deepEqual((await broker.dispatchAgent(auth,'v2.listProjects',{})).projects,[{projectId:'p'}]);
 assert.deepEqual((await broker.dispatchAgent(auth,'v2.listEnvironments',{projectId:'p'})).environments,[{environmentId:'e'}]);
 await assert.rejects(broker.dispatchAgent(auth,'v2.openEnvironment',{projectId:'p',environmentId:'f'}),{code:'SCOPE_MISMATCH'});
 await assert.rejects(broker.dispatchAgent(auth,'v2.addPlugin',{projectId:'p',environmentId:'e'}),{code:'WORKSPACE_ACCESS_DENIED'});
 await broker.dispatchAgent(auth,'v2.openEnvironment',{projectId:'p',environmentId:'e',clientInstanceId:'forged'});assert.notEqual(seen[0].clientInstanceId,'forged');
 active=false;await assert.rejects(broker.dispatchAgent(auth,'info',{}),{code:'BROKER_UNAUTHORIZED'});grant.revoke();assert.equal(broker.agentGrants.size,0);
});
test('Agent IPC 校验可信主 frame、配置版本与插件类型',async()=>{
 let handler;const plugin={projectId:'p',environmentId:'e',pluginInstanceId:'agent',pluginType:'codex',revision:1};const sender=Object.assign(new EventEmitter(),{id:10,mainFrame:{},isDestroyed:()=>false});
 registerCodexWorkspaceIpc({handle:(_c,h)=>{handler=h;}},{isWorkspaceRenderer:s=>s===sender,workspaceStore:{getPlugin:async()=>plugin},codexRuntime:{workspaceStatus:async()=>({connected:false})}});
 const payload={...plugin,expectedRevision:1,operation:'status'};
 assert.equal((await handler({sender,senderFrame:{}},payload)).error.code,'WORKSPACE_ACCESS_DENIED');
 assert.equal((await handler({sender,senderFrame:sender.mainFrame},{...payload,expectedRevision:0})).error.code,'CODEX_WORKSPACE_STALE');
 assert.equal((await handler({sender,senderFrame:sender.mainFrame},payload)).ok,true);
});
test('权限配置只给选定源码读权限，不允许网络与凭据目录',()=>{
 const config=agentPermissions('/private/app','/private/app/work/one',[{directory:'/private/app/source/one'}]);
 assert.deepEqual(config,{filesystem:{':minimal':'read','/private/app':'deny','/private/app/work/one':'write','/private/app/source/one':'read'},network:{enabled:false}});
 assert.throws(()=>normalizePlugin({pluginType:'codex',target:{executable:'codex --unsafe'}},{projectId:'p',environmentId:'e'}),{code:'INVALID_ARGUMENT'});
});

test('ChatGPT 模式不会向 CLI 注入保留的自定义服务密钥',async t=>{
 const {plugin,runtime,configs}=await setup(t,'chatgpt');
 await runtime.connect(plugin,{apiKey:'unused-custom-key-fixture'});
 assert.equal(configs.at(-1).env.AI_OPS_MODEL_API_KEY,undefined);
 assert.equal(runtime.require(plugin).redactions.includes('unused-custom-key-fixture'),false);
});
