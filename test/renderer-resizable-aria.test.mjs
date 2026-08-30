import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {parse} from 'yaml';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('react-resizable-panels/package.json'));
const patchKey = 'react-resizable-panels@4.12.3';
const patchPath = 'patches/react-resizable-panels@4.12.3.patch';

// Execute the installed Separator's actual index expression. ARIA bounds, native
// arrow keys and persisted sizes remain strict Electron smoke assertions.
async function distributionHarness(format) {
  const filename = path.join(packageRoot,'dist',`react-resizable-panels.${format}`);
  const source = await fs.readFile(filename,'utf8');
  const indexExpressions = [...source.matchAll(/\bY\s*=\s*(([DT])\.findIndex\(\(?panel\)?\s*=>\s*panel\.panelId\s*===\s*_\.id\))/gu)];
  assert.equal(indexExpressions.length,1,`${format}: installed Separator uses the full group index`);
  assert.doesNotMatch(source,/Y\s*=\s*(?:oe|ne)\.indexOf\(_\)/u);
  const [,expression,groupName] = indexExpressions[0];
  return runInNewContext(`(${groupName},_) => (${expression})`);
}

test('the narrow separator index patch is registered and installed without changing the dependency version',async () => {
  const [manifest,workspace,lockfile,patch,attributes] = await Promise.all([
    fs.readFile(path.join(packageRoot,'package.json'),'utf8').then(JSON.parse),
    fs.readFile('pnpm-workspace.yaml','utf8').then(parse),
    fs.readFile('pnpm-lock.yaml','utf8').then(parse),
    fs.readFile(patchPath),
    fs.readFile('.gitattributes','utf8'),
  ]);
  assert.equal(manifest.version,'4.12.3');
  assert.match(attributes,/^\/patches\/\*\.patch text eol=lf$/mu,'keep the pnpm patch hash stable on Windows checkouts');
  assert.equal(workspace.patchedDependencies[patchKey],patchPath);
  const hash = createHash('sha256').update(patch).digest('hex');
  assert.equal(lockfile.patchedDependencies[patchKey],hash);
  assert.ok(lockfile.importers['.'].dependencies['react-resizable-panels'].version
    .startsWith(`4.12.3(patch_hash=${hash})`));
  const sections = patch.toString('utf8').split(/(?=^diff --git )/mu).filter(Boolean);
  assert.equal(sections.length,2,'only the shipped ESM and CJS separator index lines are patched');
  for (const section of sections) {
    const removed = section.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).map((line) => line.slice(1)).join('\n');
    const added = section.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
    const expected = section.startsWith('diff --git a/dist/react-resizable-panels.cjs ')
      ? removed.replace('Y=ne.indexOf(_)','Y=T.findIndex(panel=>panel.panelId===_.id)')
      : removed.replace('Y = oe.indexOf(_)','Y = D.findIndex((panel) => panel.panelId === _.id)');
    assert.notEqual(added,removed);
    assert.equal(added,expected,'no resize, keyboard or persistence algorithm is patched');
  }
});

for (const format of ['js','cjs']) {
  test(`${format}: first, middle and last primary separators use their three/four-panel group indices`,async () => {
    const primaryIndex = await distributionHarness(format);
    for (const count of [3,4]) {
      const panels = Array.from({length:count},(_unused,index) => ({id:`panel-${index}`}));
      const panelConstraints = panels.map(({id}) => ({panelId:id}));
      for (let index = 0; index < panels.length - 1; index += 1) {
        const primary = panels[index];
        assert.equal(primaryIndex(panelConstraints,primary),index);
        // A separator's neighboring pair always puts its primary first; the
        // old pair-local index was therefore zero for every separator.
        const pair = [primary,panels[index + 1]];
        assert.equal(pair.indexOf(primary),0);
        if (index > 0) assert.notEqual(primaryIndex(panelConstraints,primary),pair.indexOf(primary));
      }
    }
  });
}

test('App Shell keeps the real shadcn Resizable primitive and the tested production constraints',async () => {
  const [primitive,shell] = await Promise.all([
    fs.readFile('renderer/v2/src/components/ui/resizable.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/app-shell/AppShell.tsx','utf8'),
  ]);
  assert.match(primitive,/import \* as ResizablePrimitive from "react-resizable-panels"/u);
  for (const name of ['Group','Panel','Separator']) assert.match(primitive,new RegExp(`<ResizablePrimitive\\.${name}\\b`,'u'));
  assert.match(primitive,/w-px/u);
  assert.doesNotMatch(primitive,/aria-valuemin|aria-valuemax|aria-valuenow|onKeyDown/u,'do not fake ARIA or replace library keyboard handling');
  assert.match(shell,/collapsedSize=\{PROJECT_RAIL_COLLAPSED_SIZE\}[\s\S]*?maxSize=\{viewportWidth < 720 \? PROJECT_RAIL_COLLAPSED_SIZE : "300px"\}\s+minSize=\{viewportWidth < 720 \? PROJECT_RAIL_COLLAPSED_SIZE : "176px"\}/u);
  const layout = await import('../renderer/v2/src/state/layout-state.ts');
  assert.equal(layout.PROJECT_RAIL_COLLAPSED_WIDTH,128);
  assert.equal(layout.PROJECT_RAIL_COLLAPSED_SIZE,'128px');
  assert.equal(layout.PROJECT_RAIL_COLLAPSE_THRESHOLD,130);
  assert.match(shell,/projectPanelPixels <= PROJECT_RAIL_COLLAPSE_THRESHOLD/u);
  assert.match(shell,/collapsed=\{compactProjectRail\}/u);
  assert.doesNotMatch(shell,/collapsed=\{layoutState\.projectCollapsed \|\| compactProjectRail\}/u);
  assert.match(shell,/onDoubleClick=\{\(\) => setProjectCollapsed\(false, true\)\}/u);
  assert.match(shell,/id="project-rail-resize-help">\{projectResizeDescription\}/u);
  const projectSeparator = shell.match(/<ResizableHandle\b[^>]*data-testid="project-resource-resizer"[^]*?withHandle \/>/u)?.[0];
  assert.ok(projectSeparator,'project resize handle remains discoverable without a header toggle');
  assert.match(projectSeparator,/aria-describedby="project-rail-resize-help"/u);
  assert.match(projectSeparator,/aria-keyshortcuts=\{viewportWidth < 720 \? undefined : "Enter ArrowLeft ArrowRight Control\+B Meta\+B"\}/u);
  assert.match(projectSeparator,/title=\{projectResizeDescription\}/u);
  assert.doesNotMatch(projectSeparator,/onKeyDown|aria-valuemin|aria-valuemax|aria-valuenow/u,
    'instructions describe the library keyboard controls without replacing them');
  assert.match(shell,/放大窗口后可调整项目栏宽度/u);
  assert.match(shell,/双击恢复默认宽度（224 像素，受窗口空间限制）/u);
  assert.match(shell,/id=\{APP_SHELL_PANEL_IDS\.resource\} maxSize="80%" minSize=\{constraintLimited \? \(viewportWidth < 720 \? "184px" : "200px"\) : "240px"\}/u);
  assert.match(shell,/collapsedSize="48px"[\s\S]*?id=\{APP_SHELL_PANEL_IDS\.detail\} minSize=\{constraintLimited \? "320px" : "360px"\}/u);
  assert.ok(layout.PROJECT_RAIL_COLLAPSED_WIDTH + 184 + 320 + 2 <= 640,
    'the compact rail and both other panel minima fit the supported 640px smoke viewport');
});

test('project collapse intent follows deliberate resizing without persisting responsive compression',async () => {
  const {projectCollapseIntentAfterResize} = await import('../renderer/v2/src/state/layout-state.ts');
  const resize = (current,values) => projectCollapseIntentAfterResize(current,{
    inPixels:128,previousPixels:224,viewportWidth:1280,isUserInteraction:true,...values,
  });

  assert.equal(resize(false,{}),true,'dragging an expanded rail closed saves the collapsed preference');
  assert.equal(resize(true,{inPixels:224,previousPixels:128,viewportWidth:800}),false,
    'dragging a saved collapsed rail wider below 960px clears that preference');
  assert.equal(resize(false,{viewportWidth:640,isUserInteraction:false}),false,
    'a constrained viewport may compact the rail without replacing expanded intent');
  assert.equal(resize(false,{viewportWidth:640}),false,
    'resizing another panel while expansion is unavailable cannot save collapsed intent');
  assert.equal(resize(false,{previousPixels:128,viewportWidth:800}),false,
    'an unchanged automatically compact rail is not a project collapse gesture');
  assert.equal(resize(true,{inPixels:224,isUserInteraction:false}),true,
    'restoring layout or editor geometry does not overwrite the saved preference');
  assert.equal(resize(false,{inPixels:128.5,previousPixels:128,viewportWidth:800}),false,
    'rounding during unrelated panel updates does not change intent');
});
