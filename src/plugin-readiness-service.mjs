import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { pluginAgentFingerprint, pluginConnectionFingerprint } from './plugin-change-classifier.mjs';

const VALIDATION_PURPOSES = [
  'tls-probe',
  'server-auth',
  'resource-discovery',
  'resource-access',
  'health-check',
];
const CREDENTIAL_STATES = new Set(['available','missing','unreadable','unknown']);
const CREDENTIAL_INTENTS = new Set(['unchanged','replace','rebind-existing','clear-explicit']);
const PERSISTENCE_STATES = new Set(['committed','saved-draft','edit-draft']);
const VALIDATION_STATES = new Set(['untested','running','stale','valid','failed','cancelled']);

function normalizedRuntime(plugin,runtimeSnapshot = {}) {
  const source = runtimeSnapshot?.plugins?.[plugin.pluginInstanceId] ?? {};
  const rawPhase = source.phase ?? 'disconnected';
  const phase = rawPhase === 'waitingDependency'
    ? 'connecting'
    : rawPhase === 'blocked'
      ? 'error'
      : ['disconnected','connecting','connected','disconnecting','reconnecting','error'].includes(rawPhase)
        ? rawPhase
        : 'disconnected';
  return {
    phase,
    reason:source.reason ?? null,
    sequence:Number.isInteger(source.sequence)
      ? source.sequence
      : Number.isInteger(runtimeSnapshot?.sequence) ? runtimeSnapshot.sequence : 0,
    operationId:source.operationId ?? null,
  };
}

function publicError(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    code:String(value.code ?? 'INTERNAL_ERROR'),
    message:String(value.message ?? '操作失败。'),
    ...(value.field ? {field:String(value.field)} : {}),
  };
}

function publicWarning(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...(value.code ? {code:String(value.code)} : {}),
    ...(value.message ? {message:String(value.message)} : {}),
  };
}

function normalizedValidation(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    state:VALIDATION_STATES.has(value.state) ? value.state : 'untested',
    operationId:value.operationId ?? null,
    draftGeneration:Number.isInteger(value.draftGeneration) ? value.draftGeneration : 0,
    configDigest:typeof value.configDigest === 'string' ? value.configDigest : null,
    startedAt:value.startedAt ?? null,
    completedAt:value.completedAt ?? null,
    error:publicError(value.error),
  };
}

function normalizedValidations(values = {}) {
  return Object.fromEntries(VALIDATION_PURPOSES.map((purpose) => [purpose,normalizedValidation(values[purpose])]));
}

function assessDependency(plugin,environmentPlugins,adapter) {
  const [providerPluginInstanceId = null] = adapter.dependencyRefs(plugin);
  if (plugin?.transport?.kind === 'serverTunnel' && !providerPluginInstanceId) {
    return {state:'provider-missing',providerPluginInstanceId:null};
  }
  if (!providerPluginInstanceId) return {state:'ready',providerPluginInstanceId:null};
  const provider = environmentPlugins.find((item) => item.pluginInstanceId === providerPluginInstanceId);
  if (!provider || provider.pluginType !== 'server') {
    return {state:'provider-missing',providerPluginInstanceId};
  }
  if (provider.projectId !== plugin.projectId || provider.environmentId !== plugin.environmentId) {
    return {state:'provider-incomplete',providerPluginInstanceId};
  }
  if (provider.tunnelProvider === false) {
    return {state:'capability-disabled',providerPluginInstanceId};
  }
  const providerConfiguration = getPluginConnectionAdapter('server').assessConfiguration(provider,'connection');
  if (providerConfiguration.state !== 'complete') {
    return {state:'provider-incomplete',providerPluginInstanceId};
  }
  return {state:'ready',providerPluginInstanceId};
}

function providerRuntimeBlock(dependency,runtimeSnapshot = {}) {
  if (dependency.state !== 'ready' || !dependency.providerPluginInstanceId) return null;
  const provider = runtimeSnapshot?.plugins?.[dependency.providerPluginInstanceId];
  if (!provider || provider.phase === 'connected') return null;
  return {
    providerPluginInstanceId:dependency.providerPluginInstanceId,
    phase:provider.phase ?? 'disconnected',
    reason:provider.reason ?? null,
    operationId:provider.operationId ?? null,
  };
}

function agentIssue(code,message,field = null) {
  return {code,message,field};
}

function assessAgent({persistence,configuration,credential,dependency,resourceScope,runtime,providerBlock,edit,agentSummary}) {
  const issues = [];
  if (persistence.state !== 'committed') issues.push(agentIssue('PLUGIN_DRAFT_NOT_CONNECTABLE','草稿不能用于 Agent 操作。'));
  if (configuration.state === 'invalid') {
    issues.push(agentIssue('PLUGIN_CONFIGURATION_INVALID','插件配置无效。',configuration.issues[0]?.field ?? null));
  } else if (configuration.state === 'incomplete') {
    issues.push(agentIssue('PLUGIN_CONFIGURATION_INCOMPLETE','插件配置不完整。',configuration.issues[0]?.field ?? null));
  }
  if (credential.state === 'missing') issues.push(agentIssue('PLUGIN_CREDENTIAL_MISSING','插件凭据缺失。'));
  if (credential.state === 'unreadable') issues.push(agentIssue('PLUGIN_CREDENTIAL_UNREADABLE','插件凭据不可读。'));
  if (credential.state === 'unknown') issues.push(agentIssue('PLUGIN_CREDENTIAL_UNKNOWN','尚未确认插件凭据状态。'));
  if (dependency.state !== 'ready') issues.push(agentIssue('PLUGIN_DEPENDENCY_BLOCKED','插件依赖尚未就绪。'));
  if (providerBlock) issues.push(agentIssue('PLUGIN_PROVIDER_RUNTIME_BLOCKED','Provider 当前未连接。'));
  if (resourceScope.state === 'missing') issues.push(agentIssue('PLUGIN_RESOURCE_SELECTION_REQUIRED','请选择固定资源。'));
  if (resourceScope.state === 'selected-unverified') {
    issues.push(agentIssue('PLUGIN_RESOURCE_VALIDATION_REQUIRED','固定资源尚未通过正式连接验证。'));
  }
  if (runtime.phase !== 'connected') issues.push(agentIssue('PLUGIN_RUNTIME_DISCONNECTED','插件当前未连接。'));
  if (edit.state !== 'viewing') issues.push(agentIssue('PLUGIN_EDIT_BUSY','插件连接配置正在编辑。'));
  return {
    availability:issues.length ? 'unavailable' : 'ready',
    activity:['idle','busy'].includes(agentSummary?.activity) ? agentSummary.activity : 'idle',
    approval:['none','required','pending'].includes(agentSummary?.approval) ? agentSummary.approval : 'none',
    issues,
  };
}

function primaryStatus({persistence,credential,configuration,dependency,edit,runtime}) {
  if (persistence.blocking) {
    return {kind:'persistence-blocked',label:'配置存储需要恢复',action:'view-recovery'};
  }
  if (credential.state === 'unreadable') {
    return {kind:'credential-recovery',label:'凭据需要恢复',action:'view-recovery'};
  }
  if (configuration.state !== 'complete') {
    const count = configuration.issues.length;
    return {kind:'needs-configuration',label:`需要配置（${count} 项）`,action:'continue-configuration'};
  }
  if (dependency.state !== 'ready') {
    return {kind:'dependency-blocked',label:'依赖不可用',action:'view-provider'};
  }
  if (persistence.state !== 'committed') {
    return {kind:'draft',label:'草稿',action:'continue-configuration'};
  }
  if (edit.state === 'preparing') return {kind:'preparing',label:'正在准备修改',action:null};
  if (edit.state === 'editing') return {kind:'editing',label:'正在修改连接配置',action:null};
  if (edit.state === 'saving') return {kind:'saving',label:'正在保存',action:null};
  if (edit.state === 'restoring') return {kind:'restoring',label:'正在恢复连接',action:null};
  if (runtime.phase === 'connecting') return {kind:'connecting',label:'连接中',action:'cancel'};
  if (runtime.phase === 'reconnecting') return {kind:'reconnecting',label:'正在重连',action:'cancel'};
  if (runtime.phase === 'disconnecting') return {kind:'disconnecting',label:'正在断开',action:null};
  if (runtime.phase === 'error') {
    return {kind:'connection-error',label:`连接失败：${runtime.reason ?? '未知错误'}`,action:'retry'};
  }
  if (runtime.phase === 'connected') return {kind:'connected',label:'已连接',action:'disconnect'};
  return {kind:'disconnected',label:'未连接',action:'connect'};
}

export class PluginAssessmentService {
  assess({
    scope = null,
    plugin,
    environmentPlugins = null,
    credentialSummary = null,
    persistenceSummary = null,
    runtimeSnapshot = null,
    validationByPurpose = null,
    resourceVerified = undefined,
    agentSummary = null,
    editSummary = null,
  } = {}) {
    if (!plugin || typeof plugin !== 'object') throw new TypeError('Plugin is required for assessment');
    const adapter = getPluginConnectionAdapter(plugin.pluginType);
    const configuration = adapter.assessConfiguration(plugin,'connection');
    const plugins = Array.isArray(environmentPlugins) ? environmentPlugins : [plugin];
    let runtime = normalizedRuntime(plugin,runtimeSnapshot ?? {});
    let legacyPhase = runtimeSnapshot?.plugins?.[plugin.pluginInstanceId]?.phase ?? runtime.phase;
    const persistenceState = PERSISTENCE_STATES.has(persistenceSummary?.state)
      ? persistenceSummary.state
      : 'committed';
    const persistence = {
      state:persistenceState,
      dirty:Boolean(persistenceSummary?.dirty),
      warning:publicWarning(persistenceSummary?.warning),
      ...(persistenceSummary?.blocking || persistenceSummary?.warning?.blocking ? {blocking:true} : {}),
    };
    if (persistenceState !== 'committed') {
      runtime = {...runtime,phase:'disconnected',reason:'DRAFT_NOT_CONNECTABLE',operationId:null};
      legacyPhase = 'disconnected';
    }
    const credential = {
      state:CREDENTIAL_STATES.has(credentialSummary?.state) ? credentialSummary.state : 'unknown',
      editIntent:CREDENTIAL_INTENTS.has(credentialSummary?.editIntent) ? credentialSummary.editIntent : 'unchanged',
    };
    const dependency = assessDependency(plugin,plugins,adapter);
    const verified = resourceVerified === undefined ? runtime.phase === 'connected' : Boolean(resourceVerified);
    const resourceScope = adapter.resourceScope(plugin,{verified});
    const edit = {
      state:editSummary?.state ?? 'viewing',
      editSessionId:editSummary?.editSessionId ?? null,
    };
    const providerBlock = providerRuntimeBlock(dependency,runtimeSnapshot ?? {});
    const agent = assessAgent({
      persistence,
      configuration,
      credential,
      dependency,
      resourceScope,
      runtime,
      providerBlock,
      edit,
      agentSummary,
    });
    const assessment = {
      scope:{
        projectId:scope?.projectId ?? plugin.projectId,
        environmentId:scope?.environmentId ?? plugin.environmentId,
        pluginInstanceId:scope?.pluginInstanceId ?? plugin.pluginInstanceId,
      },
      recordRevision:plugin.revision ?? 0,
      connectionFingerprint:pluginConnectionFingerprint(plugin),
      agentFingerprint:pluginAgentFingerprint(plugin),
      persistence,
      configuration,
      credential,
      dependency,
      resourceScope,
      validationByPurpose:normalizedValidations(validationByPurpose ?? {}),
      runtime,
      providerRuntimeBlock:providerBlock,
      agent,
      edit,
      primaryStatus:null,
      configState:persistenceState === 'committed' && configuration.state === 'complete' ? 'ready' : 'draft',
      phase:legacyPhase,
    };
    assessment.primaryStatus = primaryStatus(assessment);
    return assessment;
  }
}

const defaultAssessmentService = new PluginAssessmentService();

export function assessPlugin(input) {
  return defaultAssessmentService.assess(input);
}

export const pluginReadinessInternals = {
  VALIDATION_PURPOSES,
  assessDependency,
  normalizedRuntime,
  primaryStatus,
  providerRuntimeBlock,
};
