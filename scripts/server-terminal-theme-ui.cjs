const assert = require('node:assert/strict');

module.exports = async function terminalThemeProbe({ evaluate, until, wait, click, nativeTheme, createTab = true }) {
  if (createTab) await click('[aria-label="新增终端"]');
  await until("document.querySelectorAll('.server-terminal-tab-panel').length===2 && document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-rows')?.textContent.includes('operator@demo')", '两个合成终端就绪');
  await wait(250);
  // 观察实际生成样式，不依赖组件源码或 xterm 私有实例字段。
  await evaluate(`(()=>{
    window.terminalThemeStyles=[...document.querySelectorAll('.xterm-screen style')].filter(node=>node.textContent.includes('.xterm-fg-'));
    window.terminalThemeMutations=0;
    window.terminalThemeObserver=new MutationObserver(records=>{window.terminalThemeMutations+=records.length});
    window.terminalThemeStyles.forEach(node=>window.terminalThemeObserver.observe(node,{childList:true,characterData:true,subtree:true}));
  })()`);
  try {
    assert.equal(await evaluate('window.terminalThemeStyles.length'), 2);
    for (const tab of [1, 2, 1, 2]) {
      await click('[role="tab"][title="终端 ' + tab + '"]');
      await until("document.querySelector('.server-terminal-tab-panel:not([hidden]) .xterm-helper-textarea')===document.activeElement", '切换后输入焦点');
    }
    await wait(100);
    const unchangedThemeMutations = await evaluate('window.terminalThemeMutations');
    assert.equal(unchangedThemeMutations, 0, '同主题标签切换不重写终端配色样式');
    for (const theme of ['light', 'dark']) {
      await evaluate('window.terminalThemeBefore=window.terminalThemeStyles.map(node=>node.textContent)');
      nativeTheme.themeSource = theme;
      await until('document.documentElement.dataset.theme===' + JSON.stringify(theme), '跟随系统主题');
      await until('window.terminalThemeStyles.every((node,index)=>node.textContent!==window.terminalThemeBefore[index])', '前后台终端同步更新配色');
    }
    const screenReaderLayers = await evaluate('document.querySelectorAll(".xterm-accessibility-tree[role=list]").length');
    assert.equal(screenReaderLayers, 2, '前后台终端均保留无障碍文本层');
    return { tabs: 2, unchangedThemeMutations, themeUpdates: await evaluate('window.terminalThemeMutations'), screenReaderLayers };
  } finally {
    await evaluate('window.terminalThemeObserver.disconnect(); delete window.terminalThemeStyles; delete window.terminalThemeMutations; delete window.terminalThemeObserver; delete window.terminalThemeBefore');
  }
};
