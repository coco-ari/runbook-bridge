import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { AppError } from './errors.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PLUGIN_TYPES = new Set(['server', 'mysql', 'redis']);
const ADDRESS_FAMILIES = new Set(['ipv4Preferred', 'ipv4Only', 'ipv6Preferred', 'ipv6Only']);
const TRANSPORTS = new Set(['direct', 'windowsVpn', 'serverTunnel']);
const POLICY_MODES = new Set(['auto', 'confirm', 'deny']);

const DEFAULT_RUNBOOK = (name) => `# ${name}\n\n## 服务拓扑\n\n记录该环境包含的服务和依赖关系。\n\n## 日志与配置\n\n记录日志来源、关键字段和允许读取的配置范围。\n\n## 排障流程\n\n记录只读检查顺序、成功标准和升级处理方式。\n`;

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function normalizeName(value, label = '名称') {
  const name = String(value ?? '').normalize('NFKC').trim();
  if (!name || name.length > 120 || CONTROL_RE.test(name)) {
    throw new AppError('INVALID_ARGUMENT', `${label}不能为空、不能超过 120 字符或包含控制字符。`);
  }
  return name;
}

function normalizeId(value, prefix) {
  const raw = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (ID_RE.test(normalized)) return normalized;
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function assertId(value, label) {
  if (!ID_RE.test(String(value ?? ''))) throw new AppError('INVALID_ARGUMENT', `${label}无效。`);
  return String(value);
}

function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', '端口必须在 1 到 65535 之间。');
  }
  return port;
}

function normalizeHost(value, { required = true } = {}) {
  const host = String(value ?? '').trim();
  if ((!host && required) || host.length > 255 || CONTROL_RE.test(host)) {
    throw new AppError('INVALID_ARGUMENT', '连接目标地址无效。');
  }
  return host;
}

function normalizeAddressFamily(value) {
  return ADDRESS_FAMILIES.has(value) ? value : 'ipv4Preferred';
}

function normalizePolicy(input, defaults) {
  const output = {};
  for (const [capability, fallback] of Object.entries(defaults)) {
    const mode = input?.[capability] ?? fallback;
    if (!POLICY_MODES.has(mode)) throw new AppError('INVALID_ARGUMENT', `操作规则 ${capability} 无效。`);
    output[capability] = mode;
  }
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in defaults));
  if (unknown.length) throw new AppError('INVALID_ARGUMENT', `不支持的操作规则：${unknown.join(', ')}。`);
  return output;
}

function normalizeTransport(input = {}) {
  const kind = TRANSPORTS.has(input.kind) ? input.kind : 'direct';
  const transport = { kind };
  if (kind === 'serverTunnel') {
    transport.serverPluginInstanceId = assertId(input.serverPluginInstanceId, '隧道 Server 插件标识');
  }
  if (kind === 'windowsVpn') {
    const interfaceAlias = String(input.interfaceAlias ?? '').trim();
    if (!interfaceAlias || interfaceAlias.length > 128 || CONTROL_RE.test(interfaceAlias)) {
      throw new AppError('INVALID_ARGUMENT', 'Windows VPN 网卡名称无效。');
    }
    transport.interfaceAlias = interfaceAlias;
  }
  return transport;
}

function normalizeServerSources(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 50) throw new AppError('INVALID_ARGUMENT', 'Server 数据源最多 50 个。');
  const ids = new Set();
  return input.map((item, index) => {
    const sourceId = normalizeId(item?.sourceId ?? `source-${index + 1}`, 'source');
    if (ids.has(sourceId)) throw new AppError('INVALID_ARGUMENT', 'Server sourceId 不能重复。');
    ids.add(sourceId);
    const kind = ['log', 'config', 'download'].includes(item?.kind) ? item.kind : 'log';
    const root = String(item?.root ?? '').trim().replace(/\\/g, '/');
    if (!root.startsWith('/') || root.includes('\0') || root.split('/').includes('..') || root.length > 4096) throw new AppError('INVALID_ARGUMENT', 'Server 数据源根目录必须是安全的绝对路径。');
    const patterns = (Array.isArray(item?.patterns) && item.patterns.length ? item.patterns : ['*']).map((value) => {
      const pattern = String(value ?? '').trim();
      if (!pattern || pattern.length > 256 || pattern.includes('/') || CONTROL_RE.test(pattern)) throw new AppError('INVALID_ARGUMENT', 'Server 文件匹配模式无效。');
      return pattern;
    });
    return {
      sourceId,
      displayName: normalizeName(item?.displayName ?? sourceId, '数据源名称'),
      kind,
      root: path.posix.normalize(root),
      patterns,
      maxFileBytes: Math.min(Math.max(Number(item?.maxFileBytes ?? 100 * 1024 * 1024), 1024), 1024 * 1024 * 1024),
      redactSecrets: kind === 'config' ? item?.redactSecrets !== false : false,
    };
  });
}

function normalizeServerActions(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 100) throw new AppError('INVALID_ARGUMENT', 'Server action 配置过多。');
  return input.map((item) => {
    const actionId = String(item?.actionId ?? '');
    if (!['system.summary', 'process.summary', 'network.listen', 'filesystem.usage', 'service.status'].includes(actionId)) throw new AppError('INVALID_ARGUMENT', `不支持的 Server action：${actionId}。`);
    if (actionId === 'service.status') {
      const serviceId = normalizeId(item.serviceId, 'service');
      const unit = String(item.unit ?? '').trim();
      if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(unit)) throw new AppError('INVALID_ARGUMENT', 'Systemd unit 名称无效。');
      return { actionId, serviceId, displayName: normalizeName(item.displayName ?? serviceId, '服务名称'), unit };
    }
    if (actionId === 'filesystem.usage') {
      const mountId = normalizeId(item.mountId, 'mount');
      const mountPath = String(item.mountPath ?? '').trim();
      if (!/^\/[A-Za-z0-9_./-]{0,1023}$/.test(mountPath) || mountPath.split('/').includes('..')) throw new AppError('INVALID_ARGUMENT', '挂载点路径无效。');
      return { actionId, mountId, displayName: normalizeName(item.displayName ?? mountId, '挂载点名称'), mountPath: path.posix.normalize(mountPath) };
    }
    return { actionId };
  });
}

function normalizePlugin(input, scope, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGUMENT', '插件配置无效。');
  }
  const pluginType = input.pluginType ?? existing?.pluginType;
  if (!PLUGIN_TYPES.has(pluginType)) throw new AppError('INVALID_ARGUMENT', '插件类型无效。');
  if (existing && existing.pluginType !== pluginType) throw new AppError('INVALID_ARGUMENT', '不能修改插件类型。');
  const pluginInstanceId = existing?.pluginInstanceId ?? normalizeId(input.pluginInstanceId ?? input.displayName, pluginType);
  const base = {
    schemaVersion: 1,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    pluginInstanceId,
    pluginType,
    displayName: normalizeName(input.displayName ?? existing?.displayName ?? pluginType, '插件名称'),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: now(),
  };

  if (pluginType === 'server') {
    const source = {
      ...(existing ?? {}),
      ...input,
      policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
      limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
    };
    const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
    const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
    const uplink = { ...(existing?.uplink ?? {}), ...(input.uplink ?? {}) };
    const host = normalizeHost(target.host, { required: false });
    const username = String(auth.username ?? '').trim();
    if (username.length > 128 || CONTROL_RE.test(username)) throw new AppError('INVALID_ARGUMENT', 'SSH 用户名无效。');
    const authType = ['password', 'privateKey', 'agent'].includes(auth.type) ? auth.type : 'password';
    const uplinkType = ['direct', 'socks5', 'http', 'windowsVpn'].includes(uplink.type) ? uplink.type : 'direct';
    const plugin = {
      ...base,
      configState: host && username ? 'ready' : 'draft',
      target: {
        host,
        port: normalizePort(target.port, 22),
        addressFamily: normalizeAddressFamily(target.addressFamily),
        ...(target.hostKeyFingerprint ? { hostKeyFingerprint: String(target.hostKeyFingerprint) } : {}),
      },
      auth: {
        type: authType,
        username,
        ...(authType === 'privateKey' && auth.privateKeyPath ? { privateKeyPath: String(auth.privateKeyPath) } : {}),
        ...(authType === 'agent' && auth.agentSocket ? { agentSocket: String(auth.agentSocket) } : {}),
      },
      uplink: {
        type: uplinkType,
        ...(uplinkType === 'socks5' || uplinkType === 'http'
          ? {
              host: normalizeHost(uplink.host),
              port: normalizePort(uplink.port, uplinkType === 'socks5' ? 1080 : 8080),
              username: String(uplink.username ?? '').trim(),
              remoteDns: false,
            }
          : {}),
        ...(uplinkType === 'windowsVpn'
          ? { interfaceAlias: normalizeName(uplink.interfaceAlias, 'Windows VPN 网卡名称') }
          : {}),
      },
      sources: normalizeServerSources(source.sources),
      actions: normalizeServerActions(source.actions),
      tunnelProvider: source.tunnelProvider !== false,
      policy: normalizePolicy(source.policy, {
        status: 'auto',
        logs: 'auto',
        config: 'auto',
        download: 'confirm',
        diagnostics: 'auto',
      }),
      limits: {
        timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 10_000), 1_000), 60_000),
        maxBytes: Math.min(Math.max(Number(source.limits?.maxBytes ?? 262_144), 1024), 1_048_576),
      },
      ...(source.legacyProjectId ? { legacyProjectId: String(source.legacyProjectId) } : {}),
    };
    return plugin;
  }

  if (pluginType === 'mysql') {
    const source = {
      ...(existing ?? {}),
      ...input,
      policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
      limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
      tls: { ...(existing?.tls ?? {}), ...(input.tls ?? {}) },
    };
    const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
    const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
    const host = normalizeHost(target.host, { required: false });
    const database = String(target.database ?? '').trim();
    const username = String(auth.username ?? '').trim();
    if (database.length > 128 || CONTROL_RE.test(database) || username.length > 128 || CONTROL_RE.test(username)) {
      throw new AppError('INVALID_ARGUMENT', 'MySQL 数据库或用户名无效。');
    }
    return {
      ...base,
      configState: host && database && username ? 'ready' : 'draft',
      target: {
        host,
        port: normalizePort(target.port, 3306),
        database,
        addressFamily: normalizeAddressFamily(target.addressFamily),
      },
      auth: { username },
      transport: normalizeTransport({ ...(existing?.transport ?? {}), ...(input.transport ?? {}) }),
      tls: { mode: ['disabled', 'preferred', 'required', 'verifyIdentity'].includes(source.tls?.mode) ? source.tls.mode : 'preferred' },
      policy: normalizePolicy(source.policy, { describe: 'auto', select: 'auto', explain: 'auto' }),
      limits: {
        maxRows: Math.min(Math.max(Number(source.limits?.maxRows ?? 100), 1), 1000),
        maxBytes: Math.min(Math.max(Number(source.limits?.maxBytes ?? 1_048_576), 1024), 4_194_304),
        timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 10_000), 500), 60_000),
        maxConcurrency: 1,
      },
    };
  }

  const source = {
    ...(existing ?? {}),
    ...input,
    policy: { ...(existing?.policy ?? {}), ...(input.policy ?? {}) },
    limits: { ...(existing?.limits ?? {}), ...(input.limits ?? {}) },
    tls: { ...(existing?.tls ?? {}), ...(input.tls ?? {}) },
  };
  const target = { ...(existing?.target ?? {}), ...(input.target ?? {}) };
  const auth = { ...(existing?.auth ?? {}), ...(input.auth ?? {}) };
  const host = normalizeHost(target.host, { required: false });
  const username = String(auth.username ?? '').trim();
  const db = Number(target.db ?? 0);
  if (!Number.isInteger(db) || db < 0 || db > 15) throw new AppError('INVALID_ARGUMENT', 'Redis logical DB 必须在 0 到 15 之间。');
  if (username.length > 128 || CONTROL_RE.test(username)) throw new AppError('INVALID_ARGUMENT', 'Redis 用户名无效。');
  const patterns = Array.isArray(source.patterns) && source.patterns.length
    ? source.patterns.map((item, index) => ({
        patternId: normalizeId(item.patternId ?? `pattern-${index + 1}`, 'pattern'),
        pattern: String(item.pattern ?? '').trim(),
        displayName: normalizeName(item.displayName ?? item.pattern ?? `范围 ${index + 1}`, 'Key 范围名称'),
      }))
    : [{ patternId: 'default-pattern', pattern: '*', displayName: '全部允许 Key' }];
  for (const pattern of patterns) {
    if (!pattern.pattern || pattern.pattern.length > 256 || CONTROL_RE.test(pattern.pattern)) {
      throw new AppError('INVALID_ARGUMENT', 'Redis Key pattern 无效。');
    }
  }
  return {
    ...base,
    configState: host ? 'ready' : 'draft',
    target: {
      host,
      port: normalizePort(target.port, 6379),
      db,
      addressFamily: normalizeAddressFamily(target.addressFamily),
    },
    auth: { username },
    transport: normalizeTransport({ ...(existing?.transport ?? {}), ...(input.transport ?? {}) }),
    tls: { mode: ['disabled', 'required', 'verifyIdentity'].includes(source.tls?.mode) ? source.tls.mode : 'disabled' },
    patterns,
    policy: normalizePolicy(source.policy, { scan: 'auto', read: 'auto', ttl: 'auto' }),
    limits: {
      maxKeys: Math.min(Math.max(Number(source.limits?.maxKeys ?? 100), 1), 1000),
      maxValueBytes: Math.min(Math.max(Number(source.limits?.maxValueBytes ?? 65_536), 256), 262_144),
      timeoutMs: Math.min(Math.max(Number(source.limits?.timeoutMs ?? 5_000), 500), 30_000),
      maxConcurrency: 1,
    },
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export class WorkspaceStore {
  constructor(dataRoot, { legacyStore = null } = {}) {
    this.dataRoot = dataRoot;
    this.projectsRoot = path.join(dataRoot, 'projects');
    this.legacyStore = legacyStore;
    this.writeQueues = new Map();
  }

  async init({ migrateLegacy = true } = {}) {
    await fs.mkdir(this.projectsRoot, { recursive: true });
    if (this.legacyStore) await this.legacyStore.init();
    if (migrateLegacy && this.legacyStore) await this.migrateLegacyProjects();
  }

  projectDir(projectId) {
    return path.join(this.projectsRoot, assertId(projectId, '项目标识'));
  }

  workspacePath(projectId) {
    return path.join(this.projectDir(projectId), 'workspace.yaml');
  }

  environmentDir(projectId, environmentId) {
    return path.join(this.projectDir(projectId), 'environments', assertId(environmentId, '环境标识'));
  }

  environmentPath(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'environment.yaml');
  }

  pluginDir(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'plugins');
  }

  pluginPath(projectId, environmentId, pluginInstanceId) {
    return path.join(this.pluginDir(projectId, environmentId), `${assertId(pluginInstanceId, '插件标识')}.yaml`);
  }

  runbookPath(projectId, environmentId) {
    return path.join(this.environmentDir(projectId, environmentId), 'README.md');
  }

  async readYaml(file, missingCode, missingMessage) {
    try {
      return YAML.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new AppError(missingCode, missingMessage);
      throw error;
    }
  }

  enqueue(key, operation) {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writeQueues.set(key, current);
    return current.finally(() => {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key);
    });
  }

  async atomicWrite(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  }

  async writeYaml(file, value) {
    await this.atomicWrite(file, YAML.stringify(value, { lineWidth: 0 }));
  }

  async migrateLegacyProjects() {
    const legacyProjects = await this.legacyStore.list();
    const migrated = [];
    for (const legacy of legacyProjects) {
      if (await pathExists(this.workspacePath(legacy.id))) continue;
      const environmentId = 'default';
      const pluginInstanceId = 'server-primary';
      const projectDir = this.projectDir(legacy.id);
      const environmentDir = this.environmentDir(legacy.id, environmentId);
      await fs.mkdir(this.pluginDir(legacy.id, environmentId), { recursive: true });
      const timestamp = now();
      const workspace = {
        schemaVersion: 2,
        projectId: legacy.id,
        name: legacy.name,
        revision: 1,
        environmentOrder: [environmentId],
        createdAt: timestamp,
        updatedAt: timestamp,
        migration: { source: 'project-v1', migratedAt: timestamp },
      };
      const environment = {
        schemaVersion: 1,
        projectId: legacy.id,
        environmentId,
        name: '默认环境',
        revision: 1,
        pluginOrder: [pluginInstanceId],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const plugin = normalizePlugin({
        pluginInstanceId,
        pluginType: 'server',
        displayName: '应用服务器',
        target: { ...legacy.ssh, addressFamily: 'ipv4Preferred' },
        auth: { ...legacy.auth, username: legacy.ssh.username },
        uplink: legacy.proxy,
        legacyProjectId: legacy.id,
        policy: { status: 'auto', logs: 'auto', config: 'auto', download: 'confirm', diagnostics: 'auto' },
        limits: { timeoutMs: Number(legacy.limits?.commandTimeoutSeconds ?? 180) * 1000 },
      }, { projectId: legacy.id, environmentId });
      const legacyReadme = path.join(projectDir, 'docs', 'README.md');
      const runbook = (await pathExists(legacyReadme)) ? await fs.readFile(legacyReadme, 'utf8') : DEFAULT_RUNBOOK(environment.name);
      await this.writeYaml(this.workspacePath(legacy.id), workspace);
      await this.writeYaml(this.environmentPath(legacy.id, environmentId), environment);
      await this.writeYaml(this.pluginPath(legacy.id, environmentId, pluginInstanceId), plugin);
      await this.atomicWrite(path.join(environmentDir, 'README.md'), runbook);
      migrated.push(legacy.id);
    }
    return migrated;
  }

  async listProjects() {
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const project = await this.getProject(entry.name);
        const environments = await this.listEnvironments(entry.name);
        projects.push({ ...project, environmentCount: environments.length, pluginCount: environments.reduce((sum, item) => sum + item.pluginCount, 0) });
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'PROJECT_NOT_FOUND')) throw error;
      }
    }
    return projects.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async getProject(projectId) {
    const value = await this.readYaml(this.workspacePath(projectId), 'PROJECT_NOT_FOUND', '项目不存在。');
    if (value?.schemaVersion !== 2 || value.projectId !== projectId) throw new AppError('PROJECT_CONFIG_INVALID', '项目配置损坏。');
    return value;
  }

  async createProject(input) {
    const name = normalizeName(input?.name, '项目名称');
    let projectId = normalizeId(input?.projectId ?? name, 'project');
    while (await pathExists(this.projectDir(projectId))) projectId = `project-${crypto.randomBytes(5).toString('hex')}`;
    const environmentId = normalizeId(input?.environmentId ?? input?.environmentName ?? 'default', 'environment');
    const timestamp = now();
    const workspace = {
      schemaVersion: 2,
      projectId,
      name,
      revision: 1,
      environmentOrder: [environmentId],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const environment = {
      schemaVersion: 1,
      projectId,
      environmentId,
      name: normalizeName(input?.environmentName ?? '默认环境', '环境名称'),
      revision: 1,
      pluginOrder: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await fs.mkdir(this.pluginDir(projectId, environmentId), { recursive: true });
    try {
      await this.writeYaml(this.workspacePath(projectId), workspace);
      await this.writeYaml(this.environmentPath(projectId, environmentId), environment);
      await this.atomicWrite(this.runbookPath(projectId, environmentId), String(input?.runbook ?? DEFAULT_RUNBOOK(environment.name)));
      for (const plugin of input?.plugins ?? []) await this.createPlugin(projectId, environmentId, plugin);
      return this.getProject(projectId);
    } catch (error) {
      await fs.rm(this.projectDir(projectId), { recursive: true, force: true });
      throw error;
    }
  }

  async updateProject(projectId, patch, expectedRevision = null) {
    return this.enqueue(`project:${projectId}`, async () => {
      const current = await this.getProject(projectId);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '项目配置已经变化，请刷新后重试。');
      const next = { ...current, name: patch.name === undefined ? current.name : normalizeName(patch.name, '项目名称'), revision: current.revision + 1, updatedAt: now() };
      await this.writeYaml(this.workspacePath(projectId), next);
      return next;
    });
  }

  async listEnvironments(projectId) {
    const project = await this.getProject(projectId);
    const environments = [];
    for (const environmentId of project.environmentOrder ?? []) {
      const environment = await this.getEnvironment(projectId, environmentId);
      const plugins = await this.listPlugins(projectId, environmentId);
      environments.push({ ...environment, pluginCount: plugins.length, readyPluginCount: plugins.filter((item) => item.configState === 'ready').length });
    }
    return environments;
  }

  async getEnvironment(projectId, environmentId) {
    const value = await this.readYaml(this.environmentPath(projectId, environmentId), 'ENVIRONMENT_NOT_FOUND', '环境不存在。');
    if (value?.projectId !== projectId || value.environmentId !== environmentId) throw new AppError('SCOPE_MISMATCH', '环境不属于当前项目。');
    return value;
  }

  async createEnvironment(projectId, input) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      const existing = await this.listEnvironments(projectId);
      if (existing.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED', '每个项目最多 100 个环境。');
      const name = normalizeName(input?.name, '环境名称');
      const nameKey = name.normalize('NFKC').toLocaleLowerCase('zh-CN');
      if (existing.some((item) => item.name.normalize('NFKC').toLocaleLowerCase('zh-CN') === nameKey)) throw new AppError('DUPLICATE_ENVIRONMENT_NAME', '同一项目内环境名称不能重复。');
      let environmentId = normalizeId(input?.environmentId ?? name, 'environment');
      while (existing.some((item) => item.environmentId === environmentId)) environmentId = `environment-${crypto.randomBytes(5).toString('hex')}`;
      const timestamp = now();
      const environment = { schemaVersion: 1, projectId, environmentId, name, revision: 1, pluginOrder: [], createdAt: timestamp, updatedAt: timestamp };
      await fs.mkdir(this.pluginDir(projectId, environmentId), { recursive: true });
      await this.writeYaml(this.environmentPath(projectId, environmentId), environment);
      await this.atomicWrite(this.runbookPath(projectId, environmentId), String(input?.runbook ?? DEFAULT_RUNBOOK(name)));
      const nextProject = { ...project, environmentOrder: [...project.environmentOrder, environmentId], revision: project.revision + 1, updatedAt: timestamp };
      await this.writeYaml(this.workspacePath(projectId), nextProject);
      return environment;
    });
  }

  async updateEnvironment(projectId, environmentId, patch, expectedRevision = null) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const current = await this.getEnvironment(projectId, environmentId);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境配置已经变化，请刷新后重试。');
      const nextName = patch.name === undefined ? current.name : normalizeName(patch.name, '环境名称');
      const siblings = await this.listEnvironments(projectId);
      if (siblings.some((item) => item.environmentId !== environmentId && item.name.normalize('NFKC').toLowerCase() === nextName.normalize('NFKC').toLowerCase())) {
        throw new AppError('DUPLICATE_ENVIRONMENT_NAME', '同一项目内环境名称不能重复。');
      }
      const next = { ...current, name: nextName, revision: current.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), next);
      return next;
    });
  }

  async deleteEnvironment(projectId, environmentId, { runtimeActive = false } = {}) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      const environment = await this.getEnvironment(projectId, environmentId);
      if (project.environmentOrder.length <= 1) throw new AppError('POLICY_DENIED', '项目至少需要保留一个环境。');
      const plugins = await this.listPlugins(projectId, environmentId);
      if (plugins.length) throw new AppError('ENVIRONMENT_NOT_EMPTY', `该环境仍有 ${plugins.length} 个插件，不能删除。`);
      if (runtimeActive) throw new AppError('ENVIRONMENT_CONNECTED', '请先断开环境再删除。');
      const next = { ...project, environmentOrder: project.environmentOrder.filter((id) => id !== environmentId), revision: project.revision + 1, updatedAt: now() };
      const source = this.environmentDir(projectId, environmentId);
      const tombstone = `${source}.deleting-${crypto.randomBytes(4).toString('hex')}`;
      await fs.rename(source, tombstone);
      try {
        await this.writeYaml(this.workspacePath(projectId), next);
        await fs.rm(tombstone, { recursive: true, force: true });
      } catch (error) {
        await fs.rename(tombstone, source).catch(() => undefined);
        throw error;
      }
      return { environmentId, name: environment.name };
    });
  }

  async reorderEnvironments(projectId, orderedIds, expectedRevision = null) {
    return this.enqueue(`project:${projectId}`, async () => {
      const project = await this.getProject(projectId);
      if (expectedRevision !== null && project.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '项目配置已经变化，请刷新后重试。');
      if (!Array.isArray(orderedIds) || orderedIds.length !== project.environmentOrder.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !project.environmentOrder.includes(id))) {
        throw new AppError('INVALID_ARGUMENT', '环境排序列表无效。');
      }
      const next = { ...project, environmentOrder: [...orderedIds], revision: project.revision + 1, updatedAt: now() };
      await this.writeYaml(this.workspacePath(projectId), next);
      return next;
    });
  }

  async readRunbook(projectId, environmentId) {
    await this.getEnvironment(projectId, environmentId);
    const content = await fs.readFile(this.runbookPath(projectId, environmentId), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    return { content, bytes: Buffer.byteLength(content), hash: crypto.createHash('sha256').update(content).digest('hex'), empty: !content.trim() };
  }

  async saveRunbook(projectId, environmentId, content, expectedRevision = null) {
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new AppError('RESULT_LIMIT_EXCEEDED', '运维说明不能超过 1 MiB。');
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      if (expectedRevision !== null && environment.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '环境已经变化，请刷新后重试。');
      await this.atomicWrite(this.runbookPath(projectId, environmentId), text);
      const next = { ...environment, revision: environment.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), next);
      return { environment: next, ...(await this.readRunbook(projectId, environmentId)) };
    });
  }

  async listPlugins(projectId, environmentId) {
    const environment = await this.getEnvironment(projectId, environmentId);
    const plugins = [];
    for (const pluginInstanceId of environment.pluginOrder ?? []) plugins.push(await this.getPlugin(projectId, environmentId, pluginInstanceId));
    return plugins;
  }

  async getPlugin(projectId, environmentId, pluginInstanceId) {
    const value = await this.readYaml(this.pluginPath(projectId, environmentId, pluginInstanceId), 'PLUGIN_NOT_FOUND', '插件不存在。');
    if (value?.projectId !== projectId || value.environmentId !== environmentId || value.pluginInstanceId !== pluginInstanceId) {
      throw new AppError('SCOPE_MISMATCH', '插件不属于当前环境。');
    }
    return value;
  }

  async createPlugin(projectId, environmentId, input) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      if (environment.pluginOrder.length >= 100) throw new AppError('RESULT_LIMIT_EXCEEDED', '每个环境最多 100 个插件。');
      const plugin = normalizePlugin(input, { projectId, environmentId });
      if (environment.pluginOrder.includes(plugin.pluginInstanceId)) throw new AppError('PLUGIN_ALREADY_EXISTS', '插件标识已经存在。');
      await this.assertPluginReferences(plugin);
      await this.writeYaml(this.pluginPath(projectId, environmentId, plugin.pluginInstanceId), plugin);
      const nextEnvironment = { ...environment, pluginOrder: [...environment.pluginOrder, plugin.pluginInstanceId], revision: environment.revision + 1, updatedAt: now() };
      await this.writeYaml(this.environmentPath(projectId, environmentId), nextEnvironment);
      return plugin;
    });
  }

  async updatePlugin(projectId, environmentId, pluginInstanceId, patch, expectedRevision = null) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const current = await this.getPlugin(projectId, environmentId, pluginInstanceId);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new AppError('CONFIG_REVISION_CONFLICT', '插件配置已经变化，请刷新后重试。');
      const next = normalizePlugin({ ...patch, pluginInstanceId, pluginType: current.pluginType }, { projectId, environmentId }, current);
      await this.assertPluginReferences(next);
      await this.writeYaml(this.pluginPath(projectId, environmentId, pluginInstanceId), next);
      return next;
    });
  }

  async deletePlugin(projectId, environmentId, pluginInstanceId) {
    return this.enqueue(`environment:${projectId}:${environmentId}`, async () => {
      const environment = await this.getEnvironment(projectId, environmentId);
      const plugin = await this.getPlugin(projectId, environmentId, pluginInstanceId);
      const plugins = await this.listPlugins(projectId, environmentId);
      const dependents = plugins.filter((item) => item.transport?.kind === 'serverTunnel' && item.transport.serverPluginInstanceId === pluginInstanceId);
      if (dependents.length) throw new AppError('PLUGIN_HAS_DEPENDENTS', `仍有 ${dependents.length} 个插件复用此隧道。`);
      const next = { ...environment, pluginOrder: environment.pluginOrder.filter((id) => id !== pluginInstanceId), revision: environment.revision + 1, updatedAt: now() };
      const source = this.pluginPath(projectId, environmentId, pluginInstanceId);
      const tombstone = `${source}.deleting-${crypto.randomBytes(4).toString('hex')}`;
      await fs.rename(source, tombstone);
      try {
        await this.writeYaml(this.environmentPath(projectId, environmentId), next);
        await fs.rm(tombstone, { force: true });
      } catch (error) {
        await fs.rename(tombstone, source).catch(() => undefined);
        throw error;
      }
      return { pluginInstanceId, displayName: plugin.displayName };
    });
  }

  async assertPluginReferences(plugin) {
    if (plugin.transport?.kind !== 'serverTunnel') return;
    const provider = await this.getPlugin(plugin.projectId, plugin.environmentId, plugin.transport.serverPluginInstanceId);
    if (provider.pluginType !== 'server' || provider.tunnelProvider === false) throw new AppError('INVALID_PLUGIN_REFERENCE', '隧道只能引用同环境且允许提供隧道的 Server 插件。');
  }

  publicPlugin(plugin) {
    const target = plugin.target ?? {};
    return {
      pluginInstanceId: plugin.pluginInstanceId,
      pluginType: plugin.pluginType,
      displayName: plugin.displayName,
      configState: plugin.configState,
      revision: plugin.revision,
      resource: plugin.pluginType === 'mysql'
        ? { database: target.database }
        : plugin.pluginType === 'redis'
          ? { db: target.db }
          : { host: target.host, port: target.port },
      transport: plugin.transport?.kind ?? plugin.uplink?.type ?? 'direct',
      policy: clone(plugin.policy ?? {}),
      limits: clone(plugin.limits ?? {}),
    };
  }

  pluginBindingHash(plugin) {
    const projection = { pluginType: plugin.pluginType, target: plugin.target, auth: plugin.auth, transport: plugin.transport, uplink: plugin.uplink, tls: plugin.tls, sources: plugin.sources, actions: plugin.actions, policy: plugin.policy, limits: plugin.limits };
    return crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  }

  async appendAudit(projectId, entry) {
    return this.enqueue(`audit:${projectId}`, async () => {
      const file = path.join(this.projectDir(projectId), 'audit', 'operations-v3.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const record = { schemaVersion: 3, time: now(), ...entry };
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return record;
    });
  }

  async listAudit(projectId, { environmentId = null, pluginInstanceId = null, cursor = 0, limit = 100 } = {}) {
    await this.getProject(projectId);
    const file = path.join(this.projectDir(projectId), 'audit', 'operations-v3.jsonl');
    const content = await fs.readFile(file, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    const entries = content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((entry) => (!environmentId || entry.environmentId === environmentId) && (!pluginInstanceId || entry.pluginInstanceId === pluginInstanceId)).reverse();
    const offset = Math.max(Number(cursor) || 0, 0);
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return { entries: entries.slice(offset, offset + pageSize), nextCursor: offset + pageSize < entries.length ? String(offset + pageSize) : null };
  }
}

export const workspaceInternals = { normalizePlugin, normalizeId, normalizeName };
