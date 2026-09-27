import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

const MAX_BYTES = 262_144;
const invalid = () => new AppError('INVALID_ARGUMENT', '文件读取位置无效，请重新查看头部或末尾。');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// 有界、无正文的签名游标绑定窗口、目标和连接；不保存日志或持久化阅读记录。
export class ServerWorkspaceLogReader {
  constructor(operations) { this.operations = operations; this.secret = crypto.randomBytes(32); }
  options(payload) {
    const {tail, cursor, followToken} = payload;
    if (tail !== undefined && typeof tail !== 'boolean') throw invalid();
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,15})$/u.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw invalid();
    if (followToken !== undefined && (typeof followToken !== 'string' || followToken.length > 4096 || !followToken)) throw invalid();
    if ((tail === true && cursor !== undefined) || (followToken !== undefined && (tail !== undefined || cursor !== undefined))) throw invalid();
  }
  signature(context, body) { return crypto.createHmac('sha256', this.secret).update(context).update('\0').update(body).digest('hex'); }
  decode(context, token) {
    const [body, mac, extra] = token.split('.');
    if (!body || !/^[a-f0-9]{64}$/u.test(mac ?? '') || extra !== undefined) throw invalid();
    if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.signature(context, body), 'hex'))) throw new AppError('WORKSPACE_CHANGED', '日志读取现场已变化，请重新查看末尾。');
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalid(); }
  }
  async read(plugin, payload, ownerId, binding, resolved, reader) {
    const context = JSON.stringify([ownerId, binding.scope, binding.revision, binding.generation, binding.epoch, payload.path, resolved.canonicalPath]);
    const previous = payload.followToken ? this.decode(context, payload.followToken) : null;
    let reset = false, resetReason;
    if (previous) {
      reset = resolved.size < previous.end;
      if (!reset && previous.anchorBytes) {
        const anchor = await this.operations.readFile(plugin, {path:resolved.canonicalPath, cursor:String(previous.anchorStart), maxBytes:previous.anchorBytes}, {reader});
        reset = hash(anchor.content) !== previous.anchorHash;
      } else if (!reset && resolved.size === previous.size && resolved.mtime !== previous.mtime) reset = true;
    }
    if (reset) resetReason = 'changed';
    else if (previous && resolved.size - previous.end > MAX_BYTES) { reset = true; resetReason = 'limit'; }
    const result = await this.operations.readFile(plugin, {path:resolved.canonicalPath, maxBytes:MAX_BYTES,
      ...(payload.tail || reset ? {tail:true} : {cursor:previous ? String(previous.end) : payload.cursor})}, {reader});
    if (result.content.includes('\0')) return {...result, reset, resetReason};
    // 从完整 Unicode 字符边界取最多 128 个字符，续读前核对衔接片段，检测截断/替换。
    const suffix = Array.from(result.content).slice(-128).join('');
    const anchorBytes = Buffer.byteLength(suffix);
    const state = suffix ? {end:result.endByte, size:result.size, mtime:result.mtime, anchorStart:result.endByte - anchorBytes, anchorBytes, anchorHash:hash(suffix)}
      : previous && !reset ? {...previous, end:result.endByte, size:result.size, mtime:result.mtime} : {end:result.endByte, size:result.size, mtime:result.mtime, anchorStart:result.endByte, anchorBytes:0};
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    return {...result, reset, resetReason, followToken:body + '.' + this.signature(context, body)};
  }
}
