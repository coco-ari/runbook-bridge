import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, session, Menu, shell } from 'electron';
import { ProjectStore } from './project-store.mjs';
import { desktopMenuTemplate } from './desktop-menu.mjs';
import { readWindowsClipboardFiles } from './desktop-file-clipboard.mjs';
import { createTransferExitGuard } from './desktop-transfer-exit-guard.mjs';
import { DesktopDownloadPicker } from './desktop-download-picker.mjs';
import { BrokerServer } from './broker-server.mjs';
import { rotateBrokerToken } from './broker-auth.mjs';
import { CredentialStore, migrateLegacyCredentialForPlugin } from './credential-store.mjs';
import { defaultDataRoot } from './paths.mjs';
import { WorkspaceStore } from './workspace-store.mjs';
import { CloudConfigWorkspace } from './cloud-config-workspace.mjs';
import { CloudConfigService } from './cloud-config-service.mjs';
import { PluginCredentialVault, pluginCredentialInternals } from './plugin-credential-vault.mjs';
import { AddressResolver, SystemVpnGuard, RouteManager } from './route-manager.mjs';
import { ServerPluginRuntime } from './server-plugin-runtime.mjs';
import { MysqlPluginRuntime } from './mysql-plugin-runtime.mjs';
import { RedisPluginRuntime } from './redis-plugin-runtime.mjs';
import { PluginManager } from './plugin-manager.mjs';
import { EnvironmentConnectionManager } from './environment-connection-manager.mjs';
import { ServerOperations } from './server-operations.mjs';
import { ServerWorkspaceManager } from './server-workspace-manager.mjs';
import { ServerWorkspaceFiles } from './server-workspace-files.mjs';
import { EnvironmentContextManager } from './context-manager.mjs';
import { ConfirmationManager } from './confirmation-manager.mjs';
import { V2Service } from './v2-service.mjs';
import { registerV2Ipc } from './ipc-v2.mjs';
import { CodexIntegration } from './codex-integration.mjs';
import { NetworkChangeWatcher } from './network-change-watcher.mjs';
import { PluginConfigTransactionJournal } from './plugin-config-transaction.mjs';
import { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator.mjs';
import { CredentialUseResolver } from './credential-use-resolver.mjs';
import { PluginValidationRuntime } from './plugin-validation-runtime.mjs';
import { PluginEditSessionManager } from './plugin-edit-session-manager.mjs';
import { PluginDraftCredentialVault } from './plugin-draft-credential-vault.mjs';
import { PluginDraftStore } from './plugin-draft-store.mjs';
import { PluginDraftPromotionJournal } from './plugin-draft-promotion-journal.mjs';
import { PluginProbeManager } from './plugin-probe-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = defaultDataRoot();
const store = new ProjectStore(dataRoot);
let brokerServer;
let credentialStore;
let mainWindow;
let v2;
const SHUTDOWN_WATCHDOG_MS = 15_000;
const transferExitGuard = createTransferExitGuard({
  summary: () => {
    const transfers = v2?.serverWorkspaceFiles?.exitSummary() ?? {active:0, resumable:0};
    const sql = v2?.v2Service?.mysqlSql?.exitSummary().active ?? 0;
    const editing = v2?.serverWorkspaceFiles?.editor.exitSummary() ?? 0;
    return {...transfers, active:transfers.active + sql + editing, transfers:transfers.active, sql, editing};
  },
  confirm: async ({transfers, resumable, sql, editing}) => {
    const options = {
      type:'warning', title:'退出客户端', message:editing ? '还有未保存或待核实的文件编辑' : sql ? '还有未结束的 SQL 执行或事务' : '还有未结束的文件传输',
      detail:[sql ? `${sql} 个 SQL 标签正在执行、有未提交事务或结果尚未确认。退出将关闭这些连接，未提交事务会回滚；已提交或结果不确定的写入不会被撤销。` : '',
        editing ? `${editing} 个文件有未保存内容、正在保存或结果待核实。退出会清除草稿和会话内的恢复版本；已保存的远端内容不会撤销。` : '',
        transfers || resumable ? `${transfers} 项正在传输或等待结束，${resumable} 项已暂停或等待续传。退出将终止传输并清除续传信息。` : ''].filter(Boolean).join('\n'),
      buttons:['留在客户端', editing || sql ? '结束会话并退出' : '终止传输并退出'], defaultId:0, cancelId:0, noLink:true,
    };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  quit: () => app.quit(),
});

app.setName('AI 运维工具');
app.disableHardwareAcceleration();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'AI 运维工具',
    backgroundColor: '#101115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', event => { if (!app.__aiOpsClosing) transferExitGuard.allow(event); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer-build', 'v2', 'index.html'));
}

async function clearRendererCacheAfterUpgrade() {
  try {
    const cacheStateDir = path.join(dataRoot, 'runtime');
    const marker = path.join(cacheStateDir, 'renderer-cache-version');
    const version = app.getVersion();
    const previous = await fs.readFile(marker, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    if (previous.trim() === version) return { cleared:false };
    await session.defaultSession.clearCache();
    await fs.mkdir(cacheStateDir, { recursive:true });
    await fs.writeFile(marker, `${version}\n`, { encoding:'utf8', mode:0o600 });
    return { cleared:true };
  } catch {
    // Cache maintenance is never a startup dependency. Read-only profiles,
    // antivirus locks and full disks must still allow the application to open.
    return { cleared:false, warning:true };
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
        // Renderer assets use stable app.asar URLs. Clear only after an upgrade;
        // doing this on every launch adds avoidable synchronous startup I/O.
        await clearRendererCacheAfterUpgrade();
        await store.init();
        const { safeStorage } = await import('electron');
        credentialStore = new CredentialStore(store, safeStorage);
        const workspaceStore = new WorkspaceStore(dataRoot, { legacyStore: store });
        await workspaceStore.init({ migrateLegacy:false });
        const pluginCredentialVault = new PluginCredentialVault(dataRoot, safeStorage);
        await pluginCredentialVault.ensureBackup();
        const cloudWorkspace = new CloudConfigWorkspace(workspaceStore,pluginCredentialVault,safeStorage);
        await cloudWorkspace.recoverAll();
        const configTransactionJournal = new PluginConfigTransactionJournal(dataRoot, workspaceStore, pluginCredentialVault);
        configTransactionJournal.addGuard(cloudWorkspace);
        await configTransactionJournal.recoverAll();
        const pluginDraftCredentialVault = new PluginDraftCredentialVault(dataRoot,safeStorage);
        const pluginDraftStore = new PluginDraftStore(workspaceStore,pluginDraftCredentialVault);
        const pluginDraftPromotionJournal = new PluginDraftPromotionJournal(
          dataRoot,workspaceStore,pluginDraftStore,pluginDraftCredentialVault,pluginCredentialVault,
        );
        // Recover promotions started by older releases. Saved draft data stays
        // untouched for rollback, but is no longer exposed to the application.
        await pluginDraftPromotionJournal.recoverAll();
        configTransactionJournal.addGuard(pluginDraftPromotionJournal);
        // Recovery must precede legacy materialization/import: otherwise an
        // unresolved old envelope could be mistaken for an absent credential.
        if (!configTransactionJournal.hasUnresolved()) await workspaceStore.migrateLegacyProjects();
        for (const project of await workspaceStore.listProjects()) {
          if (project.migration?.source !== 'project-v1') continue;
          try {
            const plugin = await workspaceStore.getPlugin(project.projectId, 'default', 'server-primary');
            configTransactionJournal.assertPluginAvailable(project.projectId, 'default', 'server-primary');
            await migrateLegacyCredentialForPlugin({
              legacyCredentialStore:credentialStore,
              credentialVault:pluginCredentialVault,
              plugin,
              pluginBindingHash:pluginCredentialInternals.bindingHash(plugin),
            });
          } catch {
            // Legacy ciphertext remains in its original project directory and
            // is archived byte-for-byte if the project is explicitly deleted.
          }
        }
        const resolver = new AddressResolver();
        const vpnGuard = new SystemVpnGuard();
        const serverRuntime = new ServerPluginRuntime(workspaceStore, pluginCredentialVault, { resolver, vpnGuard });
        const routeManager = new RouteManager({ resolver, vpnGuard, serverRuntime });
        const mysqlRuntime = new MysqlPluginRuntime(routeManager, pluginCredentialVault);
        const redisRuntime = new RedisPluginRuntime(routeManager, pluginCredentialVault);
        const pluginManager = new PluginManager({ runtimes:{server:serverRuntime, mysql:mysqlRuntime, redis:redisRuntime} });
        const mutationCoordinator = new WorkspaceMutationCoordinator();
        const environmentConnectionManager = new EnvironmentConnectionManager(workspaceStore, pluginManager, {
          configurationJournal:configTransactionJournal,
          mutationCoordinator,
        });
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
        const serverDocker = serverOperations.docker;
        const serverWorkspaceManager = new ServerWorkspaceManager({ workspaceStore, serverRuntime, serverOperations });
        const serverWorkspaceFiles = new ServerWorkspaceFiles({ workspaceStore, serverRuntime, serverOperations });
        const contextManager = new EnvironmentContextManager(workspaceStore);
        const confirmationManager = new ConfirmationManager();
        const credentialUseResolver = new CredentialUseResolver(pluginCredentialVault);
        const validationRuntime = new PluginValidationRuntime({pluginManager,mysqlRuntime});
        const pluginProbeManager = new PluginProbeManager({
          workspaceStore,
          mutationCoordinator,
          credentialUseResolver,
          validationRuntime,
          configurationJournal:configTransactionJournal,
        });
        const pluginEditSessionManager = new PluginEditSessionManager({
          workspaceStore,
          connectionManager:environmentConnectionManager,
          mutationCoordinator,
          credentialUseResolver,
          validationRuntime,
          assertScopeIdle: scope => v2Service.mysqlSql.assertScopeIdle(scope),
        });
        const broadcast = (channel, payload) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
            try { window.webContents.send(channel, payload); } catch { /* Window closed between checks. */ }
          }
        };
        const v2Service = new V2Service({ workspaceStore, connectionManager: environmentConnectionManager, pluginManager, contextManager, confirmationManager, serverOperations, credentialVault: pluginCredentialVault, mutationCoordinator, workspaceChanged:(payload) => broadcast('v2:workspace-changed', payload) });
        v2 = { serverDocker, serverWorkspaceManager, serverWorkspaceFiles, workspaceStore, credentialVault: pluginCredentialVault, legacyCredentialStore:credentialStore, configTransactionJournal, mutationCoordinator, credentialUseResolver, validationRuntime, pluginProbeManager, pluginEditSessionManager, resolver, vpnGuard, serverRuntime, routeManager, mysqlRuntime, redisRuntime, pluginManager, connectionManager: environmentConnectionManager, networkWatcher, serverOperations, contextManager, confirmationManager, v2Service };
        const cloudConfigService = new CloudConfigService({...v2,workspace:cloudWorkspace,broadcast});
        await cloudConfigService.init();
        v2.cloudConfigService = cloudConfigService;
        const token = await rotateBrokerToken(dataRoot);
        brokerServer = new BrokerServer({ dataRoot, token, v2Service, appVersion: app.getVersion() });
        await brokerServer.start();
        const downloadPicker = new DesktopDownloadPicker({
          dataRoot, defaultDirectory:app.getPath('downloads'),
          showSaveDialog:(window, options) => dialog.showSaveDialog(window, options),
          atomicWrite:(file, content) => workspaceStore.atomicWrite(file, content),
        });
        registerV2Ipc(ipcMain, {
          ...v2,
          codexIntegration: new CodexIntegration({ executablePath: process.execPath, entryPath: path.join(__dirname, 'mcp-v2.mjs'), dataRoot, clipboard }),
          broadcast,
          openRepository: () => shell.openExternal('https://github.com/coco-ari/runbook-bridge'),
          quickQuestionClipboard:clipboard,
          terminalClipboard:clipboard,
          readServerClipboardFiles:readWindowsClipboardFiles,
          isWorkspaceRenderer: (sender) => sender.getURL() === pathToFileURL(path.join(__dirname, '..', 'renderer-build', 'v2', 'index.html')).href,
          pickMysqlExportPath: async (sender, name) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (!window || window.isDestroyed()) return null;
            const result = await dialog.showSaveDialog(window, {title:'导出 SQL', defaultPath:path.join(app.getPath('downloads'), name), filters:[{name:'SQL 文件',extensions:['sql']}], properties:['showOverwriteConfirmation']});
            return result.canceled ? null : result.filePath;
          },
          revealServerDownload: target => shell.showItemInFolder(target),
          pickServerDownloadPath: async (sender, name, previousPath) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (!window || window.isDestroyed()) return null;
            return downloadPicker.pick(window, name, previousPath);
          },
          pickServerUploadFiles: async (sender) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (!window || window.isDestroyed()) return [];
            const result = await dialog.showOpenDialog(window, { title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] });
            return result.canceled ? [] : result.filePaths;
          },
        });
        const menuTemplate = desktopMenuTemplate();
        if (menuTemplate) Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
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
      if (!transferExitGuard.allow(event)) return;
      event.preventDefault();
      app.__aiOpsClosing = true;
      v2?.networkWatcher?.stop();
      v2?.serverDocker?.dispose();
      v2?.v2Service?.redisWorkspaceManager?.dispose();
      v2?.v2Service?.redisEditor?.dispose();
      v2?.serverWorkspaceManager?.dispose();
      v2?.serverWorkspaceFiles?.dispose();
      v2?.pluginProbeManager?.invalidateAll?.();
      v2?.pluginEditSessionManager?.invalidateAll?.({allowSaving:true});
      const watchdog = setTimeout(() => app.quit(), SHUTDOWN_WATCHDOG_MS);
      Promise.all([v2?.v2Service?.mysqlSql?.closeAll(), v2?.connectionManager?.closeAll(), brokerServer?.stop()])
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(watchdog);
          app.quit();
        });
    });

    app.on('window-all-closed', () => app.quit());
  }
}
