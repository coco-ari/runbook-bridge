import crypto from 'node:crypto';
import { AppError, toPublicError } from './errors.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { workspaceInternals } from './workspace-store.mjs';

const PROBE_PURPOSES = new Set([
  'resource-discovery',
  'resource-access',
  'server-auth',
  'tls-probe',
]);
const PLUGIN_TYPES = new Set(['server','mysql','redis']);
const PURPOSES_BY_PLUGIN_TYPE = Object.freeze({
  server:new Set(['server-auth']),
  mysql:new Set(['resource-discovery','resource-access','tls-probe']),
  redis:new Set(['resource-access','tls-probe']),
});
const SECRET_DRAFT_FIELDS = new Set([
  'password',
  'proxypassword',
  'privatekeypassphrase',
  'tlspassphrase',
  'capem',
  'clientcertpem',
  'clientkeypem',
  'ciphertext',
  'secrets',
  'temporarysecrets',
]);

function requiredString(value,label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AppError('INVALID_ARGUMENT',`${label}无效。`);
  }
  return normalized;
}

function assertSecretFreeDraft(draft) {
  const pending = [draft];
  const visited = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (visited.has(value)) continue;
    visited.add(value);
    for (const [key,item] of Object.entries(value)) {
      if (SECRET_DRAFT_FIELDS.has(key.toLocaleLowerCase('en-US'))) {
        throw new AppError('INVALID_ARGUMENT','插件探针草稿不能包含凭据或密文字段。',{field:key});
      }
      if (item && typeof item === 'object') pending.push(item);
    }
  }
}

function copyTemporarySecrets(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGUMENT','临时凭据格式无效。');
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key,item]) => [key,String(item ?? '')])
      .filter(([,item]) => item.length > 0),
  );
}

function clearSecrets(value) {
  for (const key of Object.keys(value ?? {})) value[key] = '';
}

function contextFor(record) {
  return {
    projectId:record.projectId,
    environmentId:record.environmentId,
    formInstanceId:record.formInstanceId,
    requestId:record.requestId,
    operationId:record.operationId,
    purpose:record.purpose,
    draftGeneration:record.draftGeneration,
    ...(record.sequence === null ? {} : {sequence:record.sequence}),
    configDigest:record.configDigest,
  };
}

function envelopeFor(record,state,result = null) {
  return {...contextFor(record),state,result};
}

function payloadCorrelation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const output = {};
  for (const key of ['projectId','environmentId','formInstanceId','requestId','purpose']) {
    const value = String(payload[key] ?? '').trim();
    if (value && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) output[key] = value;
  }
  if (Number.isInteger(payload.draftGeneration) && payload.draftGeneration >= 0) {
    output.draftGeneration = payload.draftGeneration;
  }
  if (Number.isInteger(payload.sequence) && payload.sequence >= 0) output.sequence = payload.sequence;
  return output;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise,resolve};
}

export class PluginProbeManager {
  constructor({
    workspaceStore,
    mutationCoordinator,
    credentialUseResolver,
    validationRuntime,
    configurationJournal = null,
  } = {}) {
    Object.assign(this,{
      workspaceStore,mutationCoordinator,credentialUseResolver,validationRuntime,configurationJournal,
    });
    this.requests = new Map();
    this.groups = new Map();
  }

  requestKey(ownerId,requestId) {
    return `${ownerId}\u0000${requestId}`;
  }

  groupKey(record) {
    return [
      record.ownerId,record.projectId,record.environmentId,record.formInstanceId,record.purpose,
    ].join('\u0000');
  }

  normalizeRequest(payload,ownerId,onProgress) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('INVALID_ARGUMENT','插件探针请求无效。');
    }
    const normalizedOwner = requiredString(ownerId,'探针所有者');
    const projectId = requiredString(payload.projectId,'项目标识');
    const environmentId = requiredString(payload.environmentId,'环境标识');
    const formInstanceId = requiredString(payload.formInstanceId,'表单实例标识');
    const requestId = requiredString(payload.requestId,'请求标识');
    const purpose = String(payload.purpose ?? '');
    if (!PROBE_PURPOSES.has(purpose)) throw new AppError('INVALID_ARGUMENT','插件探针用途无效。');
    if (!Number.isInteger(payload.draftGeneration) || payload.draftGeneration < 0) {
      throw new AppError('INVALID_ARGUMENT','插件草稿代次无效。');
    }
    const sequence = payload.sequence === undefined || payload.sequence === null
      ? null
      : payload.sequence;
    if (sequence !== null && (!Number.isInteger(sequence) || sequence < 0)) {
      throw new AppError('INVALID_ARGUMENT','插件探针序号无效。');
    }
    if (!payload.draft || typeof payload.draft !== 'object' || Array.isArray(payload.draft)) {
      throw new AppError('INVALID_ARGUMENT','插件探针草稿无效。');
    }
    assertSecretFreeDraft(payload.draft);
    const pluginType = String(payload.draft.pluginType ?? '');
    if (!PLUGIN_TYPES.has(pluginType)) throw new AppError('INVALID_ARGUMENT','插件类型无效。');
    const operationId = crypto.randomUUID();
    const displayName = String(payload.draft.displayName ?? '').trim() || pluginType;
    const candidate = workspaceInternals.normalizePlugin({
      ...payload.draft,
      projectId,
      environmentId,
      pluginType,
      displayName,
      pluginInstanceId:`diagnostic-edit-${operationId}`,
      ...(purpose === 'resource-discovery' && pluginType === 'mysql'
        ? {target:{...(payload.draft.target ?? {}),database:''}}
        : {}),
    },{projectId,environmentId});
    const adapter = getPluginConnectionAdapter(pluginType);
    const configDigest = adapter.validationDigest(candidate,purpose);
    if (!PURPOSES_BY_PLUGIN_TYPE[pluginType]?.has(purpose)) {
      throw new AppError('PLUGIN_VALIDATION_UNAVAILABLE','当前插件不支持该探针用途。',{
        ...payloadCorrelation(payload),operationId,configDigest,
      });
    }
    if (Object.hasOwn(payload,'credentialIntent') || Object.hasOwn(payload,'oneTimeGrant')) {
      throw new AppError('INVALID_ARGUMENT','临时探针不能复用已保存凭据。',{
        ...payloadCorrelation(payload),operationId,configDigest,
      });
    }
    const configuration = adapter.assessConfiguration(candidate,purpose);
    if (configuration.state !== 'complete') {
      const code = configuration.state === 'invalid'
        ? 'PLUGIN_CONFIGURATION_INVALID'
        : 'PLUGIN_CONFIGURATION_INCOMPLETE';
      throw new AppError(code,configuration.issues[0]?.message ?? '插件配置不完整。',{
        field:configuration.issues[0]?.field ?? null,
        issues:configuration.issues,
        projectId,
        environmentId,
        formInstanceId,
        requestId,
        purpose,
        draftGeneration:payload.draftGeneration,
        ...(sequence === null ? {} : {sequence}),
        operationId,
        configDigest,
      });
    }
    return {
      ownerId:normalizedOwner,projectId,environmentId,formInstanceId,requestId,purpose,
      draftGeneration:payload.draftGeneration,sequence,operationId,configDigest,
      adapter,candidate,runtimeDraft:candidate,
      temporarySecrets:copyTemporarySecrets(payload.temporarySecrets),
      controller:new AbortController(),
      state:'queued',
      terminalError:null,
      terminalProgressSent:false,
      onProgress:typeof onProgress === 'function' ? onProgress : null,
    };
  }

  emit(record,state,{result = undefined,error = undefined} = {}) {
    try {
      record.onProgress?.({
        ...contextFor(record),
        state,
        ...(result === undefined ? {} : {result:structuredClone(result)}),
        ...(error === undefined ? {} : {error:structuredClone(error)}),
      });
    } catch {
      // A renderer closing during a probe cannot affect ownership or cleanup.
    }
  }

  stopRecord(record,state,code,message) {
    if (!record || !['queued','running'].includes(record.state)) return false;
    const error = new AppError(code,message);
    record.state = state;
    record.terminalError = error;
    record.controller.abort(error);
    record.terminalProgressSent = true;
    this.emit(record,state,{error:toPublicError(error)});
    return true;
  }

  probePluginDraft(payload,{ownerId,onProgress} = {}) {
    let record;
    try {
      record = this.normalizeRequest(payload,ownerId,onProgress);
    } catch (error) {
      const publicError = toPublicError(error);
      const details = publicError.details && typeof publicError.details === 'object'
        ? publicError.details
        : {};
      throw new AppError(publicError.code,publicError.message,{
        ...payloadCorrelation(payload),
        ...details,
      });
    }
    const requestKey = this.requestKey(record.ownerId,record.requestId);
    if (this.requests.has(requestKey)) {
      throw new AppError('PLUGIN_VALIDATION_STALE','请求标识正在使用中。',contextFor(record));
    }
    const groupKey = this.groupKey(record);
    const previous = this.groups.get(groupKey) ?? null;
    if (previous && record.sequence !== null && previous.sequence !== null
      && record.sequence <= previous.sequence) {
      throw new AppError('PLUGIN_VALIDATION_STALE','插件探针请求序号已经过期。',contextFor(record));
    }
    const settled = deferred();
    record.groupKey = groupKey;
    record.settled = settled.promise;
    record.releaseSettled = settled.resolve;
    this.requests.set(requestKey,record);
    this.groups.set(groupKey,record);
    if (previous) {
      this.stopRecord(previous,'stale','PLUGIN_VALIDATION_STALE','新的插件探针请求已取代旧请求。');
    }
    record.completion = this.execute(record,previous);
    return record.completion;
  }

  async execute(record,previous) {
    let result;
    let failure = null;
    let resolvedSecrets = {};
    if (previous) await previous.settled;
    try {
      if (record.terminalError) throw record.terminalError;
      record.state = 'running';
      this.emit(record,'running');
      result = await this.mutationCoordinator.runEnvironmentOperation(
        record.projectId,
        record.environmentId,
        async () => {
          this.configurationJournal?.assertEnvironmentAvailable?.(
            record.projectId,record.environmentId,
          );
          await this.workspaceStore.getEnvironment(record.projectId,record.environmentId);
          if (record.terminalError || record.controller.signal.aborted) {
            throw record.terminalError ?? new AppError('PLUGIN_VALIDATION_CANCELLED','插件探针已取消。');
          }
          const resolved = await this.credentialUseResolver.resolve({
            committedPlugin:null,
            draft:record.candidate,
            credentialIntent:Object.keys(record.temporarySecrets).length ? 'replace' : 'unchanged',
            temporarySecrets:record.temporarySecrets,
            editSessionId:record.operationId,
            draftGeneration:record.draftGeneration,
            purpose:record.purpose,
            caller:'main',
          });
          if (!['temporary','none'].includes(resolved?.source)) {
            throw new AppError('CREDENTIAL_ACCESS_DENIED','临时探针不能读取或复用已保存凭据。');
          }
          resolvedSecrets = resolved.secrets ?? {};
          const value = await record.adapter.validate({
            draft:record.runtimeDraft,
            purpose:record.purpose,
            resolvedSecrets,
            runtimeFacade:this.validationRuntime,
            signal:record.controller.signal,
            editSessionId:record.formInstanceId,
            operationId:record.operationId,
            draftGeneration:record.draftGeneration,
            configDigest:record.configDigest,
            requestId:record.requestId,
          });
          if (record.terminalError || record.controller.signal.aborted
            || this.groups.get(record.groupKey) !== record) {
            throw record.terminalError
              ?? new AppError('PLUGIN_VALIDATION_STALE','插件探针结果已经过期。');
          }
          return value;
        },
        {ownerId:record.ownerId},
      );
      record.state = 'valid';
    } catch (error) {
      failure = record.terminalError ?? error;
      if (!['cancelled','stale'].includes(record.state)) record.state = 'failed';
    } finally {
      await Promise.resolve(this.validationRuntime.cleanup?.(
        record.runtimeDraft,
        `plugin-probe-${record.state}`,
        record.operationId,
      )).catch(() => undefined);
      clearSecrets(resolvedSecrets);
      clearSecrets(record.temporarySecrets);
      record.temporarySecrets = {};
      if (this.groups.get(record.groupKey) === record) this.groups.delete(record.groupKey);
      this.requests.delete(this.requestKey(record.ownerId,record.requestId));
      record.releaseSettled();
    }

    if (failure) {
      const publicError = toPublicError(failure);
      const details = publicError.details && typeof publicError.details === 'object'
        ? publicError.details
        : {};
      const decorated = new AppError(publicError.code,publicError.message,{
        ...details,
        ...contextFor(record),
        state:record.state,
      });
      if (!record.terminalProgressSent) this.emit(record,record.state,{error:toPublicError(decorated)});
      throw decorated;
    }
    const response = envelopeFor(record,'valid',result);
    this.emit(record,'valid',{result});
    return response;
  }

  cancelPluginProbe({requestId,formInstanceId = undefined} = {},{ownerId} = {}) {
    const normalizedOwner = requiredString(ownerId,'探针所有者');
    const normalizedRequest = requiredString(requestId,'请求标识');
    const record = this.requests.get(this.requestKey(normalizedOwner,normalizedRequest));
    if (!record || (formInstanceId !== undefined
      && record.formInstanceId !== requiredString(formInstanceId,'表单实例标识'))) {
      throw new AppError('PLUGIN_VALIDATION_STALE','插件探针已经结束或不属于当前窗口。');
    }
    if (!this.stopRecord(
      record,'cancelled','PLUGIN_VALIDATION_CANCELLED','插件探针已取消。',
    )) {
      throw new AppError('PLUGIN_VALIDATION_STALE','插件探针已经结束。',contextFor(record));
    }
    return {...envelopeFor(record,'cancelled',null),cancelled:true};
  }

  invalidateOwner(ownerId) {
    const normalizedOwner = String(ownerId ?? '');
    let invalidated = 0;
    for (const record of this.requests.values()) {
      if (record.ownerId !== normalizedOwner) continue;
      if (this.stopRecord(
        record,'cancelled','PLUGIN_VALIDATION_CANCELLED','探针所属窗口已关闭。',
      )) invalidated += 1;
    }
    return invalidated;
  }

  invalidateAll() {
    let invalidated = 0;
    for (const record of this.requests.values()) {
      if (this.stopRecord(
        record,'cancelled','PLUGIN_VALIDATION_CANCELLED','应用正在退出，插件探针已取消。',
      )) invalidated += 1;
    }
    return invalidated;
  }
}
