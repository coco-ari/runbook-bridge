const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain } = require('electron');

module.exports = async ({win,confirmations,publishUpdates,waitFor,captureRenderedFrame,screenshotRoot,restoreHandlers}) => {
  const evaluate = code => win.webContents.executeJavaScript(code,true);
  const popup = '[data-testid="update-center"]';
  const review = popup + ' [data-testid="confirmation-review"]';
  const card = id => review + ` [data-confirmation-id="${id}"]`;
  const approve = id => card(id) + ' [data-slot="button-group"] button:last-child';
  const reject = id => card(id) + ' [data-slot="button-group"] button:first-child';
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    if (process.platform === 'darwin') app.focus({steal:true});
    win.focus(); win.webContents.focus();
    await captureRenderedFrame(win);
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)}), rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x,y))) throw new Error('确认弹窗点击目标不可见或被遮挡');
      return {x,y};
    })()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await captureRenderedFrame(win);
  };
  const channels = ['v2:confirmation-list','v2:confirmation-approve','v2:confirmation-reject'];
  const base = structuredClone(confirmations).map(item => ({...item,expiresAt:Date.now()+600000}));
  let items = base, releaseDecision, failDecision = false;
  const decisions = [];
  const publish = next => { items = next; win.webContents.send('v2:confirmations-changed',structuredClone(items)); };
  const select = async id => {
    await waitFor(`document.querySelector('[data-confirmation-message="${id}"] button')`,'消息列表包含目标请求');
    await click(`[data-confirmation-message="${id}"] button`);
    await waitFor(`document.querySelector('${card(id)}')`,'仅展开选中的请求');
    assert.equal(await evaluate(`document.querySelectorAll('${review} [data-confirmation-id]').length`),1);
  };
  const open = async () => {
    await click('[data-testid="updates-open"]');
    await select('confirmation-shell');
  };
  for (const channel of channels) ipcMain.removeHandler(channel);
  ipcMain.handle(channels[0],async () => ({ok:true,data:structuredClone(items)}));
  for (const [channel,decision] of [[channels[1],'approve'],[channels[2],'reject']]) {
    ipcMain.handle(channel,async (_event,...args) => {
      decisions.push({decision,args:structuredClone(args)});
      if (failDecision) return {ok:false,error:{code:'CONFIRMATION_FAILED',message:'合成确认失败'}};
      await new Promise(resolve => { releaseDecision = resolve; });
      publish(items.filter(item => item.requestId !== args[0]));
      return {ok:true,data:{requestId:args[0]}};
    });
  }
  try {
    win.setContentSize(1280,820);
    publish(base);
    publishUpdates([{id:'merged-cloud',type:'cloud',kind:'changed',repositoryId:'fixture-one',repositoryName:'合成仓库',projectId:'demo',title:'合成项目更新',description:'云端有配置变化'}]);
    await waitFor(`document.querySelector('[data-testid="confirmation-notice"]')?.textContent.includes('3 项操作待确认')`,'侧栏持续提示');
    await click('[data-project-id="project-data"]');
    await open();
    assert.equal(await evaluate(`document.querySelector('#detail-main').dataset.selectionKind`),'project','确认详情保留原导航');
    assert.equal(await evaluate(`document.querySelector('${review}').textContent.includes('跨范围请求不得显示')`),false,'不显示其他环境的操作');
    assert.equal(await evaluate(`document.querySelector('${approve('confirmation-shell')}').disabled`),true,'Shell 未核对禁止批准');
    assert.deepEqual(decisions,[],'查看不触发确认');
    assert.equal(await evaluate(`document.querySelector('${card('confirmation-shell')} [data-testid="confirmation-full-command"]').textContent`),base[1].presentation.command,'紧凑布局保留完整长命令');

    await click(card('confirmation-shell') + ' [role="checkbox"]');
    assert.equal(await evaluate(`document.querySelector('${approve('confirmation-shell')}').disabled`),false,'核对后可批准');
    await click('[data-testid="updates-close"]');
    await open();
    assert.equal(await evaluate(`document.querySelector('${approve('confirmation-shell')}').disabled`),true,'重新打开必须重新核对');
    publish([base[0],{...base[1],presentation:{kind:'shell'}},base[2]]);
    await waitFor(`document.querySelector('${card('confirmation-shell')}').textContent.includes('完整命令不可用')`,'命令缺失禁止核对');
    assert.equal(await evaluate(`document.querySelector('${approve('confirmation-shell')}').disabled`),true);
    publish(base);
    await waitFor(`document.querySelector('${card('confirmation-shell')} [data-testid="confirmation-full-command"]')`,'恢复命令详情');

    for (const width of [800,1280]) {
      win.setContentSize(width,820);
      await captureRenderedFrame(win);
      await click(card('confirmation-shell') + ' [role="checkbox"]');
      const geometry = await evaluate(`(() => {
        const popup = document.querySelector('${popup}'), rect = popup.getBoundingClientRect(), list = popup.querySelector('[data-utility-popover-list]');
        return {width:rect.width,inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,scrolling:list.scrollHeight>list.clientHeight,horizontalOverflow:list.scrollWidth>list.clientWidth+1};
      })()`);
      assert.deepEqual(geometry,{width:360,inViewport:true,scrolling:true,horizontalOverflow:false},'窄屏内保留滚动和完整参数');
    }
    if (screenshotRoot) {
      await click(card('confirmation-shell') + ' h3');
      fs.mkdirSync(screenshotRoot,{recursive:true});
      fs.writeFileSync(path.join(screenshotRoot,'confirmation-review.png'),(await captureRenderedFrame(win)).toPNG());
    }

    await click('[data-testid="confirmation-review-back"]');
    await waitFor(`document.querySelector('[data-testid="message-confirmations"]') && document.querySelector('[data-testid="update-notice"]')`,'两类事项同一弹窗清楚分区');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="confirmation-center"], [data-testid="workspace-confirmation-center"]'))`),false,'移除独立确认入口');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="project-rail"] [data-testid="workspace-switcher"]'))`),true,'工作区仍独立');
    if (screenshotRoot) {
      await evaluate(`document.querySelector('${popup} [data-utility-popover-list]').scrollTop = 0`);
      fs.writeFileSync(path.join(screenshotRoot,'merged-message-center.png'),(await captureRenderedFrame(win)).toPNG());
    }
    await select('confirmation-upload');
    await click(approve('confirmation-upload'));
    await waitFor(`document.querySelector('${approve('confirmation-upload')}').disabled`,'确认提交期间禁用重复操作');
    assert.equal(await evaluate(`document.querySelector('${reject('confirmation-upload')}').disabled`),true);
    await evaluate(`document.querySelector('${approve('confirmation-upload')}').click()`);
    assert.deepEqual(decisions,[{decision:'approve',args:['confirmation-upload']}],'只提交本条请求标识一次');
    releaseDecision(); releaseDecision = null;
    await waitFor(`document.querySelector('[data-testid="message-decision-feedback"]')?.textContent.includes('等待 Agent 执行') && !document.querySelector('${review}')`,'授权后回消息列表且不误报执行成功');
    await waitFor(`document.querySelector('[data-testid="updates-open"]').getAttribute('aria-label') === '消息中心，2 项待确认操作，1 项更新'`,'两种计数独立');
    await select('confirmation-shell');
    failDecision = true;
    await click(reject('confirmation-shell'));
    await waitFor(`document.querySelector('${review} [data-testid="confirmation-queue-error"]')`,'失败留在弹窗内可重试');
    assert.equal(await evaluate(`document.querySelector('${reject('confirmation-shell')}').disabled`),false);
    failDecision = false;
    await click(reject('confirmation-shell'));
    assert.deepEqual(decisions.slice(1),[{decision:'reject',args:['confirmation-shell']},{decision:'reject',args:['confirmation-shell']}],'拒绝只绑定本条请求，失败可重试');
    releaseDecision(); releaseDecision = null;
    await waitFor(`document.querySelector('[data-testid=message-decision-feedback]')?.textContent.includes('操作已拒绝') && !document.querySelector('${review}')`,'拒绝后显示结果且保持弹窗打开');
    await waitFor(`document.querySelector('[data-testid="updates-open"]').getAttribute('aria-label') === '消息中心，1 项待确认操作，1 项更新'`,'处理完当前环境仍保留其他环境数量');

    publish([{...base[1],expiresAt:Date.now()+3000},base[2]]);
    await select('confirmation-shell');
    await waitFor(`!document.querySelector('${card('confirmation-shell')}')`,'过期请求不能在弹窗中确认');
    await click('[data-testid="confirmation-review-back"]');
    await waitFor(`!document.querySelector('${review}') && document.querySelector('${popup}')`,'返回列表保留弹窗');
    assert.equal(await evaluate(`document.querySelector('${popup} [data-confirmation-environment="environment-archive"] button').disabled`),true,'不可用环境无法批准');
    assert.equal(await evaluate(`document.querySelector('#detail-main').dataset.selectionKind`),'project','全部操作不跳转导航');
    publish([]);
    await waitFor(`!document.querySelector('[data-testid="confirmation-notice"]') && document.querySelector('[data-testid="update-notice"]')`,'确认处理完后提示条收起，更新仍保留');
    const newRequest={...base[0],requestId:'merged-new-arrival',expiresAt:Date.now()+60000};
    publish([newRequest]);
    await waitFor(`document.querySelector('[data-sonner-toaster]')?.textContent.includes('有 1 项新操作需要确认')`,'新增请求轻提示');
    await select(newRequest.requestId);
    publish([newRequest,{...base[1],requestId:'merged-second-arrival'}]);
    await waitFor(`document.querySelector('[data-testid="updates-open"]').getAttribute('aria-label').includes('2 项待确认')`,'详情打开时仍收到新请求');
    assert.equal(await evaluate(`document.querySelector('${review} [data-confirmation-id]').dataset.confirmationId`),newRequest.requestId,'新请求不切走正在核对的详情');
    await click('[data-testid="updates-close"]');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="confirmation-notice"]'))`),true,'关闭消息不清除待确认提醒');
    publish([]);publishUpdates([]);
    await waitFor(`!document.querySelector('[data-testid="confirmation-notice"]')`,'清空合成请求');
    await click('[data-testid="updates-open"]');
    await waitFor(`document.querySelector('${popup}')?.textContent.includes('暂无消息')`,'两类事项均空时简洁空态');
    assert.equal(await evaluate(`Boolean(document.querySelector('${popup} [data-testid="message-confirmations"]'))`),false);
    await click('[data-testid="updates-close"]');
  } finally {
    releaseDecision?.();
    for (const channel of channels) ipcMain.removeHandler(channel);
    restoreHandlers();
  }
};
