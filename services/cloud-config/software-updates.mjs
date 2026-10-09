import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BLOCKMAP_BYTES = 16 * 1024 * 1024;
const VERSION = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';

function reject(status,code) { throw Object.assign(new Error(code),{status,code}); }

function releaseRoute(request) {
  // 直接校验原始路径，避免 URL 规范化提前吞掉编码后的目录穿越。
  const pathname = String(request.url ?? '').split('?')[0];
  if (!pathname.startsWith('/updates/')) return null;
  const match = /^\/updates\/(win32|darwin)\/(x64|arm64|ia32)\/([A-Za-z0-9.-]+)$/.exec(pathname);
  if (!match || (match[1] === 'darwin' && match[2] === 'ia32')) reject(404,'CLOUD_UPDATE_NOT_FOUND');
  const [,platform,arch,name] = match;
  const manifest = name === (platform === 'win32' ? 'latest.yml' : 'latest-mac.yml');
  const extensions = platform === 'win32' ? 'exe' : '(?:zip|dmg)';
  if (!manifest && !new RegExp(`^RunbookBridge-${VERSION}-${platform}-${arch}\\.${extensions}(?:\\.blockmap)?$`).test(name)) reject(404,'CLOUD_UPDATE_NOT_FOUND');
  return {platform,arch,name,manifest,blockmap:name.endsWith('.blockmap')};
}

async function openRelease(directory,route) {
  const root = path.resolve(directory);
  let target = root;
  const parts = [route.platform,route.arch,route.name];
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) reject(404,'CLOUD_UPDATE_NOT_FOUND');
    const canonicalRoot = await fs.realpath(root);
    let fileStat;
    for (const [index,part] of parts.entries()) {
      target = path.join(target,part);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (index < parts.length-1 ? !stat.isDirectory() : !stat.isFile())) reject(404,'CLOUD_UPDATE_NOT_FOUND');
      fileStat = stat;
    }
    const file = await fs.open(target,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      const expectedPath = path.join(canonicalRoot,...parts);
      if (!stat.isFile() || stat.dev !== fileStat.dev || stat.ino !== fileStat.ino || await fs.realpath(target) !== expectedPath) reject(404,'CLOUD_UPDATE_NOT_FOUND');
      const limit = route.manifest ? MAX_MANIFEST_BYTES : route.blockmap ? MAX_BLOCKMAP_BYTES : MAX_PACKAGE_BYTES;
      if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > limit) reject(413,'CLOUD_UPDATE_TOO_LARGE');
      return {file,size:stat.size};
    } catch (error) { await file.close(); throw error; }
  } catch (error) {
    if (error?.code?.startsWith('CLOUD_')) throw error;
    reject(404,'CLOUD_UPDATE_NOT_FOUND');
  }
}

function rangeFor(header,size,response) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => {
    response.setHeader('Content-Range',`bytes */${size}`);
    reject(416,'CLOUD_UPDATE_RANGE_INVALID');
  };
  if (!match || (!match[1] && !match[2])) invalid();
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) invalid();
    start = Math.max(0,size-suffix); end = size-1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size-1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) invalid();
    end = Math.min(end,size-1);
  }
  return {start,end};
}

export async function serveSoftwareUpdate(request,response,{releasesDirectory} = {}) {
  const route = releaseRoute(request);
  if (!route) return false;
  // 软件分发是公开只读接口，不接收配置仓库或发布管理员的凭据。
  if (request.headers.authorization !== undefined || request.headers.cookie !== undefined || request.headers['proxy-authorization'] !== undefined) reject(400,'CLOUD_UPDATE_CREDENTIALS_FORBIDDEN');
  if (!['GET','HEAD'].includes(request.method)) reject(405,'CLOUD_METHOD_NOT_ALLOWED');
  if (!releasesDirectory) reject(404,'CLOUD_UPDATES_UNCONFIGURED');
  const {file,size} = await openRelease(releasesDirectory,route);
  try {
    const range = rangeFor(request.headers.range,size,response);
    const headers = {
      'Content-Type':route.manifest ? 'application/yaml; charset=utf-8' : 'application/octet-stream',
      'Content-Length':range ? range.end-range.start+1 : size,
      'Cache-Control':route.manifest ? 'no-store' : 'public, max-age=86400, immutable',
      'X-Content-Type-Options':'nosniff',
      'Accept-Ranges':'bytes',
      ...(range ? {'Content-Range':`bytes ${range.start}-${range.end}/${size}`} : {}),
    };
    response.writeHead(range ? 206 : 200,headers);
    if (request.method === 'HEAD') response.end();
    else await pipeline(file.createReadStream({autoClose:false,...(range ?? {})}),response);
    return true;
  } finally { await file.close(); }
}
