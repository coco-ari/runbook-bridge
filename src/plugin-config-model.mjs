import { AppError } from './errors.mjs';
import { builtinPluginRegistry } from './plugins/builtins.mjs';
import { normalizeId, normalizeName, normalizeDescription, normalizeTags, normalizeDisplayOrder } from './plugin-config-utils.mjs';
export { normalizeId, normalizeName } from './plugin-config-utils.mjs';

const now = () => new Date().toISOString();

export function normalizePlugin(input, scope, existing = null, registry = builtinPluginRegistry) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGUMENT', '插件配置无效。');
  }
  const pluginType = input.pluginType ?? existing?.pluginType;
  if (!registry.has(pluginType)) throw new AppError('INVALID_ARGUMENT', '插件类型无效。');
  if (existing && existing.pluginType !== pluginType) throw new AppError('INVALID_ARGUMENT', '不能修改插件类型。');
  const pluginInstanceId = existing?.pluginInstanceId ?? normalizeId(input.pluginInstanceId ?? input.displayName, pluginType);
  const metadata = {...(existing ?? {}),...input};
  const base = {
    schemaVersion: 1,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    pluginInstanceId,
    pluginType,
    displayName: normalizeName(input.displayName ?? existing?.displayName ?? pluginType, '插件名称'),
    ...((Object.hasOwn(existing ?? {}, 'description') || Object.hasOwn(input, 'description'))
      ? {description:normalizeDescription(metadata.description)}
      : {}),
    ...((Object.hasOwn(existing ?? {}, 'tags') || Object.hasOwn(input, 'tags'))
      ? {tags:normalizeTags(metadata.tags ?? [])}
      : {}),
    ...((Object.hasOwn(existing ?? {}, 'displayOrder') || Object.hasOwn(input, 'displayOrder'))
      ? {displayOrder:normalizeDisplayOrder(metadata.displayOrder ?? 0)}
      : {}),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: now(),
  };

  return registry.get(pluginType).normalizeConfiguration(input, existing, base);
}

export function normalizePluginCandidate(input, scope, existing, registry = builtinPluginRegistry) {
  if (!existing) throw new AppError('PLUGIN_NOT_FOUND', '缺少候选配置的现有插件。');
  const normalized = normalizePlugin(input,scope,existing,registry);
  return {
    ...normalized,
    revision:existing.revision,
    updatedAt:existing.updatedAt,
  };
}

export function materializePluginCandidate(candidate, existing) {
  return {
    ...candidate,
    revision:existing.revision + 1,
    updatedAt:now(),
  };
}

export function sanitizePluginSnapshot(plugin, registry = builtinPluginRegistry) {
  // 按白名单重新规范化，避免将凭据或未知配置写入恢复快照。
  const normalized = normalizePlugin(plugin, {
    projectId:plugin.projectId,
    environmentId:plugin.environmentId,
  }, null, registry);
  return {
    ...normalized,
    revision:plugin.revision,
    updatedAt:plugin.updatedAt,
  };
}
