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

test('relative project moves support both drop edges without mutating the source order', async () => {
  const {moveProjectBeforeOrAfter} = await importModule(
    'renderer/v2/src/features/projects/project-mutation-model.ts',
  );
  const original = Object.freeze(['project-a','project-b','project-c','project-d']);
  const cases = [
    ['project-a','project-c',false,['project-b','project-a','project-c','project-d']],
    ['project-a','project-c',true,['project-b','project-c','project-a','project-d']],
    ['project-d','project-b',false,['project-a','project-d','project-b','project-c']],
    ['project-d','project-b',true,['project-a','project-b','project-d','project-c']],
    ['project-a','project-d',true,['project-b','project-c','project-d','project-a']],
    ['project-d','project-a',false,['project-d','project-a','project-b','project-c']],
  ];
  for (const [source,target,after,expected] of cases) {
    assert.deepEqual(moveProjectBeforeOrAfter(original,source,target,after),expected);
  }
  assert.deepEqual(original,['project-a','project-b','project-c','project-d']);
});

test('relative project moves ignore unchanged positions and missing drag participants', async () => {
  const {moveProjectBeforeOrAfter} = await importModule(
    'renderer/v2/src/features/projects/project-mutation-model.ts',
  );
  const original = ['project-a','project-b','project-c'];
  for (const [source,target,after] of [
    ['project-b','project-b',false],
    ['project-b','project-b',true],
    ['project-a','project-b',false],
    ['project-b','project-a',true],
    ['removed-project','project-a',false],
    ['project-a','removed-project',true],
  ]) {
    assert.deepEqual(moveProjectBeforeOrAfter(original,source,target,after),original);
  }
  assert.deepEqual(moveProjectBeforeOrAfter([],'project-a','project-b',false),[]);
});

test('persisted relative order survives a fresh workspace read with added and removed projects', async () => {
  const {moveProjectBeforeOrAfter,normalizeProjectOrder,parseStoredProjectOrder} = await importModule(
    'renderer/v2/src/features/projects/project-mutation-model.ts',
  );
  const moved = moveProjectBeforeOrAfter(
    ['project-a','project-b','project-c'],'project-c','project-a',false,
  );
  const saved = parseStoredProjectOrder(JSON.stringify(moved));
  assert.deepEqual(
    normalizeProjectOrder(['project-a','project-b','project-c'],saved),
    ['project-c','project-a','project-b'],
  );
  assert.deepEqual(
    normalizeProjectOrder(['project-a','project-c','project-d'],saved),
    ['project-c','project-a','project-d'],
  );
  assert.deepEqual(normalizeProjectOrder([],saved),[]);
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
  assert.match(order,/if \(!projectsReady\) return\s+if \(sameOrder\(order, normalizedOrder\)\) return/u,
    'startup loading must not erase the stored order before a successful workspace read');
  assert.match(order,/if \(!projectsReady\) return false/u,
    'order changes must wait for a successful workspace read');
  const commit = order.slice(order.indexOf('const commit = useCallback'),order.indexOf('const moveProject = useCallback'));
  assert.ok(commit.indexOf('storage.setItem') < commit.indexOf('setOrder(next)'),
    'a failed storage write must not publish an order that was not saved');
  assert.match(commit,/if \(!storage\) throw new Error\("Project order storage is unavailable"\)/u,
    'unavailable storage must use the save-failure path rather than report a successful move');
  assert.match(commit,/catch \{[\s\S]*?const failureMessage = "项目顺序保存失败，已恢复原顺序。"\s+setAnnouncement\(failureMessage\)\s+toast\.error\(failureMessage\)\s+return false/u,
    'save failures must be visible for pointer users as well as announced to assistive technology');
  assert.match(order,/altKey/u);
  assert.match(order,/ArrowUp/u);
  assert.match(order,/ArrowDown/u);
  assert.match(order,/aria-live="polite"/u);
  assert.match(order,/focus\(\{ preventScroll: true \}\)/u);
  assert.doesNotMatch(`${surface}\n${order}`,/window\.(?:confirm|prompt|alert)|dangerouslySetInnerHTML|console\./u);
  assert.doesNotMatch(`${surface}\n${order}`,/ipcRenderer|contextBridge|https?:\/\//u);
});
