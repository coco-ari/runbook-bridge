import { AppError } from './errors.mjs';

const CONNECTION_PURPOSES = new Set(['tls-probe','server-auth','resource-access','health-check']);

export class PluginValidationRuntime {
  constructor({pluginManager,mysqlRuntime} = {}) {
    this.pluginManager = pluginManager;
    this.mysqlRuntime = mysqlRuntime;
    this.operations = new Map();
  }

  assertDiagnosticDraft(draft,operationId) {
    if (!draft?.pluginInstanceId?.startsWith('diagnostic-edit-') || !String(operationId ?? '')) {
      throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE','临时验证命名空间无效。');
    }
  }

  async validate(payload) {
    const {
      pluginType,draft,purpose,resolvedSecrets = {},signal,operationId,
      editSessionId,draftGeneration,configDigest,
    } = payload;
    this.assertDiagnosticDraft(draft,operationId);
    if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。');
    const operation = {operationId,draft,purpose,connected:false};
    this.operations.set(operationId,operation);

    if (purpose === 'resource-discovery') {
      if (pluginType !== 'mysql' || typeof this.mysqlRuntime?.listDatabases !== 'function') {
        throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE','当前插件不支持资源发现。');
      }
      return this.mysqlRuntime.listDatabases(draft,resolvedSecrets,{
        signal,operationId,editSessionId,draftGeneration,configDigest,
      });
    }
    if (!CONNECTION_PURPOSES.has(purpose)) {
      throw new AppError('INVALID_ARGUMENT','验证用途无效。');
    }
    await this.pluginManager.connect(draft,resolvedSecrets,{
      signal,attemptToken:operationId,validationPurpose:purpose,
    });
    operation.connected = true;
    if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。');
    const health = await this.pluginManager.health(draft);
    if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','验证已取消。');
    return {...health,connected:true,diagnosticOnly:true,purpose};
  }

  async cleanup(draft,reason = 'validation-complete',operationId = null) {
    const operation = this.operations.get(operationId);
    if (!operation || operation.draft.pluginInstanceId !== draft?.pluginInstanceId) return {cleaned:false};
    this.operations.delete(operationId);
    const connectionPurpose = CONNECTION_PURPOSES.has(operation.purpose);
    if (!connectionPurpose) return {cleaned:true,connected:false};
    if (typeof this.pluginManager?.forceDisconnect === 'function') {
      await this.pluginManager.forceDisconnect(operation.draft,reason,{attemptToken:operationId});
    } else {
      await this.pluginManager?.disconnect?.(operation.draft,reason);
    }
    return {cleaned:true,connected:operation.connected};
  }
}
