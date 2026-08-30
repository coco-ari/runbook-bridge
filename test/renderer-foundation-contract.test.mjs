import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('production React Renderer is the unique packaged entry and preserves Electron security boundaries', async () => {
  const [manifest,main,html,viteConfig,components,styles,app,button,item,buttonGroup,kbd,gitignore] = await Promise.all([
    fs.readFile('package.json','utf8'),
    fs.readFile('src/main.mjs','utf8'),
    fs.readFile('renderer/v2/index.html','utf8'),
    fs.readFile('renderer/v2/vite.config.ts','utf8'),
    fs.readFile('renderer/v2/components.json','utf8'),
    fs.readFile('renderer/v2/src/styles/globals.css','utf8'),
    fs.readFile('renderer/v2/src/app/App.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/button.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/item.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/button-group.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/kbd.tsx','utf8'),
    fs.readFile('.gitignore','utf8'),
  ]);
  const packageJson = JSON.parse(manifest);
  const shadcn = JSON.parse(components);

  assert.match(packageJson.scripts.start,/build:renderer.*electron \./u);
  assert.match(packageJson.scripts['test:ui'],/build:renderer.*ui-react-foundation-smoke\.cjs/u);
  assert.match(packageJson.scripts.dist,/build:renderer.*electron-builder/u);
  assert.equal(packageJson.scripts['check:renderer'],'tsc --project renderer/v2/tsconfig.json --noEmit');
  assert.match(packageJson.scripts['check:renderer:next'],/check:renderer/u);
  assert.match(packageJson.scripts['build:renderer:next'],/build:renderer/u);
  assert.match(packageJson.scripts['test:ui:renderer-next'],/test:ui/u);
  assert.ok(packageJson.build.files.includes('renderer-build/v2/**/*'));
  assert.ok(packageJson.build.files.includes('!renderer/v2/**/*'));
  assert.ok(packageJson.build.files.includes('!src/mcp.mjs'));
  assert.ok(!packageJson.build.files.includes('renderer/v2/**/*'));

  assert.match(main,/minWidth: 960/u);
  assert.match(main,/minHeight: 640/u);
  assert.match(main,/contextIsolation: true/u);
  assert.match(main,/nodeIntegration: false/u);
  assert.match(main,/sandbox: true/u);
  assert.match(main,/'renderer-build', 'v2', 'index\.html'/u);
  assert.doesNotMatch(main,/'renderer', 'v2', 'index\.html'|react\.html/u);

  assert.match(html,/default-src 'self'/u);
  assert.match(html,/script-src 'self'/u);
  assert.match(html,/style-src 'self' 'unsafe-inline'/u);
  assert.match(html,/connect-src 'none'/u);
  assert.equal((html.match(/'unsafe-inline'/gu) ?? []).length,1);
  assert.doesNotMatch(html,/script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
  assert.doesNotMatch(html,/unsafe-eval|https?:\/\//u);
  assert.match(html,/src="\/src\/main\.tsx"/u);

  assert.match(viteConfig,/base: "\.\/"/u);
  assert.match(viteConfig,/renderer-build\/v2/u);
  assert.match(viteConfig,/input: path\.resolve\(rendererRoot, "index\.html"\)/u);
  assert.match(gitignore,/^renderer-build\/$/mu);
  await assert.rejects(fs.access('renderer/v2/react.html'),/ENOENT/u);

  assert.equal(shadcn.style,'radix-nova');
  assert.equal(shadcn.rsc,false);
  assert.equal(shadcn.tsx,true);
  assert.equal(shadcn.iconLibrary,'phosphor');
  assert.equal(shadcn.tailwind.css,'src/styles/globals.css');
  assert.ok(packageJson.dependencies['radix-ui']);
  assert.equal(packageJson.dependencies['@base-ui/react'],undefined);
  assert.match(button,/data-slot="button"/u);
  assert.match(button,/class-variance-authority/u);
  assert.match(item,/data-slot="item"/u);
  assert.match(item,/data-slot="item-group"/u);
  assert.match(item,/role="list"/u);
  assert.match(item,/const Comp = asChild \? Slot\.Root : "p"/u);
  assert.match(buttonGroup,/data-slot="button-group"/u);
  assert.match(buttonGroup,/role="group"/u);
  assert.match(kbd,/data-slot="kbd"/u);
  assert.match(kbd,/KbdGroup\(\{ className, \.\.\.props \}: React\.ComponentProps<"kbd">\)/u);

  for (const token of [
    'background','surface','surface-raised','surface-hover','surface-selected',
    'foreground','border','popover','muted','accent','input','ring','sidebar',
    'primary','success','warning','danger','info',
  ]) assert.match(styles,new RegExp(`--${token}:`,'u'));
  assert.match(styles,/:root\[data-theme="dark"\]/u);
  assert.match(styles,/:root\[data-theme="dark"\][\s\S]*--primary: #37d7a0/u);
  assert.match(styles,/:root\[data-theme="dark"\][\s\S]*--background: #0b0b0f/u);
  assert.match(styles,/\[data-shell-nav-item\]\[aria-selected="true"\][\s\S]*color: var\(--primary\)/u);
  assert.match(styles,/prefers-reduced-motion: reduce/u);
  assert.match(styles,/:focus-visible/u);

  assert.match(app,/AppShell/u);
  assert.doesNotMatch(app,/workspaceOverview\(\)|getAiOpsV2/u);
  assert.doesNotMatch(app,/createProject|updateProject|deleteProject|createEnvironment|createPlugin|requestConnectionIntent/u);
  assert.doesNotMatch(`${app}\n${html}`,/[—–]/u);
  assert.doesNotMatch(app,/console\./u);
});

test('shared shadcn controls expose consistent focus and localized accessibility semantics', async () => {
  const [alert,button,dialog,sheet,sidebar,tabs] = await Promise.all([
    fs.readFile('renderer/v2/src/components/ui/alert.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/button.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/dialog.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/sheet.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/sidebar.tsx','utf8'),
    fs.readFile('renderer/v2/src/components/ui/tabs.tsx','utf8'),
  ]);

  assert.match(button,/focus-visible:ring-2 focus-visible:ring-ring\/60/u);
  assert.doesNotMatch(button,/focus-visible:ring-offset|focus-visible:ring-focus-ring/u);
  assert.match(alert,/role=\{role \?\? \(variant === "destructive" \? "alert" : undefined\)\}/u);
  assert.doesNotMatch(alert,/role="alert"/u);
  assert.match(dialog,/<span className="sr-only">关闭<\/span>/u);
  assert.match(dialog,/<Button variant="outline">关闭<\/Button>/u);
  assert.match(sheet,/<span className="sr-only">关闭<\/span>/u);
  assert.match(sidebar,/<SheetTitle>侧边栏<\/SheetTitle>/u);
  assert.match(sidebar,/<SheetDescription>显示移动端侧边栏。<\/SheetDescription>/u);
  assert.match(sidebar,/aria-label="切换侧边栏"/u);
  assert.match(tabs,/data-active:bg-primary\/\[0\.14\]/u);
  assert.doesNotMatch(tabs,/variant=navigation[^\n]*data-active:after/u);
});

test('foundation screenshot geometry follows the actual resized viewport and a fresh rendered frame', async () => {
  const smoke = await fs.readFile('scripts/ui-react-foundation-smoke.cjs','utf8');
  const capture = smoke.slice(smoke.indexOf('async function captureVisualScenario'),smoke.indexOf('async function captureOverlayVisualEvidence'));
  assert.match(capture,/Math\.abs\(window\.innerWidth - \$\{width\}\) <= 2 && Math\.abs\(window\.innerHeight - \$\{height\}\) <= 2/u);
  const renderBarrier = capture.indexOf('await captureRenderedFrame(win)');
  assert.ok(renderBarrier > capture.indexOf('win.setContentSize(width,height)'));
  assert.ok(renderBarrier < capture.indexOf('const automaticTabScroll'));
  assert.ok(renderBarrier < capture.indexOf('const snapshot'));
  assert.match(capture,/snapshot\.projectRail\.width >= 175\.5/u);
  assert.doesNotMatch(capture,/\.resize\(|\.setLayout\(|\.style\s*=/u,'screenshot capture cannot repair production layout');
});

test('expanded Radix accordion content grows after asynchronous resource updates', async () => {
  const accordion = await fs.readFile('renderer/v2/src/components/ui/accordion.tsx','utf8');
  assert.match(accordion,/data-open:animate-accordion-down data-closed:animate-accordion-up/u);
  assert.doesNotMatch(accordion,/h-\(--radix-accordion-content-height\)|height:\s*["']?var\(--radix-accordion-content-height/u,
    'the measured animation height must not freeze the live content height');
});

test('foundation verifies each separator receives native keyboard input and persists its own ARIA value', async () => {
  const smoke = await fs.readFile('scripts/ui-react-foundation-smoke.cjs','utf8');
  const helper = smoke.slice(smoke.indexOf('async function assertKeyboardResizerPersistence'),smoke.indexOf('async function assertRendererKeyboardFocus'));
  assert.match(helper,/await captureRenderedFrame\(win\)/u);
  assert.match(helper,/document\.hasFocus\(\) && document\.activeElement === target/u);
  assert.match(helper,/value !== \$\{before\.value\}/u);
  assert.match(helper,/saved !== null && saved !== \$\{JSON\.stringify\(before\.savedLayout\)\}/u);
  assert.match(helper,/JSON\.parse\(saved\)\.layout\[\$\{JSON\.stringify\(panelId\)\}\] === value/u);
  assert.match(helper,/await pressKey\(win,keyCode\)/u);
  assert.doesNotMatch(helper,/\.resize\(|\.setLayout\(|\.setItem\(|dispatchEvent/u);
  assert.match(smoke,/await captureRenderedFrame\(win\);\s*await assertRendererKeyboardFocus\(win\);\s*const layoutBefore/u);
  assert.match(smoke,/testId:'project-resource-resizer',keyCode:'RIGHT',panelId:'project-panel'/u);
  assert.match(smoke,/testId:'resource-detail-resizer',keyCode:'LEFT',panelId:'resource-panel'/u);
  assert.match(smoke,/assert\.notEqual\(savedLayout,layoutBefore\)/u);
});
