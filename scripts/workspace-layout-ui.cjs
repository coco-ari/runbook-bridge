const assert = require('node:assert/strict');

// 使用 SSH、Docker、MySQL 和 Redis 模拟数据验证共享布局行为。
module.exports = async function ({evaluate, until, win, root}) {
  const selector = root + ' [data-workspace-layout-toggle]';
  const read = () => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(root)});
    const buttons = root.querySelectorAll('[data-workspace-layout-toggle]');
    const button = buttons[0];
    const rect = button.getBoundingClientRect();
    const bar = button.closest('[data-workspace-tabbar]');
    const row = bar.getBoundingClientRect();
    const icon = button.querySelector('svg').getBoundingClientRect();
    return {count:buttons.length, label:button.getAttribute('aria-label'), description:button.getAttribute('aria-description'),
      expanded:button.getAttribute('aria-expanded'), x:rect.x, y:rect.y, width:rect.width, height:rect.height,
      icon:[icon.width,icon.height], rightGap:root.getBoundingClientRect().right-rect.right,
      rowHeight:row.height, last:button === bar.querySelector('button:last-child[data-workspace-layout-toggle]'),
      hit:button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),
      panels:button.getAttribute('aria-controls').split(' ').map(id => {const el=document.getElementById(id); return el ? {id,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height} : null}),
      tabs:[...bar.querySelectorAll('[role=tab]')].map(tab=>[tab.id,tab.getAttribute('aria-selected')])};
  })()`);
  await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  win.webContents.invalidate();
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const before = await read();
  assert.equal(before.count,1,'每个工作区只有一个布局主按钮');
  assert.equal(before.label,'最大化工作区');
  assert.equal(before.description,before.label);
  assert.deepEqual([before.width,before.height,...before.icon],[28,28,16,16]);
  assert.equal(before.rowHeight,36);
  assert.ok(Math.abs(before.rightGap-8)<1,'布局按钮固定在工作区右侧 8px');
  assert.ok(before.hit && before.last,'主布局按钮可点击且在布局组最右侧');
  assert.ok(before.panels.every(Boolean),'布局按钮声明的受控面板必须存在');
  win.webContents.focus();
  await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  const point = {x:Math.round(before.x+before.width/2),y:Math.round(before.y+before.height/2)};
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'false'`,'最大化后更新按钮状态');
  await until(`document.getElementById(${JSON.stringify(before.panels[0].id)}).getBoundingClientRect().width < 1`,'最大化后侧栏完全收起');
  const maximized = await read();
  assert.equal(maximized.label,'恢复分栏');
  assert.equal(maximized.description,maximized.label);
  assert.deepEqual([maximized.x,maximized.y],[before.x,before.y],'最大化与恢复按钮保持原位');
  assert.deepEqual(maximized.tabs,before.tabs,'切换布局保留标签与选中状态');
  await until(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`,'切换布局后保留键盘焦点');
  win.webContents.focus();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'true'`,'Enter 可恢复分栏');
  await until(`Math.abs(document.getElementById(${JSON.stringify(before.panels[0].id)}).getBoundingClientRect().width - ${before.panels[0].width}) < 2`,'恢复用户调整后的侧栏宽度').catch(async error => {
    console.error('侧栏恢复尺寸', JSON.stringify({before:before.panels,after:(await read()).panels}));
    throw error;
  });
  const restored = await read();
  assert.ok(Math.abs(restored.panels[0].width-before.panels[0].width)<2,'恢复用户调整后的侧栏宽度');
  assert.deepEqual(restored.tabs,before.tabs,'恢复布局保留标签与选中状态');
};
