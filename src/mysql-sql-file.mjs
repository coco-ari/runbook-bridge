import fs from 'node:fs/promises';
import { AppError } from './errors.mjs';

// 文件路径仅来自桌面保存对话框，渲染进程不能指定本地写入位置。
export async function saveMysqlSqlFile(payload, pickPath, assertActive = () => {}) {
  if (!payload || Object.keys(payload).some(key=>!['fileName','sql'].includes(key))
    || typeof payload.fileName !== 'string' || payload.fileName.length>128 || !/^[\p{L}\p{N}_.-]+\.sql$/u.test(payload.fileName)
    || typeof payload.sql !== 'string' || !payload.sql.trim() || Buffer.byteLength(payload.sql)>4*1024*1024) {
    throw new AppError('INVALID_ARGUMENT','SQL 导出内容或文件名无效。');
  }
  assertActive();
  if (typeof pickPath !== 'function') throw new AppError('SQL_EXPORT_UNAVAILABLE','当前窗口无法打开保存对话框。');
  const path = await pickPath(payload.fileName);
  assertActive();
  if (!path) return {saved:false};
  try { await fs.writeFile(path,payload.sql,{encoding:'utf8',mode:0o600}); }
  catch { throw new AppError('SQL_EXPORT_FAILED','SQL 文件保存失败，请检查所选目录的权限及剩余空间。'); }
  return {saved:true};
}
