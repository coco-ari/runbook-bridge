const assert = require('node:assert/strict');

module.exports = async function ({win,fill,click,waitFor,active,writeValues}) {
  const selector='.redis-tab-panel:not([hidden]) [aria-label="Redis Value"]';
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const doc=()=>evaluate(`document.querySelector(${JSON.stringify(selector)}).cmTile.root.view.state.sliceDoc()`);
  const key=async (keyCode,shift=false)=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    win.webContents.focus();
    const modifiers=[process.platform==='darwin'?'meta':'control',...(shift?['shift']:[])];
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
    await new Promise(resolve=>setTimeout(resolve,80));
  };
  const raw=String.raw`{"id":9007199254740993123,"n":1.2300,"n":1e+09,"escaped":"\u4e2d","text":"中文😀"}`;
  await fill(win,selector,raw);
  await click(win,active('redis-edit-format-json'));
  assert.equal(await doc(),raw,'切换JSON模式不会重写原始值');
  assert.equal(await evaluate('Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-lineNumbers"))'),true,'编辑模式提供行号');
  await waitFor(win,'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .redis-json-string"))','草稿JSON高亮');
  await click(win,active('redis-draft-format'));
  const formatted=await doc();
  assert.ok(formatted.includes('\n')&&formatted.includes('9007199254740993123')&&formatted.includes('1.2300')&&formatted.includes('1e+09')&&formatted.includes(String.raw`\u4e2d`),'显式格式化保留数字精度和转义');
  assert.equal((formatted.match(/"n"/g)||[]).length,2,'格式化保留重复字段');
  await key('Z');
  assert.equal(await doc(),raw,'格式化可撤销到精确原文');
  await click(win,active('redis-edit-format-text'));
  await click(win,active('redis-edit-format-json'));
  if(process.platform==='darwin')await key('Z',true);else await key('Y');
  assert.equal(await doc(),formatted,'切换显示格式保留重做历史');
  await click(win,active('redis-draft-find'));
  await waitFor(win,'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-search"))','编辑中本地查找');
  await fill(win,'.redis-tab-panel:not([hidden]) .cm-search input[name=search]','中文');
  await evaluate('document.querySelector(".redis-tab-panel:not([hidden]) .cm-search input[name=search]").dispatchEvent(new KeyboardEvent("keyup",{key:"a",bubbles:true}))');
  await waitFor(win,'Boolean(document.querySelector(".redis-tab-panel:not([hidden]) .cm-searchMatch"))','草稿本地查找有高亮');
  await click(win,'.redis-tab-panel:not([hidden]) .cm-search [name=close]');
  await click(win,active('redis-edit-format-text'));
  await fill(win,selector,'');
  const attached=win.webContents.debugger.isAttached();
  if(!attached)win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'中文😀'});
    await waitFor(win,`document.querySelector(${JSON.stringify(selector)}).cmTile.root.view.state.sliceDoc()==='中文😀'`,'中文输入法合成文本提交');
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});
    if(!attached)win.webContents.debugger.detach();
  }
  assert.equal(await doc(),'中文😀','中文输入法及补充平面字符可编辑');
  assert.ok(await evaluate('document.querySelector(".redis-tab-panel:not([hidden]) [data-testid=redis-draft-bytes]").textContent.startsWith("10 / ")'),'UTF-8字节数使用完整字符计数');
  await fill(win,selector,'中'.repeat(21846));
  assert.equal(await doc(),'中文😀','UTF-8超限输入保留原草稿');
  await waitFor(win,'document.querySelector(".redis-tab-panel:not([hidden]) .redis-edit-error")?.textContent.includes("字节上限")','字节超限说明');
  await fill(win,selector,'x'.repeat(65536));
  assert.equal((await doc()).length,65536,'原有65536字符边界可用');
  await fill(win,selector,'x'.repeat(65537));
  assert.equal((await doc()).length,65536,'超过原有字符上限不能进入草稿');
  await waitFor(win,'document.querySelector(".redis-tab-panel:not([hidden]) .redis-edit-error")?.textContent.includes("个字符")','字符超限说明');
  assert.equal(writeValues.has('cache:ui-created'),false,'查找、格式化和编辑不会触发写入');
  await fill(win,selector,'{"id":9007199254740993}');
  await click(win,active('redis-edit-format-json'));
};
