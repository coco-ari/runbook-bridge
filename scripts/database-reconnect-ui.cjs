const assert = require('node:assert/strict');

module.exports = async function ({win,fill,click,waitFor,textContains,testId,state,databaseCalls,PRIMARY_ID,plugins,runtime,assessment,queryResult}) {
  const evaluate = source => win.webContents.executeJavaScript(source,true);
  const fixture = state.sqlFixture;
  const active = plugins.find(plugin => plugin.pluginInstanceId === PRIMARY_ID);
  const phase = value => {
    active.assessment = assessment(value);
    state.sequence++;
    win.webContents.send('v2:environment-status-changed',runtime());
  };
  const disconnect = async () => {
    phase('disconnected');
    await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-disconnected]') !== null",'断线后停留工作区');
  };
  const reconnect = async () => {
    phase('connected');
    await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-disconnected]') === null",'重连恢复工作区');
    await textContains(win,'mysql-table-list','orders');
  };
  const value = () => evaluate("document.querySelector('[data-testid=mysql-sql-editor]').value");
  const reset = async () => {
    await click(win,testId('mysql-workspace-close'));
    await click(win,testId('mysql-workspace-confirm-close'));
    await click(win,testId('plugin-workspace-open'));
    await textContains(win,'mysql-table-list','orders');
  };
  await textContains(win,'mysql-table-list','orders');
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders');
  await click(win,testId('mysql-query-run'));
  await textContains(win,'mysql-query-result','模拟订单');
  await click(win,testId('mysql-query-new'));
  await fill(win,testId('mysql-sql-editor'),'SELECT id FROM orders WHERE id = 7');
  await click(win,'[data-testid=mysql-table-item][data-table-name=orders]');
  await textContains(win,'mysql-preview-result','已完成订单');
  await fill(win,testId('mysql-table-where'),'id > 5');
  const executions = fixture.executions.length;
  await disconnect();
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-document-tab]').getAttribute('aria-selected')"),'true');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'id > 5');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-preview-run]').disabled"),true);
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-tables-refresh]').disabled"),true);
  await click(win,testId('mysql-sql-document-tab'));
  assert.equal(await value(),'SELECT id FROM orders WHERE id = 7');
  await fill(win,testId('mysql-sql-editor'),'SELECT id FROM orders WHERE id = 8');
  const offlineCalls = databaseCalls.length;
  await evaluate("document.querySelector('[data-testid=mysql-query-run]').click()");
  await new Promise(resolve => setTimeout(resolve,150));
  assert.equal(databaseCalls.length,offlineCalls,'离线编辑 SQL 不触发读取或执行');
  state.allowDisconnect = true;
  state.failReconnect = true;
  await click(win,testId('mysql-workspace-reconnect'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-reconnect]')?.disabled === false",'重连失败后允许重试');
  assert.equal(await value(),'SELECT id FROM orders WHERE id = 8','重连失败仍保留草稿');
  state.failReconnect = false;
  await click(win,testId('mysql-workspace-reconnect'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-disconnected]') === null",'再次重连成功');
  state.allowDisconnect = false;
  assert.equal(await value(),'SELECT id FROM orders WHERE id = 8');
  assert.equal(fixture.executions.length,executions,'重连不自动执行 SQL');
  await click(win,testId('mysql-sql-tab'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-stale]') !== null",'旧查询结果标记过期');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-add-row]').disabled"),true,'未打开过编辑快照的旧结果也不能编辑');
  const before = fixture.calls.length;
  await click(win,testId('mysql-query-run'));
  await textContains(win,'mysql-query-result','模拟订单');
  await waitFor(win,"document.querySelector('[data-query-document=query-1] [data-testid=mysql-query-stale]') === null",'手动执行更新查询结果');
  assert.deepEqual(fixture.calls.slice(before).filter(call => ['release','prepare','execute'].includes(call.operation)).map(call => call.operation),['release','prepare','execute'],'重连首次执行先释放旧 SQL 会话');
  await click(win,testId('mysql-table-document-tab'));
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'id > 5');
  await waitFor(win,"document.querySelector('[data-testid=mysql-preview-stale]') !== null",'表数据需要重新读取');
  await click(win,testId('mysql-preview-run'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-preview-stale]') === null",'手动刷新表数据后解除失效标记');

  // 同批断重连时旧分页响应必须失效，表标签和筛选继续保留。
  const late = {channel:'v2:mysql-preview-table',pluginInstanceId:PRIMARY_ID,result:queryResult([{id:99,label:'不可回填的旧结果',optional:null}])};
  state.holdNext = late;
  await click(win,testId('mysql-preview-run'));
  assert.equal(typeof late.release,'function');
  phase('disconnected'); phase('connected');
  await waitFor(win,"document.querySelector('[data-testid=mysql-preview-stale]') !== null && !document.querySelector('[data-testid=mysql-preview-summary]')?.textContent.includes('正在读取')",'快速断重连保留标签并使旧请求失效');
  late.release();
  await new Promise(resolve => setTimeout(resolve,100));
  assert.equal(await evaluate("document.body.textContent.includes('不可回填的旧结果')"),false);
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'id > 5');

  // 已弹出的写入确认在断线后取消，重连不得继续消费旧计划。
  await click(win,testId('mysql-sql-document-tab'));
  await fill(win,testId('mysql-sql-editor'),'DELETE FROM orders');
  await click(win,testId('mysql-query-run'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-confirm-dialog]') !== null",'写入确认已打开');
  const writes = fixture.executions.length;
  await disconnect();
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-confirm-dialog]') === null",'断线取消旧写入确认');
  await reconnect();
  assert.equal(fixture.executions.length,writes,'重连不提交旧写入计划');
  assert.equal(await value(),'DELETE FROM orders');
  await reset();

  // 准备阶段的迟到结果不得触发自动执行或重新弹出确认。
  const originalHandle = fixture.handle;
  let releasePrepare;
  fixture.handle = async payload => {
    const response = await originalHandle(payload);
    if (payload.operation === 'prepare') await new Promise(resolve => { releasePrepare = resolve; });
    return response;
  };
  await fill(win,testId('mysql-sql-editor'),'SELECT id FROM orders');
  await click(win,testId('mysql-query-run'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-run]').disabled",'SQL 准备请求等待响应');
  assert.equal(typeof releasePrepare,'function');
  const preparedExecutions = fixture.executions.length;
  await disconnect(); await reconnect();
  fixture.handle = originalHandle;
  releasePrepare();
  await new Promise(resolve => setTimeout(resolve,100));
  assert.equal(fixture.executions.length,preparedExecutions,'旧准备响应不能自动执行');
  assert.equal(await value(),'SELECT id FROM orders');
  await click(win,testId('mysql-query-run'));
  await textContains(win,'mysql-query-result','模拟订单');
  await reset();

  // 执行中的响应在断线后到达也不能恢复成可重试状态。
  const heldExecution = {channel:'v2:mysql-sql',pluginInstanceId:PRIMARY_ID,result:queryResult([{id:77,label:'旧执行响应',optional:null}])};
  state.holdNext = heldExecution;
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders');
  await click(win,testId('mysql-query-run'));
  assert.equal(typeof heldExecution.release,'function');
  await disconnect();
  heldExecution.release();
  await new Promise(resolve => setTimeout(resolve,100));
  assert.equal(await evaluate("document.body.textContent.includes('旧执行响应')"),false,'断线前执行的迟到响应不能回填');
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-uncertain]') !== null",'在途执行断线后锁住重试');
  await reconnect();
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-run]').disabled"),true);
  await click(win,testId('mysql-workspace-close'));
  await click(win,testId('mysql-workspace-confirm-close'));
  await click(win,testId('mysql-edit-discard-confirm'));
  await click(win,testId('plugin-workspace-open'));
  await textContains(win,'mysql-table-list','orders');

  // 活动事务掉线后只能核对状态，不能在新连接提交旧事务。
  await fill(win,testId('mysql-sql-editor'),'SELECT * FROM orders');
  await click(win,testId('mysql-query-mode'));
  await evaluate("[...document.querySelectorAll('[role=option]')].find(item => item.textContent.includes('手动事务')).click()");
  await click(win,testId('mysql-query-run'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-transaction-active]') !== null",'建立模拟手动事务');
  for (const session of fixture.sessions.values()) if (session.transaction === 'active') {
    session.transaction = 'unknown'; session.status = 'unknown';
  }
  const transactionExecutions = fixture.executions.length;
  await disconnect(); await reconnect();
  await waitFor(win,"document.querySelector('[data-testid=mysql-query-uncertain]') !== null",'事务保持待核实状态');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-commit]').disabled"),true);
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-query-run]').disabled"),true);
  assert.equal(fixture.executions.length,transactionExecutions,'重连不执行或提交旧事务');
  await click(win,testId('mysql-workspace-close'));
  await click(win,testId('mysql-workspace-confirm-close'));
  await click(win,testId('mysql-edit-discard-confirm'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-full-window-workspace]') === null",'明确关闭才释放保留工作区');
  process.stdout.write('数据库断线保留通过：多 SQL、表标签、筛选、离线编辑、重连、旧结果、迟到响应、写入确认及事务隔离。\n');
};
