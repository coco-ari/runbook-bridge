import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname,'..');
const read = (relativePath) => fs.readFileSync(path.join(root,relativePath),'utf8');
const importModule = (relativePath) => import(pathToFileURL(path.join(root,relativePath)).href);

function environment(environmentId,name,{plugins = 0,phase = 'disconnected',desiredConnected = false} = {}) {
  return {
    projectId:'project-a',environmentId,name,revision:1,pluginCount:plugins,
    readyPluginCount:plugins,draftCount:0,resourcePreview:[],resourcePreviewTruncated:false,
    status:phase === 'connected' ? 'connected' : 'disconnected',
    runtime:{
      projectId:'project-a',environmentId,phase,desiredConnected,sequence:1,plugins:[],pluginsPartial:true,
      blockedCount:0,connectedCount:phase === 'connected' ? 1 : 0,draftCount:0,eligibleCount:plugins,
      errorCount:0,status:phase === 'connected' ? 'connected' : 'disconnected',
    },
  };
}

function project(environments) {
  return {
    projectId:'project-a',name:'项目 A',revision:7,isolated:false,environments,
    environmentCount:environments.length,pluginCount:environments.reduce((sum,item) => sum + item.pluginCount,0),
    status:'disconnected',
  };
}

test('environment mutation model fails closed on scope, contents and runtime', async () => {
  const model = await importModule(
    'renderer/v2/src/features/environments/environment-mutation-model.ts',
  );
  assert.deepEqual(model.normalizeEnvironmentName('  Ａ 环境  '),{ok:true,value:'A 环境'});
  assert.equal(model.normalizeEnvironmentName(' ').ok,false);
  assert.equal(model.normalizeEnvironmentName('环'.repeat(121)).ok,false);

  const emptyA = environment('environment-a','生产');
  const emptyB = environment('environment-b','预发');
  assert.equal(model.assessEnvironmentDeletion(project([emptyA]),emptyA).allowed,false);
  assert.match(model.assessEnvironmentDeletion(
    project([environment('environment-a','生产',{plugins:2}),emptyB]),
    environment('environment-a','生产',{plugins:2}),
  ).message,/2 个插件/u);
  assert.match(model.assessEnvironmentDeletion(
    project([environment('environment-a','生产',{phase:'connected'}),emptyB]),
    environment('environment-a','生产',{phase:'connected'}),
  ).message,/断开/u);
  assert.equal(model.assessEnvironmentDeletion(project([emptyA,emptyB]),emptyA).allowed,true);

  const wrongScope = {...emptyA,projectId:'project-b'};
  assert.equal(model.assessEnvironmentDeletion(project([emptyA,emptyB]),wrongScope).allowed,false);
  const spoofedEmpty = {...emptyA,pluginCount:0};
  assert.equal(model.assessEnvironmentDeletion(
    project([environment('environment-a','生产',{plugins:2}),emptyB]),spoofedEmpty,
  ).allowed,false,'deletion must use the authoritative project member');
  assert.equal(model.environmentNameIsDuplicate(project([emptyA,emptyB]),' 预发 '),true);
  assert.equal(model.environmentNameIsDuplicate(project([emptyA,emptyB]),'预发','environment-b'),false);
  assert.equal(model.suggestedEnvironmentAfterDelete([emptyA,emptyB],'environment-a'),'environment-b');
  assert.equal(model.suggestedEnvironmentAfterDelete([emptyA,emptyB],'environment-b'),'environment-a');
  assert.equal(model.validEnvironmentOrder([emptyA,emptyB],['environment-b','environment-a']),true);
  assert.equal(model.validEnvironmentOrder([emptyA,emptyB],['environment-a','environment-a']),false);
  assert.deepEqual(
    model.moveEnvironmentByOffset([emptyA,emptyB],'environment-a',1).order,
    ['environment-b','environment-a'],
  );
  assert.equal(
    model.safeEnvironmentMutationMessage({code:'INTERNAL_ERROR',message:'secret row'},'操作失败'),
    '操作失败',
  );
});

test('environment controller binds revisions, exact scopes, deletion preflight and server order', () => {
  const controller = read('renderer/v2/src/features/environments/use-environment-mutations.ts');
  assert.match(controller,/api\.createEnvironment\(\{/u);
  assert.match(controller,/projectId: project\.projectId/u);
  assert.match(controller,/api\.updateEnvironment\(\{/u);
  assert.match(controller,/environmentId: currentEnvironment\.environmentId/u);
  assert.match(controller,/expectedRevision: currentEnvironment\.revision/u);
  assert.match(controller,/assessEnvironmentDeletion\(project, environment\)/u);
  assert.match(controller,/api\.deleteEnvironment\(scope\)/u);
  assert.match(controller,/mayLeaveRef\.current\(scope\)/u);
  assert.match(controller,/api\.reorderEnvironments\(\{/u);
  assert.match(controller,/expectedRevision: project\.revision/u);
  assert.match(controller,/validEnvironmentOrder/u);
  assert.match(controller,/suggestedEnvironmentAfterDelete/u);
  assert.match(controller,/returnedEnvironmentId !== currentEnvironment\.environmentId/u);
  assert.match(controller,/epochRef/u);
  assert.match(controller,/inFlightRef/u);
  assert.match(controller,/toast\.warning/u);
  assert.doesNotMatch(controller,/toast\.success/u,'the App Shell owns the single success notification');
  const remove = controller.slice(controller.indexOf('const remove = useCallback'),controller.indexOf('const reorder = useCallback'));
  assert.ok(remove.indexOf('start("delete")') < remove.indexOf('await mayLeaveRef.current'),
    'busy and duplicate-submission guards must cover the asynchronous leave check');
  assert.match(remove,/if \(!mountedRef\.current \|\| epochRef\.current !== epoch\) return false/u);
  assert.match(remove,/finally \{\s+finish\("delete", epoch\)/u);
  assert.doesNotMatch(controller,/window\.(?:confirm|prompt|alert)|console\./u);
  assert.doesNotMatch(controller,/credential|connectEnvironment|connectPlugin/u);
});

test('environment compact Dialogs and standalone deletion preserve Radix, busy, focus and scope contracts', () => {
  const surface = read('renderer/v2/src/features/environments/EnvironmentMutationSurfaces.tsx');
  const leave = read('renderer/v2/src/features/environments/DirtyLeaveGuard.tsx');
  const order = read('renderer/v2/src/features/environments/EnvironmentOrderController.tsx');
  assert.match(surface,/<Dialog/u);
  assert.doesNotMatch(surface,/<Sheet|components\/ui\/sheet/u);
  assert.match(surface,/<AlertDialog/u);
  assert.match(surface,/kind: "delete"/u);
  assert.match(surface,/data-testid="environment-settings-dialog"/u);
  assert.match(surface,/if \(action\?\.kind === "delete"\) \{[\s\S]*?<AlertDialog/u);
  assert.match(surface,/max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/u);
  assert.match(surface,/assessEnvironmentDeletion/u);
  assert.match(surface,/onCloseAutoFocus/u);
  assert.match(surface,/if \(action\?\.kind === "create"\) \{\s+const createTarget = document\.querySelector<HTMLElement>\('\[data-testid="add-environment-footer"\]'\)/u,
    'creation always returns to the stable environment footer after a Command handoff');
  assert.match(surface,/requestedTarget !== document\.body/u,'Command handoff must restore an actionable footer, not body');
  assert.match(surface,/requestedTarget !== document\.documentElement/u);
  assert.match(surface,/environmentRailTarget/u);
  assert.match(surface,/pendingRestoreTargetRef/u);
  assert.match(surface,/import \{ focusWorkspaceElement \} from "@\/lib\/workspace-focus"/u);
  assert.match(surface,/event\.preventDefault\(\)\s+requestAnimationFrame\(\(\) => focusWorkspaceElement\(target\)\)/u);
  assert.doesNotMatch(surface,/target\.focus\(/u,'deferred restoration must not steal focus from a newer modal');
  assert.doesNotMatch(surface,/deleteTriggerRef|deleteOpen|setDeleteOpen/u);
  assert.match(surface,/if \(controller\.busy\) return/u);
  assert.match(surface,/onEscapeKeyDown=\{preventDismissWhileBusy\}/u);
  assert.match(surface,/onInteractOutside=\{preventDismissWhileBusy\}/u);
  assert.match(surface,/showCloseButton=\{controller\.busy === null\}/u);
  assert.match(surface,/<AlertDialogCancel disabled=\{controller\.busy !== null\}/u);
  assert.match(surface,/if \(await controller\.remove\(project, environment\)\) \{\s+onActionChange\(null\)/u);
  assert.match(surface,/deleteAssessment\.message/u);
  assert.match(surface,/<DialogFooter>[\s\S]*?form="rename-environment-form"/u);
  const settings = surface.slice(surface.indexOf('data-testid="environment-settings-dialog"'));
  assert.doesNotMatch(settings,/<AlertDialog|variant="destructive"|危险操作/u,
    'settings must not nest the deletion workflow');
  assert.doesNotMatch(surface,/modal=\{false\}/u);
  assert.doesNotMatch(surface,/<(?:Dialog|Sheet)Description[^>]*\btitle=/u);
  assert.match(leave,/saveInFlight/u);
  assert.match(leave,/正在保存，请稍候/u);
  assert.match(leave,/onLeaveApproved/u);
  assert.match(leave,/restorePreEditConnections|安全结束当前编辑会话/u);
  assert.match(leave,/<AlertDialog/u);
  assert.match(leave,/放弃未保存的更改/u);
  assert.match(order,/persistOrder/u);
  assert.match(order,/已恢复原顺序/u);
  assert.match(order,/try \{[\s\S]*persistRef\.current\(project, next\)[\s\S]*catch/u);
  assert.match(order,/aria-live="polite"/u);
  assert.match(order,/ArrowUp/u);
  assert.match(order,/ArrowDown/u);
  assert.doesNotMatch(`${surface}\n${leave}\n${order}`,/window\.(?:confirm|prompt|alert)|dangerouslySetInnerHTML|console\./u);
  assert.doesNotMatch(`${surface}\n${leave}\n${order}`,/ipcRenderer|contextBridge|https?:\/\//u);
});
