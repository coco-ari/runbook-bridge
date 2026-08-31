import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const REQUIRED_SHADCN_COMPONENTS = [
  'accordion','alert','alert-dialog','badge','button','card','checkbox','collapsible',
  'command','context-menu','dialog','dropdown-menu','empty','field','input-group',
  'input','label','resizable','scroll-area','select','separator','sheet','sidebar',
  'skeleton','sonner','table','tabs','textarea','tooltip',
];

async function collectSourceFiles(root) {
  const entries = await fs.readdir(root,{ withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root,entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(entryPath));
    else if (/\.(?:ts|tsx|css)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test('production React shell composes shadcn/Radix with the typed desktop bridge',async () => {
  const sourceFiles = await collectSourceFiles('renderer/v2/src');
  const sourceEntries = await Promise.all(
    sourceFiles.map(async (sourcePath) => [sourcePath,await fs.readFile(sourcePath,'utf8')]),
  );
  const sourceByPath = new Map(sourceEntries);
  const nonBridgeSources = sourceEntries
    .filter(([sourcePath]) => !sourcePath.endsWith(path.join('bridge','ai-ops-v2.ts')))
    .map(([,source]) => source)
    .join('\n');
  const [
    manifest,
    shadcnConfig,
    reactHtml,
    appShell,
    projectRail,
    resourcePane,
    workspaceDetail,
    globalCommand,
    pluginEditor,
    projectSurfaces,
    environmentSurfaces,
    workspaceModel,
    layoutState,
    navigation,
    styles,
    smoke,
    ...shadcnSources
  ] = await Promise.all([
    fs.readFile('package.json','utf8'),
    fs.readFile('renderer/v2/components.json','utf8'),
    fs.readFile('renderer/v2/index.html','utf8'),
    fs.readFile('renderer/v2/src/components/app-shell/AppShell.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/project-rail/ProjectRail.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/resource-pane/ResourcePane.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/detail-workspace/WorkspaceDetail.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/app-shell/GlobalCommand.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/plugins/PluginEditorWorkspace.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/projects/ProjectMutationSurfaces.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/environments/EnvironmentMutationSurfaces.tsx','utf8'),
    fs.readFile('renderer/v2/src/features/workspace/workspace-read-model.ts','utf8'),
    fs.readFile('renderer/v2/src/state/layout-state.ts','utf8'),
    fs.readFile('renderer/v2/src/hooks/use-roving-navigation.ts','utf8'),
    fs.readFile('renderer/v2/src/styles/globals.css','utf8'),
    fs.readFile('scripts/ui-react-foundation-smoke.cjs','utf8'),
    ...REQUIRED_SHADCN_COMPONENTS.map((name) =>
      fs.readFile(`renderer/v2/src/components/ui/${name}.tsx`,'utf8'),
    ),
  ]);
  const packageJson = JSON.parse(manifest);
  const config = JSON.parse(shadcnConfig);
  const allShadcnSources = shadcnSources.join('\n');
  const tabsSource = sourceByPath.get(path.join('renderer','v2','src','components','ui','tabs.tsx')) ?? '';

  assert.ok(packageJson.dependencies['radix-ui']);
  assert.ok(packageJson.dependencies['react-resizable-panels']);
  assert.ok(packageJson.dependencies.cmdk);
  assert.ok(packageJson.dependencies.sonner);
  assert.equal(packageJson.dependencies['@radix-ui/react-slot'],undefined);
  assert.equal(packageJson.dependencies['lucide-react'],undefined);
  assert.equal(packageJson.dependencies['next-themes'],undefined);
  assert.equal(config.style,'radix-nova');
  assert.equal(config.iconLibrary,'phosphor');
  assert.equal(config.rsc,false);
  assert.match(allShadcnSources,/radix-ui/u);

  assert.match(appShell,/getAiOpsV2/u);
  assert.match(appShell,/useWorkspaceOverview/u);
  assert.match(appShell,/useEnvironmentPlugins/u);
  assert.match(appShell,/useEnvironmentStatus/u);
  assert.match(appShell,/ProjectMutationSurfaces/u);
  assert.match(appShell,/EnvironmentMutationSurfaces/u);
  assert.match(appShell,/PluginEditorWorkspace/u);
  assert.match(appShell,/createPluginWorkMode/u);
  assert.match(appShell,/editorLeave && !await editorLeave\(\)/u);
  assert.match(appShell,/PluginMetadataDialog/u);
  assert.match(appShell,/PluginDeleteDialog/u);
  assert.match(appShell,/outcome\.saveStrategy === "connect-current"/u);
  assert.match(appShell,/outcome\.saveStrategy === "restore-previous"/u);
  assert.doesNotMatch(appShell,/APP_SHELL_FIXTURES|MockActionSurfaces/u);
  assert.match(appShell,/defaultLayout=/u);
  assert.match(appShell,/onLayoutChanged=/u);
  assert.match(appShell,/usePanelRef/u);
  assert.match(appShell,/collapsedSize=\{PROJECT_RAIL_COLLAPSED_SIZE\}/u);
  assert.match(appShell,/collapsedSize="48px"/u);
  assert.equal((appShell.match(/<ResizableHandle/gu) ?? []).length,2);
  assert.match(appShell,/href="#detail-main"/u);
  assert.match(appShell,/跳到详情内容/u);
  assert.match(appShell,/data-shell-ready="true"/u);

  assert.match(projectRail,/WorkspaceProjectReadModel/u);
  assert.match(projectRail,/SidebarProvider/u);
  assert.match(projectRail,/SidebarMenuButton/u);
  assert.doesNotMatch(projectRail,/<Avatar(?:Fallback|Image)?\b/u);
  assert.match(projectRail,/data-project-compact-name/u);
  assert.match(projectRail,/data-project-compact-status/u);
  assert.match(projectRail,/data-project-name/u);
  assert.match(projectRail,/data-project-status-badge/u);
  assert.doesNotMatch(projectRail,/data-project-rail-toggle|data-testid="project-(?:collapse|expand)"/u,
    'the project rail header has no separate collapse arrow');
  assert.match(appShell,/aria-describedby="project-rail-resize-help"/u);
  assert.match(projectRail,/Tooltip/u);
  assert.match(projectRail,/DropdownMenu/u);
  assert.match(projectRail,/ContextMenu/u);
  assert.match(projectRail,/Empty/u);
  assert.match(projectRail,/data-testid="confirmation-center"/u);
  assert.match(projectRail,/data-testid="add-project-footer"/u);
  assert.ok(
    projectRail.lastIndexOf('data-testid="confirmation-center"') <
      projectRail.lastIndexOf('<SidebarContent'),
    'global confirmation belongs above the project list',
  );

  assert.match(resourcePane,/WorkspaceEnvironmentReadModel/u);
  assert.match(resourcePane,/Accordion/u);
  assert.match(resourcePane,/ContextMenu/u);
  assert.match(resourcePane,/DropdownMenu/u);
  assert.match(resourcePane,/ScrollArea/u);
  assert.match(resourcePane,/Empty/u);
  assert.match(resourcePane,/data-testid="add-environment-footer"/u);

  assert.match(workspaceDetail,/TabsList/u);
  assert.match(workspaceDetail,/variant="navigation"/u);
  assert.match(workspaceDetail,/aria-label="详情视图"/u);
  assert.match(workspaceDetail,/data-testid="detail-tabs"/u);
  assert.match(workspaceDetail,/data-detail-tab=\{tab\.value\}/u);
  assert.match(workspaceDetail,/w-max min-w-max justify-start/u);
  assert.match(workspaceDetail,/viewportClassName="\[&>div\]:min-w-max!"/u);
  assert.match(workspaceDetail,/min-w-max flex-none text-xs/u);
  assert.doesNotMatch(workspaceDetail,/max-w-\[720px\]/u);
  assert.doesNotMatch(workspaceDetail,/TabsTrigger[\s\S]*?flex-1 px-2/u);
  assert.match(workspaceDetail,/min-w-0 flex-1/u);
  assert.doesNotMatch(workspaceDetail,/onOpenConnection|onOpenAgentAccess/u);
  assert.match(workspaceDetail,/scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/u);
  assert.match(workspaceDetail,/matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? "auto" : "smooth"/u);
  assert.match(workspaceDetail,/id="detail-main" tabIndex=\{-1\}/u);
  assert.match(workspaceDetail,/focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring\/60/u);
  assert.match(workspaceDetail,/new ResizeObserver\(keepActiveTabVisible\)/u);
  assert.match(workspaceDetail,/viewportRef=\{detailTabsViewportRef\}/u);
  assert.match(workspaceDetail,/data-testid="detail-tabs-scroll-backward"/u);
  assert.match(workspaceDetail,/data-testid="detail-tabs-scroll-forward"/u);
  assert.match(workspaceDetail,/viewport\.scrollBy\(/u);
  assert.match(workspaceDetail,/data-overflow=\{detailTabsOverflow\.overflow\}/u);
  assert.match(workspaceDetail,/activationMode="manual"/u);
  assert.match(workspaceDetail,/orientation="horizontal"/u);
  assert.match(tabsSource,/orientation=\{orientation\}/u);
  assert.match(tabsSource,/navigation:/u);
  assert.match(tabsSource,/variant=navigation/u);
  assert.match(tabsSource,/rounded-lg bg-surface-inset\/80/u);
  assert.match(tabsSource,/data-active:bg-primary\/\[0\.14\]/u);
  assert.doesNotMatch(tabsSource,/variant=navigation[^\n]*data-active:after/u);
  assert.match(workspaceDetail,/DetailTabIcon/u);
  assert.match(workspaceDetail,/ProjectOverview/u);
  assert.match(workspaceDetail,/EnvironmentOverview/u);
  assert.match(workspaceDetail,/PluginOverview/u);
  assert.match(workspaceDetail,/PluginConnectionPanel/u);
  assert.match(workspaceDetail,/PluginAgentAccess/u);
  assert.match(workspaceDetail,/RunbookFeature/u);
  assert.match(workspaceDetail,/QuickQuestionsFeature/u);
  assert.match(workspaceDetail,/AuditFeature/u);
  assert.match(workspaceDetail,/ConfirmationsFeature/u);
  assert.doesNotMatch(workspaceDetail,/variant="line"/u);
  assert.doesNotMatch(workspaceDetail,/variant="segmented"/u);
  assert.match(globalCommand,/CommandDialog/u);
  assert.match(globalCommand,/WorkspaceProjectReadModel/u);
  assert.match(globalCommand,/ctrlKey/u);

  assert.match(pluginEditor,/data-testid="plugin-editor-workspace"/u);
  assert.doesNotMatch(pluginEditor,/SheetContent|components\/ui\/sheet/u);
  assert.match(pluginEditor,/onRegisterLeaveGuard\(requestLeave\)/u);
  assert.match(pluginEditor,/AlertDialogContent/u);
  assert.match(pluginEditor,/editor\.isDirty/u);
  assert.match(projectSurfaces,/DialogContent/u);
  assert.match(projectSurfaces,/AlertDialogContent/u);
  assert.match(projectSurfaces,/FieldGroup/u);
  assert.match(environmentSurfaces,/DialogContent/u);
  assert.match(environmentSurfaces,/AlertDialogContent/u);
  assert.match(environmentSurfaces,/FieldGroup/u);

  for (const status of [
    'connected','disconnected','connecting','partial','blocked','error',
  ]) assert.match(workspaceModel,new RegExp(`"${status}"`,'u'));
  assert.match(workspaceModel,/normalizeWorkspaceOverview/u);
  assert.match(workspaceModel,/normalizeWorkspacePluginList/u);
  assert.match(workspaceModel,/normalizeEnvironmentRuntime/u);

  assert.match(layoutState,/runbook-bridge:app-shell-layout:v1/u);
  assert.match(layoutState,/window\.localStorage\.getItem/u);
  assert.match(layoutState,/window\.localStorage\.setItem/u);
  assert.match(layoutState,/project-panel/u);
  assert.match(navigation,/ArrowDown/u);
  assert.match(navigation,/ArrowUp/u);
  assert.match(navigation,/Home/u);
  assert.match(navigation,/End/u);
  assert.match(navigation,/stopPropagation/u);
  assert.match(styles,/--color-popover/u);
  assert.match(styles,/--color-sidebar/u);
  assert.match(styles,/@custom-variant data-open/u);
  assert.match(styles,/forced-colors: active/u);
  assert.match(styles,/prefers-reduced-motion: reduce/u);
  assert.match(styles,/overflow: hidden/u);
  assert.match(styles,/--primary: #37d7a0/u);
  assert.match(styles,/--surface-selected: #24242e/u);

  assert.match(reactHtml,/style-src 'self' 'unsafe-inline'/u);
  assert.match(reactHtml,/connect-src 'none'/u);
  assert.doesNotMatch(reactHtml,/script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
  assert.match(smoke,/width:960/u);
  assert.match(smoke,/height:640/u);
  assert.match(smoke,/1280/u);
  assert.match(smoke,/1680/u);
  assert.match(smoke,/capturePage/u);
  assert.match(smoke,/const accessibility/u);
  assert.match(smoke,/assert\.deepEqual\(mutationCalls,\[\]\)/u);
  assert.match(smoke,/readCalls\.some/u);
  assert.match(smoke,/externalRequests/u);

  assert.doesNotMatch(nonBridgeSources,/window\.aiOps|ipcRenderer|contextBridge|node:[a-z]/u);
  assert.doesNotMatch(nonBridgeSources,/lucide-react|next-themes|@base-ui|base-ui/u);
  assert.doesNotMatch(nonBridgeSources,/https?:\/\//u);
  assert.doesNotMatch(nonBridgeSources,/[—–]/u);
  assert.ok(sourceByPath.has(path.join('renderer','v2','src','bridge','ai-ops-v2.ts')));
});
