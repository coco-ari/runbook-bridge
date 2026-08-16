import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { ProjectStore } from './project-store.mjs';
import { BrokerServer } from './broker-server.mjs';
import { rotateBrokerToken } from './broker-auth.mjs';
import { CredentialStore } from './credential-store.mjs';
import { defaultDataRoot } from './paths.mjs';
import { WorkspaceStore } from './workspace-store.mjs';
import { PluginCredentialVault } from './plugin-credential-vault.mjs';
import { AddressResolver, WindowsVpnGuard, RouteManager } from './route-manager.mjs';
import { ServerPluginRuntime } from './server-plugin-runtime.mjs';
import { MysqlPluginRuntime } from './mysql-plugin-runtime.mjs';
import { RedisPluginRuntime } from './redis-plugin-runtime.mjs';
import { PluginManager } from './plugin-manager.mjs';
import { EnvironmentConnectionManager } from './environment-connection-manager.mjs';
import { ServerOperations } from './server-operations.mjs';
import { EnvironmentContextManager } from './context-manager.mjs';
import { ConfirmationManager } from './confirmation-manager.mjs';
import { V2Service } from './v2-service.mjs';
import { registerV2Ipc } from './ipc-v2.mjs';
import { NetworkChangeWatcher } from './network-change-watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = defaultDataRoot();
const store = new ProjectStore(dataRoot);
let brokerServer;
let credentialStore;
let mainWindow;
let v2;

app.setName('AI 运维工具');
app.disableHardwareAcceleration();

function createWindow() {
  const screenshotPath = process.env.AI_OPS_SCREENSHOT_PATH;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'AI 运维工具',
    backgroundColor: '#101115',
    show: !screenshotPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'v2', 'index.html'));
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const screenshotDialog = process.env.AI_OPS_SCREENSHOT_DIALOG ?? '0';
      await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
          if (document.querySelector('#app') && window.aiOps?.v2) resolve(true);
          else if (attempts++ > 120) resolve(false);
          else setTimeout(check, 50);
        };
        check();
      })`);
      if (screenshotDialog === 'project') await mainWindow.webContents.executeJavaScript("document.querySelector('#createProjectButton').click()");
      if (screenshotDialog === 'environment') await mainWindow.webContents.executeJavaScript("document.querySelector('#manageEnvironments')?.click()");
      if (screenshotDialog === 'plugin') await mainWindow.webContents.executeJavaScript("document.querySelector('#addPlugin')?.click()");
      await new Promise((resolve) => setTimeout(resolve, 350));
      const image = await mainWindow.webContents.capturePage();
      await fs.writeFile(screenshotPath, image.toPNG());
      app.quit();
    });
  }
}

if (process.argv.includes('--mcp')) {
  // Electron's Windows GUI process does not consume redirected stdin reliably.
  // Run the MCP entrypoint in Electron's Node mode and inherit the original pipes.
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-v2.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('exit', (code) => process.exit(code ?? 1));
  child.once('error', () => process.exit(1));
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    app.whenReady()
      .then(async () => {
        await store.init();
        const { safeStorage } = await import('electron');
        credentialStore = new CredentialStore(store, safeStorage);
        const workspaceStore = new WorkspaceStore(dataRoot, { legacyStore: store });
        await workspaceStore.init({ migrateLegacy: true });
        const pluginCredentialVault = new PluginCredentialVault(dataRoot, safeStorage);
        for (const project of await workspaceStore.listProjects()) {
          if (project.migration?.source !== 'project-v1') continue;
          try {
            const legacy = await store.get(project.projectId);
            const plugin = await workspaceStore.getPlugin(project.projectId, 'default', 'server-primary');
            if (!(await pluginCredentialVault.has(plugin)) && await credentialStore.hasUsable(project.projectId, legacy)) {
              const legacySecrets = await credentialStore.load(project.projectId, legacy);
              if (Object.keys(legacySecrets).length) await pluginCredentialVault.save(plugin, legacySecrets);
            }
          } catch {
            // Non-secret migration remains usable; the UI will request credential re-entry.
          }
        }
        const resolver = new AddressResolver();
        const vpnGuard = new WindowsVpnGuard();
        const serverRuntime = new ServerPluginRuntime(workspaceStore, pluginCredentialVault, { resolver, vpnGuard });
        const routeManager = new RouteManager({ resolver, vpnGuard, serverRuntime });
        const mysqlRuntime = new MysqlPluginRuntime(routeManager, pluginCredentialVault);
        const redisRuntime = new RedisPluginRuntime(routeManager, pluginCredentialVault);
        const pluginManager = new PluginManager({ serverRuntime, mysqlRuntime, redisRuntime });
        const environmentConnectionManager = new EnvironmentConnectionManager(workspaceStore, pluginManager);
        const networkWatcher = new NetworkChangeWatcher((reason) => environmentConnectionManager.networkChanged(reason));
        environmentConnectionManager.on('changed', () => networkWatcher.setActive(Object.values(environmentConnectionManager.listStates()).some((item) => item.desiredConnected)));
        serverRuntime.on('lifecycle', (event) => {
          if (event.type === 'lost') environmentConnectionManager.pluginLost(event.projectId, event.environmentId, event.pluginInstanceId, event.error).catch(() => undefined);
        });
        mysqlRuntime.on('lifecycle', (event) => {
          if (event.type === 'lost') environmentConnectionManager.pluginLost(event.projectId, event.environmentId, event.pluginInstanceId, event.error).catch(() => undefined);
        });
        redisRuntime.on('lifecycle', (event) => {
          if (event.type === 'lost') environmentConnectionManager.pluginLost(event.projectId, event.environmentId, event.pluginInstanceId, event.error).catch(() => undefined);
        });
        const serverOperations = new ServerOperations(serverRuntime, workspaceStore);
        const contextManager = new EnvironmentContextManager(workspaceStore);
        const confirmationManager = new ConfirmationManager();
        const broadcast = (channel, payload) => {
          for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
        };
        const v2Service = new V2Service({ workspaceStore, connectionManager: environmentConnectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault: pluginCredentialVault, workspaceChanged:(payload) => broadcast('v2:workspace-changed', payload) });
        v2 = { workspaceStore, credentialVault: pluginCredentialVault, resolver, vpnGuard, serverRuntime, routeManager, mysqlRuntime, redisRuntime, pluginManager, connectionManager: environmentConnectionManager, networkWatcher, serverOperations, contextManager, confirmationManager, v2Service };
        const token = await rotateBrokerToken(dataRoot);
        brokerServer = new BrokerServer({ dataRoot, token, v2Service, appVersion: app.getVersion() });
        await brokerServer.start();
        registerV2Ipc(ipcMain, {
          ...v2,
          broadcast,
        });
        createWindow();
        powerMonitor.on('resume', () => environmentConnectionManager.networkChanged('system-resume').catch(() => undefined));
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      })
      .catch(() => {
        dialog.showErrorBox('AI 运维工具启动失败', '程序无法初始化本地数据或通信服务，请关闭其他实例后重试。');
        app.quit();
      });

    app.on('before-quit', (event) => {
      if (app.__aiOpsClosing) return;
      event.preventDefault();
      app.__aiOpsClosing = true;
      v2?.networkWatcher?.stop();
      Promise.all([v2?.connectionManager?.closeAll(), brokerServer?.stop()])
        .catch(() => undefined)
        .finally(() => app.quit());
    });

    app.on('window-all-closed', () => app.quit());
  }
}
