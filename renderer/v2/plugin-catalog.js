const entries = [
  {
    type:'server',
    label:'Server',
    icon:'server',
    summary:'运维、日志与隧道',
    defaultPort:22,
    capabilities:{resourceDiscovery:false,resourceTarget:false,tls:false,transport:false},
    validationPurpose:{validate:'server-auth',tls:'tls-probe'},
  },
  {
    type:'mysql',
    label:'MySQL',
    icon:'db',
    summary:'固定一个数据库',
    defaultPort:3306,
    capabilities:{resourceDiscovery:true,resourceTarget:true,tls:true,transport:true},
    validationPurpose:{discover:'resource-discovery',validate:'resource-access',tls:'tls-probe'},
  },
  {
    type:'redis',
    label:'Redis',
    icon:'redis',
    summary:'固定一个逻辑 DB',
    defaultPort:6379,
    capabilities:{resourceDiscovery:false,resourceTarget:true,tls:true,transport:true},
    validationPurpose:{validate:'resource-access',tls:'tls-probe'},
  },
];

export const pluginCatalog = Object.freeze(entries.map((entry) => Object.freeze({
  ...entry,
  capabilities:Object.freeze({...entry.capabilities}),
  validationPurpose:Object.freeze({...entry.validationPurpose}),
})));

export const pluginCatalogByType = Object.freeze(Object.fromEntries(
  pluginCatalog.map((entry) => [entry.type,entry]),
));

export const pluginTypeNames = Object.freeze(Object.fromEntries(
  pluginCatalog.map((entry) => [entry.type,entry.label]),
));

export const pluginTypeIcons = Object.freeze(Object.fromEntries(
  pluginCatalog.map((entry) => [entry.type,entry.icon]),
));

export function pluginDefinition(type) {
  return pluginCatalogByType[type] ?? null;
}
