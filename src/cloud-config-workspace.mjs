import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { normalizePlugin } from './plugin-config-model.mjs';
import { cloudError, cloudId } from './cloud-config-crypto.mjs';
import { snapshotDigest } from './cloud-config-snapshot.mjs';

const ID = '[a-z0-9][a-z0-9-]{1,62}';
const FILE = new RegExp(`^(workspace\\.yaml|environments/${ID}/(environment\\.yaml|README\\.md|quick-questions\\.json|plugins/${ID}\\.yaml))$`);
const stamp = () => new Date().toISOString();

export class CloudConfigWorkspace {
  constructor(store,vault,encryption) {
    this.store = store;
    this.vault = vault;
    this.encryption = encryption;
    this.directory = path.join(store.dataRoot,'cloud-config');
    this.blocked = new Set();
    this.blockAll = false;
  }
  assertProjectAvailable(projectId) {
    if (this.blockAll || this.blocked.has(projectId)) throw cloudError('RECOVERY_REQUIRED','此项目的云配置事务尚未恢复，请重启并检查系统安全存储。');
  }
  assertPluginAvailable(projectId) { this.assertProjectAvailable(projectId); }
  assertEnvironmentAvailable(projectId) { this.assertProjectAvailable(projectId); }
  hasUnresolved() { return this.blockAll || this.blocked.size > 0; }
  async seal(value) {
    if (!this.encryption?.isEncryptionAvailable?.() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw cloudError('ENCRYPTION_UNAVAILABLE','系统安全存储不可用，无法保存云配置凭据或备份。');
    const ciphertext = await this.encryption.encryptString(JSON.stringify(value));
    return JSON.stringify({schemaVersion:1,ciphertext:Buffer.from(ciphertext).toString('base64')});
  }
  async unseal(text) {
    try {
      const wrapper = JSON.parse(text);
      if (wrapper.schemaVersion !== 1 || typeof wrapper.ciphertext !== 'string') throw new Error();
      return JSON.parse(await this.encryption.decryptString(Buffer.from(wrapper.ciphertext,'base64')));
    } catch { throw cloudError('LOCAL_DECRYPT_FAILED','本机云配置记录无法解密，原始数据已保留。'); }
  }
  async writeSealed(file,value) { await this.store.atomicWrite(file,await this.seal(value)); }
  async safeFile(projectId,relative) {
    if (!FILE.test(relative)) throw cloudError('FORMAT_INVALID','项目备份文件名无效。');
    const root = this.store.projectDir(projectId);
    const target = path.resolve(root,...relative.split('/'));
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw cloudError('FORMAT_INVALID','项目文件越界。');
    let current = this.store.projectsRoot;
    for (const segment of [projectId,...relative.split('/')]) {
      current = path.join(current,segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory()) || (current === target && !stat.isFile())) throw cloudError('LOCAL_PATH_INVALID','配置目录不能包含链接或特殊文件。');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async capture(projectId) {
    const files = {};
    let project;
    try { project = await this.store.getProject(projectId); }
    catch (error) { if (error.code !== 'PROJECT_NOT_FOUND') throw error; }
    const read = async (relative,optional = false) => {
      const file = await this.safeFile(projectId,relative);
      try { files[relative] = (await fs.readFile(file)).toString('base64'); }
      catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
    };
    if (project) {
      await read('workspace.yaml');
      for (const environmentId of project.environmentOrder) {
        const env = await this.store.getEnvironment(projectId,environmentId);
        const prefix = `environments/${environmentId}`;
        await read(`${prefix}/environment.yaml`);
        await read(`${prefix}/README.md`,true);
        await read(`${prefix}/quick-questions.json`,true);
        for (const pluginId of env.pluginOrder) await read(`${prefix}/plugins/${pluginId}.yaml`);
      }
    }
    return {projectId,files,entries:await this.vault.captureProjectEntries(projectId)};
  }
  async materialize(portable,projectId,before) {
    const files = {};
    const plugins = [];
    const old = relative => before.files[relative] ? YAML.parse(Buffer.from(before.files[relative],'base64').toString('utf8')) : null;
    const write = (relative,text) => { files[relative] = Buffer.from(text).toString('base64'); };
    const yaml = (relative,value) => write(relative,YAML.stringify(value,{lineWidth:0}));
    const previousProject = old('workspace.yaml');
    const timestamp = stamp();
    yaml('workspace.yaml',{schemaVersion:2,projectId,name:portable.name,revision:(previousProject?.revision ?? 0)+1,environmentOrder:portable.environments.map(e => e.environmentId),createdAt:previousProject?.createdAt ?? timestamp,updatedAt:timestamp});
    for (const environment of portable.environments) {
      const environmentId = environment.environmentId;
      const prefix = `environments/${environmentId}`;
      const previousEnv = old(`${prefix}/environment.yaml`);
      yaml(`${prefix}/environment.yaml`,{schemaVersion:1,projectId,environmentId,name:environment.name,revision:(previousEnv?.revision ?? 0)+1,pluginOrder:environment.plugins.map(p => p.config.pluginInstanceId),createdAt:previousEnv?.createdAt ?? timestamp,updatedAt:timestamp});
      write(`${prefix}/README.md`,environment.runbook);
      const questions = {schemaVersion:1,projectId,environmentId,revision:(old(`${prefix}/quick-questions.json`)?.revision ?? 0)+1,items:environment.questions.map(q => ({...q,createdAt:timestamp,updatedAt:timestamp}))};
      this.store.validateQuickQuestionsDocument(questions,projectId,environmentId);
      write(`${prefix}/quick-questions.json`,JSON.stringify(questions));
      for (const item of environment.plugins) {
        const file = `${prefix}/plugins/${item.config.pluginInstanceId}.yaml`;
        const plugin = normalizePlugin(item.config,{projectId,environmentId});
        plugin.revision = (old(file)?.revision ?? 0)+1;
        plugin.updatedAt = timestamp;
        yaml(file,plugin);
        plugins.push({plugin,secrets:item.secrets});
      }
    }
    return {projectId,files,entries:await this.vault.encryptProjectEntries(plugins)};
  }
  validateRecord(record) {
    cloudId(record.id);
    this.store.projectDir(record.projectId);
    if (record.schemaVersion !== 1 || !['prepared','committed','backup'].includes(record.phase)) throw cloudError('FORMAT_INVALID','本机事务记录无效。');
    for (const snapshot of [record.before,record.after].filter(Boolean)) {
      if (snapshot.projectId !== record.projectId || !snapshot.files || !snapshot.entries?.primary || !snapshot.entries?.backup) throw cloudError('FORMAT_INVALID','本机事务作用域无效。');
      for (const [file,content] of Object.entries(snapshot.files)) if (!FILE.test(file) || typeof content !== 'string') throw cloudError('FORMAT_INVALID','本机事务文件无效。');
    }
    return record;
  }
  async replace(target,other) {
    const projectId = target.projectId;
    // 只操作结构化快照内的配置文件；审计、历史文件和其他项目不参与覆盖。
    for (const [relative,encoded] of Object.entries(target.files)) {
      await this.store.atomicWrite(await this.safeFile(projectId,relative),Buffer.from(encoded,'base64'));
    }
    for (const relative of Object.keys(other.files)) {
      if (!Object.hasOwn(target.files,relative)) await fs.rm(await this.safeFile(projectId,relative),{force:true});
    }
    await this.vault.restoreProjectEntries(projectId,target.entries);
    if (!target.files['workspace.yaml']) {
      const root = this.store.projectDir(projectId);
      const directories = new Set(Object.keys(other.files).map(file => path.dirname(path.join(root,file))));
      for (const dir of [...directories].sort((a,b) => b.length-a.length)) {
        let current = dir;
        while (current.startsWith(`${root}${path.sep}`)) {
          await fs.rmdir(current).catch(error => { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; });
          current = path.dirname(current);
        }
      }
      await fs.rmdir(root).catch(error => { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; });
    }
  }
  rebaseRestore(saved,current) {
    const restored = structuredClone(saved);
    for (const [relative,content] of Object.entries(restored.files)) {
      if (!relative.endsWith('.yaml') && !relative.endsWith('quick-questions.json')) continue;
      const json = relative.endsWith('.json');
      const parse = value => json ? JSON.parse(value) : YAML.parse(value);
      const value = parse(Buffer.from(content,'base64').toString('utf8'));
      const previous = current.files[relative] ? parse(Buffer.from(current.files[relative],'base64').toString('utf8')) : null;
      value.revision = Math.max(value.revision ?? 0,previous?.revision ?? 0)+1;
      if (!json) value.updatedAt = stamp();
      restored.files[relative] = Buffer.from(json ? JSON.stringify(value) : YAML.stringify(value,{lineWidth:0})).toString('base64');
    }
    return restored;
  }
  async commit(before,after) {
    this.assertProjectAvailable(before.projectId);
    const record = {schemaVersion:1,id:crypto.randomUUID(),projectId:before.projectId,createdAt:stamp(),phase:'prepared',before,after};
    const journal = path.join(this.directory,'transactions',`${record.id}.json`);
    const backup = path.join(this.directory,'backups',`${record.id}.json`);
    await this.writeSealed(backup,{...record,phase:'backup',after:null});
    await this.writeSealed(journal,record);
    this.blocked.add(record.projectId);
    try {
      await this.replace(after,before);
      await this.writeSealed(journal,{...record,phase:'committed'});
    } catch (error) {
      try {
        await this.replace(before,after);
        await fs.rm(journal);
        this.blocked.delete(record.projectId);
      } catch { throw cloudError('RECOVERY_REQUIRED','导入未完成且恢复需要重试，已隔离项目并保留加密备份。'); }
      throw error;
    }
    // 提交标记持久化后，即使清理失败也不回滚已完成的数据。
    let cleanupPending = false;
    try { await fs.rm(journal); this.blocked.delete(record.projectId); }
    catch { cleanupPending = true; }
    return {backupId:record.id,cleanupPending};
  }
  async recoverAll() {
    const directory = path.join(this.directory,'transactions');
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return; this.blockAll = true; return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record;
      try {
        record = this.validateRecord(await this.unseal(await fs.readFile(path.join(directory,name),'utf8')));
        if (name !== `${record.id}.json`) throw cloudError('FORMAT_INVALID','本机事务标识无效。');
        this.blocked.add(record.projectId);
        await this.replace(record.phase === 'committed' ? record.after : record.before,record.phase === 'committed' ? record.before : record.after);
        await fs.rm(path.join(directory,name));
        this.blocked.delete(record.projectId);
      } catch { if (record?.projectId) this.blocked.add(record.projectId); else this.blockAll = true; }
    }
  }
  async readBackup(backupId) {
    const file = path.join(this.directory,'backups',`${cloudId(backupId)}.json`);
    const text = await fs.readFile(file,'utf8');
    const record = this.validateRecord(await this.unseal(text));
    if (record.id !== backupId || record.phase !== 'backup') throw cloudError('FORMAT_INVALID','本机备份标识无效。');
    return {record,digest:snapshotDigest(text)};
  }
  backupSummary(record) {
    if (!record.before.files['workspace.yaml']) return null;
    const project = YAML.parse(Buffer.from(record.before.files['workspace.yaml'],'base64').toString('utf8'));
    return {backupId:record.id,projectId:record.projectId,name:project.name,createdAt:record.createdAt};
  }
  async listBackups({offset = 0,limit = 20} = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw cloudError('INVALID_ARGUMENT','备份分页参数无效。');
    const directory = path.join(this.directory,'backups');
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return {backups:[],unreadableBackups:0,nextBackupOffset:null}; throw error; }
    // Sort cheap filesystem metadata first; decrypt only the requested page.
    const files = await Promise.all(names.filter(n => n.endsWith('.json')).map(async name => ({name,mtime:(await fs.stat(path.join(directory,name)).catch(() => null))?.mtimeMs ?? 0})));
    files.sort((a,b) => b.mtime-a.mtime || a.name.localeCompare(b.name));
    const result = [];
    let unreadableBackups = 0;
    for (const {name} of files.slice(offset,offset+limit)) {
      try {
        const {record} = await this.readBackup(name.slice(0,-5));
        const summary = this.backupSummary(record);
        if (summary) result.push(summary);
      } catch { unreadableBackups++; }
    }
    return {backups:result,unreadableBackups,nextBackupOffset:offset+limit < files.length ? offset+limit : null};
  }
}
