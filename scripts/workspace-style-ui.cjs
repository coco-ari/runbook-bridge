const assert = require('node:assert/strict');

const collectStyleEvidence = () => {
  const root = document.documentElement;
  const savedTheme = root.dataset.theme;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const results = [];
  try {
    for (const theme of ['light', 'dark']) {
      root.dataset.theme = theme;
      for (const scope of ['settings', 'server-workspace', 'redis-workspace', 'mysql-workspace']) {
        probe.innerHTML = '<section class="' + scope + '" style="position:static;height:auto">'
          + '<button class="h-8 rounded-md text-sm font-medium border border-input">配置</button>'
          + '<input class="h-8 text-xs font-mono border border-input" />'
          + '<span class="text-xs">辅助说明</span></section>';
        const [button, input, hint] = probe.firstElementChild.children;
        const buttonStyle = getComputedStyle(button);
        const inputStyle = getComputedStyle(input);
        const expected = document.createElement('span');
        expected.style.borderColor = 'var(--input)';
        expected.style.color = 'var(--primary)';
        expected.style.backgroundColor = 'var(--surface-selected)';
        probe.append(expected);
        const expectedStyle = getComputedStyle(expected);
        results.push({
          theme, scope,
          buttonFont: buttonStyle.fontSize,
          weight: buttonStyle.fontWeight,
          height: buttonStyle.height,
          radius: buttonStyle.borderRadius,
          inputFont: inputStyle.fontSize,
          inputFamily: inputStyle.fontFamily,
          border: buttonStyle.borderColor,
          expectedBorder: expectedStyle.borderColor,
          hint: getComputedStyle(hint).fontSize,
          primary: expectedStyle.color,
          selected: expectedStyle.backgroundColor,
        });
      }
    }
  } finally {
    probe.remove();
    if (savedTheme === undefined) delete root.dataset.theme;
    else root.dataset.theme = savedTheme;
  }
  return results;
};

module.exports = async function assertWorkspaceStyles(win) {
  const results = await win.webContents.executeJavaScript('(' + collectStyleEvidence.toString() + ')()');
  const luminance = color => {
    const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3)
      .map(value => Number(value) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  for (const result of results) {
    const label = result.theme + '/' + result.scope;
    assert.equal(result.buttonFont, '13px', label + '：同类按钮字号不随父容器变化');
    assert.equal(result.weight, '500', label + '：字重不能被基础继承覆盖');
    assert.equal(result.height, '32px', label + '：常规按钮高度一致');
    assert.equal(result.radius, '6px', label + '：公共控件圆角一致');
    assert.equal(result.inputFont, '12px', label + '：紧凑输入字号生效');
    assert.match(result.inputFamily, /Cascadia Mono/, label + '：技术输入保留等宽字体');
    assert.equal(result.border, result.expectedBorder, label + '：输入边框颜色不能被全局规则覆盖');
    assert.equal(result.hint, '12px', label + '：辅助信息字号一致');
    const foreground = luminance(result.primary);
    const background = luminance(result.selected);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    assert.ok(contrast >= 4.5, label + '：选中态文字对比度至少为 4.5');
  }
};
