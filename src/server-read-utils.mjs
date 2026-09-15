import path from 'node:path';
import { AppError } from './errors.mjs';

export function globMatches(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u').test(name);
}


export function withinRoot(root, candidate) {
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '');
  const normalized = path.posix.normalize(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}


export function capText(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
}


export function normalizeRemotePath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text || text.length > 4096 || text.includes('\0') || !text.startsWith('/')) {
    throw new AppError('PATH_INVALID', '服务器路径必须是绝对路径。');
  }
  return path.posix.normalize(text);
}


export function namePattern(value) {
  const pattern = String(value ?? '*').trim() || '*';
  if (pattern.length > 256 || pattern.includes('/') || pattern.includes('\\') || pattern.includes('\0')) {
    throw new AppError('INVALID_ARGUMENT', '文件名模式只能匹配单个文件名。');
  }
  return pattern;
}


export function archiveSuffix(name) {
  const lower = String(name ?? '').toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return 'gzip';
  return null;
}


export function assertLogReadIdentity(file, read, { allowGrowth = false } = {}) {
  const grew = Number(read.size) > Number(file.size);
  if (Number.isFinite(Number(file.size)) && Number(read.size) !== Number(file.size) && !(allowGrowth && grew)) {
    throw new AppError('SOURCE_CHANGED', '日志文件大小已经变化，请重新搜索。');
  }
  if (Number.isFinite(Number(file.mtime)) && Number(read.mtime) !== Number(file.mtime)
    && !(allowGrowth && grew && Number(read.mtime) >= Number(file.mtime))) {
    throw new AppError('SOURCE_CHANGED', '日志文件修改时间已经变化，请重新搜索。');
  }
  if (path.posix.normalize(read.canonicalPath) !== path.posix.normalize(file.canonicalPath ?? file.path)) {
    throw new AppError('SOURCE_CHANGED', '日志文件路径在搜索期间已经变化，请重新搜索。', { reason:'path' });
  }
  if (file.allowedRoot && !withinRoot(file.allowedRoot, read.canonicalPath)) {
    throw new AppError('SOURCE_NOT_ALLOWED', '日志文件已经移出登记的数据源。');
  }
  if (file.source && Math.max(Number(read.size), Number(read.observedSize ?? read.size)) > file.source.maxFileBytes) {
    throw new AppError('SOURCE_NOT_ALLOWED', '日志文件已经超过登记数据源的大小上限。');
  }
  if (!allowGrowth && read.sourceGrew) {
    throw new AppError('SOURCE_CHANGED', '归档在读取期间发生变化，请在轮转完成后重新搜索。');
  }
  return grew || read.sourceGrew === true;
}
