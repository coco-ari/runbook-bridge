import { canonicalize, digest, issue, configurationResult, adapterValidate } from '../../plugin-connection-utils.mjs';
import { classifyChangedPath } from '../../plugin-change-policy.mjs';
import { normalizeServiceUrl, SOURCE_PROJECT } from '../../source-protocol.mjs';

export const sourceAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const issues = [];
    try { if (!normalizeServiceUrl(plugin.target?.serviceUrl)) issues.push(issue('target.serviceUrl','REQUIRED','请输入源码服务地址。')); }
    catch { issues.push(issue('target.serviceUrl','INVALID_SOURCE_URL','源码服务地址无效。')); }
    if (!SOURCE_PROJECT.test(plugin.target?.remoteProjectId ?? '')) issues.push(issue('target.remoteProjectId',plugin.target?.remoteProjectId ? 'INVALID_SOURCE_PROJECT' : 'REQUIRED','请输入有效的源码项目 ID。'));
    return configurationResult(issues);
  },
  resourceScope(plugin,{verified = false} = {}) { return {state:verified ? 'verified' : 'selected-unverified',kind:'source-project',value:plugin.target?.remoteProjectId}; },
  dependencyRefs:() => [],
  credentialIdentity:plugin => canonicalize({pluginType:'source',target:plugin.target}),
  validationDigest(plugin,purpose) { return digest({purpose,identity:this.credentialIdentity(plugin)}); },
  classifyChangedPath:(path,context) => classifyChangedPath('source',path,context),
  validate:adapterValidate('source'),
});
