const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const collectControl = (selector,type) => {
  const element=document.querySelector(selector);
  if(!(element instanceof HTMLElement))return null;
  // 系统色探针只解析当前高对比配色，控件证据全部来自实际挂载的业务控件。
  const system=document.createElement('span');
  system.style.cssText='position:fixed;left:-10000px;background:Canvas;color:CanvasText;outline-color:Highlight';
  document.body.append(system);
  const systemStyle=getComputedStyle(system);
  const systemColors={canvas:systemStyle.backgroundColor,text:systemStyle.color,highlight:systemStyle.outlineColor};
  system.remove();
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});
  const rgba=value=>{
    context.clearRect(0,0,1,1);context.fillStyle='transparent';context.fillStyle=value;context.fillRect(0,0,1,1);
    return [...context.getImageData(0,0,1,1).data];
  };
  const blend=(foreground,background)=>{
    const alpha=foreground[3]/255;
    return foreground.slice(0,3).map((value,index)=>value*alpha+background[index]*(1-alpha)).concat(255);
  };
  const luminance=value=>value.slice(0,3).map(channel=>channel/255)
    .map(channel=>channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4)
    .reduce((value,channel,index)=>value+channel*[0.2126,0.7152,0.0722][index],0);
  const ratio=(a,b)=>(Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);
  const backgroundAt=target=>{
    const ancestors=[];for(let current=target;current;current=current.parentElement)ancestors.unshift(current);
    return ancestors.reduce((background,current)=>blend(rgba(getComputedStyle(current).backgroundColor),background),rgba(systemColors.canvas));
  };
  const rect=target=>{
    const value=target.getBoundingClientRect();
    return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};
  };
  const visible=target=>{
    if(!target)return false;
    const style=getComputedStyle(target),box=rect(target);
    return box.width>0&&box.height>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0;
  };
  const style=getComputedStyle(element),inside=backgroundAt(element),outside=backgroundAt(element.parentElement);
  const border=target=>{
    const value=getComputedStyle(target),background=backgroundAt(target),external=backgroundAt(target.parentElement);
    return ['Top','Right','Bottom','Left'].map(side=>({
      width:parseFloat(value['border'+side+'Width']),style:value['border'+side+'Style'],color:value['border'+side+'Color'],
      insideContrast:ratio(blend(rgba(value['border'+side+'Color']),background),background),
      outsideContrast:ratio(blend(rgba(value['border'+side+'Color']),external),external),
    }));
  };
  const result={type,systemColors,forced:matchMedia('(forced-colors: active)').matches,visible:visible(element),disabled:Boolean(element.disabled),
    checked:element.getAttribute('aria-checked'),rect:rect(element),border:border(element),background:style.backgroundColor,
    focused:document.activeElement===element&&element.matches(':focus-visible'),
    outline:{width:parseFloat(style.outlineWidth),style:style.outlineStyle,color:style.outlineColor,
      contrast:ratio(blend(rgba(style.outlineColor),outside),outside)},
  };
  if(type==='switch'){
    const thumb=element.querySelector(':scope > span');
    result.thumb=thumb?{visible:visible(thumb),rect:rect(thumb),background:getComputedStyle(thumb).backgroundColor,
      fillContrast:ratio(backgroundAt(thumb),inside),border:border(thumb)}:null;
  }
  if(type==='checkbox'){
    const indicator=element.querySelector('[data-slot=checkbox-indicator]'),glyph=indicator?.querySelector('svg');
    result.indicator={visible:visible(indicator)&&visible(glyph),fill:glyph?getComputedStyle(glyph).fill:null,
      contrast:glyph?ratio(blend(rgba(getComputedStyle(glyph).fill),inside),inside):0};
  }
  return result;
};

module.exports = async function assertForcedControls({win,waitFor,pressKey,screenshotRoot,selector,type,label,inputSelector,settle}) {
  assert.ok(['switch','checkbox'].includes(type),'强制颜色验收只接收真实开关或复选框');
  const driver=win.webContents.debugger,attached=driver.isAttached();
  const evidence={label,type};
  // 截图保持隐藏窗口状态，避免默认捕帧唤醒窗口后改变键盘焦点。
  const capture=async target=>{
    await target.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});target.webContents.invalidate();
    await target.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    return target.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  };
  const measure=async(target,kind)=>win.webContents.executeJavaScript(`(${collectControl.toString()})(${JSON.stringify(target)},${JSON.stringify(kind)})`);
  const focusDetails=async target=>({
    ...await win.webContents.executeJavaScript(`(() => {
      const element=document.querySelector(${JSON.stringify(target)}),active=document.activeElement;
      const box=element?.getBoundingClientRect(),pane=element?.closest('[data-testid=cloud-project-list]');
      const card=element?.closest('[data-testid=cloud-project-card]');
      const identify=value=>value?{tag:value.tagName,id:value.id,role:value.getAttribute('role'),slot:value.dataset.slot,testId:value.dataset.testid}:null;
      return {documentFocused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight},active:identify(active),
        target:{exists:Boolean(element),count:document.querySelectorAll(${JSON.stringify(target)}).length,...identify(element),disabled:Boolean(element?.disabled),
          focused:active===element,focusVisible:Boolean(element?.matches(':focus-visible')),hiddenOrInert:Boolean(element?.closest('[hidden],[inert]')),
          rect:box?{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}:null},
        cloud:pane?{busy:document.querySelector('[data-testid=cloud-config-panel]')?.getAttribute('aria-busy'),filter:document.querySelector('[aria-label="筛选云项目"]')?.textContent.trim(),
          queryEmpty:!document.querySelector('#cloud-project-search')?.value,scrollTop:pane.scrollTop,clientHeight:pane.clientHeight,
          cardIndex:[...pane.querySelectorAll('[data-testid=cloud-project-card]')].indexOf(card)}:null};
    })()`),
    windowFocused:win.isFocused(),webContentsFocused:win.webContents.isFocused(),
  });
  const focus=async(target,keyboard=true,stage='control')=>{
    const trace={stage,keyboard};
    try {
      trace.entry=await focusDetails(target);
      await waitFor(`document.querySelector(${JSON.stringify(target)})?.getClientRects().length>0&&!document.querySelector(${JSON.stringify(target)})?.disabled`,'真实高对比控件可用');
      if(keyboard){
        await win.webContents.executeJavaScript(`(() => {
          window.__forcedControlsTabProcessed=false;
          window.__forcedControlsTabKeyUp=event=>{
            if(event.isTrusted&&event.key==='Tab')window.__forcedControlsTabProcessed=true;
          };
          document.addEventListener('keyup',window.__forcedControlsTabKeyUp,true);
        })()`);
        try {
          await pressKey('TAB');
          // 等原生 Tab 完成默认焦点移动，再聚焦目标，避免异步按键抢走焦点。
          await waitFor('window.__forcedControlsTabProcessed===true','原生Tab键盘事件已处理');
          trace.afterTab=await focusDetails(target);
        } finally {
          await win.webContents.executeJavaScript(`(() => {
            document.removeEventListener('keyup',window.__forcedControlsTabKeyUp,true);
            delete window.__forcedControlsTabKeyUp;
            delete window.__forcedControlsTabProcessed;
          })()`);
        }
      }
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(target)}).focus({preventScroll:true})`);
      trace.afterFocus=await focusDetails(target);
      await waitFor(`document.querySelector(${JSON.stringify(target)})===document.activeElement&&document.activeElement.matches(':focus-visible')`,'真实控件拥有键盘焦点');
    } catch(error) {
      // 仅失败时输出焦点和几何，不记录项目名称、搜索文本或业务内容。
      evidence.focusFailure={...trace,failed:await focusDetails(target)};
      throw error;
    }
  };
  const screenshot=async state=>{
    if(!screenshotRoot)return;
    const destination=path.resolve(screenshotRoot),root=path.resolve(__dirname,'..'),relative=path.relative(root,destination);
    assert.ok(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative),'强制颜色截图必须写在仓库之外');
    fs.mkdirSync(destination,{recursive:true});
    fs.writeFileSync(path.join(destination,'forced-controls-'+label.replace(/[^a-z0-9_-]/gi,'-')+'-'+state+'.png'),(await capture(win)).toPNG());
  };
  const assertControl=(data,name)=>{
    assert.ok(data?.forced&&data.visible&&!data.disabled,name+'必须是可操作的真实高对比控件');
    assert.ok(data.border.every(side=>side.width>=1&&side.style==='solid'&&Math.min(side.insideContrast,side.outsideContrast)>=3),name+'边界必须可辨认：'+JSON.stringify(data.border));
    assert.ok(data.focused&&data.outline.style==='solid'&&data.outline.width>=2&&data.outline.contrast>=3,name+'键盘焦点必须可辨认：'+JSON.stringify(data.outline));
    if(data.type==='switch'){
      assert.ok(data.thumb?.visible,name+'滑块必须存在并可见');
      assert.ok(data.thumb.fillContrast>=3||data.thumb.border.some(side=>side.width>=1&&side.style==='solid'&&side.insideContrast>=3),name+'滑块必须与轨道区分：'+JSON.stringify(data.thumb));
      assert.ok(data.thumb.rect.left>=data.rect.left-1&&data.thumb.rect.right<=data.rect.right+1,name+'滑块不能越出轨道');
    }
    if(data.type==='checkbox'&&data.checked==='true')assert.ok(data.indicator.visible&&data.indicator.contrast>=3,name+'勾选标记必须可辨认：'+JSON.stringify(data.indicator));
  };
  await win.webContents.executeJavaScript('window.__forcedControlsPreviousFocus=document.activeElement');
  if(!attached)driver.attach('1.3');
  try {
    await driver.sendCommand('Emulation.setEmulatedMedia',{media:'screen',features:[{name:'forced-colors',value:'active'}]});
    await driver.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await waitFor("matchMedia('(forced-colors: active)').matches",'强制颜色已激活');
    if(inputSelector){await focus(inputSelector,true,'input');await capture(win);evidence.input=await measure(inputSelector,'input');}
    await focus(selector,true,'before');await capture(win);evidence.before=await measure(selector,type);await screenshot('before');
    // 截图完成后紧邻发键复核真实控件焦点，避免宿主窗口重激活或排队焦点恢复抢走 Space。
    await focus(selector,false,'before-space');evidence.before=await measure(selector,type);
    assert.ok(evidence.before?.focused,'原生Space紧前真实控件必须拥有可见键盘焦点');
    assert.ok(['true','false'].includes(evidence.before?.checked),'真实控件具有明确选中状态');
    // 只执行一次既有状态操作，退出时保留业务态，不发起额外切换或读写。
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    const checked=evidence.before.checked==='true'?'false':'true';
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')===${JSON.stringify(checked)}`,'原生Space更新真实业务状态');
    if(settle)await settle();
    await focus(selector,true,'after-settle');await capture(win);evidence.after=await measure(selector,type);await screenshot('after');
    if(evidence.input)assertControl(evidence.input,label+'输入字段');
    assertControl(evidence.before,label+'操作前');assertControl(evidence.after,label+'操作后');
    assert.equal(evidence.after.checked,checked,'真实控件状态只改变一次');
    if(type==='switch')assert.ok(checked==='true'?evidence.after.thumb.rect.left>evidence.before.thumb.rect.left:evidence.after.thumb.rect.left<evidence.before.thumb.rect.left,'开关两态的滑块位置必须可辨认');
  } finally {
    process.stdout.write('强制颜色真实控件：'+JSON.stringify(evidence)+'\n');
    try {
      await driver.sendCommand('Emulation.setEmulatedMedia',{media:'screen',features:[]});
      await driver.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});
      await win.webContents.executeJavaScript('window.__forcedControlsPreviousFocus?.isConnected&&window.__forcedControlsPreviousFocus.focus({preventScroll:true});delete window.__forcedControlsPreviousFocus');
    } finally {if(!attached&&driver.isAttached())driver.detach();}
  }
  return evidence;
};
