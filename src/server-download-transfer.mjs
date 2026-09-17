import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { abortable, sftpCall } from './server-upload-transfer.mjs';
import { uploadTimeouts } from './server-upload-progress.mjs';
import { localDownloadError, localDownloadIO, preflightDownloadDestination } from './server-download-local.mjs';

export const DESKTOP_DOWNLOAD_LIMIT = 500 * 1024 * 1024;
const changed = () => new AppError('DOWNLOAD_TARGET_CHANGED', '本地保存位置已变化，请重新选择下载位置。');
const identity = stat => ({size:stat.size, mtimeMs:stat.mtimeMs, ctimeMs:stat.ctimeMs, ino:stat.ino, dev:stat.dev, mode:stat.mode});

// 保存位置仅由主进程的原生另存为窗口提供，不接受 Renderer 传入的本地路径。
export async function downloadDestination(localPath) {
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || localPath.includes('\0')) throw changed();
  return localDownloadIO(async () => {
    const parent = await fsp.realpath(path.dirname(localPath));
    const target = path.join(parent, path.basename(localPath));
    // Windows 的流、设备名等不能作为普通下载文件。
    if (process.platform === 'win32' && (/[<>:"|?*]/u.test(path.basename(target)) || /[. ]$/u.test(target)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(path.basename(target)))) throw changed();
    let stat;
    try { stat = await fsp.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw changed();
    return {path:target, parent, parentIdentity:identity(await fsp.stat(parent)), original:stat ? identity(stat) : null};
  });
}

function matches(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
async function assertDestination(destination) {
  const current = await downloadDestination(destination.path);
  // 创建临时文件会改变目录时间，目录身份只比较设备及节点。
  if (current.parent !== destination.parent || current.parentIdentity.ino !== destination.parentIdentity.ino
    || current.parentIdentity.dev !== destination.parentIdentity.dev || !matches(current.original, destination.original)) throw changed();
}
const sourceChanged = () => new AppError('SOURCE_CHANGED', '下载期间源文件发生变化，请重新下载。');
function sameRemote(stat, expected) {
  return stat?.isFile?.() && !stat.isSymbolicLink?.() && stat.size === expected.size
    && stat.mtime === expected.mtime && stat.mode === expected.mode;
}

// 复用 ssh2 的有界并行读取；固定文件句柄，先写同目录临时文件，校验后才发布。
export async function downloadWorkspaceFile(broker, resource, remotePath, destination, expected, options = {}) {
  if (expected.type !== 'file' || expected.canonicalPath !== remotePath || !Number.isSafeInteger(expected.size)
    || expected.size < 0 || expected.size > DESKTOP_DOWNLOAD_LIMIT) throw new AppError('SOURCE_NOT_ALLOWED', '仅支持下载 500 MB 以内的普通文件。');
  const temporary = path.join(destination.parent, '.runbook-download-' + crypto.randomBytes(12).toString('hex') + '.part');
  let local;
  let owned = false;
  let committed = false;
  try {
    options.signal?.throwIfAborted();
    await assertDestination(destination);
    local = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    owned = true;
    await preflightDownloadDestination(temporary, destination, expected.size);
    options.signal?.throwIfAborted();
    await assertDestination(destination);
    await broker.withInternalSftp(resource, async (sftp, _session, lifecycle) => {
      const call = (method, ...args) => { lifecycle.signal.throwIfAborted(); return abortable(sftpCall(sftp, method, ...args), lifecycle.signal); };
      const checkSource = async handle => {
        if (!sameRemote(await call('lstat', remotePath), expected) || await call('realpath', remotePath) !== remotePath
          || (handle && !sameRemote(await call('fstat', handle), expected))) throw sourceChanged();
      };
      await checkSource();
      const handle = await call('open', remotePath, 'r');
      try {
        await checkSource(handle);
        options.onProgress?.({transferredBytes:0, phase:'uploading'});
        for (let position = 0; position < expected.size;) {
          const buffer = Buffer.allocUnsafe(Math.min(16 * 32 * 1024, expected.size - position));
          const reads = [];
          for (let offset = 0; offset < buffer.length; offset += 32 * 1024) {
            const start = offset;
            const length = Math.min(32 * 1024, buffer.length - start);
            reads.push((async () => {
              let read = 0;
              while (read < length) {
                const count = await call('read', handle, buffer, start + read, length - read, position + start + read);
                if (!Number.isSafeInteger(count) || count <= 0 || count > length - read) throw sourceChanged();
                read += count;
                lifecycle.reportProgress({phase:'download', transferredBytes:position + start + read, totalBytes:expected.size});
              }
            })());
          }
          await abortable(Promise.all(reads), lifecycle.signal);
          lifecycle.signal.throwIfAborted();
          let written = 0;
          while (written < buffer.length) {
            const result = await localDownloadIO(() => local.write(buffer, written, buffer.length - written, position + written));
            if (!result.bytesWritten) throw new AppError('TRANSFER_FAILED', '本地文件写入失败。');
            written += result.bytesWritten;
          }
          position += buffer.length;
          options.onProgress?.({transferredBytes:position, phase:'uploading'});
        }
        options.onProgress?.({transferredBytes:expected.size, phase:'verifying'});
        await checkSource(handle);
        if ((await localDownloadIO(() => local.stat())).size !== expected.size) throw new AppError('TRANSFER_INTEGRITY_FAILED', '下载文件大小不完整。');
        await localDownloadIO(() => local.sync());
        const temporaryIdentity = identity(await localDownloadIO(() => local.stat()));
        await localDownloadIO(() => local.close()); local = null;
        await options.beforeCommit?.();
        await assertDestination(destination);
        await checkSource(handle);
        lifecycle.signal.throwIfAborted();
        const namedTemporary = await localDownloadIO(() => fsp.lstat(temporary));
        if (!namedTemporary.isFile() || namedTemporary.isSymbolicLink() || !matches(identity(namedTemporary), temporaryIdentity)) throw changed();
        lifecycle.signal.throwIfAborted();
        // 不存在的目标使用独占硬链接发布，避免覆盖下载期间新出现的文件。
        try {
          if (destination.original) await fsp.rename(temporary, destination.path);
          else await fsp.link(temporary, destination.path);
          committed = true;
        } catch (error) {
          if (error.code === 'EEXIST') throw changed();
          throw localDownloadError(error);
        }
      } finally {
        if (!lifecycle.signal.aborted) await call('close', handle).catch(() => undefined);
      }
    }, {...uploadTimeouts(expected.size), timeoutMessage:'文件下载超过总时限，请检查网络后重试。', signal:options.signal});
    return {bytes:expected.size, localPath:destination.path};
  } catch (error) {
    if (committed) return {bytes:expected.size, localPath:destination.path};
    throw localDownloadError(error);
  } finally {
    await local?.close().catch(() => undefined);
    if (owned) await fsp.unlink(temporary).catch(() => undefined);
  }
}
