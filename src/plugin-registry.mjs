import { AppError } from './errors.mjs';

function freezeDefinition(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDefinition(child, seen);
  return Object.freeze(value);
}

// 注册只接受随应用发布的可信代码；实例配置不能自行增加类型或权限。
export function createPluginRegistry(definitions) {
  const entries = new Map();
  for (const definition of definitions) {
    const type = definition?.type;
    if (typeof type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(type)
      || entries.has(type)) {
      throw new TypeError('插件类型无效或重复注册。');
    }
    for (const name of ['normalizeConfiguration', 'publicResource', 'invoke']) {
      if (typeof definition[name] !== 'function') throw new TypeError(`插件缺少 ${name}。`);
    }
    if (!Array.isArray(definition.connectionFields) || !definition.connectionNestedFields
      || !definition.capabilities || typeof definition.capabilities !== 'object') {
      throw new TypeError('插件缺少配置字段范围或能力声明。');
    }
    for (const method of ['assessConfiguration','resourceScope','dependencyRefs','credentialIdentity','validationDigest','classifyChangedPath','validate']) {
      if (typeof definition.connectionAdapter?.[method] !== 'function') {
        throw new TypeError(`插件缺少连接适配器方法 ${method}。`);
      }
    }
    for (const rule of Object.values(definition.capabilities)) {
      if (!rule || !['auto', 'confirm', 'deny'].includes(rule.decision)
        || typeof rule.risk !== 'string' || typeof rule.label !== 'string') {
        throw new TypeError('插件能力规则无效。');
      }
    }
    entries.set(type, freezeDefinition({...definition}));
  }
  return Object.freeze({
    types: Object.freeze([...entries.keys()]),
    has: (type) => entries.has(type),
    get(type) {
      const definition = entries.get(type);
      if (!definition) throw new AppError('PLUGIN_TYPE_UNSUPPORTED', '插件类型暂不支持。');
      return definition;
    },
    capabilityRule(type, capability) {
      const rules = entries.get(type)?.capabilities;
      return rules && Object.hasOwn(rules, capability)
        ? rules[capability]
        : Object.freeze({decision:'deny', risk:'unknown', label:'未登记操作'});
    },
  });
}
