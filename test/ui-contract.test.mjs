import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('production renderer exposes only the structured V2 operations surface', async () => {
  const [html, renderer, styles, preload, main, manifest] = await Promise.all([
    fs.readFile('renderer/v2/index.html', 'utf8'),
    fs.readFile('renderer/v2/app.js', 'utf8'),
    fs.readFile('renderer/v2/styles.css', 'utf8'),
    fs.readFile('src/preload.cjs', 'utf8'),
    fs.readFile('src/main.mjs', 'utf8'),
    fs.readFile('package.json', 'utf8'),
  ]);

  assert.match(html, /id="moreEnvironments"/);
  assert.match(html, /id="confirmationButton"/);
  assert.match(html, /id="deletePluginDialog"/);
  assert.match(html, /id="queryDatabases"/);
  assert.match(html, /id="toggleProjectRail"/);
  assert.match(html, /id="projectRailResizeHandle"/);
  assert.match(html, /id="projectOverviewStats"/);
  assert.match(html, /id="projectOverviewAttention"/);
  assert.match(html, /id="projectOverviewActivity"/);
  assert.match(html, /id="overviewAddEnvironment"/);
  assert.doesNotMatch(html, /id="overviewManageEnvironments"/);
  assert.match(html, /id="projectSettingsDialog"/);
  assert.match(html, /id="deleteProjectDialog"/);
  assert.match(html, /data-password-target="pluginPassword"/);
  assert.match(html, /<th>发起者<\/th>/);
  assert.doesNotMatch(html, /id="pluginSearch"|id="pluginTypeFilter"|id="pluginStatusFilter"|plugin-filters/);
  assert.doesNotMatch(renderer, /pluginFilter|clear-plugin-filter/);
  assert.doesNotMatch(renderer, /manager-current|当前查看/);
  assert.match(renderer, /prepare-delete-plugin/);
  assert.match(renderer, /listPluginDatabases/);
  assert.match(renderer, /revealCredential/);
  assert.match(renderer, /navigationGeneration/);
  assert.match(renderer, /projectRailExpanded/);
  assert.match(renderer, /PROJECT_RAIL_WIDTH_KEY/);
  assert.match(renderer, /setPointerCapture/);
  assert.match(renderer, /resourcePreview/);
  assert.match(renderer, /data-overview-rename-environment/);
  assert.match(renderer, /data-overview-delete-environment/);
  assert.doesNotMatch(renderer, /data-overview-manage-environment/);
  assert.match(renderer, /data-overview-add-resource/);
  assert.match(renderer, /handleOverviewPluginRuntimeAction/);
  assert.match(renderer, /function runtimeFacts/);
  assert.match(renderer, /USER_DISCONNECTED/);
  assert.match(renderer, /连接未连接项/);
  assert.match(renderer, /connected > 0 \|\| runtime\.phase === 'reconnecting'/);
  assert.match(renderer, /environment-overview-issue empty/);
  assert.doesNotMatch(renderer, /environment-type-chips/);
  assert.match(renderer, /loadProjectOverviewActivity/);
  assert.match(renderer, /filter\(overviewActivityVisible\)\.slice\(0,5\)/);
  assert.match(renderer, /本机保存的凭据会继续保留/);
  assert.match(renderer, /data-project-settings/);
  assert.match(renderer, /api\.deleteProject/);
  assert.match(renderer, /slice\(0,2\)/);
  assert.match(renderer, /插件草稿已保存；补齐配置后才能连接/);
  assert.match(renderer, /Agent 已添加插件/);
  assert.match(renderer, /任意绝对路径；敏感内容也原样返回/);
  assert.match(renderer, /所有服务器变更逐次确认/);
  assert.match(renderer, /data-approval-level/);
  assert.doesNotMatch(renderer, /data-policy-key|save-policy|discard-policy/);
  assert.doesNotMatch(preload, /savePolicy|v2:plugin-policy/);
  assert.match(styles, /\.confirmation-button/);
  assert.match(styles, /\.policy-state\.strong/);
  assert.match(styles, /\.delete-blockers/);
  assert.match(styles, /\.project-rail-resize-handle/);
  assert.match(styles, /\.project-overview-stats/);
  assert.match(styles, /\.environment-resource-row/);
  assert.match(styles, /\.environment-resource-action/);
  assert.match(styles, /\.overview-attention-row:only-child/);
  assert.match(styles, /\.environment-overview-issue\.empty/);

  assert.match(preload, /contextBridge\.exposeInMainWorld\('aiOps', \{\s*v2:/s);
  assert.match(preload, /v2:plugin-delete/);
  assert.match(preload, /v2:project-delete/);
  assert.match(preload, /v2:plugin-databases/);
  assert.match(preload, /v2:confirmation-list/);
  assert.doesNotMatch(preload, /project:delete/);
  assert.doesNotMatch(preload, /project:execute/);
  assert.doesNotMatch(preload, /project:upload/);
  assert.doesNotMatch(preload, /project:download/);
  assert.doesNotMatch(main, /registerIpc\(/);
  assert.doesNotMatch(main, /new SshBroker/);

  const packageJson = JSON.parse(manifest);
  assert.ok(packageJson.build.files.includes('renderer/v2/**/*'));
  assert.ok(!packageJson.build.files.includes('renderer/**/*'));
  assert.ok(packageJson.build.files.includes('!src/mcp.mjs'));
});
