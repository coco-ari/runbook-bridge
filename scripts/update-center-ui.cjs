const assert = require('node:assert/strict');

module.exports = async function exerciseUpdateCenter({evaluate,waitFor,pressKey,publish,capture,resize,click,setSoftwareHandler}) {
  const localProjectId = await evaluate(`document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId ?? document.querySelector('button[data-project-id]')?.dataset.projectId`);
  assert.ok(localProjectId);
  await evaluate(`document.querySelector('button[data-project-id="'+${JSON.stringify(localProjectId)}+'"]').click()`);
  let notices = [
    {id:'a'.repeat(64),type:'software',kind:'available',version:'99.0.0',repositoryId:'fixture-one',repositoryName:'演示云仓库',title:'新版本 99.0.0 可用',description:'下载新版本，完成后可立即更新。',firstSeenAt:Date.now()-600_000},
    {id:'b'.repeat(64),type:'cloud',kind:'conflict',repositoryId:'fixture-one',repositoryName:'团队仓库',projectId:'cloud-project-demo',localProjectId,title:'运维平台配置有更新',description:'本地与云端都有修改，请查看差异后处理。',firstSeenAt:Date.now()-300_000},
  ];
  let software = {phase:'available',currentVersion:'2.0.3',availableVersion:'99.0.0',releaseNotes:'合成版本说明',releaseDate:null,progress:null,error:null,checkedAt:null,source:{repositoryId:'fixture-one',name:'演示云仓库'},sources:[],supported:true};
  const requests = [];
  let finishDownload;
  setSoftwareHandler(async request => {
    requests.push(request);
    if (request.action === 'download') {
      software = {...software,phase:'downloading',progress:{percent:37,transferred:370,total:1000}};
      await new Promise(resolve => { finishDownload=resolve; });
      software = {...software,phase:'downloaded',progress:{percent:100,transferred:1000,total:1000}};
    }
    if (request.action === 'install') software = {...software,phase:'error',error:{code:'UPDATE_WORKSPACE_BUSY',message:'请先结束 SQL 事务和文件传输，再更新。'}};
    return software;
  });
  const jsClick = async selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const softwareAction = '[data-update-id="'+notices[0].id+'"] [data-testid="update-notice-view"]';
  const assertCompact = async testId => {
    const geometry = await evaluate(`(() => { const panel=document.querySelector('[data-testid="${testId}"]'),rect=panel.getBoundingClientRect(); return {overflow:panel.scrollWidth>panel.clientWidth,focused:panel.contains(document.activeElement),width:rect.width,height:rect.height,overlay:Boolean(document.querySelector('[data-slot="sheet-overlay"], [data-slot="dialog-overlay"]'))}; })()`);
    assert.equal(geometry.overflow,false); assert.equal(geometry.focused,true); assert.equal(geometry.overlay,false); assert.ok(geometry.width<=361); assert.ok(geometry.height<=520);
  };
  try {
    publish(notices);
    await waitFor(`document.querySelector('[data-testid="updates-count"]')?.textContent === '2'`,'未完成两项');
    await waitFor(`Boolean(document.querySelector('[data-testid="project-update-indicator"]')) && Boolean(document.querySelector('[data-testid="project-update-banner"]')) && Boolean(document.querySelector('[data-testid="software-update-hint"]'))`,'项目内提示与软件轻提示');
    assert.equal(await evaluate(`document.querySelector('[data-testid="project-update-view"]').textContent`),'立即更新');
    if (capture) await capture('update-workspace');
    await click('[data-testid="updates-open"]');
    await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 2`,'消息加载');
    await waitFor(`Math.abs(document.querySelector('[data-testid="update-center"]').getBoundingClientRect().bottom + 10 - document.querySelector('[data-testid="updates-open"]').getBoundingClientRect().top) < 2`,'浮层紧邻铃铛上方');
    await assertCompact('update-center');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="updates-pending"], [data-testid="updates-later"], [data-testid="update-snooze"], [data-testid="updates-read-all"]'))`),false);
    assert.match(await evaluate(`document.querySelector('[data-testid="update-center"]').textContent`),/消息中心/);
    if (capture) await capture('update-center');
    await click('[data-testid="updates-open"]');
    await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'点击入口收起');
    await click('[data-testid="updates-open"]');
    await waitFor(`Boolean(document.querySelector('[data-testid="update-center"]'))`,'再次展开');
    await click('input[placeholder="搜索项目"]');
    await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'点击外部收起');
    assert.equal(await evaluate(`document.activeElement?.getAttribute('placeholder')`),'搜索项目','外部输入保留焦点');
    await click('[data-testid="updates-open"]');
    await waitFor(`Boolean(document.querySelector('[data-testid="update-preferences"]'))`,'消息设置');
    await evaluate(`document.querySelector('[data-testid="update-preferences"]').focus()`);
    await pressKey('Enter');
    await waitFor(`Boolean(document.querySelector('[data-testid="update-mode-app"]'))`,'提醒方式');
    await jsClick('[data-testid="update-mode-app"]');
    await waitFor(`!document.querySelector('[data-testid="update-mode-app"]') && !document.querySelector('[data-testid="update-preferences"]').disabled`,'保存提醒方式');
    assert.equal(await evaluate(`document.querySelector('[data-testid="updates-count"]').textContent`),'2','偏好和查看不清除提醒');

    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="confirmation-center"], [data-testid="global-confirmation-center"]'))`),false,'移除独立确认入口和弹窗');
    await waitFor(`document.activeElement?.dataset.testid === 'update-preferences'`,'提醒菜单关闭后恢复焦点');
    await evaluate(`document.querySelector('[data-testid="update-center"]').focus()`);
    await waitFor(`!document.querySelector('[role="tooltip"]')`,'焦点离开设置按钮后关闭提示气泡');
    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'Esc 关闭消息中心');
    assert.equal(await evaluate(`document.activeElement?.dataset.testid`),'updates-open');
    await click('[data-testid="workspace-switcher"]');
    await waitFor(`Boolean(document.querySelector('[data-testid="workspace-manager"]'))`,'工作区统一浮层');
    await assertCompact('workspace-manager');
    if (capture) await capture('workspace-manager');
    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="workspace-manager"]')`,'关闭工作区列表');

    await click('[data-testid="updates-open"]');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(softwareAction)}))`,'软件消息');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(softwareAction)}).textContent`),'下载新版本');
    await jsClick(softwareAction);
    await waitFor(`document.querySelector(${JSON.stringify(softwareAction)})?.textContent.includes('37%')`,'直接下载与进度');
    assert.equal(requests.filter(r=>r.action==='download').length,1);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="settings-page"]'))`),false,'不必跳转设置');
    finishDownload();
    await waitFor(`document.querySelector(${JSON.stringify(softwareAction)})?.textContent === '立即更新' && !document.querySelector(${JSON.stringify(softwareAction)}).disabled`,'下载完成立即更新');
    notices = [{...notices[0],kind:'downloaded',title:'新版本 99.0.0 已就绪',description:'下载已完成，可立即更新。'},notices[1]];
    publish(notices);
    await jsClick(softwareAction);
    await waitFor(`Boolean(document.querySelector('[data-testid="software-update-confirm"]')) && !document.querySelector('[data-testid="update-center"]')`,'安装确认');
    assert.equal(requests.filter(r=>r.action==='install').length,0);
    await jsClick('[data-testid="software-update-install-cancel"]');
    await waitFor(`!document.querySelector('[data-testid="software-update-confirm"]')`,'取消安装');
    assert.equal(await evaluate(`document.querySelector('[data-testid="updates-count"]').textContent`),'2','取消后消息持续保留');
    await click('[data-testid="updates-open"]');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(softwareAction)}))`,'重新打开消息');
    await jsClick(softwareAction);
    await waitFor(`Boolean(document.querySelector('[data-testid="software-update-install-confirm"]:not(:disabled)'))`,'可确认安装');
    await jsClick('[data-testid="software-update-install-confirm"]');
    await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('SQL 事务')`,'安装受阻仍在消息中心显示原因');
    assert.equal(requests.filter(r=>r.action==='install').length,1,'明确确认后仅安装一次');
    assert.equal(await evaluate(`document.querySelector('[data-testid="updates-count"]').textContent`),'2','失败不移除消息');
    await waitFor(`!document.querySelector(${JSON.stringify(softwareAction)}).disabled`,'安装请求已结束');
    software = {...software,phase:'available',availableVersion:'100.0.0',error:null};
    await jsClick(softwareAction);
    await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('版本或更新来源已变化')`,'旧消息不下载其他版本');
    assert.equal(requests.filter(r=>r.action==='download').length,1);

    if (resize) {
      const many = Array.from({length:12},(_,index)=>({...notices[1],id:`overflow-${index}`,title:'很长的项目名称与配置变化说明'.repeat(5),description:'configuration_'.repeat(40)}));
      publish(many); await resize(360,420);
      await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 12`,'长消息加载');
      await waitFor(`(() => { const p=document.querySelector('[data-testid="update-center"]'),r=p.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && p.scrollWidth<=p.clientWidth; })()`,'窄矮窗口完整容纳浮层');
      assert.equal(await evaluate(`(() => { const list=document.querySelector('[data-testid="update-center"] [data-utility-popover-list]'); list.scrollTop=list.scrollHeight; return list.scrollHeight>list.clientHeight && list.scrollTop>0; })()`),true,'列表内部滚动');
      if (capture) await capture('update-overflow');
      publish(notices); await resize(1280,800);
    }
    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'关闭消息中心');
    publish(notices,{kind:'open',target:{type:'software',repositoryId:'fixture-one',kind:'available'}});
    await waitFor(`document.querySelector('#settings-heading')?.textContent === '关于'`,'系统通知仍定位软件更新');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="settings-page"] [data-testid="updates-open"]'))`),false,'设置页移除消息中心');
    publish(notices,{kind:'open',target:{type:'cloud',repositoryId:'removed-repository',kind:'deleted'}});
    await waitFor(`document.querySelector('[data-sonner-toaster]')?.textContent.includes('该云仓库已解除关联')`,'过期通知不切换到其他仓库');
    await jsClick('[data-testid="settings-back"]');
    await waitFor(`!document.querySelector('[data-testid="settings-page"]')`,'回工作台');
    publish([]);
    await waitFor(`!document.querySelector('[data-testid="updates-count"]')`,'完成后角标自动移除');
    await click('[data-testid="updates-open"]');
    await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('暂无消息')`,'消息空状态');
    if (capture) await capture('update-empty');
    await click('[data-testid="updates-close"]');
    await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'关闭空消息');
    publish([],{kind:'notice',title:'演示更新提醒',body:'查看最近变化'});
    await waitFor(`Array.from(document.querySelectorAll('[data-sonner-toast] button')).some(button => button.textContent === '查看')`,'前台提醒');
    await evaluate(`Array.from(document.querySelectorAll('[data-sonner-toast] button')).find(button => button.textContent === '查看').click()`);
    await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('暂无消息')`,'轻提示可打开消息');
  } finally { setSoftwareHandler(null); }
};
