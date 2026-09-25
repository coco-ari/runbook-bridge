import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function releasePlatforms(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag ?? '')) throw new Error('发布标签格式无效。');
  const windows = { os: 'windows-latest', platform: 'win32', arch: 'x64', app: 'dist/win-unpacked/Agent运维工作台.exe' };
  // 当前公开测试版仅分发 Windows；稳定版仍要求两种 Mac 架构完成签名、公证和验证。
  return { include: tag.includes('-') ? [windows] : [windows,
    { os: 'macos-15', platform: 'darwin', arch: 'arm64', app: 'dist/mac-arm64/Agent运维工作台.app' },
    { os: 'macos-15-intel', platform: 'darwin', arch: 'x64', app: 'dist/mac/Agent运维工作台.app' },
  ] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(releasePlatforms(process.argv[2])));
}
