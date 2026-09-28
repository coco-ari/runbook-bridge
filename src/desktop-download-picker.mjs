import fs from 'node:fs/promises';
import path from 'node:path';

// 仅记住本机目录作为对话框默认值，不作为静默写入或覆盖授权。
export class DesktopDownloadPicker {
  constructor({dataRoot, defaultDirectory, showSaveDialog, atomicWrite}) {
    this.file = path.join(dataRoot, 'desktop-download-preferences.json');
    this.defaultDirectory = defaultDirectory;
    this.showSaveDialog = showSaveDialog;
    this.atomicWrite = atomicWrite;
    this.loaded = false;
    this.directory = null;
    this.writes = Promise.resolve();
  }

  async pick(window, name, previousPath) {
    if (!this.loaded) {
      try {
        const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
        if (typeof value.directory === 'string' && path.isAbsolute(value.directory) && !value.directory.includes('\0')) this.directory = value.directory;
      } catch { /* 偏好缺失或损坏不阻止选择文件。 */ }
      this.loaded = true;
    }
    let directory = this.directory;
    try { if (!directory || !(await fs.stat(directory)).isDirectory()) directory = this.defaultDirectory; }
    catch { directory = this.defaultDirectory; }
    const result = await this.showSaveDialog(window, {
      title:'下载文件', defaultPath:previousPath ?? path.join(directory, name), properties:['showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    this.directory = path.dirname(result.filePath);
    const content = JSON.stringify({directory:this.directory}) + '\n';
    this.writes = this.writes.then(() => this.atomicWrite(this.file, content)).catch(() => {
      // 偏好写入失败时保留本次会话记忆，不影响已经确认的下载。
    });
    await this.writes;
    return result.filePath;
  }
}
