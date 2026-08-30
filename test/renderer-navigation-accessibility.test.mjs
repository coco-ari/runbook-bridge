import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname,'..');
const read = (relativePath) => fs.readFile(path.join(root,relativePath),'utf8');
const importModule = (relativePath) => import(pathToFileURL(path.join(root,relativePath)).href);

test('persisted panel layouts accept only exact positive finite percentages near 100', async () => {
  const layout = await importModule('renderer/v2/src/state/layout-state.ts');
  const panelIds = layout.APP_SHELL_PANEL_IDS;

  assert.equal(layout.isAppShellLayout(layout.DEFAULT_APP_SHELL_LAYOUT),true);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: 20.04,
    [panelIds.resource]: 31.97,
    [panelIds.detail]: 47.99,
  }),true);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: 20,
    [panelIds.resource]: 32,
    [panelIds.detail]: 48,
    unexpected: 1,
  }),false);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: 0,
    [panelIds.resource]: 40,
    [panelIds.detail]: 60,
  }),false);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: -2,
    [panelIds.resource]: 42,
    [panelIds.detail]: 60,
  }),false);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: Number.POSITIVE_INFINITY,
    [panelIds.resource]: 32,
    [panelIds.detail]: 48,
  }),false);
  assert.equal(layout.isAppShellLayout({
    [panelIds.project]: 20,
    [panelIds.resource]: 32,
    [panelIds.detail]: 47.5,
  }),false);
});

test('project and resource navigation expose one visible roving tab stop and valid current semantics', async () => {
  const [hook,projectRail,resourcePane,styles] = await Promise.all([
    read('renderer/v2/src/hooks/use-roving-navigation.ts'),
    read('renderer/v2/src/components/project-rail/ProjectRail.tsx'),
    read('renderer/v2/src/components/resource-pane/ResourcePane.tsx'),
    read('renderer/v2/src/styles/globals.css'),
  ]);

  assert.match(hook,/event\.defaultPrevented/u);
  for (const modifier of ['altKey','ctrlKey','metaKey','shiftKey']) {
    assert.match(hook,new RegExp(`event\\.${modifier}`,'u'));
  }
  assert.match(hook,/setSingleTabStop/u);
  assert.match(hook,/onFocusCapture/u);
  assert.match(hook,/navigationItemFromTarget\(event\.currentTarget, event\.target\)/u);
  assert.match(hook,/data-slot"\) === "accordion-content"/u);
  assert.doesNotMatch(hook,/document\.activeElement/u);

  assert.match(projectRail,/<nav[\s\S]*?aria-label="项目导航"/u);
  assert.match(projectRail,/onFocusCapture=\{projectNavigation\.onFocusCapture\}/u);
  assert.match(projectRail,/tabIndex=\{tabStopProjectId === project\.projectId \? 0 : -1\}/u);
  assert.match(projectRail,/aria-current=\{selected \? "page" : undefined\}/u);
  assert.match(projectRail,/aria-disabled=\{project\.isolated \|\| undefined\}/u);
  assert.match(projectRail,/项目配置已隔离，无法选择、排序或新增环境/u);
  assert.match(projectRail,/if \(!project\.isolated\) onProjectKeyDown/u);
  assert.doesNotMatch(projectRail,/data-project-meta/u);
  assert.match(projectRail,/data-project-status-badge/u);
  assert.match(projectRail,/\[&_svg\]:size-3!/u);
  assert.doesNotMatch(projectRail,/SidebarMenuBadge/u);
  assert.match(projectRail,/from "@\/components\/ui\/input-group"/u);
  assert.match(projectRail,/<InputGroup[\s\S]*?<InputGroupAddon[\s\S]*?<InputGroupInput/u);
  assert.match(projectRail,/SidebarMenuSkeleton/u);
  assert.match(projectRail,/import \{ Kbd \} from "@\/components\/ui\/kbd"/u);
  assert.match(projectRail,/<Kbd[\s\S]*?>[\s\S]*?Ctrl N[\s\S]*?<\/Kbd>/u);
  assert.match(projectRail,/data-testid="project-search"/u);
  assert.match(projectRail,/<InputGroupInput[\s\S]*?text-xs!/u,
    'project search overrides the global native-input font reset');
  assert.match(projectRail,/MagnifyingGlass[^>]*className="[^"]*size-3\.5/u,
    'the project search icon keeps its own width');
  assert.match(projectRail,/project\.name \+ " " \+ projectDescription\(project\)/u);
  assert.match(projectRail,/visibleProjects\.find/u);
  assert.match(projectRail,/data-testid="project-search-empty-state"/u);
  assert.match(projectRail,/没有匹配项目/u);
  assert.match(projectRail,/按项目名或描述搜索项目/u);
  assert.match(projectRail,/data-testid="project-actions-footer"/u);
  assert.match(projectRail,/className="h-10 w-full justify-start gap-2/u);
  assert.match(projectRail,/"shrink-0 border-t border-sidebar-border bg-sidebar\/95"/u);
  assert.match(projectRail,/"gap-0 px-2 py-2"/u);
  assert.match(projectRail,/data-testid="project-list-scroll"/u);
  assert.ok(
    projectRail.indexOf('data-testid="project-search"') < projectRail.indexOf('<nav'),
    'project search stays outside roving project navigation',
  );
  assert.ok(
    projectRail.lastIndexOf('</ScrollArea>') < projectRail.indexOf('data-testid="add-project-footer"'),
    'add-project action stays outside the scroll area',
  );
  assert.doesNotMatch(projectRail,/项目范围彼此隔离|<Kbd[\s\S]*?>[\s\S]*?Ctrl K[\s\S]*?<\/Kbd>/u);
  assert.doesNotMatch(projectRail,/<(?:button|details|summary|select)\b/u);
  assert.doesNotMatch(projectRail,/aria-selected=/u);

  const header = projectRail.slice(projectRail.indexOf('<SidebarHeader'),projectRail.indexOf('</SidebarHeader>'));
  const footer = projectRail.slice(projectRail.indexOf('<SidebarFooter'));
  assert.doesNotMatch(header,/data-project-rail-toggle|project-expand|project-collapse|CaretLeft|CaretRight|\bcollapsed\b/u);
  assert.match(header,/AI 运维工具/u);
  assert.match(header,/本地三栏工作台/u);
  assert.match(projectRail,/<SidebarContent[^>]*id="project-navigation-content"/u);
  assert.doesNotMatch(footer,/project-expand|project-rail-toggle|CaretRight/u);
  const footerButton = footer.slice(footer.indexOf('<Button'),footer.indexOf('</Button>'));
  assert.match(footerButton,/variant="outline"/u);
  assert.doesNotMatch(footerButton,/<Kbd|\bcollapsed\b/u);
  assert.doesNotMatch(projectRail,/AvatarFallback|data-project-monogram|data-project-short-name|buildProjectRailIdentities/u);
  assert.match(projectRail,/data-project-compact-name>\s*\{project.name\}/u);
  assert.match(projectRail,/"h-9 w-full justify-start/u);
  assert.match(projectRail,/truncate text-left text-xs/u);
  assert.match(projectRail,/data-project-compact-status/u);
  assert.match(projectRail,/data-status="disconnected" title=\{statusLabel\(project.status\)\}/u);
  assert.match(projectRail,/size-\[7px\] rounded-full border border-muted-foreground/u);
  assert.doesNotMatch(projectRail,/absolute right-0 bottom-0/u);
  assert.match(projectRail,/aria-label=\{`\$\{project.name\}/u);
  assert.match(projectRail,/hidden: false/u);
  assert.match(projectRail,/statusLabel\(project.status\)/u);
  const projectFilter = projectRail.slice(projectRail.indexOf('const visibleProjects ='),projectRail.indexOf('const selectedProject ='));
  assert.doesNotMatch(projectFilter,/\bcollapsed\b/u,'the same query filters projects at either rail width');

  assert.match(resourcePane,/onFocusCapture=\{resourceNavigation\.onFocusCapture\}/u);
  assert.match(resourcePane,/onKeyDownCapture=\{resourceNavigation\.onKeyDown\}/u);
  assert.match(resourcePane,/tabStopItemId === `environment:/u);
  assert.match(resourcePane,/=== `plugin:/u);
  assert.match(resourcePane,/const selectedPluginIsVisible =/u);
  assert.match(resourcePane,/expandedEnvironmentIds\.includes\(selectedEnvironment\.environmentId\)/u);
  assert.match(resourcePane,/selectedEnvironment && selectedPluginIsVisible/u);
  const environmentTrigger = resourcePane.slice(resourcePane.indexOf('<AccordionTrigger'),resourcePane.indexOf('</AccordionTrigger>'));
  assert.match(environmentTrigger,/if \(!environmentSelected\) onSelectEnvironment\(\)/u,
    'an environment title returns from a selected plugin to environment details on mouse or keyboard activation');
  assert.doesNotMatch(environmentTrigger,/preventDefault\(|stopPropagation\(/u,
    'the environment header preserves native mouse and keyboard Accordion toggling');
  assert.match(resourcePane,/onValueChange=\{setExpandedEnvironmentIds\}/u);
  assert.match(resourcePane,/reconcileEnvironmentExpansion\([\s\S]*?previous\?\.target \?\? null,[\s\S]*?previous\?\.environmentIds \?\? \[\]/u,
    'refresh reconciliation distinguishes navigation from late-arriving environment data');
  assert.match(resourcePane,/aria-current=\{environmentSelected \? "page" : undefined\}/u);
  assert.match(resourcePane,/aria-current=\{selected \? "page" : undefined\}/u);
  assert.match(resourcePane,/data-testid="isolated-project-resource-state"/u);
  assert.match(resourcePane,/data-testid="resource-list-scroll"/u);
  assert.match(resourcePane,/data-testid="resource-actions-footer"/u);
  const resourceFooterButton = resourcePane.slice(resourcePane.lastIndexOf('<Button'),resourcePane.lastIndexOf('</Button>'));
  assert.match(resourceFooterButton,/data-testid="add-environment-footer"/u);
  assert.match(resourceFooterButton,/variant="outline"/u);
  assert.doesNotMatch(resourceFooterButton,/bg-primary|text-primary-foreground/u);
  assert.match(resourcePane,/className="shrink-0 border-t border-border bg-surface\/95 px-2 py-2"/u);
  assert.match(resourcePane,/data-testid=\{`environment-actions-/u);
  assert.match(resourcePane,/data-testid=\{`plugin-actions-/u);
  assert.match(resourcePane,/from "@\/components\/ui\/item"/u);
  assert.match(resourcePane,/from "@\/components\/ui\/skeleton"/u);
  assert.match(resourcePane,/<ItemGroup/u);
  assert.match(resourcePane,/<Item\b/u);
  assert.doesNotMatch(resourcePane,/<ButtonGroup|from "@\/components\/ui\/button-group"/u);
  assert.match(resourcePane,/group\/environment-card[\s\S]*?rounded-lg border border-border\/70/u);
  assert.match(resourcePane,/data-testid=\{`environment-row-/u);
  assert.match(resourcePane,/<Accordion[\s\S]*?className="gap-2 py-2"/u);
  assert.match(resourcePane,/\[&_\[data-slot=accordion-trigger-icon\]\]:hidden/u);
  assert.match(resourcePane,/<ItemGroup className="gap-0">/u);
  assert.match(resourcePane,/environmentSelected && "bg-primary\/\[0\.08\] before:bg-primary"/u);
  assert.match(resourcePane,/selected && "bg-primary\/\[0\.08\][^"]*before:bg-primary/u);
  assert.match(resourcePane,/className="my-1 mr-1 shrink-0 self-center gap-1"/u);
  assert.match(resourcePane,/className="mr-1 shrink-0 self-center gap-1"/u);
  assert.doesNotMatch(resourcePane,/MagnifyingGlass|onOpenCommand|打开命令面板|搜索 Ctrl K/u);
  assert.doesNotMatch(resourcePane,/0_8px_22px|0_12px_28px|0_16px_34px/u);
  assert.doesNotMatch(resourcePane,/environmentSelected && "[^"]*ring-/u);
  assert.doesNotMatch(`${projectRail}\n${resourcePane}`,/0_-12px_24px/u);
  assert.doesNotMatch(resourcePane,/hover:-translate|hover:shadow|ring-1 ring-primary|<(?:button|details|summary|select)\b/u);
  assert.ok(
    resourcePane.lastIndexOf('</ScrollArea>') < resourcePane.indexOf('data-testid="resource-actions-footer"'),
    'add-environment action stays outside the scroll area',
  );
  assert.doesNotMatch(resourcePane,/aria-selected=/u);
  assert.match(styles,/\[aria-current="page"\]/u);
});

test('navigation read failures take precedence over empty states and expose scoped retries', async () => {
  const [projectRail,resourcePane,appShell] = await Promise.all([
    read('renderer/v2/src/components/project-rail/ProjectRail.tsx'),
    read('renderer/v2/src/components/resource-pane/ResourcePane.tsx'),
    read('renderer/v2/src/components/app-shell/AppShell.tsx'),
  ]);

  assert.match(projectRail,/from "@\/components\/ui\/alert"/u);
  assert.match(projectRail,/data-testid="project-navigation-read-error"/u);
  assert.match(projectRail,/当前显示上次成功读取的项目摘要/u);
  assert.match(projectRail,/error && projects\.length === 0 \? null/u);
  assert.ok(
    projectRail.indexOf('data-testid="project-navigation-read-error"')
      < projectRail.indexOf('data-testid="project-empty-state"'),
    'project read error is rendered before the true empty state',
  );

  assert.match(resourcePane,/from "@\/components\/ui\/alert"/u);
  assert.match(resourcePane,/data-testid=\{testId\}/u);
  assert.match(resourcePane,/testId="resource-workspace-read-error"/u);
  assert.match(resourcePane,/workspaceError && !project \?/u);
  assert.match(resourcePane,/workspaceError \? null : \(/u);
  assert.match(resourcePane,/pluginError \|\| runtimeError \?/u);
  assert.match(resourcePane,/loadingPlugins && plugins\.length === 0 \?/u);
  assert.match(resourcePane,/显示上次成功读取的数据/u);
  assert.match(resourcePane,/显示工作区摘要数据/u);
  assert.match(resourcePane,/environment-navigation-read-error-/u);
  assert.ok(
    resourcePane.indexOf('workspaceError && !project ?')
      < resourcePane.indexOf('data-testid="no-project-resource-state"'),
    'workspace read error is rendered before the select-project empty state',
  );

  assert.match(appShell,/<ProjectRail[\s\S]*?error=\{workspace\.error\}[\s\S]*?onReload=\{workspace\.reload\}/u);
  assert.match(appShell,/<ResourcePane[\s\S]*?onReloadScope=\{reloadSelectedNavigationScope\}/u);
  assert.match(appShell,/pluginError=\{pluginList\.error\}/u);
  assert.match(appShell,/runtimeError=\{environmentStatus\.error\}/u);
  assert.match(appShell,/workspaceError=\{workspace\.error\}/u);
  const scopedReload = appShell.match(
    /const reloadSelectedNavigationScope[\s\S]*?\}, \[environmentStatus, pluginList\]\)/u,
  )?.[0] ?? '';
  assert.match(scopedReload,/pluginList\.reload\(\)/u);
  assert.match(scopedReload,/environmentStatus\.reload\(\)/u);
  assert.doesNotMatch(scopedReload,/workspace\.reload\(\)/u);
});

test('project rail shortcuts and responsive expansion target the desktop panel without stealing edit or modal focus', async () => {
  const [rail,sidebar,shell] = await Promise.all([
    read('renderer/v2/src/components/project-rail/ProjectRail.tsx'),
    read('renderer/v2/src/components/ui/sidebar.tsx'),
    read('renderer/v2/src/components/app-shell/AppShell.tsx'),
  ]);
  assert.match(rail,/keyboardShortcutEnabled=\{false\}/u);
  assert.match(sidebar,/if \(!keyboardShortcutEnabled\) return/u);
  assert.match(sidebar,/mx-2 w-auto bg-sidebar-border data-horizontal:w-auto/u,
    'sidebar separator width must include its horizontal margins rather than overflowing the rail');
  for (const field of ['defaultPrevented','repeat','isComposing','altKey','shiftKey']) {
    assert.ok(rail.includes(`event.${field}`));
  }
  assert.match(rail,/target\.isContentEditable/u);
  assert.match(rail,/input, textarea, select, \[role="textbox"\]/u);
  assert.match(rail,/\[role="dialog"\], \[role="alertdialog"\], \[role="menu"\]/u);
  assert.match(rail,/if \(modalOpen\) return/u);
  assert.match(rail,/if \(!toggleDisabled\) onToggleCollapsed\(\)/u);
  assert.doesNotMatch(rail,/data-project-rail-toggle|project-expand|project-collapse/u);
  assert.match(shell,/expandDisabled=\{viewportWidth < 720\}/u);
  assert.match(shell,/collapsed=\{compactProjectRail\}/u);
  assert.match(shell,/setProjectCollapsed\(!compactProjectRail\)/u);
  assert.match(shell,/projectPanelPixels <= PROJECT_RAIL_COLLAPSE_THRESHOLD/u);
  assert.match(shell,/if \(!collapsed && window.innerWidth < 720\) return/u);
  assert.match(shell,/if \(projectPanelRef.current\?\.isCollapsed\(\)\) projectPanelRef.current\?\.resize\("176px"\)/u);
  assert.match(shell,/maxSize=\{viewportWidth < 720 \? PROJECT_RAIL_COLLAPSED_SIZE : "300px"\}/u);
  assert.match(shell,/onDoubleClick=\{\(\) => setProjectCollapsed\(false, true\)\}/u);
});

test('command palette values remain unique across duplicate display names and isolate invalid projects', async () => {
  const command = await read('renderer/v2/src/components/app-shell/GlobalCommand.tsx');
  const commandItemCount = (command.match(/<CommandItem\b/gu) ?? []).length;
  const explicitValueCount = (command.match(/\bvalue=/gu) ?? []).length;

  assert.equal(explicitValueCount,commandItemCount);
  assert.match(command,/value="action:create-project 新增项目"/u);
  assert.match(command,/value="action:create-environment 在当前项目新增环境"/u);
  assert.match(command,/value=\{`project:\$\{project\.projectId\} \$\{project\.name\}`\}/u);
  assert.match(command,/value=\{`environment:\$\{project\.projectId\}:\$\{environment\.environmentId\} \$\{environment\.name\}`\}/u);
  assert.match(command,/value=\{`plugin:\$\{project\.projectId\}:\$\{environment\.environmentId\}:\$\{plugin\.pluginInstanceId\} \$\{plugin\.displayName\}`\}/u);
  assert.match(command,/disabled=\{project\.isolated\}/u);
  assert.match(command,/已隔离，无法选择/u);
  assert.equal((command.match(/min-w-0 flex-1 truncate/gu) ?? []).length,3);
  assert.match(command,/title=\{project\.name\}[\s\S]*?\{project\.name\}/u);
  assert.match(command,/title=\{environment\.name\}[\s\S]*?\{environment\.name\}/u);
  assert.match(command,/if \(!\(event\.metaKey \|\| event\.ctrlKey\) \|\| event\.altKey\) return/u);
  assert.match(command,/if \(key === "n"\) \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?onOpenChange\(false\)[\s\S]*?onCreateProject\(\)/u);
  assert.match(command,/aria-keyshortcuts="Control\+N Meta\+N"/u);
});
