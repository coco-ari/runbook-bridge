const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {nativeTheme} = require('electron');

module.exports = async ({win,waitFor,captureRenderedFrame,selectVisualScope,selectVisualTab,screenshotRoot,readCalls}) => {
  const evaluate = source => win.webContents.executeJavaScript(source,true);
  const until = (source,label) => waitFor(win,source,label);
  const click = async selector => {
    await until(`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`,selector);
    const point = await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  const fill = (selector,value) => evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const capture = async name => {
    if (!screenshotRoot) return;
    fs.mkdirSync(screenshotRoot,{recursive:true});
    fs.writeFileSync(path.join(screenshotRoot,name+'.png'),(await captureRenderedFrame(win)).toPNG());
  };
  const widths = `(() => Object.fromEntries(['project','resource','detail'].map(name=>[name,document.getElementById(name+'-panel').getBoundingClientRect().width])))()`;
  const stored = await evaluate(`localStorage.getItem('runbook-bridge:app-shell-layout:v1')`);
  for (const [width,project,resource] of [[1280,224,320],[960,176,240],[1280,224,320]]) {
    win.setContentSize(width,820);
    await until(`innerWidth===${width}`,'逻辑窗口尺寸');
    await captureRenderedFrame(win);
    await until(`(() => {const w=${widths};return Math.abs(w.project-${project})<2&&Math.abs(w.resource-${resource})<2})()`,'导航临时压缩与恢复');
    assert.equal(await evaluate(`localStorage.getItem('runbook-bridge:app-shell-layout:v1')`),stored,'调整窗口不覆盖保存布局');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false);
  }
  win.setContentSize(960,820);
  await until(`(() => {const w=${widths};return Math.abs(w.project-176)<2})()`,'窄窗折叠前完成布局');
  await click('[data-project-rail-toggle]');
  await until(`document.querySelector('[data-testid="project-rail"]').dataset.collapsed==='true'`,'窄窗折叠项目栏');
  await click('[data-project-rail-toggle]');
  await until(`document.querySelector('[data-testid="project-rail"]').dataset.collapsed==='false'`,'窄窗重新展开项目栏');
  win.setContentSize(1280,820);
  await until(`(() => {const w=${widths};return Math.abs(w.project-224)<2&&Math.abs(w.resource-320)<2})()`,'窄窗折叠操作仍保留宽窗首选宽度');
  await selectVisualScope(win,'environment');
  assert.equal(await evaluate(`document.querySelector('[data-testid="plugin-trigger-plugin-orders-db"]').textContent.includes('连接失败')`),true,'连接异常有可见文字');
  await click('[aria-label="搜索全部资源"]');
  for (const query of ['生产 订单','订单 生产','mysql 生产 订单']) {
    await fill('[cmdk-input]',query);
    await until(`[...document.querySelectorAll('[cmdk-item]')].some(e=>e.getClientRects().length&&e.textContent.includes('订单数据库'))`,'组合搜索实际返回目标');
  }
  await fill('[cmdk-input]','测试 订单');
  await until(`[...document.querySelectorAll('[cmdk-item]')].every(e=>!e.getClientRects().length||!e.textContent.includes('订单数据库'))`,'环境条件不能跨范围匹配');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until(`!document.querySelector('[cmdk-input]')`,'关闭搜索');
  await selectVisualTab(win,'audit','[data-feature="audit"]','操作记录');
  win.setContentSize(960,640);
  await captureRenderedFrame(win);
  await until(`document.querySelector('[data-testid="audit-filter-toggle"]')?.getClientRects().length>0`,'窄窗显示筛选入口');
  assert.equal(await evaluate(`document.querySelector('[aria-label="筛选参与方"]').getClientRects().length`),0,'低频筛选初始收起');
  for (const theme of ['light','dark']) {
    nativeTheme.themeSource=theme;
    await until(`document.documentElement.dataset.theme==='${theme}'`,'主题切换');
    await capture('audit-compact-'+theme);
  }
  await click('[data-testid="audit-filter-toggle"]');
  await click('[aria-label="筛选参与方"]');
  await until(`document.querySelector('[role="option"][data-value="user"]')!==null||[...document.querySelectorAll('[role="option"]')].some(e=>e.textContent==='用户')`,'参与方选项');
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent==='用户').click()`);
  await until(`document.querySelector('[aria-label="移除筛选 参与方：用户"]')!==null`,'已选筛选始终可见');
  await click('[data-testid="audit-filter-toggle"]');
  await until(`document.querySelector('[aria-label="筛选参与方"]').getClientRects().length===0`,'筛选区域已收起');
  await until(`document.querySelector('[aria-label="移除筛选 参与方：用户"]').getClientRects().length>0`,'收起后筛选条件可见');
  await click('[aria-label="移除筛选 参与方：用户"]');
  await until(`!document.querySelector('[aria-label="移除筛选 参与方：用户"]')`,'直接移除筛选');
  assert.ok(readCalls.some(call=>call.channel==='v2:audit-list'&&call.args[0]?.actor==='user'),'筛选仍请求实际参与方范围');
  await selectVisualScope(win,'environment');
  win.setContentSize(1280,820);
  await captureRenderedFrame(win);
  await click('[data-testid="add-plugin-env-production-east"]');
  await until(`document.querySelector('#plugin-username')!==null`,'认证输入可用');
  assert.equal(await evaluate(`document.querySelector('#plugin-docker-socket')?.getClientRects().length??0`),0,'可选 Docker 设置默认收起');
  await capture('plugin-essential-fields');
  await click('[data-testid="plugin-advanced-toggle"]');
  await until(`document.querySelector('#plugin-docker-socket')?.getClientRects().length>0`,'高级连接设置展开');
  await fill('#plugin-docker-socket','/var/run/custom-docker.sock');
  await click('[data-testid="plugin-advanced-toggle"]');
  await until(`!document.querySelector('#plugin-docker-socket')?.getClientRects().length`,'高级连接设置收起');
  await click('[data-testid="plugin-advanced-toggle"]');
  await until(`document.querySelector('#plugin-docker-socket')?.getClientRects().length>0`,'高级连接设置重新展开');
  assert.equal(await evaluate(`document.querySelector('#plugin-docker-socket').value`),'/var/run/custom-docker.sock','折叠高级设置不丢失草稿');
  process.stdout.write('UI 体验专项通过：窄窗恢复、上下文搜索、连接异常文字、筛选收起与移除、高级字段草稿。\n');
};
