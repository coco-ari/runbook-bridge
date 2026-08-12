import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'AIOpsTool';

export function defaultDataRoot() {
  if (process.env.AI_OPS_DATA_DIR) {
    return path.resolve(process.env.AI_OPS_DATA_DIR);
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && localAppData) {
    return path.join(localAppData, APP_DIR_NAME);
  }
  return path.join(os.homedir(), '.ai-ops-tool');
}

export function projectsRoot(dataRoot = defaultDataRoot()) {
  return path.join(dataRoot, 'projects');
}

export function brokerEndpoint(dataRoot = defaultDataRoot()) {
  if (process.platform === 'win32') {
    const suffix = crypto.createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\ai-ops-tool-${suffix}`;
  }
  return path.join(dataRoot, 'broker.sock');
}
