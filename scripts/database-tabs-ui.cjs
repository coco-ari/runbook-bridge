const assert = require('node:assert/strict');
module.exports = async function ({win,fill,click,waitFor,textContains,testId,screenshot,state,databaseCalls,PRIMARY_ID,openRowDetail}) {
  const evaluate = source => win.webContents.executeJavaScript(source,true);
  state.browseFixture = true;
  await click(win,'[data-testid=mysql-table-document-tab][data-table-name=orders]');
  await fill(win,testId('mysql-table-where'),'id >= 51');
  await click(win,testId('mysql-preview-run'));
  await textContains(win,'mysql-preview-summary','15 行');
  const before = databaseCalls.length;
  await click(win,'[data-testid=mysql-table-item][data-table-name=orders]');
  assert.equal(databaseCalls.length,before,'重复点击表不得重复查询');
  await click(win,testId('mysql-tables-load-more'));
  await click(win,'[data-testid=mysql-table-item][data-table-name=archived_orders]');
  await textContains(win,'mysql-preview-summary','20 行');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-table-document-tab]').length"),2);
  await fill(win,testId('mysql-table-where'),'id >= 61');
  await click(win,testId('mysql-preview-load-more'));
  await textContains(win,'mysql-preview-summary','40 行');
  await evaluate("document.querySelector('[data-testid=mysql-preview-table-scroll]').scrollTop=180");
  const beforeSwitch = databaseCalls.length;
  await click(win,'[data-testid=mysql-table-document-tab][data-table-name=orders]');
  await textContains(win,'mysql-preview-summary','15 行');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'id >= 51');
  assert.equal(databaseCalls.length,beforeSwitch,'切表恢复数据无需重新读取');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-preview-result]').length"),1,'后台表不保留表格 DOM');
  await fill(win,testId('mysql-table-where'),'');
  await evaluate("(() => { const transfer=new DataTransfer(); const header=document.querySelector('[data-testid=mysql-preview-sort][data-column=label]'); header.dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true})); const input=document.querySelector('[data-testid=mysql-table-where]'); input.focus(); input.setSelectionRange(0,0); input.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})); })()");
  await waitFor(win,"document.querySelector('[data-testid=mysql-table-where]').value === '`label` '",'拖字段填入筛选条件');
  assert.equal(databaseCalls.length,beforeSwitch,'拖字段不自动执行筛选');
  await evaluate("(() => { const transfer=new DataTransfer(); transfer.setData('application/x-runbook-mysql-column',JSON.stringify({workspace:'other',table:'orders',column:'id'})); document.querySelector('[data-testid=mysql-table-where]').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})); })()");
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'`label` ');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-workspace-density]')"),null,'数据库工作区固定紧凑布局，不提供密度切换');
  await openRowDetail(win,'[data-testid=mysql-preview-row][data-row-index="0"]');
  // 菜单关闭后才提交行详情状态；等待真实挂载与原焦点就绪，不抢在异步动作之前读取选区。
  await waitFor(win,"document.querySelector('[data-testid=mysql-preview-row-detail] dd')?.getClientRects().length > 0 && document.querySelector('[data-testid=mysql-preview-copy-row]')?.getClientRects().length > 0 && document.activeElement === document.querySelector('[data-testid=mysql-preview-close-detail]')",'复制回退前行详情与原焦点就绪');
  const evaluateAdapter = async (stage,source) => {
    const result = await evaluate(`(async () => {
      try { return {ok:true,value:await (${source})}; }
      catch (error) { return {ok:false,error:{name:error?.name ?? 'Error',message:error?.message ?? String(error),stack:error?.stack ?? ''}}; }
    })()`);
    if (!result.ok) throw new Error(`数据库复制回退测试 ${stage} 失败：${result.error.name}: ${result.error.message}\n${result.error.stack}`);
    return result.value;
  };
  // 隐藏窗口无法可靠写入系统剪贴板；在系统 API 边界采集真实选区并模拟成功，不声称真实系统写入已覆盖。
  const copiedBefore = await evaluate('window.__databaseClipboardWrites.length');
  const expectedRow = {id:65,label:'浏览记录 65',optional:null};
  const expectedRowJson = JSON.stringify(expectedRow,null,2);
  try {
    await evaluateAdapter('安装',`(() => {
      const ranges = () => { const selection=document.getSelection(); return selection ? Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index).cloneRange()) : []; };
      const state = window.__databaseFallbackCopy = {
        clipboardDescriptor:Object.getOwnPropertyDescriptor(navigator,'clipboard'),
        execDescriptor:Object.getOwnPropertyDescriptor(document,'execCommand'),
        execCommand:document.execCommand,
        previousFocus:document.activeElement,previousRanges:ranges(),attempts:[],commands:[]
      };
      const source=document.querySelector('[data-testid=mysql-preview-row-detail] dd');
      if (!source) throw new Error('缺少行详情选区来源');
      const range=document.createRange(); range.selectNodeContents(source);
      const selection=document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
        state.attempts.push({text,focused:document.activeElement,ranges:ranges(),selectionLength:document.getSelection()?.toString().length ?? 0});
        throw new DOMException('Permission denied','NotAllowedError');
      }}});
      Object.defineProperty(document,'execCommand',{configurable:true,value:function(command,...args) {
        if (command !== 'copy') return state.execCommand.call(this,command,...args);
        const input=document.activeElement;
        const isTextarea=input instanceof HTMLTextAreaElement;
        const text=isTextarea ? input.value.slice(input.selectionStart,input.selectionEnd) : document.getSelection()?.toString();
        state.commands.push({text,isTextarea,fullSelection:isTextarea && input.selectionStart===0 && input.selectionEnd===input.value.length});
        window.__databaseClipboardWrites.push(text);
        return true;
      }});
    })()`);
    const assertFallback = async (count,expectedTexts) => {
      const actual = await evaluateAdapter(`第 ${count} 次复制恢复检查`,`(() => {
        const state=window.__databaseFallbackCopy;
        const previous=state.attempts.at(-1);
        const selection=document.getSelection();
        const restoredRanges=previous.ranges.length===selection.rangeCount && previous.ranges.every((range,index)=>{
          const actual=selection.getRangeAt(index);
          return range.startContainer===actual.startContainer && range.startOffset===actual.startOffset && range.endContainer===actual.endContainer && range.endOffset===actual.endOffset;
        });
        return {attempts:state.attempts.map(attempt=>attempt.text),commands:state.commands,focused:document.activeElement===previous.focused,restoredRanges,rangeCount:previous.ranges.length,selectionLength:previous.selectionLength,writes:window.__databaseClipboardWrites.slice(${copiedBefore})};
      })()`);
      assert.equal(actual.commands.length,count,'每次复制只调用一次系统回退');
      assert.deepEqual(actual.attempts,expectedTexts,'浏览器权限拒绝前的复制参数完整且顺序准确');
      assert.deepEqual(actual.commands.map(command=>command.text),expectedTexts,'回退从真实临时字段选区读取完整原文');
      assert.ok(actual.commands.every(command=>command.isTextarea && command.fullSelection),'系统回退完整选择实际临时文本字段');
      assert.deepEqual(actual.writes,expectedTexts,'每次回退只写入一次，复制顺序准确');
      assert.equal(actual.focused,true,'复制回退恢复原焦点');
      assert.equal(actual.rangeCount,1,'复制前保留一个真实非空 DOM 选区');
      assert.ok(actual.selectionLength>0,'复制前的真实 DOM 选区包含文本');
      assert.equal(actual.restoredRanges,true,'复制回退恢复原选区边界');
    };
    await click(win,testId('mysql-preview-copy-row'));
    await waitFor(win,`window.__databaseClipboardWrites.length === ${copiedBefore + 1} && document.body.textContent.includes('整行 JSON 已复制')`,'权限受限时整行 JSON 复制完成且仅写入一次');
    await assertFallback(1,[expectedRowJson]);
    assert.deepEqual(JSON.parse(await evaluateAdapter('整行 JSON 读取','window.__databaseFallbackCopy.commands[0].text')),expectedRow,'整行复制保留字段值及 NULL 语义');
    await click(win,'[data-testid=mysql-preview-copy-cell][data-column-name=label]');
    await waitFor(win,`window.__databaseClipboardWrites.length === ${copiedBefore + 2}`,'完整单元格复制完成且仅写入一次');
    await assertFallback(2,[expectedRowJson,'浏览记录 65']);
  } finally {
    await evaluateAdapter('还原',`(() => {
      const state=window.__databaseFallbackCopy;
      if (!state) return;
      if (state.clipboardDescriptor) Object.defineProperty(navigator,'clipboard',state.clipboardDescriptor); else delete navigator.clipboard;
      if (state.execDescriptor) Object.defineProperty(document,'execCommand',state.execDescriptor); else delete document.execCommand;
      if (state.previousFocus?.isConnected) state.previousFocus.focus({preventScroll:true});
      const selection=document.getSelection(); selection?.removeAllRanges();
      for (const range of state.previousRanges) selection?.addRange(range);
      delete window.__databaseFallbackCopy;
    })()`);
  }
  await click(win,testId('mysql-preview-close-detail'));
  await screenshot(win,'multiple-tables');
  const late = {channel:'v2:mysql-preview-table',pluginInstanceId:PRIMARY_ID,result:require('./database-assist-ui.cjs').browseFixture({offset:20})};
  await click(win,'[data-testid=mysql-table-document-tab][data-table-name=archived_orders]');
  assert.equal(await evaluate("document.querySelector('[data-testid=mysql-table-where]').value"),'id >= 61');
  assert.ok(await evaluate("document.querySelector('[data-testid=mysql-preview-table-scroll]').scrollTop >= 179"),'恢复表格滚动位置');
  state.holdNext = late;
  await click(win,testId('mysql-preview-load-more'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-preview-load-more]').textContent.includes('加载中')",'关闭前保持一个在途请求');
  await click(win,'[data-testid=mysql-table-close][data-table-name=archived_orders]');
  late.release();
  await textContains(win,'mysql-preview-summary','15 行');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-table-document-tab]').length"),1);
  state.extraTables = true;
  await click(win,testId('mysql-tables-refresh'));
  await textContains(win,'mysql-table-list','fixture_6');
  for (let index=1;index<=5;index++) {
    await click(win,'[data-testid=mysql-table-item][data-table-name=fixture_'+index+']');
    await textContains(win,'mysql-preview-summary','20 行');
  }
  const atLimit = databaseCalls.length;
  await click(win,'[data-testid=mysql-table-item][data-table-name=fixture_6]');
  assert.equal(databaseCalls.length,atLimit,'达到表标签上限不能继续发起请求');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-table-document-tab]').length"),6);
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-preview-result]').length"),1);
  await require('./workspace-layout-ui.cjs')({evaluate,until:(expression,label)=>waitFor(win,expression,label),win,root:'[data-testid=mysql-database-workspace]'});
  state.extraTables = false;
  await click(win,testId('mysql-workspace-close'));
  await click(win,testId('mysql-workspace-confirm-close'));
  await click(win,testId('plugin-workspace-open'));
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-table-document-tab]').length"),0,'关闭工作区清除全部表标签');
  state.allowDisconnect = true;
  state.failDisconnect = true;
  await click(win,testId('mysql-workspace-disconnect'));
  await waitFor(win,"document.body.textContent.includes('模拟断开失败')",'断开失败保留工作区');
  assert.equal(await evaluate("document.querySelectorAll('[data-testid=mysql-database-workspace]').length"),1);
  state.failDisconnect = false;
  await click(win,testId('mysql-workspace-disconnect'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-disconnected]') !== null",'成功断开保留数据库工作区');
  await click(win,testId('mysql-workspace-reconnect'));
  await waitFor(win,"document.querySelector('[data-testid=mysql-workspace-disconnected]') === null",'工作区内重新连接');
  state.allowDisconnect = false;
  state.browseFixture = false;
};
