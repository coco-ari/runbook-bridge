const assert = require('node:assert/strict');

module.exports = async function testMetrics({evaluate,click,clickText,until,wait,win,setViewport,snapshot,metricsState,writes,errors}) {
  // 前序工作区场景可能保留窄窗，先用正常窗口调整建立宽窗基线。
  await until("![...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some(element=>element.getClientRects().length&&!element.closest('[hidden],[inert]'))", '前序工作区弹层已关闭');
  await setViewport(1440,920);
  const cpu = "document.querySelector('[data-metric=cpu] strong')?.textContent";
  const memory = "document.querySelector('[data-metric=memory] strong')?.textContent";
  const disk = "document.querySelector('[data-metric=disk] strong')?.textContent";
  const beforeWrites = writes.length;
  const retainedWorkspaceKey=await evaluate("document.querySelector('[data-testid=server-workspace]:not([hidden])')?.dataset.workspaceKey ?? null");
  assert.equal(typeof retainedWorkspaceKey,'string','指标专项绑定当前合成服务器工作区');
  const retainedPluginId=JSON.parse(retainedWorkspaceKey)[2];
  const navigationSnapshots=[];
  const readNavigationDiagnostics=async stage=>({stage,...await evaluate(`(() => {
    const box=element=>{const rect=element?.getBoundingClientRect();return rect?{left:rect.left,right:rect.right,width:rect.width,height:rect.height}:null};
    const visible=element=>Boolean(element?.getClientRects().length&&!element.closest('[hidden],[inert]'));
    const detail=document.querySelector('[data-testid=detail-workspace]'),expand=document.querySelector('[data-testid=detail-expand]');
    let savedLayout=null;
    try{savedLayout=JSON.parse(localStorage.getItem('runbook-bridge:app-shell-layout:v1'))}catch{}
    return {viewport:innerWidth,documentHidden:document.hidden,selectionKind:document.querySelector('#detail-main')?.dataset.selectionKind??null,
      detailTitle:detail?.querySelector('header h1')?.textContent??null,detailCollapsed:detail?.dataset.collapsed??null,
      detailExpand:expand?{visible:visible(expand),disabled:expand.disabled,label:expand.getAttribute('aria-label'),rect:box(expand)}:null,
      projectCollapsed:document.querySelector('[data-testid=project-rail]')?.dataset.collapsed??null,
      panels:['project-panel','resource-panel','detail-panel'].map(id=>({id,...box(document.getElementById(id))})),
      layout:savedLayout?{projectCollapsed:savedLayout.projectCollapsed,detailCollapsed:savedLayout.detailCollapsed,layout:savedLayout.layout}:null,
      selectedProject:document.querySelector('[data-project-id][aria-current=page]')?.dataset.projectId??null,
      selectedEnvironment:document.querySelector('[data-testid^=environment-trigger-][aria-current=page]')?.dataset.testid??null,
      selectedPlugin:document.querySelector('[data-testid^=plugin-trigger-][aria-current=page]')?.dataset.testid??null,
      tab:detail?.querySelector('[role=tab][aria-selected=true]')?.dataset.testid??null,
      entries:[...document.querySelectorAll('[data-testid=plugin-open-workspace]')].map(entry=>({visible:visible(entry),disabled:entry.disabled,
        label:entry.textContent?.trim(),hint:entry.getAttribute('aria-description')||entry.title,rect:box(entry),className:entry.className})),
      connectionPhase:document.querySelector('[data-testid=plugin-status-console]')?.dataset.status??null,
      connectionAction:document.querySelector('[data-testid=plugin-connection-primary]')?.textContent?.trim()??null,
      retainedWorkspaces:[...document.querySelectorAll('[data-testid=server-workspace]')].map(workspace=>({key:workspace.dataset.workspaceKey,hidden:workspace.hidden,visible:visible(workspace)})),
      modalScopes:[...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu]')].filter(visible).map(element=>({role:element.getAttribute('role'),id:element.id,testId:element.dataset.testid}))};
  })()`)});
  const layoutPreferenceBefore=await evaluate("localStorage.getItem('runbook-bridge:app-shell-layout:v1')");
  let navigationBefore=await readNavigationDiagnostics('metrics-layout-baseline');
  const initialNavigationBaseline=navigationBefore;
  if(layoutPreferenceBefore===null){
    try{
      await until(`(() => {
        const width=id=>document.getElementById(id)?.getBoundingClientRect().width;
        return Math.abs(width('project-panel')-224)<2&&Math.abs(width('resource-panel')-320)<2;
      })()`,'无保存布局的224/320px导航完成恢复');
    }catch(error){
      const current=await readNavigationDiagnostics('metrics-layout-baseline-failed');
      process.stderr.write('指标默认导航基线诊断：'+JSON.stringify({initialNavigationBaseline,current})+'\n');
      throw error;
    }
    navigationBefore=await readNavigationDiagnostics('metrics-layout-baseline-settled');
    for(const [id,expected] of [['project-panel',224],['resource-panel',320]]){
      const actual=navigationBefore.panels.find(panel=>panel.id===id).width;
      assert.ok(Math.abs(actual-expected)<2,'无保存布局保留默认导航像素宽度：'+JSON.stringify({id,expected,actual,navigationBefore}));
    }
  }
  assert.equal(navigationBefore.detailCollapsed,'false','指标缩放验收从用户展开的详情偏好开始：'+JSON.stringify(navigationBefore));
  process.stdout.write('指标导航基线：'+JSON.stringify({initialNavigationBaseline,navigationBefore,hasSavedLayout:layoutPreferenceBefore!==null})+'\n');
  const assertViewportPreferences=async(stage,restoreNavigation=false)=>{
    const current=await readNavigationDiagnostics(stage);
    const saved=await evaluate("localStorage.getItem('runbook-bridge:app-shell-layout:v1')");
    assert.equal(saved,layoutPreferenceBefore,'非用户窗口缩放原样保留保存记录：'+JSON.stringify(current));
    if(current.viewport>=960){
      assert.equal(current.detailCollapsed,'false','宽窗恢复用户展开的详情显示：'+JSON.stringify(current));
      assert.ok(current.panels.find(panel=>panel.id==='detail-panel').width>=359.5,'恢复后的详情满足可展开宽度');
    }
    if(restoreNavigation){
      for(const id of ['project-panel','resource-panel']){
        const before=navigationBefore.panels.find(panel=>panel.id===id).width;
        const restored=current.panels.find(panel=>panel.id===id).width;
        assert.ok(Math.abs(restored-before)<2,'窄窗往返恢复用户导航像素宽度：'+JSON.stringify({id,before,restored,current}));
      }
    }
    return current;
  };
  const continueRetainedWorkspace=async stage=>{
    try{
      await until(`(() => {
        const detail=document.querySelector('[data-testid=detail-workspace]');
        const entry=document.querySelector('#detail-main [data-testid=plugin-open-workspace]');
        const selected=document.querySelector('[data-testid^=plugin-trigger-][aria-current=page]');
        return detail?.dataset.collapsed==='false'&&document.querySelector('#detail-main')?.dataset.selectionKind==='plugin'
          &&selected?.dataset.testid===${JSON.stringify('plugin-trigger-'+retainedPluginId)}
          &&entry&&!entry.disabled&&entry.getClientRects().length>0&&!entry.closest('[hidden],[inert]');
      })()`,stage+'：当前插件详情和保留工作区入口可见可用');
      await click('[data-testid=plugin-open-workspace]');
      await until(`document.querySelector('[data-testid=server-workspace]:not([hidden])')?.dataset.workspaceKey===${JSON.stringify(retainedWorkspaceKey)}`,
        stage+'：只恢复同一个服务器工作区');
    }catch(error){
      // 失败时只记录合成夹具的导航和控件状态，不记录终端输出、配置或凭据。
      navigationSnapshots.push(await readNavigationDiagnostics(stage+'-failed'));
      process.stderr.write('指标工作区恢复诊断：'+JSON.stringify({stage,expectedWorkspaceKey:retainedWorkspaceKey,navigationSnapshots})+'\n');
      throw error;
    }
  };
  await until(cpu + " === '18%'", '首次双采样后显示真实 CPU 数值');
  assert.equal(await evaluate(memory),'43%');
  assert.equal(await evaluate(disk),'62%');

  await click('[data-testid=server-workspace-back]');
  metricsState.diskDelay=3000;
  const firstStarted=Date.now();
  await continueRetainedWorkspace('首次返回详情后继续');
  await until(memory + " === '43%' && " + cpu + " === '--' && " + disk + " === '--'", '内存先显示，CPU 与磁盘分别等待采样');
  await until(cpu + " === '18%'", '首次 CPU 一秒补采');
  const firstCpuMs=Date.now()-firstStarted;
  assert.ok(firstCpuMs<2500,'首次 CPU 不再等待五秒或磁盘：'+firstCpuMs+' ms');
  assert.equal(await evaluate(disk),'--','CPU 已显示时慢磁盘仍在读取');
  await until(disk + " === '62%'", '磁盘独立完成');
  assert.equal(await evaluate(cpu),'18%','迟到磁盘响应不覆盖已显示的 CPU');
  metricsState.diskDelay=0;
  process.stdout.write(JSON.stringify({firstCpuMs,simulatedDiskMs:3000})+'\n');


  for (const theme of ['light','dark']) {
    await evaluate("localStorage.setItem('runbook-bridge:theme-preference:v1'," + JSON.stringify(theme) + "); window.dispatchEvent(new StorageEvent('storage',{key:'runbook-bridge:theme-preference:v1'}))");
    for (const width of [1440,1301,1300,1151,1150,960,900,800]) {
      await setViewport(width,820);
      await until("getComputedStyle(document.querySelector('.server-workspace-header')).minHeight === '56px'", '窗口重绘后恢复常规页头高度');
      const geometry = await evaluate(`(() => {
        const header=document.querySelector('.server-workspace-header'),metrics=header.querySelector('.server-metrics');
        const rect=metrics.getBoundingClientRect(),action=metrics.nextElementSibling.getBoundingClientRect();
        const heading=header.querySelector('.server-workspace-heading'),title=heading.getBoundingClientRect();
        const name=heading.querySelector('h1'),nameBox=name.getBoundingClientRect(),range=document.createRange();
        range.selectNodeContents(name);
        const nameText=range.getBoundingClientRect();
        const visibleName={left:Math.max(nameBox.left,nameText.left),right:Math.min(nameBox.right,nameText.right)};
        const identityBadges=[...heading.querySelectorAll('[data-slot=badge]')].map(badge=>{
          const box=badge.getBoundingClientRect();
          return {left:box.left,right:box.right,label:badge.getAttribute('aria-label')||badge.title};
        });
        const environmentBadge=heading.querySelector('[data-environment-type]');
        let environmentIdentity=null;
        if(environmentBadge){
          const box=environmentBadge.getBoundingClientRect(),text=document.createRange();text.selectNodeContents(environmentBadge);
          const glyph=text.getBoundingClientRect();
          environmentIdentity={left:box.left,right:box.right,glyphLeft:glyph.left,glyphRight:glyph.right,label:environmentBadge.getAttribute('aria-label'),title:environmentBadge.title};
        }
        const buttons=[...header.children].filter(el=>el.tagName==='BUTTON').map(button=>{
          const box=button.getBoundingClientRect();
          return {id:button.dataset.testid,left:box.left,right:box.right,width:box.width,height:box.height,
            label:button.getAttribute('aria-label'),title:button.title,hint:button.getAttribute('aria-description')||button.title,disabled:button.disabled,
            hit:button.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2))};
        });
        const values=[...metrics.querySelectorAll('strong')].map(el=>{
          const cell=el.closest('.server-metric'),a=el.getBoundingClientRect(),b=cell.getBoundingClientRect();
          const label=el.previousElementSibling.getBoundingClientRect(),style=getComputedStyle(cell);
          return {kind:cell.dataset.metric,left:a.left,right:a.right,width:a.width,cellLeft:b.left,cellRight:b.right,cellWidth:b.width,
            labelLeft:label.left,labelRight:label.right,labelWidth:label.width,flexShrink:style.flexShrink,minWidth:style.minWidth,
            sameLine:a.top<label.bottom&&label.top<a.bottom};
        });
        const details=[...metrics.querySelectorAll('.server-metric-detail')].map(el=>getComputedStyle(el).display!=='none');
        const children=[...header.children].map(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return {tag:el.tagName,
          width:box.width,left:box.left,right:box.right,flexShrink:style.flexShrink,minWidth:style.minWidth};});
        return {width:innerWidth,headerHeight:header.getBoundingClientRect().height,left:rect.left,right:rect.right,titleRight:title.right,
          headingWidth:title.width,titleTextWidth:nameBox.width,titleGlyphWidth:Math.max(0,visibleName.right-visibleName.left),
          titleLeft:nameBox.left,titleTextRight:nameBox.right,titleFullHint:name.title===name.textContent,visibleName,identityBadges,environmentIdentity,
          actionLeft:action.left,buttons,values,details,children,bars:metrics.querySelectorAll('.server-metric-meter,[role=progressbar],progress,meter').length,overflow:header.scrollWidth>header.clientWidth};
      })()`);
      assert.ok(!geometry.overflow, '状态条不撑破页头：'+theme+' '+width);
      assert.ok(geometry.left >= geometry.titleRight, '不覆盖服务器身份');
      assert.ok(geometry.right <= geometry.actionLeft, '不覆盖配置与连接操作');
      assert.equal(geometry.headerHeight, 56, '工作区页头保持统一的 56px 高度');
      assert.ok(geometry.titleTextWidth>=64&&geometry.titleGlyphWidth>0&&geometry.titleFullHint,
        '服务器名称保留可读文本和完整提示：'+JSON.stringify({theme,requestedWidth:width,...geometry}));
      assert.ok(geometry.visibleName.right<=geometry.left&&geometry.identityBadges.every(badge=>geometry.titleTextRight<=badge.left&&badge.right<=geometry.left),
        '名称不侵入环境或连接徽标、指标：'+JSON.stringify({theme,requestedWidth:width,...geometry}));
      assert.ok(geometry.environmentIdentity&&geometry.environmentIdentity.glyphLeft>=geometry.environmentIdentity.left&&geometry.environmentIdentity.glyphRight<=geometry.environmentIdentity.right&&geometry.environmentIdentity.label===geometry.environmentIdentity.title,
        '生产或测试环境身份文字完整保留');
      assert.ok(geometry.buttons.length>=6&&geometry.buttons.every(button=>button.label&&button.width>=28&&button.height>=28&&button.left>=0&&button.right<=geometry.width&&(button.disabled||button.hit)),
        '全部头部操作具有名称且仍可命中：'+JSON.stringify(geometry.buttons));
      const compactButtons=geometry.buttons.filter(button=>['server-workspace-back','workspace-switcher','settings-open'].includes(button.id));
      assert.equal(compactButtons.length,3,'紧凑入口仍保留返回、工作区和应用设置');
      assert.ok(compactButtons.every(button=>button.hint&&(width>1300||button.width===32&&button.height===32)),
        '1300px边界内使用带完整提示的32px导航与设置入口：'+JSON.stringify({theme,requestedWidth:width,width:geometry.width,compactButtons}));
      const switcher=compactButtons.find(button=>button.id==='workspace-switcher');
      assert.match(switcher.hint,/\d+\s*项/u,'完整提示保留工作区数量');
      assert.equal(switcher.hint.match(/\d+\s*项/u)?.[0],switcher.label.match(/\d+\s*项/u)?.[0],'工作区数量保留在提示和可访问名称中');
      const percentagesFit=geometry.values.every(item=>item.left>=item.cellLeft&&item.right<=item.cellRight);
      if(!percentagesFit)await snapshot('server-metrics-failed-'+theme+'-'+width+'.png');
      assert.ok(percentagesFit, '百分比完整显示：'+JSON.stringify({theme,requestedWidth:width,...geometry}));
      assert.equal(geometry.bars, 0, '纯文本状态行不显示进度条');
      assert.ok(geometry.values.every(item=>item.sameLine), '标签和百分比处于同一行');
      assert.ok(geometry.details.every(visible=>visible===(width>1150)), '容量在宽窗口显示，在窄窗口收起');
      await snapshot('server-metrics-'+theme+'-'+width+'.png');
      await assertViewportPreferences('metrics-width-'+width+'-'+theme);
      if(width===800)navigationSnapshots.push(await readNavigationDiagnostics('metrics-width-800-'+theme));
    }
  }
  await setViewport(1440,920);
  await click('[data-metric=disk]');
  await until("document.querySelector('[aria-label=服务器磁盘用量]')", '点开服务器磁盘列表');
  await evaluate("[...document.querySelectorAll('.server-metrics-disk-list button')].find(button=>button.textContent.includes('/data with space')).click()");
  await until(disk + " === '92%'", '切换本地挂载点');
  assert.equal(await evaluate("document.querySelector('[data-metric=disk]').dataset.tone"),'danger');
  assert.ok(await evaluate("document.querySelector('[data-metric=disk]').getAttribute('aria-label').includes('/data with space')"));
  await setViewport(800,820);
  assert.ok(await evaluate("(() => { const header=document.querySelector('.server-workspace-header'),value=document.querySelector('[data-metric=disk] strong'),cell=value.closest('.server-metric'),a=value.getBoundingClientRect(),b=cell.getBoundingClientRect(); return header.scrollWidth<=header.clientWidth&&a.left>=b.left&&a.right<=b.right })()"), '长挂载路径在窄窗口不挤压百分比');
  await snapshot('server-metrics-dark-long-mount-800.png');
  await setViewport(1440,920);
  await click('[data-metric=disk]');
  await evaluate("document.querySelector('.server-metrics-disk-list button').click()");

  await until("!document.querySelector('[aria-label=服务器磁盘用量]')", '关闭磁盘弹层');
  await wait(180);
  win.webContents.focus();
  await wait(100);
  await evaluate("document.querySelector('[data-metric=cpu]').focus()");
  await wait(200);
  await until("[...document.querySelectorAll('[role=tooltip]')].some(item=>item.textContent.includes('最近两次采样'))", '键盘聚焦可查看 CPU 说明');
  await evaluate("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-helper-textarea').focus()");

  const readsBefore = metricsState.reads;
  await click('[aria-label=新增终端]');
  await wait(550);
  assert.ok(metricsState.reads <= readsBefore+2, '新增终端标签不新建采样循环');
  const activeClose = await evaluate("document.querySelector('.server-terminal-tabs [role=tab][aria-selected=true]').parentElement.querySelector('button[aria-label^=关闭]').getAttribute('aria-label')");
  await click('[aria-label='+JSON.stringify(activeClose)+']');

  metricsState.mode='failure';
  await until(cpu + " === '旧 18%'", '失败保留最后值并明确标记过期');
  assert.equal(await evaluate("document.querySelector('[data-metric=cpu]').dataset.tone"),'muted');
  assert.equal(await evaluate("document.querySelector('[data-metric=disk]').dataset.tone"),'normal','系统采样失败不影响磁盘状态');
  await setViewport(800,820);
  const staleLayout = await evaluate("(() => { const header=document.querySelector('.server-workspace-header'); return { viewport:innerWidth, width:header.clientWidth, scroll:header.scrollWidth, values:[...header.querySelectorAll('.server-metric strong')].map(value=>{const a=value.getBoundingClientRect(),b=value.closest('.server-metric').getBoundingClientRect();return {text:value.textContent,left:a.left,right:a.right,cellLeft:b.left,cellRight:b.right}})} })()");
  assert.ok(staleLayout.scroll <= staleLayout.width && staleLayout.values.every(value => value.left >= value.cellLeft && value.right <= value.cellRight), '过期前缀在窄窗口完整显示：' + JSON.stringify(staleLayout));
  await setViewport(1440,920);
  navigationSnapshots.push(await assertViewportPreferences('stale-width-restored-1440',true));
  metricsState.mode='normal';
  await until(cpu + " === '18%'", '恢复后更新指标');

  metricsState.delay=6000;
  await until("true",'开始慢请求测试');
  const deadline=Date.now()+6500;
  while(!metricsState.byKind.system && Date.now()<deadline) await wait(30);
  assert.equal(metricsState.byKind.system,1,'慢系统请求已经开始');
  await wait(5100);
  assert.deepEqual(metricsState.maxByKind,{system:1,disks:1},'每类指标慢响应都不叠加采样请求');
  metricsState.delay=0;
  while(metricsState.inFlight) await wait(30);

  const pausedReads=metricsState.reads, pausedStops=metricsState.stops;
  await evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))");
  await until("document.querySelector('[data-testid=server-metrics]').dataset.paused === 'true'", '最小化可见性变化后暂停');
  await wait(5300);
  assert.equal(metricsState.reads,pausedReads,'暂停期间不发起采样');
  assert.ok(metricsState.stops>pausedStops,'暂停取消服务器采样');
  await evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))");
  await until(cpu + " === '--'", '恢复后先重新采样');
  await until(cpu + " === '18%'", '恢复双采样后显示使用率');
  await evaluate("delete document.hidden");

  await click('[data-testid=server-workspace-back]');
  navigationSnapshots.push(await assertViewportPreferences('second-back-detail',true));
  const hiddenReads=metricsState.reads;
  await wait(5300);
  assert.equal(metricsState.reads,hiddenReads,'返回详情后停止采样');
  await continueRetainedWorkspace('暂停验证后从详情继续');
  await until(cpu + " === '18%'", '返回工作区恢复采样');

  await click('[data-testid=server-workspace-disconnect]');
  await until("document.querySelector('[data-testid=server-metrics]').dataset.paused === 'true'", '断线暂停监控');
  const disconnectedReads=metricsState.reads;
  await wait(1200);
  assert.equal(metricsState.reads,disconnectedReads);
  await click('[data-testid=server-workspace-reconnect]');
  await until(cpu + " === '18%'", '重新连接恢复监控');
  assert.equal(writes.length,beforeWrites,'资源采集不向人工终端发送输入');
  assert.deepEqual(errors,[],'监控界面无渲染错误');
};
