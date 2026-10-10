import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

const fail = () => new AppError('REDIS_EXPORT_FAILED', '导出失败，请检查目标文件权限、剩余空间及连接状态。');
const changed = () => new AppError('REDIS_VALUE_CHANGED', '导出期间内容已变化或过期，未生成文件，请重试。');
async function fingerprint(path) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail();
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 导出路径仅来自主进程保存对话框；分块写临时文件，一致性检查成功后才替换目标。
export async function exportRedisValue(connection, plugin, key, pickPath, assertCurrent, verifyCurrent) {
  if (typeof pickPath !== 'function') throw new AppError('REDIS_EXPORT_UNAVAILABLE', '当前窗口无法打开保存对话框。');
  const target = await pickPath();
  assertCurrent();
  if (!target) return { saved: false };
  const temporary = target + '.part-' + crypto.randomUUID();
  let file, created = false;
  try {
    const original = await fingerprint(target);
    const deadline = Date.now() + 5 * 60 * 1000;
    const command = async args => {
      assertCurrent();
      const value = await connection.command(args, Math.min(deadline, Date.now() + plugin.limits.timeoutMs));
      assertCurrent();
      return value;
    };
    await connection.open(Date.now() + plugin.limits.timeoutMs);
    await command(['WATCH', key]);
    const type = await command(['TYPE', key]);
    if (String(type) !== 'string') throw new AppError('REDIS_EDIT_READONLY', '当前仅支持导出 String 的原始内容。');
    const length = await command(['STRLEN', key]);
    if (!Number.isSafeInteger(length) || length < 0 || length > 512 * 1024 * 1024) throw new AppError('REDIS_VALUE_TOO_LARGE', '导出内容不能超过 512 MiB。');
    file = await fs.open(temporary, 'wx', 0o600);
    created = true;
    for (let offset = 0; offset < length;) {
      const size = Math.min(256 * 1024, length - offset);
      const value = await command(['GETRANGE', key, offset, offset + size - 1]);
      if (!Buffer.isBuffer(value) || value.length !== size) throw changed();
      let written = 0;
      while (written < value.length) {
        const result = await file.write(value, written, value.length - written);
        if (!result.bytesWritten) throw fail();
        written += result.bytesWritten;
      }
      offset += size;
    }
    await command(['MULTI']);
    if (String(await command(['PTTL', key])) !== 'QUEUED') throw changed();
    const result = await command(['EXEC']);
    if (!Array.isArray(result) || result.length !== 1 || !Number.isSafeInteger(result[0]) || result[0] < -1) throw changed();
    await verifyCurrent();
    await file.sync();
    await file.close(); file = null;
    if (await fingerprint(target) !== original) throw new AppError('REDIS_EXPORT_TARGET_CHANGED', '目标文件已被其他程序修改，未覆盖，请重新选择导出位置。');
    assertCurrent();
    await fs.rename(temporary, target);
    return { saved: true, bytes: length };
  } catch (error) { throw error instanceof AppError ? error : fail(); }
  finally {
    connection.close();
    await file?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
