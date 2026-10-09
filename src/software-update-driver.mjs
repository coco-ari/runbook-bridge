import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseDocument } from 'yaml';
import { publicSoftwareUpdateError, softwareUpdateError } from './software-update-service.mjs';

const MAX_MANIFEST = 64 * 1024;
const MAX_PACKAGE = 1024 * 1024 * 1024;

export function parseSoftwareUpdateManifest(content, {platform,arch}) {
  try {
    if (Buffer.byteLength(content) > MAX_MANIFEST) throw new Error();
    const document = parseDocument(content,{uniqueKeys:true});
    if (document.errors.length) throw new Error();
    const value = document.toJS({maxAliasCount:0});
    if (!value || value.product !== 'runbook-bridge' || value.platform !== platform || value.arch !== arch
      || typeof value.version !== 'string' || value.version.length > 80
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
      || value.packages || !Array.isArray(value.files) || value.files.length !== 1 || platform !== 'win32') throw new Error();
    const file = value.files[0];
    const expected = `RunbookBridge-${value.version}-${platform}-${arch}.exe`;
    if (!file || file.url !== expected || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PACKAGE
      || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
      || Buffer.from(file.sha512,'base64').toString('base64') !== file.sha512) throw new Error();
    return {
      version:value.version, files:[{url:expected,size:file.size,sha512:file.sha512}],
      releaseNotes:typeof value.releaseNotes === 'string' ? value.releaseNotes.slice(0,4096) : '',
      releaseDate:typeof value.releaseDate === 'string' && Number.isFinite(Date.parse(value.releaseDate)) ? new Date(value.releaseDate).toISOString() : null,
    };
  } catch { throw softwareUpdateError('UPDATE_MANIFEST_INVALID'); }
}

async function readResponse(response,limit,onChunk,failureCode = 'UPDATE_DOWNLOAD_FAILED',integrityCode = 'UPDATE_INTEGRITY_FAILED') {
  if (!response.ok || response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw softwareUpdateError(failureCode);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel().catch(() => undefined);
    throw softwareUpdateError(integrityCode);
  }
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw softwareUpdateError(integrityCode);
    await onChunk(chunk,length);
  }
  if (declared !== null && length !== Number(declared)) throw softwareUpdateError(integrityCode);
  return length;
}

export async function createSoftwareUpdateDriver({url,platform = process.platform,arch = process.arch,fetchImpl = globalThis.fetch,loadUpdater = () => import('electron-updater'),spawnImpl = spawn}) {
  let base;
  try { base = new URL(url); } catch { throw softwareUpdateError('UPDATE_SOURCE_INVALID'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.pathname !== `/updates/${platform}/${arch}/` || platform !== 'win32' || !['x64','arm64','ia32'].includes(arch)) {
    throw softwareUpdateError('UPDATE_SOURCE_INVALID');
  }
  const controller = new AbortController();
  let updater, checked, manifest, downloaded = false;
  const request = async (target,timeoutMs,run) => {
    if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
    const response = await fetchImpl(target,{signal,redirect:'error',credentials:'omit',headers:{'Accept-Encoding':'identity'}});
    return run(response);
  };
  const verifyDownloaded = async () => {
    if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
    if (!downloaded || !updater.installerPath) throw softwareUpdateError('UPDATE_NOT_DOWNLOADED');
    try {
      const expected = manifest.files[0];
      const entry = await fs.lstat(updater.installerPath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== expected.size) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
      const file = await fs.open(updater.installerPath,'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== expected.size || stat.dev !== entry.dev || stat.ino !== entry.ino) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
        const hash = crypto.createHash('sha512');
        let transferred = 0;
        for await (const chunk of file.createReadStream({autoClose:false})) {
          if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
          transferred += chunk.length;
          if (transferred > expected.size) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
          hash.update(chunk);
        }
        const after = await file.stat();
        const named = await fs.lstat(updater.installerPath);
        if (transferred !== expected.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
          || !named.isFile() || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size
          || hash.digest('base64') !== expected.sha512) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
      } finally { await file.close(); }
      if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
    } catch (error) { throw softwareUpdateError(publicSoftwareUpdateError(error,'UPDATE_INTEGRITY_FAILED').code); }
  };
  return {
    async check() {
      try {
        const chunks = [];
        await request(new URL('latest.yml',base),30_000,response => readResponse(response,MAX_MANIFEST,chunk => { chunks.push(chunk); },'UPDATE_CHECK_FAILED','UPDATE_MANIFEST_INVALID'));
        manifest = parseSoftwareUpdateManifest(Buffer.concat(chunks).toString('utf8'),{platform,arch});
        const module = await loadUpdater();
        const NsisUpdater = module.NsisUpdater ?? module.default?.NsisUpdater;
        // 固定本次已校验的清单，禁止更新器另行发现来源或读取任意下载地址。
        class PinnedProvider {
          setRequestHeaders() {}
          get fileExtraDownloadHeaders() { return null; }
          get isUseMultipleRangeRequest() { return false; }
          async getLatestVersion() { return manifest; }
          resolveFiles() { return manifest.files.map(info => ({url:new URL(info.url,base),info})); }
        }
        updater = new NsisUpdater({provider:'custom',updateProvider:PinnedProvider});
        updater.logger = null;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableWebInstaller = true;
        updater.disableDifferentialDownload = true;
        // 下载同源文件时不使用云配置认证信息，也不跟随跳转；限制实际字节数并校验摘要。
        updater.httpExecutor.download = async (target,destination,options) => {
          const file = manifest.files[0];
          if (String(target) !== new URL(file.url,base).href) throw softwareUpdateError('UPDATE_SOURCE_INVALID');
          const hash = crypto.createHash('sha512');
          const output = await fs.open(destination,'w',0o600);
          let success = false;
          try {
            const size = await request(target,30 * 60_000,response => readResponse(response,file.size,async (chunk,transferred) => {
              if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
              hash.update(chunk);
              await output.writeFile(chunk);
              options.onProgress?.({percent:transferred / file.size * 100,transferred,total:file.size});
            }));
            if (size !== file.size || hash.digest('base64') !== file.sha512) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
            success = true;
          } finally {
            await output.close();
            if (!success) await fs.rm(destination,{force:true}).catch(() => undefined);
          }
          return destination;
        };
        checked = await updater.checkForUpdates();
        return checked?.isUpdateAvailable ? manifest : null;
      } catch (error) { throw softwareUpdateError(controller.signal.aborted ? 'UPDATE_CANCELLED' : publicSoftwareUpdateError(error,'UPDATE_CHECK_FAILED').code); }
    },
    async download(onProgress) {
      if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
      if (!checked?.isUpdateAvailable) throw softwareUpdateError('UPDATE_NOT_AVAILABLE');
      downloaded = false;
      updater.on('download-progress',onProgress);
      try {
        await updater.downloadUpdate(checked.cancellationToken);
        if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
        downloaded = true;
      } catch (error) {
        const code = controller.signal.aborted ? 'UPDATE_CANCELLED'
          : ['ERR_UPDATER_INVALID_SIGNATURE','ERR_UPDATER_CHECKSUM_MISMATCH'].includes(error?.code) ? 'UPDATE_INTEGRITY_FAILED'
          : publicSoftwareUpdateError(error,'UPDATE_DOWNLOAD_FAILED').code;
        throw softwareUpdateError(code);
      } finally { updater.removeListener('download-progress',onProgress); }
    },
    verifyDownloaded,
    async quitAndInstall() {
      // 安装入口再次核验落盘文件，防止下载后缓存被替换或修改。
      await verifyDownloaded();
      let failed = false;
      const launches = [];
      const originalSpawn = updater.spawnLog;
      const onError = () => { failed = true; };
      updater.on('error',onError);
      // 等待真实进程启动事件；失败返回已处理结果，禁止库转向不可观察的异步安装旁路。
      updater.spawnLog = (command,args = [],env,stdio = 'ignore') => {
        const launch = new Promise(resolve => {
          try {
            const child = spawnImpl(command,args,{stdio,env,detached:true,windowsHide:true});
            child.once('error',() => { failed = true; resolve(false); });
            child.once('spawn',() => { child.unref(); resolve(true); });
          } catch { failed = true; resolve(false); }
        });
        launches.push(launch);
        return launch;
      };
      try {
        // 在线更新必须静默安装并自动重启，避免隐藏的安装向导等待用户输入。
        updater.quitAndInstall(true,true);
        if (!launches.length) throw softwareUpdateError('UPDATE_INSTALL_FAILED');
        await Promise.all(launches);
        if (failed) throw softwareUpdateError('UPDATE_INSTALL_FAILED');
        if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED');
      } catch (error) {
        updater.quitAndInstallCalled = false;
        throw softwareUpdateError(publicSoftwareUpdateError(error,'UPDATE_INSTALL_FAILED').code);
      } finally {
        updater.spawnLog = originalSpawn;
        updater.removeListener('error',onError);
      }
    },
    cancel() { controller.abort(); checked?.cancellationToken?.cancel(); },
    dispose() { controller.abort(); checked?.cancellationToken?.cancel(); },
  };
}
