import { canonicalize, digest, issue, commonTargetIssues, transportIssues, tlsIssues, configurationResult, dependencyRefs, targetIdentity, adapterValidate } from '../../plugin-connection-utils.mjs';
import { classifyChangedPath } from '../../plugin-change-policy.mjs';

function redisCluster(plugin) {
  return plugin?.mode === 'cluster' || plugin?.cluster === true || plugin?.target?.cluster === true;
}

export const redisAdapter = Object.freeze({
  assessConfiguration(plugin) {
    const rawDb = plugin?.target?.db ?? 0;
    const db = Number(rawDb);
    const issues = [
      ...commonTargetIssues(plugin,6379,'Redis'),
      ...(transportIssues(plugin?.transport)),
      ...(tlsIssues(plugin?.tls)),
      !Number.isInteger(db) || db < 0 || db > 15
        ? issue('target.db','INVALID_REDIS_DB','Redis Logical DB 必须在 0 到 15 之间。')
        : null,
      redisCluster(plugin) && Number.isInteger(db) && db !== 0
        ? issue('target.db','REDIS_CLUSTER_DB_UNSUPPORTED','Redis Cluster 只支持 Logical DB 0。')
        : null,
    ];
    return configurationResult(issues);
  },
  resourceScope(plugin,{verified = false} = {}) {
    const value = plugin?.target?.db === undefined ? 0 : Number(plugin.target.db);
    return {state:verified ? 'verified' : 'selected-unverified',kind:'redis-logical-db',value};
  },
  dependencyRefs,
  credentialIdentity(plugin) {
    return canonicalize({
      pluginType:'redis',
      target:targetIdentity(plugin?.target,{excludeDatabase:true,excludeDb:true}),
      username:plugin?.auth?.username ?? '',
      authType:plugin?.auth?.type ?? 'password',
      transport:plugin?.transport ?? {kind:'direct'},
      tls:plugin?.tls ?? {mode:'disabled'},
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
    return classifyChangedPath('redis',path,context);
  },
  validate:adapterValidate('redis'),
});
