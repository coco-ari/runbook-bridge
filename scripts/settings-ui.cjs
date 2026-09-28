const assert = require('node:assert/strict');
const { version } = require('../package.json');

module.exports = async function exerciseSettings({ evaluate, install = false, capture = null, paint = null }) {
  const waitFor = async (expression, label) => {
    for (let index = 0; index < 100; index += 1) {
      if (await evaluate(expression)) return;
      if (paint) await paint();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`配置页面等待超时：${label}`);
  };
  const click = async testId => {
    await waitFor(`Boolean(document.querySelector('[data-testid="${testId}"]:not(:disabled)'))`, testId);
    await evaluate(`(() => { const target = document.querySelector('[data-testid="${testId}"]'); target.focus(); target.click(); })()`);
  };
  if (!await evaluate('Boolean(document.querySelector("[data-testid=settings-page]"))')) await click('settings-open');
  await click('settings-appearance');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=settings-version]"))'), false, '外观页不再显示版本信息');
  await click('settings-about');
  await waitFor('Boolean(document.querySelector("[data-testid=about-version]"))', '关于页');
  assert.equal(await evaluate('document.querySelector("[data-testid=about-version]").textContent'), version);
  assert.equal(await evaluate('document.querySelector("[data-testid=settings-version]").textContent.includes("https://github.com/coco-ari/runbook-bridge")'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=about-github]"))'), true);
  assert.equal(await evaluate('document.activeElement.id'), 'settings-heading');
  if (capture) await capture('settings-about');
  await click('settings-agent');
  await waitFor('document.querySelector("[data-testid=codex-status]")?.textContent === "未配置"', 'Codex 检测');
  assert.equal(await evaluate('document.querySelector("[data-testid=codex-install]").disabled'), false);
  await evaluate('document.querySelector("[data-testid=codex-integration-panel] details").open = true');
  assert.equal(await evaluate('document.querySelector("[data-testid=codex-integration-panel] pre").textContent.includes("agent-ops")'), true);
  await evaluate('document.querySelector("[data-testid=codex-integration-panel] details").open = false');
  if (capture) await capture('settings-agent');
  if (install) {
    await click('codex-install');
    await waitFor('document.querySelector("[data-testid=codex-status]")?.textContent === "已配置"', 'Codex 接入');
    assert.equal(await evaluate('document.querySelector("[data-testid=codex-install]").disabled'), true);
    assert.match(await evaluate('document.querySelector("[data-testid=codex-notice]").textContent'), /重新打开 Codex/u);
    await click('codex-refresh');
    await waitFor('!document.querySelector("[data-testid=codex-refresh]").disabled', '重新检测');
    assert.equal(await evaluate('document.querySelector("[data-testid=codex-status]").textContent'), '已配置');
  }
  assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  await click('settings-back');
  await waitFor('!document.querySelector("[data-testid=settings-page]")', '返回工作台');
  await waitFor('document.activeElement?.dataset.testid === "settings-open"', '恢复配置入口焦点');
};
