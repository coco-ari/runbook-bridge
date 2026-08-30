import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const source = (file) => fs.readFile(path.resolve(file),'utf8');
const modeModule = () => import(pathToFileURL(path.resolve(
  'renderer/v2/src/components/detail-workspace/detail-work-mode.ts',
)).href);

function input() {
  return {
    scope:{projectId:'project-a',environmentId:'environment-a'},
    projectName:'测试项目',environmentName:'测试环境',
    plugin:{
      projectId:'project-a',environmentId:'environment-a',pluginInstanceId:'plugin-a',
      pluginType:'redis',displayName:'测试缓存',revision:7,target:{host:'cache.invalid',port:6379},
      auth:{username:''},
    },
    returnSelection:{projectId:'project-a',environmentId:'environment-a',pluginInstanceId:'plugin-a',initialized:true},
    returnTab:'overview',
  };
}

test('plugin work mode owns a new memory-only scope and immutable input snapshot',async () => {
  const {createPluginWorkMode} = await modeModule();
  const original = input();
  const mode = createPluginWorkMode(original);
  original.scope.environmentId = 'environment-other';
  original.plugin.target.host = 'changed.invalid';
  original.plugin.revision = 8;
  original.returnSelection.pluginInstanceId = 'plugin-other';
  assert.equal(mode.scope.environmentId,'environment-a');
  assert.equal(mode.plugin.target.host,'cache.invalid');
  assert.equal(mode.plugin.revision,7);
  assert.equal(mode.returnSelection.pluginInstanceId,'plugin-a');
  assert.equal(mode.returnTab,'overview');
  assert.notEqual(createPluginWorkMode(input()).id,mode.id);
  assert.deepEqual(Object.keys(mode).sort(),[
    'environmentName','id','kind','plugin','projectName','returnSelection','returnTab','scope',
  ]);
  const code = await source('renderer/v2/src/components/detail-workspace/detail-work-mode.ts');
  assert.doesNotMatch(code,/localStorage|sessionStorage|indexedDB|writeFile/u);
});

test('plugin work mode rejects cross-project and cross-environment records',async () => {
  const {createPluginWorkMode} = await modeModule();
  for (const key of ['projectId','environmentId']) {
    const wrong = input();
    wrong.plugin[key] = 'different-scope';
    assert.throws(() => createPluginWorkMode(wrong),/插件不属于当前编辑范围/u);
  }
  const create = input();
  create.plugin = null;
  assert.equal(createPluginWorkMode(create).plugin,null);
});

test('workspace navigation waits for safe plugin cancellation and covers text editors',async () => {
  const shell = await source('renderer/v2/src/components/app-shell/AppShell.tsx');
  const guard = await source('renderer/v2/src/features/environments/DirtyLeaveGuard.tsx');
  const hook = await source('renderer/v2/src/features/plugins/use-plugin-editor.ts');
  assert.match(shell,/editorLeave && !await editorLeave\(\)\) return[\s\S]*await dirtyLeave\.requestLeave\(\)/u);
  assert.match(shell,/navigationRequestPendingRef\.current/u);
  assert.match(shell,/quickQuestionsDirty/u);
  assert.match(shell,/runbookSaving \|\| agentAccessSaving \|\| quickQuestionsSaving/u);
  assert.match(shell,/setDetailDraftEpoch\(\(current\) => current \+ 1\)/u);
  assert.match(shell,/onTabChange=\{\(value\) => \{ if \(value !== detailTab\) requestNavigation/u);
  assert.match(shell,/key=\{pluginWorkMode\.id\}/u);
  const closeWorkspace = shell.slice(shell.indexOf('const closePluginWorkspace'),shell.indexOf('const selectProject'));
  assert.match(closeWorkspace,/completeList\.scopeKey === `\$\{previous\.projectId\}\/\$\{previous\.environmentId\}`/u);
  assert.match(closeWorkspace,/plugins: completeList\.data/u);
  assert.match(closeWorkspace,/setPendingSelection\([\s\S]*tab: mode\.returnTab/u);
  assert.match(closeWorkspace,/focusTarget: editorReturnFocusRef\.current/u);
  assert.match(shell,/scheduleWorkspaceFocus\(pendingSelection\.focusTarget\)/u);
  assert.match(shell,/editorReturnFocusRef\.current = resolveReturnFocus/u);
  assert.match(shell,/\[data-testid="detail-scope-actions"\]/u);
  assert.match(shell,/className="h-full max-h-full min-h-0[^\n]*data-testid="react-app-shell"/u);
  assert.match(guard,/dirtyRef\.current\.quickQuestionsDirty/u);
  assert.match(hook,/readonly cancel: \(\) => Promise<boolean>/u);
  const cancel = hook.slice(hook.indexOf('const cancel = useCallback'),hook.indexOf('\n  return {\n    state,',hook.indexOf('const cancel = useCallback')));
  assert.match(cancel,/restorePreEditConnections: true/u);
  assert.match(cancel,/return true[\s\S]*catch[\s\S]*return false/u);
  assert.doesNotMatch(cancel,/onClosed\?\./u);
  const reject = hook.slice(hook.indexOf('const rejectEditImpact'),hook.indexOf('const rejectConfirmation'));
  assert.ok(reject.indexOf('await api.cancelPluginConnectionEdit') < reject.indexOf('preparationRef.current = null'));
});

test('inline plugin editor remains mounted when collapsed and restores retained draft focus',async () => {
  const editor = await source('renderer/v2/src/features/plugins/PluginEditorWorkspace.tsx');
  assert.doesNotMatch(editor,/components\/ui\/(?:dialog|sheet)|SheetContent|createPortal/u);
  assert.match(editor,/data-testid="plugin-editor-workspace"/u);
  assert.match(editor,/hidden=\{collapsed\}/u);
  assert.match(editor,/style=\{collapsed \? \{ display: "none" \}/u);
  assert.match(editor,/onRegisterLeaveGuard\(requestLeave\)/u);
  assert.match(editor,/onCloseAutoFocus/u);
  assert.match(editor,/lastEditorFocusRef/u);
  assert.match(editor,/event\.target !== event\.currentTarget/u);
  assert.match(editor,/!workspaceRef\.current\?\.contains\(document\.activeElement\)/u);
  assert.match(editor,/data-testid="plugin-editor-footer"/u);
  assert.match(editor,/@min-\[560px\]\/editor:flex-row/u);
  assert.match(editor,/if \(!state\.credentials\.primary\)/u);
  assert.match(editor,/plugin-local-change-confirmation/u);
});

test('command palette waits for Radix close focus and never stacks over another modal',async () => {
  const command = await source('renderer/v2/src/components/app-shell/GlobalCommand.tsx');
  const primitive = await source('renderer/v2/src/components/ui/command.tsx');
  assert.match(command,/anotherModal/u);
  assert.match(command,/pendingActionRef\.current = action/u);
  assert.match(command,/onCloseAutoFocus=\{/u);
  assert.match(command,/requestAnimationFrame\(\(\) => \{[\s\S]*!openRef\.current && !activeModal\) action\(\)/u);
  assert.match(primitive,/onCloseAutoFocus=\{onCloseAutoFocus\}/u);
});

test('all scope action menus release Radix focus before handing off to another surface', async () => {
  const sourceText = await source('renderer/v2/src/components/detail-workspace/WorkspaceDetail.tsx');
  const actions = sourceText.slice(sourceText.indexOf('function SelectionActions'),sourceText.indexOf('export function WorkspaceDetail'));
  assert.match(actions,/useMenuHandoff/u);
  assert.match(actions,/onOpenChange=\{handoff\.onOpenChange\}/u);
  assert.match(actions,/onCloseAutoFocus=\{handoff\.onCloseAutoFocus\}/u);
  assert.match(actions,/handoff\.queueAction\(\(\) => onAction\(action\)\)/u);
  assert.doesNotMatch(actions,/onSelect=\{\(\) => onAction/u);
  for (const file of ['project-rail/ProjectRail.tsx','resource-pane/ResourcePane.tsx']) {
    const code = await source(`renderer/v2/src/components/${file}`);
    assert.match(code,/useMenuHandoff/u);
    assert.match(code,/onCloseAutoFocus=\{\w+\.onCloseAutoFocus\}/u);
    assert.match(code,/onOpenChange=\{\w+\.onOpenChange\}/u);
    assert.doesNotMatch(code,/onSelect=\{(?:\(\) => onAction|onSelectProject|onSelectEnvironment)/u);
  }
  const hook = await source('renderer/v2/src/hooks/use-menu-handoff.ts');
  assert.match(hook,/useLayoutEffect\(\(\) => handoff\.invalidate\(\), \[handoff, scopeKey\]\)/u);
  assert.match(hook,/return \(\) => handoff\.dispose\(\)/u);
  assert.doesNotMatch(hook,/setTimeout|preventDefault/u,'preserve Radix close behavior; do not guess animation timing');
});

async function menuHandoffHarness() {
  const {createMenuHandoffController} = await import(pathToFileURL(path.resolve(
    'renderer/v2/src/hooks/use-menu-handoff.ts',
  )).href);
  const frames = new Map();
  let frameId = 0;
  let allowed = true;
  const calls = [];
  const controller = createMenuHandoffController({
    cancelFrame:(id) => frames.delete(id),
    mayRun:() => allowed,
    requestFrame:(callback) => { frames.set(++frameId,callback); return frameId; },
  });
  controller.mount();
  return {
    calls,controller,frames,
    block:() => {allowed=false;},
    allow:() => {allowed=true;},
    flush:() => {const queued=[...frames.values()];frames.clear();for(const callback of queued)callback();},
    select:() => {controller.onOpenChange(true);controller.queueAction(() => calls.push('exact-scope-action'));controller.onOpenChange(false);},
  };
}

test('menu handoff is single-use and begins only after Radix close-focus teardown', async () => {
  const {calls,controller,flush,select} = await menuHandoffHarness();
  select();
  flush();
  assert.deepEqual(calls,[],'selection must not open another surface inside the menu focus scope');
  controller.onCloseAutoFocus();
  assert.deepEqual(calls,[],'Radix must first restore its trigger in the close-focus event');
  flush();
  assert.deepEqual(calls,['exact-scope-action']);
  controller.onCloseAutoFocus();
  flush();
  assert.equal(calls.length,1);
});

test('menu handoff cancels stale scope, reopened menu and late unmount callbacks', async () => {
  for (const invalidate of [
    (controller) => controller.invalidate(),
    (controller) => controller.onOpenChange(true),
    (controller) => controller.dispose(),
    (controller) => {controller.dispose();controller.mount();},
  ]) {
    const {calls,controller,frames,flush,select} = await menuHandoffHarness();
    select();
    controller.onCloseAutoFocus();
    const lateFrame = [...frames.values()][0];
    invalidate(controller);
    flush();
    lateFrame();
    assert.deepEqual(calls,[],'even an already-dispatched frame cannot revive an obsolete scope');
    controller.onCloseAutoFocus();
    flush();
    assert.deepEqual(calls,[],'a close-focus callback delivered after cleanup cannot schedule old work');
  }
  const {calls,controller,flush,select} = await menuHandoffHarness();
  select();
  controller.dispose();
  controller.onCloseAutoFocus();
  flush();
  assert.deepEqual(calls,[]);
});

test('menu handoff does not replace a newer modal, menu or picker', async () => {
  const {allow,block,calls,controller,flush,select} = await menuHandoffHarness();
  select();
  controller.onCloseAutoFocus();
  block();
  flush();
  assert.deepEqual(calls,[]);
  allow();
  controller.onCloseAutoFocus();
  flush();
  assert.deepEqual(calls,[],'dismissal of the newer surface must not resume a stale action');
});

test('deferred workspace focus never steals focus from a newer modal or hidden editor',async () => {
  const {focusWorkspaceElement} = await import(pathToFileURL(path.resolve(
    'renderer/v2/src/lib/workspace-focus.ts',
  )).href);
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis,'document');
  let modals = [];
  const documentStub = {querySelectorAll:() => modals,activeElement:null};
  Object.defineProperty(globalThis,'document',{value:documentStub,configurable:true});
  const target = {
    isConnected:true,
    getClientRects:() => [1],
    closest:() => null,
    focus:() => {documentStub.activeElement=target;},
  };
  try {
    assert.equal(focusWorkspaceElement(null),false);
    assert.equal(focusWorkspaceElement({...target,isConnected:false}),false);
    assert.equal(focusWorkspaceElement({...target,getClientRects:() => []}),false);
    assert.equal(focusWorkspaceElement({...target,closest:() => ({inert:true})}),false);
    modals=[{getClientRects:() => [1],dataset:{state:'open'},contains:() => false}];
    assert.equal(focusWorkspaceElement(target),false);
    assert.equal(documentStub.activeElement,null);
    modals[0].contains=() => true;
    assert.equal(focusWorkspaceElement(target),true);
    documentStub.activeElement=null;
    modals[0].dataset.state='closed';
    modals[0].contains=() => false;
    assert.equal(focusWorkspaceElement(target),true);
  } finally {
    if(originalDocument) Object.defineProperty(globalThis,'document',originalDocument);
    else delete globalThis.document;
  }
});

test('busy modal focus covers layout commits and late Portal mounts without delayed focus',async () => {
  const hook = await source('renderer/v2/src/hooks/use-busy-dialog-focus.ts');
  assert.match(hook,/useLayoutEffect\(\(\) => \{\s*focusBusyDialog\(dialogRef\.current, busy\)/u);
  assert.match(hook,/useCallback\(\(dialog: HTMLDivElement \| null\) => \{\s*dialogRef\.current = dialog\s*focusBusyDialog\(dialog, busy\)/u);
  assert.doesNotMatch(hook,/requestAnimationFrame|setTimeout|MutationObserver/u);

  const owners = [
    ['projects/ProjectMutationSurfaces.tsx','busyDialogRef',3],
    ['environments/EnvironmentMutationSurfaces.tsx','busyDialogRef',3],
    ['environments/DirtyLeaveGuard.tsx','busyDialogRef',1],
    ['plugins/PluginMetadataDialog.tsx','busyDialogRef',1],
    ['plugins/PluginDeleteDialog.tsx','busyDialogRef',1],
    ['plugins/CredentialMigrationNotice.tsx','busyDialogRef',1],
    ['plugins/PluginEditorConfirmations.tsx','busyDialogRef',1],
    ['plugins/PluginEditorWorkspace.tsx','discardDialogRef',1],
    ['quick-questions/QuickQuestionsFeature.tsx','deleteDialogRef',1],
  ];
  for (const [file,ref,count] of owners) {
    const code = await source(`renderer/v2/src/features/${file}`);
    assert.match(code,/useBusyDialogFocus\(/u,file);
    assert.equal([...code.matchAll(new RegExp(`ref=\\{${ref}\\}`,'gu'))].length,count,file);
    assert.match(code,new RegExp(`<(?:Alert)?DialogContent\\s+ref=\\{${ref}\\}[\\s\\S]*?aria-busy=`,'u'),file);
  }
});

test('busy focus remains in the current visible open dialog and cannot revive an obsolete modal',async () => {
  const {focusBusyDialog} = await import(pathToFileURL(path.resolve(
    'renderer/v2/src/hooks/use-busy-dialog-focus.ts',
  )).href);
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis,'document');
  let modals = [];
  const documentStub = {querySelectorAll:() => modals,activeElement:null};
  Object.defineProperty(globalThis,'document',{value:documentStub,configurable:true});
  const target = {
    isConnected:true,
    dataset:{state:'open'},
    getAttribute:() => 'dialog',
    getClientRects:() => [1],
    closest:() => null,
    contains:(node) => node === target,
    focus:() => {documentStub.activeElement=target;},
  };
  try {
    assert.equal(focusBusyDialog(null,true),false);
    assert.equal(focusBusyDialog(target,false),false);
    assert.equal(focusBusyDialog({...target,dataset:{state:'closed'}},true),false);
    assert.equal(focusBusyDialog({...target,getAttribute:() => 'region'},true),false);
    assert.equal(focusBusyDialog({...target,isConnected:false},true),false);
    assert.equal(focusBusyDialog({...target,getClientRects:() => []},true),false);
    assert.equal(focusBusyDialog({...target,closest:() => ({inert:true})},true),false);
    modals = [target,{...target,contains:() => false}];
    assert.equal(focusBusyDialog(target,true),false,'a newer active modal owns focus');
    assert.equal(documentStub.activeElement,null);
    modals = [target];
    assert.equal(focusBusyDialog(target,true),true);
    assert.equal(documentStub.activeElement,target,'the container remains focusable with all controls disabled');
    target.getAttribute=() => 'alertdialog';
    documentStub.activeElement=null;
    assert.equal(focusBusyDialog(target,true),true);
    assert.equal(documentStub.activeElement,target);
  } finally {
    if(originalDocument) Object.defineProperty(globalThis,'document',originalDocument);
    else delete globalThis.document;
  }
});

test('resizable group preserves the guarded layout persistence contract',async () => {
  const shell = await source('renderer/v2/src/components/app-shell/AppShell.tsx');
  const layout = shell.slice(shell.indexOf('const handleLayoutChanged'),shell.indexOf('const focusDetail'));
  assert.match(layout,/stableLayoutRef\.current = layout/u);
  assert.ok(layout.includes('if (suppressLayoutPersistenceRef.current || window.innerWidth < 960) return'));
  assert.ok(layout.includes('const next = { ...current, layout }'));
  assert.ok(layout.includes('persistAppShellLayoutState(next)'));
  assert.ok(!layout.includes('requestAnimationFrame'));
});
