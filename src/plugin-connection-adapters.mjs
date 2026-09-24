import { AppError } from './errors.mjs';
import { builtinPluginRegistry } from './plugins/builtins.mjs';
export { isCredentialFreeServerAgent } from './plugin-connection-utils.mjs';

export const pluginConnectionAdapters = Object.freeze(Object.fromEntries(
  builtinPluginRegistry.types.map(type => [type,builtinPluginRegistry.get(type).connectionAdapter]),
));

export function getPluginConnectionAdapter(pluginType, registry = builtinPluginRegistry) {
  if (!registry.has(pluginType)) throw new TypeError(`Unsupported plugin type: ${pluginType}`);
  return registry.get(pluginType).connectionAdapter;
}

export function assertPluginConfigurationReady(plugin, registry = builtinPluginRegistry) {
  const assessment = getPluginConnectionAdapter(plugin?.pluginType, registry)
    .assessConfiguration(plugin,'connection');
  if (plugin?.configState === 'ready' && assessment.state === 'complete') return plugin;
  const invalid = assessment.state === 'invalid';
  throw new AppError(
    invalid ? 'PLUGIN_CONFIGURATION_INVALID' : 'PLUGIN_CONFIGURATION_INCOMPLETE',
    assessment.issues[0]?.message
      ?? (invalid ? '插件配置包含无效字段。' : '请补全插件配置后再保存。'),
    {configState:plugin?.configState ?? null,issues:assessment.issues},
  );
}
