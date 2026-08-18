const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ID = 'upgrade-regression';
const ENVIRONMENT_ID = 'production';
const PLUGINS = Object.freeze([
  {
    pluginType: 'server',
    pluginInstanceId: 'legacy-server',
    displayName: 'Legacy server',
    target: { host: '127.0.0.1', port: 65534, addressFamily: 'ipv4Only' },
    auth: { type: 'password', username: 'legacy-root' },
    uplink: { type: 'direct' },
  },
  {
    pluginType: 'mysql',
    pluginInstanceId: 'legacy-mysql',
    displayName: 'Legacy MySQL',
    target: { host: '127.0.0.1', port: 65533, database: 'legacy_app', addressFamily: 'ipv4Only' },
    auth: { username: 'legacy-reader' },
    transport: { kind: 'direct' },
    tls: { mode: 'disabled' },
  },
  {
    pluginType: 'redis',
    pluginInstanceId: 'legacy-redis',
    displayName: 'Legacy Redis',
    target: { host: '127.0.0.1', port: 65532, db: 0, addressFamily: 'ipv4Only' },
    auth: { username: 'legacy-reader' },
    transport: { kind: 'direct' },
    tls: { mode: 'disabled' },
  },
]);
const PASSWORDS = Object.freeze({
  'legacy-server': 'install-regression-server-password',
  'legacy-mysql': 'install-regression-mysql-password',
  'legacy-redis': 'install-regression-redis-password',
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runProcess(command, args, { env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out: ${path.basename(command)}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(output).toString('utf8').trim();
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} exited with ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForFile(file, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function isolatedEnvironment(root) {
  const localAppData = path.join(root, 'LocalAppData');
  const appData = path.join(root, 'AppData');
  const dataRoot = path.join(localAppData, 'AIOpsTool');
  const profileRoot = path.join(root, 'ElectronProfile');
  return {
    dataRoot,
    profileRoot,
    env: {
      ...process.env,
      AI_OPS_DATA_DIR: dataRoot,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
    },
  };
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, timeout: 1_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
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
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    assert.equal(typeof WebSocket, 'function', 'This regression requires Node.js WebSocket support.');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Failed to connect to CDP')), { once: true });
    });
    return new CdpClient(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

async function startInstalledApp(executable, isolation) {
  const port = await reserveDebugPort();
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${isolation.profileRoot}`,
  ], {
    env: isolation.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics = [];
  child.stdout.on('data', (chunk) => diagnostics.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  let exited = false;
  child.once('exit', () => { exited = true; });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (exited) {
      throw new Error(`Installed application exited before startup: ${Buffer.concat(diagnostics).toString('utf8')}`);
    }
    try {
      const pages = await getJson(port, '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) {
        const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
        const readyStarted = Date.now();
        while (Date.now() - readyStarted < 15_000) {
          const ready = await cdp.evaluate("Boolean(window.aiOps?.v2 && document.querySelector('#app'))");
          if (ready) return { child, cdp };
          await delay(100);
        }
        cdp.close();
      }
    } catch {
      // Chromium's debugging endpoint starts before the renderer preload.
    }
    await delay(100);
  }
  child.kill();
  throw new Error('Installed application did not expose a ready renderer.');
}

async function stopInstalledApp(appProcess) {
  const { child, cdp } = appProcess;
  await cdp.call('Browser.close').catch(() => undefined);
  cdp.close();
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < 15_000) await delay(100);
  if (child.exitCode === null) child.kill();
}

function rendererInspectionExpression(expectedPluginCount) {
  const scope = JSON.stringify({ projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID });
  const passwords = JSON.stringify(PASSWORDS);
  return `(async()=>{
    const api=window.aiOps.v2;
    const take=(result)=>{if(!result?.ok)throw new Error(result?.error?.code||'IPC_FAILED');return result.data;};
    const scope=${scope};
    const expected=${passwords};
    const overview=take(await api.workspaceOverview());
    const plugins=take(await api.listPlugins(scope));
    const status=take(await api.environmentStatus(scope));
    const checks=[];
    for(const pluginInstanceId of Object.keys(expected)){
      const credential=take(await api.credentialStatus({...scope,pluginInstanceId}));
      const revealed=take(await api.revealCredential({...scope,pluginInstanceId,field:'password'}));
      checks.push(credential.saved===true&&credential.fields.primary===true&&revealed.value===expected[pluginInstanceId]);
    }
    return {
      projectFound:overview.some(project=>project.projectId===scope.projectId),
      pluginCount:plugins.length,
      expectedPluginCount:${Number(expectedPluginCount)},
      credentialsReadable:checks.every(Boolean),
      desiredConnected:Boolean(status.desiredConnected),
      connectedCount:Number(status.connectedCount||0),
      connectedPlugins:Object.values(status.plugins||{}).filter(plugin=>plugin.phase==='connected').length,
    };
  })()`;
}

async function inspectInstalledRenderer(cdp, expectedPluginCount) {
  const result = await cdp.evaluate(rendererInspectionExpression(expectedPluginCount));
  assert.equal(result.projectFound, true);
  assert.equal(result.pluginCount, result.expectedPluginCount);
  assert.equal(result.credentialsReadable, true);
  assert.equal(result.desiredConnected, false);
  assert.equal(result.connectedCount, 0);
  assert.equal(result.connectedPlugins, 0);
  return result;
}

async function seedInstalledRenderer(cdp) {
  const result = await cdp.evaluate(`(async()=>{
    const api=window.aiOps.v2;
    const take=(value)=>{if(!value?.ok)throw new Error(value?.error?.code||'IPC_FAILED');return value.data;};
    const plugins=${JSON.stringify(PLUGINS)};
    const passwords=${JSON.stringify(PASSWORDS)};
    const project=take(await api.createProject({
      projectId:'${PROJECT_ID}',name:'Upgrade regression project',environmentId:'${ENVIRONMENT_ID}',
      environmentName:'Production',runbook:'# Upgrade regression\\n\\nPre-existing project data.\\n'
    }));
    for(const input of plugins){
      const plugin=take(await api.createPlugin({
        projectId:'${PROJECT_ID}',environmentId:'${ENVIRONMENT_ID}',input,
        secrets:{password:passwords[input.pluginInstanceId]}
      }));
      if(plugin.configState!=='ready')throw new Error('PLUGIN_NOT_READY');
    }
    return {projectId:project.projectId,createdPlugins:plugins.length};
  })()`);
  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.createdPlugins, PLUGINS.length);
}

async function exerciseFormalConnection(cdp) {
  const result = await cdp.evaluate(`(async()=>{
    const api=window.aiOps.v2;
    const take=(value)=>{if(!value?.ok)throw new Error(value?.error?.code||'IPC_FAILED');return value.data;};
    const scope={projectId:'${PROJECT_ID}',environmentId:'${ENVIRONMENT_ID}',pluginInstanceId:'legacy-server'};
    const attempted=take(await api.requestConnectionIntent({...scope,requestId:'install-regression-connect',planId:'install-regression-plan',intent:'connect',source:'install-regression'}));
    const afterAttempt=take(await api.environmentStatus(scope));
    take(await api.requestConnectionIntent({...scope,requestId:'install-regression-disconnect',intent:'disconnect',source:'install-regression'}));
    const afterDisconnect=take(await api.environmentStatus(scope));
    return {
      attemptOutcome:attempted.outcome,
      connectedAfterAttempt:Object.values(afterAttempt.plugins||{}).some(plugin=>plugin.phase==='connected'),
      desiredAfterDisconnect:Boolean(afterDisconnect.desiredConnected),
      connectedAfterDisconnect:Object.values(afterDisconnect.plugins||{}).some(plugin=>plugin.phase==='connected'),
    };
  })()`);
  assert.equal(result.connectedAfterAttempt, false, 'closed regression endpoint must not connect');
  assert.equal(result.desiredAfterDisconnect, false);
  assert.equal(result.connectedAfterDisconnect, false);
  return result;
}

function structuredResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text ?? '{}');
}

async function exerciseInstalledMcp(executable, isolation) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const mcpEntrypoint = path.join(path.dirname(executable), 'resources', 'app.asar', 'src', 'mcp-v2.mjs');
  const transport = new StdioClientTransport({
    command: executable,
    args: [mcpEntrypoint],
    env: { ...isolation.env, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'installed-upgrade-regression', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = structuredResult(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.ok(listed.projects.some((project) => project.projectId === PROJECT_ID));
    const opened = structuredResult(await client.callTool({
      name: 'open_environment',
      arguments: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
    }));
    assert.equal(opened.connection.desiredConnected, false);
    assert.equal(opened.connection.connectedCount, 0);
    const added = structuredResult(await client.callTool({
      name: 'add_plugin',
      arguments: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        contextToken: opened.contextToken,
        pluginType: 'redis',
        displayName: 'Agent added disconnected draft',
      },
    }));
    assert.equal(added.connection, 'disconnected');
    assert.equal(added.plugin.configState, 'draft');
    return { listed: true, opened: true, addedPluginInstanceId: added.plugin.pluginInstanceId };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function assertFilesUnchanged(files) {
  for (const [file, expected] of files) assert.deepEqual(await fsp.readFile(file), expected, file);
}

async function install(installer, installDir, env) {
  await runProcess(installer, ['/S', '--no-desktop-shortcut', `/D=${installDir}`], { env, timeoutMs: 180_000 });
  const executable = path.join(installDir, 'Agent\u8fd0\u7ef4\u5de5\u4f5c\u53f0.exe');
  await waitForFile(executable);
  return executable;
}

async function uninstall(installDir, env) {
  const names = await fsp.readdir(installDir);
  const uninstallerName = names.find((name) => /^Uninstall.*\.exe$/i.test(name));
  assert.ok(uninstallerName, 'NSIS uninstaller was not installed');
  await runProcess(path.join(installDir, uninstallerName), ['/S'], { env, timeoutMs: 120_000 });
  const started = Date.now();
  while (fs.existsSync(installDir) && Date.now() - started < 30_000) await delay(100);
}

async function orchestrate() {
  const root = path.resolve(__dirname, '..');
  const installer = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'Agent\u8fd0\u7ef4\u5de5\u4f5c\u53f0 Setup 1.0.37.exe'));
  await fsp.access(installer);
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-ops-install-regression-'));
  const isolation = isolatedEnvironment(temporaryRoot);
  const installDir = path.join(temporaryRoot, 'InstalledApp');
  await Promise.all([
    fsp.mkdir(isolation.dataRoot, { recursive: true }),
    fsp.mkdir(isolation.profileRoot, { recursive: true }),
    fsp.mkdir(path.dirname(installDir), { recursive: true }),
  ]);
  let installedApp = null;
  try {
    const executable = await install(installer, installDir, isolation.env);
    installedApp = await startInstalledApp(executable, isolation);
    await seedInstalledRenderer(installedApp.cdp);
    await inspectInstalledRenderer(installedApp.cdp, 3);
    await stopInstalledApp(installedApp);
    installedApp = null;

    const vaultFiles = [
      path.join(isolation.dataRoot, 'credentials', 'plugins.enc.json'),
      path.join(isolation.dataRoot, 'credentials', 'plugins.enc.backup.json'),
    ];
    const pluginFiles = PLUGINS.map((plugin) => path.join(
      isolation.dataRoot,
      'projects',
      PROJECT_ID,
      'environments',
      ENVIRONMENT_ID,
      'plugins',
      `${plugin.pluginInstanceId}.yaml`,
    ));
    const protectedFiles = new Map();
    for (const file of [...vaultFiles, ...pluginFiles]) protectedFiles.set(file, await fsp.readFile(file));
    await assertFilesUnchanged(protectedFiles);

    const upgradedExecutable = await install(installer, installDir, isolation.env);
    assert.equal(upgradedExecutable, executable);
    installedApp = await startInstalledApp(upgradedExecutable, isolation);
    await inspectInstalledRenderer(installedApp.cdp, 3);
    const connection = await exerciseFormalConnection(installedApp.cdp);
    const agent = await exerciseInstalledMcp(upgradedExecutable, isolation);
    await inspectInstalledRenderer(installedApp.cdp, 4);
    await stopInstalledApp(installedApp);
    installedApp = null;
    await assertFilesUnchanged(protectedFiles);

    await uninstall(installDir, isolation.env);
    assert.equal(fs.existsSync(isolation.dataRoot), true, 'uninstall removed isolated AppData');
    await assertFilesUnchanged(protectedFiles);
    const result = {
      installedTwice: true,
      guiCredentialsVerified: 3,
      primaryAndBackupVaultPreserved: true,
      originalPluginYamlPreserved: pluginFiles.length,
      formalConnectionOutcome: connection.attemptOutcome,
      agentListProjects: agent.listed,
      agentOpenEnvironment: agent.opened,
      agentAddedDisconnectedPlugin: true,
      appDataPreservedAfterUninstall: true,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (installedApp) await stopInstalledApp(installedApp).catch(() => undefined);
    const keep = process.env.AI_OPS_KEEP_INSTALL_REGRESSION === '1';
    const temporaryBase = path.resolve(os.tmpdir()) + path.sep;
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (!keep && resolvedTemporaryRoot.startsWith(temporaryBase)
      && path.basename(resolvedTemporaryRoot).startsWith('ai-ops-install-regression-')) {
      await fsp.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    } else if (keep) {
      process.stderr.write(`Preserved regression directory: ${resolvedTemporaryRoot}\n`);
    }
  }
}

orchestrate().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
