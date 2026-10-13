import crypto from 'node:crypto';
import net from 'node:net';
import { AppError } from './errors.mjs';

export const SOURCE_PROTOCOL = 'cmr-source/1';
export const SOURCE_LIMITS = Object.freeze({maxFiles:20000,maxFileBytes:16*1024*1024,maxTotalBytes:256*1024*1024,maxArchiveBytes:300*1024*1024,maxManifestBytes:8*1024*1024,maxBatchFiles:128,maxBatchBytes:16*1024*1024});
export const sourceHash = value => crypto.createHash('sha256').update(value).digest('hex');
export const SOURCE_HASH = /^[a-f0-9]{64}$/;
export const SOURCE_PROJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const sourceError = message => new AppError('SOURCE_INVALID',message);

export function normalizeServiceUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw sourceError('服务地址必须是完整的 HTTP 或 HTTPS 地址。'); }
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || (net.isIP(host) === 4 && (/^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)))
    || (net.isIP(host) === 6 && (host === '::1' || /^f[cd]/i.test(host)));
  if (text.length > 2048 || url.username || url.password || url.search || url.hash || !['https:','http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !privateHost)) throw sourceError('服务地址不能包含凭据、查询参数或片段；公网服务请使用 HTTPS。');
  return url.href.replace(/\/+$/,'');
}

export function sourcePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || value !== value.normalize('NFC')
    || /[\\\x00-\x1f\x7f:<>"|?*]/.test(value) || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || part.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw sourceError('源码包含不安全或不可移植的路径。');
  return value;
}

export function validateManifest(value, projectId, snapshotId) {
  const m = value;
  if (!m || m.protocol !== SOURCE_PROTOCOL || m.projectId !== projectId || !SOURCE_PROJECT.test(projectId)
    || !SOURCE_HASH.test(snapshotId) || m.snapshotId !== snapshotId || !/^[a-f0-9]{40,64}$/.test(m.revision)
    || m.exportVersion !== 1 || !SOURCE_HASH.test(m.sourceIdentity) || !Array.isArray(m.files)
    || m.files.length > SOURCE_LIMITS.maxFiles || m.fileCount !== m.files.length
    || !Number.isSafeInteger(m.archiveBytes) || m.archiveBytes < 22 || m.archiveBytes > SOURCE_LIMITS.maxArchiveBytes
    || !SOURCE_HASH.test(m.archiveSha256)) throw sourceError('源码清单格式或版本无效。');
  const paths = new Map(), sizes = new Map();
  let total = 0, previous = '';
  const files = m.files.map(file => {
    sourcePath(file.path);
    if (file.type !== 'file' || ![0o644,0o755].includes(file.mode) || !Number.isSafeInteger(file.size) || file.size < 0
      || file.size > SOURCE_LIMITS.maxFileBytes || !SOURCE_HASH.test(file.sha256) || file.path <= previous
      || paths.has(file.path.toLowerCase()) || (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.size)) throw sourceError('源码文件清单无效。');
    // Canonical key order is part of cmr-source/1's digest contract.
    const entry = {path:file.path,type:'file',mode:file.mode,size:file.size,sha256:file.sha256};
    previous = file.path;
    total += file.size;
    paths.set(file.path.toLowerCase(),file.path);
    sizes.set(file.sha256,file.size);
    return entry;
  });
  const directories = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    while (parts.length) {
      const directory = parts.join('/'), key = directory.toLowerCase();
      if (paths.has(key) || (directories.has(key) && directories.get(key) !== directory)) throw sourceError('源码目录存在名称冲突。');
      directories.set(key,directory);
      parts.pop();
    }
  }
  if (total !== m.totalBytes || total > SOURCE_LIMITS.maxTotalBytes
    || sourceHash(JSON.stringify({projectId,revision:m.revision,exportVersion:1,sourceIdentity:m.sourceIdentity,files})) !== snapshotId) throw sourceError('源码清单哈希校验失败。');
  return {protocol:SOURCE_PROTOCOL,projectId,snapshotId,revision:m.revision,exportVersion:1,sourceIdentity:m.sourceIdentity,files,
    fileCount:files.length,totalBytes:total,archiveBytes:m.archiveBytes,archiveSha256:m.archiveSha256,
    createdAt:typeof m.createdAt === 'string' && m.createdAt.length < 40 ? m.createdAt : ''};
}

export function sourceCacheIdentity(plugin) {
  return sourceHash(JSON.stringify([plugin.projectId,plugin.environmentId,plugin.pluginInstanceId,plugin.target?.serviceUrl,plugin.target?.remoteProjectId]));
}

export async function readBounded(body, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > maxBytes) throw sourceError('源码响应超过大小限制。');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks,size);
  } catch (error) { body.destroy?.(); throw error; }
}
