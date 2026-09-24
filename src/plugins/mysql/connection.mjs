import { canonicalize, digest, hasText, issue, commonTargetIssues, transportIssues, tlsIssues, configurationResult, dependencyRefs, targetIdentity, adapterValidate } from '../../plugin-connection-utils.mjs';
import { classifyChangedPath } from '../../plugin-change-policy.mjs';

export const mysqlAdapter = Object.freeze({
  assessConfiguration(plugin,purpose = 'connection') {
    const databaseRequired = !['tls-probe','server-auth','resource-discovery'].includes(purpose);
    const issues = [
      ...commonTargetIssues(plugin,3306,'MySQL'),
      !hasText(plugin?.auth?.username) ? issue('auth.username','REQUIRED','请输入 MySQL 用户名。') : null,
      ...(transportIssues(plugin?.transport)),
      ...(tlsIssues(plugin?.tls)),
      databaseRequired && !hasText(plugin?.target?.database)
        ? issue('target.database','REQUIRED','请选择或输入 MySQL 数据库。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope(plugin,{verified = false} = {}) {
    const database = String(plugin?.target?.database ?? '').trim();
    if (!database) return {state:'missing',kind:'mysql-database',value:null};
    return {state:verified ? 'verified' : 'selected-unverified',kind:'mysql-database',value:database};
  },
  dependencyRefs,
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'mysql',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      transport:plugin?.transport ?? {kind:'direct'},
      tls:plugin?.tls ?? {mode:'preferred'},
    });
  },
  validationDigest(plugin,purpose) {
    const includeResource = !['tls-probe','server-auth','resource-discovery'].includes(purpose);
    return digest({
      purpose,
      identity:this.credentialIdentity(plugin),
      ...(includeResource ? {resource:this.resourceScope(plugin).value} : {}),
    });
  },
  classifyChangedPath(path,context) {
    return classifyChangedPath('mysql',path,context);
  },
  validate:adapterValidate('mysql'),
});
