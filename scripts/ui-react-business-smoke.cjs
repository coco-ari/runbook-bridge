const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, session } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',() => {
  // This smoke owns the temporary window and exits explicitly.
});

const root = path.resolve(__dirname,'..');
const pagePath = path.join(root,'renderer-build','v2','index.html');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(),'runbook-bridge-business-smoke-'));
const quickQuestionsOnly = process.argv.includes('--quick-questions-only')
  || app.commandLine.hasSwitch('quick-questions-only');
const recoveryOnly = process.argv.includes('--recovery-only')
  || app.commandLine.hasSwitch('recovery-only');
const screenshotDirectoryArgument = process.argv.find((value) => value.startsWith('--screenshot-dir='))
  ?.slice('--screenshot-dir='.length);
const commandLineScreenshotDirectory = app.commandLine.getSwitchValue('screenshot-dir') || null;
const screenshotRoot = process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR || screenshotDirectoryArgument || commandLineScreenshotDirectory
  ? path.resolve(
      process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR
      ?? screenshotDirectoryArgument
      ?? commandLineScreenshotDirectory,
    )
  : null;
if (screenshotRoot) {
  const relativeScreenshotPath = path.relative(root,screenshotRoot);
  const screenshotInsideRepository = relativeScreenshotPath === ''
    || (!relativeScreenshotPath.startsWith(`..${path.sep}`)
      && relativeScreenshotPath !== '..'
      && !path.isAbsolute(relativeScreenshotPath));
  if (screenshotInsideRepository) {
    throw new Error('Screenshot evidence must be written outside the repository.');
  }
}
const requestedScreenshotTheme = ['light','dark'].includes(process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME)
  ? process.env.RUNBOOK_BRIDGE_SCREENSHOT_THEME
  : null;
const registeredChannels = [];
const readCalls = [];
const mutationCalls = [];
const mutationHandlers = new Map();
const forbiddenCalls = [];
const externalRequests = [];
const rendererErrors = [];

app.setPath('userData',dataRoot);
app.setPath('sessionData',path.join(dataRoot,'session'));
if (requestedScreenshotTheme) nativeTheme.themeSource = requestedScreenshotTheme;

const ok = (data) => ({ok:true,data});
const conflict = (message) => ({
  ok:false,
  error:{code:'CONFIG_REVISION_CONFLICT',message},
});
const clone = (value) => structuredClone(value);
const scopeKey = (projectId,environmentId) => `${projectId}\u0000${environmentId}`;

const state = {
  projects:[{
    projectId:'project-alpha',
    name:'核心运维项目',
    revision:5,
    environments:[{
      projectId:'project-alpha',
      environmentId:'env-production',
      name:'生产环境',
      revision:7,
    }],
  }],
  runbooks:new Map([[scopeKey('project-alpha','env-production'),'# 生产环境运维说明']]),
  opening:{
    schemaVersion:1,
    text:'请使用 AI Ops MCP 在当前模拟范围进行只读排查。',
    defaultText:'请使用 AI Ops MCP 在当前模拟范围进行只读排查。',
    revision:3,
  },
  questions:new Map(),
  nextQuestionId:1,
  nextProjectId:1,
  nextEnvironmentId:1,
  nextQuestionTimestamp:Date.parse('2026-08-30T00:00:00.000Z'),
};
let questionSaveHold = null;
let releaseQuestionSave = null;

function runtime(projectId,environmentId,sequence = 1) {
  return {
    projectId,
    environmentId,
    phase:'disconnected',
    sequence,
    desiredConnected:false,
    eligibleCount:0,
    connectedCount:0,
    errorCount:0,
    blockedCount:0,
    draftCount:0,
    plugins:{},
    pluginsPartial:false,
  };
}

function environmentOverview(environment) {
  return {
    ...environment,
    pluginCount:0,
    readyPluginCount:0,
    draftCount:0,
    resourcePreview:[],
    resourcePreviewTruncated:false,
    runtime:runtime(environment.projectId,environment.environmentId,environment.revision),
  };
}

function workspaceOverview() {
  return state.projects.map((project) => ({
    schemaVersion:2,
    projectId:project.projectId,
    name:project.name,
    revision:project.revision,
    environmentCount:project.environments.length,
    pluginCount:0,
    environments:project.environments.map(environmentOverview),
  }));
}

function projectRecord(project) {
  return {
    projectId:project.projectId,
    name:project.name,
    revision:project.revision,
  };
}

function findProject(projectId) {
  return state.projects.find((project) => project.projectId === projectId) ?? null;
}

function findEnvironment(projectId,environmentId) {
  return findProject(projectId)?.environments
    .find((environment) => environment.environmentId === environmentId) ?? null;
}

function runbookRecord(projectId,environmentId) {
  const content = state.runbooks.get(scopeKey(projectId,environmentId)) ?? '';
  return {
    content,
    bytes:Buffer.byteLength(content,'utf8'),
    hash:crypto.createHash('sha256').update(content).digest('hex'),
    empty:!content.trim(),
  };
}

function nextQuestionTimestamp() {
  const timestamp = new Date(state.nextQuestionTimestamp).toISOString();
  state.nextQuestionTimestamp += 1000;
  return timestamp;
}

function questionCollection(projectId,environmentId) {
  const key = scopeKey(projectId,environmentId);
  if (!state.questions.has(key)) {
    state.questions.set(key,{
      schemaVersion:1,
      projectId,
      environmentId,
      revision:0,
      items:[],
    });
  }
  return state.questions.get(key);
}

function register(channel,handler) {
  registeredChannels.push(channel);
  ipcMain.handle(channel,handler);
}

function registerRead(channel,handler) {
  register(channel,async (_event,...args) => {
    readCalls.push({channel,args:clone(args)});
    return ok(clone(await handler(...args)));
  });
}

function registerMutation(channel,handler) {
  mutationHandlers.set(channel,handler);
  register(channel,async (_event,payload) => {
    const entry = {channel,payload:clone(payload),result:null};
    mutationCalls.push(entry);
    entry.result = clone(await handler(payload));
    return clone(entry.result);
  });
}

function registerForbidden(channel) {
  register(channel,async (_event,payload) => {
    forbiddenCalls.push({channel,payload:clone(payload)});
    return {
      ok:false,
      error:{code:'BUSINESS_SMOKE_FORBIDDEN',message:'该操作不属于业务 smoke。'},
    };
  });
}

function registerMockApi() {
  registerRead('v2:project-list',() => state.projects.map(projectRecord));
  registerRead('v2:workspace-overview',workspaceOverview);
  registerRead('v2:environment-list',(projectId) => (
    findProject(projectId)?.environments ?? []
  ));
  registerRead('v2:environment-status',({projectId,environmentId}) => (
    runtime(projectId,environmentId,findEnvironment(projectId,environmentId)?.revision ?? 0)
  ));
  registerRead('v2:plugin-list',() => []);
  registerRead('v2:plugin-assess',() => ({
    phase:'disconnected',
    primaryStatus:{kind:'disconnected',label:'未连接',action:'connect'},
  }));
  registerRead('v2:plugin-credential-status',() => ({
    fields:{primary:false,proxy:false},
    legacyAvailable:false,
  }));
  registerRead('v2:plugin-databases',() => []);
  registerRead('v2:audit-list',() => []);
  registerRead('v2:confirmation-list',() => []);
  registerRead('v2:runbook-read',({projectId,environmentId}) => (
    runbookRecord(projectId,environmentId)
  ));
  registerRead('v2:quick-question-opening-get',() => state.opening);
  registerRead('v2:quick-question-list',({projectId,environmentId}) => (
    questionCollection(projectId,environmentId)
  ));

  registerMutation('v2:project-create',(input) => {
    const number = state.nextProjectId++;
    const projectId = number === 1 ? 'project-created' : `project-created-${number}`;
    const project = {
      projectId,
      name:String(input?.name ?? ''),
      revision:1,
      environments:[{
        projectId,
        environmentId:'env-created',
        name:String(input?.environmentName ?? ''),
        revision:1,
      }],
    };
    state.projects.push(project);
    return ok(projectRecord(project));
  });
  registerMutation('v2:project-update',(payload) => {
    const project = findProject(payload?.projectId);
    if (!project || payload?.expectedRevision !== project.revision) {
      return conflict('项目配置已经变化，请刷新后重试。');
    }
    if (payload?.patch?.name === '冲突名称') {
      return conflict('项目配置已经变化，请刷新后重试。');
    }
    project.name = String(payload?.patch?.name ?? project.name);
    project.revision += 1;
    return ok(projectRecord(project));
  });
  registerMutation('v2:environment-create',(payload) => {
    const project = findProject(payload?.projectId);
    if (!project) return conflict('项目配置已经变化，请刷新后重试。');
    const number = state.nextEnvironmentId++;
    const environment = {
      projectId:project.projectId,
      environmentId:number === 1 ? 'env-preview' : `env-preview-${number}`,
      name:String(payload?.input?.name ?? ''),
      revision:1,
    };
    project.environments.push(environment);
    project.revision += 1;
    return ok(environment);
  });
  registerMutation('v2:environment-update',(payload) => {
    const environment = findEnvironment(payload?.projectId,payload?.environmentId);
    if (!environment || payload?.expectedRevision !== environment.revision) {
      return conflict('环境配置已经变化，请刷新后重试。');
    }
    environment.name = String(payload?.patch?.name ?? environment.name);
    environment.revision += 1;
    return ok(environment);
  });
  registerMutation('v2:runbook-save',(payload) => {
    const environment = findEnvironment(payload?.projectId,payload?.environmentId);
    if (!environment || payload?.expectedRevision !== environment.revision) {
      return conflict('环境配置已经变化，请刷新后重试。');
    }
    state.runbooks.set(
      scopeKey(payload.projectId,payload.environmentId),
      String(payload.content ?? ''),
    );
    environment.revision += 1;
    return ok({
      environment:clone(environment),
      ...runbookRecord(payload.projectId,payload.environmentId),
    });
  });
  registerMutation('v2:quick-question-save',async (payload) => {
    if (questionSaveHold) await questionSaveHold;
    const collection = questionCollection(payload?.projectId,payload?.environmentId);
    if (payload?.expectedRevision !== collection.revision) {
      return conflict('快捷提问已经变化，请刷新后重试。');
    }
    if (payload.questionId) {
      const item = collection.items.find((candidate) => candidate.questionId === payload.questionId);
      if (!item) return conflict('快捷提问已经变化，请刷新后重试。');
      item.text = String(payload.text ?? '');
      item.updatedAt = nextQuestionTimestamp();
    } else {
      const timestamp = nextQuestionTimestamp();
      collection.items.push({
        questionId:`question-${state.nextQuestionId++}`,
        text:String(payload.text ?? ''),
        createdAt:timestamp,
        updatedAt:timestamp,
      });
    }
    collection.revision += 1;
    return ok(collection);
  });
  registerMutation('v2:quick-question-delete',(payload) => {
    const collection = questionCollection(payload?.projectId,payload?.environmentId);
    if (payload?.expectedRevision !== collection.revision) {
      return conflict('快捷提问已经变化，请刷新后重试。');
    }
    collection.items = collection.items.filter(
      (item) => item.questionId !== payload.questionId,
    );
    collection.revision += 1;
    return ok(collection);
  });

  [
    'v2:project-delete',
    'v2:quick-question-opening-save','v2:quick-question-copy',
    'v2:environment-delete','v2:environment-reorder',
    'v2:connection-intent','v2:connection-challenge-confirm',
    'v2:plugin-create','v2:plugin-update','v2:plugin-metadata-update',
    'v2:plugin-agent-configuration-update','v2:plugin-connection-update',
    'v2:plugin-connection-edit-prepare','v2:plugin-connection-edit-begin',
    'v2:plugin-draft-validate','v2:plugin-validation-cancel',
    'v2:plugin-probe','v2:plugin-probe-cancel',
    'v2:plugin-connection-edit-save','v2:plugin-connection-edit-cancel',
    'v2:plugin-delete','v2:plugin-credential-migration-confirm',
    'v2:plugin-credential-reveal','v2:audit-clear',
    'v2:confirmation-approve','v2:confirmation-reject',
  ].forEach(registerForbidden);
}

function unregisterMockApi() {
  for (const channel of registeredChannels) ipcMain.removeHandler(channel);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve,ms));
}

async function waitUntil(predicate,label,timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitFor(win,evaluate,label,timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(evaluate,true)) return;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function focusRenderer(win) {
  win.webContents.focus();
  await waitFor(win,'document.hasFocus() === true','real business renderer keyboard focus');
}

async function assertRendererKeyboardFocus(win) {
  await focusRenderer(win);
  const focus = await win.webContents.executeJavaScript(`(() => {
    const previous = document.activeElement;
    const target = [
      document.querySelector('[data-testid="add-project-footer"]'),
      document.querySelector('[data-project-id="project-alpha"]'),
    ].find((element) => element instanceof HTMLElement && element !== previous);
    if (!(target instanceof HTMLElement)) throw new Error('business keyboard focus probe target missing');
    let focusInCount = 0;
    let trustedFocusInCount = 0;
    const listener = (event) => {
      if (event.target !== target) return;
      focusInCount += 1;
      if (event.isTrusted) trustedFocusInCount += 1;
    };
    document.addEventListener('focusin',listener,true);
    target.focus({preventScroll:true});
    const snapshot = {
      documentHasFocus:document.hasFocus(),
      targetActive:document.activeElement === target,
      focusInCount,
      trustedFocusInCount,
    };
    document.removeEventListener('focusin',listener,true);
    if (previous instanceof HTMLElement && previous !== document.body) previous.focus({preventScroll:true});
    return snapshot;
  })()`,true);
  process.stdout.write(`Business renderer keyboard focus evidence: ${JSON.stringify(focus)}\n`);
  assert.equal(focus.documentHasFocus,true,'the hidden business window must own real document focus');
  assert.equal(focus.targetActive,true,'the business focus probe must reach its actual control');
  assert.equal(focus.focusInCount,1,'native focus must produce exactly one focusin event');
  assert.equal(focus.trustedFocusInCount,1,'the business focusin event must be browser-generated');
}

async function pressRendererKey(win,keyCode,modifiers = []) {
  await focusRenderer(win);
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  await wait(100);
}

async function setExactViewport(win,width,height) {
  const initial = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  if (initial[0] === width && initial[1] === height) return;
  if (win.isMaximized()) {
    win.unmaximize();
    await wait(120);
  }
  win.setContentSize(width,height);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await wait(120);
    const current = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
    if (current[0] === width && current[1] === height) {
      // The hidden Electron surface acknowledges viewport dimensions before
      // paint/ResizeObserver restores the pixel-sized project rail.
      await captureRenderedFrame(win);
      return;
    }
    const [contentWidth,contentHeight] = win.getContentSize();
    // Native bounds may update before Chromium acknowledges a Windows resize.
    if (contentWidth === width && contentHeight === height) continue;
    win.setContentSize(
      Math.max(1,contentWidth+width-current[0]),
      Math.max(1,contentHeight+height-current[1]),
    );
  }
  const actual = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  assert.deepEqual(actual,[width,height],'unable to calibrate the Electron content viewport');
  await captureRenderedFrame(win);
}

async function click(win,selector,label = selector) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return false;
    target.click();
    return true;
  })()`,true);
  assert.equal(clicked,true,`${label} is not visible`);
  await wait(70);
}

async function openMenu(win,selector,label) {
  await focusRenderer(win);
  await waitFor(win,`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`,`${label} trigger after layout settles`);
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return null;
    target.focus();
    const rect = target.getBoundingClientRect();
    return {x:Math.round(rect.left + rect.width / 2),y:Math.round(rect.top + rect.height / 2)};
  })()`,true);
  assert.ok(point,`${label} is not visible`);
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
  win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
  await wait(70);
}

async function activateTab(win,tab) {
  await focusRenderer(win);
  const selector = `[data-detail-tab="${tab}"]`;
  const activated = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return false;
    target.focus();
    return document.activeElement === target;
  })()`,true);
  assert.equal(activated,true,`${tab} detail tab is not visible`);
  await pressRendererKey(win,'Enter');
  await waitFor(
    win,
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'`,
    `${tab} detail tab activation`,
  );
}

async function clickText(win,text,rootSelector = 'body') {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(rootSelector)})].filter((root) => (
      root instanceof HTMLElement && root.getClientRects().length > 0
    ));
    if (roots.length === 0) return false;
    const normalize = (value) => String(value ?? '').replace(/\\s+/gu,' ').trim();
    const target = roots.flatMap((root) => [...root.querySelectorAll('button,[role="menuitem"],[role="option"]')])
      .find((candidate) => (
      candidate instanceof HTMLElement
      && candidate.getClientRects().length > 0
      && normalize(candidate.textContent) === ${JSON.stringify(text)}
      ));
    if (!target) return false;
    target.click();
    return true;
  })()`,true);
  assert.equal(clicked,true,`visible action ${text} was not found in ${rootSelector}`);
  await wait(70);
}

async function fill(win,selector,value) {
  await focusRenderer(win);
  const actual = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return null;
    target.focus();
    const prototype = target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype,'value')?.set;
    setter?.call(target,${JSON.stringify(value)});
    target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
    target.dispatchEvent(new Event('change',{bubbles:true}));
    return target.value;
  })()`,true);
  assert.equal(actual,value,`unable to fill ${selector}`);
  await wait(70);
}

async function settleAnimations(win) {
  await win.webContents.executeJavaScript(`(() => {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
  })()`,true);
  await wait(40);
}

async function captureSurfaceEvidence(win,{name,selector,restoreFocusSelector = null}) {
  if (!screenshotRoot) return;
  fs.mkdirSync(screenshotRoot,{recursive:true});
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  await setExactViewport(win,1280,820);
  await waitFor(
    win,
    `[...document.querySelectorAll(${JSON.stringify(selector)})].some((candidate) => candidate instanceof HTMLElement && candidate.getClientRects().length > 0)`,
    `${name} screenshot surface`,
  );
  await settleAnimations(win);
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const surface = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
    if (!(surface instanceof HTMLElement)) return null;
    const rect = surface.getBoundingClientRect();
    const controls = [...surface.querySelectorAll('button,input,textarea,[role="option"],[role="menuitem"]')]
      .filter(visible);
    const buttons = controls.filter((control) => control instanceof HTMLButtonElement);
    const toastRects = [...document.querySelectorAll('[data-sonner-toast]')]
      .filter(visible)
      .map((toast) => toast.getBoundingClientRect());
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < buttons.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < buttons.length; rightIndex += 1) {
        const left = buttons[leftIndex].getBoundingClientRect();
        const right = buttons[rightIndex].getBoundingClientRect();
        const overlapX = Math.min(left.right,right.right)-Math.max(left.left,right.left);
        const overlapY = Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top);
        if (overlapX > 1 && overlapY > 1) overlaps.push([leftIndex,rightIndex]);
      }
    }
    const insideViewport = (candidate) => candidate.left >= -1 && candidate.top >= -1
      && candidate.right <= window.innerWidth+1 && candidate.bottom <= window.innerHeight+1;
    return {
      viewport:[window.innerWidth,window.innerHeight],
      surfaceInside:insideViewport(rect),
      controlsInside:controls.every((control) => insideViewport(control.getBoundingClientRect())),
      buttonsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth+1),
      toastButtonOverlaps:buttons.flatMap((button,buttonIndex) => {
        const buttonRect = button.getBoundingClientRect();
        return toastRects.flatMap((toastRect,toastIndex) => (
          Math.min(buttonRect.right,toastRect.right)-Math.max(buttonRect.left,toastRect.left) > 1
          && Math.min(buttonRect.bottom,toastRect.bottom)-Math.max(buttonRect.top,toastRect.top) > 1
            ? [[buttonIndex,toastIndex]]
            : []
        ));
      }),
      overlaps,
      bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
      rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      surfaceOverflow:surface.scrollWidth-surface.clientWidth,
    };
  })()`,true);
  assert.ok(geometry,`${name} screenshot surface is not visible`);
  assert.deepEqual(geometry.viewport,[1280,820],`${name} screenshot viewport`);
  assert.equal(geometry.surfaceInside,true,`${name} surface exceeds the 1280x820 viewport`);
  assert.equal(geometry.controlsInside,true,`${name} control exceeds the 1280x820 viewport`);
  assert.equal(geometry.buttonsFit,true,`${name} has a clipped button label`);
  assert.deepEqual(geometry.overlaps,[],`${name} has overlapping buttons`);
  assert.deepEqual(geometry.toastButtonOverlaps,[],`${name} toast obscures a surface button`);
  assert.ok(geometry.bodyOverflow <= 1,`${name} causes body horizontal overflow`);
  assert.ok(geometry.rootOverflow <= 1,`${name} causes document horizontal overflow`);
  assert.ok(geometry.surfaceOverflow <= 1,`${name} surface has horizontal overflow`);
  const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(
    path.join(screenshotRoot,`business-${name}-${theme}-1280x820.png`),
    image.toPNG(),
  );
  await setExactViewport(win,previousViewport[0],previousViewport[1]);
  if (restoreFocusSelector) {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(restoreFocusSelector)})?.focus()`,
      true,
    );
  }
}

async function captureRenderedFrame(win) {
  await win.webContents.capturePage();
  win.webContents.invalidate();
  await win.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true,
  );
  await wait(120);
  return win.webContents.capturePage();
}

async function assertQuickQuestionComposer(win,{projectId,environmentId}) {
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  const previousZoomFactor = win.webContents.getZoomFactor();
  const originalCollection = clone(questionCollection(projectId,environmentId));
  const mutationCount = mutationCalls.length;
  const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  const previewSelector = '[data-testid="quick-question-preview"]';
  const toggleSelector = '[data-testid="quick-preview-toggle"]';
  const sampleQuestion = '排查测试服务的健康检查为什么失败';
  const refreshCollection = () => win.webContents.send('v2:workspace-changed',{
    type:'quick-questions-updated',projectId,environmentId,
  });
  const assertFocusedInput = async (width,height) => {
    const startingZoomFactor = win.webContents.getZoomFactor();
    try {
      for (const zoomFactor of [1,1.25,1.5]) {
        win.webContents.setZoomFactor(zoomFactor);
        await captureRenderedFrame(win);
        await focusRenderer(win);
        await win.webContents.executeJavaScript(`(() => {
          const input = document.querySelector('#quick-question-input');
          input?.focus({preventScroll:true});
          input?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
        })()`,true);
        const frame = await captureRenderedFrame(win);
        const geometry = await win.webContents.executeJavaScript(`(() => {
          const input = document.querySelector('#quick-question-input');
          const label = document.querySelector('label[for="quick-question-input"]');
          const description = document.querySelector('#quick-question-input-description');
          if (![input,label,description].every((element) => element instanceof HTMLElement)) return null;
          const inputRect = input.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          const descriptionRect = description.getBoundingClientRect();
          const inputStyle = getComputedStyle(input);
          const clearance = {
            left:inputRect.left,right:innerWidth-inputRect.right,
            top:inputRect.top,bottom:innerHeight-inputRect.bottom,
          };
          const clippingAncestors = [];
          for (let ancestor = input.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const clipsX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
            const clipsY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
            if (!clipsX && !clipsY) continue;
            const rect = ancestor.getBoundingClientRect();
            const left = rect.left+ancestor.clientLeft;
            const top = rect.top+ancestor.clientTop;
            const edgeClearance = {
              left:inputRect.left-left,right:left+ancestor.clientWidth-inputRect.right,
              top:inputRect.top-top,bottom:top+ancestor.clientHeight-inputRect.bottom,
            };
            if (clipsX) {
              clearance.left = Math.min(clearance.left,edgeClearance.left);
              clearance.right = Math.min(clearance.right,edgeClearance.right);
            }
            if (clipsY) {
              clearance.top = Math.min(clearance.top,edgeClearance.top);
              clearance.bottom = Math.min(clearance.bottom,edgeClearance.bottom);
            }
            clippingAncestors.push({
              slot:ancestor.dataset.slot ?? ancestor.id ?? ancestor.tagName,
              clipsX,clipsY,clearance:edgeClearance,
            });
          }
          return {
            viewport:[innerWidth,innerHeight],
            focused:document.hasFocus() && document.activeElement === input && input.matches(':focus-visible'),
            focusShadow:inputStyle.boxShadow,
            clearance,clippingAncestors,
            labelGap:inputRect.top-labelRect.bottom,
            descriptionGap:descriptionRect.top-inputRect.bottom,
          };
        })()`,true);
        const zoomPercent = Math.round(zoomFactor*100);
        const label = `quick-question focused input ${width}x${height} at ${zoomPercent}%`;
        if (screenshotRoot) {
          const basename = `business-quick-question-focused-${theme}-${width}x${height}-${zoomPercent}pct`;
          fs.writeFileSync(path.join(screenshotRoot,`${basename}.png`),frame.toPNG());
          fs.writeFileSync(path.join(screenshotRoot,`${basename}.json`),JSON.stringify({zoomFactor,...geometry},null,2));
        }
        assert.ok(geometry,`${label} must render its label and description`);
        assert.equal(geometry.focused,true,`${label} must own visible keyboard focus`);
        assert.notEqual(geometry.focusShadow,'none',`${label} must preserve its visible focus ring`);
        // Reserve the normal 2px ring and the forced-colors 2px outline plus
        // its 2px offset, allowing only fractional client-size rounding.
        for (const edge of ['left','right','top','bottom']) {
          assert.ok(geometry.clearance[edge] >= 3.5,
            `${label} ${edge} focus outline is clipped: ${JSON.stringify(geometry.clearance)}`);
        }
        assert.ok(geometry.labelGap >= 3.5,`${label} focus outline must not overlap its label`);
        assert.ok(geometry.descriptionGap >= 3.5,`${label} focus outline must not overlap its description`);
      }
    } finally {
      win.webContents.setZoomFactor(startingZoomFactor);
      await captureRenderedFrame(win);
    }
  };
  if (screenshotRoot) fs.mkdirSync(screenshotRoot,{recursive:true});
  try {
    win.webContents.setZoomFactor(1);
    await waitFor(win,`(() => {
      const add = document.querySelector('[data-testid="common-question-add"]');
      const opening = document.querySelector('[data-testid="quick-opening-edit"]');
      return add instanceof HTMLButtonElement && !add.disabled
        && opening instanceof HTMLButtonElement && !opening.disabled;
    })()`,'quick-question composer data ready');
    await waitFor(win,`document.querySelector('[data-sonner-toast][data-visible="true"]') === null`,
      'previous notification settles before quick-question layout evidence');
    for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
      await setExactViewport(win,width,height);
      await win.webContents.executeJavaScript(`(() => {
        const feature = document.querySelector('[data-feature="quick-questions"]');
        feature?.querySelectorAll('[data-slot="scroll-area-viewport"]').forEach((viewport) => {
          viewport.scrollTop = 0;
          viewport.scrollLeft = 0;
        });
        const workspace = document.querySelector('#detail-main');
        if (workspace) workspace.scrollTop = 0;
      })()`,true);
      await captureRenderedFrame(win);
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const feature = document.querySelector('[data-feature="quick-questions"]');
        const composer = document.querySelector('[data-testid="quick-question-composer"]');
        const library = document.querySelector('[data-testid="common-question-library"]');
        const input = document.querySelector('#quick-question-input');
        const copy = document.querySelector('[data-testid="quick-question-copy"]');
        const date = document.querySelector('#quick-question-date');
        const opening = document.querySelector('[data-testid="quick-opening-edit"]');
        const toggle = document.querySelector(${JSON.stringify(toggleSelector)});
        const workspace = document.querySelector('#detail-main');
        if (![feature,composer,library,input,copy,date,opening,toggle,workspace]
          .every((element) => element instanceof HTMLElement)) return null;
        const composerRect = composer.getBoundingClientRect();
        const libraryRect = library.getBoundingClientRect();
        const workspaceRect = workspace.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const dateRect = date.getBoundingClientRect();
        const openingRect = opening.getBoundingClientRect();
        const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
        const fitsFirstView = (element) => {
          const rect = element.getBoundingClientRect();
          const scrollViewport = element.closest('[data-slot="scroll-area-viewport"]');
          const scrollRect = scrollViewport?.getBoundingClientRect() ?? workspaceRect;
          return rect.top >= Math.max(0,workspaceRect.top,scrollRect.top)-1
            && rect.bottom <= Math.min(innerHeight,workspaceRect.bottom,scrollRect.bottom)+1
            && rect.left >= Math.max(0,workspaceRect.left,scrollRect.left)-1
            && rect.right <= Math.min(innerWidth,workspaceRect.right,scrollRect.right)+1;
        };
        const unobscured = (element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
          return element === hit || element.contains(hit)
            || (element instanceof HTMLButtonElement && element.disabled && hit === element.parentElement);
        };
        const buttons = [...composer.querySelectorAll('button')].filter(visible);
        const overlaps = [];
        for (let leftIndex = 0; leftIndex < buttons.length; leftIndex += 1) {
          for (let rightIndex = leftIndex+1; rightIndex < buttons.length; rightIndex += 1) {
            const left = buttons[leftIndex].getBoundingClientRect();
            const right = buttons[rightIndex].getBoundingClientRect();
            if (Math.min(left.right,right.right)-Math.max(left.left,right.left) > 1
              && Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top) > 1) {
              overlaps.push([leftIndex,rightIndex]);
            }
          }
        }
        return {
          viewport:[innerWidth,innerHeight],
          inputVisible:fitsFirstView(input),
          copyVisible:fitsFirstView(copy),
          inputUnobscured:unobscured(input),
          copyUnobscured:unobscured(copy),
          inputBeforeOpening:inputRect.top < openingRect.top,
          dateWidth:dateRect.width,
          composerWidth:composerRect.width,
          libraryBesideComposer:libraryRect.left >= composerRect.right-1,
          libraryBelowComposer:libraryRect.top >= composerRect.bottom-1,
          previewCollapsed:toggle.getAttribute('aria-expanded') === 'false'
            && !visible(document.querySelector(${JSON.stringify(previewSelector)})),
          buttonsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth+1),
          overlaps,
          bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
          rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
          featureOverflow:feature.scrollWidth-feature.clientWidth,
          composerOverflow:composer.scrollWidth-composer.clientWidth,
          libraryOverflow:library.scrollWidth-library.clientWidth,
        };
      })()`,true);
      const label = `quick-question composer ${width}x${height}`;
      assert.ok(geometry,`${label} must render its input, library, and copy action`);
      assert.deepEqual(geometry.viewport,[width,height],`${label} viewport`);
      assert.equal(geometry.inputVisible,true,`${label} input must be visible without scrolling`);
      assert.equal(geometry.copyVisible,true,`${label} copy action must be visible without scrolling`);
      assert.equal(geometry.inputUnobscured,true,`${label} input must not be obscured`);
      assert.equal(geometry.copyUnobscured,true,`${label} copy action must not be obscured`);
      assert.equal(geometry.inputBeforeOpening,true,`${label} must prioritize the question over opening settings`);
      assert.ok(geometry.dateWidth <= 260 && geometry.dateWidth < geometry.composerWidth-24,
        `${label} date control must stay compact instead of stretching across the form`);
      assert.equal(geometry.previewCollapsed,true,`${label} must initially collapse the complete copied content`);
      assert.equal(geometry.buttonsFit,true,`${label} button labels must fit`);
      assert.deepEqual(geometry.overlaps,[],`${label} buttons must not overlap`);
      for (const key of ['bodyOverflow','rootOverflow','featureOverflow','composerOverflow','libraryOverflow']) {
        assert.ok(geometry[key] <= 1,`${label} must not have horizontal overflow (${key})`);
      }
      if (width === 960) assert.equal(geometry.libraryBelowComposer,true,`${label} library must stack below the composer`);
      if (width === 1920) assert.equal(geometry.libraryBesideComposer,true,`${label} library must use the available side column`);
      if (screenshotRoot) {
        const frame = await captureRenderedFrame(win);
        fs.writeFileSync(path.join(screenshotRoot,`business-quick-question-empty-${theme}-${width}x${height}.png`),frame.toPNG());
        fs.writeFileSync(path.join(screenshotRoot,`business-quick-question-empty-${theme}-${width}x${height}.json`),JSON.stringify(geometry,null,2));
        if (quickQuestionsOnly && width === 1920) {
          const captureRect = await win.webContents.executeJavaScript(`(() => {
            const workspace = document.querySelector('[data-testid="detail-workspace"]');
            if (!(workspace instanceof HTMLElement)) return null;
            const rect = workspace.getBoundingClientRect();
            const x = Math.max(0,Math.floor(rect.left));
            const y = Math.max(0,Math.floor(rect.top));
            const opening = document.querySelector('#opening-title')?.closest('section');
            const library = document.querySelector('[data-testid="common-question-library"]');
            const contentBottom = Math.max(
              opening?.getBoundingClientRect().bottom ?? rect.bottom,
              library?.getBoundingClientRect().bottom ?? rect.bottom,
            )+24;
            return {
              x,y,
              width:Math.min(innerWidth,Math.ceil(rect.right))-x,
              height:Math.min(innerHeight,Math.ceil(rect.bottom),Math.ceil(contentBottom))-y,
            };
          })()`,true);
          assert.ok(captureRect && captureRect.width > 0 && captureRect.height > 0,
            'quick-question workspace must expose a visible native capture rectangle');
          const workspaceFrame = await win.webContents.capturePage(captureRect);
          fs.writeFileSync(path.join(screenshotRoot,`business-quick-question-workspace-${theme}-${width}x${height}.png`),workspaceFrame.toPNG());
        }
      }
      await assertFocusedInput(width,height);
    }

    await setExactViewport(win,1280,820);
    const firstQuestion = '检查模拟环境的任务积压';
    const revisedQuestion = '检查模拟环境的任务积压和重试次数';
    await fill(win,'#quick-question-input',firstQuestion);
    await click(win,toggleSelector,'expand the copied question preview');
    await waitFor(win,`(() => {
      const preview = document.querySelector(${JSON.stringify(previewSelector)});
      return document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-expanded') === 'true'
        && preview?.getClientRects().length > 0
        && preview.textContent?.includes(${JSON.stringify(firstQuestion)}) === true;
    })()`,'expanded quick-question preview');
    await fill(win,'#quick-question-input',revisedQuestion);
    await waitFor(win,`document.querySelector(${JSON.stringify(previewSelector)})?.textContent?.includes(${JSON.stringify(revisedQuestion)}) === true`,
      'expanded preview updates with the question');
    await click(win,toggleSelector,'collapse the copied question preview');
    await waitFor(win,`document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-expanded') === 'false'`,
      'quick-question preview collapse');
    await fill(win,'#quick-question-input',firstQuestion);
    await click(win,toggleSelector,'reopen the copied question preview');
    await waitFor(win,`(() => {
      const preview = document.querySelector(${JSON.stringify(previewSelector)});
      return preview?.textContent?.includes(${JSON.stringify(firstQuestion)}) === true
        && !preview.textContent.includes(${JSON.stringify(revisedQuestion)});
    })()`,'reopened preview uses the latest question');

    // Read-only fixture publication exercises reuse without changing the exact
    // mutation sequence or the collection revision owned by the CRUD scenario.
    state.questions.set(scopeKey(projectId,environmentId),{
      ...originalCollection,
      items:[{
        questionId:'question-layout-fixture',text:sampleQuestion,
        createdAt:'2026-08-30T00:00:00.000Z',updatedAt:'2026-08-30T00:00:00.000Z',
      }],
    });
    refreshCollection();
    await waitFor(win,`document.querySelector('[data-testid="common-question-library"]')?.textContent?.includes(${JSON.stringify(sampleQuestion)}) === true`,
      'read-only common-question reuse fixture');
    const reused = await win.webContents.executeJavaScript(`(() => {
      const library = document.querySelector('[data-testid="common-question-library"]');
      const button = [...(library?.querySelectorAll('button') ?? [])]
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(sampleQuestion)}));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.focus();
      button.click();
      return true;
    })()`,true);
    assert.equal(reused,true,'the common-question row must remain a reusable action');
    await waitFor(win,`(() => {
      const input = document.querySelector('#quick-question-input');
      return input?.value === ${JSON.stringify(sampleQuestion)} && document.activeElement === input
        && document.querySelector(${JSON.stringify(previewSelector)})?.textContent?.includes(${JSON.stringify(sampleQuestion)}) === true;
    })()`,'reusing a common question returns focus to the input and updates the preview');
    assert.equal(mutationCalls.length,mutationCount,'layout, preview, and question reuse must not invoke mutation APIs');
    assert.deepEqual(forbiddenCalls,[],'preview interactions must not copy or write without the corresponding explicit action');
  } finally {
    win.webContents.setZoomFactor(previousZoomFactor);
    state.questions.set(scopeKey(projectId,environmentId),originalCollection);
    refreshCollection();
    await waitFor(win,`document.querySelector('[data-testid="common-question-library"]')?.textContent?.includes('还没有常见问题') === true`,
      'restore the empty scoped common-question fixture');
    if (await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-expanded') === 'true'`,true)) {
      await click(win,toggleSelector,'restore the collapsed preview');
    }
    await fill(win,'#quick-question-input','');
    await setExactViewport(win,previousViewport[0],previousViewport[1]);
  }
}

async function assertQuickQuestionDatePicker(win) {
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  const toggleSelector = '[data-testid="quick-preview-toggle"]';
  const previewSelector = '[data-testid="quick-question-preview"]';
  const popoverSelector = '[data-slot="popover-content"]';
  const calendarSelector = `${popoverSelector} [data-slot="calendar"]`;
  const dateQuestion = '核对测试服务故障发生日期';
  try {
    await setExactViewport(win,1280,820);
    await fill(win,'#quick-question-input',dateQuestion);
    await click(win,toggleSelector,'expand the date context preview');
    await waitFor(win,`document.querySelector(${JSON.stringify(previewSelector)})?.textContent?.includes(${JSON.stringify(dateQuestion)}) === true`,
      'date context preview ready');
    await click(win,'#quick-question-date','open the question discovery calendar');
    await waitFor(win,`document.querySelector(${JSON.stringify(calendarSelector)})?.getClientRects().length > 0`,
      'question discovery calendar visible');
    const datePopover = await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('#quick-question-date');
      const controlled = document.getElementById(trigger?.getAttribute('aria-controls') ?? '');
      return {
        expanded:trigger?.getAttribute('aria-expanded') === 'true',
        linkedCalendar:controlled?.querySelector('[data-slot="calendar"]')?.getClientRects().length > 0,
        previewHasDate:document.querySelector(${JSON.stringify(previewSelector)})?.textContent?.includes('问题发现时间：') === true,
      };
    })()`,true);
    assert.deepEqual(datePopover,{expanded:true,linkedCalendar:true,previewHasDate:false},
      'the discovery calendar must be accessible and opening it must not select a date');
    const selectedDate = await win.webContents.executeJavaScript(`(() => {
      const calendar = document.querySelector(${JSON.stringify(calendarSelector)});
      const day = [...(calendar?.querySelectorAll('button[data-day]') ?? [])]
        .find((button) => !button.disabled && button.getClientRects().length > 0
          && !button.closest('[data-outside="true"]'));
      if (!(day instanceof HTMLButtonElement)) return null;
      const parts = String(day.dataset.day).match(/\\d+/gu)?.map(Number);
      if (!parts || parts.length !== 3) return null;
      const [year,month,date] = parts;
      day.click();
      return {year,month,date};
    })()`,true);
    assert.ok(selectedDate && selectedDate.year >= 1000 && selectedDate.month >= 1
      && selectedDate.month <= 12 && selectedDate.date >= 1 && selectedDate.date <= 31,
      'the discovery calendar must expose a valid selectable date');
    const expectedDateLine = `问题发现时间：${selectedDate.month}月${selectedDate.date}日`;
    await waitFor(win,`(() => {
      const trigger = document.querySelector('#quick-question-date');
      const preview = document.querySelector(${JSON.stringify(previewSelector)});
      return trigger?.getAttribute('data-empty') === 'false'
        && trigger.getAttribute('aria-expanded') === 'false'
        && preview?.textContent?.split('\\n').includes(${JSON.stringify(expectedDateLine)}) === true
        && document.activeElement === trigger;
    })()`,'selecting a date updates month-day preview context and restores trigger focus');
    const selectedDateGeometry = await win.webContents.executeJavaScript(`(() => {
      const date = document.querySelector('#quick-question-date');
      const composer = document.querySelector('[data-testid="quick-question-composer"]');
      return {dateWidth:date.getBoundingClientRect().width,composerWidth:composer.getBoundingClientRect().width};
    })()`,true);
    assert.ok(selectedDateGeometry.dateWidth <= 260
      && selectedDateGeometry.dateWidth < selectedDateGeometry.composerWidth-24,
      'the selected date must remain compact');
    await click(win,'#quick-question-date','reopen the selected discovery date');
    await waitFor(win,`document.querySelector(${JSON.stringify(`${calendarSelector} button[data-selected-single="true"]`)}) !== null`,
      'the calendar retains its selected date');
    await clickText(win,'清除日期',popoverSelector);
    await waitFor(win,`(() => {
      const trigger = document.querySelector('#quick-question-date');
      const preview = document.querySelector(${JSON.stringify(previewSelector)});
      return trigger?.getAttribute('data-empty') === 'true'
        && trigger.getAttribute('aria-expanded') === 'false'
        && preview?.textContent?.includes('问题发现时间：') === false
        && preview.textContent.includes(${JSON.stringify(dateQuestion)})
        && document.activeElement === trigger;
    })()`,'clearing the discovery date preserves the question, removes date context, and restores focus');
  } finally {
    if (await win.webContents.executeJavaScript(`document.querySelector('#quick-question-date')?.getAttribute('aria-expanded') === 'true'`,true)) {
      await pressRendererKey(win,'Escape');
    }
    if (await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-expanded') === 'true'`,true)) {
      await click(win,toggleSelector,'restore the collapsed date preview');
    }
    await fill(win,'#quick-question-input','');
    await setExactViewport(win,previousViewport[0],previousViewport[1]);
  }
}

async function captureInlineEditorEvidence(win,{name,testId,fieldId,scopeText}) {
  const previousViewport = await win.webContents.executeJavaScript('[window.innerWidth,window.innerHeight]',true);
  const selector = `[data-testid="${testId}"]`;
  const theme = requestedScreenshotTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  if (screenshotRoot) fs.mkdirSync(screenshotRoot,{recursive:true});
  try {
    for (const [width,height] of [[960,640],[1280,820],[1920,1080]]) {
      await setExactViewport(win,width,height);
      for (const part of ['editor','actions']) {
        await win.webContents.executeJavaScript(`(() => {
          const editor = document.querySelector(${JSON.stringify(selector)});
          const target = ${JSON.stringify(part)} === 'editor'
            ? editor?.querySelector('[data-slot="card-header"]')
            : editor?.querySelector('[data-slot="button-group"]');
          target?.scrollIntoView({block:${JSON.stringify(part)} === 'editor' ? 'start' : 'nearest',inline:'nearest',behavior:'instant'});
        })()`,true);
        await win.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true,
        );
        await wait(100);
        const geometry = await win.webContents.executeJavaScript(`(() => {
          const editor = document.querySelector(${JSON.stringify(selector)});
          const workspace = document.querySelector('#detail-main');
          const field = document.getElementById(${JSON.stringify(fieldId)});
          const actions = editor?.querySelector('[data-slot="button-group"]');
          if (!(editor instanceof HTMLElement) || !(workspace instanceof HTMLElement)
            || !(field instanceof HTMLElement) || !(actions instanceof HTMLElement)) return null;
          const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
          const editorRect = editor.getBoundingClientRect();
          const workspaceRect = workspace.getBoundingClientRect();
          const partTarget = ${JSON.stringify(part)} === 'editor' ? field : actions;
          const targetRect = partTarget.getBoundingClientRect();
          const controls = [...editor.querySelectorAll('button,input,textarea')].filter(visible);
          const buttons = controls.filter((control) => control instanceof HTMLButtonElement);
          const overlaps = [];
          for (let leftIndex = 0; leftIndex < buttons.length; leftIndex += 1) {
            for (let rightIndex = leftIndex+1; rightIndex < buttons.length; rightIndex += 1) {
              const left = buttons[leftIndex].getBoundingClientRect();
              const right = buttons[rightIndex].getBoundingClientRect();
              if (Math.min(left.right,right.right)-Math.max(left.left,right.left) > 1
                && Math.min(left.bottom,right.bottom)-Math.max(left.top,right.top) > 1) {
                overlaps.push([leftIndex,rightIndex]);
              }
            }
          }
          const descriptionIds = String(field.getAttribute('aria-describedby') ?? '').split(/\\s+/u).filter(Boolean);
          const actionButtons = [...actions.querySelectorAll('button')];
          const targetCenter = {
            x:Math.max(0,Math.min(innerWidth-1,targetRect.left+targetRect.width/2)),
            y:Math.max(0,Math.min(innerHeight-1,targetRect.top+targetRect.height/2)),
          };
          const targetHit = document.elementFromPoint(targetCenter.x,targetCenter.y);
          return {
            viewport:[innerWidth,innerHeight],
            modalCount:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).length,
            inlineEditorCount:[...document.querySelectorAll('[data-testid="quick-opening-inline-editor"],[data-testid="common-question-inline-editor"]')].filter(visible).length,
            partVisible:targetRect.top >= workspaceRect.top-1 && targetRect.bottom <= workspaceRect.bottom+1
              && targetRect.left >= workspaceRect.left-1 && targetRect.right <= workspaceRect.right+1,
            partUnobscured:partTarget === targetHit || partTarget.contains(targetHit),
            scopePresent:editor.textContent?.includes(${JSON.stringify(scopeText)}) === true,
            controlsInside:controls.every((control) => {
              const rect = control.getBoundingClientRect();
              return rect.left >= editorRect.left-1 && rect.right <= editorRect.right+1
                && rect.left >= workspaceRect.left-1 && rect.right <= workspaceRect.right+1;
            }),
            buttonsFit:buttons.every((button) => button.scrollWidth <= button.clientWidth+1),
            actionHeightsMatch:actionButtons.every((button) => Math.abs(button.getBoundingClientRect().height-actionButtons[0].getBoundingClientRect().height) <= 1),
            descriptionIdsPresent:descriptionIds.length > 0 && descriptionIds.every((id) => document.getElementById(id)),
            overlaps,
            bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
            rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
            editorOverflow:editor.scrollWidth-editor.clientWidth,
          };
        })()`,true);
        const label = `${name} ${width}x${height} ${part}`;
        assert.ok(geometry,`${label} must render an inline editor in the third column`);
        assert.deepEqual(geometry.viewport,[width,height],`${label} viewport`);
        assert.equal(geometry.modalCount,0,`${label} must not open a modal`);
        assert.equal(geometry.inlineEditorCount,1,`${label} must keep a single inline editor`);
        assert.equal(geometry.scopePresent,true,`${label} must explain its current scope`);
        assert.equal(geometry.partVisible,true,`${label} must be reachable by normal container scrolling`);
        assert.equal(geometry.partUnobscured,true,`${label} must not be obscured by another surface`);
        assert.equal(geometry.controlsInside,true,`${label} controls must stay inside the third column`);
        assert.equal(geometry.buttonsFit,true,`${label} button labels must fit`);
        assert.equal(geometry.actionHeightsMatch,true,`${label} action buttons must align`);
        assert.equal(geometry.descriptionIdsPresent,true,`${label} field descriptions must resolve`);
        assert.deepEqual(geometry.overlaps,[],`${label} buttons must not overlap`);
        assert.ok(geometry.bodyOverflow <= 1,`${label} must not overflow the page horizontally`);
        assert.ok(geometry.rootOverflow <= 1,`${label} must not overflow the document horizontally`);
        assert.ok(geometry.editorOverflow <= 1,`${label} must not overflow the editor horizontally`);
        if (screenshotRoot) {
          const frame = await captureRenderedFrame(win);
          fs.writeFileSync(path.join(screenshotRoot,`business-${name}-${theme}-${width}x${height}-${part}.png`),frame.toPNG());
          fs.writeFileSync(path.join(screenshotRoot,`business-${name}-${theme}-${width}x${height}-${part}.json`),JSON.stringify(geometry,null,2));
        }
      }
    }
  } finally {
    await setExactViewport(win,previousViewport[0],previousViewport[1]);
    await win.webContents.executeJavaScript(`(() => {
      const field = document.getElementById(${JSON.stringify(fieldId)});
      field?.focus({preventScroll:true});
      field?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    })()`,true);
  }
}

async function attemptDetailTab(win,tab) {
  await focusRenderer(win);
  await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-detail-tab="${tab}"]');
    target?.focus({preventScroll:true});
  })()`,true);
  await pressRendererKey(win,'Enter');
}

async function assertInlineDraft(win,{fieldId,text,testId}) {
  const snapshot = await win.webContents.executeJavaScript(`(() => ({
    text:document.getElementById(${JSON.stringify(fieldId)})?.value,
    editorCount:[...document.querySelectorAll('[data-testid="quick-opening-inline-editor"],[data-testid="common-question-inline-editor"]')]
      .filter((element) => element.getClientRects().length > 0).length,
    expectedEditorVisible:(document.querySelector('[data-testid="${testId}"]')?.getClientRects().length ?? 0) > 0,
    modalCount:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter((element) => element.getClientRects().length > 0).length,
    questionsSelected:document.querySelector('[data-detail-tab="questions"]')?.getAttribute('aria-selected') === 'true',
  }))()`,true);
  assert.deepEqual(snapshot,{text,editorCount:1,expectedEditorVisible:true,modalCount:0,questionsSelected:true},
    `${testId} must retain its draft without a modal or scope change`);
}

async function dismissDirtyLeave(win,action) {
  await waitFor(win,`document.querySelector('[data-testid="dirty-leave-dialog"]') !== null`,'quick-question dirty leave guard');
  const modals = await win.webContents.executeJavaScript(`(() => {
    const visible = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter((element) => element.getClientRects().length > 0);
    return {count:visible.length,subject:visible[0]?.textContent?.includes('快捷提问') === true};
  })()`,true);
  assert.deepEqual(modals,{count:1,subject:true},'quick-question drafts require exactly one scoped leave confirmation');
  if (action === 'Escape') {
    await pressRendererKey(win,'Escape');
  } else {
    await clickText(win,action,'[data-testid="dirty-leave-dialog"]');
  }
  await waitFor(win,`document.querySelector('[data-testid="dirty-leave-dialog"]') === null`,'quick-question dirty guard close');
}

async function assertFocusWithin(win,selector,label) {
  await waitFor(win,`(() => {
    const active = document.activeElement;
    return document.hasFocus() && active instanceof HTMLElement && active !== document.body
      && active.isConnected && active.getClientRects().length > 0
      && !active.closest('[inert],[aria-hidden="true"]')
      && [...document.querySelectorAll(${JSON.stringify(selector)})].some((root) => root.contains(active));
  })()`,label);
}

async function openInlineQuestion(win,label) {
  await waitFor(win,`(() => {
    const button = document.querySelector('[data-testid="common-question-add"]');
    return button instanceof HTMLButtonElement && !button.disabled && button.getClientRects().length > 0;
  })()`,'scoped common-question collection ready');
  await click(win,'[data-testid="common-question-add"]',label);
  await waitFor(win,`document.querySelector('[data-testid="common-question-inline-editor"]') !== null`,'common-question inline editor');
}

async function assertSurface(win,selector,ctaText) {
  await settleAnimations(win);
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const normalize = (value) => String(value ?? '').replace(/\\s+/gu,' ').trim();
    const surface = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => (
      candidate instanceof HTMLElement
      && candidate.getClientRects().length > 0
      && [...candidate.querySelectorAll('button')].some((button) => (
        button instanceof HTMLElement
        && button.getClientRects().length > 0
        && normalize(button.textContent) === ${JSON.stringify(ctaText)}
      ))
    ));
    if (!(surface instanceof HTMLElement)) return null;
    const cta = [...surface.querySelectorAll('button')].find((button) => (
      button instanceof HTMLElement
      && button.getClientRects().length > 0
      && normalize(button.textContent) === ${JSON.stringify(ctaText)}
    ));
    const rect = surface.getBoundingClientRect();
    const surfaceStyle = getComputedStyle(surface);
    const ctaRect = cta?.getBoundingClientRect() ?? null;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const inside = (candidate) => Boolean(candidate
      && candidate.left >= -1
      && candidate.top >= -1
      && candidate.right <= viewportWidth + 1
      && candidate.bottom <= viewportHeight + 1);
    return {
      viewport:[viewportWidth,viewportHeight],
      surfaceRect:[rect.left,rect.top,rect.right,rect.bottom],
      surfaceStyle:{
        animationName:surfaceStyle.animationName,
        animationPlayState:surfaceStyle.animationPlayState,
        animationDuration:surfaceStyle.animationDuration,
        transform:surfaceStyle.transform,
      },
      ctaRect:ctaRect ? [ctaRect.left,ctaRect.top,ctaRect.right,ctaRect.bottom] : null,
      surfaceInside:inside(rect),
      ctaInside:inside(ctaRect),
      ctaVisible:Boolean(cta),
    };
  })()`,true);
  assert.ok(geometry,`${selector} is not visible`);
  assert.equal(
    geometry.surfaceInside,
    true,
    `${selector} exceeds the 960x640 viewport: ${JSON.stringify(geometry)}`,
  );
  assert.equal(geometry.ctaVisible,true,`${ctaText} is not visible in ${selector}`);
  assert.equal(geometry.ctaInside,true,`${ctaText} exceeds the 960x640 viewport`);
}

function call(channel,index = 0) {
  return mutationCalls.filter((entry) => entry.channel === channel)[index] ?? null;
}

async function waitForCall(channel,index = 0) {
  await waitUntil(() => call(channel,index) !== null,`${channel} call ${index + 1}`);
  return call(channel,index);
}

async function openProjectSettings(win,name) {
  await openMenu(win,`button[aria-label=${JSON.stringify(`${name}更多操作`)}]`,`${name} project actions`);
  await waitFor(win,`document.querySelector('[role="menu"]') !== null`,'project actions menu');
  await clickText(win,'项目设置');
  await waitFor(
    win,
    `document.querySelector('[data-testid="project-settings-dialog"]') !== null`,
    'project settings dialog',
  );
  await assertScopedMutationModal(win,'project-settings-dialog','dialog');
}

async function openEnvironmentSettings(win,name) {
  await openMenu(win,`button[aria-label=${JSON.stringify(`${name}更多操作`)}]`,`${name} environment actions`);
  await waitFor(win,`document.querySelector('[role="menu"]') !== null`,'environment actions menu');
  await clickText(win,'环境设置');
  await waitFor(
    win,
    `document.querySelector('[data-testid="environment-settings-dialog"]') !== null`,
    'environment settings dialog',
  );
  await assertScopedMutationModal(win,'environment-settings-dialog','dialog');
}

async function assertScopedMutationModal(win,testId,role) {
  await waitFor(win,`document.querySelector('[data-testid="${testId}"]')?.contains(document.activeElement) === true && document.querySelector('[role="menu"]') === null`,`${testId} receives native focus after its menu closes`);
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector('[data-testid="${testId}"]');
    if (!(surface instanceof HTMLElement)) return null;
    const visibleModals = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((candidate) => candidate.getClientRects().length > 0);
    const backgroundRegions = [...document.querySelectorAll('[data-project-id],[data-testid="add-project-footer"],[data-testid="resource-panel"],[data-testid="detail-panel"]')]
      .filter((element) => element.getClientRects().length > 0);
    const interactiveSelector = 'button,input,textarea,select,a[href],[tabindex]:not(main):not([role="tabpanel"]),[contenteditable="true"]';
    const backgroundControls = [...new Set(backgroundRegions.flatMap((element) => [
      ...(element.matches(interactiveSelector) ? [element] : []),
      ...element.querySelectorAll(interactiveSelector),
    ]))].filter((element) => element.getClientRects().length > 0);
    return {
      role:surface.getAttribute('role'),
      backgroundHidden:backgroundControls.every((element) => element.closest('[aria-hidden="true"],[inert]')),
      backgroundControlCount:backgroundControls.length,
      exposedBackgroundControls:backgroundControls.filter((element) => !element.closest('[aria-hidden="true"],[inert]'))
        .map((element) => ({tag:element.tagName,id:element.id,testId:element.getAttribute('data-testid'),role:element.getAttribute('role')})),
      preservedLiveRegions:backgroundRegions.flatMap((element) => [...element.querySelectorAll('[aria-live]')])
        .filter((element) => !element.closest('[aria-hidden="true"],[inert]')).length,
      active:{tag:document.activeElement?.tagName,id:document.activeElement?.id,slot:document.activeElement?.getAttribute('data-slot')},
      menus:[...document.querySelectorAll('[role="menu"]')].map((element) => ({state:element.getAttribute('data-state'),visible:element.getClientRects().length > 0})),
      hiddenNodes:[...document.querySelectorAll('[aria-hidden="true"],[inert]')].map((element) => ({tag:element.tagName,id:element.id,testId:element.getAttribute('data-testid'),slot:element.getAttribute('data-slot')})).filter((element) => element.tag !== 'svg'),
      tabStops:[...surface.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter((element) => !element.disabled && element.getClientRects().length > 0).length,
      count:visibleModals.length,
      focusedInside:surface.contains(document.activeElement),
      height:surface.getBoundingClientRect().height,
      nestedDeletion:surface.querySelector('[data-testid^="delete-"]') !== null,
    };
  })()`,true);
  assert.ok(geometry,`${testId} must be visible`);
  assert.equal(geometry.role,role,`${testId} must retain its Radix role`);
  // Radix preserves aria-live regions and their ancestors. Require every
  // background control to be hidden, then verify native focus containment;
  // requiring a whole panel to be hidden would incorrectly hide live status.
  assert.ok(geometry.backgroundControlCount > 0,`${testId} must inspect real background controls`);
  assert.equal(geometry.backgroundHidden,true,`${testId} must hide background controls from accessibility traversal: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.count,1,`${testId} must be the only open business modal`);
  assert.equal(geometry.focusedInside,true,`${testId} must receive focus: ${JSON.stringify(geometry)}`);
  const escapedFocus = await win.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector('[data-testid="${testId}"]');
    const targets = [...document.querySelectorAll('[data-testid="add-project-footer"],#detail-main,[data-testid="detail-panel"] [role="tabpanel"]')]
      .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0);
    if (!targets.length) return true;
    return targets.some((target) => {
      target.focus({preventScroll:true});
      return !surface.contains(document.activeElement);
    });
  })()`,true);
  assert.equal(escapedFocus,false,`${testId} must restore attempted background focus into its modal`);
  for (const modifiers of [[],['shift']]) {
    for (let index = 0; index <= geometry.tabStops; index += 1) {
      await pressRendererKey(win,'Tab',modifiers);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="${testId}"]')?.contains(document.activeElement) === true`,true),
        true,`${testId} must trap real ${modifiers.length ? 'Shift+Tab' : 'Tab'} focus`);
    }
  }
  if (role === 'dialog') {
    assert.ok(geometry.height < 480,`${testId} must remain a compact name-edit dialog`);
    assert.equal(geometry.nestedDeletion,false,`${testId} must not embed deletion`);
  }
}

async function openScopedDelete(win,{actionText,resourceSelector,testId}) {
  await focusRenderer(win);
  const point = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(resourceSelector)});
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return null;
    target.focus();
    const rect = target.getBoundingClientRect();
    return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
  })()`,true);
  assert.ok(point,`${resourceSelector} must be visible for direct deletion`);
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
  win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'right',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'right',clickCount:1});
  await waitFor(win,`document.querySelector('[role="menu"]') !== null`,'scoped context menu');
  await clickText(win,actionText,'[role="menu"]');
  await waitFor(win,`document.querySelector('[data-testid="${testId}"]') !== null`,testId);
  await assertScopedMutationModal(win,testId,'alertdialog');
}

async function assertOneScopeSuccessToast(win,message) {
  const count = await win.webContents.executeJavaScript(`(() => (
    [...document.querySelectorAll('[data-sonner-toast]')]
      .filter((toast) => toast.textContent?.includes(${JSON.stringify(message)})).length
  ))()`,true);
  assert.equal(count,1,`${message} must be announced once, not by both controller and App Shell`);
}

async function assertBusinessRecoveryAndLifecycle(win,{projectId,environmentId}) {
  const scope = {projectId,environmentId};
  const start = mutationCalls.length;
  const originalRunbookSave = mutationHandlers.get('v2:runbook-save');
  let runbookAttempts = 0;
  ipcMain.removeHandler('v2:runbook-save');
  registerMutation('v2:runbook-save',(payload) => {
    assert.deepEqual({projectId:payload.projectId,environmentId:payload.environmentId},scope);
    if (++runbookAttempts === 1) {
      findEnvironment(projectId,environmentId).revision += 1;
      state.runbooks.set(scopeKey(projectId,environmentId),'# 其他窗口保存的内容');
      return conflict('环境配置已经变化，请刷新后重试。');
    }
    return originalRunbookSave(payload);
  });
  await activateTab(win,'runbook');
  await clickText(win,'编辑','[data-feature="runbook"]');
  const draft = '# 冲突恢复草稿\n保留本次人工修改。';
  await fill(win,'textarea[aria-label="当前环境运维说明"]',draft);
  await clickText(win,'保存','[data-feature="runbook"]');
  await waitFor(win,`document.querySelector('[data-feature="runbook"] [role="alert"]')?.textContent.includes('运维说明已在其他位置更新') === true`,'runbook conflict preserves editable draft');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="当前环境运维说明"]')?.value`,true),draft);
  await waitFor(win,`[...document.querySelectorAll('[data-feature="runbook"] button')].some(button => button.textContent.trim() === '保存' && !button.disabled)`,'runbook conflict refresh completes');
  await clickText(win,'保存','[data-feature="runbook"]');
  await waitFor(win,`document.querySelector('[data-feature="runbook"] pre')?.textContent.includes('冲突恢复草稿') === true`,'runbook retry saves preserved draft');
  const runbookWrites = mutationCalls.slice(start).filter(entry => entry.channel === 'v2:runbook-save');
  assert.equal(runbookWrites.length,2);
  assert.equal(runbookWrites[1].payload.expectedRevision,runbookWrites[0].payload.expectedRevision+1);
  assert.equal(runbookWrites[1].payload.content,draft);
  await clickText(win,'编辑','[data-feature="runbook"]');
  await fill(win,'textarea[aria-label="当前环境运维说明"]','# 应取消的运维说明');
  await clickText(win,'取消','[data-feature="runbook"]');
  assert.equal(state.runbooks.get(scopeKey(projectId,environmentId)),draft,'runbook cancellation must not overwrite the saved document');

  let copyAttempts = 0;
  const copied = [];
  ipcMain.removeHandler('v2:quick-question-copy');
  registerMutation('v2:quick-question-copy',(payload) => {
    assert.deepEqual(payload,{...scope,text:'检查业务恢复流程',expectedOpeningRevision:state.opening.revision});
    if (++copyAttempts === 1) {
      state.opening = {...state.opening,text:'请使用 AI Ops MCP 检查更新后的模拟范围。',revision:state.opening.revision+1};
      return conflict('开场词已经更新。');
    }
    copied.push(payload.text);
    return ok({copied:true});
  });
  await activateTab(win,'questions');
  await fill(win,'#quick-question-input','检查业务恢复流程');
  await click(win,'[data-testid="quick-question-copy"]','copy current question');
  await waitFor(win,`document.querySelector('[data-feature="quick-questions"]')?.textContent.includes('开场词已更新，预览已刷新。请再次复制。') === true`,'copy conflict refreshes opening before retry');
  await click(win,'[data-testid="quick-question-copy"]','retry exact question copy');
  await waitUntil(() => copied.length === 1,'one accepted copy after opening conflict');
  assert.deepEqual(copied,['检查业务恢复流程']);

  const auditEntries = [
    {auditId:'recover-success',type:'runbook-updated',result:'success',actor:'user',time:'2026-08-30T05:00:00.000Z',environmentId,description:'业务成功记录'},
    {auditId:'recover-error',type:'runbook-updated',result:'error',actor:'user',time:'2026-08-30T05:01:00.000Z',environmentId,description:'业务失败记录'},
  ];
  ipcMain.removeHandler('v2:audit-list');
  registerRead('v2:audit-list',() => ({entries:auditEntries,nextCursor:null}));
  await activateTab(win,'audit');
  await click(win,'[data-testid="audit-refresh-trigger"]','refresh recovery audit rows');
  await waitFor(win,`document.querySelector('[data-feature="audit"]')?.textContent.includes('业务成功记录') === true`,'audit rows available');
  await fill(win,'input[aria-label="搜索操作记录"]','业务失败记录');
  await waitFor(win,`document.querySelector('[data-feature="audit"]')?.textContent.includes('业务失败记录') === true && !document.querySelector('[data-feature="audit"]')?.textContent.includes('业务成功记录')`,'audit query filters visible rows');
  await fill(win,'input[aria-label="搜索操作记录"]','');
  await click(win,'[aria-label="筛选操作结果"]','filter audit outcome');
  await clickText(win,'失败','[role="listbox"]');
  await waitFor(win,`document.querySelector('[data-feature="audit"]')?.textContent.includes('业务失败记录') === true && !document.querySelector('[data-feature="audit"]')?.textContent.includes('业务成功记录')`,'audit outcome filter');
  await click(win,'[aria-label="筛选操作结果"]','reset audit outcome');
  await clickText(win,'全部结果','[role="listbox"]');
  await waitFor(win,`document.querySelector('[data-feature="audit"]')?.textContent.includes('业务成功记录') === true`,'audit filter reset');

  let pending = [
    {...scope,pluginInstanceId:'mock-server',requestId:'recover-approve',capability:'server.shell',summary:'执行模拟健康检查',approvalLevel:'strong',riskLevel:'critical',expiresAt:Date.now()+120000},
    {...scope,pluginInstanceId:'mock-server',requestId:'recover-reject',capability:'server.write_file',summary:'写入模拟说明',approvalLevel:'standard',riskLevel:'write',expiresAt:Date.now()+120000},
    {projectId:'another-project',environmentId:'another-environment',pluginInstanceId:'mock-server',requestId:'out-of-scope',capability:'server.write_file',summary:'其他环境操作',approvalLevel:'standard',expiresAt:Date.now()+120000},
  ];
  ipcMain.removeHandler('v2:confirmation-list');
  registerRead('v2:confirmation-list',() => pending);
  let approvalAttempts = 0;
  ipcMain.removeHandler('v2:confirmation-approve');
  registerMutation('v2:confirmation-approve',(requestId) => {
    assert.equal(requestId,'recover-approve');
    if (++approvalAttempts === 1) return {ok:false,error:{code:'CONFIRMATION_FAILED',message:'模拟授权暂时失败。'}};
    pending = pending.filter(item => item.requestId !== requestId);
    return ok({approved:true});
  });
  ipcMain.removeHandler('v2:confirmation-reject');
  registerMutation('v2:confirmation-reject',(requestId) => {
    assert.equal(requestId,'recover-reject');
    pending = pending.filter(item => item.requestId !== requestId);
    return ok({rejected:true});
  });
  await activateTab(win,'confirmations');
  win.webContents.send('v2:confirmations',clone(pending));
  await waitFor(win,`document.querySelector('[data-confirmation-id="recover-approve"]') !== null`,'scoped confirmation queue');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-confirmation-id="out-of-scope"]') === null`,true),true,'confirmation queue cannot expose another environment');
  assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-confirmation-id="recover-approve"] button')].find(button => button.textContent.trim() === '确认执行一次')?.disabled`,true),true,'strong approvals require explicit acknowledgement');
  await click(win,'#confirmation-ack-recover-approve','acknowledge exact simulated command');
  await clickText(win,'确认执行一次','[data-confirmation-id="recover-approve"]');
  await waitFor(win,`document.querySelector('[data-feature="confirmations"] [role="alert"]') !== null`,'failed approval keeps retry available');
  await clickText(win,'确认执行一次','[data-confirmation-id="recover-approve"]');
  await waitFor(win,`document.querySelector('[data-confirmation-id="recover-approve"]') === null`,'approved request removed exactly once');
  await clickText(win,'拒绝','[data-confirmation-id="recover-reject"]');
  await waitFor(win,`document.querySelector('[data-confirmation-id="recover-reject"]') === null`,'rejected request removed');
  assert.equal(approvalAttempts,2);
  assert.deepEqual(pending.map(item => item.requestId),['out-of-scope']);

  await activateTab(win,'overview');
  const beforeCreate = mutationCalls.length;
  await click(win,'[data-testid="add-environment-footer"]','add lifecycle environment');
  await clickText(win,'创建环境','[data-testid="create-environment-dialog"]');
  await waitFor(win,`document.querySelector('#new-environment-name')?.getAttribute('aria-invalid') === 'true'`,'blank environment name reports form error');
  assert.equal(mutationCalls.length,beforeCreate,'invalid environment form cannot reach IPC');
  await fill(win,'#new-environment-name','重建验证环境');
  await clickText(win,'创建环境','[data-testid="create-environment-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="create-environment-dialog"]') === null`,'environment correction succeeds');
  const createdEnvironment = findProject(projectId).environments.at(-1);
  const originalEnvironmentUpdate = mutationHandlers.get('v2:environment-update');
  let renameAttempts = 0;
  ipcMain.removeHandler('v2:environment-update');
  registerMutation('v2:environment-update',(payload) => ++renameAttempts === 1
    ? conflict('环境配置已经变化，请刷新后重试。')
    : originalEnvironmentUpdate(payload));
  await openEnvironmentSettings(win,'重建验证环境');
  await fill(win,'#environment-settings-name','重建验证新名称');
  await clickText(win,'保存名称','[data-testid="environment-settings-dialog"]');
  await waitFor(win,`document.querySelector('#environment-settings-name')?.getAttribute('aria-invalid') === 'true'`,'environment rename conflict retains form');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#environment-settings-name')?.value`,true),'重建验证新名称');
  await clickText(win,'保存名称','[data-testid="environment-settings-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="environment-settings-dialog"]') === null`,'environment rename retry succeeds');
  ipcMain.removeHandler('v2:environment-delete');
  registerMutation('v2:environment-delete',(payload) => {
    assert.deepEqual(payload,{projectId,environmentId:createdEnvironment.environmentId});
    const project = findProject(projectId);
    assert.ok(project.environments.length > 1);
    project.environments = project.environments.filter(item => item.environmentId !== payload.environmentId);
    project.revision += 1;
    return ok({...payload,deleted:true,credentialsPreserved:true});
  });
  await openScopedDelete(win,{actionText:'删除环境',resourceSelector:`[data-testid="environment-trigger-${createdEnvironment.environmentId}"]`,testId:'delete-environment-dialog'});
  await clickText(win,'确认删除','[data-testid="delete-environment-dialog"]');
  await waitFor(win,`document.querySelector('[data-environment-id="${createdEnvironment.environmentId}"]') === null && document.querySelector('[data-testid="delete-environment-dialog"]') === null`,'environment removal updates selection and closes dialog');
  await click(win,'[data-testid="add-environment-footer"]','recreate deleted environment');
  await fill(win,'#new-environment-name','重建验证新名称');
  await clickText(win,'创建环境','[data-testid="create-environment-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="create-environment-dialog"]') === null`,'environment recreated after deletion');
  assert.notEqual(findProject(projectId).environments.at(-1).environmentId,createdEnvironment.environmentId,'recreated environment receives a fresh identity');

  const projectName = findProject(projectId).name;
  ipcMain.removeHandler('v2:project-delete');
  registerMutation('v2:project-delete',(payload) => {
    assert.deepEqual(payload,{projectId});
    state.projects = state.projects.filter(project => project.projectId !== projectId);
    return ok({projectId,deleted:true,credentialsPreserved:true});
  });
  await openScopedDelete(win,{actionText:'删除项目',resourceSelector:`[data-project-id="${projectId}"]`,testId:'delete-project-dialog'});
  await fill(win,'#delete-project-confirmation',projectName);
  await clickText(win,'永久删除','[data-testid="delete-project-dialog"]');
  await waitFor(win,`document.querySelector('[data-project-id="${projectId}"]') === null && document.querySelector('[data-testid="delete-project-dialog"]') === null`,'project removed from workspace');
  const beforeProjectCreate = mutationCalls.length;
  await click(win,'[data-testid="add-project-footer"]','recreate deleted project');
  await clickText(win,'创建项目','[data-testid="create-project-dialog"]');
  await waitFor(win,`document.querySelector('#new-project-name')?.getAttribute('aria-invalid') === 'true'`,'blank project name reports form error');
  assert.equal(mutationCalls.length,beforeProjectCreate,'invalid project form cannot reach IPC');
  await fill(win,'#new-project-name',projectName);
  await fill(win,'#new-project-environment-name','重建首个环境');
  await clickText(win,'创建项目','[data-testid="create-project-dialog"]');
  await waitFor(win,`document.querySelector('[data-testid="create-project-dialog"]') === null`,'project recreated after deletion');
  const recreated = state.projects.at(-1);
  assert.notEqual(recreated.projectId,projectId,'recreated project receives a fresh identity');
  assert.equal(recreated.environments.length,1,'recreated project starts with its own first environment');
  const expected = [
    'v2:runbook-save','v2:runbook-save','v2:quick-question-copy','v2:quick-question-copy',
    'v2:confirmation-approve','v2:confirmation-approve','v2:confirmation-reject',
    'v2:environment-create','v2:environment-update','v2:environment-update','v2:environment-delete',
    'v2:environment-create','v2:project-delete','v2:project-create',
  ];
  assert.deepEqual(mutationCalls.slice(start).map(entry => entry.channel),expected,'recovery/lifecycle cases have an exact bounded mutation sequence');
  process.stdout.write(`Business recovery/lifecycle passed (${expected.length} exact attempts; runbook conflict/cancel, copy retry, audit filters, approval/rejection, delete/recreate)\n`);
}

async function run() {
  assert.ok(fs.existsSync(pagePath),'build:renderer must produce renderer-build/v2/index.html');
  await app.whenReady();
  registerMockApi();
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => {
    if (!details.url.startsWith('file:') && !details.url.startsWith('devtools:')) {
      externalRequests.push(details.url);
      callback({cancel:true});
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    show:false,
    useContentSize:true,
    width:960,
    height:640,
    webPreferences:{
      preload:path.join(root,'src','preload.cjs'),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      backgroundThrottling:false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('did-finish-load',() => win.webContents.focus());
  win.webContents.on('will-attach-webview',(event) => event.preventDefault());
  win.webContents.on('will-navigate',(event) => event.preventDefault());
  win.webContents.on('console-message',(_event,level,message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  let releaseAuditClear = null;

  try {
    await win.loadFile(pagePath);
    await focusRenderer(win);
    win.setContentSize(960,640);
    await wait(80);
    await waitFor(
      win,
      `document.querySelector('[data-shell-ready="true"]') !== null`,
      'React App Shell mount',
    );
    if (requestedScreenshotTheme) {
      await waitFor(
        win,
        `document.documentElement.dataset.theme === ${JSON.stringify(requestedScreenshotTheme)}`,
        `${requestedScreenshotTheme} screenshot theme`,
      );
    }
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-alpha"]') !== null`,
      'initial project',
    );
    await assertRendererKeyboardFocus(win);

    if (recoveryOnly) {
      await click(win,'[data-project-id="project-alpha"]','select recovery project');
      await click(win,'[data-testid="environment-trigger-env-production"]','select recovery environment');
      await assertBusinessRecoveryAndLifecycle(win,{projectId:'project-alpha',environmentId:'env-production'});
      assert.deepEqual(forbiddenCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      return;
    }

    if (quickQuestionsOnly) {
      await click(win,'[data-project-id="project-alpha"]','select the existing quick-question project');
      await waitFor(win,`document.querySelector('[data-environment-id="env-production"] [data-shell-nav-item]') !== null`,
        'initial production environment');
      await click(win,'[data-environment-id="env-production"] [data-shell-nav-item]','select the initial production environment');
      await waitFor(win,`document.querySelector('[data-environment-id="env-production"] [data-shell-nav-item]')?.getAttribute('aria-current') === 'page'`,
        'initial production environment selection');
      await activateTab(win,'questions');
      await waitFor(win,`document.querySelector('[data-feature="quick-questions"]') !== null`,
        'isolated quick questions feature');
      await assertQuickQuestionComposer(win,{projectId:'project-alpha',environmentId:'env-production'});
      await assertQuickQuestionDatePicker(win);
      assert.deepEqual(mutationCalls,[],'the isolated quick-question layout smoke must not mutate application data');
      assert.deepEqual(forbiddenCalls,[]);
      assert.deepEqual(externalRequests,[]);
      assert.deepEqual(rendererErrors,[]);
      assert.ok(readCalls.some((entry) => entry.channel === 'v2:workspace-overview'));
      assert.ok(readCalls.some((entry) => entry.channel === 'v2:quick-question-opening-get'));
      assert.ok(readCalls.some((entry) => entry.channel === 'v2:quick-question-list'));
      process.stdout.write('React quick-questions-only smoke passed (0 mutation payloads, layout/preview/reuse/date checks)\n');
      return;
    }

    await click(win,'[data-testid="add-project-footer"]','add project');
    await waitFor(
      win,
      `document.querySelector('[data-testid="create-project-dialog"]') !== null`,
      'create project dialog',
    );
    await fill(win,'#new-project-name','新建业务项目');
    await fill(win,'#new-project-environment-name','开发环境');
    await assertSurface(win,'[data-testid="create-project-dialog"]','创建项目');
    await captureSurfaceEvidence(win,{
      name:'create-project',
      selector:'[data-testid="create-project-dialog"]',
      restoreFocusSelector:'#new-project-environment-name',
    });
    await clickText(win,'创建项目','[data-testid="create-project-dialog"]');
    assert.deepEqual((await waitForCall('v2:project-create')).payload,{
      name:'新建业务项目',
      environmentName:'开发环境',
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-created"]')?.getAttribute('aria-current') === 'page'`,
      'created project selection',
    );
    await assertOneScopeSuccessToast(win,'项目已创建');

    await click(win,'[data-project-id="project-alpha"]','select original project');
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-alpha"]')?.getAttribute('aria-current') === 'page'`,
      'original project selection',
    );
    await openProjectSettings(win,'核心运维项目');
    await fill(win,'#project-settings-name','核心平台运维');
    await assertSurface(win,'[data-testid="project-settings-dialog"]','保存名称');
    await captureSurfaceEvidence(win,{
      name:'project-settings',
      selector:'[data-testid="project-settings-dialog"]',
      restoreFocusSelector:'#project-settings-name',
    });
    await clickText(win,'保存名称','[data-testid="project-settings-dialog"]');
    assert.deepEqual((await waitForCall('v2:project-update',0)).payload,{
      projectId:'project-alpha',
      expectedRevision:5,
      patch:{name:'核心平台运维'},
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-project-id="project-alpha"]')?.textContent?.includes('核心平台运维') === true`,
      'renamed project in project rail',
    );
    await assertOneScopeSuccessToast(win,'项目名称已更新');

    await openProjectSettings(win,'核心平台运维');
    await fill(win,'#project-settings-name','冲突名称');
    await assertSurface(win,'[data-testid="project-settings-dialog"]','保存名称');
    await clickText(win,'保存名称','[data-testid="project-settings-dialog"]');
    assert.deepEqual((await waitForCall('v2:project-update',1)).payload,{
      projectId:'project-alpha',
      expectedRevision:6,
      patch:{name:'冲突名称'},
    });
    await waitFor(
      win,
      `document.querySelector('[data-testid="project-mutation-error"]')?.textContent?.includes('项目配置已经变化') === true`,
      'revision conflict feedback',
    );
    await captureSurfaceEvidence(win,{
      name:'project-revision-conflict',
      selector:'[data-testid="project-settings-dialog"]',
      restoreFocusSelector:'#project-settings-name',
    });
    const conflictSnapshot = await win.webContents.executeJavaScript(`(() => ({
      value:document.querySelector('#project-settings-name')?.value ?? null,
      invalid:document.querySelector('#project-settings-name')?.getAttribute('aria-invalid'),
      dialogVisible:document.querySelector('[data-testid="project-settings-dialog"]')?.getClientRects().length > 0,
    }))()`,true);
    assert.deepEqual(conflictSnapshot,{value:'冲突名称',invalid:'true',dialogVisible:true});
    await clickText(win,'取消','[data-testid="project-settings-dialog"]');
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-testid="project-settings-dialog"]') === null`,
      'project settings close after conflict',
    );
    await waitFor(win,
      `document.activeElement === document.querySelector('[data-project-id="project-alpha"]')`,
      'project settings cancel restores its original project');

    await openScopedDelete(win,{
      actionText:'删除项目',
      resourceSelector:'[data-project-id="project-alpha"]',
      testId:'delete-project-dialog',
    });
    await fill(win,'#delete-project-confirmation','不匹配的名称');
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const surface = document.querySelector('[data-testid="delete-project-dialog"]');
      return [...surface.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '永久删除')?.disabled;
    })()`,true),true,'project deletion still requires the exact typed name');
    await fill(win,'#delete-project-confirmation','核心平台运维');
    await assertSurface(win,'[data-testid="delete-project-dialog"]','永久删除');
    await captureSurfaceEvidence(win,{
      name:'project-delete-cancel',
      selector:'[data-testid="delete-project-dialog"]',
      restoreFocusSelector:'#delete-project-confirmation',
    });
    await clickText(win,'取消','[data-testid="delete-project-dialog"]');
    await settleAnimations(win);
    await waitFor(win,
      `document.querySelector('[data-testid="delete-project-dialog"]') === null
        && document.activeElement === document.querySelector('[data-project-id="project-alpha"]')`,
      'direct project delete cancellation restores its original project');
    assert.equal(call('v2:project-delete'),null,'cancelling project deletion must not mutate');

    await openScopedDelete(win,{
      actionText:'删除环境',
      resourceSelector:'[data-testid="environment-trigger-env-production"]',
      testId:'delete-environment-dialog',
    });
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const surface = document.querySelector('[data-testid="delete-environment-dialog"]');
      return surface.textContent.includes('暂时不能删除环境')
        && ![...surface.querySelectorAll('button')].some((button) => button.textContent?.trim() === '确认删除');
    })()`,true),true,'the last environment must remain protected from deletion');
    await clickText(win,'关闭','[data-testid="delete-environment-dialog"]');
    await settleAnimations(win);
    await waitFor(win,
      `document.querySelector('[data-testid="delete-environment-dialog"]') === null
        && document.activeElement === document.querySelector('[data-testid="environment-trigger-env-production"]')`,
      'blocked environment deletion restores the environment trigger');

    await click(win,'[data-testid="add-environment-footer"]','add environment');
    await waitFor(
      win,
      `document.querySelector('[data-testid="create-environment-dialog"]') !== null`,
      'create environment dialog',
    );
    await fill(win,'#new-environment-name','预发布环境');
    await assertSurface(win,'[data-testid="create-environment-dialog"]','创建环境');
    await captureSurfaceEvidence(win,{
      name:'create-environment',
      selector:'[data-testid="create-environment-dialog"]',
      restoreFocusSelector:'#new-environment-name',
    });
    await clickText(win,'创建环境','[data-testid="create-environment-dialog"]');
    assert.deepEqual((await waitForCall('v2:environment-create')).payload,{
      projectId:'project-alpha',
      input:{name:'预发布环境'},
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-environment-id="env-preview"] [data-shell-nav-item]')?.getAttribute('aria-current') === 'page'`,
      'created environment selection',
    );
    await assertOneScopeSuccessToast(win,'环境已创建');

    await openEnvironmentSettings(win,'预发布环境');
    await fill(win,'#environment-settings-name','预发布验证环境');
    await assertSurface(win,'[data-testid="environment-settings-dialog"]','保存名称');
    await captureSurfaceEvidence(win,{
      name:'environment-settings',
      selector:'[data-testid="environment-settings-dialog"]',
      restoreFocusSelector:'#environment-settings-name',
    });
    await clickText(win,'保存名称','[data-testid="environment-settings-dialog"]');
    assert.deepEqual((await waitForCall('v2:environment-update')).payload,{
      projectId:'project-alpha',
      environmentId:'env-preview',
      expectedRevision:1,
      patch:{name:'预发布验证环境'},
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-environment-id="env-preview"]')?.textContent?.includes('预发布验证环境') === true`,
      'renamed environment in resource pane',
    );
    await assertOneScopeSuccessToast(win,'环境名称已更新');

    await openScopedDelete(win,{
      actionText:'删除环境',
      resourceSelector:'[data-testid="environment-trigger-env-preview"]',
      testId:'delete-environment-dialog',
    });
    await assertSurface(win,'[data-testid="delete-environment-dialog"]','确认删除');
    await captureSurfaceEvidence(win,{
      name:'environment-delete-cancel',
      selector:'[data-testid="delete-environment-dialog"]',
      restoreFocusSelector:'[data-slot="alert-dialog-cancel"]',
    });
    await clickText(win,'取消','[data-testid="delete-environment-dialog"]');
    await settleAnimations(win);
    await waitFor(win,
      `document.querySelector('[data-testid="delete-environment-dialog"]') === null
        && document.activeElement === document.querySelector('[data-testid="environment-trigger-env-preview"]')`,
      'direct environment delete cancellation restores its original environment');
    assert.equal(call('v2:environment-delete'),null,'cancelling environment deletion must not mutate');

    await activateTab(win,'runbook');
    await waitFor(
      win,
      `document.querySelector('[data-feature="runbook"]') !== null`,
      'runbook feature',
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('[data-feature="runbook"] button')].some((button) => button.textContent?.trim() === '编辑')`,
      'runbook edit action',
    );
    await clickText(win,'编辑','[data-feature="runbook"]');
    const runbookContent = '# 预发布验证环境\n\n- 仅用于内存业务 smoke';
    await fill(win,'textarea[aria-label="当前环境运维说明"]',runbookContent);
    await clickText(win,'保存','[data-feature="runbook"]');
    assert.deepEqual((await waitForCall('v2:runbook-save')).payload,{
      projectId:'project-alpha',
      environmentId:'env-preview',
      content:runbookContent,
      expectedRevision:2,
    });
    await waitFor(
      win,
      `document.querySelector('[data-feature="runbook"] pre')?.textContent?.includes('仅用于内存业务 smoke') === true`,
      'saved runbook content',
    );

    await activateTab(win,'questions');
    await waitFor(
      win,
      `document.querySelector('[data-feature="quick-questions"]') !== null`,
      'quick questions feature',
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('[data-feature="quick-questions"] button')].some((button) => button.textContent?.trim() === '新增')`,
      'quick question add action',
    );
    const questionEditorSelector = '[data-testid="common-question-inline-editor"]';
    const draftBeforeSave = '尚未保存的预发布排查草稿';
    await assertQuickQuestionComposer(win,{projectId:'project-alpha',environmentId:'env-preview'});
    await openInlineQuestion(win,'add inline question');
    await waitFor(win,`document.querySelector('${questionEditorSelector}') !== null`,'add question inline editor');
    await fill(win,'#common-question-editor',draftBeforeSave);
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});

    // External reads of the same revision must not clear or spuriously stale a local draft.
    const readsBeforeQuestionRefresh = readCalls.filter((entry) => entry.channel === 'v2:quick-question-list').length;
    win.webContents.send('v2:workspace-changed',{
      type:'quick-questions-updated',projectId:'project-alpha',environmentId:'env-preview',
    });
    await waitUntil(() => readCalls.filter((entry) => entry.channel === 'v2:quick-question-list').length > readsBeforeQuestionRefresh,
      'external quick-question refresh');
    await wait(160);
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#common-question-revision-warning') === null`,true),
      true,'an unchanged collection revision must not mark the question draft stale');

    await attemptDetailTab(win,'runbook');
    await dismissDirtyLeave(win,'返回编辑');
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});
    await assertFocusWithin(win,'#common-question-editor','declining a dirty tab change restores the question draft field');

    await attemptDetailTab(win,'runbook');
    await dismissDirtyLeave(win,'Escape');
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});
    await assertFocusWithin(win,'#common-question-editor','Escape from the dirty guard restores the question draft field');

    await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="project-created"]')?.focus()`,true);
    await click(win,'[data-project-id="project-created"]','attempt project switch with a question draft');
    await dismissDirtyLeave(win,'返回编辑');
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});
    await assertFocusWithin(win,'#common-question-editor','declining a dirty project change restores the question draft field');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="project-alpha"]')?.getAttribute('aria-current') === 'page'`,true),
      true,'declining a question draft leave must preserve the selected project');

    // Switching between the two inline editors uses one local guard, not a second global modal.
    await click(win,'[data-testid="quick-opening-edit"]','attempt opening editor with a question draft');
    await dismissDirtyLeave(win,'返回编辑');
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:draftBeforeSave,testId:'common-question-inline-editor'});
    await assertFocusWithin(win,'#common-question-editor','declining a local editor switch restores the question field');

    await attemptDetailTab(win,'runbook');
    await dismissDirtyLeave(win,'放弃更改');
    await waitFor(win,`document.querySelector('[data-detail-tab="runbook"]')?.getAttribute('aria-selected') === 'true'`,'discarding a question draft switches tabs');
    await assertFocusWithin(win,'[data-testid="detail-workspace"]','discarding a question draft restores third-column focus after the draft epoch remount');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${questionEditorSelector}') === null`,true),true,
      'confirmed tab leave must remove the unsaved inline editor');

    await activateTab(win,'questions');
    await openInlineQuestion(win,'open question draft before project leave');
    await fill(win,'#common-question-editor',draftBeforeSave);
    await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="project-created"]')?.focus()`,true);
    await click(win,'[data-project-id="project-created"]','confirm project switch with a question draft');
    await dismissDirtyLeave(win,'放弃更改');
    await waitFor(win,`document.querySelector('[data-project-id="project-created"]')?.getAttribute('aria-current') === 'page'`,'discarding a question draft switches projects');
    await assertFocusWithin(win,'[data-project-id="project-created"],[data-testid="detail-workspace"]','discarding a question draft keeps focus in the destination project or workspace');
    assert.equal(mutationCalls.length,6,'question draft navigation must not call a mutation API');

    await click(win,'[data-project-id="project-alpha"]','return to the question owner project');
    await waitFor(win,`document.querySelector('[data-environment-id="env-preview"] [data-shell-nav-item]') !== null`,'return to preview environment');
    await click(win,'[data-environment-id="env-preview"] [data-shell-nav-item]','select question owner environment');
    await waitFor(win,`document.querySelector('[data-environment-id="env-preview"] [data-shell-nav-item]')?.getAttribute('aria-current') === 'page'`,'question owner environment selection');
    await activateTab(win,'questions');
    await openInlineQuestion(win,'create the scoped common question');
    await fill(win,'#common-question-editor','如何检查预发布服务？');
    await captureInlineEditorEvidence(win,{
      name:'quick-question-create',testId:'common-question-inline-editor',fieldId:'common-question-editor',
      scopeText:'核心平台运维 / 预发布验证环境',
    });
    questionSaveHold = new Promise((resolve) => { releaseQuestionSave = resolve; });
    await clickText(win,'保存',questionEditorSelector);
    const createdQuestionCall = await waitForCall('v2:quick-question-save',0);
    assert.deepEqual(createdQuestionCall.payload,{
      projectId:'project-alpha',
      environmentId:'env-preview',
      text:'如何检查预发布服务？',
      expectedRevision:0,
    });
    await waitFor(win,`document.querySelector('#common-question-editor')?.disabled === true`,'inline question saving state');
    await attemptDetailTab(win,'runbook');
    await click(win,'[data-project-id="project-created"]','attempt project navigation while saving a question');
    await assertInlineDraft(win,{fieldId:'common-question-editor',text:'如何检查预发布服务？',testId:'common-question-inline-editor'});
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-project-id="project-alpha"]')?.getAttribute('aria-current') === 'page'`,true),true,
      'in-flight question saves must block project navigation');
    assert.equal(mutationCalls.filter((entry) => entry.channel === 'v2:quick-question-save').length,1,
      'busy question navigation must not duplicate the mutation');
    releaseQuestionSave();
    questionSaveHold = null;
    releaseQuestionSave = null;
    await waitUntil(() => createdQuestionCall.result !== null,'question save completion');
    assert.equal(createdQuestionCall.result?.ok,true);
    await settleAnimations(win);
    await wait(250);
    const createdQuestionUi = await win.webContents.executeJavaScript(`(() => ({
      contains:document.querySelector('[data-feature="quick-questions"]')
        ?.textContent?.includes('如何检查预发布服务?') === true,
      inlineEditorOpen:document.querySelector('#common-question-editor') !== null,
      error:document.querySelector('[data-feature="quick-questions"] [role="alert"]')?.textContent ?? null,
      text:document.querySelector('[data-feature="quick-questions"]')?.textContent?.slice(0,1200) ?? null,
    }))()`,true);
    assert.equal(
      createdQuestionUi.contains,
      true,
      `created quick question missing: ${JSON.stringify(createdQuestionUi)}`,
    );

    await click(
      win,
      'button[aria-label="编辑常见问题：如何检查预发布服务?"]',
      'edit quick question',
    );
    await waitFor(win,`document.querySelector('${questionEditorSelector}') !== null`,'edit question inline editor');
    await fill(win,'#common-question-editor','如何检查预发布服务健康状态？');
    await captureInlineEditorEvidence(win,{
      name:'quick-question-edit',testId:'common-question-inline-editor',fieldId:'common-question-editor',
      scopeText:'核心平台运维 / 预发布验证环境',
    });
    await clickText(win,'保存',questionEditorSelector);
    assert.deepEqual((await waitForCall('v2:quick-question-save',1)).payload,{
      projectId:'project-alpha',
      environmentId:'env-preview',
      questionId:'question-1',
      text:'如何检查预发布服务健康状态？',
      expectedRevision:1,
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-feature="quick-questions"]')?.textContent?.includes('如何检查预发布服务健康状态?') === true`,
      'updated quick question',
    );

    await click(
      win,
      'button[aria-label="删除常见问题：如何检查预发布服务健康状态?"]',
      'delete quick question',
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('[role="alertdialog"]')].some((dialog) => dialog.textContent?.includes('删除常见问题'))`,
      'delete question alert dialog',
    );
    const deleteSurfaceSelector = '[role="alertdialog"]';
    await assertSurface(win,deleteSurfaceSelector,'确认删除');
    await captureSurfaceEvidence(win,{
      name:'quick-question-delete',
      selector:deleteSurfaceSelector,
      restoreFocusSelector:'[data-slot="alert-dialog-cancel"]',
    });
    await clickText(win,'确认删除',deleteSurfaceSelector);
    assert.deepEqual((await waitForCall('v2:quick-question-delete')).payload,{
      projectId:'project-alpha',
      environmentId:'env-preview',
      questionId:'question-1',
      expectedRevision:2,
    });
    await settleAnimations(win);
    await waitFor(
      win,
      `document.querySelector('[data-feature="quick-questions"]')?.textContent?.includes('还没有常见问题') === true`,
      'deleted quick question feedback',
    );
    await assertFocusWithin(win,'[data-testid="common-question-add"]','deleting the final question restores the surviving add action');

    assert.deepEqual(mutationCalls.map((entry) => entry.channel),[
      'v2:project-create',
      'v2:project-update',
      'v2:project-update',
      'v2:environment-create',
      'v2:environment-update',
      'v2:runbook-save',
      'v2:quick-question-save',
      'v2:quick-question-save',
      'v2:quick-question-delete',
    ]);

    // The original nine exact mutations and forbidden channel list stay intact.
    // Only this isolated, explicit global-opening case may now invoke opening-save.
    ipcMain.removeHandler('v2:quick-question-opening-save');
    registerMutation('v2:quick-question-opening-save',(payload) => {
      if (payload?.expectedRevision !== state.opening.revision) {
        return conflict('开场词已经变化，请刷新后重试。');
      }
      state.opening = {...state.opening,text:String(payload.text ?? ''),revision:state.opening.revision+1};
      return ok(state.opening);
    });
    const openingEditorSelector = '[data-testid="quick-opening-inline-editor"]';
    const openingDraft = '请使用 AI Ops MCP 仅在明确选择的环境进行只读排查。';
    await click(win,'[data-testid="quick-opening-edit"]','open global opening inline editor');
    await waitFor(win,`document.querySelector('${openingEditorSelector}') !== null`,'global opening inline editor');
    await fill(win,'#quick-opening-editor',openingDraft);
    await assertInlineDraft(win,{fieldId:'quick-opening-editor',text:openingDraft,testId:'quick-opening-inline-editor'});
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('${openingEditorSelector}')?.textContent?.includes('该设置对所有环境生效') === true`,true),true,
      'the global opening editor must explicitly state that it affects every environment');
    await clickText(win,'取消',openingEditorSelector);
    await dismissDirtyLeave(win,'返回编辑');
    await assertInlineDraft(win,{fieldId:'quick-opening-editor',text:openingDraft,testId:'quick-opening-inline-editor'});
    await assertFocusWithin(win,'#quick-opening-editor','returning to an opening draft restores its field');
    await captureInlineEditorEvidence(win,{
      name:'quick-opening-edit',testId:'quick-opening-inline-editor',fieldId:'quick-opening-editor',
      scopeText:'该设置对所有环境生效',
    });

    state.opening = {...state.opening,text:'请使用 AI Ops MCP 先核对当前范围再读取信息。',revision:4};
    win.webContents.send('v2:workspace-changed',{type:'quick-question-opening-updated'});
    await waitFor(win,`document.querySelector('#quick-opening-revision-warning') !== null`,'external opening revision notice');
    await assertInlineDraft(win,{fieldId:'quick-opening-editor',text:openingDraft,testId:'quick-opening-inline-editor'});
    assert.equal(await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('${openingEditorSelector}');
      return [...editor.querySelectorAll('button')].some((button) => button.textContent?.trim() === '保存' && button.disabled);
    })()`,true),true,'external opening refresh must disable stale saves while keeping the draft');
    await clickText(win,'采用最新修订，保留草稿',openingEditorSelector);
    await waitFor(win,`document.querySelector('#quick-opening-revision-warning') === null`,'explicit opening revision adoption');
    await assertInlineDraft(win,{fieldId:'quick-opening-editor',text:openingDraft,testId:'quick-opening-inline-editor'});

    // A concurrent save after adoption must still fail closed against the exact snapshot revision.
    state.opening = {...state.opening,text:'请使用 AI Ops MCP 保持只读，并再次核对项目与环境。',revision:5};
    await clickText(win,'保存',openingEditorSelector);
    const openingConflictCall = await waitForCall('v2:quick-question-opening-save',0);
    assert.deepEqual(openingConflictCall.payload,{text:openingDraft,expectedRevision:4});
    await waitUntil(() => openingConflictCall.result !== null,'opening conflict response');
    assert.equal(openingConflictCall.result?.error?.code,'CONFIG_REVISION_CONFLICT');
    await waitFor(win,`document.querySelector('#quick-opening-revision-warning')?.textContent?.includes('再次核对项目与环境') === true`,'opening conflict reload preserves the local draft');
    await assertInlineDraft(win,{fieldId:'quick-opening-editor',text:openingDraft,testId:'quick-opening-inline-editor'});
    await captureInlineEditorEvidence(win,{
      name:'quick-opening-conflict',testId:'quick-opening-inline-editor',fieldId:'quick-opening-editor',
      scopeText:'该设置对所有环境生效',
    });
    await clickText(win,'采用最新修订，保留草稿',openingEditorSelector);
    await clickText(win,'保存',openingEditorSelector);
    const openingSavedCall = await waitForCall('v2:quick-question-opening-save',1);
    assert.deepEqual(openingSavedCall.payload,{text:openingDraft,expectedRevision:5});
    await waitUntil(() => openingSavedCall.result !== null,'global opening save response');
    assert.equal(openingSavedCall.result?.ok,true);
    await waitFor(win,`document.querySelector('${openingEditorSelector}') === null`,'global opening save closes the inline editor');
    await assertFocusWithin(win,'[data-testid="quick-opening-edit"]','saving an opening restores its inline edit trigger');
    assert.equal(state.opening.revision,6);

    await click(win,'[data-project-id="project-created"]','verify the opening in another project');
    await waitFor(win,`document.querySelector('[data-environment-id="env-created"] [data-shell-nav-item]') !== null`,'created project environment');
    await click(win,'[data-environment-id="env-created"] [data-shell-nav-item]','verify the opening in another environment');
    await activateTab(win,'questions');
    await waitFor(win,`document.querySelector('[data-feature="quick-questions"]')?.textContent?.includes(${JSON.stringify(openingDraft)}) === true`,
      'the saved global opening applies to another environment');
    assert.equal(questionCollection('project-alpha','env-preview').revision,3,
      'global opening saves must not change scoped common-question revisions');
    assert.deepEqual(questionCollection('project-created','env-created').items,[],
      'common questions must not leak into the other environment');
    assert.deepEqual(mutationCalls.map((entry) => entry.channel),[
      'v2:project-create',
      'v2:project-update',
      'v2:project-update',
      'v2:environment-create',
      'v2:environment-update',
      'v2:runbook-save',
      'v2:quick-question-save',
      'v2:quick-question-save',
      'v2:quick-question-delete',
      'v2:quick-question-opening-save',
      'v2:quick-question-opening-save',
    ]);
    // Audit clear is enabled only for this final, exact-scope case. The
    // preceding eleven writes remain independently asserted above.
    let auditEntries = [{auditId:'overlay-audit',type:'runbook-updated',result:'success',actor:'user',
      time:'2026-08-30T04:26:00.000Z',environmentId:'env-created',description:'更新测试环境运维说明。'}];
    ipcMain.removeHandler('v2:audit-list');
    registerRead('v2:audit-list',() => ({entries:auditEntries,nextCursor:null}));
    ipcMain.removeHandler('v2:audit-clear');
    let auditClearAttempts = 0;
    registerMutation('v2:audit-clear',async (payload) => {
      assert.deepEqual(payload,{projectId:'project-created',environmentId:'env-created',pluginInstanceId:null});
      auditClearAttempts += 1;
      if (auditClearAttempts === 1) return {ok:false,error:{code:'AUDIT_CLEAR_FAILED',message:'测试记录暂时无法清除，请重试。'}};
      await new Promise((resolve) => { releaseAuditClear = resolve; });
      auditEntries = [];
      return ok({deleted:1});
    });
    await activateTab(win,'audit');
    await waitFor(win,`document.querySelector('[data-testid="audit-clear-trigger"]')?.disabled === false`,'isolated audit entry loaded');
    await click(win,'[data-testid="audit-clear-trigger"]','open audit clear');
    await clickText(win,'确认清除','[data-testid="audit-clear-confirmation"]');
    await waitFor(win,`document.querySelector('[data-testid="audit-clear-confirmation"] [role="alert"]') !== null`,'clear failure stays inside confirmation');
    const auditFailure = await win.webContents.executeJavaScript(`(() => {
      const error = document.querySelector('[data-testid="audit-clear-confirmation"] [role="alert"]');
      return {
        title:error?.querySelector('[data-slot="alert-title"]')?.textContent,
        description:error?.querySelector('[data-slot="alert-description"]')?.textContent,
      };
    })()`,true);
    assert.deepEqual(auditFailure,{title:'记录尚未清除',description:'操作未完成，请检查目标状态后重试。'},'AUDIT_CLEAR_FAILED uses the shared safe FAILED-code message, not untrusted backend text');
    await captureSurfaceEvidence(win,{name:'audit-clear-error',selector:'[data-testid="audit-clear-confirmation"]',restoreFocusSelector:'[data-slot="alert-dialog-cancel"]'});
    await clickText(win,'确认清除','[data-testid="audit-clear-confirmation"]');
    await waitUntil(() => releaseAuditClear !== null,'audit retry in flight');
    await assertFocusWithin(win,'[data-testid="audit-clear-confirmation"]','busy audit clear retains modal focus while buttons are disabled');
    await pressRendererKey(win,'Escape');
    assert.equal(auditClearAttempts,2,'busy audit clear must not duplicate writes');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-testid="audit-clear-confirmation"]') !== null`,true),true,'busy clear cannot dismiss its confirmation');
    releaseAuditClear();
    releaseAuditClear = null;
    await waitFor(win,`document.querySelector('[data-testid="audit-clear-confirmation"]') === null`,'successful clear closes confirmation');
    await assertFocusWithin(win,'[data-testid="audit-refresh-trigger"]','clearing the last entry focuses the surviving refresh action');
    assert.equal(mutationCalls.length,13,'eleven original writes plus two exact audit attempts');
    assert.deepEqual(mutationCalls.slice(-2).map((entry) => ({channel:entry.channel,payload:entry.payload})),[
      {channel:'v2:audit-clear',payload:{projectId:'project-created',environmentId:'env-created',pluginInstanceId:null}},
      {channel:'v2:audit-clear',payload:{projectId:'project-created',environmentId:'env-created',pluginInstanceId:null}},
    ]);
    assert.deepEqual(forbiddenCalls,[]);
    assert.deepEqual(externalRequests,[]);
    assert.deepEqual(rendererErrors,[]);
    assert.ok(readCalls.some((entry) => entry.channel === 'v2:workspace-overview'));
    assert.ok(readCalls.some((entry) => entry.channel === 'v2:runbook-read'));
    assert.ok(readCalls.some((entry) => entry.channel === 'v2:quick-question-list'));
    await assertBusinessRecoveryAndLifecycle(win,{projectId:'project-created',environmentId:'env-created'});
    assert.deepEqual(forbiddenCalls,[]);
    assert.deepEqual(externalRequests,[]);
    assert.deepEqual(rendererErrors,[]);
    if (screenshotRoot) {
      process.stdout.write(
        'Project/environment screenshots cover cancellation; subsequent isolated lifecycle cases verify deletion and recreation.\n',
      );
    }
    process.stdout.write(
      `React business smoke passed (${mutationCalls.length} exact mutation payloads)\n`,
    );
  } finally {
    releaseAuditClear?.();
    releaseQuestionSave?.();
    questionSaveHold = null;
    releaseQuestionSave = null;
    if (!win.isDestroyed()) win.destroy();
    await wait(100);
    unregisterMockApi();
  }
}

run()
  .then(async () => {
    await wait(50);
    app.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    await wait(100);
    app.exit(1);
  });
