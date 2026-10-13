import readline from 'node:readline';
let loggedIn = false, seq = 0;
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const notify = (method,params) => emit({method,params});
const turns = new Map();
readline.createInterface({input:process.stdin}).on('line',line => {
 const {id,method,params:p = {},result:answer} = JSON.parse(line);
 if (!method) { if (answer && turns.has(id)) { const t = turns.get(id); notify('item/agentMessage/delta',{...t,itemId:'answer',delta:'已收到回答'}); notify('turn/completed',{threadId:t.threadId,turn:{id:t.turnId,status:'completed'}}); } return; }
 let result = {};
 if (method === 'initialize') result = {codexHome:process.env.CODEX_HOME,userAgent:'fixture'};
 else if (method === 'initialized') return;
 else if (method === 'account/read') result = {account:loggedIn ? {type:'chatgpt',email:'test@example.invalid'} : null};
 else if (method === 'account/login/start') { result = {type:'chatgpt',loginId:'test-login',authUrl:'https://auth.openai.com/authorize?code=fixture'}; setTimeout(()=>{loggedIn=true;notify('account/login/completed',{loginId:'test-login',success:true})},20); }
 else if (method === 'account/logout') loggedIn = false;
 else if (method === 'model/list') result = {data:[{id:'test-model',model:'test-model',displayName:'测试模型'}],nextCursor:null};
 else if (method === 'thread/start' || method === 'thread/resume') {
  if (p.permissions !== 'ai_ops' || p.config?.permissions?.ai_ops?.network?.enabled !== false || p.sandbox !== undefined) { emit({id,error:{code:-1,message:'invalid isolation'}}); return; }
  result = {thread:{id:p.threadId ?? `thread-${++seq}`},activePermissionProfile:{id:'ai_ops'},approvalsReviewer:'user',model:p.model || 'test-model'};
 }
 else if (method === 'turn/start') {
  const value=p.input[0].text, turnId=`turn-${++seq}`, threadId=p.threadId;
  if(value==='crash')process.exit(1);
  result={turn:{id:turnId,status:'inProgress'}};
  setTimeout(()=>{
   notify('turn/started',{threadId,turn:{id:turnId}});
   if(value==='ask') {const requestId=1000+seq;turns.set(requestId,{threadId,turnId});emit({id:requestId,method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'question',questions:[{id:'choice',header:'请选择',question:'查看哪项信息？',options:[{label:'日志',description:'只读日志'}]}]}});return;}
   if(value==='escape')emit({id:9999,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'cmd',command:'cat protected'}});
   if(value==='wait')return;
   notify('item/started',{threadId,turnId,item:{id:'tool',type:'mcpToolCall',server:'agent_ops',tool:'open_environment',status:'inProgress'}});
   notify('item/agentMessage/delta',{threadId,turnId,itemId:'message-'+turnId,delta:value==='leak' ? process.env.AI_OPS_MODEL_API_KEY : '正在分析源码。'});
   setTimeout(()=>{notify('item/agentMessage/delta',{threadId,turnId,itemId:'message-'+turnId,delta:'建议检查配置。'});notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}})},30);
  },10);
 } else if(method==='turn/interrupt')notify('turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}});
 emit({id,result});
});
