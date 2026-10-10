const assert = require('node:assert/strict');

module.exports = async function exerciseUpdateCenter({evaluate,waitFor,pressKey,publish,capture}) {
  const notices = [
    {id:'a'.repeat(64),type:'software',kind:'available',repositoryId:'fixture-one',repositoryName:'演示云仓库',title:'发现新版本 99.0.0',description:'查看版本说明，选择何时下载和安装。',unread:true},
    {id:'b'.repeat(64),type:'cloud',kind:'conflict',repositoryId:'fixture-one',repositoryName:'演示云仓库',projectId:'project-operations',title:'合成项目：环境配置有变化',description:'本地与云端都有修改，请查看差异后处理。',unread:true},
  ];
  publish(notices);
  await waitFor(`document.querySelector('[data-testid="updates-count"]')?.textContent === '2'`,'更新角标显示两项');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelectorAll('[data-testid="update-notice"]').length === 2`,'更新列表加载');
  const geometry = await evaluate(`(() => { const panel=document.querySelector('[data-testid="update-center"]'); return {overflow:panel.scrollWidth>panel.clientWidth,focused:panel.contains(document.activeElement)}; })()`);
  assert.deepEqual(geometry,{overflow:false,focused:true});
  if (capture) await capture();
  await evaluate(`document.querySelector('[data-testid="updates-read-all"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('0 项未读')`,'已读状态保存');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="update-notice"]').length`),2);
  await pressKey('Escape');
  await waitFor(`!document.querySelector('[data-testid="update-center"]')`,'关闭更新面板');
  await evaluate(`document.querySelector('[data-testid="updates-open"]').click()`);
  await waitFor(`document.querySelector('[data-testid="update-center"]')?.textContent.includes('0 项未读')`,'再次打开保留已读和待处理项');
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
