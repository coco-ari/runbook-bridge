const assert = require('node:assert/strict');
module.exports = async function ({evaluate,until,root,win}) {
  await require('./workspace-style-ui.cjs')(win);
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
  const trigger = root + ' [data-testid=settings-open]';
  const preferenceKey = 'runbook-bridge:theme-preference:v1';
  const original = await evaluate(`localStorage.getItem('${preferenceKey}') || 'system'`);
  const header = await evaluate(`(() => {
    const header = document.querySelector(${JSON.stringify(root)}).querySelector('header');
    return [...header.querySelectorAll('button')].map(button => ({label:button.getAttribute('aria-label') || button.textContent.trim(),description:button.getAttribute('aria-description') || ''}));
  })()`);
  assert.ok(header.some(button => button.label === '配置'),'工作区必须提供配置入口');
  assert.ok(header.some(button => button.label === '断开连接' && button.description === '断开连接'));
  assert.ok(header.some(button => button.label.startsWith('关闭') && button.description.startsWith('关闭工作区')));
  for (const preference of ['light','dark','system',original]) {
    await click(trigger);
    await until("document.querySelector('[data-testid=settings-page]') !== null",'打开配置页面');
    await click('[data-testid=theme-menu-trigger]');
    await until("document.querySelector('[data-testid=theme-menu]') !== null",'打开工作区主题菜单');
    await until("(() => { const rect=document.querySelector('[data-testid=theme-menu]').getBoundingClientRect(); return rect.top>=0 && rect.bottom<=innerHeight && rect.right<=innerWidth; })()",'菜单定位后不得超出窗口');
    await click('[data-testid=theme-option-'+preference+']');
    const expected = preference === 'system' ? await evaluate("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'") : preference;
    await until(`document.documentElement.dataset.theme === ${JSON.stringify(expected)}`,'工作区主题立即生效');
    await until("document.activeElement === document.querySelector('[data-testid=theme-menu-trigger]')",'主题选择后恢复入口焦点');
    if (process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR) {
      const fs = require('node:fs'), path = require('node:path');
      const destination = path.resolve(process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR);
      fs.mkdirSync(destination,{recursive:true});
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      win.webContents.invalidate();
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await evaluate("Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))");
      const frame = await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      fs.writeFileSync(path.join(destination,'settings-appearance-'+expected+'.png'),frame.toPNG());
    }
    await click('[data-testid=settings-back]');
    await until(`!document.querySelector('[data-testid=settings-page]') && document.activeElement === document.querySelector(${JSON.stringify(trigger)})`,'返回原工作区并恢复配置入口焦点');
  }
};
