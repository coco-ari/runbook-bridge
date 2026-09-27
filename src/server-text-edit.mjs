import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { sftpCall } from './server-upload-transfer.mjs';

export const TEXT_EDIT_LIMIT = 1024 * 1024;
export const textHash = value => crypto.createHash('sha256').update(value).digest('hex');
const changed = () => new AppError('FILE_EDIT_CONFLICT', '远端文件已经变化。草稿已保留，请重新读取并核对差异。');
const sameStat = (a, b) => ['size', 'mtime', 'mode', 'uid', 'gid'].every(key => a[key] === b[key]);
export const sameTextSnapshot = (a, b) => sameStat(a, b) && a.sha256 === b.sha256;

export function editPath(value) {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/') || value.length > 4096
    || /[\u0000-\u001f\u007f\\]/u.test(value) || path.posix.normalize(value) !== value || value.endsWith('/')) {
    throw new AppError('PATH_INVALID', '编辑文件需要规范的绝对路径。');
  }
  return value;
}

export function textBytes(content) {
  if (typeof content !== 'string' || content.length > TEXT_EDIT_LIMIT || !content.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
    throw new AppError('FILE_EDIT_ENCODING', '仅支持完整 UTF-8 文本；二进制或包含特殊控制字符的文件不能编辑。');
  }
  const data = Buffer.from(content);
  if (data.length > TEXT_EDIT_LIMIT) throw new AppError('FILE_TOO_LARGE', '编辑文件不能超过 1 MiB。');
  return data;
}

async function inspect(sftp, target) {
  const parent = path.posix.dirname(target);
  if (await sftpCall(sftp, 'realpath', parent) !== parent || !(await sftpCall(sftp, 'lstat', parent)).isDirectory()) {
    throw new AppError('WORKSPACE_PATH_CHANGED', '父目录包含链接或已变化，请从实际路径打开文件。');
  }
  const stat = await sftpCall(sftp, 'lstat', target);
  if (!stat.isFile() || stat.isSymbolicLink() || await sftpCall(sftp, 'realpath', target) !== target) {
    throw new AppError('SOURCE_NOT_ALLOWED', '只能编辑普通文件，请使用实际路径，不支持符号链接或特殊文件。');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > TEXT_EDIT_LIMIT) throw new AppError('FILE_TOO_LARGE', '编辑文件不能超过 1 MiB。');
  return Object.fromEntries(['size', 'mtime', 'mode', 'uid', 'gid'].map(key => [key, stat[key]]));
}

export async function readEditableText(sftp, value, signal) {
  const target = editPath(value);
  signal?.throwIfAborted();
  const before = await inspect(sftp, target);
  const handle = await sftpCall(sftp, 'open', target, 'r');
  try {
    const opened = await sftpCall(sftp, 'fstat', handle);
    if (!opened.isFile() || !sameStat(before, opened)) throw changed();
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const count = await sftpCall(sftp, 'read', handle, data, offset, Math.min(32768, data.length - offset), offset);
      if (!Number.isInteger(count) || count <= 0 || count > data.length - offset) throw changed();
      offset += count;
    }
    if (!sameStat(before, await sftpCall(sftp, 'fstat', handle)) || !sameStat(before, await inspect(sftp, target))) throw changed();
    signal?.throwIfAborted();
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new AppError('FILE_EDIT_ENCODING', '此文件不是有效的 UTF-8 文本，保持只读以避免损坏编码。'); }
    textBytes(content);
    return { ...before, content, sha256: textHash(data) };
  } finally { if (!signal?.aborted) await sftpCall(sftp, 'close', handle).catch(() => {}); }
}

// 普通 SFTP 没有条件替换指令：提交前检查内容哈希和元数据，使用 OpenSSH 原子重命名。
// 不先删目标，不退化为原地截断，也不执行 Shell 或自动提权。
export async function replaceEditableText(sftp, { path: target, content, expected }, { signal, beforeCommit, onCommitting } = {}) {
  editPath(target);
  const data = textBytes(content);
  const verify = async () => {
    if (!sameTextSnapshot(await readEditableText(sftp, target, signal), expected)) throw changed();
  };
  await verify();
  const temporary = path.posix.join(path.posix.dirname(target), '.runbook-edit-' + crypto.randomUUID());
  let handle, created = false;
  try {
    handle = await sftpCall(sftp, 'open', temporary, 'wx', 0o600); created = true;
    for (let offset = 0; offset < data.length; offset += 32768) {
      signal?.throwIfAborted();
      await sftpCall(sftp, 'write', handle, data, offset, Math.min(32768, data.length - offset), offset);
    }
    await sftpCall(sftp, 'close', handle); handle = null;
    const written = await readEditableText(sftp, temporary, signal);
    if (written.sha256 !== textHash(data)) throw new AppError('TRANSFER_INTEGRITY_FAILED', '临时文件内容校验失败，原文件保持不变。');
    // 所有者和权限无法保留时明确失败，不悄悄把配置文件改成其他用户所有。
    await sftpCall(sftp, 'setstat', temporary, { uid: expected.uid, gid: expected.gid, mode: expected.mode & 0o7777 });
    const attributes = await inspect(sftp, temporary);
    if (['uid', 'gid', 'mode'].some(key => attributes[key] !== expected[key])) throw new AppError('FILE_EDIT_METADATA', '无法保留文件所有者或权限，已停止保存。');
    await beforeCommit?.();
    await verify();
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      try {
        onCommitting?.();
        sftp.ext_openssh_rename(temporary, target, error => error ? reject(error) : resolve());
      } catch (error) {
        if (typeof sftp.ext_openssh_rename !== 'function' || /does not support this extended request/u.test(String(error?.message))) {
          reject(new AppError('FILE_EDIT_ATOMIC_UNAVAILABLE', '此 SFTP 服务器不支持原子替换，无法安全保存；原文件保持不变。'));
        } else reject(error);
      }
    });
    created = false;
    return { bytes: data.length, sha256: textHash(data) };
  } finally {
    if (!signal?.aborted) {
      if (handle) await sftpCall(sftp, 'close', handle).catch(() => {});
      if (created) await sftpCall(sftp, 'unlink', temporary).catch(() => {});
    }
  }
}
