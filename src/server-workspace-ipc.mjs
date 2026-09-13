import { AppError, toPublicError } from './errors.mjs';

const SCOPE_KEYS = ['projectId', 'environmentId', 'pluginInstanceId'];
const CALLS = [
  ['server-terminal-open', 'serverWorkspaceManager', 'openTerminal', ['cols', 'rows', 'tabId', 'defaultColors']],
  ['server-terminal-read', 'serverWorkspaceManager', 'readTerminal', ['sessionId']],
  ['server-terminal-write', 'serverWorkspaceManager', 'writeTerminal', ['sessionId', 'data', 'encoding']],
  ['server-terminal-resize', 'serverWorkspaceManager', 'resizeTerminal', ['sessionId', 'cols', 'rows']],
  ['server-terminal-close', 'serverWorkspaceManager', 'closeTerminal', ['sessionId']],
  ['server-workspace-list-directory', 'serverWorkspaceFiles', 'listDirectory', ['path', 'cursor', 'snapshotId', 'deferLinks', 'resolveLinks']],
  ['server-workspace-read-file', 'serverWorkspaceFiles', 'readFile', ['path']],
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
    handle(name, extra, (ownerId, payload) => {
      const manager = services[serviceName];
      if (!manager) throw new AppError('WORKSPACE_UNAVAILABLE', '服务器工作区暂不可用。');
      return manager[method](ownerId, payload);
    });
  }
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
      return services.serverWorkspaceFiles.prepareUpload(ownerId, payload, files);
    } finally { picking.delete(ownerId); }
  });
}