// preload 的沙箱禁止加载任意本地模块；其静态映射通过可执行契约测试与此目录对照。
export const PLUGIN_IPC_CHANNELS = Object.freeze({
  listPlugins:'v2:plugin-list',
  assessPlugin:'v2:plugin-assess',
  createPlugin:'v2:plugin-create',
  updatePlugin:'v2:plugin-update',
  updatePluginMetadata:'v2:plugin-metadata-update',
  updatePluginAgentConfiguration:'v2:plugin-agent-configuration-update',
  updatePluginConnection:'v2:plugin-connection-update',
  preparePluginConnectionEdit:'v2:plugin-connection-edit-prepare',
  beginPluginConnectionEdit:'v2:plugin-connection-edit-begin',
  validatePluginDraft:'v2:plugin-draft-validate',
  cancelPluginValidation:'v2:plugin-validation-cancel',
  probePluginDraft:'v2:plugin-probe',
  cancelPluginProbe:'v2:plugin-probe-cancel',
  savePluginConnectionEdit:'v2:plugin-connection-edit-save',
  cancelPluginConnectionEdit:'v2:plugin-connection-edit-cancel',
  deletePlugin:'v2:plugin-delete',
});
