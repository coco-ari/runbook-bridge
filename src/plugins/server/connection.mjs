import { canonicalize, digest, hasText, issue, commonTargetIssues, portIssue, configurationResult, targetIdentity, adapterValidate, UPLINKS } from '../../plugin-connection-utils.mjs';
import { classifyChangedPath } from '../../plugin-change-policy.mjs';

export const serverAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const authType = plugin?.auth?.type ?? 'password';
    const uplinkType = plugin?.uplink?.type ?? 'direct';
    const issues = [
      ...commonTargetIssues(plugin,22,'SSH'),
      !hasText(plugin?.auth?.username) ? issue('auth.username','REQUIRED','请输入 SSH 用户名。') : null,
      !['password','privateKey','agent'].includes(authType)
        ? issue('auth.type','INVALID_AUTH_TYPE','SSH 认证方式无效。')
        : null,
      authType === 'privateKey' && plugin?.auth?.privateKeySource !== 'vault' && !hasText(plugin?.auth?.privateKeyPath)
        ? issue('auth.privateKeyPath','REQUIRED','请选择 SSH 私钥文件。')
        : null,
      !UPLINKS.has(uplinkType) ? issue('uplink.type','INVALID_TRANSPORT','SSH 上行路径无效。') : null,
      ['socks5','http'].includes(uplinkType) && !hasText(plugin?.uplink?.host)
        ? issue('uplink.host','REQUIRED','请输入代理主机地址。')
        : null,
      ...(['socks5','http'].includes(uplinkType)
        ? [portIssue(plugin?.uplink?.port,'uplink.port','代理')]
        : []),
      uplinkType === 'windowsVpn' && !hasText(plugin?.uplink?.interfaceAlias)
        ? issue('uplink.interfaceAlias','REQUIRED','请选择 系统 VPN 网卡。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope() {
    return {state:'not-required',kind:null,value:null};
  },
  dependencyRefs() {
    return [];
  },
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'server',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      privateKeyPath:plugin?.auth?.privateKeyPath,
      ...(plugin?.auth?.privateKeySource === 'vault' ? {privateKeySource:'vault'} : {}),
      agentSocket:plugin?.auth?.agentSocket,
      uplink:plugin?.uplink ?? {type:'direct'},
    });
  },
  validationDigest(plugin,purpose) {
    return digest({purpose,identity:this.credentialIdentity(plugin)});
  },
  classifyChangedPath(path,context) {
    return classifyChangedPath('server',path,context);
  },
  validate:adapterValidate('server'),
});
