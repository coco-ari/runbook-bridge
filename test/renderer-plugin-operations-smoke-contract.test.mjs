import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const smokePath = path.join(root,'scripts','ui-react-plugin-operations-smoke.cjs');

test('Electron direct CLI starts the plugin smoke while matrix import does not start a second run',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  const entry = source.slice(source.indexOf('const isDirectEntry ='));
  assert.ok(entry.startsWith('const isDirectEntry ='),'smoke has an explicit Electron-compatible entry');
  for (const [entryPath,expectedRuns] of [
    [smokePath,1],
    [path.join(root,'scripts','ui-react-plugin-editor-matrix-smoke.cjs'),0],
  ]) {
    let runs = 0;
    const exits = [];
    await runInNewContext(entry,{
      require:{main:{}},module:{},path,__filename:smokePath,
      process:{argv:['electron',entryPath,'--probe-regression-only'],stderr:{write:() => assert.fail('entry must not fail')}},
      run:async () => { runs += 1; },wait:async () => {},app:{exit:(code) => exits.push(code)},
    });
    assert.equal(runs,expectedRuns);
    assert.deepEqual(exits,expectedRuns ? [0] : []);
  }
});

test('first-plugin re-add smoke exercises the real temporary-probe boundary without recording credentials',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/await import\('\.\.\/src\/plugin-probe-manager\.mjs'\)/u);
  assert.match(source,/new PluginProbeManager\(/u);
  assert.match(source,/await probeManager\.probePluginDraft\(payload,/u);
  assert.match(source,/clone\(recordableMutationPayload\(channel,payload\)\)/u);
  assert.match(source,/assertSyntheticCredentials\(resolvedSecrets,'probe runtime input'\)/u);
  assert.match(source,/assertNoSensitivePayload\(recordable,channel\)/u);
  assert.match(source,/assert\.equal\(actual === value,true,/u);
  const regression = source.slice(source.indexOf('async function assertFirstPluginAfterDeletion(win)'),source.indexOf('async function run()'));
  assert.match(regression,/for \(const pluginType of \['server','redis'\]\)/u);
  assert.match(regression,/deletePluginThroughUi\(win,plugin\.pluginInstanceId\)/u);
  assert.match(regression,/state\.plugins\.length,0,'re-add starts only after deleting the last plugin'/u);
  assert.match(regression,/clickText\(win,'检查连接',EDITOR_SELECTOR\)/u);
  assert.match(regression,/plugin-save-disconnected/u);
  assert.match(regression,/Object\.hasOwn\(payload,'credentialIntent'\),false/u);
  assert.match(regression,/Object\.hasOwn\(payload,'oneTimeGrant'\),false/u);
  assert.match(regression,/usesTemporaryCredentials:true/u);
  assert.match(regression,/usesTemporaryCredentials:false/u);
  assert.doesNotMatch(regression,/capturePage|captureSurfaceEvidence|capturePluginWorkspaceEvidence/u);
  assert.ok(source.lastIndexOf('await assertFirstPluginAfterDeletion(win);') > source.indexOf('await assertEnvironmentDetailsLifecycle(win);'));
  assert.match(source,/app\.commandLine\.hasSwitch\('probe-regression-only'\)/u);
  assert.match(source,/await assertFirstPluginAfterDeletion\(win\);\s+await assertSmokeSafety\(\);/u);
});

test('plugin operations smoke stays isolated, scoped and credential-free',async () => {
  const [source,manifestSource] = await Promise.all([
    fs.readFile(smokePath,'utf8'),
    fs.readFile(path.join(root,'package.json'),'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.match(manifest.scripts['test:ui:plugins'],/build:renderer.*ui-react-plugin-operations-smoke\.cjs/u);
  assert.match(manifest.scripts.check,/node --check scripts\/ui-react-plugin-operations-smoke\.cjs/u);

  assert.match(source,/new BrowserWindow\(\{[\s\S]*?width:960,[\s\S]*?height:640,/u);
  assert.match(source,/preload:path\.join\(root,'src','preload\.cjs'\)/u);
  assert.match(source,/contextIsolation:true/u);
  assert.match(source,/nodeIntegration:false/u);
  assert.match(source,/sandbox:true/u);
  assert.match(source,/session\.defaultSession\.webRequest\.onBeforeRequest/u);
  assert.match(source,/externalRequests\.push\(details\.url\)/u);
  assert.match(source,/assert\.deepEqual\(externalRequests,\[\]\)/u);

  for (const channel of [
    'v2:plugin-create',
    'v2:plugin-connection-edit-prepare',
    'v2:plugin-connection-edit-begin',
    'v2:plugin-draft-validate',
    'v2:plugin-connection-edit-save',
    'v2:connection-intent',
    'v2:connection-challenge-confirm',
    'v2:confirmation-approve',
  ]) {
    assert.match(source,new RegExp(channel,'u'));
  }

  for (const rawStrategy of [
    'stay-disconnected',
    'connect-current',
    'restore-pre-edit-set',
  ]) {
    assert.match(source,new RegExp(`assertEditSavePayload\\([\\s\\S]*?'${rawStrategy}'`,'u'));
  }

  assert.match(source,/exactKeys\(payload,\['editSessionId','patch','expectedRevision','afterCommit','credentialIntent','discardTemporarySecrets'\]/u);
  assert.match(source,/exactKeys\(payload,\[[\s\S]*?'projectId','environmentId','pluginInstanceId','intent','requestId','source','planId'/u);
  assert.match(source,/assert\.equal\(cancel\.planId,pendingConnect\.planId\)/u);
  assert.match(source,/assert\.equal\(calls\('v2:connection-challenge-confirm'\)\.length,0/u);

  assert.match(source,/LONG_FINGERPRINT/u);
  assert.match(source,/long host-key fingerprint must wrap/u);
  assert.match(source,/assertSurfaceGeometry/u);
  assert.match(source,/assertFocusLoop/u);
  assert.match(source,/strong confirmation must be gated before acknowledgement/u);
  assert.match(source,/strong confirmation must unlock only after acknowledgement/u);
  assert.match(source,/assertNoSensitivePayload/u);
  assert.match(source,/no credentials logged/u);

  assert.doesNotMatch(source,/https?:\/\//u,'the smoke must not embed or contact network endpoints');
  assert.match(source,/RUNBOOK_BRIDGE_SCREENSHOT_DIR/u);
  assert.match(source,/if \(!screenshotRoot\) return/u);
  assert.match(source,/Screenshot evidence must be written outside the repository/u);
  assert.match(source,/setExactViewport\(win,1280,820\)/u);
});

test('plugin smoke distinguishes non-modal workspace navigation from safety-dialog focus traps',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/const EDITOR_SELECTOR = '\[data-testid="plugin-editor-workspace"\]'/u);
  assert.match(source,/const DISCARD_SELECTOR = '\[data-testid="plugin-unsaved-changes-confirmation"\]'/u);
  assert.doesNotMatch(source,/plugin-editor-sheet/u);
  assert.match(source,/assertWorkspaceGeometry/u);
  assert.match(source,/assertWorkspaceKeyboardNavigation/u);
  assert.match(source,/assertNativeFocusEvents/u);
  assert.match(source,/win\.webContents\.focus\(\)/u);
  assert.match(source,/document\.hasFocus\(\)/u);
  assert.match(source,/keyboard checks require real native focus events, not only activeElement changes/u);
  assert.match(source,/Array\(24\)\.fill\(false\),\.\.\.Array\(8\)\.fill\(true\)/u);
  assert.doesNotMatch(source,/new FocusEvent/u);
  assert.match(source,/plugin editor must be mounted inside the third panel/u);
  assert.match(source,/plugin workspace must not use dialog or modal semantics/u);
  assert.match(source,/plugin workspace must not add a Sheet\/Dialog overlay/u);
  assert.match(source,/plugin workspace must preserve one visible skip-link main target/u);
  assert.match(source,/non-modal editor must allow keyboard navigation back to project\/resource panes/u);
  assert.match(source,/plugin editor causes page-level horizontal overflow/u);
  assert.match(source,/\[\[960,640\],\[1280,820\],\[1920,1080\]\]/u);
  assert.match(source,/capturePluginWorkspaceEvidence/u);
  assert.match(source,/editor screenshot waits for the existing Sonner toast to disappear naturally/u);
  assert.match(source,/async function assertResourceAccordionBounds/u);
  assert.match(source,/dynamic plugin rows must not be clipped by a stale accordion-content height/u);
  assert.match(source,/assertResourceAccordionBounds\(win,'after dynamically adding a Redis plugin'\)/u);
  assert.match(source,/assertResourceAccordionBounds\(win,'entering the existing plugin editor'\)/u);
  assert.match(source,/if \(name === 'cancel-failure-retains-draft'\) await assertPluginEditorErrorVisible\(win\)/u);
  assert.match(source,/plugin cancellation error must be inside the current viewport/u);
  assert.match(source,/plugin editor errors must not be buried at the end of the scrollable form/u);
  assert.doesNotMatch(source,/assertFocusLoop\(win,EDITOR_SELECTOR\)/u);
  assert.match(source,/assertFocusLoop\(win,'\[data-testid="runtime-host-key-confirmation"\]'\)/u);
  assert.match(source,/assertFocusLoop\(win,'\[data-testid="plugin-editor-confirmation"\]'\)/u);
  assert.match(source,/assertFocusLoop\(win,DISCARD_SELECTOR\)/u);
});

test('plugin smoke diagnoses ResizeObserver failures without suppressing console errors',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/if \(level >= 2\) rendererErrors\.push\(message\)/u);
  assert.match(source,/message\.includes\('ResizeObserver loop'\)/u);
  assert.match(source,/const step = currentStep/u);
  assert.match(source,/rendererErrorDiagnostics\.push\(\{step,message,\.\.\.snapshot\}\)/u);
  assert.match(source,/viewport:\[window\.innerWidth,window\.innerHeight\]/u);
  assert.match(source,/panels:\[\.\.\.document\.querySelectorAll\('\[data-slot="resizable-panel"\]'\)\]/u);
  assert.match(source,/assert\.deepEqual\(rendererErrors,\[\],/u);
  assert.doesNotMatch(source,/rendererErrors\.filter|rendererErrors\.splice|rendererErrors\.length\s*=\s*0/u);
  assert.doesNotMatch(source,/RUNBOOK_BRIDGE_RESIZE_TRACE|__smokeResizeTrace|NativeResizeObserver|resizeTrace:/u,'the default smoke must not retain temporary ResizeObserver instrumentation or trace-only branches');
  assert.doesNotMatch(source,/(?:window|globalThis)\s*(?:\.ResizeObserver|\[['"]ResizeObserver['"]\])\s*=/u,'the smoke must preserve native ResizeObserver delivery without an override');
});

test('plugin smoke blocks dirty and busy navigation until exact edit-session cleanup succeeds',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/editor preparation must preserve exact scope and revision/u);
  assert.match(source,/exactKeys\(payload,\['projectId','environmentId','pluginInstanceId','expectedRevision'\]/u);
  assert.match(source,/exactKeys\(call\.payload,\['editSessionId','restorePreEditConnections'\]/u);
  assert.match(source,/assert\.deepEqual\(call\.payload,\{editSessionId,restorePreEditConnections:true\}/u);
  assert.match(source,/assertPluginWorkspaceNavigation\(win,disconnectedCreate\.payload\.input\.pluginInstanceId\)/u);
  const saveSequence = source.indexOf("assertEditSavePayload(await saveExistingPlugin(win,'restore-pre-edit-set',2)");
  const navigationSequence = source.indexOf('await assertPluginWorkspaceNavigation(win,');
  assert.ok(saveSequence > 0 && navigationSequence > saveSequence,'new navigation cases must not displace original save-strategy sessions');

  for (const expectation of [
    'opening a workspace must prepare exactly once',
    'opening a workspace must begin exactly once',
    'bounded overview must exclude the edited plugin',
    'complete scoped list must still contain the edited plugin',
    'cancelling outside the bounded preview restores the exact original plugin and tab',
    'cancelling outside the bounded preview restores the original edit trigger',
    'new plugin save selects the exact created plugin',
    'plugin save returns to the exact edited plugin',
    'background refresh must not restart edit preparation',
    'background refresh must not restart the edit session',
    'collapsing must not end the editor session',
    'collapsing must not cancel the editor',
    'Escape closes only the save menu',
    'save menu Escape restores its trigger',
    'navigation must not cancel before discard approval',
    'Escape dismisses only the dirty confirmation',
    'Escape must not cancel or leave the edit session',
    'Escape from dirty confirmation restores editor focus',
    'continue editing restores editor focus',
    'blocked navigation must retain the editor, exact scope and draft',
    'blocked navigation must retain the active edit session',
    'cancel failure remains visible in the editor',
    'failed cancellation must not trigger an unmount cleanup retry',
    'discard failure must not persist the edited host',
    'discard failure must not change the stored revision',
    'target project selected only after cancellation succeeded',
    'navigation must not silently save a draft',
    'navigation must not create a plugin',
    'workspace navigation must not initiate a connection',
    'saving must block leave instead of queuing a dirty prompt',
    'saving must not cancel the in-flight edit session',
    'save returns to the exact plugin instead of executing blocked navigation',
    'failed impact rejection must retain the preparation token for retry',
    'edit impact rejection failure is visible inside the safety confirmation',
    'impact retry must reuse the same preparation',
    'all plugin edit sessions must be saved or safely cancelled',
    'all plugin edit preparations must be consumed or safely cancelled',
  ]) assert.ok(source.includes(expectation),`missing plugin lifecycle assertion: ${expectation}`);
  assert.match(source,/state\.pendingEditCancel\.resolve\(\)/u);
  assert.match(source,/state\.pendingEditSave\.resolve\(\)/u);
  assert.match(source,/state\.cancelFailuresRemaining = 1/u);
});

test('runtime host-key prompts preserve explicit approval, exact correlation and scoped focus across every entry',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/function assertRuntimeHostKeyPayload\(payload,challenge\)/u);
  assert.match(source,/exactKeys\(payload,\['challengeId','planId','operationId','expectedRevision','decision'\]/u);
  assert.match(source,/decision:'trust-host-key'/u);
  for (const name of ['plugin-panel','environment-panel','environment-row','plugin-row']) {
    assert.ok(source.includes(`name:'${name}'`),`missing host-key owner entry ${name}`);
  }
  assert.match(source,/state\.runtimeHostKeyMode = true/u);
  assert.match(source,/state\.runtimeConfirmFailuresRemaining = 1/u);
  assert.match(source,/state\.deferNextRuntimeConfirm = true/u);
  assert.match(source,/button\.click\(\);\s+button\.click\(\)/u);
  for (const expectation of [
    'runtime host-key confirmation must bind the exact challenge, plan, operation and revision',
    'a new host-key challenge must not inherit a previous scope, challenge or error',
    'Escape must never confirm or continue a runtime host-key challenge',
    'Not trust must never confirm or continue a runtime host-key challenge',
    'restores the exact connection trigger',
    'double-click plus Escape during trust must send exactly one confirmation',
    'pending trust must keep the same modal open, focused and non-dismissible',
    'confirmation error remains inside its modal',
    'failed trust must retain the same challenge for explicit retry',
    'explicit trust retry must reuse the exact challenge payload',
    'trust retry must not silently start another connection intent',
    'later trust must not consume an escaped challenge',
    'later trust must not consume a rejected challenge',
    'removed host-key trigger restores the stable detail-workspace fallback',
    'removing the challenge owner must not trust a host key',
    'original plugin save strategies and workspace lifecycle retain the exact forty-one-call baseline',
    'host-key governance adds only twenty-one reviewed calls to the original plugin baseline',
  ]) assert.ok(source.includes(expectation),`missing host-key governance assertion: ${expectation}`);
  assert.match(source,/assert\.equal\(mutationCalls\.length,41,/u);
  assert.match(source,/assert\.equal\(mutationCalls\.length,62,/u);
  assert.match(source,/assert\.equal\(mutationCalls\.length,initialMutationCount\+21,/u);
  assert.ok(source.indexOf('await assertRuntimeHostKeyGovernance(win);') > source.indexOf('await assertPluginWorkspaceNavigation(win,'));
});

test('late and simultaneous host-key challenges queue behind the active short dialog without automatic approval',async () => {
  const source = await fs.readFile(smokePath,'utf8');
  assert.match(source,/state\.deferRuntimeChallenges = true/u);
  assert.match(source,/\[\[pluginEntry\],\[pluginEntry,environmentEntry\]\]/u);
  assert.match(source,/pending\.forEach\(\(response\) => response\.resolve\(\)\)/u);
  assert.match(source,/new MutationObserver\(record\)/u);
  assert.match(source,/Math\.max\(\.\.\.counts\),1/u);
  for (const expectation of [
    'late host-key responses must queue without stacking over the active metadata dialog or stealing focus',
    'queued host-key challenges are never auto-approved',
    'queued challenge presentation must match one exact pending host, fingerprint and scope',
    'the final queued challenge returns focus to its own exact connection trigger',
    'rejecting one challenge presents the other scope without reusing the rejected challenge',
    'rejecting sequential host-key challenges sends zero confirmations',
    'single and simultaneous late host-key responses must never stack active modal surfaces',
    'queued dialogs must not save metadata or cause hidden mutations',
  ]) assert.ok(source.includes(expectation),`missing late-challenge assertion: ${expectation}`);
  assert.match(source,/assert\.equal\(mutationCalls\.length,65,/u);
  assert.match(source,/assert\.equal\(mutationCalls\.length,initialMutationCount\+3,/u);
  assert.ok(source.indexOf('await assertDeferredHostKeyDialogs(win);') > source.indexOf('await assertRuntimeHostKeyGovernance(win);'));
});

test('connection tooltip handoff is a mandatory native-focus regression after the complete plugin baseline',async () => {
  const [source,rowSource] = await Promise.all([
    fs.readFile(smokePath,'utf8'),
    fs.readFile(path.join(root,'renderer/v2/src/features/connections/ConnectionRowAction.tsx'),'utf8'),
  ]);
  assert.match(rowSource,/const \[tooltipOpen, setTooltipOpen\] = useState\(false\)/u);
  assert.match(rowSource,/const tooltipBlocked = connection\.state\.operation !== null \|\| connection\.state\.challenge !== null/u);
  assert.match(rowSource,/if \(tooltipBlocked\) setTooltipOpen\(false\)/u);
  assert.match(rowSource,/const run = \(\) => \{\s+setTooltipOpen\(false\)/u);
  assert.match(rowSource,/onOpenChange=\{\(open\) => setTooltipOpen\(open && !tooltipBlocked\)\}/u);
  assert.match(rowSource,/open=\{tooltipOpen && !tooltipBlocked\}/u);
  assert.match(rowSource,/\{!tooltipBlocked \? <TooltipContent>\{help\}<\/TooltipContent> : null\}/u,'blocked connection tooltips must unmount, not linger in a closing Portal');
  assert.match(rowSource,/aria-label=\{help\}/u,'blocking the visual tooltip must not remove the trigger accessible name');

  const handoff = source.slice(source.indexOf('async function assertConnectionTooltipHandoff(win)'),source.indexOf('async function run()'));
  assert.match(handoff,/const initialMutationCount = mutationCalls\.length/u);
  assert.match(handoff,/const initialConfirmCount = calls\('v2:connection-challenge-confirm'\)\.length/u);
  assert.match(handoff,/iteration < 8/u);
  assert.match(handoff,/for \(const kind of \['environment','plugin'\]\)/u);
  assert.match(handoff,/for \(const dismissal of \['Escape','不信任'\]\)/u);
  assert.match(handoff,/await ensureNativeKeyboardFocus\(win\)/u);
  assert.match(handoff,/const blurred = await win\.webContents\.executeJavaScript/u);
  assert.match(handoff,/main\.focus\(\{preventScroll:true\}\)/u);
  assert.match(handoff,/getAttribute\('data-state'\) === 'closed'/u);
  assert.match(handoff,/previous tooltip close commits before keyboard refocus/u);
  assert.ok(handoff.indexOf('const focus = await') > handoff.indexOf('previous tooltip close commits before keyboard refocus'),'controlled Tooltip blur must commit before a separate native-focus task reopens it');
  assert.match(handoff,/event\.isTrusted && event\.target === target/u);
  assert.match(handoff,/target\.focus\(\{preventScroll:true\}\)/u);
  assert.match(handoff,/await waitFor\(win,[\s\S]*?\[data-slot="tooltip-content"\]/u);
  assert.match(handoff,/document\.activeElement === trigger/u);
  assert.match(handoff,/await openRuntimeHostKeyChallenge\(win,entry\)/u);
  assert.match(handoff,/assert\.equal\(remainingTooltips,0,/u);
  assert.match(handoff,/if \(dismissal === 'Escape'\) await pressEscape\(win\)/u);
  assert.match(handoff,/else await clickText\(win,'不信任',entry\.dialog\)/u);
  assert.match(handoff,/await assertRuntimeHostKeyClosed\(win,entry,/u);
  assert.match(handoff,/assert\.equal\(calls\('v2:connection-intent'\)\.length,initialIntentCount\+32,/u);
  assert.match(handoff,/assert\.equal\(calls\('v2:connection-challenge-confirm'\)\.length,initialConfirmCount,/u);
  assert.match(handoff,/assert\.equal\(mutationCalls\.length,initialMutationCount\+32,/u);
  assert.doesNotMatch(handoff,/process\.env|new FocusEvent|settleAnimations/u,'handoff coverage must always run with native focus and ordinary tooltip dismissal timing');
  for (const count of [41,62,65,97]) {
    assert.match(source,new RegExp(`assert\\.equal\\(mutationCalls\\.length,${count},`,'u'));
  }
  assert.ok(source.indexOf('await assertConnectionTooltipHandoff(win);') > source.indexOf('await assertDeferredHostKeyDialogs(win);'));
  assert.ok(source.indexOf('assert.equal(mutationCalls.length,97,') > source.indexOf('await assertConnectionTooltipHandoff(win);'));
});
