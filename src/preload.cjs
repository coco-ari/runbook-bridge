const { contextBridge, ipcRenderer } = require('electron');

const requestConnectionIntent = (payload) => ipcRenderer.invoke('v2:connection-intent',payload);
const legacyConnectionSnapshot = (payload) => requestConnectionIntent(payload).then((result) => (
  result?.ok ? {...result,data:result.data?.snapshot} : result
));

contextBridge.exposeInMainWorld('aiOps', {
  v2: {
    listProjects: () => ipcRenderer.invoke('v2:project-list'),
    workspaceOverview: () => ipcRenderer.invoke('v2:workspace-overview'),
    createProject: (input) => ipcRenderer.invoke('v2:project-create', input),
    updateProject: (payload) => ipcRenderer.invoke('v2:project-update', payload),
    deleteProject: (payload) => ipcRenderer.invoke('v2:project-delete', payload),
    listEnvironments: (projectId) => ipcRenderer.invoke('v2:environment-list', projectId),
    createEnvironment: (payload) => ipcRenderer.invoke('v2:environment-create', payload),
    updateEnvironment: (payload) => ipcRenderer.invoke('v2:environment-update', payload),
    deleteEnvironment: (payload) => ipcRenderer.invoke('v2:environment-delete', payload),
    reorderEnvironments: (payload) => ipcRenderer.invoke('v2:environment-reorder', payload),
    requestConnectionIntent,
    confirmConnectionChallenge: (payload) => ipcRenderer.invoke('v2:connection-challenge-confirm',payload),
    connectEnvironment: (payload) => legacyConnectionSnapshot({...payload,intent:'connect',source:'legacy-environment'}),
    retryEnvironment: (payload) => legacyConnectionSnapshot({...payload,intent:'retry',source:'legacy-environment'}),
    disconnectEnvironment: (payload) => legacyConnectionSnapshot({...payload,intent:'disconnect',source:'legacy-environment'}),
    cancelEnvironment: (payload) => legacyConnectionSnapshot({...payload,intent:'cancel',source:'legacy-environment',legacyScope:true}),
    environmentStatus: (payload) => ipcRenderer.invoke('v2:environment-status', payload),
    connectPlugin: (payload) => legacyConnectionSnapshot({...payload,intent:'connect',source:'legacy-plugin'}),
    disconnectPlugin: (payload) => legacyConnectionSnapshot({...payload,intent:'disconnect',source:'legacy-plugin'}),
    readRunbook: (payload) => ipcRenderer.invoke('v2:runbook-read', payload),
    saveRunbook: (payload) => ipcRenderer.invoke('v2:runbook-save', payload),
    listPlugins: (payload) => ipcRenderer.invoke('v2:plugin-list', payload),
    listPluginDrafts: (payload) => ipcRenderer.invoke('v2:plugin-draft-list',payload),
    savePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-draft-save',payload),
    resumePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-draft-resume',payload),
    cancelPluginDraftSession: (payload) => ipcRenderer.invoke('v2:plugin-draft-edit-cancel',payload),
    deletePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-draft-delete',payload),
    promotePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-draft-promote',payload),
    assessPlugin: (payload) => ipcRenderer.invoke('v2:plugin-assess', payload),
    createPlugin: (payload) => ipcRenderer.invoke('v2:plugin-create', payload),
    updatePlugin: (payload) => ipcRenderer.invoke('v2:plugin-update', payload),
    updatePluginMetadata: (payload) => ipcRenderer.invoke('v2:plugin-metadata-update', payload),
    updatePluginAgentConfiguration: (payload) => ipcRenderer.invoke('v2:plugin-agent-configuration-update', payload),
    updatePluginConnection: (payload) => ipcRenderer.invoke('v2:plugin-connection-update', payload),
    preparePluginConnectionEdit: (payload) => ipcRenderer.invoke('v2:plugin-connection-edit-prepare', payload),
    beginPluginConnectionEdit: (payload) => ipcRenderer.invoke('v2:plugin-connection-edit-begin', payload),
    validatePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-draft-validate', payload),
    cancelPluginValidation: (payload) => ipcRenderer.invoke('v2:plugin-validation-cancel', payload),
    probePluginDraft: (payload) => ipcRenderer.invoke('v2:plugin-probe', payload),
    cancelPluginProbe: (payload) => ipcRenderer.invoke('v2:plugin-probe-cancel', payload),
    savePluginConnectionEdit: (payload) => ipcRenderer.invoke('v2:plugin-connection-edit-save', payload),
    cancelPluginConnectionEdit: (payload) => ipcRenderer.invoke('v2:plugin-connection-edit-cancel', payload),
    onPluginValidationProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:plugin-validation-progress', listener);
      return () => ipcRenderer.removeListener('v2:plugin-validation-progress', listener);
    },
    onPluginProbeProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:plugin-probe-progress', listener);
      return () => ipcRenderer.removeListener('v2:plugin-probe-progress', listener);
    },
    deletePlugin: (payload) => ipcRenderer.invoke('v2:plugin-delete', payload),
    credentialStatus: (payload) => ipcRenderer.invoke('v2:plugin-credential-status', payload),
    confirmCredentialMigration: (payload) => ipcRenderer.invoke('v2:plugin-credential-migration-confirm', payload),
    revealCredential: (payload) => ipcRenderer.invoke('v2:plugin-credential-reveal', payload),
    listPluginDatabases: (payload) => ipcRenderer.invoke('v2:plugin-databases', payload),
    listAudit: (payload) => ipcRenderer.invoke('v2:audit-list', payload),
    clearAudit: (payload) => ipcRenderer.invoke('v2:audit-clear', payload),
    listConfirmations: () => ipcRenderer.invoke('v2:confirmation-list'),
    approveConfirmation: (requestId) => ipcRenderer.invoke('v2:confirmation-approve', requestId),
    rejectConfirmation: (requestId) => ipcRenderer.invoke('v2:confirmation-reject', requestId),
    onEnvironmentStatus: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:environment-status-changed', listener);
      return () => ipcRenderer.removeListener('v2:environment-status-changed', listener);
    },
    onWorkspaceChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('v2:workspace-changed', listener);
      return () => ipcRenderer.removeListener('v2:workspace-changed', listener);
    },
    onConfirmations: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('v2:confirmations-changed', listener);
      return () => ipcRenderer.removeListener('v2:confirmations-changed', listener);
    },
    notifyNetworkChanged: () => ipcRenderer.send('v2:network-changed'),
  },
});
