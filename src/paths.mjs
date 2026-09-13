import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'AIOpsTool';

export function defaultDataRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.AI_OPS_DATA_DIR) {
    return paths.resolve(env.AI_OPS_DATA_DIR);
  }
  const localAppData = env.LOCALAPPDATA;
  if (platform === 'win32' && localAppData) {
    return paths.join(localAppData, APP_DIR_NAME);
  }
  return paths.join(home, '.ai-ops-tool');
}

export function projectsRoot(dataRoot = defaultDataRoot()) {
  return path.join(dataRoot, 'projects');
}

export function brokerEndpoint(dataRoot = defaultDataRoot(), { platform = process.platform, uid = process.getuid?.() ?? 0 } = {}) {
  if (platform === 'win32') {
    const suffix = crypto.createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\ai-ops-tool-${suffix}`;
  }
  const endpoint = path.posix.join(dataRoot, 'broker.sock');
  if (Buffer.byteLength(endpoint, 'utf8') <= 100) return endpoint;
  // macOS 的 Unix socket 路径上限按字节计算，使用私有短目录容纳长数据路径。
  const suffix = crypto.createHash('sha256').update(path.posix.resolve(dataRoot)).digest('hex').slice(0, 24);
  return path.posix.join('/tmp', 'ai-ops-tool-' + uid, suffix + '.sock');
}
