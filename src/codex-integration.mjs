import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { AppError, toPublicError } from './errors.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const failure = (code, message) => new AppError(code, message);

export function codexConfigPath(env = process.env, home = os.homedir()) {
  return path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml');
}

function parseConfig(text) {
  try { return parse(text.replace(/^\uFEFF/u, '')); }
  catch { throw failure('CODEX_CONFIG_INVALID', 'Codex 配置格式无效，请先在 Codex 中修复 config.toml，再重新检测。'); }
}

export class CodexIntegration {
  constructor({ configPath = codexConfigPath(), executablePath, entryPath, dataRoot, clipboard }) {
    this.configPath = configPath;
    this.clipboard = clipboard;
    this.entry = {
      command: executablePath,
      args: [entryPath],
      env: { ELECTRON_RUN_AS_NODE: '1', AI_OPS_DATA_DIR: dataRoot },
    };
    this.configSnippet = stringify({ mcp_servers: { 'agent-ops': this.entry } });
    this.approvals = new Map();
    this.installing = false;
  }

  async snapshot() {
    const directory = await fs.lstat(path.dirname(this.configPath)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
      throw failure('CODEX_CONFIG_UNSAFE', 'Codex 配置目录不是普通目录，请手动配置接入。');
    }
    const stat = await fs.lstat(this.configPath, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return { exists: false, text: '', revision: 'missing', parsed: {} };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_CONFIG_BYTES)) {
      throw failure('CODEX_CONFIG_UNSAFE', 'Codex 配置不是普通独立文件，或超过 1 MiB，请手动配置接入。');
    }
    const handle = await fs.open(this.configPath, 'r');
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw failure('CODEX_CONFIG_CHANGED', 'Codex 配置已变化，请重新检测。');
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_CONFIG_BYTES) throw failure('CODEX_CONFIG_UNSAFE', 'Codex 配置超过 1 MiB，请手动配置接入。');
      bytes = buffer.subarray(0, bytesRead);
      const after = await handle.stat({ bigint: true });
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        throw failure('CODEX_CONFIG_CHANGED', 'Codex 配置已变化，请重新检测。');
      }
    } finally { await handle.close(); }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw failure('CODEX_CONFIG_INVALID', 'Codex 配置不是有效 UTF-8 文件，请手动检查。'); }
    const revision = createHash('sha256').update(bytes).update(`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`).digest('hex');
    return { exists: true, text, revision, parsed: parseConfig(text) };
  }

  classify(snapshot) {
    const current = snapshot.parsed.mcp_servers?.['agent-ops'];
    if (current !== undefined) {
      const matches = current?.command === this.entry.command
        && JSON.stringify(current.args) === JSON.stringify(this.entry.args)
        && Object.entries(this.entry.env).every(([key, value]) => current.env?.[key] === value)
        && Object.keys(current.env ?? {}).length === Object.keys(this.entry.env).length;
      if (matches && current.enabled !== false) return { status: 'configured', message: '用户级配置已就绪。重启 Codex 后使用；此状态不代表 MCP 已连接。' };
      return { status: 'conflict', message: '已有不同或已停用的 agent-ops 配置。请手动核对并替换该条目，然后重新检测。' };
    }
    if (Buffer.byteLength(this.updatedText(snapshot), 'utf8') > MAX_CONFIG_BYTES) {
      return { status: 'error', message: '添加接入后配置将超过 1 MiB，请手动配置接入。' };
    }
    // 只追加本应用的配置；再次解析可识别内联表等不允许追加的 TOML 结构。
    try { parseConfig(this.updatedText(snapshot)); }
    catch { return { status: 'conflict', message: '现有 MCP 配置结构不支持直接追加，请使用下方配置手动接入。' }; }
    return { status: 'available', message: '可一键写入本机 Codex 的用户级配置，无需安装 Codex CLI。' };
  }

  updatedText(snapshot) {
    const newline = snapshot.text.includes('\r\n') ? '\r\n' : '\n';
    return snapshot.text + (snapshot.text ? newline + newline : '') + this.configSnippet.replace(/\n/gu, newline);
  }

  async status(owner) {
    const base = { configPath: this.configPath, configSnippet: this.configSnippet, approvalId: null };
    this.approvals.delete(owner);
    try {
      const snapshot = await this.snapshot();
      const state = this.classify(snapshot);
      if (state.status === 'available') {
        const approvalId = randomUUID();
        if (this.approvals.size >= 32) this.approvals.delete(this.approvals.keys().next().value);
        this.approvals.set(owner, { approvalId, revision: snapshot.revision, expires: Date.now() + APPROVAL_TTL_MS });
        return { ...base, ...state, approvalId };
      }
      return { ...base, ...state };
    } catch (error) {
      return { ...base, status: 'error', message: error instanceof AppError ? error.message : '无法读取 Codex 配置，请检查文件权限后重新检测。' };
    }
  }

  async install(owner, approvalId) {
    if (this.installing) throw failure('CODEX_INTEGRATION_BUSY', '正在写入接入配置，请稍候。');
    const approval = this.approvals.get(owner);
    this.approvals.delete(owner);
    if (!approval || approval.approvalId !== approvalId || approval.expires < Date.now()) {
      throw failure('CODEX_APPROVAL_EXPIRED', '接入检查已失效，请重新检测后再试。');
    }
    this.installing = true;
    let temporaryPath;
    try {
      const snapshot = await this.snapshot();
      if (snapshot.revision !== approval.revision) throw failure('CODEX_CONFIG_CHANGED', 'Codex 配置已变化，请重新检测后再接入。');
      if (this.classify(snapshot).status !== 'available') throw failure('CODEX_CONFIG_CONFLICT', '已有配置需要手动核对，请重新检测。');
      const updated = this.updatedText(snapshot);
      parseConfig(updated);
      await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
      temporaryPath = `${this.configPath}.runbook-bridge-${randomUUID()}.tmp`;
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(updated, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      let backupPath = null;
      if (snapshot.exists) {
        backupPath = `${this.configPath}.runbook-bridge-${randomUUID()}.bak`;
        await fs.writeFile(backupPath, snapshot.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
      // 写入前再次绑定读取时的文件身份和内容，拒绝覆盖期间发生的编辑。
      if ((await this.snapshot()).revision !== snapshot.revision) throw failure('CODEX_CONFIG_CHANGED', 'Codex 配置已变化，请重新检测后再接入。');
      if (snapshot.exists) await fs.rename(temporaryPath, this.configPath);
      else {
        await fs.link(temporaryPath, this.configPath);
        await fs.unlink(temporaryPath);
      }
      const state = await this.status(owner);
      return { ...state, backupPath };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failure('CODEX_CONFIG_WRITE_FAILED', '无法写入 Codex 配置，请检查目录权限后重新检测。');
    } finally {
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
      this.installing = false;
    }
  }

  copy() {
    this.clipboard.writeText(this.configSnippet);
    return { copied: true };
  }
}

export function registerCodexIntegrationIpc(ipcMain, { codexIntegration, isWorkspaceRenderer, openRepository }) {
  ipcMain.handle('v2:open-repository', async (event, ...args) => {
    try {
      if (!event?.sender || !isWorkspaceRenderer?.(event.sender)
        || event.senderFrame !== event.sender.mainFrame) throw failure('FORBIDDEN', '仅工作台主页面可打开项目仓库。');
      if (args.length) throw failure('INVALID_ARGUMENT', '打开项目仓库不接受参数。');
      if (!openRepository) throw failure('UNAVAILABLE', '暂时无法打开项目仓库。');
      await openRepository();
      return { ok: true, data: { opened: true } };
    } catch (error) { return { ok: false, error: toPublicError(error) }; }
  });
  ipcMain.handle('v2:codex-integration', async (event, payload) => {
    try {
      if (!event?.sender || !isWorkspaceRenderer?.(event.sender)
        || event.senderFrame !== event.sender.mainFrame) throw failure('FORBIDDEN', '仅工作台主页面可管理 Agent 接入。');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !['status', 'install', 'copy'].includes(payload.action)
        || Object.keys(payload).some(key => !['action', ...(payload.action === 'install' ? ['approvalId'] : [])].includes(key))
        || (payload.action === 'install' && typeof payload.approvalId !== 'string')) {
        throw failure('INVALID_ARGUMENT', 'Agent 接入请求无效。');
      }
      if (!codexIntegration) throw failure('UNAVAILABLE', 'Agent 接入服务暂不可用。');
      const owner = event.sender.id;
      const data = payload.action === 'status' ? await codexIntegration.status(owner)
        : payload.action === 'install' ? await codexIntegration.install(owner, payload.approvalId) : codexIntegration.copy();
      return { ok: true, data };
    } catch (error) { return { ok: false, error: toPublicError(error) }; }
  });
}
