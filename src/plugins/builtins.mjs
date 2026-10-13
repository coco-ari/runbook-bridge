import { createPluginRegistry } from '../plugin-registry.mjs';
import { serverPluginDefinition } from './server/definition.mjs';
import { mysqlPluginDefinition } from './mysql/definition.mjs';
import { redisPluginDefinition } from './redis/definition.mjs';
import { sourcePluginDefinition } from './source/definition.mjs';

import { codexPluginDefinition } from './codex/definition.mjs';

export const builtinPluginRegistry = createPluginRegistry([
  serverPluginDefinition,
  mysqlPluginDefinition,
  redisPluginDefinition,
  sourcePluginDefinition,
  codexPluginDefinition,
]);
