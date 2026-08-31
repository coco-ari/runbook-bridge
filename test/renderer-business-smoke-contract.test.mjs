import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('business mutation smoke stays isolated, scoped and wired into package checks',async () => {
  const [source,manifestSource] = await Promise.all([
    fs.readFile('scripts/ui-react-business-smoke.cjs','utf8'),
    fs.readFile('package.json','utf8'),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.match(manifest.scripts['test:ui:business'],/build:renderer.*ui-react-business-smoke\.cjs/u);
  assert.match(manifest.scripts.check,/node scripts\/check-syntax\.mjs/u);

  assert.match(source,/fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\),'runbook-bridge-business-smoke-'\)\)/u);
  assert.match(source,/new BrowserWindow\(\{[\s\S]*?width:960,[\s\S]*?height:640,/u);
  assert.match(source,/preload:path\.join\(root,'src','preload\.cjs'\)/u);
  assert.match(source,/contextIsolation:true/u);
  assert.match(source,/nodeIntegration:false/u);
  assert.match(source,/sandbox:true/u);
  assert.match(source,/session\.defaultSession\.webRequest\.onBeforeRequest/u);
  assert.match(source,/assert\.deepEqual\(externalRequests,\[\]\)/u);
  assert.match(source,/assert\.deepEqual\(forbiddenCalls,\[\]\)/u);
  assert.match(source,/assertSurface\(win,'\[data-testid="create-project-dialog"\]','创建项目'\)/u);
  assert.match(source,/assertSurface\(win,'\[data-testid="environment-settings-dialog"\]','保存名称'\)/u);
  assert.doesNotMatch(source,/project-settings-sheet|environment-settings-sheet/u);
  assert.match(source,/project deletion still requires the exact typed name/u);
  assert.match(source,/the last environment must remain protected from deletion/u);
  assert.match(source,/cancelling environment deletion must not mutate/u);
  assert.match(source,/assertOneScopeSuccessToast/u);
  assert.match(source,/CONFIG_REVISION_CONFLICT/u);
  assert.match(source,/RUNBOOK_BRIDGE_SCREENSHOT_DIR/u);
  assert.match(source,/if \(!screenshotRoot\) return/u);
  assert.match(source,/Screenshot evidence must be written outside the repository/u);

  for (const channel of [
    'v2:project-create',
    'v2:project-update',
    'v2:environment-create',
    'v2:environment-update',
    'v2:runbook-save',
    'v2:quick-question-save',
    'v2:quick-question-delete',
  ]) {
    assert.match(source,new RegExp(channel,'u'));
  }

  assert.match(source,/bytes:Buffer\.byteLength\(content,'utf8'\)/u);
  assert.match(source,/hash:crypto\.createHash\('sha256'\)/u);
  assert.match(source,/empty:!content\.trim\(\)/u);
  assert.match(source,/createdAt:timestamp,[\s\S]*updatedAt:timestamp/u);
  assert.match(source,/item\.updatedAt = nextQuestionTimestamp\(\)/u);
  assert.match(source,/schemaVersion:1,[\s\S]*text:'请使用 AI Ops MCP/u);
  assert.doesNotMatch(source,/item\.revision/u);
  assert.doesNotMatch(source,/require\(['"]\.\.\/src\/(?:main|v2-service|workspace-store)/u);
});

test('quick-question smoke validates inline drafts, guarded navigation and exact global-opening conflicts',async () => {
  const source = await fs.readFile('scripts/ui-react-business-smoke.cjs','utf8');
  const questionFlow = source.slice(source.indexOf('const questionEditorSelector ='));
  const inlineCapture = source.slice(source.indexOf('async function captureInlineEditorEvidence('),source.indexOf('async function attemptDetailTab('));
  assert.match(questionFlow,/data-testid="common-question-inline-editor"/u);
  assert.match(questionFlow,/data-testid="quick-opening-inline-editor"/u);
  assert.doesNotMatch(questionFlow,/add question dialog|edit question dialog|assertSurface\(win,'\[role="dialog"\]'/u);
  assert.match(questionFlow,/const deleteSurfaceSelector = '\[role="alertdialog"\]'/u);
  assert.match(questionFlow,/await assertInlineDraft\(win,/u);
  assert.match(questionFlow,/await attemptDetailTab\(win,'runbook'\)/u);
  assert.match(questionFlow,/dismissDirtyLeave\(win,'返回编辑'\)/u);
  assert.match(questionFlow,/dismissDirtyLeave\(win,'放弃更改'\)/u);
  assert.match(questionFlow,/dismissDirtyLeave\(win,'Escape'\)/u);
  assert.match(questionFlow,/declining a dirty tab change restores the question draft field/u);
  assert.match(questionFlow,/draft epoch remount/u);
  assert.match(questionFlow,/in-flight question saves must block project navigation/u);
  assert.match(questionFlow,/busy question navigation must not duplicate the mutation/u);
  assert.match(questionFlow,/unchanged collection revision must not mark the question draft stale/u);
  assert.match(questionFlow,/the global opening editor must explicitly state that it affects every environment/u);
  assert.match(questionFlow,/external opening refresh must disable stale saves while keeping the draft/u);
  assert.match(questionFlow,/openingConflictCall\.payload,\{text:openingDraft,expectedRevision:4\}/u);
  assert.match(questionFlow,/openingSavedCall\.payload,\{text:openingDraft,expectedRevision:5\}/u);
  assert.match(questionFlow,/common questions must not leak into the other environment/u);
  assert.match(source,/if \(questionSaveHold\) await questionSaveHold/u);

  const originalMutationSequence = /assert\.deepEqual\(mutationCalls\.map\(\(entry\) => entry\.channel\),\[\s*'v2:project-create',\s*'v2:project-update',\s*'v2:project-update',\s*'v2:environment-create',\s*'v2:environment-update',\s*'v2:runbook-save',\s*'v2:quick-question-save',\s*'v2:quick-question-save',\s*'v2:quick-question-delete',\s*\]\);/u;
  const originalSequence = originalMutationSequence.exec(source);
  assert.ok(originalSequence,'the original nine-mutation assertion must remain exact');
  const openingCaseOffset = source.indexOf("ipcMain.removeHandler('v2:quick-question-opening-save')");
  assert.ok(openingCaseOffset > originalSequence.index+originalSequence[0].length,
    'opening-save is allowed only after the original exact-payload case has finished');
  const forbidden = source.match(/\[\s*'v2:project-delete',[\s\S]*?\]\.forEach\(registerForbidden\)/u)?.[0] ?? '';
  for (const channel of ['quick-question-opening-save','quick-question-copy','environment-delete','connection-intent','plugin-connection-edit-save','confirmation-approve']) {
    assert.ok(forbidden.includes(`v2:${channel}`),`${channel} must remain forbidden in the original business case`);
  }

  assert.match(inlineCapture,/\[\[960,640\],\[1280,820\],\[1920,1080\]\]/u);
  assert.match(inlineCapture,/for \(const part of \['editor','actions'\]\)/u);
  assert.match(inlineCapture,/scrollIntoView/u);
  assert.match(inlineCapture,/geometry\.modalCount,0/u);
  assert.match(inlineCapture,/geometry\.inlineEditorCount,1/u);
  assert.match(inlineCapture,/geometry\.descriptionIdsPresent,true/u);
  assert.match(inlineCapture,/geometry\.partUnobscured,true/u);
  assert.match(inlineCapture,/geometry\.actionHeightsMatch,true/u);
  assert.match(inlineCapture,/geometry\.editorOverflow <= 1/u);
  assert.match(inlineCapture,/captureRenderedFrame\(win\)/u);
  assert.doesNotMatch(inlineCapture,/\.style\.|insertCSS|settleAnimations|\.finish\(/u);
  assert.match(source,/webContents\.invalidate\(\)/u);
  assert.match(source,/if \(contentWidth === width && contentHeight === height\) continue/u);
});

test('business keyboard checks use real Chromium focus and native key input',async () => {
  const source = await fs.readFile('scripts/ui-react-business-smoke.cjs','utf8');
  assert.match(source,/async function focusRenderer\(win\) \{\s*win\.webContents\.focus\(\);\s*await waitFor\(win,'document\.hasFocus\(\) === true'/u);
  assert.match(source,/on\('did-finish-load',\(\) => win\.webContents\.focus\(\)\)/u);
  assert.match(source,/await win\.loadFile\(pagePath\);\s*await focusRenderer\(win\)/u);
  assert.match(source,/async function pressRendererKey\(win,keyCode,modifiers = \[\]\) \{\s*await focusRenderer\(win\);/u);
  assert.match(source,/backgroundHidden/u);
  assert.match(source,/backgroundControls\.every\(\(element\) => element\.closest\('\[aria-hidden="true"\],\[inert\]'\)\)/u);
  assert.match(source,/preservedLiveRegions/u);
  assert.match(source,/must restore attempted background focus into its modal/u);
  assert.match(source,/must trap real/u);
  assert.match(source,/assert\.equal\(mutationCalls\.length,13/u);
  assert.match(source,/clearing the last entry focuses the surviving refresh action/u);
  assert.match(source,/sendInputEvent\(\{type:'keyDown',keyCode,modifiers\}\)/u);
  assert.match(source,/focus\.focusInCount,1/u);
  assert.match(source,/focus\.trustedFocusInCount,1/u);
  assert.doesNotMatch(source,/new (?:FocusEvent|KeyboardEvent)\(/u);
  assert.match(source,/assertFocusWithin\(win,'#common-question-editor'/u);
  assert.match(source,/assertFocusWithin\(win,'#quick-opening-editor'/u);
});

test('business recovery smoke exercises retries and destructive lifecycle actions after the original bounded cases',async () => {
  const source = await fs.readFile('scripts/ui-react-business-smoke.cjs','utf8');
  const recovery = source.slice(source.indexOf('async function assertBusinessRecoveryAndLifecycle('),source.indexOf('async function run()'));
  for (const scenario of [
    'runbook conflict preserves editable draft',
    'runbook retry saves preserved draft',
    'runbook cancellation must not overwrite the saved document',
    'copy conflict refreshes opening before retry',
    'audit query filters visible rows',
    'audit outcome filter',
    'strong approvals require explicit acknowledgement',
    'confirmation queue cannot expose another environment',
    'failed approval keeps retry available',
    'rejected request removed',
    'invalid environment form cannot reach IPC',
    'invalid project form cannot reach IPC',
    'recreated environment receives a fresh identity',
    'recreated project receives a fresh identity',
  ]) assert.ok(recovery.includes(scenario),scenario);
  assert.match(recovery,/assert\.deepEqual\(mutationCalls\.slice\(start\)\.map\(entry => entry\.channel\),expected/u);
  const finalFlow = source.indexOf("await assertBusinessRecoveryAndLifecycle(win,{projectId:'project-created'");
  assert.ok(finalFlow > source.indexOf('assert.equal(mutationCalls.length,13'),
    'additional delete/recreate and confirmation actions remain outside the original thirteen-write case');
});
