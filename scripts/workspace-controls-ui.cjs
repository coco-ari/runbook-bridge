const assert = require('node:assert/strict');
module.exports = async function ({evaluate,until,root,win}) {
  async function click(selector) {
    win.webContents.focus();
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    win.webContents.invalidate();
    await until(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); const rect=target?.getBoundingClientRect(); return rect && rect.width>0 && rect.top>=0 && rect.bottom<=innerHeight && target.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)); })()`,'等待主题控件定位');
    const point=await evaluate(`(() => { const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}; })()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  }
  const trigger = root + ' [data-testid=theme-menu-trigger]';
  const preferenceKey = 'runbook-bridge:theme-preference:v1';
  const original = await evaluate(`localStorage.getItem('${preferenceKey}') || 'system'`);
  const header = await evaluate(`(() => {
    const header = document.querySelector(${JSON.stringify(root)}).querySelector('header');
    return [...header.querySelectorAll('button')].map(button => ({label:button.getAttribute('aria-label') || button.textContent.trim(),title:button.title}));
  })()`);
  assert.ok(header.some(button => button.label.startsWith('切换主题')),'工作区必须提供主题入口');
  assert.ok(header.some(button => button.label === '断开连接' && button.title === '断开连接'));
  assert.ok(header.some(button => button.label.startsWith('关闭') && button.title.startsWith('关闭工作区')));
  for (const preference of ['light','dark','system',original]) {
    await click(trigger);
    await until("document.querySelector('[data-testid=theme-menu]') !== null",'打开工作区主题菜单');
    await until("(() => { const rect=document.querySelector('[data-testid=theme-menu]').getBoundingClientRect(); return rect.top>=0 && rect.bottom<=innerHeight && rect.right<=innerWidth; })()",'菜单定位后不得超出窗口');
    await click('[data-testid=theme-option-'+preference+']');
    const expected = preference === 'system' ? await evaluate("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'") : preference;
    await until(`document.documentElement.dataset.theme === ${JSON.stringify(expected)}`,'工作区主题立即生效');
    await until(`document.activeElement === document.querySelector(${JSON.stringify(trigger)})`,'主题选择后恢复入口焦点');
  }
};
