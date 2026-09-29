const assert = require('node:assert/strict');

module.exports = async function (evaluate, prefix, { connected, pending = false }) {
  const action = connected ? 'disconnect' : 'reconnect';
  const result = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="' + ${JSON.stringify(prefix)} + '-${action}"]')];
    const button = buttons[0];
    if (!button) return null;
    window.__workspaceConnectionButtons ??= {};
    const previous = window.__workspaceConnectionButtons[${JSON.stringify(prefix)}];
    window.__workspaceConnectionButtons[${JSON.stringify(prefix)}] = button;
    return {
      count: buttons.length, header: Boolean(button.closest('header')), disabled: button.disabled,
      label: button.textContent.trim(), sameButton: !previous || previous === button
    };
  })()`);
  assert.ok(result, '工作区应提供连接操作');
  assert.equal(result.count, 1, '工作区连接操作不重复');
  assert.equal(result.header, true, '连接操作始终位于顶部');
  assert.equal(result.sameButton, true, '断开与重连复用同一个按钮');
  assert.equal(result.disabled, false, '已有连接计划时允许取消，空闲时允许连接操作');
  assert.equal(result.label, pending ? '取消连接' : connected ? '断开连接' : prefix === 'server-workspace' ? '重新连接服务器' : '重新连接');
};
