import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { publicSoftwareUpdateError, softwareUpdateError } from './software-update-service.mjs';

const MAX_MANIFEST = 64 * 1024;
const MAX_PACKAGE = 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function quarantineMacUpdate(file,{exec = execFileAsync} = {}) {
  // 主进程直接下载不会经过浏览器，显式标记隔离属性，交由系统执行常规安全检查。
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};RunbookBridge;`;
  await exec('/usr/bin/xattr',['-w','com.apple.quarantine',value,file],{timeout:5000,windowsHide:true});
}

export function parseMacSoftwareUpdateManifest(content,{arch}) {
  try {
    if (!['arm64','x64'].includes(arch) || Buffer.byteLength(content) > MAX_MANIFEST) throw new Error();
    const document = parseDocument(content,{uniqueKeys:true});
    if (document.errors.length) throw new Error();
    const value = document.toJS({maxAliasCount:0});
    if (!value || value.product !== 'runbook-bridge' || value.platform !== 'darwin' || value.arch !== arch
      || typeof value.version !== 'string' || value.version.length > 80
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
      || value.packages || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2) throw new Error();
    const prefix = `RunbookBridge-${value.version}-darwin-${arch}`;
    const seen = new Set();
    for (const file of value.files) {
      if (!file || ![`${prefix}.dmg`,`${prefix}.zip`].includes(file.url) || seen.has(file.url)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PACKAGE
        || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
        || Buffer.from(file.sha512,'base64').toString('base64') !== file.sha512) throw new Error();
      seen.add(file.url);
    }
    const file = value.files.find(item => item.url === `${prefix}.dmg`);
    if (!file) throw new Error();
    return {version:value.version,files:[{url:file.url,size:file.size,sha512:file.sha512}],
      releaseNotes:typeof value.releaseNotes === 'string' ? value.releaseNotes.slice(0,4096) : '',
      releaseDate:typeof value.releaseDate === 'string' && Number.isFinite(Date.parse(value.releaseDate)) ? new Date(value.releaseDate).toISOString() : null};
  } catch { throw softwareUpdateError('UPDATE_MANIFEST_INVALID'); }
}

async function readResponse(response,limit,onChunk,signal,failure,integrity) {
  if (!response.ok || response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw softwareUpdateError(failure);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel().catch(() => undefined);
    throw softwareUpdateError(integrity);
  }
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > limit) throw softwareUpdateError(integrity);
    await onChunk(chunk,size);
  }
  signal.throwIfAborted();
  if (declared !== null && Number(declared) !== size) throw softwareUpdateError(integrity);
  return size;
}

export async function createMacSoftwareUpdateDriver({url,arch = process.arch,fetchImpl = globalThis.fetch,temporaryRoot = os.tmpdir(),openPath,showItemInFolder,quarantineFile = quarantineMacUpdate}) {
  let base;
  try { base = new URL(url); } catch { throw softwareUpdateError('UPDATE_SOURCE_INVALID'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || !['arm64','x64'].includes(arch) || base.pathname !== `/updates/darwin/${arch}/`) throw softwareUpdateError('UPDATE_SOURCE_INVALID');
  const controller = new AbortController();
  let manifest, directory, directoryStat, destination, partial, downloaded = false, handedOff = false;
  let downloadFlight, openFlight;
  const assertActive = () => { if (controller.signal.aborted) throw softwareUpdateError('UPDATE_CANCELLED'); };
  const safeError = (error,fallback) => softwareUpdateError(controller.signal.aborted ? 'UPDATE_CANCELLED' : publicSoftwareUpdateError(error,fallback).code);
  const request = async (target,timeoutMs,run) => {
    assertActive();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
    const response = await fetchImpl(target,{signal,redirect:'error',credentials:'omit',headers:{'Accept-Encoding':'identity'}});
    return run(response,signal);
  };
  const assertDirectory = async () => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directoryStat.dev || stat.ino !== directoryStat.ino
      || await fs.realpath(directory) !== directory) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
  };
  const cleanup = async () => {
    if (!directory || handedOff) return;
    // 仅清理本次创建目录内的两个固定文件；目录身份变化后不执行删除。
    try {
      await assertDirectory();
      for (const file of [partial,destination]) if (file) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(directory);
    } catch {}
  };
  const verifyDownloaded = async () => {
    assertActive();
    if (!downloaded || !destination) throw softwareUpdateError('UPDATE_NOT_DOWNLOADED');
    try {
      await assertDirectory();
      const expected = manifest.files[0], entry = await fs.lstat(destination);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== expected.size) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
      const file = await fs.open(destination,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let verified;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== expected.size) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
        const hash = crypto.createHash('sha512');
        let size = 0;
        for await (const chunk of file.createReadStream({autoClose:false})) {
          assertActive();
          size += chunk.length;
          if (size > expected.size) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
          hash.update(chunk);
        }
        const after = await file.stat(), named = await fs.lstat(destination);
        await assertDirectory();
        if (size !== expected.size || hash.digest('base64') !== expected.sha512 || after.size !== stat.size
          || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || !named.isFile() || named.isSymbolicLink()
          || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size
          || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
        verified = named;
      } finally { await file.close(); }
      assertActive();
      return verified;
    } catch (error) { throw safeError(error,'UPDATE_INTEGRITY_FAILED'); }
  };
  const dispose = async () => {
    controller.abort();
    await Promise.allSettled([downloadFlight,openFlight]);
    await cleanup();
  };
  return {
    async check() {
      try {
        const chunks = [];
        await request(new URL('latest-mac.yml',base),30_000,async (response,signal) => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined);
            throw softwareUpdateError('UPDATE_NOT_PUBLISHED');
          }
          return readResponse(response,MAX_MANIFEST,chunk => { chunks.push(chunk); },signal,'UPDATE_CHECK_FAILED','UPDATE_MANIFEST_INVALID');
        });
        assertActive();
        manifest = parseMacSoftwareUpdateManifest(Buffer.concat(chunks).toString('utf8'),{arch});
        return manifest;
      } catch (error) { throw safeError(error,'UPDATE_CHECK_FAILED'); }
    },
    download(onProgress = () => {}) {
      if (downloadFlight) return downloadFlight;
      downloadFlight = (async () => {
        assertActive();
        if (!manifest) throw softwareUpdateError('UPDATE_NOT_AVAILABLE');
        try {
          const root = await fs.realpath(temporaryRoot);
          directory = await fs.mkdtemp(path.join(root,'runbook-bridge-update-'));
          directoryStat = await fs.lstat(directory);
          await fs.chmod(directory,0o700);
          const expected = manifest.files[0];
          destination = path.join(directory,expected.url);
          partial = `${destination}.part`;
          const output = await fs.open(partial,'wx',0o600);
          try {
            const hash = crypto.createHash('sha512');
            const size = await request(new URL(expected.url,base),30 * 60_000,(response,signal) => readResponse(response,expected.size,async (chunk,transferred) => {
              hash.update(chunk);
              await output.writeFile(chunk);
              onProgress({percent:transferred / expected.size * 100,transferred,total:expected.size});
            },signal,'UPDATE_DOWNLOAD_FAILED','UPDATE_INTEGRITY_FAILED'));
            if (size !== expected.size || hash.digest('base64') !== expected.sha512) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
            await output.sync();
          } finally { await output.close(); }
          assertActive();
          await assertDirectory();
          await fs.rename(partial,destination);
          await quarantineFile(destination);
          downloaded = true;
          await verifyDownloaded();
        } catch (error) {
          downloaded = false;
          await cleanup();
          throw safeError(error,'UPDATE_DOWNLOAD_FAILED');
        }
      })();
      return downloadFlight;
    },
    verifyDownloaded,
    openInstaller({reveal = false,beforeOpen = async () => {}} = {}) {
      if (openFlight) return openFlight;
      openFlight = (async () => {
        try {
          const verified = await verifyDownloaded();
          await beforeOpen();
          try {
            await assertDirectory();
            const current = await fs.lstat(destination);
            if (!current.isFile() || current.isSymbolicLink() || current.dev !== verified.dev || current.ino !== verified.ino
              || current.size !== verified.size || current.mtimeMs !== verified.mtimeMs || current.ctimeMs !== verified.ctimeMs) throw softwareUpdateError('UPDATE_INTEGRITY_FAILED');
          } catch (error) { throw safeError(error,'UPDATE_INTEGRITY_FAILED'); }
          assertActive();
          const open = reveal ? showItemInFolder : openPath;
          if (typeof open !== 'function') throw softwareUpdateError('UPDATE_OPEN_FAILED');
          // 系统接手后保留 DMG，应用退出或切换来源不会破坏正在进行的手动安装。
          handedOff = true;
          const result = await open(destination);
          if (!reveal && result !== '') throw softwareUpdateError('UPDATE_OPEN_FAILED');
        } catch (error) { throw safeError(error,'UPDATE_OPEN_FAILED'); }
      })().finally(() => { openFlight = null; });
      return openFlight;
    },
    cancel:dispose,
    dispose,
  };
}
