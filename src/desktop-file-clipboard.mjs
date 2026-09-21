import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

const executeFile = promisify(execFile);
const readFilesCommand = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
  "if ($files.Count -gt 20) { '{\"tooMany\":true}' } else { ConvertTo-Json -Compress -InputObject @{files=@($files)} }",
].join('; ');

export async function readWindowsClipboardFiles({ platform = process.platform, execute = executeFile } = {}) {
  if (platform !== 'win32') throw new AppError('UPLOAD_SOURCE_UNAVAILABLE', '当前系统请使用原生粘贴或拖入文件。');
  let result;
  try {
    // 固定脚本只读取系统文件列表，不执行剪贴板文本，也不读取文件内容。
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(readFilesCommand, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    result = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
  } catch {
    throw new AppError('CLIPBOARD_UNAVAILABLE', '无法读取文件剪贴板，请重新复制文件后重试，或拖入文件上传。');
  }
  if (result?.tooMany) throw new AppError('INVALID_ARGUMENT', '每次请复制 1 至 20 个本地普通文件。');
  const files = result?.files;
  if (!Array.isArray(files) || files.length > 20 || files.some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0') || !path.win32.isAbsolute(value))) {
    throw new AppError('UPLOAD_SOURCE_UNAVAILABLE', '剪贴板中的文件列表无效，请从资源管理器重新复制文件。');
  }
  if (!files.length) throw new AppError('UPLOAD_SOURCE_UNAVAILABLE', '剪贴板中没有本地文件，请先在资源管理器中复制文件，或拖入文件上传。');
  return files;
}
