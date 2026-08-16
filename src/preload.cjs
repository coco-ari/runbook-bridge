const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiOps', {
  listProjects: () => ipcRenderer.invoke('project:list'),
  getProject: (id) => ipcRenderer.invoke('project:get', id),
  createProject: (payload) => ipcRenderer.invoke('project:create', payload),
  updateProject: (payload) => ipcRenderer.invoke('project:update', payload),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  connectProject: (payload) => ipcRenderer.invoke('project:connect', payload),
  trustHostKeyChange: (payload) => ipcRenderer.invoke('project:trust-host-key-change', payload),
  disconnectProject: (id) => ipcRenderer.invoke('project:disconnect', id),
  listDocuments: (projectId) => ipcRenderer.invoke('document:list', projectId),
  readDocument: (projectId, name) => ipcRenderer.invoke('document:read', { projectId, name }),
  saveDocument: (projectId, name, content) =>
    ipcRenderer.invoke('document:save', { projectId, name, content }),
  createDocument: (projectId, name) => ipcRenderer.invoke('document:create', { projectId, name }),
  deleteDocument: (projectId, name) => ipcRenderer.invoke('document:delete', { projectId, name }),
  choosePrivateKey: () => ipcRenderer.invoke('dialog:private-key'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  v2: {
    listProjects: () => ipcRenderer.invoke('v2:project-list'),
    createProject: (input) => ipcRenderer.invoke('v2:project-create', input),
    updateProject: (payload) => ipcRenderer.invoke('v2:project-update', payload),
    listEnvironments: (projectId) => ipcRenderer.invoke('v2:environment-list', projectId),
    createEnvironment: (payload) => ipcRenderer.invoke('v2:environment-create', payload),
    updateEnvironment: (payload) => ipcRenderer.invoke('v2:environment-update', payload),
    deleteEnvironment: (payload) => ipcRenderer.invoke('v2:environment-delete', payload),
    reorderEnvironments: (payload) => ipcRenderer.invoke('v2:environment-reorder', payload),
    connectEnvironment: (payload) => ipcRenderer.invoke('v2:environment-connect', payload),
    retryEnvironment: (payload) => ipcRenderer.invoke('v2:environment-retry', payload),
    disconnectEnvironment: (payload) => ipcRenderer.invoke('v2:environment-disconnect', payload),
    cancelEnvironment: (payload) => ipcRenderer.invoke('v2:environment-cancel', payload),
    environmentStatus: (payload) => ipcRenderer.invoke('v2:environment-status', payload),
    readRunbook: (payload) => ipcRenderer.invoke('v2:runbook-read', payload),
    saveRunbook: (payload) => ipcRenderer.invoke('v2:runbook-save', payload),
    listPlugins: (payload) => ipcRenderer.invoke('v2:plugin-list', payload),
    createPlugin: (payload) => ipcRenderer.invoke('v2:plugin-create', payload),
    updatePlugin: (payload) => ipcRenderer.invoke('v2:plugin-update', payload),
    deletePlugin: (payload) => ipcRenderer.invoke('v2:plugin-delete', payload),
    credentialStatus: (payload) => ipcRenderer.invoke('v2:plugin-credential-status', payload),
    listPluginDatabases: (payload) => ipcRenderer.invoke('v2:plugin-databases', payload),
    savePolicy: (payload) => ipcRenderer.invoke('v2:plugin-policy', payload),
    testPlugin: (payload) => ipcRenderer.invoke('v2:plugin-test', payload),
    listAudit: (payload) => ipcRenderer.invoke('v2:audit-list', payload),
    listConfirmations: () => ipcRenderer.invoke('v2:confirmation-list'),
    approveConfirmation: (requestId) => ipcRenderer.invoke('v2:confirmation-approve', requestId),
    rejectConfirmation: (requestId) => ipcRenderer.invoke('v2:confirmation-reject', requestId),
    onEnvironmentStatus: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:environment-status-changed', listener);
      return () => ipcRenderer.removeListener('v2:environment-status-changed', listener);
    },
    onConfirmations: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:confirmations-changed', listener);
      return () => ipcRenderer.removeListener('v2:confirmations-changed', listener);
    },
    notifyNetworkChanged: () => ipcRenderer.send('v2:network-changed'),
  },
});
