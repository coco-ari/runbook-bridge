const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {app,nativeTheme} = require('electron');
const harness = require('./ui-react-plugin-operations-smoke.cjs');
const {state,PROJECT_ID,ENVIRONMENT_ID,SERVER_ID,click,clickText,waitFor,setExactViewport,captureFreshFrame,calls} = harness;
const baseline = process.argv.includes('--baseline');
const screenshotRoot = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR;
const secondId = 'plugin-dependent-smoke';
state.projectName = '海岬电商生产运维与跨区域灾备演练工作台（完整项目名称核对）';
state.environmentName = '生产环境 · 华东集群与共享服务（完整环境名称核对）';
state.plugins[0].displayName = '应用服务器（华东共享服务与跨区域消费端长名称核对）';
state.plugins[0].auth.type = 'password';
state.credentialStatus = {saved:true,fields:{primary:true,proxy:false},legacyAvailable:false};

async function scenario(win) {
  const evaluate = source => win.webContents.executeJavaScript(source,true);
  const until = (source,label) => waitFor(win,source,label);
  const key = async keyCode => {
    win.webContents.sendInputEvent({type:'keyDown',keyCode});
    if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode});
  };
  const capture = async name => {
    if (!screenshotRoot) return;
    fs.mkdirSync(screenshotRoot,{recursive:true});
    fs.writeFileSync(path.join(screenshotRoot,name+'.png'),(await captureFreshFrame(win)).toPNG());
  };
  const assertIdentity = async () => {
    if (baseline) return;
    await harness.ensureNativeKeyboardFocus(win);
    await evaluate(`document.querySelector('[data-testid="scope-identity-trigger"]').focus()`);
    await until(`document.activeElement===document.querySelector('[data-testid="scope-identity-trigger"]')`,'完整身份入口获得焦点');
    await harness.wait(80);
    assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-testid="scope-identity-trigger"]')`),true,'键盘激活前焦点稳定');
    await key('Enter');
    await until(`document.querySelector('[data-testid="scope-identity-content"]')?.getClientRects().length>0`,'键盘展开完整对象身份');
    const identity = await evaluate(`(() => {const e=document.querySelector('[data-testid="scope-identity-content"]'); const r=e.getBoundingClientRect();return {text:e.textContent,overflow:e.scrollWidth>e.clientWidth+1,inside:r.x>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}})()`);
    for (const name of [state.projectName,state.environmentName,state.plugins[0].displayName]) assert.ok(identity.text.includes(name),'完整名称必须出现在可见身份面板中');
    assert.equal(identity.overflow,false);
    assert.equal(identity.inside,true);
    await capture('identity-'+nativeTheme.themeSource);
    await key('Escape');
    await until(`!document.querySelector('[data-testid="scope-identity-content"]')`,'Escape 关闭身份面板');
    await until(`document.activeElement===document.querySelector('[data-testid="scope-identity-trigger"]')`,'身份面板关闭后返回入口焦点');
  };
  const selectPlugin = async () => {
    if (!await evaluate(`document.querySelector('[data-testid="plugin-trigger-${SERVER_ID}"]')?.getClientRects().length>0`)) {
      await click(win,`[data-testid="environment-expand-${ENVIRONMENT_ID}"]`,'展开环境');
    }
    await click(win,`[data-testid="plugin-trigger-${SERVER_ID}"]`,'选择模拟插件');
    await until(`document.querySelector('[data-testid="plugin-action-edit"]')?.disabled===false`,'插件详情可编辑');
  };
  const openEditor = async () => {
    await click(win,'[data-testid="plugin-action-edit"]','修改配置');
    await until(`document.querySelector('[data-testid="plugin-editor-workspace"]')!==null`,'进入编辑');
    if (state.preEditConnectedSet?.length) {
      await until(`document.querySelector('[data-testid="plugin-editor-confirmation"]')!==null`,'保留连接影响确认');
      await clickText(win,'继续编辑','[data-testid="plugin-editor-confirmation"]');
    }
    await until(`!document.querySelector('[data-testid="plugin-editor-loading"]')&&!document.querySelector('[data-testid="plugin-editor-confirmation"]')`,'编辑会话就绪');
  };
  await selectPlugin();
  for (const theme of ['light','dark']) {
    nativeTheme.themeSource = theme;
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`,'切换主题');
    for (const [width,height] of [[960,640],[1280,820],[1600,1000]]) {
      await setExactViewport(win,width,height);
      await capture(`detail-${theme}-${width}x${height}`);
      await assertIdentity();
      await openEditor();
      await capture(`editor-${theme}-${width}x${height}`);
      await assertIdentity();
      if (!baseline) {
        assert.equal(await evaluate(`document.querySelector('[data-testid="stored-credential-view-password"]').textContent.trim()`),'查看已保存');
        assert.equal(await evaluate(`document.querySelector('#plugin-primary-credential').type`),'password');
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false);
        assert.equal(await evaluate(`(() => {const r=document.querySelector('[data-testid="plugin-save"]').getBoundingClientRect(); return r.bottom<=innerHeight&&r.right<=innerWidth})()`),true,'保存按钮始终可达');
      }
      await click(win,'[data-testid="plugin-editor-cancel"]','取消无更改编辑');
      await until(`!document.querySelector('[data-testid="plugin-editor-workspace"]')`,'返回详情');
    }
  }
  if (baseline) return;
  await setExactViewport(win,960,640);
  for (const zoom of [1.25,1.5]) {
    win.webContents.setZoomFactor(zoom);
    await captureFreshFrame(win);
    await assertIdentity();
  }
  win.webContents.setZoomFactor(1);
  await captureFreshFrame(win);

  const snapshot = phases => ({
    ...state.runtime,sequence:state.runtime.sequence+1,
    plugins:Object.fromEntries(Object.entries(phases).map(([id,phase])=>[id,{pluginInstanceId:id,phase,assessment:{phase,primaryStatus:{kind:phase,label:phase}}}])),
  });
  const noticeState = expected => until(`document.querySelector('[data-testid="plugin-save-recovery-notice"]')?.dataset.recoveryState===${JSON.stringify(expected)}`,`保存恢复状态：${expected}`);
  for (const item of [
    {name:'not-needed',ids:[],phases:{[SERVER_ID]:'disconnected'},outcome:null},
    {name:'recovering',ids:[SERVER_ID],phases:{[SERVER_ID]:'connecting'},outcome:'started'},
    {name:'partial',ids:[SERVER_ID,secondId],phases:{[SERVER_ID]:'connected',[secondId]:'error'},outcome:'needs-action'},
    {name:'not-restored',ids:[SERVER_ID],phases:{[SERVER_ID]:'disconnected'},outcome:'cancelled'},
    {name:'unknown',ids:[SERVER_ID],phases:{},outcome:'started'},
    {name:'restored',ids:[SERVER_ID],phases:{[SERVER_ID]:'connected'},outcome:'started'},
  ]) {
    state.preEditConnectedSet = item.ids;
    await openEditor();
    const resultSnapshot = snapshot(item.phases);
    state.runtime = resultSnapshot;
    state.nextSaveResult = {connectionPlan:item.outcome===null?null:{outcome:item.outcome,actions:item.outcome==='needs-action'?[{code:'CONNECT_FAILED'}]:[],snapshot:resultSnapshot}};
    state.deferNextEditSave = true;
    const count = calls('v2:plugin-connection-edit-save').length;
    await click(win,'[data-testid="plugin-save"]','保存并恢复原连接');
    await harness.waitUntil(()=>state.pendingEditSave!==null,'暂缓模拟保存结果');
    assert.equal(await evaluate(`document.querySelector('[data-testid="plugin-save"]').disabled`),true);
    assert.equal(await evaluate(`document.querySelector('[data-testid="plugin-editor-save-progress"]').textContent.includes('等待结果')`),true,'返回结果前不能声明配置已保存');
    const pending = state.pendingEditSave;
    state.pendingEditSave = null;
    pending.resolve();
    await until(`!document.querySelector('[data-testid="plugin-editor-workspace"]')`,'保存返回详情');
    assert.equal(calls('v2:plugin-connection-edit-save').length,count+1);
    assert.equal(calls('v2:plugin-connection-edit-save').at(-1).payload.afterCommit,'restore-pre-edit-set');
    await noticeState(item.name);
    await until(`!document.querySelector('[data-sonner-toast]')`,'短暂通知消失后持久结果仍存在');
    await noticeState(item.name);
    await capture(`save-${item.name}`);
    if (item.name==='recovering') {
      state.runtime = snapshot({[SERVER_ID]:'connected'});
      win.webContents.send('v2:environment-status-changed',structuredClone(state.runtime));
      await noticeState('restored');
      await click(win,`[data-project-id="${harness.NAVIGATION_PROJECT_ID ?? 'project-plugin-navigation-smoke'}"]`,'切换项目');
      await until(`!document.querySelector('[data-testid="plugin-save-recovery-notice"]')`,'其他项目不显示此保存结果');
      await click(win,`[data-project-id="${PROJECT_ID}"]`,'返回原项目');
      await selectPlugin();
      await noticeState('restored');
    }
  }
  assert.equal(calls('v2:connection-intent').length,0,'状态展示不触发额外连接');
  assert.equal(harness.externalRequests.length,0);
  process.stdout.write('插件身份与保存反馈专项通过：深浅主题、三种尺寸、键盘身份核对、模拟缩放、保存与六类恢复结果、范围隔离。\n');
}

harness.runScenario(scenario).then(()=>app.exit(0)).catch(error=>{process.stderr.write(`${error.stack ?? error}\n`);app.exit(1);});
