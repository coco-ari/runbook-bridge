import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packaged = process.argv.includes('--mcp-packaged');
const packageRoot = path.resolve('dist/win-unpacked');

// 打包专项让探针和 MCP 子进程都使用包内运行时，避免源码 Broker 与安装包混用。
if (packaged && !process.versions.electron) {
  const child = spawnSync(path.join(packageRoot, 'Agent运维工作台.exe'), [path.resolve(process.argv[1]), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  if (child.error) console.error(JSON.stringify({ status: 'stopped', code: child.error.code ?? 'PACKAGED_PROBE_START_FAILED' }));
  process.exit(child.status ?? 1);
}

export function loadProbeRuntime(name) {
  if (!/^[a-z0-9-]+\.mjs$/u.test(name)) throw new Error('实测模块名无效');
  const entry = packaged ? pathToFileURL(path.join(packageRoot, 'resources/app.asar/src', name)) : new URL('../src/' + name, import.meta.url);
  return import(entry.href);
}
