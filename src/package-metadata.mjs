import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');

export const APP_VERSION = manifest.version;

function readBuildInfo() {
  if (!import.meta.url.includes('.asar/')) return null;
  try {
    const value = require('../build/runtime.json');
    if (!/^[a-f0-9]{64}$/.test(value.buildId)) return null;
    return { buildId:value.buildId, gitCommit:/^[a-f0-9]{40}$/.test(value.gitCommit) ? value.gitCommit : null, dirty:value.dirty === true, builtAt:value.builtAt };
  } catch {
    return null;
  }
}

export const BUILD_INFO = Object.freeze(readBuildInfo() ?? { buildId:'development', gitCommit:null, dirty:true, builtAt:null });
export const RUNTIME_INFO = Object.freeze({ version:APP_VERSION, ...BUILD_INFO, startedAt:new Date().toISOString(), platform:process.platform, arch:process.arch });
