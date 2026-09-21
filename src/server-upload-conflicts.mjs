import path from 'node:path';
import { AppError } from './errors.mjs';

export const UPLOAD_CONFLICT_ACTIONS = ['skip', 'overwrite', 'keep-both'];

export function uploadDecisions(input, names, previous = {}) {
  const decisions = Object.fromEntries(names.filter(name => Object.hasOwn(previous, name)).map(name => [name, previous[name]]));
  if (input === undefined) return decisions;
  if (!Array.isArray(input) || input.length > 20 || new Set(input.map(item => item?.name)).size !== input.length
    || input.some(item => !item || Object.keys(item).some(key => !['name', 'action'].includes(key))
      || !names.includes(item.name) || !UPLOAD_CONFLICT_ACTIONS.includes(item.action))) {
    throw new AppError('INVALID_ARGUMENT', '文件冲突处理选择无效。');
  }
  for (const item of input) Object.defineProperty(decisions, item.name, { value: item.action, enumerable: true, writable: true, configurable: true });
  return decisions;
}

export async function planUploadFile(file, { action, directory, reserved, snapshot }) {
  const original = await snapshot(path.posix.join(directory, file.name));
  file.exists = original.exists;
  file.remote = original.exists ? { size: original.size, mtime: original.mtime, mode: original.mode, type: original.type } : null;
  file.action = action ?? (original.exists ? 'pending' : 'upload');
  let targetName = file.name;
  let target = original;
  if (file.action === 'keep-both' && original.exists) {
    const extension = /\.tar\.(?:gz|bz2|xz)$/iu.exec(file.name)?.[0] ?? path.posix.extname(file.name);
    const stem = extension ? file.name.slice(0, -extension.length) : file.name;
    let found = false;
    // 有界查找并避开本批次的其他名称；最终名称随后绑定一次性确认。
    for (let index = 1; index <= 100; index += 1) {
      const candidate = stem + ' (' + index + ')' + extension;
      if (Buffer.byteLength(candidate) > 255) throw new AppError('INVALID_ARGUMENT', '生成的文件名过长，请缩短本地文件名后重试。');
      if (reserved.has(candidate)) continue;
      const next = await snapshot(path.posix.join(directory, candidate));
      if (!next.exists) { targetName = candidate; target = next; found = true; break; }
    }
    if (!found) throw new AppError('TARGET_EXISTS', '可用的副本名称已用尽，请调整文件名后重试。');
    reserved.add(targetName);
  }
  file.remotePath = path.posix.join(directory, targetName);
  if (file.action !== 'skip' && target.exists && target.type !== 'file') {
    throw new AppError('PATH_INVALID', '同名目标不是普通文件，请选择跳过或保留两份。');
  }
  return { ...file, target };
}
