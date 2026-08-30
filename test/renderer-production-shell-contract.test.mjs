import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('React production smoke exercises real read-only workspace integration',async () => {
  const smoke = await fs.readFile('scripts/ui-react-foundation-smoke.cjs','utf8');

  assert.match(smoke,/renderer-build','v2','index\.html'/u);
  assert.doesNotMatch(smoke,/react\.html/u);
  assert.doesNotMatch(smoke,/fixture-switcher|selectFixture|MockActionSurfaces|mock-create-dialog|mock-plugin-sheet/u);

  for (const channel of [
    'v2:workspace-overview',
    'v2:environment-list',
    'v2:environment-status',
    'v2:plugin-list',
    'v2:runbook-read',
    'v2:confirmation-list',
  ]) {
    assert.match(smoke,new RegExp(channel,'u'));
  }
  assert.match(smoke,/readCalls/u);
  assert.match(smoke,/mutationCalls/u);
  assert.match(smoke,/assert\.deepEqual\(mutationCalls,\[\]\)/u);
  assert.match(smoke,/SMOKE_READ_ONLY/u);
  assert.match(
    smoke,
    /registerRead\('v2:quick-question-opening-get',[\s\S]*?schemaVersion:1,[\s\S]*?AI Ops MCP/u,
  );

  assert.match(smoke,/data-testid="create-project-dialog"/u);
  assert.match(smoke,/data-feature="confirmations"/u);
  assert.match(smoke,/data-testid="global-command"/u);
  assert.match(smoke,/assertKeyboardResizerPersistence\(win,\{\s*testId:'project-resource-resizer',keyCode:'RIGHT',panelId:'project-panel'/u);
  assert.match(smoke,/assertKeyboardResizerPersistence\(win,\{\s*testId:'resource-detail-resizer',keyCode:'LEFT',panelId:'resource-panel'/u);
  assert.match(smoke,/ai-ops-project-order-v1/u);
  assert.match(smoke,/key:'ArrowDown',altKey:true/u);
  assert.match(smoke,/href="#detail-main"/u);
  assert.match(smoke,/v2:environment-status-changed/u);
  assert.match(smoke,/v2:confirmations-changed/u);
  assert.match(smoke,/confirmation-other-scope/u);
  assert.match(smoke,/crossScopeVisible:false/u);

  for (const dimensions of ['960,640','1280,820','1680,980']) {
    assert.match(smoke,new RegExp(`assertViewport\\(win,${dimensions}`,'u'));
  }
  assert.match(smoke,/RUNBOOK_BRIDGE_SCREENSHOT_THEME/u);
  const providers = await fs.readFile('renderer/v2/src/app/providers.tsx','utf8');
  assert.match(providers,/<Toaster position="top-center" richColors/u);
  assert.match(smoke,/app-shell-\$\{theme\}-\$\{width\}x\$\{height\}\.png/u);
  assert.match(smoke,/selectedPluginContrast >= 4\.5/u);
  assert.match(smoke,/selected plugin outside resource viewport/u);
  assert.match(smoke,/project row overlap/u);
  assert.match(smoke,/project truncation/u);
  assert.match(smoke,/projectFooter:footerGeometry\(project,'project-list-scroll','project-actions-footer'\)/u);
  assert.match(smoke,/resourceFooter:footerGeometry\(resources,'resource-list-scroll','resource-actions-footer'\)/u);
  assert.match(smoke,/footerOpticalAlignment/u);
  assert.match(smoke,/project and environment footer optical alignment/u);
  assert.match(smoke,/environment action overlap/u);
  assert.match(smoke,/environment is not one accordion container/u);
  assert.match(smoke,/environment outer glow remains/u);
  assert.match(smoke,/project footer hint remains/u);
  assert.match(smoke,/plugin action overlap/u);
  assert.match(smoke,/environment connection action missing/u);
  assert.match(smoke,/plugin connection action missing/u);
  assert.match(smoke,/invalid resource button content/u);
  assert.match(smoke,/last detail tab cannot scroll into view/u);
  assert.match(smoke,/detail tabs neither fit nor expose horizontal scrolling/u);
  assert.match(smoke,/detail tab labels clipped/u);
  assert.match(smoke,/detail tab keyboard activation/u);
  assert.match(smoke,/detail tabs repeat borders/u);
  assert.match(smoke,/detail tabs are stretched instead of content-sized/u);
  assert.match(smoke,/plugin action group misaligned/u);
  assert.match(smoke,/plugin details expose direct actions without duplicate navigation/u);
  assert.match(smoke,/tabVariant,'navigation'/u);
  assert.match(smoke,/collapsedProjectGeometry/u);
  assert.match(smoke,/插件详情','Agent 权限','插件记录','操作确认/u);
  assert.match(smoke,/confirmationSelectionKind,'environment'/u);
  assert.match(smoke,/body overflow/u);
  assert.match(smoke,/root overflow/u);
  assert.match(smoke,/shell overflow/u);

  for (const scenario of [
    'project-overview',
    'environment-overview',
    'plugin-overview',
    'plugin-agent-access',
    'runbook',
    'quick-questions',
    'audit',
    'confirmations',
  ]) {
    assert.match(smoke,new RegExp(`name:'${scenario}'`,'u'));
  }
  assert.match(smoke,/scenario-\$\{name\}-\$\{theme\}-\$\{width\}x\$\{height\}\.png/u);
  assert.match(smoke,/name:'date-picker'/u);
  assert.match(smoke,/data-slot="popover-content"/u);
  assert.match(smoke,/selected detail tab is not focused/u);
  assert.match(smoke,/selected-detail-tab-auto-scroll-failed/u);
  assert.match(smoke,/selected-detail-tab-clipped/u);
  assert.match(smoke,/automaticTabScroll/u);
  assert.match(smoke,/button overlap in/u);
  assert.match(smoke,/assert\.deepEqual\(mutationCalls,\[\]\)/u);
  assert.match(smoke,/assertFocusLoop/u);
  assert.match(smoke,/create-project Dialog/u);
  assert.match(smoke,/project settings Dialog/u);
  assert.match(smoke,/delete-project AlertDialog/u);
  assert.match(smoke,/forward focus loop/u);
  assert.match(smoke,/reverse focus loop/u);
  assert.match(smoke,/focus-restore-failed/u);
  assert.match(smoke,/layout-restore-mismatch/u);
  assert.match(smoke,/Emulation\.setEmulatedMedia/u);
  assert.match(smoke,/prefers-reduced-motion: reduce/u);
  assert.match(smoke,/forced-colors: active/u);
  assert.match(smoke,/zoomFactor of \[1\.25,1\.5\]/u);
  assert.match(smoke,/heightChain/u);
  assert.match(smoke,/sidebarWrapper:heightGeometry/u);
  assert.match(smoke,/project panel below 176px minimum/u);
  assert.match(smoke,/resource panel below 240px minimum/u);
  assert.match(smoke,/detail panel below 360px minimum/u);
  assert.match(smoke,/Panel CSS pixel evidence/u);
  assert.match(smoke,/Accessibility geometry failures/u);

  assert.match(smoke,/apiNames\.length,58/u);
  assert.match(smoke,/contextIsolation,true/u);
  assert.match(smoke,/nodeIntegration,false/u);
  assert.match(smoke,/sandbox,true/u);
  assert.match(smoke,/style-src 'self' 'unsafe-inline'/u);
  assert.match(smoke,/connect-src 'none'/u);
  assert.match(smoke,/externalRequests/u);
  assert.match(smoke,/assert\.deepEqual\(externalRequests,\[\]\)/u);
});

test('packaged React smoke verifies compact rail geometry and process-restart persistence in an empty workspace',async () => {
  const smoke = await fs.readFile('scripts/packaged-ui-smoke.cjs','utf8');

  assert.match(smoke,/PROJECT_RAIL_COLLAPSED_WIDTH = 128/u);
  assert.match(smoke,/PROJECT_RAIL_EXPANDED_MIN_WIDTH = 176/u);
  assert.match(smoke,/runbook-bridge:app-shell-layout:v1/u);
  assert.match(smoke,/async function readProjectRail\(cdp\) \{[\s\S]*?await cdp\.call\('Page\.captureScreenshot',[\s\S]*?return cdp\.evaluate/u);
  assert.doesNotMatch(smoke,/backgroundThrottling|force-device-scale-factor|Emulation\.setDeviceMetricsOverride/u);
  assert.match(smoke,/Math\.abs\(snapshot\.panelWidth - snapshot\.width\) <= 1/u);
  assert.match(smoke,/snapshot\.collapsed === String\(collapsed\)/u);
  assert.match(smoke,/assert\.equal\(snapshot\.noTopToggle, true/u);
  assert.match(smoke,/Math\.abs\(snapshot\.valueNow - snapshot\.panelShare\) <= 0\.2/u);
  assert.match(smoke,/assert\.equal\(snapshot\.controls, 'project-panel'/u);
  assert.match(smoke,/assert\.equal\(snapshot\.noPageOverflow, true/u);
  assert.match(smoke,/assert\.equal\(snapshot\.noRailOverflow, true/u);
  assert.match(smoke,/Input\.dispatchKeyEvent/u);
  assert.match(smoke,/event\.isTrusted/u);
  assert.match(smoke,/pressProjectRailShortcut\(running\.cdp\)/u);
  assert.match(smoke,/pressProjectRailResizer\(running\.cdp\)/u);
  assert.match(smoke,/modifiers: 2/u);
  assert.match(smoke,/assert\.equal\(snapshot\.sameResizer, true/u);
  assert.match(smoke,/assert\.equal\(snapshot\.focused, true/u);
  assert.match(smoke,/assert\.deepEqual\(snapshot\.trustedKeys, trustedKeys/u);
  assert.match(smoke,/resizer follows the actual rail edge/u);
  assert.match(smoke,/resizer vertical anchor stays fixed/u);
  assert.match(smoke,/await stopPackagedApp\(running\);\s*running = null;\s*running = await startPackagedApp\(isolation\)/u);
  assert.match(smoke,/assert\.equal\(afterRestart\.savedCollapsed, true/u);
  assert.match(smoke,/expand restored rail/u);
  assert.doesNotMatch(smoke,/localStorage\.(?:setItem|removeItem|clear)\(/u);
  assert.doesNotMatch(smoke,/window\.aiOps\.v2\.(?:createProject|createEnvironment|createPlugin|connectPlugin|requestConnectionIntent)\(/u);
  assert.match(smoke,/assert\.equal\(inspection\.projectCount, 0\)/u);
  assert.match(smoke,/assert\.equal\(inspection\.apiCount, 58\)/u);
  assert.match(smoke,/projectCount: 0, apiCount: 58/u);
  assert.match(smoke,/connect-src 'none'/u);
  assert.match(smoke,/assert\.deepEqual\(running\.httpRequests, \[\]\)/u);
});

test('packaged search smoke measures real placeholder typography and native input geometry at 128px',async () => {
  const smoke = await fs.readFile('scripts/packaged-ui-smoke.cjs','utf8');

  assert.match(smoke,/async function readProjectSearch\(cdp\) \{\s*await cdp\.call\('Page\.captureScreenshot'/u);
  assert.match(smoke,/await document\.fonts\.ready/u);
  assert.match(smoke,/getComputedStyle\(input, '::placeholder'\)/u);
  assert.match(smoke,/context\.measureText\(input\.placeholder\)\.width \+ letterSpacing/u);
  assert.match(smoke,/input\.clientWidth - paddingLeft - paddingRight/u);
  assert.match(smoke,/DOM\.describeNode', \{objectId, depth: -1, pierce: true\}/u);
  assert.match(smoke,/DOM\.getBoxModel/u);
  assert.match(smoke,/Math\.min\(search\.contentWidth, nativeBox\.width\)/u);
  assert.match(smoke,/search\.fontSize \* 1\.25/u);
  assert.match(smoke,/search\.placeholderWidth <= search\.availableWidth \+ 1/u);
  assert.match(smoke,/search\.iconRight <= search\.contentLeft \+ 1/u);
  assert.match(smoke,/assert\.equal\(search\.sameInput, true/u);
  assert.match(smoke,/Input\.insertText', \{text: '项目'\}/u);
  assert.match(smoke,/key: 'Backspace'/u);
  assert.match(smoke,/trustedInputEvents > typed\.trustedInputEvents/u);
  assert.match(smoke,/Ctrl\+B in the search input does not resize the rail/u);
  for (const label of ['128px project search placeholder','expanded project search preserves its input',
    'collapsed project search preserves its input','restored 128px project search']) {
    assert.ok(smoke.includes(label), `${label} is covered by the packaged smoke`);
  }
});
