const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// Synthetic desktop SQL transport. Grammar validation is the production policy;
// transactions/results are controlled here so UI fault cases never touch a DB.
function createSqlFixture({state = {},read,moduleRoot = path.resolve(__dirname,'..')}) {
  const sessions = new Map(), executions = [], calls = [];
  const policy = import(pathToFileURL(path.join(moduleRoot,'src','desktop-mysql-sql-policy.mjs')).href);
  const key = p => JSON.stringify([p.projectId,p.environmentId,p.pluginInstanceId,p.documentId]);
  const idleTimeoutMs=300_000;
  const beginTransaction=s=>{
    s.transaction='active';
    s.transactionSummary??={id:crypto.randomUUID(),startedAt:Date.now(),idleTimeoutMs,idleExpiresAt:Date.now()+idleTimeoutMs,statementCount:0,writeCount:0,affectedRows:0,entries:[],omittedCount:0};
  };
  const finishTransaction=s=>{s.transaction='none';delete s.transactionSummary;};
  const touch=s=>{if(s.transactionSummary)s.transactionSummary.idleExpiresAt=Date.now()+idleTimeoutMs;};
  const snapshot = s => structuredClone({documentId:s.documentId,mode:s.mode,transaction:s.transaction,status:s.status,results:s.results,
    ...(['active','unknown'].includes(s.transaction)&&s.transactionSummary?{transactionSummary:{...s.transactionSummary,serverNow:Date.now(),idleExpiresAt:s.status==='running'||s.transaction==='unknown'?null:s.transactionSummary.idleExpiresAt}}:{}),
    ...(s.plan?{plan:s.plan}:{}),...(s.error?{error:s.error}:{}),...(s.message?{message:s.message}:{})});
  const response = s => ({ok:true,data:snapshot(s)});
  const failure = (code,message) => ({ok:false,error:{code,message}});
  async function handle(payload) {
    calls.push(structuredClone(payload));
    assert.ok(payload.documentId?.startsWith('sql-'),'SQL UI 必须发送独立 documentId');
    const id = key(payload);
    let s = sessions.get(id);
    if(payload.operation==='release') {
      if(state.holdSqlRelease?.pluginInstanceId===payload.pluginInstanceId) {
        const hold=state.holdSqlRelease;state.holdSqlRelease=null;
        await new Promise(resolve=>{hold.release=resolve;});
      }
      if(s) { s.cancelled=true;s.status='cancelled';s.transaction='none';s.releasePending?.();sessions.delete(id); }
      return {ok:true,data:{documentId:payload.documentId,mode:s?.mode??'atomic',transaction:'none',status:'idle',results:[]}};
    }
    if(payload.operation==='prepare') {
      let items;
      try { items=(await policy).prepareMysqlSqlScript(payload.sql); }
      catch(error) { return failure(error.code,error.message); }
      if(s?.status==='unknown') return failure('MYSQL_SQL_OUTCOME_UNKNOWN','上次结果尚未确认，请在新的标签核实。');
      if(s?.transaction==='active' && payload.mode!=='manual') return failure('MYSQL_SQL_TRANSACTION_ACTIVE','请先提交或回滚。');
      s ??= {documentId:payload.documentId,mode:payload.mode,transaction:'none',status:'idle',results:[]};
      sessions.set(id,s);
      const writeCount=items.filter(item=>item.write).length;
      s.items=items;s.sql=payload.sql;s.used=false;s.cancelled=false;s.mode=payload.mode;s.status='prepared';s.error=null;s.message=null;
      touch(s);
      s.plan={planId:crypto.randomUUID(),requiresConfirmation:writeCount>0,dangerous:items.some(item=>item.dangerous),statementCount:items.length,writeCount,
        statements:items.map((item,index)=>({index:index+1,line:item.line,kind:item.kind,tables:item.tables,dangerous:item.dangerous}))};
      return response(s);
    }
    if(!s) return failure('MYSQL_SQL_SESSION_STALE','模拟 SQL 会话已关闭。');
    if(payload.operation==='status') return response(s);
    if(payload.operation==='stop') {
      assert.equal(payload.planId,s.plan.planId);
      s.cancelled=true;s.status='cancelled';finishTransaction(s);s.message='执行已停止，当前未提交事务已回滚。';
      s.results=s.items.map((item,index)=>({index:index+1,line:item.line,kind:item.kind,status:'skipped',durationMs:0,transactionEffect:'none'}));
      s.releasePending?.();return response(s);
    }
    assert.equal(payload.operation,'execute','SQL fixture 不得放行未知操作');
    assert.equal(payload.planId,s.plan.planId,'执行必须绑定准备阶段的计划');
    if(s.used) return response(s);
    if(s.plan.requiresConfirmation && payload.confirmed!==true) return failure('CONFIRMATION_REQUIRED','请确认生产环境写入。');
    s.used=true;s.status='running';s.results=[];
    if(s.mode==='manual'&&s.items.some(item=>!['begin','commit','rollback'].includes(item.kind)))beginTransaction(s);
    const scope=Object.fromEntries(['projectId','environmentId','pluginInstanceId'].map(name=>[name,payload[name]]));
    executions.push({...scope,sql:s.sql});
    if(state.holdNext?.channel==='v2:mysql-sql' && state.holdNext.pluginInstanceId===payload.pluginInstanceId) {
      const hold=state.holdNext;state.holdNext=null;
      await new Promise(resolve=>{let released=false;hold.release=()=>{if(!released){released=true;resolve();}};s.releasePending=hold.release;});
      s.releasePending=null;
      if(s.cancelled || !sessions.has(id)) return response(s);
      s.heldResult=hold.result;
    }
    if(state.sqlNextError){
      s.error=state.sqlNextError;state.sqlNextError=null;s.status='error';finishTransaction(s);
      s.results=[{index:1,line:1,kind:s.items[0].kind,status:'error',durationMs:12,error:s.error,transactionEffect:'none'}];
      return response(s);
    }
    if(state.sqlUnknownNext) {
      state.sqlUnknownNext=false;s.status='unknown';s.transaction='unknown';
      s.error={code:'MYSQL_SQL_OUTCOME_UNKNOWN',message:'模拟提交回复丢失，执行结果尚未确认，请先核实。'};
      s.results=[{index:1,line:1,kind:s.items[0].kind,status:'error',durationMs:12,error:s.error,transactionEffect:'unknown'}];
      return response(s);
    }
    if(s.mode==='atomic')beginTransaction(s);
    for(const [index,item] of s.items.entries()) {
      const result={index:index+1,line:item.line,kind:item.kind,status:'success',durationMs:12,transactionEffect:'none'};
      if(item.kind==='begin') beginTransaction(s);
      else if(['commit','rollback'].includes(item.kind)) {
        assert.equal(s.transaction,'active','提交或回滚仅用于活动事务');
        finishTransaction(s);
      } else {
        if(s.mode==='manual')beginTransaction(s);
        if(item.write) result.affectedRows=1;
        else {
          const readResult=s.heldResult?{ok:true,data:s.heldResult}:await read({...scope,sql:item.sql});
          s.heldResult=null;
          if(!readResult.ok) {
            result.status='error';result.error=readResult.error;s.error=readResult.error;s.status='error';finishTransaction(s);s.results.push(result);
            for(const previous of s.results)if(previous.transactionEffect==='pending')previous.transactionEffect='rolledBack';
            for(const [offset,rest] of s.items.slice(index+1).entries())s.results.push({index:index+offset+2,line:rest.line,kind:rest.kind,status:'skipped',durationMs:0,transactionEffect:'none'});
            return response(s);
          }
          result.data=readResult.data;
        }
        result.transactionEffect=s.mode!=='autocommit'?'pending':item.write?'committed':'none';
        if(s.transactionSummary){
          const summary=s.transactionSummary;
          summary.statementCount++;summary.writeCount+=item.write?1:0;summary.affectedRows+=result.affectedRows??0;
          summary.entries.push({sequence:summary.statementCount,kind:item.kind,tables:item.tables,...(item.write?{affectedRows:result.affectedRows}:{}),executedAt:Date.now()});
          if(summary.entries.length>100){summary.entries.shift();summary.omittedCount++;}
        }
      }
      s.results.push(result);
    }
    if(s.mode==='atomic'){finishTransaction(s);for(const result of s.results)if(result.transactionEffect==='pending')result.transactionEffect='committed';}
    touch(s);
    s.status='success';s.message=s.transaction==='active'?'事务尚未提交。':'执行完成。';
    return response(s);
  }
  return {handle,sessions,executions,calls};
}

async function assertSqlExecutionUi({win,fill,click,waitFor,textContains,testId,screenshot,state,PRIMARY_ID,setExactViewport,returnToDetails,openDatabaseWorkspace}) {
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const activeResult='[data-query-document]:not([hidden]) ';
  const resultText=async(id,text)=>waitFor(win,`document.querySelector(${JSON.stringify(activeResult+testId(id))})?.textContent.includes(${JSON.stringify(text)})`,'当前 SQL 标签显示 '+text);
  const fixture=state.sqlFixture;
  const currentId=()=>evaluate("document.querySelector('[data-testid=mysql-sql-document-tab][aria-selected=true]').dataset.queryId");
  const setMode=async label=>{await click(win,testId('mysql-query-mode'));await evaluate(`[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(${JSON.stringify(label)})).click()`);};
  const runAll=async()=>{await evaluate("document.querySelector('[data-testid=mysql-query-run-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");await click(win,testId('mysql-query-run-all'));};
  const lastOperation=operation=>fixture.calls.filter(call=>call.operation===operation);
  await click(win,testId('mysql-query-new'));
  const id=await currentId();
  const selectionScript='SELECT * FROM orders;\nSELECT * FROM orders WHERE 1 = 0';
  await fill(win,testId('mysql-sql-editor'),selectionScript);
  await evaluate(`document.querySelector('[data-testid=mysql-sql-editor]').setSelectionRange(${selectionScript.indexOf('\n')+1},${selectionScript.length})`);
  await evaluate("document.querySelector('[data-testid=mysql-query-run-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
  await click(win,testId('mysql-query-run-selection'));
  await textContains(win,'mysql-query-summary','0 行');
  await resultText('mysql-query-statements','行 2');
  assert.equal(fixture.executions.at(-1).sql,'SELECT * FROM orders WHERE 1 = 0','选中执行只能发送明确选中的语句');
  await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='batch' WHERE id=1;\nSELECT * FROM orders WHERE 1 = 0");
  const before=fixture.executions.length;
  await runAll();
  await textContains(win,'mysql-query-confirm-dialog','2 条语句');
  assert.equal(fixture.executions.length,before,'生产确认前不得执行任何一条语句');
  assert.ok(await evaluate("document.querySelector('[data-testid=mysql-query-confirm-dialog] [data-environment-type=production]') !== null"),'确认必须显示生产环境');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-run-menu]').getAttribute('data-state')"),'closed','确认打开时执行菜单必须关闭');
  await screenshot(win,'sql-production-confirm');
  await evaluate("[...document.querySelectorAll('[data-testid=mysql-query-confirm-dialog] button')].find(e=>e.textContent==='取消').click()");
  await waitFor(win,"!document.querySelector('[data-testid=mysql-query-confirm-dialog]')",'取消生产写入确认');
  assert.equal(fixture.executions.length,before,'取消确认不会执行或自动重试');
  await runAll();
  await click(win,testId('mysql-query-confirm-execute'));
  await resultText('mysql-query-statements','第 2 条');
  assert.equal(fixture.executions.length,before+1,'生产写入整批只执行一次');
  assert.equal(await evaluate("document.querySelectorAll('[data-query-document]:not([hidden]) [data-testid=mysql-query-statement-result]').length"),2);
  await click(win,activeResult+'[data-testid=mysql-query-statement-result][data-statement-index="2"]');
  await textContains(win,'mysql-query-summary','0 行');
  await screenshot(win,'sql-batch');

  await setMode('手动事务');
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');
  await click(win,testId('mysql-query-run'));
  await resultText('mysql-query-transaction-active','事务未提交');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-mode]').disabled"),true,'活动事务不能切换模式');
  await click(win,testId('mysql-sql-tab'));
  await click(win,`[data-testid=mysql-sql-document-tab][data-query-id="${id}"]`);
  await resultText('mysql-query-transaction-active','事务未提交');
  const releaseCount=lastOperation('release').length;
  await returnToDetails(win);await openDatabaseWorkspace(win);
  await resultText('mysql-query-transaction-active','事务未提交');
  assert.equal(lastOperation('release').length,releaseCount,'返回详情与继续工作区保留事务');
  const size=win.getContentSize();await setExactViewport(win,960,640);
  const buttons=await evaluate("['run','stop','commit','rollback'].map(id=>{const e=document.querySelector('[data-testid=mysql-query-'+id+']'),r=e.getBoundingClientRect();return {id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,disabled:e.disabled}})");
  assert.ok(buttons.every(button=>button.x>=0&&button.right<=960&&button.bottom<=640),'窄屏工具栏按钮完整可见');
  assert.equal(buttons.find(button=>button.id==='commit').disabled,false);
  await screenshot(win,'sql-manual-narrow');
  await click(win,testId('mysql-query-commit'));
  await waitFor(win,"!document.querySelector('[data-testid=mysql-query-transaction-active]')",'提交后结束事务');
  assert.match(fixture.executions.at(-1).sql,/^COMMIT$/u);
  const after=await evaluate("['run','stop','commit','rollback'].map(id=>{const r=document.querySelector('[data-testid=mysql-query-'+id+']').getBoundingClientRect();return {id,x:r.x,y:r.y}})");
  assert.deepEqual(after.map(button=>button.id),buttons.map(button=>button.id),'提交前后按钮顺序固定');
  // 允许亚像素舍入差异，实际像素级位移仍会使回归失败。
  for (let index=0;index<buttons.length;index++) {
    const previous=buttons[index],current=after[index];
    assert.ok(Math.abs(current.x-previous.x)<=0.1&&Math.abs(current.y-previous.y)<=0.1,
      '提交前后按钮位置固定：'+JSON.stringify({before:previous,after:current}));
  }
  await setExactViewport(win,...size);
  await click(win,testId('mysql-query-run'));await resultText('mysql-query-transaction-active','事务未提交');
  await click(win,testId('mysql-query-rollback'));
  await waitFor(win,"!document.querySelector('[data-testid=mysql-query-transaction-active]')",'回滚后结束事务');
  assert.equal(fixture.executions.at(-1).sql,'ROLLBACK');
  await click(win,testId('mysql-query-run'));await resultText('mysql-query-transaction-active','事务未提交');
  const beforeClose=lastOperation('release').length;
  await click(win,`[data-testid=mysql-query-close][data-query-id="${id}"]`);
  await textContains(win,'mysql-edit-discard-dialog','事务');
  assert.equal(lastOperation('release').length,beforeClose,'关闭确认前事务必须保留');
  await click(win,testId('mysql-edit-discard-confirm'));
  await waitFor(win,`!document.querySelector('[data-testid=mysql-sql-document-tab][data-query-id="${id}"]')`,'确认释放后关闭 SQL 标签');
  assert.ok(lastOperation('release').length>beforeClose);

  await click(win,testId('mysql-query-new'));
  const stopId=await currentId();
  const hold={channel:'v2:mysql-sql',pluginInstanceId:PRIMARY_ID,result:null};state.holdNext=hold;
  await fill(win,testId('mysql-sql-editor'),'SELECT delayed_stop FROM orders');
  await click(win,testId('mysql-query-run'));
  await waitFor(win,"!document.querySelector('[data-testid=mysql-query-stop]').disabled",'执行中可停止');
  const executionsBeforeStop=fixture.executions.length;
  await click(win,testId('mysql-query-stop'));
  await resultText('mysql-query-execution-summary','停止');
  assert.equal(fixture.executions.length,executionsBeforeStop,'停止不能重试执行');
  await click(win,`[data-testid=mysql-query-close][data-query-id="${stopId}"]`);

  await click(win,testId('mysql-query-new'));
  const unknownId=await currentId();state.sqlUnknownNext=true;
  await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='unknown' WHERE id=1");
  await click(win,testId('mysql-query-run'));await click(win,testId('mysql-query-confirm-execute'));
  await resultText('mysql-query-uncertain','执行结果待核实');
  const unknownExecutions=fixture.executions.length;
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-run]').disabled"),true,'结果未知必须锁住重复执行');
  await evaluate("[...document.querySelectorAll('[data-testid=mysql-query-uncertain] button')].find(e=>e.textContent.includes('核对状态')).click()");
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(fixture.executions.length,unknownExecutions,'核实只查询状态，不能重发写入');
  await screenshot(win,'sql-outcome-unknown');
  await click(win,`[data-testid=mysql-query-close][data-query-id="${unknownId}"]`);
  await click(win,testId('mysql-edit-discard-confirm'));
  await waitFor(win,`!document.querySelector('[data-query-id="${unknownId}"][role=tab]')`,'结果未知标签释放后关闭');
  await click(win,testId('mysql-sql-tab'));
  await assertTransactionSummaryUi({win,fill,click,waitFor,testId,screenshot,state,PRIMARY_ID,setExactViewport});

  // 完整数据库回归可能保留拖表生成的查询；先关闭这些已结束的查询再建立竞态场景。
  const existing=await evaluate("[...document.querySelectorAll('[data-query-id][role=tab]')].map(e=>e.dataset.queryId)");
  for(const extraId of existing.slice(1)) {
    await click(win,`[data-testid=mysql-query-close][data-query-id="${extraId}"]`);
    await waitFor(win,`!document.querySelector('[data-query-id="${extraId}"][role=tab]')`,'关闭前序用例留下的查询');
  }
  // 主进程释放延迟时，连续关闭最后两个标签不能把工作区清成零标签。
  const remaining=await evaluate("[...document.querySelectorAll('[data-query-id][role=tab]')].map(e=>e.dataset.queryId)");
  assert.equal(remaining.length,1,'并发关闭用例从一个 SQL 标签开始');
  await click(win,testId('mysql-query-new'));
  const closingId=await currentId();
  const releaseHold={pluginInstanceId:PRIMARY_ID};state.holdSqlRelease=releaseHold;
  const releaseBeforeRace=lastOperation('release').length;
  try {
    await evaluate(`(() => {const first=document.querySelector('[data-testid=mysql-query-close][data-query-id="${closingId}"]'),second=document.querySelector('[data-testid=mysql-query-close][data-query-id="${remaining[0]}"]');first.click();second.click();})()`);
    for(let attempt=0;attempt<100 && !releaseHold.release;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(typeof releaseHold.release,'function','关闭等待独立会话释放');
    assert.equal(lastOperation('release').length,releaseBeforeRace+1,'并发关闭只允许一条释放流程');
    assert.equal(await evaluate("document.querySelectorAll('[data-query-id][role=tab]').length"),2,'释放完成前保留两个标签');
  } finally {releaseHold.release?.();state.holdSqlRelease=null;}
  await waitFor(win,"document.querySelectorAll('[data-query-id][role=tab]').length === 1",'并发关闭后保留最后一个 SQL 标签');
  assert.equal(await evaluate("document.querySelector('[data-query-id][role=tab][aria-selected=true]')?.dataset.queryId"),remaining[0],'当前选择必须仍指向保留的 SQL 标签');
  assert.ok(await evaluate("document.querySelector('[data-testid=mysql-sql-editor]') !== null"),'最后一个 SQL 编辑器继续可用');
}

async function assertTransactionSummaryUi({win,fill,click,waitFor,testId,screenshot,state,PRIMARY_ID,setExactViewport}) {
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const active='[data-query-document]:not([hidden]) ';
  const fixture=state.sqlFixture;
  const currentId=()=>evaluate("document.querySelector('[data-testid=mysql-sql-document-tab][aria-selected=true]').dataset.queryId");
  const setManual=async()=>{await click(win,testId('mysql-query-mode'));await evaluate("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('手动事务')).click()");};
  const latestSession=()=>{const documentId=fixture.calls.filter(call=>call.operation==='prepare').at(-1).documentId;return [...fixture.sessions.values()].find(session=>session.documentId===documentId);};
  const counts=async(expected)=>{
    await waitFor(win,`(() => {const e=document.querySelector('${active}[data-testid=mysql-query-transaction-counts]');return e&&Number(e.dataset.statementCount)===${expected[0]}&&Number(e.dataset.writeCount)===${expected[1]}&&Number(e.dataset.affectedRows)===${expected[2]}})()`,'事务累计数量 '+expected.join('/'));
  };
  const idle=async value=>waitFor(win,`document.querySelector('${active}[data-testid=mysql-query-transaction-summary]')?.dataset.idleState === '${value}'`,'事务闲置状态 '+value);
  await click(win,testId('mysql-query-new'));const id=await currentId();await setManual();
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');await click(win,testId('mysql-query-run'));
  await counts([1,0,0]);
  assert.match(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-active]').textContent`),/查询|无写入|未发生写入/u,'查询事务不得误报已有数据修改');
  const s=latestSession(),summaryId=s.transactionSummary.id;
  await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='summary-secret-business-value' WHERE id=1");
  await click(win,testId('mysql-query-run'));await click(win,testId('mysql-query-confirm-execute'));
  await counts([2,1,1]);assert.equal(s.transactionSummary.id,summaryId,'跨请求沿用原事务');
  await click(win,active+testId('mysql-query-transaction-toggle'));
  await waitFor(win,`document.querySelectorAll('${active}[data-testid=mysql-query-transaction-entry]').length === 2`,'展开跨请求事务清单');
  const summaryText=await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-summary]').textContent`);
  assert.match(summaryText,/SELECT/u);assert.match(summaryText,/UPDATE/u);assert.match(summaryText,/orders/u);
  assert.ok(!summaryText.includes('summary-secret-business-value'),'摘要清单不包含 SQL 正文或业务值');
  await click(win,testId('mysql-sql-tab'));
  assert.equal(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-summary]')`),null,'其他 SQL 标签不能看到本事务摘要');
  await click(win,`[data-testid=mysql-sql-document-tab][data-query-id="${id}"]`);await counts([2,1,1]);
  const held={channel:'v2:mysql-sql',pluginInstanceId:PRIMARY_ID,result:null};state.holdNext=held;
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders WHERE 1 = 0');await click(win,testId('mysql-query-run'));
  try {await idle('paused');assert.equal(s.transactionSummary.statementCount,2,'执行中不提前累计成功语句');}
  finally {held.release?.();}
  await counts([3,1,1]);
  s.transactionSummary.startedAt=Date.now()-255_000;
  s.transactionSummary.idleExpiresAt=Date.now()+45_000;const expires=s.transactionSummary.idleExpiresAt;
  await idle('soon');assert.equal(s.transactionSummary.idleExpiresAt,expires,'正常状态轮询不延长截止时间');
  const original=win.getContentSize();await setExactViewport(win,960,640);
  const geometry=await evaluate(`(() => {const e=document.querySelector('${active}[data-testid=mysql-query-transaction-summary]'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.ok(geometry.left>=0&&geometry.right<=960&&!geometry.overflow,'960宽事务摘要不得横向溢出');
  await screenshot(win,'sql-transaction-summary');await setExactViewport(win,...original);
  s.transactionSummary.idleExpiresAt=Date.now()-1000;
  const beforeExpiry=fixture.executions.length;await idle('confirming');
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(s.transaction,'active','倒计时到零不会在界面或fixture中自动宣布回滚');
  assert.equal(fixture.executions.length,beforeExpiry,'本地倒计时不能发送提交或回滚');
  assert.ok(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-active]') !== null`));
  s.transaction='none';s.status='cancelled';delete s.transactionSummary;s.message='SQL 会话闲置超过 5 分钟，未提交事务已回滚，连接已释放。';
  for(const result of s.results)if(result.transactionEffect==='pending')result.transactionEffect='rolledBack';
  await waitFor(win,`!document.querySelector('${active}[data-testid=mysql-query-transaction-active]')`,'服务端确认后清除事务摘要');
  await waitFor(win,"document.body.textContent.includes('SQL 会话闲置超过 5 分钟')",'显示服务端闲置回滚结果');

  await click(win,testId('mysql-query-run'));await counts([1,0,0]);
  state.sqlUnknownNext=true;await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='uncertain-summary' WHERE id=1");
  await click(win,testId('mysql-query-run'));await click(win,testId('mysql-query-confirm-execute'));
  await idle('unknown');
  assert.doesNotMatch(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-summary]').textContent`),/未发生写入|尚未执行|没有待提交的数据更改/u,'未知结果只能描述已确认成功的操作，不能宣称没有写入');
  assert.equal(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-time]')`),null,'未知结果不展示无法确认的倒计时');
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-time]')`),null,'未知结果持续暂停计时，不假装知道剩余空闲时间');
  assert.equal(s.transactionSummary.statementCount,1,'不确定的写入不能计为成功写入');
  await click(win,`[data-testid=mysql-query-close][data-query-id="${id}"]`);await click(win,testId('mysql-edit-discard-confirm'));
  await waitFor(win,`!document.querySelector('[data-query-id="${id}"][role=tab]')`,'释放摘要未知状态标签');

  await click(win,testId('mysql-query-new'));const zeroUnknownId=await currentId();await setManual();state.sqlUnknownNext=true;
  await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='unknown-before-first-ack' WHERE id=1");
  await click(win,testId('mysql-query-run'));await click(win,testId('mysql-query-confirm-execute'));
  await idle('unknown');await counts([0,0,0]);
  assert.equal(await evaluate(`document.querySelectorAll('${active}[data-testid=mysql-query-transaction-entry]').length`),0);
  assert.doesNotMatch(await evaluate(`document.querySelector('${active}[data-testid=mysql-query-transaction-summary]').textContent`),/未发生写入|尚未执行|没有待提交的数据更改/u,'首条写入结果未知且零摘要，不能误报没有执行或写入');
  await click(win,active+testId('mysql-query-transaction-toggle'));
  await screenshot(win,'sql-transaction-unknown-empty');
  await click(win,`[data-testid=mysql-query-close][data-query-id="${zeroUnknownId}"]`);await click(win,testId('mysql-edit-discard-confirm'));
  await waitFor(win,`!document.querySelector('[data-query-id="${zeroUnknownId}"][role=tab]')`,'释放尚无成功应答的未知事务标签');

  await click(win,testId('mysql-query-new'));const permissionId=await currentId();
  state.sqlNextError={code:'MYSQL_SQL_WRITE_UNSAFE',message:'无法确认目标表的触发器元数据可见性，已停止本次写入检查。',details:{reason:'trigger_visibility',driverMessage:'fixture-private-driver-user-and-host'}};
  await fill(win,testId('mysql-sql-editor'),"UPDATE orders SET label='permission-fixture' WHERE id=1");
  await click(win,testId('mysql-query-run'));await click(win,testId('mysql-query-confirm-execute'));
  await waitFor(win,`document.querySelector('${active}[data-testid=diagnostic-details]')?.textContent.includes('TRIGGER')`,'结构化权限建议');
  await click(win,active+'[data-testid=diagnostic-details] summary');
  const details=await evaluate(`document.querySelector('${active}[data-testid=diagnostic-details]').textContent`);
  assert.match(details,/直接|角色/u);assert.ok(!details.includes('fixture-private-driver-user-and-host'));
  await evaluate(`[...document.querySelectorAll('${active}[data-testid=diagnostic-details] button')].find(e=>e.textContent.includes('复制诊断')).click()`);
  await waitFor(win,`document.querySelector('${active}[data-testid=diagnostic-details]')?.textContent.includes('已复制')`,'复制安全权限诊断');
  const copied=await evaluate('window.__databaseClipboardWrites.at(-1)');
  assert.match(copied,/TRIGGER/u);assert.ok(!copied.includes('fixture-private-driver-user-and-host'));
  await screenshot(win,'sql-permission-guidance');
  await click(win,`[data-testid=mysql-query-close][data-query-id="${permissionId}"]`);await click(win,testId('mysql-sql-tab'));
}

module.exports={createSqlFixture,assertSqlExecutionUi};
