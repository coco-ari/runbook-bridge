const assert = require('node:assert/strict');

module.exports = async function exerciseUpdateCenter({evaluate,waitFor,pressKey,publish,capture,resize,click}) {
  const localProjectId = await evaluate(`document.querySelector('[data-project-id][aria-current="page"]')?.dataset.projectId ?? document.querySelector('button[data-project-id]')?.dataset.projectId`);
  assert.ok(localProjectId);
  await evaluate(`document.querySelector('button[data-project-id="'+${JSON.stringify(localProjectId)}+'"]').click()`);
  const notices = [
    {id:'a'.repeat(64),type:'software',kind:'available',repositoryId:'fixture-one',repositoryName:'演示云仓库',title:'新版本 99.0.0 可用',description:'查看版本说明，选择何时下载和安装。',unread:true,firstSeenAt:Date.now()-600_000},
    {id:'b'.repeat(64),type:'cloud',kind:'conflict',repositoryId:'fixture-one',repositoryName:'团队仓库',projectId:'cloud-project-demo',localProjectId,title:'运维平台配置有更新',description:'本地与云端都有修改，请查看差异后处理。',unread:true,firstSeenAt:Date.now()-300_000},
  ];
  publish(notices);
  await waitFor(`document.querySelector('[data-testid="updates-count"]')?.textContent === '2'`,'更新角标显示未读两项');
  await waitFor(`Boolean(document.querySelector('[data-testid="project-update-indicator"]')) && Boolean(document.querySelector('[data-testid="project-update-banner"]')) && Boolean(document.querySelector('[data-testid="software-update-hint"]'))`,'项目内提示与软件轻提示');
  if (capture) await capture('update-workspace');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').focus(); document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 2`,'更新列表加载');
  const geometry = await evaluate(`(() => { const panel=document.querySelector('[data-testid="update-center"]'),rect=panel.getBoundingClientRect(); return {overflow:panel.scrollWidth>panel.clientWidth,focused:panel.contains(document.activeElement),right:Math.abs(rect.right-innerWidth)<2,width:rect.width,overlay:Boolean(document.querySelector('[data-slot="sheet-overlay"]'))}; })()`);
  assert.equal(geometry.overflow,false); assert.equal(geometry.focused,true); assert.equal(geometry.right,true); assert.equal(geometry.overlay,false); assert.ok(geometry.width<=421);
  if (capture) await capture('update-center');
  await click('input[placeholder="搜索项目"]');
  await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'切回工作台关闭面板');
  assert.equal(await evaluate(`document.activeElement?.getAttribute('placeholder')`),'搜索项目','关闭侧栏不抢走工作台输入焦点');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').focus(); document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 2`,'重新打开更新列表');
  await evaluate(`document.querySelector('[data-testid="update-snooze"]').focus()`);
  await pressKey('Enter');
  await waitFor(`Boolean(document.querySelector('[data-testid="update-snooze-hour"]'))`,'稍后提醒菜单');
  await evaluate(`document.querySelector('[data-testid="update-snooze-hour"]').click()`);
  await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 1 && document.querySelector('[data-testid="updates-count"]')?.textContent === '1'`,'延后从待处理和未读中移出');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="software-update-hint"]'))`),false);
  await evaluate(`document.querySelector('[data-testid="updates-later"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-notice"]')?.textContent.includes('提醒') && Boolean(document.querySelector('[data-testid="update-resume"]'))`,'稍后列表显示时间与恢复入口');
  if (capture) await capture('update-later');
  await pressKey('Escape');
  await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'关闭更新面板');
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`),'updates-open');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-testid="update-resume"]'))`,'再次打开保留延后状态');
  await evaluate(`document.querySelector('[data-testid="update-resume"]').click()`);
  await waitFor(`document.querySelector('[data-testid="updates-count"]')?.textContent === '2'`,'恢复待处理和未读状态');
  await evaluate(`document.querySelector('[data-testid="updates-pending"]').click()`);
  await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 2`,'恢复后在待处理列表可见');
  await evaluate(`const mode=document.querySelector('[data-testid="update-notification-mode"]'); mode.value='app'; mode.dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`document.querySelector('[data-testid="update-notification-mode"]')?.value === 'app' && !document.querySelector('[data-testid="update-notification-mode"]').disabled`,'提醒偏好保存');
  await evaluate(`document.querySelector('[data-testid="updates-read-all"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('0 项未读') && !document.querySelector('[data-testid="updates-count"]')`,'已读清除角标');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="update-notice"]').length`),2);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="project-update-indicator"]'))`),true,'已读不隐藏冲突状态');
  if (resize) {
    await resize(640,640);
    await waitFor(`document.querySelector('[data-testid="update-center"]').getBoundingClientRect().right <= innerWidth+1`,'窄窗口面板布局');
    assert.equal(await evaluate(`(() => { const p=document.querySelector('[data-testid="update-center"]'); return p.scrollWidth>p.clientWidth || p.getBoundingClientRect().height>innerHeight+1; })()`),false);
    if (capture) await capture('update-narrow');
    await resize(1280,800);
  }
  await pressKey('Escape');
  await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'关闭后回到工作台');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('0 项未读')`,'再次打开保留已读和待处理项');
  assert.equal(await evaluate(`document.querySelector('[data-testid="update-notification-mode"]').value`),'app');
  await evaluate(`document.querySelector('[data-testid="update-notice-view"]').click()`);
  await waitFor(`document.querySelector('[data-testid="software-update-panel"]') !== null`,'版本提醒定位到软件更新');
  await evaluate(`document.querySelector('[data-testid="settings-appearance"]').click()`);
  await waitFor(`document.querySelector('#settings-heading')?.textContent === '外观主题'`,'手动切换设置仍正常');
  publish(notices,{kind:'open',target:{type:'software',repositoryId:'fixture-one',kind:'available'}});
  await waitFor(`document.querySelector('#settings-heading')?.textContent === '关于'`,'系统通知定位软件更新');
  publish(notices,{kind:'open',target:{type:'cloud',repositoryId:'removed-repository',kind:'deleted'}});
  await waitFor(`document.querySelector('[data-sonner-toaster]')?.textContent.includes('该云仓库已解除关联')`,'过期通知不切换到其他仓库');
  assert.equal(await evaluate(`document.querySelector('#settings-heading')?.textContent`),'关于');
  publish([]);
  await waitFor(`!document.querySelector('[data-testid="updates-count"]')`,'处理后移除角标');
  await evaluate(`document.querySelector('[data-testid="settings-page"] [data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('暂无待处理更新')`,'空状态可读');
};
