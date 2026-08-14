import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('renderer exposes project lifecycle, document editing, and per-project command policy controls', async () => {
  const [html, renderer, styles, preload, main] = await Promise.all([
    fs.readFile('renderer/index.html', 'utf8'),
    fs.readFile('renderer/app.js', 'utf8'),
    fs.readFile('renderer/styles.css', 'utf8'),
    fs.readFile('src/preload.cjs', 'utf8'),
    fs.readFile('src/main.mjs', 'utf8'),
  ]);
  assert.match(html, /id="delete-project"/);
  assert.match(html, /id="document-dialog"/);
  assert.match(html, /name="rememberCredentials"/);
  assert.match(html, /name="commandPolicyEnabled"/);
  assert.match(html, /name="customDeny"/);
  assert.doesNotMatch(html, /name="accessMode"/);
  assert.doesNotMatch(renderer, /accessMode/);
  assert.doesNotMatch(html, /name="displayTimezone"/);
  assert.doesNotMatch(renderer, /displayTimezone/);
  assert.doesNotMatch(html, /name="allowedLogRoots"/);
  assert.doesNotMatch(renderer, /allowedLogRoots/);
  assert.doesNotMatch(renderer, /window\.prompt/);
  assert.match(renderer, /window\.aiOps\.updateProject/);
  assert.match(renderer, /window\.aiOps\.deleteProject/);
  assert.match(renderer, /documentDialog\.showModal/);
  assert.match(renderer, /project\.credentialsSaved/);
  assert.match(renderer, /project\.commandPolicy\?\.enabled/);
  assert.match(renderer, /project\.status\.reconnecting/);
  assert.match(renderer, /停止重连/);
  assert.match(renderer, /SSH 正在自动重连/);
  assert.match(renderer, /SSH 自动重连已停止/);
  assert.match(renderer, /SSH_AUTH_FAILED/);
  assert.match(renderer, /customDeny\.value\.split/);
  assert.match(renderer, /loadedDocumentKey !== currentDocumentKey\(\)/);
  assert.match(renderer, /state\.documentDirty = true/);
  assert.match(renderer, /if \(!saved\.verified\)/);
  assert.match(html, /id="document-save-state"/);
  assert.match(renderer, /function continueCreatedProjectAsConnect/);
  assert.match(renderer, /projectCreated = true;\s+continueCreatedProjectAsConnect\(created\.project\)/);
  assert.match(renderer, /项目已经创建，但连接失败/);
  assert.match(styles, /\.project-list\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.sidebar-button\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(preload, /project:delete/);
  assert.match(preload, /project:trust-host-key-change/);
  assert.match(main, /shell\.trashItem/);
  assert.match(main, /host-key-change-approved/);
});
