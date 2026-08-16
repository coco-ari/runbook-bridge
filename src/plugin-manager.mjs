import { AppError } from './errors.mjs';

export class PluginManager {
  constructor({ serverRuntime, mysqlRuntime, redisRuntime }) {
    this.runtimes = { server: serverRuntime, mysql: mysqlRuntime, redis: redisRuntime };
  }

  runtime(plugin) {
    const runtime = this.runtimes[plugin.pluginType];
    if (!runtime) throw new AppError('PLUGIN_TYPE_UNSUPPORTED', '插件类型暂不支持。');
    return runtime;
  }

  status(plugin) {
    return this.runtime(plugin).status(plugin);
  }

  connect(plugin, secrets = {}) {
    return this.runtime(plugin).connect(plugin, secrets);
  }

  disconnect(plugin, reason) {
    return this.runtime(plugin).disconnect(plugin, reason);
  }

  health(plugin) {
    const runtime = this.runtime(plugin);
    return typeof runtime.health === 'function' ? runtime.health(plugin) : Promise.resolve(runtime.status(plugin));
  }

  async invoke(plugin, capability, args = {}) {
    const mode = plugin.policy?.[capability];
    if (!mode) throw new AppError('CAPABILITY_NOT_GRANTED', '插件没有该操作能力。');
    if (mode === 'deny') throw new AppError('POLICY_DENIED', '该操作已被插件规则禁止。');
    if (mode === 'confirm' && !args.policyApproved) throw new AppError('CONFIRMATION_REQUIRED', '该操作需要桌面确认。', { capability });
    const runtime = this.runtime(plugin);
    if (plugin.pluginType === 'mysql') {
      if (capability === 'describe') return args.table ? runtime.describeTable(plugin, args.table) : runtime.listTables(plugin, args);
      if (capability === 'select') return runtime.queryReadonly(plugin, args.sql, args.params);
      if (capability === 'explain') return runtime.explain(plugin, args.sql, args.params);
    }
    if (plugin.pluginType === 'redis') {
      if (capability === 'scan') return runtime.scan(plugin, args);
      if (capability === 'read') return runtime.read(plugin, args);
      if (capability === 'ttl') return runtime.ttl(plugin, args);
    }
    throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '该插件操作尚未实现。');
  }

  async closeAll() {
    await Promise.all(Object.values(this.runtimes).map((runtime) => runtime.closeAll()));
  }
}
