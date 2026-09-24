import { builtinPluginRegistry } from './plugins/builtins.mjs';
import { AppError } from './errors.mjs';

export class PluginManager {
  constructor({ serverRuntime, mysqlRuntime, redisRuntime, runtimes = null, registry = builtinPluginRegistry }) {
    this.registry = registry;
    this.runtimes = runtimes ?? { server: serverRuntime, mysql: mysqlRuntime, redis: redisRuntime };
  }

  runtime(plugin) {
    this.registry.get(plugin.pluginType);
    const runtime = Object.hasOwn(this.runtimes, plugin.pluginType) ? this.runtimes[plugin.pluginType] : null;
    if (!runtime) throw new AppError('PLUGIN_TYPE_UNSUPPORTED', '插件类型暂不支持。');
    return runtime;
  }

  status(plugin) {
    return this.runtime(plugin).status(plugin);
  }

  connect(plugin, secrets = {}, options = {}) {
    return this.runtime(plugin).connect(plugin, secrets, options);
  }

  disconnect(plugin, reason) {
    return this.runtime(plugin).disconnect(plugin, reason);
  }

  forceDisconnect(plugin, reason = 'forced-disconnect', options = {}) {
    const runtime = this.runtime(plugin);
    return typeof runtime.forceDisconnect === 'function'
      ? runtime.forceDisconnect(plugin, reason, options)
      : runtime.disconnect(plugin, reason);
  }

  health(plugin) {
    const runtime = this.runtime(plugin);
    return typeof runtime.health === 'function' ? runtime.health(plugin) : Promise.resolve(runtime.status(plugin));
  }

  async invoke(plugin, capability, args = {}, options = {}) {
    const runtime = this.runtime(plugin);
    if (this.registry.capabilityRule(plugin.pluginType, capability).decision === 'deny') {
      throw new AppError('CAPABILITY_NOT_IMPLEMENTED', '该插件操作尚未实现。');
    }
    return this.registry.get(plugin.pluginType).invoke({plugin, capability, args, runtime, options});
  }

  async closeAll() {
    await Promise.all(Object.values(this.runtimes).map((runtime) => runtime.closeAll()));
  }
}
