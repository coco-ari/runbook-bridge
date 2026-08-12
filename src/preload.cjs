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
});
