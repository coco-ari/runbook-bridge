import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { AUDIT_ACTORS, AUDIT_RESULTS, presentAuditEvent } from './audit-record.mjs';

const WINDOW = 512;
const MAX_WINDOWS = 8;
const MAX_TIMELINE = 64;
const scope = entry => JSON.stringify([entry.environmentId ?? '', entry.pluginInstanceId ?? '']);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
const matchesScope = (entry, filters) => (!filters.environmentId || entry.environmentId === filters.environmentId)
  && (!filters.pluginInstanceId || entry.pluginInstanceId === filters.pluginInstanceId);

function groupKey(entry, offset) {
  if (identifier(entry.confirmationId)) return `${scope(entry)}:confirmation:${entry.confirmationId}`;
  if (identifier(entry.planId)) return `${entry.environmentId ?? ''}:plan:${entry.planId}`;
  if (identifier(entry.operationId)) return `${scope(entry)}:operation:${entry.operationId}`;
  if (identifier(entry.sessionId)) return `${scope(entry)}:session:${entry.sessionId}:${entry.type?.startsWith('terminal-') ? 'terminal' : 'metrics'}`;
  if (identifier(entry.requestId) && ['plugin-operation-started','plugin-operation'].includes(entry.type)) {
    return `${scope(entry)}:legacy:${entry.requestId}:${entry.actor ?? ''}:${entry.capability ?? ''}`;
  }
  return `event:${offset}`;
}

function normalizeFilters(input) {
  if (input.includeRedisScans !== undefined && typeof input.includeRedisScans !== 'boolean') throw new AppError('INVALID_ARGUMENT', '扫描记录筛选条件无效。');
  const result = {includeRedisScans:input.includeRedisScans === true};
  for (const field of ['environmentId','pluginInstanceId','actor','category','result','query','from','to']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > (field === 'query' ? 200 : 128))) {
      throw new AppError('INVALID_ARGUMENT', '操作记录筛选条件无效。');
    }
    result[field] = input[field]?.trim() ?? '';
  }
  for (const field of ['from','to']) if (result[field] && !Number.isFinite(Date.parse(result[field]))) throw new AppError('INVALID_ARGUMENT', '操作记录日期无效。');
  if (result.from && result.to && Date.parse(result.from) > Date.parse(result.to)) throw new AppError('INVALID_ARGUMENT', '开始时间不能晚于结束时间。');
  return result;
}

function matches(operation, filters) {
  // 仅隐藏桌面用户的成功扫描，异常和其他来源仍保留在默认视图。
  if (!filters.includeRedisScans && operation.action === 'redis.scan' && operation.actor === 'user'
    && operation.result === 'success' && !operation.errorCode
    && operation.timeline.every(event => ['success','unknown'].includes(event.result) && !event.errorCode)) return false;
  if (filters.actor && filters.actor !== 'all' && !operation.participants.includes(filters.actor)) return false;
  if (filters.category && filters.category !== 'all' && operation.category !== filters.category) return false;
  if (filters.result && filters.result !== 'all' && operation.result !== filters.result) return false;
  const time = Date.parse(operation.updatedAt);
  if (filters.from && (!Number.isFinite(time) || time < Date.parse(filters.from))) return false;
  if (filters.to && (!Number.isFinite(time) || time > Date.parse(filters.to))) return false;
  if (filters.query) {
    const text = [operation.title,operation.target,operation.pluginNameSnapshot,operation.errorCode,operation.errorSummary,
      AUDIT_RESULTS[operation.result],...operation.participants.map(actor => AUDIT_ACTORS[actor]),
      ...operation.timeline.map(event => `${event.title} ${event.target} ${event.pluginNameSnapshot}`)].join(' ').toLocaleLowerCase('zh-CN');
    if (!text.includes(filters.query.toLocaleLowerCase('zh-CN'))) return false;
  }
  return true;
}

function aggregate(group, active, sessionId) {
  const latest = group.latest;
  const first = group.first;
  const entry = latest.entry;
  const operation = {...presentAuditEvent(entry,latest.offset)};
  const firstEvent = presentAuditEvent(first.entry,first.offset);
  const execution = group.execution ? presentAuditEvent(group.execution.entry,group.execution.offset) : firstEvent;
  if (operation.title === '操作类型未记录' || entry.type?.startsWith('confirmation-')) {
    Object.assign(operation,{title:execution.title,action:execution.action,category:execution.category});
  }
  operation.actor = group.initiator ?? (first.entry.type.startsWith('confirmation-') ? 'unknown' : firstEvent.actor);
  operation.target ||= execution.target || firstEvent.target;
  if (operation.pluginNameSnapshot === '插件名称未记录') operation.pluginNameSnapshot = execution.pluginNameSnapshot;
  if (active.has(group.key)) operation.result = 'running';
  if (['pending','approved'].includes(operation.result)) {
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) operation.result = 'expired';
    else if (entry.auditSessionId && entry.auditSessionId !== sessionId) operation.result = 'invalidated';
  }
  if (group.key.includes(':session:') && !['terminal-close','server-metrics-stop'].includes(entry.type) && !active.has(group.key)) operation.result = 'unknown';
  const events = [...group.events].sort((a,b) => a.offset - b.offset);
  operation.timeline = events.map(({entry:value,offset}) => presentAuditEvent(value,offset));
  operation.timelineTruncated = group.count > events.length;
  operation.eventCount = group.count;
  operation.participants = [...group.participants];
  operation.approval = group.approval;
  operation.time = firstEvent.time;
  operation.updatedAt = operationUpdated(latest);
  operation.auditId = crypto.createHash('sha256').update(group.key).digest('hex').slice(0,32);
  if (operation.durationMs === undefined && group.starts === 1 && group.ends === 1) {
    const duration = Date.parse(operation.updatedAt) - Date.parse(operation.time);
    if (Number.isFinite(duration) && duration >= 0) operation.durationMs = duration;
  }
  return {...operation,_offset:latest.offset};
}

const operationUpdated = ({entry}) => Number.isFinite(Date.parse(entry.time)) ? entry.time : null;
const stale = () => new AppError('AUDIT_CURSOR_STALE', '记录已清除或分页已失效，请刷新后重试。');

export class AuditHistory {
  constructor() {
    this.secret = crypto.randomBytes(32);
    this.sessionId = crypto.randomUUID();
    this.active = new Set();
    this.reads = 0;
  }

  observe(entry) {
    if (entry.auditNested) return;
    const key = groupKey(entry, 0);
    if (key.startsWith('event:') || key.includes(':legacy:') || key.includes(':plan:')) return;
    if (entry.result === 'started' || entry.type === 'terminal-open') {
      if (this.active.size < 4096) this.active.add(key);
    } else if (entry.type !== 'server-metrics-status') this.active.delete(key);
  }

  encode(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256',this.secret).update(body).digest('base64url')}`;
  }

  decode(cursor, binding) {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw stale();
    const [body,signature] = cursor.split('.');
    const expected = crypto.createHmac('sha256',this.secret).update(body ?? '').digest('base64url');
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) throw stale();
    let value;
    try { value = JSON.parse(Buffer.from(body,'base64url').toString()); } catch { throw stale(); }
    if (value.binding !== binding || !Number.isSafeInteger(value.end) || !Number.isSafeInteger(value.before) || value.before < 0 || value.before > value.end) throw stale();
    return value;
  }

  async list(file, input, readLines) {
    if (this.reads >= 2) throw new AppError('READ_BUSY', '操作记录正在读取，请稍后重试。');
    this.reads += 1;
    try { return await this.readPage(file, input, readLines); }
    finally { this.reads -= 1; }
  }

  async readPage(file, input, readLines) {
    const filters = normalizeFilters(input);
    const limit = Math.min(100,Math.max(1,Math.trunc(Number(input.limit) || 50)));
    const binding = crypto.createHash('sha256').update(JSON.stringify([file,filters])).digest('hex');
    const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) { if (input.cursor) throw stale(); return {entries:[],nextCursor:null}; }
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const snapshot = input.cursor ? this.decode(input.cursor,binding) : {binding,identity,end:stat.size,before:stat.size};
    if (snapshot.identity !== identity || stat.size < snapshot.end) throw stale();
    let before = snapshot.before;
    const output = [];
    // 候选窗口和每项过程均有上限；分两次流式读取，确保跨页的开始、审批、结束仍属同一次操作。
    for (let window = 0; window < MAX_WINDOWS && before > 0 && output.length < limit; window += 1) {
      const candidates = new Map();
      let floor = 0, count = 0;
      for await (const {line,offset} of readLines(file,{endPosition:before,withOffset:true})) {
        floor = offset;
        count += 1;
        let entry;
        try { entry = JSON.parse(line); } catch { if (count >= WINDOW) break; continue; }
        if (entry && typeof entry.type === 'string' && matchesScope(entry,filters)) {
          const key = groupKey(entry,offset);
          if (!candidates.has(key)) candidates.set(key,{key,events:[],windowEvents:[],participants:new Set(),count:0,starts:0,ends:0,approval:null});
          candidates.get(key).windowEvents.push({entry,offset});
        }
        if (count >= WINDOW) break;
      }
      if (candidates.size) for await (const {line,offset} of readLines(file,{endPosition:snapshot.end,withOffset:true})) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry.type !== 'string' || !matchesScope(entry,filters)) continue;
        const group = candidates.get(groupKey(entry,offset));
        if (!group) continue;
        const event = {entry,offset};
        group.latest ??= event;
        group.first = event;
        group.count += 1;
        if (group.events.length < MAX_TIMELINE) group.events.push(event);
        else group.events[MAX_TIMELINE - 1] = event;
        const presented = presentAuditEvent(entry,offset);
        group.participants.add(presented.actor);
        if (!entry.type.startsWith('confirmation-') && entry.type !== 'server-metrics-status' && entry.type !== 'server-metrics-stop') group.initiator = presented.actor;
        if (['plugin-operation','plugin-operation-started','plugin-operation-decision'].includes(entry.type)) group.execution ??= event;
        if (entry.result === 'started') group.starts += 1;
        if (entry.type === 'plugin-operation') group.ends += 1;
        if (entry.type === 'confirmation-approved' && !group.approval) group.approval = 'approved';
        if (entry.type === 'confirmation-rejected' && !group.approval) group.approval = 'rejected';
      }
      const operations = [];
      for (const group of candidates.values()) {
        if (group.key.includes(':legacy:') && (group.starts > 1 || group.ends > 1)) {
          for (const {entry,offset} of group.windowEvents) {
            const event = presentAuditEvent(entry,offset);
            operations.push({...event,participants:[event.actor],updatedAt:event.time,timeline:[event],eventCount:1,_offset:offset});
          }
        } else if (group.latest?.offset < before && group.latest.offset >= floor) operations.push(aggregate(group,this.active,this.sessionId));
      }
      operations.sort((a,b) => b._offset - a._offset);
      const matching = operations.filter(operation => matches(operation,filters));
      const take = matching.slice(0,limit - output.length);
      output.push(...take);
      before = take.length < matching.length ? take.at(-1)._offset : floor;
    }
    const after = await fs.stat(file).catch(() => null);
    if (!after || `${after.dev}:${after.ino}:${after.birthtimeMs}` !== identity || after.size < snapshot.end) throw stale();
    return {
      entries:output.map(({_offset,...operation}) => operation),
      nextCursor:before > 0 ? this.encode({...snapshot,before}) : null,
      scanning:before > 0 && output.length < limit,
    };
  }
}
