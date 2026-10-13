import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { stringify } from 'smol-toml';
import { CodexProcess, resolveCodexExecutable } from '../src/codex-process.mjs';
import { agentPermissions } from '../src/codex-plugin-runtime.mjs';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-codex-probe-')));
let rpc;
try {
 for(const folder of ['home','work','source','credentials','other-source'])await fs.mkdir(path.join(root,folder));
 await fs.writeFile(path.join(root,'credentials','canary'),'PRIVATE_FIXTURE');
 await fs.writeFile(path.join(root,'other-source','canary'),'OTHER_ENV_FIXTURE');
 await fs.writeFile(path.join(root,'source','hello'),'PUBLIC_SOURCE');
 const home=path.join(root,'home'),cwd=path.join(root,'work'),source=path.join(root,'source');
 const config={default_permissions:'ai_ops',permissions:{ai_ops:agentPermissions(root,cwd,[{directory:source}])},shell_environment_policy:{inherit:'none',set:{PATH:'/usr/bin:/bin',HOME:cwd},ignore_default_excludes:false},cli_auth_credentials_store:'file',analytics:{enabled:false}};
 await fs.writeFile(path.join(home,'config.toml'),stringify(config));
 const binary=await resolveCodexExecutable(process.argv[2]);
 rpc=new CodexProcess({executable:binary.executable,cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,AI_OPS_MODEL_API_KEY:'FIXTURE_API_KEY'}});
 rpc.on('request',m=>rpc.reject(m.id));
 await rpc.initialize(home);
 const started=await rpc.request('thread/start',{cwd,permissions:'ai_ops',approvalPolicy:'on-request',approvalsReviewer:'user',ephemeral:true});
 assert.equal(started.activePermissionProfile?.id,'ai_ops');
 const command = async argv => rpc.request('command/exec',{command:argv,cwd,permissionProfile:'ai_ops',timeoutMs:5000,outputBytesCap:2048});
 if(process.platform==='win32')throw new Error('此验证脚本使用 POSIX 命令，请在 macOS/Linux 运行；Windows 需原生沙箱专项验收。');
 const read=await command(['/bin/cat',path.join(source,'hello')]);assert.equal(read.exitCode,0);assert.equal(read.stdout,'PUBLIC_SOURCE');
 for(const folder of ['credentials','other-source']) { const denied=await command(['/bin/cat',path.join(root,folder,'canary')]);assert.notEqual(denied.exitCode,0);assert.doesNotMatch(denied.stdout,/PRIVATE_FIXTURE|OTHER_ENV_FIXTURE/); }
 const deniedWrite=await command(['/bin/sh','-c','printf changed > "$1"','sh',path.join(source,'hello')]);assert.notEqual(deniedWrite.exitCode,0);assert.equal(await fs.readFile(path.join(source,'hello'),'utf8'),'PUBLIC_SOURCE');
 const environment=await command(['/usr/bin/env']);assert.doesNotMatch(environment.stdout,/FIXTURE_API_KEY|AI_OPS_MODEL_API_KEY|AI_OPS_AGENT_BROKER_TOKEN/);
 console.log(`${binary.version}: initialize、隔离 profile、源码只读、凭据/跨环境读取拒绝、命令环境隐藏密钥：通过`);
} finally {rpc?.close();await fs.rm(root,{recursive:true,force:true});}
