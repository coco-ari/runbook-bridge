import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { CloudConfigWorkspace } from './cloud-config-workspace.mjs';
import { AppError } from './errors.mjs';
import { storedPluginSnapshot } from './mysql-connection-profile.mjs';

// 复用已有加密日志和提交标记协议，恢复范围仅包含本次插件与环境索引。
export class PluginBatchTransaction extends CloudConfigWorkspace {
  constructor(store,vault,encryption) {
    super(store,vault,encryption);
    this.directory = path.join(store.dataRoot,'runtime','plugin-batches');
    this.commitQueues = new Map();
  }

  commit(before,after) {
    const projectId = before.projectId;
    const previous = this.commitQueues.get(projectId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => super.commit(before,after)).catch(error => {
      if (error.code === 'CLOUD_RECOVERY_REQUIRED') throw new AppError('CONFIG_TRANSACTION_RECOVERY_REQUIRED','批量保存未完成，恢复需要重试；已隔离项目并保留加密恢复记录。');
      if (error.code === 'CLOUD_ENCRYPTION_UNAVAILABLE') throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE','系统安全存储不可用，无法安全保存插件组。');
      throw error;
    });
    this.commitQueues.set(projectId,pending);
    return pending.finally(() => {
      if (this.commitQueues.get(projectId) === pending) this.commitQueues.delete(projectId);
    });
  }

  assertProjectAvailable(projectId) {
    if (this.blockAll || this.blocked.has(projectId)) {
      throw new AppError('CONFIG_TRANSACTION_RECOVERY_REQUIRED','批量插件保存尚未安全恢复，请重启并检查本机安全存储。');
    }
  }

  async snapshot(projectId,environmentId,pluginIds,credentialIds = pluginIds) {
    const prefix = `environments/${environmentId}`;
    const files = {};
    for (const relative of [`${prefix}/environment.yaml`,...pluginIds.map(id => `${prefix}/plugins/${id}.yaml`)]) {
      try { files[relative] = (await fs.readFile(await this.safeFile(projectId,relative))).toString('base64'); }
      catch (error) { if (error.code !== 'ENOENT' || relative.endsWith('/environment.yaml')) throw error; }
    }
    const entries = await this.vault.capturePluginEntries(projectId,environmentId,credentialIds);
    return {projectId,environmentId,pluginIds:[...pluginIds],credentialIds:[...credentialIds],files,entries};
  }

  async commitPlugins(before,plugins,credentials,{creating = false,connections = null,removeCredentialIds = [],removePluginIds = []} = {}) {
    const after = structuredClone(before);
    for (const plugin of plugins) {
      const relative = `environments/${before.environmentId}/plugins/${plugin.pluginInstanceId}.yaml`;
      after.files[relative] = Buffer.from(YAML.stringify(storedPluginSnapshot(plugin),{lineWidth:0})).toString('base64');
    }
    for (const id of removePluginIds) delete after.files[`environments/${before.environmentId}/plugins/${id}.yaml`];
    if (creating || connections || removePluginIds.length) {
      const relative = `environments/${before.environmentId}/environment.yaml`;
      const environment = YAML.parse(Buffer.from(before.files[relative],'base64').toString('utf8'));
      if (creating) environment.pluginOrder.push(...plugins.map(plugin => plugin.pluginInstanceId).filter(id => !environment.pluginOrder.includes(id)));
      environment.pluginOrder = environment.pluginOrder.filter(id => !removePluginIds.includes(id));
      if (connections) { environment.schemaVersion = 2; environment.mysqlConnections = connections; }
      environment.revision += 1;
      environment.updatedAt = new Date().toISOString();
      after.files[relative] = Buffer.from(YAML.stringify(environment,{lineWidth:0})).toString('base64');
    }
    const encrypted = await this.vault.encryptProjectEntries(credentials);
    for (const slot of ['primary','backup']) {
      for (const id of removeCredentialIds) delete after.entries[slot][`${before.projectId}/${before.environmentId}/${id}`];
      Object.assign(after.entries[slot],encrypted[slot]);
    }
    return this.commit(before,after);
  }

  validateRecord(record) {
    super.validateRecord(record);
    for (const snapshot of [record.before,record.after].filter(Boolean)) {
      const {projectId,environmentId,pluginIds} = snapshot;
      if (!Array.isArray(pluginIds) || !pluginIds.length || pluginIds.length > 100 || new Set(pluginIds).size !== pluginIds.length) throw new Error('invalid batch');
      this.store.environmentPath(projectId,environmentId);
      for (const id of pluginIds) this.store.pluginPath(projectId,environmentId,id);
      const prefix = `environments/${environmentId}`;
      const allowed = new Set([`${prefix}/environment.yaml`,...pluginIds.map(id => `${prefix}/plugins/${id}.yaml`)]);
      if (Object.keys(snapshot.files).some(file => !allowed.has(file)) || !snapshot.files[`${prefix}/environment.yaml`]) throw new Error('invalid batch files');
      const credentialIds = snapshot.credentialIds ?? pluginIds;
      if (!Array.isArray(credentialIds) || credentialIds.length > 300) throw new Error('invalid credential scope');
      for (const id of credentialIds) this.store.pluginPath(projectId,environmentId,id);
      const keys = new Set(credentialIds.map(id => `${projectId}/${environmentId}/${id}`));
      for (const slot of ['primary','backup']) if (Object.keys(snapshot.entries[slot]).some(key => !keys.has(key))) throw new Error('invalid batch credentials');
      if (record.after && (record.after.environmentId !== record.before.environmentId || !isDeepStrictEqual(record.after.pluginIds,record.before.pluginIds))) throw new Error('invalid batch scope');
      if (record.after && !isDeepStrictEqual(record.after.credentialIds,record.before.credentialIds)) throw new Error('invalid credential scope');
    }
    return record;
  }

  async replace(target,other) {
    this.validateRecord({schemaVersion:1,id:crypto.randomUUID(),phase:'prepared',projectId:target.projectId,before:target,after:other});
    // 降级客户端或手动修改产生第三种状态时，保留现场，不能覆盖较新的数据。
    const current = await this.snapshot(target.projectId,target.environmentId,target.pluginIds,target.credentialIds ?? target.pluginIds);
    for (const file of new Set([...Object.keys(target.files),...Object.keys(other.files)])) {
      if (current.files[file] !== target.files[file] && current.files[file] !== other.files[file]) throw new AppError('CONFIG_REVISION_CONFLICT','批量事务涉及的配置已经变化，已保留恢复记录。');
    }
    for (const slot of ['primary','backup']) {
      for (const key of new Set([...Object.keys(current.entries[slot]),...Object.keys(target.entries[slot]),...Object.keys(other.entries[slot])])) {
        if (!isDeepStrictEqual(current.entries[slot][key],target.entries[slot][key]) && !isDeepStrictEqual(current.entries[slot][key],other.entries[slot][key])) throw new AppError('CONFIG_REVISION_CONFLICT','批量事务涉及的凭据已经变化，已保留恢复记录。');
      }
    }
    for (const [relative,encoded] of Object.entries(target.files)) await this.store.atomicWrite(await this.safeFile(target.projectId,relative),Buffer.from(encoded,'base64'));
    for (const relative of Object.keys(other.files)) if (!Object.hasOwn(target.files,relative)) await fs.rm(await this.safeFile(target.projectId,relative),{force:true});
    await this.vault.restorePluginEntries(target.projectId,target.environmentId,target.credentialIds ?? target.pluginIds,target.entries);
  }
}
