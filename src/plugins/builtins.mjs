import { createPluginRegistry } from '../plugin-registry.mjs';
import { serverPluginDefinition } from './server/definition.mjs';
import { mysqlPluginDefinition } from './mysql/definition.mjs';
import { redisPluginDefinition } from './redis/definition.mjs';

export const builtinPluginRegistry = createPluginRegistry([
  serverPluginDefinition,
  mysqlPluginDefinition,
  redisPluginDefinition,
]);
