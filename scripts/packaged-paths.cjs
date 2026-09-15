const path = require('node:path');

function packagedPaths(input, { platform = process.platform, arch = process.arch, root = path.resolve(__dirname, '..') } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const product = 'Agent运维工作台';
  const fallback = platform === 'darwin'
    ? paths.join(root, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', product + '.app')
    : paths.join(root, 'dist', 'win-unpacked', product + '.exe');
  const target = paths.resolve(input || fallback);
  const isBundle = target.endsWith('.app');
  const isMacExecutable = paths.basename(paths.dirname(target)) === 'MacOS'
    && paths.basename(paths.dirname(paths.dirname(target))) === 'Contents';
  if (isBundle || isMacExecutable) {
    const bundle = isBundle ? target : paths.dirname(paths.dirname(paths.dirname(target)));
    if (!bundle.endsWith('.app')) throw new Error('无效的 macOS 应用包路径。');
    const executable = isBundle ? paths.join(bundle, 'Contents', 'MacOS', paths.basename(bundle, '.app')) : target;
    const appAsar = paths.join(bundle, 'Contents', 'Resources', 'app.asar');
    return { executable, appAsar, bundle, mcpEntrypoint:paths.join(appAsar, 'src', 'mcp-v2.mjs') };
  }
  const appAsar = paths.join(paths.dirname(target), 'resources', 'app.asar');
  return { executable:target, appAsar, bundle:null, mcpEntrypoint:paths.join(appAsar, 'src', 'mcp-v2.mjs') };
}

module.exports = { packagedPaths };
