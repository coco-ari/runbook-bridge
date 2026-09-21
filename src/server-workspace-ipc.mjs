import { AppError, toPublicError } from './errors.mjs';
import path from 'node:path';

const SCOPE_KEYS = ['projectId', 'environmentId', 'pluginInstanceId'];
const CALLS = [
  ['server-workspace-file-info', 'serverWorkspaceFiles', 'fileInfo', ['path']],
  ['server-workspace-prepare-file-action', 'serverWorkspaceFiles', 'prepareFileAction', ['kind', 'path', 'name']],
  ['server-workspace-confirm-file-action', 'serverWorkspaceFiles', 'confirmFileAction', ['operationId']],
  ['server-workspace-cancel-file-action', 'serverWorkspaceFiles', 'cancelFileAction', ['operationId']],
  ['server-docker-read', 'serverDocker', 'read', ['kind', 'requestId', 'containerId', 'cursor', 'limit', 'lines', 'maxBytes', 'since', 'until']],
  ['server-docker-cancel', 'serverDocker', 'cancel', ['requestId']],
  ['server-workspace-metrics', 'serverWorkspaceManager', 'readMetrics', ['kind']],
  ['server-workspace-stop-metrics', 'serverWorkspaceManager', 'stopMetrics', []],
  ['server-workspace-pause-upload', 'serverWorkspaceFiles', 'pauseUpload', ['jobId']],
  ['server-workspace-clear-transfers', 'serverWorkspaceFiles', 'clearTransfers', ['jobId']],
  ['server-workspace-prepare-upload-resume', 'serverWorkspaceFiles', 'prepareUploadResume', ['jobId']],
  ['server-terminal-open', 'serverWorkspaceManager', 'openTerminal', ['cols', 'rows', 'tabId', 'defaultColors', 'recoveryOf']],
  ['server-terminal-working-directory', 'serverWorkspaceManager', 'terminalWorkingDirectory', ['sessionId']],
  ['server-terminal-read', 'serverWorkspaceManager', 'readTerminal', ['sessionId']],
  ['server-terminal-write', 'serverWorkspaceManager', 'writeTerminal', ['sessionId', 'data', 'encoding']],
  ['server-terminal-resize', 'serverWorkspaceManager', 'resizeTerminal', ['sessionId', 'cols', 'rows']],
  ['server-terminal-close', 'serverWorkspaceManager', 'closeTerminal', ['sessionId']],
  ['server-workspace-list-directory', 'serverWorkspaceFiles', 'listDirectory', ['path', 'cursor', 'snapshotId', 'deferLinks', 'resolveLinks']],
  ['server-workspace-read-file', 'serverWorkspaceFiles', 'readFile', ['path']],
  ['server-workspace-revise-upload', 'serverWorkspaceFiles', 'reviseUploadReview', ['reviewId', 'fileNames', 'decisions']],
  ['server-workspace-read-upload-review', 'serverWorkspaceFiles', 'readUploadReview', ['reviewId']],
  ['server-workspace-cancel-upload-review', 'serverWorkspaceFiles', 'cancelUploadReview', ['reviewId']],
  ['server-workspace-confirm-upload', 'serverWorkspaceFiles', 'confirmUpload', ['preparationId', 'overwrite']],
  ['server-workspace-cancel-upload', 'serverWorkspaceFiles', 'cancelUpload', ['jobId']],
  ['server-workspace-uploads', 'serverWorkspaceFiles', 'uploads', []],
];

function assertPayload(payload, extra) {
  const allowed = new Set([...SCOPE_KEYS, ...extra]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !allowed.has(key)) || SCOPE_KEYS.some((key) => typeof payload[key] !== 'string' || !payload[key] || payload[key].length > 200 || /[\\/\0]/u.test(payload[key]))) {
    throw new AppError('INVALID_ARGUMENT', '服务器工作区请求参数无效。');
  }
}

export function registerServerWorkspaceIpc(ipcMain, services) {
  const installed = new WeakSet();
  const picking = new Set();
  const closeOwner = (ownerId) => {
    services.serverDocker?.closeOwner(ownerId);
    services.serverWorkspaceManager?.closeOwner(ownerId);
    services.serverWorkspaceFiles?.closeOwner(ownerId);
  };
  const ownerFor = (event) => {
    const sender = event?.sender;
    if (!sender || !Number.isInteger(sender.id) || sender.isDestroyed?.() || !sender.mainFrame || event.senderFrame !== sender.mainFrame || services.isWorkspaceRenderer?.(sender) !== true) {
      throw new AppError('WORKSPACE_ACCESS_DENIED', '仅当前桌面工作区可以访问服务器会话。');
    }
    const ownerId = 'renderer:' + sender.id;
    if (!installed.has(sender)) {
      installed.add(sender);
      sender.once('destroyed', () => closeOwner(ownerId));
      sender.on('render-process-gone', () => closeOwner(ownerId));
      sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) closeOwner(ownerId);
      });
    }
    return ownerId;
  };
  const handle = (name, extra, callback) => ipcMain.handle('v2:' + name, async (event, payload) => {
    try {
      const ownerId = ownerFor(event);
      assertPayload(payload, extra);
      services.mutationCoordinator?.assertProjectAvailable(payload.projectId);
      return { ok: true, data: await callback(ownerId, payload, event) };
    } catch (error) { return { ok: false, error: toPublicError(error) }; }
  });
  for (const [name, serviceName, method, extra] of CALLS) {
    handle(name, extra, (ownerId, payload, event) => {
      const manager = services[serviceName];
      if (!manager) throw new AppError('WORKSPACE_UNAVAILABLE', '服务器工作区暂不可用。');
      if (method === 'readMetrics' && event.sender.getOwnerBrowserWindow?.()?.isMinimized?.()) {
        manager.stopMetrics(ownerId, payload);
        throw new AppError('METRICS_PAUSED', '窗口最小化期间暂停资源采集。');
      }
      if (name === 'server-docker-read' && payload.kind === 'stats' && event.sender.getOwnerBrowserWindow?.()?.isMinimized?.()) {
        throw new AppError('DOCKER_PAUSED', '窗口最小化期间暂停容器资源采集。');
      }
      return manager[method](ownerId, payload);
    });
  }
  handle('server-terminal-clipboard', ['sessionId', 'action', 'text'], async (ownerId, payload, event) => {
    const adapter = services.terminalClipboard;
    if (!services.serverWorkspaceManager || !adapter) throw new AppError('WORKSPACE_UNAVAILABLE', '终端剪贴板暂不可用。');
    if (!['copy', 'paste'].includes(payload.action)
      || (payload.action === 'copy' && (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > 1024 * 1024))
      || (payload.action === 'paste' && payload.text !== undefined)) {
      throw new AppError('INVALID_ARGUMENT', '剪贴板操作无效或复制内容超过 1 MiB。');
    }
    await services.serverWorkspaceManager.requireRecord(ownerId, payload, { allowClosed: payload.action === 'copy' });
    ownerFor(event);
    // 仅响应桌面终端操作，剪贴板内容不进入 MCP、审计或错误详情。
    try {
      if (payload.action === 'copy') { adapter.writeText(payload.text); return {}; }
      const text = adapter.readText();
      if (Buffer.byteLength(text) > 65536) throw new AppError('CLIPBOARD_TOO_LARGE', '粘贴内容超过 64 KB，请分批操作。');
      return { text };
    } catch (error) {
      if (error?.code === 'CLIPBOARD_TOO_LARGE') throw error;
      throw new AppError('CLIPBOARD_UNAVAILABLE', '无法访问系统剪贴板，请稍后重试。');
    }
  });
  handle('server-workspace-download', ['path'], async (ownerId, payload, event) => {
    const files = services.serverWorkspaceFiles;
    if (!files || !services.pickServerDownloadPath) throw new AppError('WORKSPACE_UNAVAILABLE', '下载暂不可用。');
    if (picking.has(ownerId)) throw new AppError('WORKSPACE_BUSY', '请选择或关闭当前文件选择窗口。');
    picking.add(ownerId);
    try {
      const prepared = await files.downloads.prepare(ownerId, payload);
      const selected = await services.pickServerDownloadPath(event.sender, prepared.name);
      if (!selected) return null;
      ownerFor(event);
      return await files.downloads.start(ownerId, payload, prepared, selected);
    } finally { picking.delete(ownerId); }
  });
  handle('server-workspace-import-upload', ['path', 'localPaths'], async (ownerId, payload, event) => {
    const files = services.serverWorkspaceFiles;
    if (!files) throw new AppError('WORKSPACE_UNAVAILABLE', '文件上传暂不可用。');
    if (!Array.isArray(payload.localPaths) || !payload.localPaths.length || payload.localPaths.length > 20
      || payload.localPaths.some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0') || !path.isAbsolute(value))) {
      throw new AppError('INVALID_ARGUMENT', '每次请粘贴或拖入 1 至 20 个本地普通文件。');
    }
    if (picking.has(ownerId)) throw new AppError('WORKSPACE_BUSY', '正在接收文件，请稍候。');
    picking.add(ownerId);
    try {
      const binding = await files.requirePlugin(ownerId, payload);
      ownerFor(event);
      await files.requirePlugin(ownerId, payload, binding);
      // 与文件选择器共用预检查和一次性确认；接收文件不启动传输。
      return await files.beginUploadReview(ownerId, payload, payload.localPaths);
    } finally { picking.delete(ownerId); }
  });
  handle('server-workspace-pick-upload', ['path'], async (ownerId, payload, event) => {
    if (!services.serverWorkspaceFiles || !services.pickServerUploadFiles) throw new AppError('WORKSPACE_UNAVAILABLE', '文件选择暂不可用。');
    if (picking.has(ownerId)) throw new AppError('WORKSPACE_BUSY', '请选择或关闭当前文件选择窗口。');
    picking.add(ownerId);
    try {
      const binding = await services.serverWorkspaceFiles.requirePlugin(ownerId, payload);
      const files = await services.pickServerUploadFiles(event.sender);
      if (!files?.length) return null;
      ownerFor(event);
      await services.serverWorkspaceFiles.requirePlugin(ownerId, payload, binding);
      return await services.serverWorkspaceFiles.beginUploadReview(ownerId, payload, files);
    } finally { picking.delete(ownerId); }
  });
}