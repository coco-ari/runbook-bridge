import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
export const agentScope = p => ({projectId:p.projectId,environmentId:p.environmentId,pluginInstanceId:p.pluginInstanceId});
export const agentKey = p => JSON.stringify([p.projectId,p.environmentId,p.pluginInstanceId]);
export const agentIdentity = p => crypto.createHash('sha256').update(JSON.stringify([agentKey(p),p.target])).digest('hex');
export const SESSION_ID = /^[a-f0-9-]{36}$/;
export class CodexSessionStore {
  constructor(dataRoot) { this.base = path.join(dataRoot,'codex-agent'); this.queues = new Map(); this.catalogs = new Map(); this.catalogLoads = new Map(); }
  root(plugin) { return path.join(this.base,agentIdentity(plugin)); }
  async prepare(plugin) {
    const root = this.root(plugin);
    await fs.mkdir(root,{recursive:true,mode:0o700});
    for (const part of [this.base,root]) if (!(await fs.lstat(part)).isDirectory()) throw new AppError('CODEX_STORE_INVALID','Agent 数据目录无效。');
    for (const name of ['home','work','sessions']) {
      const dir = path.join(root,name); await fs.mkdir(dir,{recursive:true,mode:0o700});
      if (!(await fs.lstat(dir)).isDirectory()) throw new AppError('CODEX_STORE_INVALID','Agent 数据目录无效。');
    }
    return fs.realpath(root);
  }
  file(plugin,id) { if (!SESSION_ID.test(id)) throw new AppError('INVALID_ARGUMENT','会话 ID 无效。'); return path.join(this.root(plugin),'sessions',`${id}.json`); }
  async read(plugin,id) {
    const file = this.file(plugin,id), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4*1024*1024) throw new AppError('CODEX_STORE_INVALID','会话记录无效。');
    const data = JSON.parse(await fs.readFile(file,'utf8'));
    if (data.id !== id || data.identity !== agentIdentity(plugin) || !Array.isArray(data.messages) || !Array.isArray(data.sources)) throw new AppError('CODEX_STORE_INVALID','会话不属于当前插件配置。');
    return data;
  }
  async list(plugin) {
    const key = this.root(plugin);
    if (this.catalogs.has(key)) return [...this.catalogs.get(key).values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!this.catalogLoads.has(key)) this.catalogLoads.set(key,this.loadCatalog(plugin).finally(() => this.catalogLoads.delete(key)));
    await this.catalogLoads.get(key); return this.list(plugin);
  }
  async loadCatalog(plugin) {
    await this.prepare(plugin);
    const names = (await fs.readdir(path.join(this.root(plugin),'sessions'))).filter(n => n.endsWith('.json')).slice(0,201);
    const sessions = new Map();
    for (const name of names) try { const {messages,...metadata} = await this.read(plugin,name.slice(0,-5)); sessions.set(metadata.id,metadata); } catch { /* Corrupt records cannot become runnable sessions. */ }
    this.catalogs.set(this.root(plugin),sessions);
  }
  save(plugin,record) {
    const file = this.file(plugin,record.id), value = JSON.stringify(record);
    if (Buffer.byteLength(value) > 4*1024*1024) return Promise.reject(new AppError('CODEX_HISTORY_FULL','会话记录已满，请新建会话。'));
    const next = (this.queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp,value,{mode:0o600,flag:'wx'}); await fs.rename(temp,file); const {messages,...metadata} = JSON.parse(value); this.catalogs.get(this.root(plugin))?.set(record.id,metadata); }
      finally { await fs.rm(temp,{force:true}); }
    });
    this.queues.set(file,next); void next.finally(() => { if (this.queues.get(file) === next) this.queues.delete(file); }).catch(() => {}); return next;
  }
  async remove(plugin,id) { const file = this.file(plugin,id); await this.queues.get(file)?.catch(() => {}); await fs.rm(file,{force:true}); this.catalogs.get(this.root(plugin))?.delete(id); }
}
