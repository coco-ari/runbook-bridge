import { softwareUpdateError } from './software-update-service.mjs';
import { AppError } from './errors.mjs';

export class SoftwareUpdateShutdownGate {
  constructor() { this.active = 0; this.closing = false; this.allowQuit = false; }

  async run(operation) {
    if (this.closing) throw new AppError('UPDATE_BUSY','客户端正在重启更新。');
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }

  async install(driver,{assertIdle,close,onFailure,quit = () => {}}) {
    const assertAvailable = () => {
      if (this.closing || this.active) throw softwareUpdateError('UPDATE_BUSY');
      assertIdle();
    };
    assertAvailable();
    await driver.verifyDownloaded();
    // 摘要复核期间可能有新请求；再次检查后同步关闭入口，避免停机期间产生新任务。
    assertAvailable();
    this.closing = true;
    try {
      await close();
      await driver.quitAndInstall();
      this.allowQuit = true;
      quit();
    } catch {
      this.allowQuit = true;
      onFailure();
      throw softwareUpdateError('UPDATE_INSTALL_FAILED');
    }
  }
}
