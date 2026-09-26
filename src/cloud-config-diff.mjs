import { isDeepStrictEqual } from 'node:util';

// Only these known non-secret fields may cross the desktop boundary as values.
// Free-form runbooks, questions, commands, policy and credential material never do.
const FIELDS = {
  displayName: '插件名称', pluginType: '插件类型',
  'target.host': '主机', 'target.port': '端口', 'target.database': '数据库', 'target.db': 'Logical DB',
  'target.addressFamily': '地址策略', 'target.hostKeyFingerprint': '主机指纹', 'target.dockerSocket': 'Docker 套接字',
  'auth.type': '认证方式', 'auth.username': '用户名',
  'transport.kind': '连接路径', 'transport.serverPluginInstanceId': '隧道服务器',
  'uplink.type': '上游连接', 'tls.mode': 'TLS 模式', 'tunnelProvider': '提供隧道',
};
const TYPE_LABELS = { production: '生产', test: '测试', unspecified: '未标注' };
const LIMIT = 200;
const text = value => value === undefined || value === null ? '未设置'
  : typeof value === 'boolean' ? value ? '开启' : '关闭'
  : ['string','number'].includes(typeof value) ? String(value).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200) : '已配置';
const get = (object,path) => path.split('.').reduce((value,key) => value?.[key],object);
const byId = (items,key) => new Map((items ?? []).map(item => [key(item),item]));

export function cloudProjectFieldDiff(before, after) {
  const fields = [];
  let fieldsOmitted = 0;
  function add(scope, field, a, b, redacted = false) {
    if (isDeepStrictEqual(a,b)) return;
    if (fields.length >= LIMIT) { fieldsOmitted++; return; }
    fields.push({ scope:text(scope), field, before:redacted ? '内容不展示' : text(a), after:redacted ? '已变化' : text(b), redacted });
  }
  add('项目','名称',before?.name,after?.name);
  add('项目','环境顺序',before?.environments.map(e => e.environmentId) ?? [],after?.environments.map(e => e.environmentId) ?? [],true);
  const oldEnvs = byId(before?.environments,e => e.environmentId), newEnvs = byId(after?.environments,e => e.environmentId);
  for (const id of new Set([...oldEnvs.keys(),...newEnvs.keys()])) {
    const a = oldEnvs.get(id), b = newEnvs.get(id), scope = `环境 · ${b?.name ?? a.name}`;
    if (!a || !b) add(scope,'环境',a ? '存在' : '不存在',b ? '存在' : '不存在');
    add(scope,'名称',a?.name,b?.name);
    add(scope,'类型',TYPE_LABELS[a?.environmentType ?? 'unspecified'],TYPE_LABELS[b?.environmentType ?? 'unspecified']);
    add(scope,'运维说明',a?.runbook ?? '',b?.runbook ?? '',true);
    add(scope,'快捷提问',a?.questions ?? [],b?.questions ?? [],true);
    add(scope,'插件顺序',a?.plugins.map(p => p.config.pluginInstanceId) ?? [],b?.plugins.map(p => p.config.pluginInstanceId) ?? [],true);
    const oldPlugins = byId(a?.plugins,p => p.config.pluginInstanceId), newPlugins = byId(b?.plugins,p => p.config.pluginInstanceId);
    for (const pluginId of new Set([...oldPlugins.keys(),...newPlugins.keys()])) {
      const oldPlugin = oldPlugins.get(pluginId), newPlugin = newPlugins.get(pluginId);
      const pluginScope = `${b?.name ?? a.name} / ${newPlugin?.config.displayName ?? oldPlugin.config.displayName}`;
      if (!oldPlugin || !newPlugin) add(pluginScope,'插件',oldPlugin ? '存在' : '不存在',newPlugin ? '存在' : '不存在');
      for (const [path,label] of Object.entries(FIELDS)) add(pluginScope,label,get(oldPlugin?.config,path),get(newPlugin?.config,path));
      // Summarize everything outside the allowlist, without exposing arbitrary text.
      const rest = config => {
        const value = structuredClone(config ?? {});
        delete value.pluginInstanceId;
        for (const path of Object.keys(FIELDS)) {
          const keys = path.split('.'), leaf = keys.pop();
          const parent = keys.reduce((item,key) => item?.[key],value);
          if (parent) delete parent[leaf];
        }
        return value;
      };
      add(pluginScope,'其他配置',rest(oldPlugin?.config),rest(newPlugin?.config),true);
      add(pluginScope,'凭据',oldPlugin?.secrets ?? {},newPlugin?.secrets ?? {},true);
    }
  }
  return { fields, fieldsOmitted };
}
