const assert = require('node:assert/strict');
const { version } = require('../package.json');

module.exports = async function exerciseSettings({ evaluate, install = false, initialCodexStatus = "尚未配置", capture = null, paint = null }) {
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
  assert.equal(await evaluate('document.querySelector("[data-testid=settings-cloud]").textContent'), '云同步');
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
  await waitFor('document.querySelector("[data-testid=codex-status]")?.textContent === ' + JSON.stringify(initialCodexStatus), 'Codex 检测');
  assert.equal(await evaluate('document.querySelector("[data-testid=codex-advanced]").open'), false, '高级设置默认收起');
  const configured = initialCodexStatus === '已配置';
  const manualOnly = ['需要手动处理', '暂时无法检测'].includes(initialCodexStatus);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=codex-install]")?.checkVisibility())'), !configured && !manualOnly, '主要操作只在需要配置时显示');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=codex-next-steps]"))'), configured);
  if (configured) {
    if (paint) await paint();
    assert.match(await evaluate('document.querySelector("[data-testid=codex-status-summary]").textContent'), /本机已完成.*无需重复配置/u);
    const statusColors = await evaluate('(() => { const icon = document.querySelector("[data-testid=codex-status-summary] svg"); const title = document.querySelector("[data-testid=codex-status]"); return { icon: getComputedStyle(icon).color, title: getComputedStyle(title).color, iconClass: icon.getAttribute("class"), titleClass: title.className }; })()');
    assert.equal(statusColors.icon, statusColors.title, '确认图标与成功文字保持一致：' + JSON.stringify(statusColors));
    assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector("[data-testid=codex-status]")).fontSize) >= 24'), '成功状态应醒目');
  }
  if (capture) await capture('settings-agent');
  const setAdvanced = async open => {
    if (await evaluate('document.querySelector("[data-testid=codex-advanced]").open') !== open) {
      await evaluate('(() => { const summary = document.querySelector("[data-testid=codex-advanced] > summary"); summary.focus(); summary.click(); })()');
      await waitFor('document.querySelector("[data-testid=codex-advanced]").open === ' + open, '高级设置切换');
    }
  };
  if (manualOnly) {
    await click('codex-help');
    await waitFor('document.querySelector("[data-testid=codex-advanced]").open', '处理方式可展开');
  } else await setAdvanced(true);
  assert.equal(await evaluate('document.querySelector("[data-testid=codex-config-path]").checkVisibility()'), true);
  await evaluate('document.querySelector("[data-testid=codex-manual]").open = true');
  assert.equal(await evaluate('document.querySelector("[data-testid=codex-manual] pre").textContent.includes("agent-ops")'), true);
  await evaluate('document.querySelector("[data-testid=codex-manual]").open = false');
  await setAdvanced(false);
  if (install) {
    await click('codex-install');
    await waitFor('document.querySelector("[data-testid=codex-status]")?.textContent === "已配置"', 'Codex 接入');
    await waitFor('!document.querySelector("[data-testid=codex-install]").disabled', '接入完成');
    assert.match(await evaluate('document.querySelector("[data-testid=codex-install]").textContent'), /重新配置/u);
    assert.equal(await evaluate('document.querySelector("[data-testid=codex-install]").checkVisibility()'), false, '接入成功后自动收起重新配置');
    await waitFor('document.activeElement?.dataset.testid === "codex-status"', '成功后聚焦状态');
    await setAdvanced(true);
    const previousBackup = await evaluate('document.querySelector("[data-testid=codex-backup]").textContent');
    await click('codex-install');
    await waitFor('!document.querySelector("[data-testid=codex-install]").disabled && document.querySelector("[data-testid=codex-backup]")?.textContent !== ' + JSON.stringify(previousBackup), '再次接入完成');
    assert.equal(await evaluate('document.querySelector("[data-testid=codex-status]").textContent'), '已配置');
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
