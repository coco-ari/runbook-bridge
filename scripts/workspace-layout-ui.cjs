const assert = require('node:assert/strict');

// Shared behavioral checks run against SSH, Docker, MySQL and Redis fixtures.
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
    return {count:buttons.length, label:button.getAttribute('aria-label'), title:button.title,
      expanded:button.getAttribute('aria-expanded'), x:rect.x, y:rect.y, width:rect.width, height:rect.height,
      icon:[icon.width,icon.height], rightGap:root.getBoundingClientRect().right-rect.right,
      rowHeight:row.height, last:button === bar.querySelector('button:last-child[data-workspace-layout-toggle]'),
      hit:button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),
      panels:button.getAttribute('aria-controls').split(' ').map(id => {const el=document.getElementById(id); return el ? {id,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height} : null}),
      tabs:[...bar.querySelectorAll('[role=tab]')].map(tab=>[tab.id,tab.getAttribute('aria-selected')])};
  })()`);
  const before = await read();
  assert.equal(before.count,1,'每个工作区只有一个布局主按钮');
  assert.equal(before.label,'最大化工作区');
  assert.equal(before.title,before.label);
  assert.deepEqual([before.width,before.height,...before.icon],[32,32,16,16]);
  assert.equal(before.rowHeight,40);
  assert.ok(Math.abs(before.rightGap-8)<1,'布局按钮固定在工作区右侧 8px');
  assert.ok(before.hit && before.last,'主布局按钮可点击且在布局组最右侧');
  assert.ok(before.panels.every(Boolean),'布局按钮声明的受控面板必须存在');
  win.webContents.focus();
  await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  const point = {x:Math.round(before.x+16),y:Math.round(before.y+16)};
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'false'`,'最大化后更新按钮状态');
  await until(`document.getElementById(${JSON.stringify(before.panels[0].id)}).getBoundingClientRect().width < 1`,'最大化后侧栏完全收起');
  const maximized = await read();
  assert.equal(maximized.label,'恢复分栏');
  assert.equal(maximized.title,maximized.label);
  assert.deepEqual([maximized.x,maximized.y],[before.x,before.y],'最大化与恢复按钮保持原位');
  assert.deepEqual(maximized.tabs,before.tabs,'切换布局保留标签与选中状态');
  await until(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`,'切换布局后保留键盘焦点');
  win.webContents.focus();
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded') === 'true'`,'Enter 可恢复分栏');
  await until(`document.getElementById(${JSON.stringify(before.panels[0].id)}).getBoundingClientRect().width > 1`,'恢复侧栏宽度');
  const restored = await read();
  assert.ok(Math.abs(restored.panels[0].width-before.panels[0].width)<2,'恢复用户调整后的侧栏宽度');
  assert.deepEqual(restored.tabs,before.tabs,'恢复布局保留标签与选中状态');
};
