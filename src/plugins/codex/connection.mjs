import { canonicalize,digest,issue,configurationResult,adapterValidate } from '../../plugin-connection-utils.mjs';
import { classifyChangedPath } from '../../plugin-change-policy.mjs';
export const codexAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const issues = [];
    if (!['chatgpt','custom'].includes(plugin.target?.authMode)) issues.push(issue('target.authMode','REQUIRED','请选择登录方式。'));
    if (plugin.target?.authMode === 'custom') for (const field of ['baseUrl','model']) if (!plugin.target[field]) issues.push(issue(`target.${field}`,'REQUIRED','请填写模型服务地址和模型 ID。'));
    return configurationResult(issues);
  },
  resourceScope:(_plugin,{verified = false} = {}) => ({state:verified ? 'verified' : 'selected-unverified',kind:'local-agent'}),
  dependencyRefs:() => [],credentialIdentity:plugin => canonicalize({pluginType:'codex',target:plugin.target}),
  validationDigest(plugin,purpose) { return digest({purpose,identity:this.credentialIdentity(plugin)}); },
  classifyChangedPath:(value,context) => classifyChangedPath('codex',value,context),validate:adapterValidate('codex'),
});
