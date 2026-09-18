import { AppError } from './errors.mjs';
import { pluginConnectionFingerprint } from './plugin-change-classifier.mjs';
import { cpuPercent, parseDiskMetrics, parseSystemMetrics } from './server-metrics-reader.mjs';

const keyFor = scope => JSON.stringify([scope.projectId, scope.environmentId, scope.pluginInstanceId]);
const empty = () => ({ cpu:null, memory:null, disks:[], sampledAt:null, diskSampledAt:null, error:null, diskError:null, unsupported:false, disksTruncated:false });
const metricError = error => ['METRICS_TIMEOUT','METRICS_OUTPUT_LIMIT','METRICS_INVALID','COMMAND_BLOCKED'].includes(error?.code) ? error.code : 'METRICS_UNAVAILABLE';
const INTERVALS = { system:5000, disks:30000 };

export class ServerWorkspaceMetrics {
  constructor({ workspaceStore, serverRuntime, requirePlugin, now = Date.now }) {
    Object.assign(this, { workspaceStore, serverRuntime, requirePlugin, now });
    this.records = new Map();
    this.disposed = false;
  }

  async audit(record, type, result, required = false) {
    try {
      await this.workspaceStore.appendAudit(record.scope.projectId, {
        ...record.scope, pluginType:'server', origin:'desktop-human', type, result, generation:record.generation,
      });
    } catch {
      if (required) throw new AppError('METRICS_AUDIT_UNAVAILABLE', '无法记录资源监控会话，请检查本地审计存储。');
    }
  }

  valid(record) {
    if (this.disposed || record.controller.signal.aborted || this.records.get(record.key) !== record) {
      throw new AppError('METRICS_CANCELLED', '资源采集已停止。');
    }
  }

  read(owner, scope, kind = 'system') {
    if (kind !== 'system' && kind !== 'disks') return Promise.reject(new AppError('INVALID_ARGUMENT', '服务器指标采样类型无效。'));
    if (this.disposed) return Promise.reject(new AppError('WORKSPACE_CLOSED', '服务器工作区已经关闭。'));
    const key = keyFor(scope);
    let record = this.records.get(key);
    if (!record) {
      if (this.records.size >= 32) return Promise.reject(new AppError('METRICS_LIMIT_REACHED', '同时监控的服务器过多。'));
      record = { key, scope, owners:new Set(), controller:new AbortController(), snapshot:empty(), previous:null, previousAt:0,
        nextAt:{system:0,disks:0}, pending:{system:null,disks:null}, initialization:null, generation:null, fingerprint:null, started:false, lastResult:{} };
      this.records.set(key, record);
    }
    record.owners.add(owner);
    // 同一服务器按指标分别合并并发请求，磁盘变慢不会阻塞系统采样。
    if (!record.pending[kind]) record.pending[kind] = this.collect(record, kind).catch(error => {
      if (this.records.get(record.key) === record) this.release(record, 'read-failed');
      throw error;
    }).finally(() => { record.pending[kind] = null; });
    return record.pending[kind];
  }

  async initialize(record) {
    const plugin = await this.requirePlugin(record.scope);
    this.valid(record);
    record.generation = this.serverRuntime.status(plugin)?.generation;
    record.fingerprint = pluginConnectionFingerprint(plugin);
    await this.audit(record, 'server-metrics-start', 'started', true);
    record.started = true;
    if (record.controller.signal.aborted) await this.audit(record, 'server-metrics-stop', 'paused');
    this.valid(record);
  }

  async currentPlugin(record) {
    const plugin = await this.requirePlugin(record.scope);
    this.valid(record);
    if (this.serverRuntime.status(plugin)?.generation !== record.generation || pluginConnectionFingerprint(plugin) !== record.fingerprint) {
      throw new AppError('METRICS_CANCELLED', '服务器连接已更新，请重新采样。');
    }
    return plugin;
  }

  response(record, kind) {
    return { ...structuredClone(record.snapshot), retryAfterMs:Math.max(0, record.nextAt[kind] - this.now()) };
  }

  async collect(record, kind) {
    // 首次系统与磁盘请求共用验证和启动审计，停止后不能迟到启动远程命令。
    record.initialization ??= this.initialize(record);
    await record.initialization;
    const plugin = await this.currentPlugin(record);
    if (record.snapshot.unsupported || this.now() < record.nextAt[kind]) return this.response(record, kind);
    let patch, previous = record.previous, sampledAt = record.previousAt, interval = INTERVALS[kind];
    try {
      const raw = await this.serverRuntime.readWorkspaceMetrics(plugin, kind, { signal:record.controller.signal });
      this.valid(record);
      if (kind === 'system') {
        const data = parseSystemMetrics(raw.stdout);
        sampledAt = this.now();
        if (data.unsupported) {
          patch = { ...empty(), unsupported:true };
          previous = null;
        } else {
          const baseline = sampledAt - record.previousAt <= 15000 ? record.previous : null;
          const percent = cpuPercent(baseline, data.cpu);
          // 首轮或断线恢复后仅加快一次补采，常规采样仍保持五秒。
          if (data.cpu && !baseline) interval = 1000;
          previous = data.cpu;
          patch = { cpu:data.cpu ? { percent, cores:data.cpu.cores } : null, memory:data.memory, sampledAt, error:null };
        }
      } else {
        if (raw.exitCode !== 0) throw new AppError('METRICS_UNAVAILABLE', '磁盘信息暂时无法读取。');
        const data = parseDiskMetrics(raw.stdout);
        patch = { disks:data.items, disksTruncated:data.truncated, diskSampledAt:this.now(), diskError:null };
      }
    } catch (error) {
      this.valid(record);
      if (kind === 'system') { previous = null; patch = { error:metricError(error) }; }
      else patch = { diskError:metricError(error) };
    }
    await this.currentPlugin(record);
    if (!record.snapshot.unsupported) {
      record.snapshot = { ...record.snapshot, ...patch };
      if (kind === 'system') { record.previous = previous; record.previousAt = sampledAt; }
    }
    record.nextAt[kind] = this.now() + interval;
    const result = record.snapshot.unsupported ? 'unsupported'
      : kind === 'system' ? record.snapshot.error || !record.snapshot.cpu || !record.snapshot.memory ? 'partial' : 'ready'
      : record.snapshot.diskError ? 'partial' : 'ready';
    if (record.lastResult[kind] !== result) {
      record.lastResult[kind] = result;
      await this.audit(record, 'server-metrics-status', kind + ':' + result);
      this.valid(record);
    }
    // 返回剩余等待时间，提前请求只补等剩余时间，不会额外等待完整周期。
    return this.response(record, kind);
  }

  release(record, reason) {
    this.records.delete(record.key);
    record.controller.abort();
    if (record.started) void this.audit(record, 'server-metrics-stop', reason);
  }

  stop(owner, scope) {
    const record = this.records.get(keyFor(scope));
    if (record) {
      record.owners.delete(owner);
      if (!record.owners.size) this.release(record, 'paused');
    }
    return { stopped:true };
  }

  closeOwner(owner) {
    for (const record of this.records.values()) this.stop(owner, record.scope);
  }

  closeScope(scope) {
    for (const record of this.records.values()) {
      if (record.scope.projectId === scope.projectId
        && (!scope.environmentId || record.scope.environmentId === scope.environmentId)
        && (!scope.pluginInstanceId || record.scope.pluginInstanceId === scope.pluginInstanceId)) this.release(record, 'scope-invalidated');
    }
  }

  dispose() {
    this.disposed = true;
    for (const record of this.records.values()) this.release(record, 'application-closed');
  }
}
