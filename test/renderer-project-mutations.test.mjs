import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname,'..');
const read = (relativePath) => fs.readFileSync(path.join(root,relativePath),'utf8');
const importModule = (relativePath) => import(pathToFileURL(path.join(root,relativePath)).href);

test('project mutation model preserves normalized names and the local stable order', async () => {
  const model = await importModule(
    'renderer/v2/src/features/projects/project-mutation-model.ts',
  );

  assert.deepEqual(model.normalizeProjectName('  Ａ 项目  '),{ok:true,value:'A 项目'});
  assert.equal(model.normalizeProjectName('   ').ok,false);
  assert.equal(model.normalizeProjectName(`项目\u0000`).ok,false);
  assert.equal(model.normalizeProjectName('项'.repeat(121)).ok,false);
  assert.deepEqual(model.normalizeEnvironmentNameForProject(' 生产 '),{ok:true,value:'生产'});
  assert.equal(model.projectDeleteConfirmationMatches('生产项目',' 生产项目 '),true);
  assert.equal(model.projectDeleteConfirmationMatches('生产项目','生产'),false);

  assert.deepEqual(model.parseStoredProjectOrder('{bad'),[]);
  assert.deepEqual(
    model.normalizeProjectOrder(['project-a','project-b','project-c'],[
      'project-b','project-b','deleted-project',
    ]),
    ['project-b','project-a','project-c'],
  );
  assert.deepEqual(
    model.moveProjectByOffset(['project-a','project-b'],'project-a',-1),
    {announcement:'已经是第一个项目',changed:false,order:['project-a','project-b']},
  );
  const moved = model.moveProjectByOffset(
    ['project-a','project-b','project-c'],'project-b',1,'项目 B',
  );
  assert.equal(moved.changed,true);
  assert.deepEqual(moved.order,['project-a','project-c','project-b']);
  assert.match(moved.announcement,/第 3 项，共 3 项/u);

  assert.equal(
    model.safeProjectMutationMessage({code:'INTERNAL_ERROR',message:'C:/secret/customer'},'操作失败'),
    '操作失败',
  );
  assert.equal(
    model.safeProjectMutationMessage({code:'CONFIG_REVISION_CONFLICT',message:'项目配置已经变化'},'操作失败'),
    '项目配置已经变化',
  );
});

test('project mutation controller is revision-bound, exact-scope and late-result fenced', () => {
  const controller = read('renderer/v2/src/features/projects/use-project-mutations.ts');
  assert.match(controller,/api\.createProject\(\{/u);
  assert.match(controller,/environmentName: environmentName\.value/u);
  assert.match(controller,/api\.updateProject\(\{/u);
  assert.match(controller,/expectedRevision: project\.revision/u);
  assert.match(controller,/projectId: project\.projectId/u);
  assert.match(controller,/api\.deleteProject\(\{ projectId: project\.projectId \}\)/u);
  assert.match(controller,/projectDeleteConfirmationMatches/u);
  assert.match(controller,/mayLeaveRef\.current\(project\.projectId\)/u);
  assert.match(controller,/result\.data\.projectId !== project\.projectId/u);
  assert.match(controller,/epochRef/u);
  assert.match(controller,/inFlightRef/u);
  assert.match(controller,/onCommittedRef/u);
  assert.match(controller,/toast\.warning/u);
  assert.doesNotMatch(controller,/toast\.success/u,'the App Shell owns the single success notification');
  const remove = controller.slice(controller.indexOf('const remove = useCallback'));
  assert.ok(remove.indexOf('start("delete")') < remove.indexOf('await mayLeaveRef.current'),
    'busy and duplicate-submission guards must cover the asynchronous leave check');
  assert.match(remove,/if \(!mountedRef\.current \|\| epochRef\.current !== epoch\) return false/u);
  assert.match(remove,/finally \{\s+finish\("delete", epoch\)/u);
  assert.doesNotMatch(controller,/window\.(?:confirm|prompt|alert)|console\./u);
  assert.doesNotMatch(controller,/credential|connectEnvironment|connectPlugin/u);
});

test('project mutations use compact Radix Dialogs and standalone typed delete with busy and focus guards', () => {
  const surface = read('renderer/v2/src/features/projects/ProjectMutationSurfaces.tsx');
  const dialog = read('renderer/v2/src/components/ui/dialog.tsx');
  const order = read('renderer/v2/src/features/projects/ProjectOrderController.tsx');
  assert.match(surface,/<Dialog/u);
  assert.doesNotMatch(surface,/<Sheet|components\/ui\/sheet/u);
  assert.match(surface,/<AlertDialog/u);
  assert.match(surface,/<Field/u);
  assert.match(surface,/<Input/u);
  assert.match(surface,/kind: "delete"; project: WorkspaceProjectReadModel/u);
  assert.match(surface,/data-testid="project-settings-dialog"/u);
  assert.match(surface,/if \(action\?\.kind === "delete"\) \{[\s\S]*?<AlertDialog/u);
  assert.match(surface,/max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/u);
  assert.match(surface,/projectDeleteConfirmationMatches/u);
  assert.match(surface,/onCloseAutoFocus/u);
  assert.match(surface,/restoreFocusRef/u);
  assert.match(surface,/if \(action\?\.kind === "create"\) \{\s+const createTarget = document\.querySelector<HTMLElement>\('\[data-testid="add-project-footer"\]'\)/u,
    'creation always returns to the stable project footer after a Command handoff');
  assert.match(surface,/requestedTarget !== document\.body/u,'Command handoff must restore an actionable footer, not body');
  assert.match(surface,/requestedTarget !== document\.documentElement/u);
  assert.match(surface,/projectRailTarget/u);
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
  assert.match(surface,/if \(await controller\.remove\(project, typedConfirmation\)\) \{\s+onActionChange\(null\)/u);
  assert.match(surface,/本机加密凭据仍保留/u);
  assert.match(surface,/<DialogFooter>[\s\S]*?form="rename-project-form"/u);
  const settings = surface.slice(surface.indexOf('data-testid="project-settings-dialog"'));
  assert.doesNotMatch(settings,/<AlertDialog|variant="destructive"|危险操作/u,
    'settings must not nest the deletion workflow');
  assert.doesNotMatch(surface,/<DialogDescription[^>]*\btitle=|modal=\{false\}/u);
  assert.match(dialog,/Dialog as DialogPrimitive.*from "radix-ui"/u);
  assert.match(dialog,/<DialogPrimitive\.Content/u);
  assert.match(order,/PROJECT_ORDER_STORAGE_KEY/u);
  assert.match(order,/altKey/u);
  assert.match(order,/ArrowUp/u);
  assert.match(order,/ArrowDown/u);
  assert.match(order,/aria-live="polite"/u);
  assert.match(order,/focus\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(`${surface}\n${order}`,/window\.(?:confirm|prompt|alert)|dangerouslySetInnerHTML|console\./u);
  assert.doesNotMatch(`${surface}\n${order}`,/ipcRenderer|contextBridge|https?:\/\//u);
});
