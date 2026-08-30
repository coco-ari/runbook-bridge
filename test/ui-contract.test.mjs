import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const LEGACY_RENDERER_PATHS = [
  'renderer/v2/app.js',
  'renderer/v2/styles.css',
  'renderer/v2/connection-view-model.js',
  'renderer/v2/plugin-catalog.js',
  'renderer/v2/quick-questions.js',
  'renderer/v2/react.html',
  'scripts/ui-three-pane-smoke.cjs',
];

async function collectSourceFiles(root) {
  const entries = await fs.readdir(root,{withFileTypes:true});
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root,entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(entryPath));
    else if (/\.(?:ts|tsx|css)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test('production UI is the React shadcn/Radix renderer and preserves the V2 security boundary',async () => {
  const sourceFiles = await collectSourceFiles('renderer/v2/src');
  const sourceEntries = await Promise.all(
    sourceFiles.map(async (sourcePath) => [sourcePath,await fs.readFile(sourcePath,'utf8')]),
  );
  const rendererSource = sourceEntries.map(([,source]) => source).join('\n');
  const featureSource = sourceEntries
    .filter(([sourcePath]) => !sourcePath.endsWith(path.join('bridge','ai-ops-v2.ts')))
    .map(([,source]) => source)
    .join('\n');
  const [
    html,
    appShell,
    workspaceDetail,
    projectRail,
    resourcePane,
    preload,
    main,
    ipc,
    manifest,
    shadcnConfig,
  ] = await Promise.all([
    fs.readFile('renderer/v2/index.html','utf8'),
    fs.readFile('renderer/v2/src/components/app-shell/AppShell.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/detail-workspace/WorkspaceDetail.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/project-rail/ProjectRail.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/resource-pane/ResourcePane.tsx','utf8'),
    fs.readFile('src/preload.cjs','utf8'),
    fs.readFile('src/main.mjs','utf8'),
    fs.readFile('src/ipc-v2.mjs','utf8'),
    fs.readFile('package.json','utf8'),
    fs.readFile('renderer/v2/components.json','utf8'),
  ]);
  const packageJson = JSON.parse(manifest);
  const shadcn = JSON.parse(shadcnConfig);

  assert.match(html,/<div id="root"><\/div>/u);
  assert.equal((html.match(/<script\b/gu) ?? []).length,1);
  assert.match(html,/src="\/src\/main\.tsx"/u);
  assert.match(html,/default-src 'self'/u);
  assert.match(html,/script-src 'self'/u);
  assert.match(html,/style-src 'self' 'unsafe-inline'/u);
  assert.match(html,/connect-src 'none'/u);
  assert.doesNotMatch(html,/script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
  assert.doesNotMatch(html,/unsafe-eval|https?:\/\//u);

  assert.match(appShell,/ProjectRail/u);
  assert.match(appShell,/ResourcePane/u);
  assert.match(appShell,/WorkspaceDetail/u);
  assert.match(appShell,/GlobalCommand/u);
  assert.match(appShell,/ProjectMutationSurfaces/u);
  assert.match(appShell,/EnvironmentMutationSurfaces/u);
  assert.match(appShell,/PluginEditorWorkspace/u);
  assert.match(appShell,/PluginDeleteDialog/u);
  assert.match(appShell,/useWorkspaceRuntimeCache/u);
  assert.match(appShell,/data-shell-ready="true"/u);
  assert.match(appShell,/href="#detail-main"/u);
  assert.equal((appShell.match(/<ResizableHandle/gu) ?? []).length,2);
  assert.doesNotMatch(appShell,/APP_SHELL_FIXTURES|MockActionSurfaces/u);

  for (const feature of [
    'ProjectOverview',
    'EnvironmentOverview',
    'PluginOverview',
    'EnvironmentConnectionPanel',
    'PluginConnectionPanel',
    'PluginAgentAccess',
    'RunbookFeature',
    'QuickQuestionsFeature',
    'AuditFeature',
    'ConfirmationsFeature',
  ]) assert.match(workspaceDetail,new RegExp(feature,'u'));
  assert.match(workspaceDetail,/TabsList/u);
  assert.match(workspaceDetail,/variant="navigation"/u);
  assert.match(workspaceDetail,/activationMode="manual"/u);
  assert.match(projectRail,/SidebarProvider/u);
  assert.match(projectRail,/DropdownMenu/u);
  assert.match(projectRail,/ContextMenu/u);
  assert.match(resourcePane,/Accordion/u);
  assert.match(resourcePane,/ScrollArea/u);
  assert.match(resourcePane,/ContextMenu/u);

  assert.equal(shadcn.style,'radix-nova');
  assert.equal(shadcn.iconLibrary,'phosphor');
  assert.equal(shadcn.rsc,false);
  assert.ok(packageJson.dependencies['radix-ui']);
  assert.equal(packageJson.dependencies['@base-ui/react'],undefined);
  assert.doesNotMatch(featureSource,/ipcRenderer|contextBridge|node:[a-z]/u);
  assert.doesNotMatch(featureSource,/window\.aiOps/u);
  assert.doesNotMatch(featureSource,/dangerouslySetInnerHTML/u);
  assert.doesNotMatch(featureSource,/window\.(?:confirm|prompt|alert)/u);
  assert.doesNotMatch(featureSource,/https?:\/\//u);
  assert.doesNotMatch(rendererSource,/@base-ui|lucide-react|next-themes/u);

  assert.match(preload,/contextBridge\.exposeInMainWorld\('aiOps', \{\s*v2:/su);
  assert.match(preload,/requestConnectionIntent/u);
  assert.match(preload,/v2:plugin-connection-edit-save/u);
  assert.match(preload,/v2:plugin-delete/u);
  assert.match(preload,/v2:confirmation-list/u);
  assert.match(preload,/v2:audit-clear/u);
  assert.doesNotMatch(preload,/v2:plugin-test|v2:plugin-draft-(?:list|save|resume|edit-cancel|delete|promote)/u);
  assert.doesNotMatch(preload,/project:(?:delete|execute|upload|download)/u);
  assert.match(ipc,/handle\('connection-intent'/u);
  assert.match(ipc,/handleWithEvent\('plugin-connection-edit-save'/u);
  assert.doesNotMatch(ipc,/v2:plugin-test|plugin-test-progress/u);
  assert.doesNotMatch(ipc,/handle(?:WithEvent)?\('plugin-draft-(?:list|save|resume|edit-cancel|delete|promote)'/u);

  assert.match(main,/contextIsolation: true/u);
  assert.match(main,/nodeIntegration: false/u);
  assert.match(main,/sandbox: true/u);
  assert.match(main,/'renderer-build', 'v2', 'index\.html'/u);
  assert.doesNotMatch(main,/'renderer', 'v2', 'index\.html'|react\.html/u);
  assert.doesNotMatch(main,/PluginDraftService|registerIpc\(|new SshBroker/u);

  assert.match(packageJson.scripts.start,/build:renderer.*electron \./u);
  assert.match(packageJson.scripts['test:ui'],/build:renderer.*ui-react-foundation-smoke\.cjs/u);
  assert.match(packageJson.scripts.dist,/build:renderer.*electron-builder/u);
  assert.ok(packageJson.build.files.includes('renderer-build/v2/**/*'));
  assert.ok(packageJson.build.files.includes('!renderer/v2/**/*'));
  assert.ok(packageJson.build.files.includes('!src/mcp.mjs'));
  assert.ok(!packageJson.build.files.includes('renderer/v2/**/*'));

  for (const legacyPath of LEGACY_RENDERER_PATHS) {
    await assert.rejects(fs.access(legacyPath),/ENOENT/u,legacyPath + ' must stay deleted');
  }
});
