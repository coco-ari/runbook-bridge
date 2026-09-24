import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import ssh2 from 'ssh2';
import { sanitizePluginSnapshot, normalizePlugin, normalizeName } from './plugin-config-model.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';
import { normalizeQuickQuestionText, containsQuickQuestionCredential, QUICK_QUESTION_LIMIT } from './quick-questions.mjs';
import { CLOUD_MAX_BYTES, cloudError } from './cloud-config-crypto.mjs';

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONFIG_KEYS = new Set(['pluginType','pluginInstanceId','displayName','description','tags','displayOrder','target','auth','uplink','transport','tls','tunnelProvider','sources','actions','policy','limits','patterns','mode','cluster']);
export function canonicalCloud(value) {
  if (Array.isArray(value)) return value.map(canonicalCloud);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonicalCloud(value[key])]));
}
export function snapshotDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalCloud(value))).digest('hex');
}
export function configProjection(plugin) {
  return Object.fromEntries(Object.entries(sanitizePluginSnapshot(plugin)).filter(([key]) => CONFIG_KEYS.has(key)));
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw cloudError('FORMAT_INVALID','云配置结构包含不支持的字段。');
}
function id(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw cloudError('FORMAT_INVALID','云配置资源标识无效。');
  return value;
}
function list(value, max) {
  if (!Array.isArray(value) || value.length > max) throw cloudError('FORMAT_INVALID','云配置列表无效或超过数量限制。');
  return value;
}
function unique(values) {
  if (new Set(values).size !== values.length) throw cloudError('FORMAT_INVALID','云配置包含重复资源。');
}
function normalizeProject(input, vault) {
  object(input,['projectId','name','environments']);
  const projectId = id(input.projectId);
  const environments = list(input.environments,100).map(raw => {
    object(raw,['environmentId','name','runbook','questions','plugins']);
    const environmentId = id(raw.environmentId);
    if (typeof raw.runbook !== 'string' || Buffer.byteLength(raw.runbook) > 1024*1024) throw cloudError('FORMAT_INVALID','环境运维说明无效或过大。');
    const questions = list(raw.questions,QUICK_QUESTION_LIMIT).map(question => {
      object(question,['questionId','text']);
      if (typeof question.text !== 'string' || containsQuickQuestionCredential(question.text)) throw cloudError('FORMAT_INVALID','快捷提问内容无效。');
      return {questionId:id(question.questionId),text:normalizeQuickQuestionText(question.text)};
    });
    unique(questions.map(q => q.questionId));
    const plugins = list(raw.plugins,500).map(item => {
      object(item,['config','secrets']);
      object(item.config,[...CONFIG_KEYS]);
      if (!['server','mysql','redis'].includes(item.config.pluginType)) throw cloudError('FORMAT_UNSUPPORTED','云配置包含不支持的插件。');
      id(item.config.pluginInstanceId);
      if (item.config.auth?.privateKeyPath || item.config.auth?.agentSocket) throw cloudError('FORMAT_INVALID','云配置不能指定本机私钥路径或 Agent 套接字。');
      const config = normalizePlugin(item.config,{projectId,environmentId});
      if (snapshotDigest(item.config) !== snapshotDigest(configProjection(config))) throw cloudError('FORMAT_INVALID','云插件配置不是受支持的规范格式，已停止导入。');
      if (config.auth.type === 'privateKey' && config.auth.privateKeySource !== 'vault') throw cloudError('FORMAT_INVALID','云端私钥必须使用凭据库。');
      if (!item.secrets || typeof item.secrets !== 'object' || Array.isArray(item.secrets) || Object.values(item.secrets).some(v => typeof v !== 'string')) throw cloudError('FORMAT_INVALID','云配置凭据结构无效。');
      const secrets = vault.normalizeSecrets(config,item.secrets);
      if (secrets.privateKeyPem) {
        const parsed = ssh2.utils.parseKey(secrets.privateKeyPem,secrets.privateKeyPassphrase || undefined);
        if (parsed instanceof Error || !parsed?.isPrivateKey?.()) throw cloudError('PRIVATE_KEY_INVALID','SSH 私钥或口令无效。');
      }
      return {config:configProjection(config),secrets};
    });
    unique(plugins.map(p => p.config.pluginInstanceId));
    for (const {config} of plugins) {
      const providerId = config.transport?.kind === 'serverTunnel' ? config.transport.serverPluginInstanceId : null;
      if (providerId && !plugins.some(p => p.config.pluginInstanceId === providerId && p.config.pluginType === 'server' && p.config.tunnelProvider !== false)) throw cloudError('DEPENDENCY_INVALID','云配置的隧道依赖缺失或无效。');
    }
    return {environmentId,name:normalizeName(raw.name),runbook:raw.runbook,questions,plugins};
  });
  unique(environments.map(e => e.environmentId));
  unique(environments.map(e => e.name.normalize('NFKC').toLowerCase()));
  return {projectId,name:normalizeName(input.name),environments};
}
export function normalizeCloudSnapshot(value, vault) {
  if (Buffer.byteLength(JSON.stringify(value)) > CLOUD_MAX_BYTES) throw cloudError('TOO_LARGE','云配置内容过大。');
  object(value,['schemaVersion','projects']);
  if (value.schemaVersion !== 1) throw cloudError('FORMAT_UNSUPPORTED','不支持此云配置版本。');
  const projects = list(value.projects,200).map(project => normalizeProject(project,vault));
  unique(projects.map(p => p.projectId));
  return {schemaVersion:1,projects};
}

async function privateKeyFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024*1024) throw cloudError('PRIVATE_KEY_INVALID','私钥必须是最大 1 MiB 的普通文件。');
  const handle = await fs.open(file,'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw cloudError('STALE','私钥文件已变化，请重试。');
    const buffer = Buffer.alloc(1024*1024+1);
    try {
      const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
      if (bytesRead > 1024*1024) throw cloudError('PRIVATE_KEY_INVALID','SSH 私钥文件过大。');
      return buffer.subarray(0,bytesRead).toString('utf8');
    } finally { buffer.fill(0); }
  } finally { await handle.close(); }
}
export async function exportCloudProject(store,vault,projectId) {
  const project = await store.getProject(projectId);
  const environments = [];
  for (const environmentId of project.environmentOrder) {
    const environment = await store.getEnvironment(projectId,environmentId);
    const plugins = [];
    for (const plugin of await store.listPlugins(projectId,environmentId)) {
      const config = configProjection(plugin);
      const secrets = {...await vault.load(plugin)};
      if (config.pluginType === 'server') {
        if (config.auth.type === 'privateKey') {
          if (config.auth.privateKeySource !== 'vault') {
            try { secrets.privateKeyPem = await privateKeyFile(config.auth.privateKeyPath); }
            catch (error) {
              if (error?.code?.startsWith('CLOUD_')) throw error;
              throw cloudError('PRIVATE_KEY_UNAVAILABLE','无法读取所选项目的私钥，请先修复私钥路径。');
            }
          }
          config.auth.privateKeySource = 'vault';
        }
        delete config.auth.privateKeyPath;
        delete config.auth.agentSocket;
      }
      plugins.push({config,secrets});
    }
    const questions = await store.listQuickQuestions(projectId,environmentId);
    environments.push({environmentId,name:environment.name,runbook:(await store.readRunbook(projectId,environmentId)).content,questions:questions.items.map(({questionId,text}) => ({questionId,text})),plugins});
  }
  return normalizeProject({projectId,name:project.name,environments},vault);
}
export function cloudProjectWarnings(project) {
  const warnings = [];
  for (const env of project.environments) for (const {config,secrets} of env.plugins) {
    const prefix = `${env.name} / ${config.displayName}`;
    if (config.auth.type === 'agent') warnings.push(`${prefix}：需要本机 SSH Agent。`);
    if (config.uplink?.type === 'windowsVpn' || config.transport?.kind === 'windowsVpn') warnings.push(`${prefix}：需要本机 VPN 网卡与网络。`);
    if (config.auth.type === 'password' && !secrets.password) warnings.push(`${prefix}：未保存登录密码。`);
    if (config.auth.type === 'privateKey' && !secrets.privateKeyPem) warnings.push(`${prefix}：缺少 SSH 私钥。`);
    if (config.pluginType === 'mysql' && !secrets.password) warnings.push(`${prefix}：未保存数据库密码，请确认是否允许空密码。`);
    if (getPluginConnectionAdapter(config.pluginType).assessConfiguration(config).state !== 'complete') warnings.push(`${prefix}：连接配置尚未完整。`);
  }
  return warnings;
}
export function cloudBackupDiff(before,after) {
  const changed = file => before.files[file] !== after.files[file];
  const files = [...new Set([...Object.keys(before.files),...Object.keys(after.files)])];
  const plugins = files.filter(file => /\/plugins\/[^/]+\.yaml$/.test(file));
  const environments = files.filter(file => file.endsWith('/environment.yaml'));
  return {
    added:plugins.filter(file => !before.files[file]).length,
    removed:plugins.filter(file => !after.files[file]).length,
    modified:plugins.filter(file => before.files[file] && after.files[file] && changed(file)).length,
    credentialsChanged:snapshotDigest(before.entries) !== snapshotDigest(after.entries),
    environmentsAdded:environments.filter(file => !before.files[file]).length,
    environmentsRemoved:environments.filter(file => !after.files[file]).length,
    metadataChanged:files.some(file => (file === 'workspace.yaml' || file.endsWith('/environment.yaml')) && changed(file)),
    runbooksChanged:files.filter(file => file.endsWith('/README.md') && changed(file)).length,
    questionsChanged:files.filter(file => file.endsWith('/quick-questions.json') && changed(file)).length,
    contentChanged:snapshotDigest(before) !== snapshotDigest(after),
  };
}
export function cloudProjectDiff(before,after) {
  const entries = project => new Map((project?.environments ?? []).flatMap(e => e.plugins.map(p => [`${e.environmentId}/${p.config.pluginInstanceId}`,p])));
  const a = entries(before), b = entries(after);
  return {
    added:[...b.keys()].filter(key => !a.has(key)).length,
    removed:[...a.keys()].filter(key => !b.has(key)).length,
    modified:[...b.keys()].filter(key => a.has(key) && snapshotDigest(a.get(key)) !== snapshotDigest(b.get(key))).length,
    credentialsChanged:[...new Set([...a.keys(),...b.keys()])].some(key => snapshotDigest(a.get(key)?.secrets ?? {}) !== snapshotDigest(b.get(key)?.secrets ?? {})),
    environmentsAdded:(after?.environments ?? []).filter(e => !before?.environments.some(x => x.environmentId === e.environmentId)).length,
    environmentsRemoved:(before?.environments ?? []).filter(e => !after?.environments.some(x => x.environmentId === e.environmentId)).length,
    metadataChanged:before?.name !== after?.name || snapshotDigest((before?.environments ?? []).map(e => ({id:e.environmentId,name:e.name}))) !== snapshotDigest((after?.environments ?? []).map(e => ({id:e.environmentId,name:e.name}))),
    runbooksChanged:(after?.environments ?? []).filter(e => before?.environments.find(old => old.environmentId === e.environmentId)?.runbook !== e.runbook).length,
    questionsChanged:(after?.environments ?? []).filter(e => snapshotDigest(before?.environments.find(old => old.environmentId === e.environmentId)?.questions ?? []) !== snapshotDigest(e.questions)).length,
    contentChanged:snapshotDigest(before ?? null) !== snapshotDigest(after ?? null),
  };
}
