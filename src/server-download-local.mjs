import fsp from 'node:fs/promises';
import { AppError } from './errors.mjs';

export function localDownloadError(error) {
  if (error instanceof AppError || error?.name === 'AbortError') return error;
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return new AppError('DOWNLOAD_DISK_FULL', '本地保存位置空间不足，请释放空间或选择其他磁盘。');
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return new AppError('DOWNLOAD_ACCESS_DENIED', '无法写入本地保存位置，请检查目录或文件权限，或选择其他位置。');
  if (['EBUSY', 'ETXTBSY'].includes(error?.code)) return new AppError('DOWNLOAD_FILE_BUSY', '本地文件正被其他程序占用，请关闭占用程序后重试。');
  if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) return new AppError('DOWNLOAD_SAVE_UNSUPPORTED', '保存位置不支持安全提交，请选择支持硬链接的本地磁盘目录。');
  if (['ENOENT', 'ENOTDIR', 'EEXIST'].includes(error?.code)) return new AppError('DOWNLOAD_TARGET_CHANGED', '本地保存位置已变化，请重新选择下载位置。');
  return new AppError('DOWNLOAD_SAVE_FAILED', '本地文件保存失败，请检查保存位置后重试。');
}

export async function localDownloadIO(operation) {
  try { return await operation(); } catch (error) { throw localDownloadError(error); }
}

// 在读取远端内容前检查可用空间，并用当前任务的空临时文件验证独占发布能力。
export async function preflightDownloadDestination(temporary, destination, bytes) {
  await localDownloadIO(async () => {
    let space;
    try { space = await fsp.statfs(destination.parent, {bigint:true}); }
    catch (error) { if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }
    if (space && space.bavail * space.bsize < BigInt(bytes)) throw Object.assign(new Error('本地空间不足'), {code:'ENOSPC'});
    if (destination.original) return;
    const probe = temporary + '.check';
    let created = false;
    try {
      await fsp.link(temporary, probe);
      created = true;
    } finally {
      if (created) await fsp.unlink(probe);
    }
  });
}
