const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({win,waitFor,captureRenderedFrame,screenshotRoot}) => {
  const evidence = [];
  const geometry = `(() => {
    const size=id=>document.getElementById(id)?.getBoundingClientRect().width;
    return {width:innerWidth,height:innerHeight,project:size('project-panel'),resource:size('resource-panel'),detail:size('detail-panel'),overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`;
  for (const width of [1280,1920]) {
    win.setContentSize(width,820);
    await waitFor(win,`innerWidth===${width}`,'新布局窗口尺寸');
    await captureRenderedFrame(win);
    await waitFor(win,`(() => {const data=${geometry};return Math.abs(data.project-224)<2&&Math.abs(data.resource-320)<2;})()`,'宽屏导航保持内容宽度');
    const data=await win.webContents.executeJavaScript(geometry);
    assert.equal(data.overflow,false,'首开布局没有页面横向溢出');
    assert.ok(Math.abs(data.detail-(width-546))<3,'增加的宽度进入详情');
    evidence.push(data);
    if(screenshotRoot) {
      fs.mkdirSync(screenshotRoot,{recursive:true});
      fs.writeFileSync(path.join(screenshotRoot,`optimization-default-layout-${width}.png`),(await captureRenderedFrame(win)).toPNG());
    }
  }
  // 保持1920物理宽度，验证缩放后新增空间仍优先留给详情区。
  try {
    win.setContentSize(1920,1080);
    for (const zoom of [1.25,1.5,2]) {
      win.webContents.setZoomFactor(zoom);
      const label=zoom*100+'%缩放';
      await waitFor(win,`Math.abs(innerWidth-${1920/zoom})<=1&&Math.abs(innerHeight-${1080/zoom})<=1`,label+'后的桌面逻辑窗口');
      await captureRenderedFrame(win);
      await waitFor(win,`(() => {const data=${geometry};return Math.abs(data.project-224)<2&&Math.abs(data.resource-320)<2;})()`,label+'导航保持内容宽度');
      const zoomed=await win.webContents.executeJavaScript(geometry);
      assert.equal(zoomed.overflow,false,label+'没有页面横向溢出');
      assert.ok(Math.abs(zoomed.detail-(zoomed.width-546))<3,label+'详情获得剩余宽度');
      evidence.push({...zoomed,zoom});
      if(screenshotRoot) fs.writeFileSync(path.join(screenshotRoot,`optimization-default-layout-${zoom*100}-percent.png`),(await captureRenderedFrame(win)).toPNG());
    }
  } finally {
    win.webContents.setZoomFactor(1);
    win.setContentSize(960,640);
    await waitFor(win,'innerWidth===960&&innerHeight===640','恢复基础验收窗口');
    await captureRenderedFrame(win);
  }
  process.stdout.write('新布局实际像素与125/150/200%缩放：'+JSON.stringify(evidence)+'\n');
};
