const assert = require('node:assert/strict');

module.exports = async function ({ win, prefix, editable, waitFor }) {
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const root = `[data-testid="${prefix}-result"]`;
  const cells = `${root} [data-edit-column]`;
  const active = () => evaluate('({row:document.activeElement.closest("[data-row-index]")?.dataset.rowIndex,column:document.activeElement.dataset.editColumn})');
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  const count = () => evaluate(`document.querySelectorAll(${JSON.stringify(cells+'[tabindex="0"]')}).length`);
  const bounds = await evaluate(`(() => { const all=[...document.querySelectorAll(${JSON.stringify(cells)})], first=all[0],last=all.at(-1); return {first:{row:first.closest('tr').dataset.rowIndex,column:first.dataset.editColumn},last:{row:last.closest('tr').dataset.rowIndex,column:last.dataset.editColumn},firstText:first.textContent} })()`);
  assert.equal(await count(), 1, '数据单元格只有一个 Tab 入口');
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(root+' tbody [tabindex="0"], '+root+' tbody button:not([tabindex="-1"]):not(:disabled)')}).length`),1,'行勾选与行号不增加逐行 Tab 停靠点');
  await evaluate(`document.querySelector(${JSON.stringify(cells)}).focus()`);
  win.webContents.focus();
  await key('End');
  assert.equal((await active()).column, bounds.last.column, 'End 到当前行最后一列');
  await key('Home');
  assert.deepEqual(await active(), bounds.first, 'Home 回到当前行第一列');
  const command = process.platform === 'darwin' ? 'meta' : 'control';
  await key('End', [command]);
  assert.deepEqual(await active(), bounds.last, 'Ctrl 或 ⌘ End 到当前已加载视图最后一格');
  await key('Home', [command]);
  assert.deepEqual(await active(), bounds.first, 'Ctrl 或 ⌘ Home 到视图第一格');
  await key('Right');
  assert.notEqual((await active()).column, bounds.first.column, '左右键访问下一列');
  await key('Left');
  await key('Down');
  assert.notEqual((await active()).row, bounds.first.row, '上下键访问下一行');
  await key('Up');
  assert.deepEqual(await active(), bounds.first);
  await key('C', [command]);
  await waitFor(win, `window.__databaseClipboardWrites.at(-1) === ${JSON.stringify(bounds.firstText)}`, '键盘复制完整单元格');
  assert.deepEqual(await active(), bounds.first, '复制后焦点仍在活动单元格');
  if (editable) {
    await key('Space');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(root+' tbody tr')}).dataset.selected`), 'true', '空格选择活动行');
    await key('Space');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(root+' tbody tr')}).dataset.selected`), undefined, '空格取消活动行选择');
    await key('Space', ['shift']);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(root+' tbody tr')}).dataset.selected`), undefined, 'Shift 空格不劫持为行勾选');
  } else {
    await key('Enter');
    await waitFor(win, `Boolean(document.querySelector('[data-testid=${prefix}-row-detail]'))`, '只读单元格 Enter 查看行详情');
    await evaluate(`document.querySelector('[data-testid=${prefix}-close-detail]').click()`);
    await waitFor(win, `!document.querySelector('[data-testid=${prefix}-row-detail]')`, '关闭详情回到活动格');
    assert.deepEqual(await active(), bounds.first, '关闭行详情恢复到原活动单元格');
  }
  assert.equal(await count(), 1, '方向移动、复制和查看后仍只有一个入口');
  await evaluate(`document.querySelector(${JSON.stringify(cells+'[tabindex="0"]')}).focus()`);
  await key('Tab');
  assert.equal(await evaluate(`Boolean(document.activeElement.closest(${JSON.stringify(root+' tbody')}))`), false, 'Tab 离开数据区，不遍历每行选择按钮');
};
