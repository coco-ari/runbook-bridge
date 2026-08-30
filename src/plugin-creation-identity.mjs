import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

async function pluginExists(store,plugin) {
  try {
    await store.getPlugin(plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
    return true;
  } catch (error) {
    if (error?.code === 'PLUGIN_NOT_FOUND') return false;
    throw error;
  }
}

export async function isolateNewPluginIdentity(candidate,{
  workspaceStore,credentialVault,explicitIdentity = false,
}) {
  if (typeof credentialVault?.hasStoredEntry !== 'function'
    || !await credentialVault.hasStoredEntry(candidate)) return candidate;

  if (await pluginExists(workspaceStore,candidate)) {
    throw new AppError('PLUGIN_ALREADY_EXISTS','插件标识已经存在。');
  }
  if (explicitIdentity) {
    throw new AppError(
      'PLUGIN_ALREADY_EXISTS',
      '此插件标识仍保留已删除实例的凭据，请重新新增插件以使用新的标识。',
      {reason:'credentials-preserved'},
    );
  }
  // Automatically derived names may be reused after deletion, but their new
  // instance must not inherit any credential belonging to the deleted one.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fresh = {...candidate,pluginInstanceId:`${candidate.pluginType}-${crypto.randomUUID()}`};
    if (!await credentialVault.hasStoredEntry(fresh) && !await pluginExists(workspaceStore,fresh)) return fresh;
  }
  throw new AppError('PLUGIN_ALREADY_EXISTS','无法分配新的插件标识，请重新新增插件。');
}
