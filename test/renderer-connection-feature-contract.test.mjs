import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';

const importModel = () => import(pathToFileURL(path.resolve(
  'renderer/v2/src/features/connections/connection-model.ts',
)).href);
const importRowModel = () => import(pathToFileURL(path.resolve(
  'renderer/v2/src/features/connections/connection-row-model.ts',
)).href);

async function modalCoordinatorHarness() {
  const source = await fs.readFile('renderer/v2/src/features/connections/RuntimeHostKeyDialog.tsx','utf8');
  const start = source.indexOf('class RuntimeHostKeyModalCoordinator');
  const end = source.indexOf('const runtimeHostKeyModals =',start);
  assert.ok(start >= 0 && end > start,'the shared coordinator must remain independently testable');
  let visible = [];
  const observers = new Set();
  const options = [];
  const Coordinator = runInNewContext(`${stripTypeScriptTypes(source.slice(start,end))}\nRuntimeHostKeyModalCoordinator`,{
    document:{
      body:{},
      querySelectorAll:() => visible,
    },
    MutationObserver:class {
      constructor(callback) { this.callback = callback; }
      observe(_target,configuration) { observers.add(this); options.push(configuration); }
      disconnect() { observers.delete(this); }
    },
  });
  return {
    coordinator:new Coordinator(),
    observers,
    options,
    updateModal(visibleModal) {
      visible = visibleModal ? [{getClientRects:() => [{}],dataset:{state:'closed'}}] : [];
      for (const observer of [...observers]) observer.callback([]);
    },
  };
}

test('runtime Host Key dialogs wait for other portals and reserve before React commits',async () => {
  const harness = await modalCoordinatorHarness();
  const granted = [];
  harness.updateModal(true);
  const releaseFirst = harness.coordinator.acquire(() => granted.push('first'));
  const releaseSecond = harness.coordinator.acquire(() => granted.push('second'));
  assert.deepEqual(granted,[],'an existing or closing modal must not be covered by a late challenge');
  assert.equal(harness.observers.size,1);
  assert.equal(harness.options[0].childList,true);
  assert.equal(harness.options[0].subtree,true);
  harness.updateModal(false);
  assert.deepEqual(granted,['first']);
  harness.updateModal(false);
  assert.deepEqual(granted,['first'],'a reservation blocks same-frame peers before the first portal exists');
  harness.updateModal(true);
  releaseFirst();
  assert.deepEqual(granted,['first'],'the next challenge waits through the old portal exit');
  harness.updateModal(false);
  assert.deepEqual(granted,['first','second']);
  releaseSecond();
  assert.equal(harness.observers.size,0,'the final release disconnects DOM observation');
});

test('runtime Host Key queue releases removed and superseded challenge requests',async () => {
  const harness = await modalCoordinatorHarness();
  const granted = [];
  harness.updateModal(true);
  const releaseRemoved = harness.coordinator.acquire(() => granted.push('unmounted'));
  const releaseOld = harness.coordinator.acquire(() => granted.push('old-challenge'));
  releaseRemoved();
  releaseOld();
  assert.equal(harness.observers.size,0);
  const releaseCurrent = harness.coordinator.acquire(() => granted.push('current-challenge'));
  harness.updateModal(false);
  assert.deepEqual(granted,['current-challenge']);
  releaseCurrent();
  releaseCurrent();
  assert.equal(harness.observers.size,0,'cleanup is idempotent');
});

function runtime(overrides = {}) {
  return {
    projectId:'project',
    environmentId:'environment',
    phase:'reconnecting',
    sequence:4,
    connectAttemptId:'plan-all',
    plugins:{
      server:{phase:'connecting',planId:'plan-all',operationId:'operation-server'},
      orders:{phase:'waitingDependency',operationId:'operation-orders'},
      cache:{phase:'failed',reason:'CONNECTION_FAILED'},
    },
    ...overrides,
  };
}

function intentResult(overrides = {}) {
  return {
    outcome:'started',
    planId:'plan-all',
    operationId:'operation-orders',
    actions:[],
    snapshot:runtime(),
    ...overrides,
  };
}

test('connection model normalizes runtime phases and rejects cross-scope ownership',async () => {
  const model = await importModel();
  const snapshot = runtime();
  assert.equal(model.environmentPhaseFromRuntime(snapshot),'connecting');
  assert.equal(model.pluginPhaseFromRuntime(snapshot,'orders'),'blocked');
  assert.equal(model.pluginPhaseFromRuntime(snapshot,'cache'),'error');
  assert.equal(model.pluginPhaseFromRuntime(runtime({
    phase:'connected',plugins:{server:{phase:'connected'}},
  }),'orders'),'unknown');
  assert.equal(model.normalizeConnectionPhase('unsupported'),'unknown');
  assert.equal(model.runtimeMatchesEnvironmentScope(snapshot,{
    projectId:'project',environmentId:'environment',
  }),true);
  assert.equal(model.runtimeMatchesEnvironmentScope(snapshot,{
    projectId:'other',environmentId:'environment',
  }),false);
  assert.deepEqual(model.runtimeConnectionOwner(snapshot,{
    projectId:'project',environmentId:'environment',
  },'orders'),{
    planId:'plan-all',
    operationId:'operation-orders',
  });
  assert.equal(model.runtimeConnectionOwner(snapshot,{
    projectId:'project',environmentId:'other',
  },'orders'),null);
});

test('plugin cancel supersedes a pending connect, inherits its node operation, and fences the late result',async () => {
  const model = await importModel();
  const scope = {projectId:'project',environmentId:'environment'};
  const connectOperation = {
    ownerKey:'project/environment/orders',
    requestId:'connect-request',
    intent:'connect',
    sequence:1,
    planId:'plan-all',
    operationId:null,
  };
  const cancelOperation = model.supersedeWithConnectionCancel({
    active:connectOperation,
    runtime:runtime(),
    scope,
    pluginInstanceId:'orders',
    requestId:'cancel-request',
    sequence:2,
  });
  assert.deepEqual(cancelOperation,{
    ownerKey:'project/environment/orders',
    requestId:'cancel-request',
    intent:'cancel',
    sequence:2,
    planId:'plan-all',
    operationId:'operation-orders',
  });
  assert.equal(model.connectionOperationIsCurrent(cancelOperation,connectOperation),false);
  assert.equal(model.connectionOperationIsCurrent(cancelOperation,cancelOperation),true);
  assert.equal(model.connectionResultMatches(cancelOperation,intentResult(),cancelOperation.ownerKey),true);
  assert.equal(model.connectionResultMatches(cancelOperation,intentResult({
    planId:'late-plan',
  }),cancelOperation.ownerKey),false);
  assert.equal(model.connectionResultMatches(cancelOperation,intentResult({
    operationId:'operation-other',
  }),cancelOperation.ownerKey),false);
});

test('cancel never widens scope and cannot proceed without an owned plan',async () => {
  const model = await importModel();
  const scope = {projectId:'project',environmentId:'environment'};
  assert.equal(model.supersedeWithConnectionCancel({
    active:null,
    runtime:runtime({connectAttemptId:null,plugins:{orders:{phase:'connecting'}}}),
    scope,
    pluginInstanceId:'orders',
    requestId:'cancel-request',
    sequence:1,
  }),null);
  assert.equal(model.supersedeWithConnectionCancel({
    active:null,
    runtime:runtime({projectId:'other'}),
    scope,
    pluginInstanceId:'orders',
    requestId:'cancel-request',
    sequence:1,
  }),null);
  assert.equal(model.supersedeWithConnectionCancel({
    active:null,
    runtime:runtime({plugins:{orders:{phase:'connecting'}}}),
    scope,
    pluginInstanceId:'orders',
    requestId:'cancel-plugin-with-environment-plan-only',
    sequence:1,
  }),null);
  assert.deepEqual(model.supersedeWithConnectionCancel({
    active:null,
    runtime:runtime(),
    scope,
    requestId:'cancel-environment',
    sequence:1,
  }),{
    ownerKey:'project/environment',
    requestId:'cancel-environment',
    intent:'cancel',
    sequence:1,
    planId:'plan-all',
    operationId:null,
  });
});

test('resource row actions expose explicit safe connection intents',async () => {
  const model = await importRowModel();
  const action = (phase,activeIntent = null,ready = true,canCancel = false) =>
    model.deriveConnectionRowAction(phase,activeIntent,ready,canCancel);
  assert.deepEqual(action('disconnected'),{
    disabled:false,kind:'connect',label:'连接',pending:false,variant:'default',
  });
  assert.equal(action('connected').kind,'disconnect');
  assert.deepEqual(action('partial'),{
    disabled:false,kind:'retry',label:'重试',pending:false,variant:'outline',
  });
  assert.equal(action('error').kind,'retry');
  assert.equal(action('blocked').kind,'retry');
  assert.deepEqual(action('connecting'),{
    disabled:true,kind:'pending',label:'连接中',pending:true,variant:'outline',
  });
  assert.deepEqual(action('connecting',null,true,true),{
    disabled:false,kind:'cancel',label:'取消',pending:false,variant:'outline',
  });
  assert.equal(action('connecting','connect').kind,'cancel');
  assert.equal(action('disconnecting').disabled,true);
  assert.equal(action('disconnected',null,false).kind,'configure');
});

test('connection row tooltips release Popper content before pending operations and Host Key prompts',async () => {
  const source = await fs.readFile('renderer/v2/src/features/connections/ConnectionRowAction.tsx','utf8');
  const component = source.slice(source.indexOf('function ConnectionActionButton'),source.indexOf('export function EnvironmentConnectionRowAction'));
  assert.match(component,/const tooltipBlocked = connection\.state\.operation !== null \|\| connection\.state\.challenge !== null/u);
  assert.match(component,/useEffect\(\(\) => \{[\s\S]*if \(tooltipBlocked\) setTooltipOpen\(false\)\s*\}, \[tooltipBlocked\]\)/u);
  assert.match(component,/const run = \(\) => \{\s*setTooltipOpen\(false\)/u);
  assert.match(component,/onOpenChange=\{\(open\) => setTooltipOpen\(open && !tooltipBlocked\)\}/u);
  assert.match(component,/open=\{tooltipOpen && !tooltipBlocked\}/u);
  assert.match(component,/\{!tooltipBlocked \? <TooltipContent>\{help\}<\/TooltipContent> : null\}/u);
  assert.match(component,/<Tooltip[\s\S]*?>\s*<TooltipTrigger asChild>\s*<Button\s+aria-busy=\{action\.pending \|\| undefined\}\s+aria-label=\{help\}/u);
  assert.equal([...component.matchAll(/<TooltipTrigger\b/gu)].length,1,'the original focus target must not be replaced by a conditional duplicate');
  assert.equal([...component.matchAll(/<Button\b/gu)].length,1);
  assert.match(component,/connectionTriggerRef\.current = event\.currentTarget/u);
  assert.match(component,/returnFocusRef=\{connectionTriggerRef\}/u);
  assert.doesNotMatch(component,/setTimeout|setInterval|preventDefault/u,'close the tooltip without suppressing normal button or focus events');
});

test('host-key and dependency models expose only validated, bounded presentation data',async () => {
  const model = await importModel();
  const challenge = {
    challengeId:'challenge-1',
    planId:'plan-all',
    operationId:'operation-server',
    expectedRevision:3,
    projectId:'project',
    environmentId:'environment',
    pluginInstanceId:'server',
    host:'server.internal',
    port:22,
    algorithm:'ssh-ed25519',
    fingerprint:'SHA256:example',
  };
  const result = intentResult({
    actions:[{
      code:'SSH_HOST_KEY_CONFIRM_REQUIRED',
      rootPluginInstanceId:'server',
      affectedPluginInstanceIds:['server','orders'],
      message:'untrusted operational message',
      details:{hostKeyChallenge:challenge},
    }],
  });
  assert.deepEqual(model.runtimeHostKeyChallenge(result,'orders'),{
    challengeId:'challenge-1',
    planId:'plan-all',
    operationId:'operation-server',
    expectedRevision:3,
    pluginInstanceId:'server',
    host:'server.internal',
    port:22,
    algorithm:'ssh-ed25519',
    fingerprint:'SHA256:example',
  });
  assert.equal(model.runtimeHostKeyChallenge(result,'cache'),null);
  assert.equal(model.runtimeHostKeyChallenge(intentResult({
    actions:[{
      code:'SSH_HOST_KEY_CONFIRM_REQUIRED',
      rootPluginInstanceId:'server',
      affectedPluginInstanceIds:['server'],
      details:{hostKeyChallenge:{...challenge,port:0}},
    }],
  })),null);
  const resumed = model.connectionPlanFromChallengeConfirmation({
    committed:true,
    connectionPlan:intentResult({
      outcome:'needs-action',
      operationId:'operation-next',
    }),
  });
  assert.equal(resumed.planId,'plan-all');
  assert.equal(resumed.operationId,'operation-next');
  assert.equal(resumed.snapshot.projectId,'project');
  assert.equal(model.connectionPlanFromChallengeConfirmation({
    connectionPlan:{outcome:'started',snapshot:{projectId:'project'}},
  }),null);

  const summaries = model.summarizeConnectionActions([
    {
      code:'TUNNEL_PROVIDER_UNAVAILABLE',
      rootPluginInstanceId:'server',
      affectedPluginInstanceIds:['orders'],
      message:'must not be rendered',
      details:{private:'must not be copied'},
    },
    {
      code:'PLUGIN_CONFIG_INCOMPLETE',
      rootPluginInstanceId:'cache',
      affectedPluginInstanceIds:['cache'],
    },
  ]);
  assert.deepEqual(summaries.map(({kind,title,affectedCount}) => ({
    kind,title,affectedCount,
  })),[
    {kind:'dependency',title:'连接依赖尚未就绪',affectedCount:1},
    {kind:'configuration',title:'插件配置需要处理',affectedCount:1},
  ]);
  assert.doesNotMatch(JSON.stringify(summaries),/must not/u);
  assert.equal(model.runtimeDependencyCount(runtime()),1);
  assert.deepEqual(model.environmentRuntimeCounts(runtime()),{
    total:3,
    connected:0,
    blocked:1,
    error:1,
  });
});

test('React connection controllers use only explicit, correlated intent APIs',async () => {
  const [
    model,
    controller,
    pluginController,
    environmentController,
    rowAction,
    pluginPanel,
    environmentPanel,
    hostKeyDialog,
  ] = await Promise.all([
    fs.readFile('renderer/v2/src/features/connections/connection-model.ts','utf8'),
    fs.readFile('renderer/v2/src/features/connections/use-connection-intent.ts','utf8'),
    fs.readFile('renderer/v2/src/features/connections/use-plugin-connection.ts','utf8'),
    fs.readFile('renderer/v2/src/features/connections/use-environment-connection.ts','utf8'),
    fs.readFile('renderer/v2/src/features/connections/ConnectionRowAction.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/connections/PluginConnectionPanel.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/connections/EnvironmentConnectionPanel.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/connections/RuntimeHostKeyDialog.tsx','utf8'),
  ]);
  const all = [
    model,
    controller,
    pluginController,
    environmentController,
    rowAction,
    pluginPanel,
    environmentPanel,
    hostKeyDialog,
  ].join('\n');

  for (const phase of [
    'connected','disconnected','connecting','disconnecting','partial','blocked','error','unknown',
  ]) assert.match(model,new RegExp(`"${phase}"`,'u'));
  for (const field of [
    'challengeId','planId','operationId','expectedRevision','fingerprint',
  ]) assert.match(model,new RegExp(field,'u'));
  assert.match(model,/supersedeWithConnectionCancel/u);
  assert.match(model,/connectionOperationIsCurrent/u);
  assert.match(model,/runtimeMatchesEnvironmentScope/u);

  assert.match(controller,/requestConnectionIntent/u);
  assert.match(controller,/planId: operation\.planId/u);
  assert.match(controller,/supersedeWithConnectionCancel/u);
  assert.match(controller,/connectionOperationIsCurrent/u);
  assert.match(controller,/connectionResultMatches/u);
  assert.match(controller,/confirmConnectionChallenge/u);
  assert.match(controller,/connectionPlanFromChallengeConfirmation/u);
  assert.match(controller,/decision: "trust-host-key"/u);
  assert.match(controller,/cancelRequiresOwnedPlan: true/u);
  assert.match(controller,/automaticallyConnects: false/u);
  assert.match(controller,/sendsCredentials: false/u);
  assert.doesNotMatch(controller,/useEffect\([\s\S]{0,180}requestConnectionIntent/u);

  assert.match(pluginController,/source: "renderer-plugin"/u);
  assert.doesNotMatch(pluginController,/expectedRevision/u);
  assert.match(environmentController,/source: "renderer-environment"/u);
  assert.match(environmentController,/expectedRevision: environment\.revision/u);

  assert.match(rowAction,/resolveConnectionCancelTarget/u);
  assert.match(rowAction,/connection\.state\.runtime/u);
  assert.match(rowAction,/if \(action\.kind === "connect"\) void connection\.connect\(\)/u);
  assert.match(rowAction,/if \(action\.kind === "retry"\) void connection\.retry\(\)/u);
  assert.match(rowAction,/if \(action\.kind === "disconnect"\) void connection\.disconnect\(\)/u);
  assert.match(rowAction,/if \(action\.kind === "cancel"\) void connection\.cancel\(\)/u);
  assert.match(rowAction,/data-connection-intent=\{action\.kind\}/u);
  assert.match(rowAction,/event\.stopPropagation\(\)/u);
  assert.match(rowAction,/RuntimeHostKeyDialog/u);

  assert.match(pluginPanel,/disabled=\{primaryAction\.disabled\}/u);
  assert.match(pluginPanel,/connection\.state\.phase === "connecting"/u);
  assert.match(environmentPanel,/environment-connection-panel/u);
  assert.match(environmentPanel,/environment-dependency-state/u);
  assert.match(environmentPanel,/environment-host-key-confirmation/u);
  assert.match(environmentPanel,/RuntimeHostKeyDialog/u);
  assert.match(environmentPanel,/TableBody/u);
  assert.match(environmentPanel,/打开详情和刷新状态不会自动连接/u);

  for (const surface of [rowAction,pluginPanel,environmentPanel]) {
    assert.match(surface,/RuntimeHostKeyDialog/u);
    assert.match(surface,/onReject=\{connection\.rejectHostKey\}/u);
    assert.match(surface,/onTrust=\{connection\.trustHostKey\}/u);
    assert.match(surface,/returnFocusRef=\{connectionTriggerRef\}/u);
    assert.match(surface,/connectionTriggerRef\.current = event\.currentTarget/u);
  }
  assert.match(hostKeyDialog,/open=\{open\}/u);
  assert.match(hostKeyDialog,/presentationRequest !== null && grantedRequest === presentationRequest/u);
  assert.match(hostKeyDialog,/useMemo\(\(\) => challengeKey === null \? null : \{ challengeKey \}, \[challengeKey\]\)/u);
  assert.match(hostKeyDialog,/return runtimeHostKeyModals\.acquire\(\(\) => setGrantedRequest\(presentationRequest\)\)/u);
  assert.match(hostKeyDialog,/new MutationObserver\(this\.drain\)/u);
  assert.doesNotMatch(hostKeyDialog,/setTimeout|setInterval/u);
  assert.match(hostKeyDialog,/if \(!open && !isPending\(\)\) onReject\(\)/u);
  assert.match(hostKeyDialog,/onEscapeKeyDown=\{\(event\) => \{ if \(isPending\(\)\) event\.preventDefault\(\)/u);
  assert.match(hostKeyDialog,/trustPendingRef\.current = challengeKey/u);
  assert.match(hostKeyDialog,/if \(open && busy\) focusWorkspaceElement\(dialogRef\.current\)/u);
  assert.match(hostKeyDialog,/focusWorkspaceElement\(dialogRef\.current\)[\s\S]*trustPendingRef\.current = challengeKey/u);
  assert.match(hostKeyDialog,/<AlertDialogContent\s+ref=\{dialogRef\}/u);
  assert.match(hostKeyDialog,/max-h-\[calc\(100dvh-2rem\)\]/u);
  assert.match(hostKeyDialog,/<ScrollArea\s+className="min-h-0"[\s\S]*<\/ScrollArea>\s*<AlertDialogFooter/u);
  assert.match(hostKeyDialog,/viewportClassName="h-auto max-h-\[calc\(100dvh-7rem\)\]"/u);
  assert.match(hostKeyDialog,/data-open:zoom-in-100 data-closed:zoom-out-100/u);
  assert.match(hostKeyDialog,/event\.preventDefault\(\)[\s\S]*void trust\(\)/u);
  assert.match(hostKeyDialog,/<AlertDialogContent[\s\S]*errorMessage \? \([\s\S]*<Alert data-testid=[\s\S]*<AlertDescription[^>]*>\{errorMessage\}<\/AlertDescription>[\s\S]*<\/AlertDialogContent>/u);
  assert.match(hostKeyDialog,/focusWorkspaceElement\(trigger\)/u);
  assert.match(hostKeyDialog,/focusWorkspaceElement\(document\.getElementById\("detail-main"\)\)/u);
  assert.doesNotMatch(hostKeyDialog,/confirmConnectionChallenge|getAiOpsV2|window\.aiOps/u);

  assert.doesNotMatch(all,/connectEnvironment\(|retryEnvironment\(|disconnectEnvironment\(|cancelEnvironment\(/u);
  assert.doesNotMatch(all,/legacyScope|secretsByPlugin|temporarySecrets|credentialIntent/u);
  assert.doesNotMatch(all,/window\.confirm|console\.|dangerouslySetInnerHTML/u);
  assert.doesNotMatch(all,/ipcRenderer|contextBridge|window\.aiOps/u);
});
