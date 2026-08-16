const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
let connectCalls = 0;
let runtime = { projectId:'member',environmentId:'prod',desiredConnected:false,phase:'disconnected',eligibleCount:3,connectedCount:0,errorCount:0,blockedCount:0,plugins:{} };
const projects = [{ schemaVersion:2,projectId:'member',name:'会员服务',revision:1,environmentCount:2,pluginCount:4 }];
const environments = [{ projectId:'member',environmentId:'prod',name:'华东正式',revision:1,pluginCount:3,readyPluginCount:3 },{ projectId:'member',environmentId:'gray',name:'灰度一组',revision:1,pluginCount:1,readyPluginCount:1 }];
const plugins = {
  prod:[
    {projectId:'member',environmentId:'prod',pluginInstanceId:'server-app',pluginType:'server',displayName:'应用服务器',revision:1,configState:'ready',target:{host:'192.168.20.45',port:22,addressFamily:'ipv4Preferred'},auth:{username:'deploy',type:'password'},uplink:{type:'direct'},sources:[],policy:{status:'auto',logs:'auto',config:'auto',download:'confirm',diagnostics:'auto'},limits:{maxBytes:262144}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'mysql-member',pluginType:'mysql',displayName:'会员主库',revision:1,configState:'ready',target:{host:'127.0.0.1',port:3306,database:'member',addressFamily:'ipv4Preferred'},auth:{username:'reader'},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-app'},tls:{mode:'disabled'},policy:{describe:'auto',select:'auto',explain:'auto'},limits:{maxRows:100,maxBytes:1048576,timeoutMs:10000}},
    {projectId:'member',environmentId:'prod',pluginInstanceId:'redis-session',pluginType:'redis',displayName:'会话缓存',revision:1,configState:'ready',target:{host:'127.0.0.1',port:6379,db:2,addressFamily:'ipv4Preferred'},auth:{username:''},transport:{kind:'serverTunnel',serverPluginInstanceId:'server-app'},tls:{mode:'disabled'},patterns:[{patternId:'session',pattern:'session:*'}],policy:{scan:'auto',read:'auto',ttl:'auto'},limits:{maxKeys:100,maxValueBytes:65536,timeoutMs:5000}},
  ],
  gray:[],
};
function ok(data){return {ok:true,data};}
function handle(name,fn){ipcMain.handle(name,async(_e,...args)=>ok(await fn(...args)));}
handle('v2:project-list',()=>projects);
handle('v2:environment-list',()=>environments);
handle('v2:plugin-list',({environmentId})=>plugins[environmentId]||[]);
handle('v2:environment-status',({environmentId})=>environmentId==='prod'?runtime:{projectId:'member',environmentId,desiredConnected:false,phase:'disconnected',eligibleCount:0,connectedCount:0,plugins:{}});
handle('v2:environment-connect',async()=>{connectCalls++;runtime={...runtime,desiredConnected:true,phase:'connected',connectedCount:3,plugins:Object.fromEntries(plugins.prod.map((p)=>[p.pluginInstanceId,{pluginInstanceId:p.pluginInstanceId,phase:'connected'}]))};return runtime;});
handle('v2:environment-disconnect',()=>{runtime={...runtime,desiredConnected:false,phase:'disconnected',connectedCount:0,plugins:{}};return runtime;});
handle('v2:environment-retry',()=>runtime);handle('v2:environment-cancel',()=>runtime);
handle('v2:runbook-read',()=>({content:'# 华东正式\n\n只读排障。',hash:'a'.repeat(64)}));
handle('v2:runbook-save',()=>({environment:environments[0]}));
handle('v2:audit-list',()=>({entries:[]}));
for(const channel of ['v2:project-create','v2:project-update','v2:environment-create','v2:environment-update','v2:environment-delete','v2:environment-reorder','v2:plugin-create','v2:plugin-update','v2:plugin-delete','v2:plugin-credential-status','v2:plugin-policy','v2:plugin-test','v2:confirmation-list','v2:confirmation-approve','v2:confirmation-reject']) handle(channel,()=>({}));
for(const channel of ['project:list','project:get','project:create','project:update','project:delete','project:connect','project:trust-host-key-change','project:disconnect','document:list','document:read','document:save','document:create','document:delete','dialog:private-key','app:open-data-folder','app:info']) handle(channel,()=>({}));

async function run(){
  const win=new BrowserWindow({show:false,useContentSize:true,width:1280,height:720,webPreferences:{preload:path.join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.setContentSize(1280,720);
  await win.loadFile(path.join(root,'renderer','v2','index.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{const wait=async(f)=>{const s=Date.now();while(!f()){if(Date.now()-s>3000)throw new Error('timeout');await new Promise(r=>setTimeout(r,20));}};await wait(()=>document.querySelectorAll('.plugin-item').length===3);const before={button:document.querySelector('#environmentAction').textContent,detail:document.querySelector('#pluginDetail').textContent,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};document.querySelector('#environmentAction').click();await wait(()=>document.querySelector('#environmentStatus').dataset.state==='connected');document.querySelector('[data-type="mysql"]').click();document.querySelector('.plugin-item').click();document.querySelector('[data-action="policy"]').click();return{before,after:document.querySelector('#environmentStatus').textContent,policyOpen:document.querySelector('#policyDialog').open,policyText:document.querySelector('#policyDialog').textContent,viewport:[innerWidth,innerHeight]};})()`);
  assert.equal(connectCalls,1);assert.equal(result.before.button,'连接环境');assert.match(result.before.detail,/应用服务器/);assert.equal(result.before.overflow,false);assert.match(result.after,/3\/3/);assert.equal(result.policyOpen,true);assert.match(result.policyText,/禁止 USE、跨库/);assert.ok(result.viewport[0]>=1280&&result.viewport[0]<=1282&&result.viewport[1]>=720&&result.viewport[1]<=722,'content viewport must be 1280x720 within the Windows frame rounding tolerance');
  if(process.env.AI_OPS_SCREENSHOT_PATH){const image=await win.webContents.capturePage();require('node:fs').writeFileSync(process.env.AI_OPS_SCREENSHOT_PATH,image.toPNG());}
  win.destroy();
}
app.whenReady().then(run).then(()=>{console.log('V2 UI smoke passed');app.exit(0);}).catch((error)=>{console.error(error);app.exit(1);});
