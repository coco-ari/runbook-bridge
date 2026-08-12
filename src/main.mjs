import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { ProjectStore } from './project-store.mjs';
import { SshBroker } from './ssh-broker.mjs';
import { BrokerServer } from './broker-server.mjs';
import { rotateBrokerToken } from './broker-auth.mjs';
import { CredentialStore, sameCredentialBinding } from './credential-store.mjs';
import { ConnectionManager } from './connection-manager.mjs';
import { defaultDataRoot } from './paths.mjs';
import { AppError, toPublicError } from './errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = defaultDataRoot();
const store = new ProjectStore(dataRoot);
const broker = new SshBroker(store);
let brokerServer;
let credentialStore;
let connectionManager;
let mainWindow;

app.setName('AI 运维工具');
app.disableHardwareAcceleration();

function resultHandler(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: toPublicError(error) };
    }
  };
}

async function listProjects() {
  const projects = await store.list();
  return Promise.all(
    projects.map(async (project) => ({
      ...project,
      status: broker.status(project.id),
      credentialsSaved: await credentialStore.hasUsable(project.id, project),
      documents: await store.listDocs(project.id),
    })),
  );
}

function registerIpc() {
  ipcMain.handle('project:list', resultHandler(listProjects));
  ipcMain.handle('project:get', resultHandler((id) => store.get(id)));
  ipcMain.handle(
    'project:create',
    resultHandler(async ({ project: input, secrets }) => {
      const project = await store.create(input);
      try {
        const connection = await connectionManager.connect(project.id, secrets);
        return { project: await store.get(project.id), connection };
      } catch (error) {
        return { project: await store.get(project.id), connectError: toPublicError(error) };
      }
    }),
  );
  ipcMain.handle(
    'project:update',
    resultHandler(async ({ id, project }) => {
      const previous = await store.get(id);
      const updated = await store.update(id, project);
      if (!updated.credentials.remember || !sameCredentialBinding(previous, updated)) {
        await credentialStore.clear(id);
      }
      return updated;
    }),
  );
  ipcMain.handle(
    'project:delete',
    resultHandler(async (projectId) => {
      const project = await store.get(projectId);
      await broker.disconnect(projectId, 'project-delete');
      broker.invalidateProjectContexts(projectId);
      await shell.trashItem(store.projectDir(projectId));
      return { id: project.id, name: project.name };
    }),
  );
  ipcMain.handle(
    'project:connect',
    resultHandler(async ({ projectId, secrets }) => connectionManager.connect(projectId, secrets)),
  );
  ipcMain.handle(
    'project:trust-host-key-change',
    resultHandler(async ({ projectId, fingerprint }) => {
      const value = String(fingerprint ?? '');
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) {
        throw new AppError('INVALID_ARGUMENT', 'SSH 主机指纹格式无效。');
      }
      const updated = await store.update(projectId, { ssh: { hostKeyFingerprint: value } });
      await store.appendAudit(projectId, { type: 'host-key-change-approved', fingerprint: value });
      return updated;
    }),
  );
  ipcMain.handle('project:disconnect', resultHandler((projectId) => broker.disconnect(projectId)));
  ipcMain.handle('document:list', resultHandler((projectId) => store.listDocs(projectId)));
  ipcMain.handle('document:read', resultHandler(({ projectId, name }) => store.readDoc(projectId, name)));
  ipcMain.handle(
    'document:save',
    resultHandler(({ projectId, name, content }) => store.saveDoc(projectId, name, content)),
  );
  ipcMain.handle('document:create', resultHandler(({ projectId, name }) => store.createDoc(projectId, name)));
  ipcMain.handle('document:delete', resultHandler(({ projectId, name }) => store.deleteDoc(projectId, name)));
  ipcMain.handle(
    'dialog:private-key',
    resultHandler(async () => {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: '选择 SSH 私钥文件',
        properties: ['openFile'],
        filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', 'ppk', '*'] }],
      });
      return selection.canceled ? null : selection.filePaths[0];
    }),
  );
  ipcMain.handle('app:open-data-folder', resultHandler(() => shell.openPath(dataRoot)));
  ipcMain.handle('app:info', resultHandler(() => ({ version: app.getVersion(), dataRoot })));
}

function createWindow() {
  const screenshotPath = process.env.AI_OPS_SCREENSHOT_PATH;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'AI 运维工具',
    backgroundColor: '#f5f7fa',
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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const screenshotDialog = process.env.AI_OPS_SCREENSHOT_DIALOG;
      if (screenshotDialog && screenshotDialog !== '1' && screenshotDialog !== 'project') {
        const contentReady = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          let attempts = 0;
          const check = () => {
            const projectReady = !document.querySelector('#project-view').classList.contains('hidden');
            const documentReady = document.querySelector('#document-editor').value.length > 0;
            if (projectReady && documentReady) resolve(true);
            else if (attempts++ > 120) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`);
        if (!contentReady && screenshotDialog === '0') {
          process.stderr.write('packaged UI smoke failed: document content did not load\n');
          app.exit(1);
          return;
        }
      }
      if (screenshotDialog === '1' || screenshotDialog === 'project') {
        await mainWindow.webContents.executeJavaScript("document.querySelector('#new-project').click()");
      } else if (screenshotDialog === 'document') {
        await mainWindow.webContents.executeJavaScript("document.querySelector('#add-document').click()");
      } else if (screenshotDialog === 'connect') {
        const connectResult = await mainWindow.webContents.executeJavaScript(`(() => {
          try {
            document.querySelector('#connection-button').click();
            return { open: document.querySelector('#project-dialog').open };
          } catch (error) {
            return { error: error.stack || error.message };
          }
        })()`);
        if (connectResult.error || !connectResult.open) {
          process.stderr.write(`connect dialog smoke failed: ${JSON.stringify(connectResult)}\n`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      const image = await mainWindow.webContents.capturePage();
      await fs.writeFile(screenshotPath, image.toPNG());
      app.quit();
    });
  }
}

if (process.argv.includes('--mcp')) {
  // Electron's Windows GUI process does not consume redirected stdin reliably.
  // Run the MCP entrypoint in Electron's Node mode and inherit the original pipes.
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.mjs')], {
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
        connectionManager = new ConnectionManager(store, credentialStore, broker);
        const token = await rotateBrokerToken(dataRoot);
        brokerServer = new BrokerServer({ dataRoot, token, broker, appVersion: app.getVersion() });
        await brokerServer.start();
        registerIpc();
        createWindow();
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
      Promise.all([broker.closeAll(), brokerServer?.stop()])
        .catch(() => undefined)
        .finally(() => app.quit());
    });

    app.on('window-all-closed', () => app.quit());
  }
}
