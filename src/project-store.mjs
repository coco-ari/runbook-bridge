import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { AppError } from './errors.mjs';
import { projectsRoot } from './paths.mjs';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DOC_NAME_RE = /^[\p{L}\p{N}._ -]+\.md$/u;
const DEFAULT_LIMITS = Object.freeze({
  commandTimeoutSeconds: 180,
  maxUploadMB: 500,
  maxDownloadMB: 100,
  maxDocumentKB: 200,
  maxLogScanMB: 16,
});
const DEFAULT_COMMAND_POLICY = Object.freeze({ enabled: true, customDeny: [] });
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const DEFAULT_README = (name) => `# ${name}\n\n## 服务器与项目目录\n\n在这里填写项目涉及的服务器目录。\n\n## 产物清单\n\n| 本地文件 | 上传目标 | 说明 |\n| --- | --- | --- |\n| \`D:\\\\work\\\\project\\\\target\\\\app.jar\` | \`/home/deploy/app/app.jar\` | 示例，请修改 |\n\n## 部署流程\n\n1. 检查当前进程。\n2. 备份现有产物。\n3. 上传新产物。\n4. 执行项目启动命令。\n5. 检查日志确认启动成功。\n6. 失败时恢复备份。\n\n## 日志位置\n\n在这里填写日志文件完整路径、日志格式、启动成功标志和常用关联字段。Codex 会从本文档取得明确路径，并可使用结构化日志搜索。\n\n## 操作要求\n\n- 不使用 sudo。\n- 删除或覆盖文件前先备份。\n- 遇到不确定情况先询问。\n\n## Codex MCP 安装\n\n安装“AI 运维工具”后，在 PowerShell 中执行以下命令。若修改过安装目录，请把命令中的路径替换为实际安装位置。\n\n\`\`\`powershell\ncodex mcp add --env ELECTRON_RUN_AS_NODE=1 ai-ops -- \"$env:LOCALAPPDATA\\Programs\\AI运维工具\\AI运维工具.exe\" \"$env:LOCALAPPDATA\\Programs\\AI运维工具\\resources\\app.asar\\src\\mcp.mjs\"\n\`\`\`\n\n验证 MCP 是否注册成功：\n\n\`\`\`powershell\ncodex mcp get ai-ops\n\`\`\`\n\n注册或升级后请完全退出并重新启动 Codex。服务器连接仍需由用户在桌面工具中主动建立，MCP 不会自行登录服务器。\n`;

function sanitizeId(input) {
  const normalized = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (PROJECT_ID_RE.test(normalized)) return normalized;
  return `project-${crypto.randomBytes(4).toString('hex')}`;
}

function safeProjectConfig(input, id) {
  const name = String(input.name ?? '').trim();
  const host = String(input.ssh?.host ?? '').trim();
  const username = String(input.ssh?.username ?? '').trim();
  const port = Number(input.ssh?.port ?? 22);
  if (!name || !host || !username) {
    throw new AppError('INVALID_ARGUMENT', '项目名称、服务器和用户名不能为空。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', 'SSH 端口必须在 1 到 65535 之间。');
  }
  if (name.length > 120 || host.length > 255 || username.length > 128) {
    throw new AppError('INVALID_ARGUMENT', '项目名称、服务器或用户名过长。');
  }
  if (CONTROL_CHAR_RE.test(host) || CONTROL_CHAR_RE.test(username)) {
    throw new AppError('INVALID_ARGUMENT', '服务器和用户名不能包含控制字符。');
  }
  const authType = ['password', 'privateKey', 'agent'].includes(input.auth?.type)
    ? input.auth.type
    : 'password';
  const proxyType = ['direct', 'socks5', 'http'].includes(input.proxy?.type)
    ? input.proxy.type
    : 'direct';
  const proxyHost = String(input.proxy?.host ?? '').trim();
  const proxyPort = Number(input.proxy?.port ?? (proxyType === 'socks5' ? 1080 : 8080));
  if (proxyType !== 'direct') {
    if (!proxyHost || CONTROL_CHAR_RE.test(proxyHost) || proxyHost.length > 255) {
      throw new AppError('INVALID_ARGUMENT', '代理地址无效。');
    }
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw new AppError('INVALID_ARGUMENT', '代理端口必须在 1 到 65535 之间。');
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  for (const [key, maximum] of [
    ['commandTimeoutSeconds', 3600],
    ['maxUploadMB', 10_240],
    ['maxDownloadMB', 10_240],
    ['maxDocumentKB', 1024],
    ['maxLogScanMB', 32],
  ]) {
    const value = Number(limits[key]);
    if (!Number.isFinite(value) || value <= 0 || value > maximum) {
      throw new AppError('INVALID_ARGUMENT', `项目限制 ${key} 超出允许范围。`);
    }
    limits[key] = value;
  }
  const rawPolicy = { ...DEFAULT_COMMAND_POLICY, ...(input.commandPolicy ?? {}) };
  if (!Array.isArray(rawPolicy.customDeny) || rawPolicy.customDeny.length > 50) {
    throw new AppError('INVALID_ARGUMENT', '自定义阻止短语最多允许 50 条。');
  }
  const customDeny = [];
  const seenDeny = new Set();
  for (const entry of rawPolicy.customDeny) {
    const value = String(entry ?? '').trim();
    if (!value) continue;
    if (value.length > 200 || CONTROL_CHAR_RE.test(value)) {
      throw new AppError('INVALID_ARGUMENT', '每条自定义阻止短语不能超过 200 字符或包含控制字符。');
    }
    const key = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    if (seenDeny.has(key)) continue;
    seenDeny.add(key);
    customDeny.push(value);
  }
  return {
    version: 1,
    id,
    name,
    ssh: {
      host,
      port,
      username,
      ...(input.ssh?.hostKeyFingerprint
        ? { hostKeyFingerprint: String(input.ssh.hostKeyFingerprint) }
        : {}),
    },
    auth: {
      type: authType,
      ...(authType === 'privateKey' && input.auth?.privateKeyPath
        ? { privateKeyPath: String(input.auth.privateKeyPath) }
        : {}),
      ...(authType === 'agent' && input.auth?.agentSocket
        ? { agentSocket: String(input.auth.agentSocket) }
        : {}),
    },
    proxy: {
      type: proxyType,
      ...(proxyType !== 'direct'
        ? {
            host: proxyHost,
            port: proxyPort,
            username: String(input.proxy?.username ?? '').trim(),
            remoteDns: input.proxy?.remoteDns !== false,
          }
        : {}),
    },
    credentials: {
      remember: input.credentials?.remember !== false,
    },
    commandPolicy: {
      enabled: rawPolicy.enabled !== false,
      customDeny,
    },
    limits,
  };
}

export class ProjectStore {
  constructor(dataRoot) {
    this.root = projectsRoot(dataRoot);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  projectDir(id) {
    if (!PROJECT_ID_RE.test(id)) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。');
    return path.join(this.root, id);
  }

  async list() {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID_RE.test(entry.name)) continue;
      try {
        projects.push(await this.get(entry.name));
      } catch {
        // Ignore malformed project folders and keep the rest usable.
      }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async create(input) {
    await this.init();
    let id = sanitizeId(input.id || input.name);
    let suffix = 1;
    while (await this.pathExists(path.join(this.root, id))) {
      id = `${sanitizeId(input.id || input.name).slice(0, 58)}-${suffix++}`;
    }
    const config = safeProjectConfig(input, id);
    const dir = this.projectDir(id);
    try {
      await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
      await fs.mkdir(path.join(dir, 'downloads'), { recursive: true });
      await fs.mkdir(path.join(dir, 'audit'), { recursive: true });
      await this.writeConfig(config);
      await fs.writeFile(path.join(dir, 'docs', 'README.md'), DEFAULT_README(config.name), {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return config;
  }

  async pathExists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async exists(id) {
    try {
      await fs.access(path.join(this.root, id, 'project.yaml'));
      return true;
    } catch {
      return false;
    }
  }

  async get(id) {
    const raw = await fs.readFile(path.join(this.projectDir(id), 'project.yaml'), 'utf8').catch(() => {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在。');
    });
    const parsed = YAML.parse(raw);
    if (parsed?.version !== undefined && parsed.version !== 1) {
      throw new AppError('PROJECT_VERSION_UNSUPPORTED', '项目配置版本高于当前程序支持范围。');
    }
    return safeProjectConfig(parsed, id);
  }

  async update(id, input) {
    const current = await this.get(id);
    const merged = {
      ...current,
      ...input,
      ssh: { ...current.ssh, ...(input.ssh ?? {}) },
      auth: { ...current.auth, ...(input.auth ?? {}) },
      proxy: { ...current.proxy, ...(input.proxy ?? {}) },
      credentials: { ...current.credentials, ...(input.credentials ?? {}) },
      commandPolicy: { ...current.commandPolicy, ...(input.commandPolicy ?? {}) },
      limits: { ...current.limits, ...(input.limits ?? {}) },
    };
    const hostChanged =
      input.ssh &&
      (String(input.ssh.host ?? current.ssh.host).trim() !== current.ssh.host ||
        Number(input.ssh.port ?? current.ssh.port) !== current.ssh.port);
    if (hostChanged && !Object.hasOwn(input.ssh, 'hostKeyFingerprint')) {
      delete merged.ssh.hostKeyFingerprint;
    }
    const config = safeProjectConfig(merged, id);
    await this.writeConfig(config);
    return config;
  }

  async writeConfig(config) {
    const dir = this.projectDir(config.id);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'project.yaml');
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, YAML.stringify(config), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  docsDir(id) {
    return path.join(this.projectDir(id), 'docs');
  }

  validateDocName(name) {
    const value = String(name ?? '').trim();
    if (value.length > 123 || !DOC_NAME_RE.test(value) || value.includes('..') || path.basename(value) !== value) {
      throw new AppError('INVALID_DOCUMENT_NAME', '文档名称必须是当前项目中的 .md 文件名。');
    }
    return value;
  }

  async listDocs(id) {
    await this.get(id);
    const docsDir = this.docsDir(id);
    await fs.mkdir(docsDir, { recursive: true });
    const entries = await fs.readdir(docsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)));
  }

  async readDoc(id, name) {
    const safeName = this.validateDocName(name);
    return fs.readFile(path.join(this.docsDir(id), safeName), 'utf8').catch(() => {
      throw new AppError('DOCUMENT_NOT_FOUND', '文档不存在。');
    });
  }

  async saveDoc(id, name, content) {
    await this.get(id);
    const safeName = this.validateDocName(name);
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
      throw new AppError('DOCUMENT_TOO_LARGE', '单个 Markdown 文档不能超过 1 MB。');
    }
    const target = path.join(this.docsDir(id), safeName);
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, text, 'utf8');
      await fs.rename(temp, target);
      const persisted = await fs.readFile(target, 'utf8');
      if (persisted !== text) {
        throw new AppError('DOCUMENT_SAVE_VERIFY_FAILED', '文档写入后校验失败。');
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      name: safeName,
      verified: true,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    };
  }

  async createDoc(id, name) {
    await this.get(id);
    const safeName = this.validateDocName(name);
    await fs.writeFile(path.join(this.docsDir(id), safeName), `# ${safeName.replace(/\.md$/i, '')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    }).catch((error) => {
      if (error.code === 'EEXIST') throw new AppError('DOCUMENT_EXISTS', '同名文档已经存在。');
      throw error;
    });
    return { name: safeName };
  }

  async deleteDoc(id, name) {
    const safeName = this.validateDocName(name);
    if (safeName === 'README.md') {
      throw new AppError('POLICY_DENIED', 'README.md 是项目入口文档，不能删除。');
    }
    await fs.unlink(path.join(this.docsDir(id), safeName)).catch(() => {
      throw new AppError('DOCUMENT_NOT_FOUND', '文档不存在。');
    });
  }

  async readContext(id) {
    const config = await this.get(id);
    const names = await this.listDocs(id);
    const maxBytes = (config.limits.maxDocumentKB ?? 200) * 1024;
    let total = 0;
    const documents = [];
    const manifest = [];
    let truncated = false;
    for (const name of names) {
      const content = await this.readDoc(id, name);
      const bytes = Buffer.byteLength(content, 'utf8');
      manifest.push([name, content]);
      if (total + bytes > maxBytes && name !== 'README.md') {
        truncated = true;
        continue;
      }
      total += bytes;
      documents.push({ name, content });
    }
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');
    return { config, documents, documentNames: names, docsHash: hash, truncated };
  }

  securityConfigHash(config) {
    const securityConfig = {
      commandPolicy: config.commandPolicy,
      limits: config.limits,
    };
    return crypto.createHash('sha256').update(JSON.stringify(securityConfig)).digest('hex');
  }

  downloadsDir(id) {
    return path.join(this.projectDir(id), 'downloads');
  }

  async appendAudit(id, entry) {
    const dir = path.join(this.projectDir(id), 'audit');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const clean = { ...entry, schemaVersion: 2, time: new Date().toISOString(), projectId: id };
    await fs.appendFile(path.join(dir, 'operations.jsonl'), `${JSON.stringify(clean)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
