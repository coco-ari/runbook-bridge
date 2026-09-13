import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function macBuildArguments({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  if (platform !== 'darwin') throw new Error('macOS 安装包需要在 Mac 或 macOS Runner 上构建和验证。');
  if (!['arm64','x64'].includes(arch)) throw new Error('macOS 只支持 arm64 和 x64 构建。');
  const args = ['--mac','--' + arch,'--publish','never'];
  if (env.AI_OPS_MAC_RELEASE === '1') {
    if (!env.CSC_LINK && !env.CSC_NAME) throw new Error('正式 Mac 构建缺少 Developer ID 签名配置。');
    const appleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    const apiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
    const keychain = env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE;
    if (!appleId && !apiKey && !keychain) throw new Error('正式 Mac 构建缺少 Apple 公证配置。');
    args.push('-c.forceCodeSigning=true','-c.mac.notarize=true');
  } else {
    // 测试包显式使用临时签名，不能冒充已公证的分发包。
    args.push('-c.mac.identity=-','-c.mac.hardenedRuntime=false','-c.mac.notarize=false');
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = macBuildArguments({arch:process.argv[2] || process.arch});
    const root = fileURLToPath(new URL('../',import.meta.url));
    const child = spawn(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),...args],{cwd:root,stdio:'inherit'});
    child.once('error',() => { console.error('无法启动 Mac 构建。'); process.exitCode = 1; });
    child.once('exit',code => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
