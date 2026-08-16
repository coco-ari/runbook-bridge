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
  assert.match(renderer, /slice\(0,2\)/);
  assert.match(renderer, /插件草稿已保存；补齐配置后才能连接/);
  assert.match(renderer, /Agent 已添加插件/);
  assert.match(styles, /\.confirmation-button/);
  assert.match(styles, /\.delete-blockers/);

  assert.match(preload, /contextBridge\.exposeInMainWorld\('aiOps', \{\s*v2:/s);
  assert.match(preload, /v2:plugin-delete/);
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
