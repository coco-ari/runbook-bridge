const assert = require('node:assert/strict');

module.exports = async function testMetrics({evaluate,click,clickText,until,wait,win,setViewport,snapshot,metricsState,writes,errors}) {
  const cpu = "document.querySelector('[data-metric=cpu] strong')?.textContent";
  const memory = "document.querySelector('[data-metric=memory] strong')?.textContent";
  const disk = "document.querySelector('[data-metric=disk] strong')?.textContent";
  const beforeWrites = writes.length;
  await until(cpu + " === '18%'", '首次双采样后显示真实 CPU 数值');
  assert.equal(await evaluate(memory),'43%');
  assert.equal(await evaluate(disk),'62%');

  await click('[data-testid=server-workspace-back]');
  metricsState.diskDelay=3000;
  const firstStarted=Date.now();
  await click('[data-testid=plugin-open-workspace]');
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
    for (const width of [1440,960,800]) {
      await setViewport(width,820);
      const geometry = await evaluate("(() => { const header=document.querySelector('.server-workspace-header'); const metrics=header.querySelector('.server-metrics'); const rect=metrics.getBoundingClientRect(); const action=header.querySelector('[data-testid=settings-open]').getBoundingClientRect(); const title=header.querySelector('.server-workspace-heading').getBoundingClientRect(); const values=[...metrics.querySelectorAll('strong')].map(el=>{const a=el.getBoundingClientRect(),b=el.closest('.server-metric').getBoundingClientRect(),label=el.previousElementSibling.getBoundingClientRect();return{left:a.left,right:a.right,cellLeft:b.left,cellRight:b.right,sameLine:a.top<label.bottom&&label.top<a.bottom};}); const details=[...metrics.querySelectorAll('.server-metric-detail')].map(el=>getComputedStyle(el).display!=='none'); return {width:innerWidth,headerHeight:header.getBoundingClientRect().height,left:rect.left,right:rect.right,titleRight:title.right,actionLeft:action.left,values,details,bars:metrics.querySelectorAll('.server-metric-meter,[role=progressbar],progress,meter').length,overflow:header.scrollWidth>header.clientWidth}; })()");
      assert.ok(!geometry.overflow, '状态条不撑破页头：'+theme+' '+width);
      assert.ok(geometry.left >= geometry.titleRight, '不覆盖服务器身份');
      assert.ok(geometry.right <= geometry.actionLeft, '不覆盖配置与连接操作');
      assert.ok(geometry.headerHeight <= 58, '保留紧凑页头高度');
      assert.ok(geometry.values.every(item=>item.left>=item.cellLeft&&item.right<=item.cellRight), '百分比完整显示');
      assert.equal(geometry.bars, 0, '纯文本状态行不显示进度条');
      assert.ok(geometry.values.every(item=>item.sameLine), '标签和百分比处于同一行');
      assert.ok(geometry.details.every(visible=>visible===(width>1150)), '容量在宽窗口显示，在窄窗口收起');
      await snapshot('server-metrics-'+theme+'-'+width+'.png');
    }
  }
  await setViewport(1440,920);
  await click('[data-metric=disk]');
  await until("document.querySelector('[aria-label=本地磁盘用量]')", '点开本地磁盘列表');
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

  await until("!document.querySelector('[aria-label=本地磁盘用量]')", '关闭磁盘弹层');
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
  assert.ok(await evaluate("(() => { const header=document.querySelector('.server-workspace-header'); return header.scrollWidth<=header.clientWidth&&[...header.querySelectorAll('.server-metric strong')].every(value=>{const a=value.getBoundingClientRect(),b=value.closest('.server-metric').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right}) })()"), '过期前缀在窄窗口完整显示');
  await setViewport(1440,920);
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
  const hiddenReads=metricsState.reads;
  await wait(5300);
  assert.equal(metricsState.reads,hiddenReads,'返回详情后停止采样');
  await click('[data-testid=plugin-open-workspace]');
  await until(cpu + " === '18%'", '返回工作区恢复采样');

  await clickText('断开连接');
  await until("document.querySelector('[data-testid=server-metrics]').dataset.paused === 'true'", '断线暂停监控');
  const disconnectedReads=metricsState.reads;
  await wait(1200);
  assert.equal(metricsState.reads,disconnectedReads);
  await clickText('重新连接');
  await until(cpu + " === '18%'", '重新连接恢复监控');
  assert.equal(writes.length,beforeWrites,'资源采集不向人工终端发送输入');
  assert.deepEqual(errors,[],'监控界面无渲染错误');
};
