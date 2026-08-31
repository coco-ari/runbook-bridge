const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { exercisePackagedPluginLifecycle } = require('./packaged-plugin-lifecycle.cjs');

const executable = path.resolve(
  process.argv[2] ?? path.join('dist', 'win-unpacked', 'Agent运维工作台.exe'),
);
const PROJECT_RAIL_COLLAPSED_WIDTH = 128;
const PROJECT_RAIL_EXPANDED_MIN_WIDTH = 176;
const LAYOUT_STORAGE_KEY = 'runbook-bridge:app-shell-layout:v1';
const THEME_STORAGE_KEY = 'runbook-bridge:theme-preference:v1';
const diagnosticDirectory = process.env.RUNBOOK_BRIDGE_PACKAGED_UI_DIAGNOSTIC_DIR;

function recordDiagnostic(entries, entry) {
  entries.push(entry);
  if (entries.length > 50) entries.shift();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: '127.0.0.1', port, path: pathname, timeout: 1_000 },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('timeout', () => request.destroy(new Error('request timeout')));
    request.once('error', reject);
  });
}

async function reserveDebugPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    assert.equal(typeof WebSocket, 'function', 'Node.js 22 WebSocket support is required');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Failed to connect to CDP')), { once: true });
    });
    return new CdpClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Packaged UI command timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function stopPackagedApp(running) {
  if (!running) return;
  const { child, cdp } = running;
  await cdp.call('Browser.close').catch(() => undefined);
  cdp.close();
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const started = Date.now();
  while (!hasExited() && Date.now() - started < 15_000) await delay(100);
  if (!hasExited()) {
    child.kill();
    const killedAt = Date.now();
    while (!hasExited() && Date.now() - killedAt < 5_000) await delay(100);
  }
  assert.equal(hasExited(), true, 'packaged application must exit before its profile is reused');
}

async function startPackagedApp(isolation) {
  const port = await reserveDebugPort();
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${isolation.profileRoot}`,
      '--disable-background-networking',
    ],
    {
      env: isolation.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const diagnostics = [];
  child.stdout.on('data', (chunk) => diagnostics.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (exited) {
      throw new Error(
        `Packaged application exited before renderer startup: ${Buffer.concat(diagnostics).toString('utf8')}`,
      );
    }
    try {
      const pages = await getJson(port, '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) {
        const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
        const httpRequests = [];
        const rendererDiagnostics = {console: [], exceptions: [], log: [], scripts: []};
        cdp.on('Network.requestWillBeSent', ({ request }) => {
          if (/^https?:/iu.test(request?.url ?? '')) httpRequests.push(request.url);
        });
        cdp.on('Runtime.consoleAPICalled', (event) => recordDiagnostic(rendererDiagnostics.console, {
          type: event.type,
          text: (event.args ?? []).map((argument) => String(argument.value ?? argument.description ?? '')).join(' ').slice(0, 2_000),
        }));
        cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => recordDiagnostic(rendererDiagnostics.exceptions, {
          text: String(exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? '').slice(0, 2_000),
          url: exceptionDetails?.url,
          lineNumber: exceptionDetails?.lineNumber,
        }));
        cdp.on('Log.entryAdded', ({ entry }) => recordDiagnostic(rendererDiagnostics.log, {
          level: entry?.level, source: entry?.source, text: String(entry?.text ?? '').slice(0, 2_000),
        }));
        cdp.on('Debugger.scriptParsed', (script) => {
          if (/renderer-build\/v2\/.+\.js(?:$|[?#])/u.test(script.url ?? '')) {
            recordDiagnostic(rendererDiagnostics.scripts, {url: script.url, hash: script.hash, length: script.length});
          }
        });
        await cdp.call('Network.enable');
        await cdp.call('Runtime.enable');
        await cdp.call('Log.enable');
        await cdp.call('Debugger.enable');
        const readyStarted = Date.now();
        while (Date.now() - readyStarted < 15_000) {
          const ready = await cdp.evaluate(
            "Boolean(window.aiOps?.v2 && document.querySelector('[data-shell-ready=\"true\"]'))",
          );
          if (ready) return { child, cdp, httpRequests, rendererDiagnostics };
          await delay(100);
        }
        cdp.close();
      }
    } catch {
      // Chromium exposes the debugging endpoint before preload and React finish.
    }
    await delay(100);
  }
  child.kill();
  throw new Error('Packaged React renderer did not become ready');
}

async function readProjectRail(cdp) {
  // Windows may mark the packaged window occluded even while it owns keyboard
  // focus. Capture an actual compositor frame before reading geometry, as the
  // Electron foundation smoke does; never substitute styles or layout values.
  await cdp.call('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false});
  return cdp.evaluate(`(() => {
    const rail = document.querySelector('[data-testid="project-rail"]');
    const panel = document.getElementById('project-panel');
    const resizer = document.getElementById('project-resource-resizer');
    const rect = resizer?.getBoundingClientRect();
    const panelWidth = panel?.getBoundingClientRect().width ?? 0;
    const groupWidth = ['project-panel','resource-panel','detail-panel'].reduce((sum, id) =>
      sum + (document.getElementById(id)?.getBoundingClientRect().width ?? 0), 0);
    const saved = JSON.parse(localStorage.getItem('${LAYOUT_STORAGE_KEY}') || 'null');
    const probe = window.__packagedProjectRailProbe;
    return {
      width: rail?.getBoundingClientRect().width ?? 0,
      railRight: rail?.getBoundingClientRect().right ?? 0,
      panelWidth,
      collapsed: rail?.dataset.collapsed,
      noTopToggle: Boolean(rail && !rail.querySelector('[data-project-rail-toggle], [data-testid="project-expand"], [data-testid="project-collapse"], button[aria-label="展开项目栏"], button[aria-label="折叠项目栏"]')),
      resizerRole: resizer?.getAttribute('role'),
      controls: resizer?.getAttribute('aria-controls'),
      valueNow: Number(resizer?.getAttribute('aria-valuenow')),
      valueMin: Number(resizer?.getAttribute('aria-valuemin')),
      valueMax: Number(resizer?.getAttribute('aria-valuemax')),
      panelShare: groupWidth > 0 ? panelWidth / groupWidth * 100 : null,
      disabled: resizer?.getAttribute('aria-disabled') === 'true',
      savedCollapsed: saved?.projectCollapsed ?? null,
      focused: document.hasFocus() && document.activeElement === resizer,
      sameResizer: Boolean(probe && probe.resizer === resizer && probe.resizer.isConnected),
      trustedKeys: probe?.trustedKeys ?? [],
      anchor: rect ? {left: rect.left, top: rect.top} : null,
      noPageOverflow: [document.documentElement, document.body,
        document.getElementById('root'), document.querySelector('[data-testid="react-app-shell"]')]
        .every((element) => element && element.scrollWidth <= element.clientWidth + 1),
      noRailOverflow: Boolean(rail && panel && rail.scrollWidth <= rail.clientWidth + 1
        && panel.scrollWidth <= panel.clientWidth + 1),
    };
  })()`);
}

async function nativeSearchTextBox(cdp, placeholder) {
  const remote = await cdp.call('Runtime.evaluate', {
    expression: "document.querySelector('[data-testid=\"project-search\"]')", returnByValue: false,
  });
  const objectId = remote.result?.objectId;
  if (!objectId) return null;
  try {
    const {node} = await cdp.call('DOM.describeNode', {objectId, depth: -1, pierce: true});
    const candidates = new Map();
    const visit = (entry, parent) => {
      const attributes = Object.fromEntries(Array.from({length: (entry.attributes?.length ?? 0) / 2}, (_, index) =>
        [entry.attributes[index * 2], entry.attributes[index * 2 + 1]]));
      if (entry.nodeType === 3 && entry.nodeValue === placeholder && parent) candidates.set(parent.backendNodeId, 'placeholder');
      if (attributes.contenteditable === 'true' || attributes.contenteditable === 'plaintext-only'
        || attributes.pseudo === '-webkit-inner-editor') candidates.set(entry.backendNodeId, 'editor');
      for (const child of [...(entry.children ?? []), ...(entry.shadowRoots ?? []), ...(entry.pseudoElements ?? [])]) visit(child, entry);
    };
    visit(node, null);
    const boxes = [];
    for (const [backendNodeId, source] of candidates) {
      const response = await cdp.call('DOM.getBoxModel', {backendNodeId}).catch(() => null);
      const content = response?.model?.content;
      if (!content) continue;
      const left = Math.min(content[0], content[2], content[4], content[6]);
      const right = Math.max(content[0], content[2], content[4], content[6]);
      if (right > left) boxes.push({left, right, width: right - left, source});
    }
    return boxes.sort((left, right) => left.width - right.width)[0] ?? null;
  } finally {
    await cdp.call('Runtime.releaseObject', {objectId}).catch(() => undefined);
  }
}

async function readProjectSearch(cdp) {
  await cdp.call('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false});
  const search = await cdp.evaluate(`(async () => {
    await document.fonts.ready;
    const input = document.querySelector('[data-testid="project-search"]');
    if (!(input instanceof HTMLInputElement)) return null;
    const group = input.closest('[data-slot="input-group"]');
    const icon = group?.querySelector('[data-align="inline-start"] svg');
    const rect = input.getBoundingClientRect();
    const groupRect = group?.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    const computed = getComputedStyle(input);
    const placeholderStyle = getComputedStyle(input, '::placeholder');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas font measurement is unavailable');
    context.font = placeholderStyle.font || [placeholderStyle.fontStyle, placeholderStyle.fontWeight,
      placeholderStyle.fontSize, placeholderStyle.fontFamily].join(' ');
    if ('fontKerning' in context) context.fontKerning = placeholderStyle.fontKerning;
    if ('letterSpacing' in context) context.letterSpacing = '0px';
    const letterSpacing = Number.parseFloat(placeholderStyle.letterSpacing) || 0;
    const placeholderWidth = context.measureText(input.placeholder).width + letterSpacing * Array.from(input.placeholder).length;
    const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(computed.paddingRight) || 0;
    const contentLeft = rect.left + (Number.parseFloat(computed.borderLeftWidth) || 0) + paddingLeft;
    const contentWidth = input.clientWidth - paddingLeft - paddingRight;
    const probe = window.__packagedProjectSearchProbe ??= {input, trustedInputEvents: 0};
    if (!probe.listening) {
      input.addEventListener('input', (event) => { if (event.isTrusted) probe.trustedInputEvents += 1; });
      probe.listening = true;
    }
    return {
      placeholder: input.placeholder, value: input.value, type: input.type,
      visible: rect.width > 0 && rect.height > 0 && computed.visibility !== 'hidden'
        && !input.closest('[hidden],[inert],[aria-hidden="true"]'),
      sameInput: probe.input === input && probe.input.isConnected,
      focused: document.hasFocus() && document.activeElement === input,
      trustedInputEvents: probe.trustedInputEvents,
      placeholderFont: context.font, fontSize: Number.parseFloat(computed.fontSize), letterSpacing,
      placeholderWidth, contentLeft, contentWidth,
      inputInsideGroup: Boolean(groupRect && rect.left >= groupRect.left - 1 && rect.right <= groupRect.right + 1),
      iconRight: iconRect?.right ?? null,
      iconVisible: Boolean(iconRect && iconRect.width > 0 && iconRect.height > 0),
    };
  })()`);
  if (!search) return null;
  const nativeBox = await nativeSearchTextBox(cdp, search.placeholder).catch(() => null);
  // Prefer Chromium's real editing viewport, which includes its native search
  // decorations. If an engine omits that shadow geometry, reserve 1.25em for the
  // cancel control rather than treating the whole CSS content box as text space.
  const availableWidth = nativeBox
    ? Math.min(search.contentWidth, nativeBox.width)
    : search.contentWidth - (search.type === 'search' ? search.fontSize * 1.25 : 0);
  return {...search, nativeBox, availableWidth};
}

async function assertProjectSearch(cdp, label, expectedValue = '') {
  const search = await readProjectSearch(cdp);
  assert.ok(search, `${label}: project search input is mounted`);
  assert.equal(search.visible, true, `${label}: project search input is visible`);
  assert.equal(search.sameInput, true, `${label}: expanding and collapsing preserves the same search input`);
  assert.equal(search.placeholder, '搜索项目');
  assert.equal(search.value, expectedValue, `${label}: native input value reaches React`);
  assert.equal(search.inputInsideGroup, true, `${label}: search input fits its group`);
  assert.equal(search.iconVisible, true, `${label}: search icon remains visible`);
  assert.ok(search.iconRight <= search.contentLeft + 1, `${label}: search icon does not overlap the text boundary`);
  assert.ok(search.placeholderWidth <= search.availableWidth + 1,
    `${label}: all placeholder characters fit the actual font and text viewport: ${JSON.stringify(search)}`);
  return search;
}

async function exerciseProjectSearchInput(cdp) {
  await cdp.evaluate("document.querySelector('[data-testid=\"project-search\"]')?.focus({preventScroll:true})");
  await cdp.call('Input.insertText', {text: '项目'});
  const typed = await assertProjectSearch(cdp, 'typing into the 128px project search', '项目');
  assert.equal(typed.focused, true, 'native project search input retains keyboard focus');
  assert.ok(typed.trustedInputEvents >= 1, 'project search receives trusted native input events');
  await pressProjectRailShortcut(cdp);
  await waitForProjectRail(cdp, true, 'Ctrl+B in the search input does not resize the rail');
  for (const type of ['keyDown','keyUp']) await cdp.call('Input.dispatchKeyEvent', {
    type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  });
  for (const type of ['keyDown','keyUp']) await cdp.call('Input.dispatchKeyEvent', {
    type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
  });
  const cleared = await assertProjectSearch(cdp, 'clearing the 128px project search');
  assert.ok(cleared.trustedInputEvents > typed.trustedInputEvents, 'native clearing sends another trusted input event');
  await cdp.evaluate("document.getElementById('project-resource-resizer')?.focus({preventScroll:true})");
  return cleared;
}

async function inspectPanelGeometry(cdp) {
  return cdp.evaluate(`(() => {
    const geometry = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        id: element.id, slot: element.dataset.slot, rect: rect.toJSON(),
        offsetWidth: element.offsetWidth, offsetHeight: element.offsetHeight,
        clientWidth: element.clientWidth, clientHeight: element.clientHeight,
        inlineStyle: element.getAttribute('style'),
        computed: Object.fromEntries(['display','width','height','minWidth','maxWidth','minHeight','maxHeight',
          'flex','flexBasis','flexGrow','flexShrink','overflow','zoom','transform'].map((name) => [name, computed[name]])),
      };
    };
    const panels = ['project-panel','resource-panel','detail-panel'].map((id) => document.getElementById(id));
    return {
      viewport: {innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
        visualViewport: visualViewport ? {width: visualViewport.width, height: visualViewport.height,
          scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop} : null},
      document: {visibilityState: document.visibilityState, hasFocus: document.hasFocus(), readyState: document.readyState},
      group: geometry(document.getElementById('app-shell-panels')),
      panels: panels.map((panel) => ({outer: geometry(panel), inner: geometry(panel?.firstElementChild)})),
      rail: geometry(document.querySelector('[data-testid="project-rail"]')),
      savedLayout: JSON.parse(localStorage.getItem('${LAYOUT_STORAGE_KEY}') || 'null'),
      resources: {scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
        styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href)},
    };
  })()`);
}

async function captureFailureDiagnostics(running) {
  const beforePaint = await inspectPanelGeometry(running.cdp);
  const scheduling = await running.cdp.evaluate(`new Promise((resolve) => {
    const started = performance.now();
    const observations = [];
    let frames = 0;
    let frame;
    const tick = () => { frames += 1; frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) observations.push({id: entry.target.id,
        contentWidth: entry.contentRect.width, offsetWidth: entry.target.offsetWidth,
        borderBoxWidth: entry.borderBoxSize[0]?.inlineSize ?? null});
    });
    for (const id of ['app-shell-panels','project-panel','resource-panel','detail-panel']) {
      const element = document.getElementById(id);
      if (element) observer.observe(element, {box: 'border-box'});
    }
    setTimeout(() => {
      observer.disconnect(); cancelAnimationFrame(frame);
      resolve({elapsedMs: performance.now() - started, frames, observations});
    }, 750);
  })`);
  const screenshot = await running.cdp.call('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false});
  const afterPaint = await inspectPanelGeometry(running.cdp);
  const asarPath = path.join(path.dirname(executable), 'resources', 'app.asar');
  const asarHash = createHash('sha256').update(await fsp.readFile(asarPath)).digest('hex');
  const diagnostics = {beforePaint, scheduling, afterPaint, asarSha256: asarHash, renderer: running.rendererDiagnostics};
  if (diagnosticDirectory) {
    const directory = path.resolve(diagnosticDirectory);
    const repositoryRoot = path.resolve(__dirname, '..');
    const relative = path.relative(repositoryRoot, directory);
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'packaged UI diagnostics must stay outside the repository');
    await fsp.mkdir(directory, {recursive: true});
    await fsp.writeFile(path.join(directory, 'packaged-ui-failure.png'), Buffer.from(screenshot.data, 'base64'));
    await fsp.writeFile(path.join(directory, 'packaged-ui-failure.json'), JSON.stringify(diagnostics, null, 2) + '\n');
  }
  process.stderr.write(`Packaged UI failure diagnostics: ${JSON.stringify(diagnostics)}\n`);
}

async function waitForProjectRail(cdp, collapsed, label, { persisted = true } = {}) {
  const started = Date.now();
  let snapshot;
  while (Date.now() - started < 10_000) {
    snapshot = await readProjectRail(cdp);
    const correctWidth = collapsed
      ? Math.abs(snapshot.width - PROJECT_RAIL_COLLAPSED_WIDTH) <= 1
      : snapshot.width >= PROJECT_RAIL_EXPANDED_MIN_WIDTH - 1;
    if (
      correctWidth
      && Math.abs(snapshot.panelWidth - snapshot.width) <= 1
      && snapshot.collapsed === String(collapsed)
      && snapshot.panelShare !== null
      && Math.abs(snapshot.valueNow - snapshot.panelShare) <= 0.2
      && (!persisted || snapshot.savedCollapsed === collapsed)
    ) {
      assert.equal(snapshot.noTopToggle, true, `${label}: no top project collapse button is rendered`);
      assert.equal(snapshot.resizerRole, 'separator', `${label}: project resizer retains its native separator role`);
      assert.equal(snapshot.controls, 'project-panel', `${label}: project resizer controls the first panel`);
      assert.equal(snapshot.disabled, false, `${label}: project resizer remains available`);
      assert.ok(snapshot.valueMin <= snapshot.valueNow + 0.2 && snapshot.valueMax >= snapshot.valueNow - 0.2,
        `${label}: separator ARIA range contains the actual panel width`);
      assert.equal(snapshot.noPageOverflow, true, `${label}: page has no horizontal overflow`);
      assert.equal(snapshot.noRailOverflow, true, `${label}: project rail has no horizontal overflow`);
      if (persisted) assert.equal(snapshot.savedCollapsed, collapsed, `${label}: collapse intent is persisted`);
      return snapshot;
    }
    await delay(100);
  }
  throw new Error(`${label}: project rail did not reach its expected geometry: ${JSON.stringify(snapshot)}`);
}

async function focusProjectRailResizer(cdp) {
  await cdp.call('Page.bringToFront');
  await cdp.evaluate(`(() => {
    const resizer = document.getElementById('project-resource-resizer');
    if (!(resizer instanceof HTMLElement) || resizer.getAttribute('role') !== 'separator') throw new Error('project rail resizer is missing');
    const probe = {resizer, trustedKeys: []};
    window.__packagedProjectRailProbe = probe;
    resizer.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'b') probe.trustedKeys.push('Control+B');
      else if (event.key === 'Enter') probe.trustedKeys.push('Enter');
    });
    resizer.focus({preventScroll: true});
  })()`);
  const snapshot = await readProjectRail(cdp);
  assert.equal(snapshot.focused, true, 'packaged project resizer receives native keyboard focus');
  return snapshot.anchor;
}

async function pressProjectRailShortcut(cdp) {
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66,
    nativeVirtualKeyCode: 66, modifiers: 2,
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66,
    nativeVirtualKeyCode: 66, modifiers: 2,
  });
}

async function pressProjectRailResizer(cdp) {
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

function assertProjectRailFocus(snapshot, anchor, trustedKeys, label) {
  assert.equal(snapshot.sameResizer, true, `${label}: the same project resizer stays mounted`);
  assert.equal(snapshot.focused, true, `${label}: project resizer retains keyboard focus`);
  assert.deepEqual(snapshot.trustedKeys, trustedKeys, `${label}: native keyboard actions are delivered exactly once`);
  assert.ok(snapshot.anchor && anchor, `${label}: resizer anchor is present`);
  assert.ok(Math.abs(snapshot.anchor.left - snapshot.railRight) <= 1, `${label}: resizer follows the actual rail edge`);
  assert.ok(Math.abs(snapshot.anchor.top - anchor.top) <= 1, `${label}: resizer vertical anchor stays fixed`);
}

async function waitForThemeUi(cdp, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(80);
  }
  throw new Error(`Packaged theme UI timed out: ${label}`);
}

async function clickThemeControl(cdp, testId) {
  await cdp.call('Page.bringToFront');
  await cdp.call('Page.captureScreenshot', {format:'png',fromSurface:true,captureBeyondViewport:false});
  await waitForThemeUi(cdp, `(() => {
    const target = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.left < 0
      || rect.bottom > innerHeight+1 || rect.right > innerWidth+1) return false;
    const hit = document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return Boolean(hit && target.contains(hit));
  })()`, `${testId} finishes positioning before native input`);
  const point = await cdp.evaluate(`(() => {
    const target = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]');
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  assert.ok(point, `packaged ${testId} is visible`);
  await cdp.call('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
  await cdp.call('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...point});
  await cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, ...point});
}

async function pressThemeKey(cdp, key, code, keyCode) {
  for (const type of ['keyDown','keyUp']) {
    await cdp.call('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode:keyCode, nativeVirtualKeyCode:keyCode,
      ...(type === 'keyDown' && key === 'Enter' ? {text:'\r',unmodifiedText:'\r'} : {}),
    });
  }
}

async function selectThemePreference(cdp, preference) {
  await clickThemeControl(cdp, 'theme-menu-trigger');
  await waitForThemeUi(cdp, `document.querySelector('[data-testid="theme-menu"]')?.contains(document.activeElement) === true`, 'menu opens with native focus');
  await cdp.call('Page.captureScreenshot', {format:'png',fromSurface:true,captureBeyondViewport:false});
  await waitForThemeUi(cdp, `(() => {
    const rect = document.querySelector('[data-testid="theme-menu"]')?.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= innerWidth+1 && rect.bottom <= innerHeight+1);
  })()`, 'menu finishes positioning before geometry assertions');
  const radio = await cdp.evaluate(`(() => {
    const option = document.querySelector('[data-testid="theme-option-${preference}"]');
    const menu = document.querySelector('[data-testid="theme-menu"]');
    const rect = menu?.getBoundingClientRect();
    const options = [...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])];
    return {role:option?.getAttribute('role'),options:options.length,
      menuFits:Boolean(rect && rect.left >= 0 && rect.right <= innerWidth+1 && rect.top >= 0 && rect.bottom <= innerHeight+1),
      optionsFit:options.every((item) => item.scrollWidth <= item.clientWidth+1)};
  })()`);
  assert.deepEqual(radio, {role:'menuitemradio',options:3,menuFits:true,optionsFit:true}, 'packaged theme radio options remain readable and inside the viewport');
  await clickThemeControl(cdp, `theme-option-${preference}`);
  await waitForThemeUi(cdp, `document.querySelector('[data-testid="theme-menu"]') === null
    && document.activeElement === document.querySelector('[data-testid="theme-menu-trigger"]')`, 'selection restores theme trigger focus');
}

async function emulateSystemTheme(cdp, theme) {
  await cdp.call('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:theme}]});
  await waitForThemeUi(cdp, `matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`, 'system color-scheme media changes');
}

async function assertThemeState(cdp, preference, actual, label, {persisted = true} = {}) {
  // The isolated empty workspace's confirmation entry displays a real toast
  // without mutating data or introducing a special packaged testing API.
  await clickThemeControl(cdp, 'confirmation-center');
  await waitForThemeUi(cdp, `(() => {
    const toasters = [...document.querySelectorAll('[data-sonner-toaster]')];
    return document.documentElement.dataset.themePreference === '${preference}'
      && document.documentElement.dataset.theme === '${actual}'
      && (!${persisted} || localStorage.getItem('${THEME_STORAGE_KEY}') === '${preference}')
      && toasters.length > 0 && toasters.every((toaster) => toaster.dataset.sonnerTheme === '${actual}');
  })()`, label);
}

async function assertThemeControlGeometry(cdp, compact) {
  const snapshot = await cdp.evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="theme-menu-trigger"]');
    const label = trigger?.querySelector('span');
    const rail = document.querySelector('[data-testid="project-rail"]');
    const footer = document.querySelector('[data-testid="add-project-footer"]');
    const rect = trigger?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    return {width:railRect?.width,visible:Boolean(rect && rect.width > 0 && rect.height > 0 && railRect
      && rect.left >= railRect.left && rect.right <= railRect.right+1 && rect.bottom <= innerHeight
      && hit && trigger.contains(hit) && !trigger.closest('[inert],[aria-hidden="true"]')),
      aboveFooter:Boolean(rect && footer && rect.bottom <= footer.getBoundingClientRect().top+1),
      labelFits:Boolean(label && label.clientWidth > 0 && label.scrollWidth <= label.clientWidth+1),
      noOverflow:Boolean(rail && rail.scrollWidth <= rail.clientWidth+1
        && document.documentElement.scrollWidth <= document.documentElement.clientWidth+1)};
  })()`);
  assert.equal(snapshot.visible, true, 'packaged theme entry stays visible and reachable');
  assert.equal(snapshot.aboveFooter, true, 'packaged theme entry stays above the project footer');
  assert.equal(snapshot.labelFits, true, 'packaged theme mode label remains fully readable without truncation');
  assert.equal(snapshot.noOverflow, true, 'packaged theme entry introduces no horizontal overflow');
  if (compact) assert.ok(Math.abs(snapshot.width-128) <= 1, 'packaged theme entry fits the actual 128px rail');
}

async function exerciseThemePreferences(cdp) {
  await assertThemeControlGeometry(cdp, false);
  await emulateSystemTheme(cdp, 'light');
  await assertThemeState(cdp, 'system', 'light', 'default system theme and Toaster', {persisted:false});
  await selectThemePreference(cdp, 'dark');
  await assertThemeState(cdp, 'dark', 'dark', 'manual dark overrides light system and Toaster');
  await emulateSystemTheme(cdp, 'dark');
  await selectThemePreference(cdp, 'light');
  await assertThemeState(cdp, 'light', 'light', 'manual light overrides dark system and Toaster');
  await emulateSystemTheme(cdp, 'light');
  await emulateSystemTheme(cdp, 'dark');
  await assertThemeState(cdp, 'light', 'light', 'system changes preserve the manual preference');
  await selectThemePreference(cdp, 'system');
  await assertThemeState(cdp, 'system', 'dark', 'return to system follows current dark media');
  await emulateSystemTheme(cdp, 'light');
  await assertThemeState(cdp, 'system', 'light', 'system preference and Toaster react live');
  await clickThemeControl(cdp, 'theme-menu-trigger');
  await waitForThemeUi(cdp, `document.querySelector('[data-testid="theme-menu"]')?.contains(document.activeElement) === true`, 'theme menu opens before Escape');
  await pressThemeKey(cdp, 'Escape', 'Escape', 27);
  await waitForThemeUi(cdp, `document.querySelector('[data-testid="theme-menu"]') === null
    && document.activeElement === document.querySelector('[data-testid="theme-menu-trigger"]')`, 'Escape restores theme trigger focus');
  assert.equal(await cdp.evaluate(`localStorage.getItem('${THEME_STORAGE_KEY}')`), 'system', 'Escape leaves the persisted preference unchanged');
  process.stdout.write('Packaged theme controls passed: manual light/dark, live system changes, visible matching Toaster, native menu focus\n');
}

async function main() {
  await fsp.access(executable);
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runbook-bridge-packaged-ui-'));
  const localAppData = path.join(temporaryRoot, 'LocalAppData');
  const appData = path.join(temporaryRoot, 'AppData');
  const dataRoot = path.join(localAppData, 'AIOpsTool');
  const profileRoot = path.join(temporaryRoot, 'ElectronProfile');
  const isolation = {
    profileRoot,
    env: {
      ...process.env,
      AI_OPS_DATA_DIR: dataRoot,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
    },
  };
  let running = null;
  try {
    await Promise.all([
      fsp.mkdir(dataRoot, { recursive: true }),
      fsp.mkdir(profileRoot, { recursive: true }),
    ]);
    running = await startPackagedApp(isolation);
    await delay(250);
    const inspection = await running.cdp.evaluate(`(async()=>{
      const overview=await window.aiOps.v2.workspaceOverview();
      const csp=document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content||'';
      const resourceUrls=performance.getEntriesByType('resource').map((entry)=>entry.name);
      return {
        href:location.href,
        title:document.title,
        shellReady:Boolean(document.querySelector('[data-shell-ready="true"]')),
        rootReady:Boolean(document.querySelector('#root')),
        skipTarget:document.querySelector('a[href="#detail-main"]')?.getAttribute('href')||null,
        noPageOverflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth,
        overviewOk:overview?.ok===true,
        projectCount:Array.isArray(overview?.data)?overview.data.length:-1,
        apiCount:Object.keys(window.aiOps.v2).length,
        nodeRequireType:typeof require,
        nodeProcessType:typeof process,
        csp,
        externalResources:resourceUrls.filter((url)=>/^https?:/iu.test(url)),
      };
    })()`);
    assert.equal(inspection.shellReady, true);
    assert.equal(inspection.rootReady, true);
    assert.equal(inspection.skipTarget, '#detail-main');
    assert.equal(inspection.noPageOverflow, true);
    assert.equal(inspection.overviewOk, true);
    assert.equal(inspection.projectCount, 0);
    assert.equal(inspection.apiCount, 58);
    assert.equal(inspection.nodeRequireType, 'undefined');
    assert.equal(inspection.nodeProcessType, 'undefined');
    assert.match(inspection.href, /app\.asar\/renderer-build\/v2\/index\.html/iu);
    assert.match(inspection.csp, /default-src 'self'/u);
    assert.match(inspection.csp, /connect-src 'none'/u);
    assert.doesNotMatch(inspection.csp, /script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
    assert.deepEqual(inspection.externalResources, []);
    assert.deepEqual(running.httpRequests, []);
    await exerciseThemePreferences(running.cdp);
    await waitForThemeUi(running.cdp, `document.querySelector('[data-sonner-toast]') === null`, 'theme toasts dismiss before rail geometry');

    // Exercise the installed renderer through native input without creating any
    // projects, replacing preload, or writing layout state directly.
    const expandedBefore = await waitForProjectRail(running.cdp, false, 'initial expanded rail', { persisted: false });
    await assertProjectSearch(running.cdp, 'initial expanded project search');
    const anchor = await focusProjectRailResizer(running.cdp);
    await pressProjectRailShortcut(running.cdp);
    const collapsed = await waitForProjectRail(running.cdp, true, 'collapse to 128px');
    assertProjectRailFocus(collapsed, anchor, ['Control+B'], 'collapse to 128px');
    await assertThemeControlGeometry(running.cdp, true);
    const compactSearch = await assertProjectSearch(running.cdp, '128px project search placeholder');
    await exerciseProjectSearchInput(running.cdp);
    await pressProjectRailResizer(running.cdp);
    const expandedAfter = await waitForProjectRail(running.cdp, false, 'expand to at least 176px');
    assertProjectRailFocus(expandedAfter, anchor, ['Control+B','Enter'], 'expand to at least 176px');
    await assertProjectSearch(running.cdp, 'expanded project search preserves its input');
    await pressProjectRailShortcut(running.cdp);
    const beforeRestart = await waitForProjectRail(running.cdp, true, 'persist collapsed rail before restart');
    assertProjectRailFocus(beforeRestart, anchor, ['Control+B','Enter','Control+B'], 'persist collapsed rail before restart');
    await assertProjectSearch(running.cdp, 'collapsed project search preserves its input');
    assert.deepEqual(running.httpRequests, []);
    await selectThemePreference(running.cdp, 'dark');
    await assertThemeState(running.cdp, 'dark', 'dark', 'manual dark saved through the menu before process restart');

    // A real process restart with the same isolated profile verifies that the
    // persisted intent and the packaged panel geometry agree on startup.
    await stopPackagedApp(running);
    running = null;
    running = await startPackagedApp(isolation);
    await emulateSystemTheme(running.cdp, 'light');
    await assertThemeState(running.cdp, 'dark', 'dark', 'manual dark and Toaster survive a real restart on a light system');
    const afterRestart = await waitForProjectRail(running.cdp, true, 'restore 128px rail after process restart');
    assert.equal(afterRestart.savedCollapsed, true, 'collapsed rail persists across a packaged process restart');
    await assertThemeControlGeometry(running.cdp, true);
    await assertProjectSearch(running.cdp, 'restored 128px project search');
    const restartAnchor = await focusProjectRailResizer(running.cdp);
    await pressProjectRailResizer(running.cdp);
    const expandedAfterRestart = await waitForProjectRail(running.cdp, false, 'expand restored rail');
    assertProjectRailFocus(expandedAfterRestart, restartAnchor, ['Enter'], 'expand restored rail');
    await assertProjectSearch(running.cdp, 'restored project search stays mounted after expansion');
    const restartedWorkspace = await running.cdp.evaluate(`(async () => {
      const overview = await window.aiOps.v2.workspaceOverview();
      return {ok: overview?.ok === true, projectCount: Array.isArray(overview?.data) ? overview.data.length : -1,
        apiCount: Object.keys(window.aiOps.v2).length};
    })()`);
    assert.deepEqual(restartedWorkspace, {ok: true, projectCount: 0, apiCount: 58});
    assert.deepEqual(running.httpRequests, []);
    await selectThemePreference(running.cdp, 'system');
    await emulateSystemTheme(running.cdp, 'dark');
    await assertThemeState(running.cdp, 'system', 'dark', 'system mode reacts after restarting a manual preference');
    await emulateSystemTheme(running.cdp, 'light');
    await assertThemeState(running.cdp, 'system', 'light', 'Toaster tracks the restored live system preference');
    await waitForThemeUi(running.cdp, `document.querySelector('[data-sonner-toast]') === null`, 'theme toasts dismiss before packaged plugin lifecycle');
    process.stdout.write('Packaged theme persistence passed: manual dark survives the real process restart; system tracking resumes after explicit selection\n');
    const pluginLifecycle = await exercisePackagedPluginLifecycle(running.cdp, dataRoot);
    assert.deepEqual(running.httpRequests, []);
    process.stdout.write(`Packaged plugin lifecycle passed: ${JSON.stringify(pluginLifecycle)}\n`);
    process.stdout.write(`Packaged project rail geometry: ${JSON.stringify({
      expandedBefore: expandedBefore.width, collapsed: collapsed.width,
      expandedAfter: expandedAfter.width, restoredAfterRestart: afterRestart.width,
      expandedAfterRestart: expandedAfterRestart.width,
      search: {fontSize: compactSearch.fontSize, placeholderWidth: compactSearch.placeholderWidth,
        availableWidth: compactSearch.availableWidth, nativeTextBox: compactSearch.nativeBox?.source ?? 'conservative-cancel-budget'},
    })}\n`);
    process.stdout.write(
      `Packaged React UI smoke passed (58 preload APIs, empty isolated workspace, 128px rail, restart persistence, no external requests): ${executable}\n`,
    );
  } catch (error) {
    if (running) {
      await captureFailureDiagnostics(running).catch((diagnosticError) => {
        process.stderr.write(`Could not capture packaged UI diagnostics: ${diagnosticError.message}\n`);
      });
    }
    throw error;
  } finally {
    await stopPackagedApp(running).catch(() => undefined);
    const temporaryBase = path.resolve(os.tmpdir()) + path.sep;
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (
      resolvedTemporaryRoot.startsWith(temporaryBase)
      && path.basename(resolvedTemporaryRoot).startsWith('runbook-bridge-packaged-ui-')
      && fs.existsSync(resolvedTemporaryRoot)
    ) {
      await fsp.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
