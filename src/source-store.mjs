import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { AppError } from './errors.mjs';
import { SOURCE_LIMITS, SOURCE_HASH, sourceHash, sourcePath, sourceError, sourceCacheIdentity, validateManifest, readBounded } from './source-protocol.mjs';

async function atomicJson(file,value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'}); await fs.rename(temp,file); }
  finally { await fs.rm(temp,{force:true}); }
}
async function regularRead(root,relative,maxBytes) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw sourceError('源码缓存根目录无效。');
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0,-1)) {
    current = path.join(current,part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('源码缓存路径不是普通目录。');
  }
  const filename = path.join(root,...parts), stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw sourceError('源码缓存不是可读取的普通文件。');
  const handle = await fs.open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.ino !== stat.ino || opened.dev !== stat.dev) throw sourceError('源码缓存已发生变化。');
    return await readBounded(handle.createReadStream({autoClose:false}),maxBytes);
  } finally { await handle.close(); }
}

export class SourceStore {
  constructor(dataRoot) {
    this.directory = path.join(dataRoot,'source-cache');
    this.updates = new Set();
    this.readers = new Map();
    this.cleaning = new Set();
  }
  root(plugin) { return path.join(this.directory,sourceCacheIdentity(plugin)); }
  snapshotDirectory(plugin,id) {
    if (!SOURCE_HASH.test(id ?? '')) throw sourceError('源码版本无效。');
    return path.join(this.root(plugin),'snapshots',id);
  }
  async prepare(plugin) {
    for (const directory of [this.directory,this.root(plugin),path.join(this.root(plugin),'objects'),path.join(this.root(plugin),'snapshots'),path.join(this.root(plugin),'pins')]) {
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError('源码缓存目录无效。');
    }
  }
  async manifest(plugin,id) {
    this.snapshotDirectory(plugin,id);
    try {
      const bytes = await regularRead(this.root(plugin),`snapshots/${id}/manifest.json`,SOURCE_LIMITS.maxManifestBytes);
      return validateManifest(JSON.parse(bytes.toString()),plugin.target.remoteProjectId,id);
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('SOURCE_NOT_DOWNLOADED','本地尚未下载此版本。');
      if (error instanceof AppError) throw error;
      throw sourceError('本地源码清单无效。');
    }
  }
  async current(plugin) {
    let value;
    try { value = JSON.parse((await regularRead(this.root(plugin),'current.json',4096)).toString()); }
    catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof AppError) throw error; throw sourceError('本地源码版本指针损坏。'); }
    return this.summary(plugin,await this.manifest(plugin,value.snapshotId));
  }
  summary(plugin,manifest) {
    return {snapshotId:manifest.snapshotId,revision:manifest.revision,createdAt:manifest.createdAt,fileCount:manifest.fileCount,totalBytes:manifest.totalBytes,
      directory:path.join(this.snapshotDirectory(plugin,manifest.snapshotId),'code')};
  }
  async object(plugin,entry) {
    try {
      const bytes = await regularRead(this.root(plugin),`objects/${entry.sha256}`,entry.size);
      return bytes.length === entry.size && sourceHash(bytes) === entry.sha256 ? bytes : null;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'SOURCE_INVALID') return null; throw error; }
  }
  async saveObject(plugin,entry,bytes) {
    if (bytes.length !== entry.size || sourceHash(bytes) !== entry.sha256) throw sourceError('源码文件哈希校验失败，当前版本未改变。');
    const target = path.join(this.root(plugin),'objects',entry.sha256), temp = `${target}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600}); await fs.rename(temp,target); }
    finally { await fs.rm(temp,{force:true}); }
  }
  async importArchive(plugin,manifest,client,signal,progress) {
    const filename = path.join(this.root(plugin),`${crypto.randomUUID()}.zip.tmp`);
    try {
      const response = await client.archive(manifest.snapshotId,signal);
      let size = 0;
      const hash = crypto.createHash('sha256');
      await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done) {
        size += chunk.length;
        if (size > manifest.archiveBytes) return done(sourceError('源码包超过声明大小。'));
        hash.update(chunk); progress({phase:'download',downloadedBytes:size,totalBytes:manifest.archiveBytes}); done(null,chunk);
      }}),createWriteStream(filename,{flags:'wx',mode:0o600}),{signal});
      if (size !== manifest.archiveBytes || hash.digest('hex') !== manifest.archiveSha256) throw sourceError('源码压缩包哈希校验失败。');
      const archive = await unzipper.Open.file(filename);
      if (archive.files.length > SOURCE_LIMITS.maxFiles * 2) throw sourceError('源码压缩包文件过多。');
      const expected = new Map(manifest.files.map(entry => [entry.path,entry])), seen = new Set();
      for (const file of archive.files) {
        signal?.throwIfAborted();
        const name = file.path.replace(/\/$/,''); sourcePath(name);
        if (file.type === 'Directory') continue;
        const entry = expected.get(name), mode = (file.externalFileAttributes >>> 16) & 0xf000;
        if (!entry || seen.has(name) || (mode && mode !== 0x8000) || file.uncompressedSize !== entry.size) throw sourceError('源码包文件与清单不一致。');
        seen.add(name);
        const stream = file.stream();
        const abort = () => stream.destroy(new AppError('SOURCE_CANCELLED','源码更新已取消。'));
        signal?.addEventListener('abort',abort,{once:true});
        try { await this.saveObject(plugin,entry,await readBounded(stream,entry.size,signal)); }
        finally { signal?.removeEventListener('abort',abort); stream.destroy(); }
      }
      if (seen.size !== expected.size) throw sourceError('源码包缺少清单文件。');
      return size;
    } finally { await fs.rm(filename,{force:true}); }
  }
  async update(plugin,client,snapshotId,{signal,progress = () => {},assertCurrent = () => {}} = {}) {
    const identity = sourceCacheIdentity(plugin);
    if (this.updates.has(identity)) throw new AppError('SOURCE_BUSY','此源码正在更新。');
    this.updates.add(identity);
    let stage;
    const checkpoint = () => { if (signal?.aborted) throw new AppError('SOURCE_CANCELLED','源码更新已取消。'); assertCurrent(); };
    try {
      await this.prepare(plugin); checkpoint();
      const manifest = await client.manifest(snapshotId,signal), before = await this.current(plugin);
      let downloadedBytes = 0, downloadedFiles = 0;
      const unique = [...new Map(manifest.files.map(entry => [entry.sha256,entry])).values()];
      const missing = [];
      for (const entry of unique) { checkpoint(); if (!await this.object(plugin,entry)) missing.push(entry); }
      // First install uses a compressed, immutable archive; retries can reuse already verified objects.
      if (!before && missing.length === unique.length && missing.length) {
        downloadedBytes = await this.importArchive(plugin,manifest,client,signal,progress);
        downloadedFiles = missing.length;
      } else {
        for (let cursor = 0; cursor < missing.length;) {
          checkpoint();
          const batch = [];
          let total = 0;
          while (cursor < missing.length && batch.length < SOURCE_LIMITS.maxBatchFiles && total + missing[cursor].size <= SOURCE_LIMITS.maxBatchBytes) { const entry = missing[cursor++]; batch.push(entry); total += entry.size; }
          const expected = new Map(batch.map(entry => [entry.sha256,entry]));
          const files = await client.files(snapshotId,[...expected.keys()],signal);
          for (const file of files) {
            const entry = expected.get(file.sha256);
            if (!entry || typeof file.data !== 'string' || file.data.length !== Math.ceil(entry.size/3)*4) throw sourceError('增量文件数据无效。');
            const bytes = Buffer.from(file.data,'base64');
            if (bytes.toString('base64') !== file.data) throw sourceError('增量文件编码无效。');
            await this.saveObject(plugin,entry,bytes); expected.delete(file.sha256);
          }
          if (expected.size) throw sourceError('增量响应缺少文件。');
          downloadedBytes += total; downloadedFiles += batch.length;
          progress({phase:'download',downloadedBytes,totalBytes:missing.reduce((sum,e) => sum+e.size,0)});
        }
      }
      checkpoint();
      stage = path.join(this.root(plugin),'snapshots',`${crypto.randomUUID()}.tmp`);
      await fs.mkdir(path.join(stage,'code'),{recursive:true,mode:0o700});
      for (let i = 0; i < manifest.files.length; i++) {
        checkpoint();
        const entry = manifest.files[i], bytes = await this.object(plugin,entry);
        if (!bytes) throw sourceError('源码缓存校验失败，请重新更新。');
        const filename = path.join(stage,'code',...entry.path.split('/'));
        await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
        await fs.writeFile(filename,bytes,{flag:'wx',mode:entry.mode === 0o755 ? 0o555 : 0o444});
        if (i % 64 === 0) progress({phase:'verify',completedFiles:i,totalFiles:manifest.fileCount});
      }
      await atomicJson(path.join(stage,'manifest.json'),manifest); checkpoint();
      const destination = this.snapshotDirectory(plugin,snapshotId);
      try { await fs.rename(stage,destination); stage = null; }
      catch (error) {
        if (!['EEXIST','ENOTEMPTY'].includes(error.code)) throw error;
        // Never replace a directory an Agent may already be reading. Verify the existing immutable copy.
        await this.manifest(plugin,snapshotId);
        for (const entry of manifest.files) await this.readEntry(plugin,snapshotId,entry,SOURCE_LIMITS.maxFileBytes);
      }
      checkpoint();
      await atomicJson(path.join(this.root(plugin),'current.json'),{snapshotId});
      return {...this.summary(plugin,manifest),downloadedBytes,downloadedFiles,reusedFiles:unique.length-downloadedFiles};
    } catch (error) {
      if (signal?.aborted) throw new AppError('SOURCE_CANCELLED','源码更新已取消，当前版本保持不变。');
      throw error;
    } finally { if (stage) await fs.rm(stage,{recursive:true,force:true}); this.updates.delete(identity); }
  }
  acquire(plugin,id) {
    if (this.cleaning.has(sourceCacheIdentity(plugin))) throw new AppError('SOURCE_BUSY','正在清理未使用源码，请稍后重试。');
    const key = `${sourceCacheIdentity(plugin)}/${id}`;
    this.snapshotDirectory(plugin,id);
    this.readers.set(key,(this.readers.get(key) ?? 0)+1);
    let active = true;
    return () => { if (!active) return; active = false; const n = this.readers.get(key)-1; if (n) this.readers.set(key,n); else this.readers.delete(key); };
  }
  async pin(plugin,id,reference) {
    const release = this.acquire(plugin,id);
    try { await this.manifest(plugin,id); await this.prepare(plugin);
      await atomicJson(path.join(this.root(plugin),'pins',sourceHash(reference)),{snapshotId:id});
    } finally { release(); }
  }
  async unpin(plugin,reference) { await fs.rm(path.join(this.root(plugin),'pins',sourceHash(reference)),{force:true}); }
  async read(plugin,id,filename,maxBytes = 2*1024*1024) {
    sourcePath(filename);
    const release = this.acquire(plugin,id);
    try {
      const manifest = await this.manifest(plugin,id), entry = manifest.files.find(file => file.path === filename);
      if (!entry) throw new AppError('SOURCE_FILE_NOT_FOUND','文件不属于此源码版本。');
      return await this.readEntry(plugin,id,entry,maxBytes);
    } finally { release(); }
  }
  async readEntry(plugin,id,entry,maxBytes = 2*1024*1024) {
    if (entry.size > maxBytes) throw new AppError('SOURCE_FILE_TOO_LARGE','文件超过预览大小限制。');
    const bytes = await regularRead(this.root(plugin),`snapshots/${id}/code/${entry.path}`,maxBytes);
    if (bytes.length !== entry.size || sourceHash(bytes) !== entry.sha256) throw sourceError('本地源码已被修改，请恢复此版本后重试。');
    return bytes;
  }
  async search(plugin,id,query,{content = false,signal} = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new AppError('INVALID_ARGUMENT','请输入 1 到 200 个字符的搜索内容。');
    const release = this.acquire(plugin,id);
    try {
      const manifest = await this.manifest(plugin,id), results = [], needle = query.toLocaleLowerCase();
      let scannedBytes = 0;
      for (const file of manifest.files) {
        signal?.throwIfAborted();
        if (!content) { if (file.path.toLocaleLowerCase().includes(needle)) results.push({path:file.path}); }
        else if (file.size <= 2*1024*1024) {
          if (scannedBytes+file.size > 32*1024*1024) return {results,truncated:true,scannedBytes};
          const bytes = await this.readEntry(plugin,id,file);
          scannedBytes += bytes.length;
          if (bytes.includes(0)) continue;
          const lines = bytes.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) if (lines[i].toLocaleLowerCase().includes(needle)) {
            const column = lines[i].toLocaleLowerCase().indexOf(needle);
            results.push({path:file.path,line:i+1,column:column+1,preview:lines[i].slice(Math.max(0,column-80),column+240)});
            if (results.length >= 200) return {results,truncated:true,scannedBytes};
          }
        }
        if (results.length >= 200) return {results,truncated:true,scannedBytes};
      }
      return {results,truncated:false,scannedBytes};
    } finally { release(); }
  }
  async cleanup(plugin) {
    const identity = sourceCacheIdentity(plugin);
    if (this.updates.has(identity)) throw new AppError('SOURCE_BUSY','更新期间不能清理源码缓存。');
    this.updates.add(identity);
    this.cleaning.add(identity);
    try {
      await this.prepare(plugin);
      const current = await this.current(plugin), keep = new Set(current ? [current.snapshotId] : []);
      for (const name of await fs.readdir(path.join(this.root(plugin),'pins'))) {
        const pin = JSON.parse((await regularRead(this.root(plugin),`pins/${name}`,4096)).toString());
        if (!SOURCE_HASH.test(pin.snapshotId)) throw sourceError('源码引用状态损坏，已停止清理。');
        keep.add(pin.snapshotId);
      }
      const objects = new Set();
      let removed = 0;
      for (const id of await fs.readdir(path.join(this.root(plugin),'snapshots'))) {
        if (!SOURCE_HASH.test(id)) continue;
        const manifest = await this.manifest(plugin,id);
        if (keep.has(id) || this.readers.has(`${identity}/${id}`)) for (const file of manifest.files) objects.add(file.sha256);
        else { await fs.rm(this.snapshotDirectory(plugin,id),{recursive:true,force:true}); removed++; }
      }
      for (const name of await fs.readdir(path.join(this.root(plugin),'objects'))) if (SOURCE_HASH.test(name) && !objects.has(name)) await fs.rm(path.join(this.root(plugin),'objects',name),{force:true});
      return {removed};
    } finally { this.updates.delete(identity); this.cleaning.delete(identity); }
  }
}
