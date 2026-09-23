import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

export const UPLOAD_BLOCK_BYTES = 32 * 1024;
export const UPLOAD_WINDOW_BLOCKS = 32;

const connectionWriteWindows = new WeakMap();

// 同一 SSH 连接的上传共用额度，避免两个 SFTP 通道各自积压一整批。
class UploadWriteWindow {
  constructor() {
    this.jobs = [];
    this.active = 0;
    this.users = 0;
    this.generation = 0;
    this.pumping = false;
  }
  enter(now) {
    if (this.users++ === 0) {
      this.now = now;
      this.limit = 1;
      this.baseline = Infinity;
      this.fastAcks = 0;
      this.generation += 1;
    }
  }
  resize(limit) {
    this.limit = limit;
    this.fastAcks = 0;
    this.generation += 1;
  }
  acknowledged(elapsed, generation, baselineProbe) {
    // 只有无其他在途写入的单请求可重测基线，不能用旧窗口的排队回执抬高阈值。
    this.baseline = baselineProbe && generation === this.generation ? elapsed : Math.min(this.baseline, elapsed);
    if (elapsed >= 2000 || elapsed > Math.max(this.baseline * 1.5, this.baseline + 50)) {
      this.resize(Math.max(1, Math.floor(this.limit / 2)));
    } else if (generation === this.generation && ++this.fastAcks >= this.limit) {
      // 稳定高 RTT 仍可扩窗；只有实际回执变慢才收缩，不按 RTT 线性封顶。
      // 扩窗保留同一代次的有效确认；只有缩窗或空闲重启才隔离旧确认。
      this.limit = Math.min(UPLOAD_WINDOW_BLOCKS, this.limit * 2);
      this.fastAcks = 0;
    }
  }
  finish(job, error) {
    if (job.done) return;
    job.done = true;
    job.signal?.removeEventListener('abort', job.abort);
    const index = this.jobs.indexOf(job);
    if (index !== -1) this.jobs.splice(index, 1);
    if (error) job.reject(error);
    else job.resolve();
  }
  run(options) {
    return new Promise((resolve, reject) => {
      const job = { ...options, resolve, reject, offset:0, remaining:Math.ceil(options.buffer.length / UPLOAD_BLOCK_BYTES), done:false };
      job.abort = () => {
        this.finish(job, job.signal.reason ?? new AppError('TRANSFER_CANCELLED', '文件传输已停止。'));
        this.pump();
      };
      this.jobs.push(job);
      job.signal?.addEventListener('abort', job.abort, {once:true});
      if (job.signal?.aborted) job.abort();
      else this.pump();
    });
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.limit) {
        const index = this.jobs.findIndex(job => job.offset < job.buffer.length);
        if (index === -1) break;
        const [job] = this.jobs.splice(index, 1);
        this.jobs.push(job);
        if (job.signal?.aborted) { job.abort(); continue; }
        const offset = job.offset, bytes = Math.min(UPLOAD_BLOCK_BYTES, job.buffer.length - offset);
        const started = this.now(), generation = this.generation, baselineProbe = this.limit === 1 && this.active === 0;
        job.offset += bytes;
        this.active += 1;
        let returned = false;
        const complete = error => {
          if (returned) return;
          returned = true;
          this.active -= 1;
          // 迟到回执只归还连接额度，不更新进度，也不复活已失败或取消的批次。
          if (!job.done) {
            if (error) {
              this.resize(Math.max(1, Math.floor(this.limit / 2)));
              this.finish(job, error);
            } else if (job.signal?.aborted) job.abort();
            else {
              this.acknowledged(Math.max(0, this.now() - started), generation, baselineProbe);
              try {
                job.onAcknowledged(bytes);
                if (!job.done && --job.remaining === 0) this.finish(job);
              } catch (callbackError) { this.finish(job, callbackError); }
            }
          }
          this.pump();
        };
        // 同步失败也必须先撤销该批次，再考虑发出下一块。
        try { job.sftp.write(job.handle, job.buffer, offset, bytes, job.position + offset, complete); }
        catch (error) { complete(error); }
      }
    } finally { this.pumping = false; }
  }
}

// 每批最多 1 MiB；读取、哈希和可恢复偏移仍只在整批回执到齐后推进。
export async function writeUploadBlocks({ sftp, handle, localHandle, size, start = 0, hash = crypto.createHash('sha256'), signal, onAcknowledged, onCheckpoint, checkPause, writeScope = sftp, now = () => performance.now() }) {
  let window = connectionWriteWindows.get(writeScope);
  if (!window) { window = new UploadWriteWindow(); connectionWriteWindows.set(writeScope, window); }
  window.enter(now);
  let position = start;
  let acknowledged = start;
  try {
    checkPause?.();
    while (position < size) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_BLOCK_BYTES * UPLOAD_WINDOW_BLOCKS, size - position));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await localHandle.read(buffer, filled, buffer.length - filled, position + filled);
        if (!bytesRead) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在上传期间发生变化。');
        filled += bytesRead;
        signal?.throwIfAborted();
      }
      hash.update(buffer);
      await window.run({sftp, handle, buffer, position, signal, onAcknowledged:bytes => {
        acknowledged += bytes;
        onAcknowledged?.(acknowledged);
      }});
      signal?.throwIfAborted();
      position += buffer.length;
      onCheckpoint?.({ bytes: position, sha256: hash.copy().digest('hex') });
      checkPause?.();
    }
    return { bytes: position, sha256: hash.digest('hex') };
  } finally { window.users -= 1; }
}

export function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(signal.reason ?? new AppError('TRANSFER_CANCELLED', '文件传输已停止。')); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) stop();
  });
}

const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');

async function readLocalHash(handle, size, prefixBytes, signal, checkPause) {
  const full = crypto.createHash('sha256');
  const prefix = crypto.createHash('sha256');
  let offset = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (offset < size) {
    signal?.throwIfAborted();
    checkPause?.();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在检查期间发生变化。');
    full.update(buffer.subarray(0, bytesRead));
    if (offset < prefixBytes) prefix.update(buffer.subarray(0, Math.min(bytesRead, prefixBytes - offset)));
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  return { sha256: full.digest('hex'), prefix };
}

async function remoteHash(sftp, handle, bytes, lifecycle, checkPause) {
  const hash = crypto.createHash('sha256');
  for (let position = 0; position < bytes;) {
    checkPause?.();
    const buffer = Buffer.allocUnsafe(Math.min(16 * 30 * 1024, bytes - position));
    const reads = [];
    for (let offset = 0; offset < buffer.length; offset += 30 * 1024) {
      const start = offset;
      const length = Math.min(30 * 1024, buffer.length - offset);
      reads.push((async () => {
        let read = 0;
        while (read < length) {
          lifecycle.signal.throwIfAborted();
          const count = await sftpCall(sftp, 'read', handle, buffer, start + read, length - read, position + start + read);
          lifecycle.signal.throwIfAborted();
          if (!Number.isSafeInteger(count) || count <= 0 || count > length - read) throw new AppError('UPLOAD_PARTIAL_CHANGED', '服务器临时文件不完整，请重新上传。');
          read += count;
          lifecycle.reportProgress({phase:'resume-verification',verifiedBytes:position+start+read,totalBytes:bytes});
        }
      })());
    }
    await abortable(Promise.all(reads), lifecycle.signal);
    hash.update(buffer);
    position += buffer.length;
  }
  return hash.digest('hex');
}

function validRegular(stats, size) {
  return stats?.isFile?.() && !stats.isSymbolicLink?.() && Number.isSafeInteger(stats.size) && stats.size >= 0 && stats.size <= size;
}
function sameRemote(left, right) {
  return left.size === right.size && left.mode === right.mode && left.mtime === right.mtime;
}

async function checkedRemoteHandle(sftp, name, flags, size, lifecycle) {
  const call = (method, ...args) => abortable(sftpCall(sftp, method, ...args), lifecycle.signal);
  const before = await call('lstat', name);
  if (!validRegular(before, size) || await call('realpath', name) !== name) throw new AppError('UPLOAD_PARTIAL_CHANGED', '服务器临时文件类型或路径已变化，请重新上传。');
  const handle = await call('open', name, flags);
  try {
    const current = await call('fstat', handle);
    if (!validRegular(current, size) || !sameRemote(before, current) || await call('realpath', name) !== name) throw new AppError('UPLOAD_PARTIAL_CHANGED', '服务器临时文件已变化，请重新上传。');
    return { handle, stat: current };
  } catch (error) {
    if (!lifecycle.signal.aborted) await call('close', handle).catch(() => undefined);
    throw error;
  }
}

export function recoverableUpload(error, signal) {
  return signal?.reason?.code === 'UPLOAD_CONNECTION_LOST'
    || ['TRANSFER_INTERRUPTED', 'SFTP_OPERATION_TIMEOUT', 'SFTP_UNAVAILABLE'].includes(error?.code);
}

// 恢复描述只由主进程持有；目标与源文件始终使用原确认的精确参数和前置条件。
export async function uploadWithCheckpoints(broker, projectId, source, target, precondition, options, helpers) {
  const { signal, onProgress, onCheckpoint, beforeCommit } = options;
  const checkPause = () => {
    signal?.throwIfAborted();
    if (options.shouldPause?.()) throw new AppError('UPLOAD_PAUSED', '上传已暂停。');
  };
  let state = options.checkpoint ? { ...options.checkpoint } : null;
  const expected = precondition.local;
  if (state && (state.sourceHash !== expected.sha256 || state.size !== expected.size
    || !Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > expected.size
    || !/^[a-f0-9]{64}$/.test(state.sha256)
    || !state.temporary.startsWith(target + '.part-')
    || !/^[a-f0-9]{24}$/.test(state.temporary.slice((target + '.part-').length)))) {
    throw new AppError('UPLOAD_RESUME_INVALID', '续传记录已失效，请重新选择文件。');
  }
  if (!state?.owned) state = {temporary:target+'.part-'+crypto.randomBytes(12).toString('hex'),sourceHash:expected.sha256,size:expected.size,bytes:0,sha256:EMPTY_SHA256,phase:'opening',owned:false};
  const publish = () => { signal?.throwIfAborted(); onCheckpoint?.({ ...state }); };
  signal?.throwIfAborted();
  const before = await helpers.lstat(source);
  const sameLocal = value => value.isFile() && !value.isSymbolicLink()
    && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ino === before.ino && value.dev === before.dev;
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在确认后发生变化，需要重新确认。');
  const localHandle = await helpers.openLocal(source);
  try {
    if (!sameLocal(await localHandle.stat())) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在确认后已被替换。');
    onProgress?.({transferredBytes:state.bytes,phase:'preparing'});
    const local = await readLocalHash(localHandle, expected.size, state.bytes, signal, checkPause);
    if (local.sha256 !== expected.sha256 || local.prefix.copy().digest('hex') !== state.sha256 || !sameLocal(await localHandle.stat())) throw new AppError('LOCAL_FILE_CHANGED', '本地文件内容在确认后发生变化，需要重新确认。');
    checkPause();
    publish();
    let reconciled = false;
    await broker.withInternalSftp(projectId, async (sftp, _session, lifecycle) => {
      const call = (method, ...args) => abortable(sftpCall(sftp, method, ...args), lifecycle.signal);
      let remoteHandle;
      let stat;
      try {
        if (state.phase === 'committing') {
          let partialMissing = false;
          try { await call('lstat', state.temporary); }
          catch (error) { if (String(error.code) === '2') partialMissing = true; else throw error; }
          if (partialMissing) {
            const targetFile = await checkedRemoteHandle(sftp, target, 'r', expected.size, lifecycle);
            remoteHandle = targetFile.handle;
            if (targetFile.stat.size !== expected.size || await remoteHash(sftp, remoteHandle, expected.size, lifecycle) !== expected.sha256
              || !sameRemote(targetFile.stat, await call('fstat', remoteHandle))) throw new AppError('REMOTE_CHANGED', '上次提交结果无法确认，请核对服务器文件。');
            await call('close', remoteHandle); remoteHandle = null;
            await beforeCommit?.(sftp, lifecycle);
            if (!sameLocal(await localHandle.stat()) || !sameLocal(await helpers.lstat(source))) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在检查期间发生变化。');
            reconciled = true;
            return;
          }
        }
        await abortable(helpers.requireRemoteSnapshot(sftp, target, precondition.remote), lifecycle.signal);
        if (state.owned) {
          const partial = await checkedRemoteHandle(sftp, state.temporary, 'r+', expected.size, lifecycle);
          remoteHandle = partial.handle; stat = partial.stat;
          if (stat.size < state.bytes || await remoteHash(sftp, remoteHandle, state.bytes, lifecycle, checkPause) !== state.sha256
            || !sameRemote(stat, await call('fstat', remoteHandle))) throw new AppError('UPLOAD_PARTIAL_CHANGED', '服务器已传部分发生变化，请重新上传。');
        } else {
          remoteHandle = await call('open', state.temporary, 'wx', precondition.remote.exists ? precondition.remote.mode & 0o777 : 0o644);
          state.owned = true;
        }
        state.phase = 'uploading'; publish();
        let lastPublished = 0;
        const result = await writeUploadBlocks({
          sftp, handle:remoteHandle, localHandle, size:expected.size, start:state.bytes, hash:local.prefix, signal:lifecycle.signal, checkPause, writeScope:_session?.client ?? sftp,
          onAcknowledged: bytes => {
            lifecycle.reportProgress({phase:'uploading',transferredBytes:bytes,totalBytes:expected.size});
            if (Date.now()-lastPublished >= 250 || bytes === expected.size) { lastPublished=Date.now(); onProgress?.({transferredBytes:bytes,phase:'uploading'}); }
          },
          onCheckpoint: checkpoint => { state.bytes=checkpoint.bytes; state.sha256=checkpoint.sha256; publish(); },
        });
        onProgress?.({transferredBytes:expected.size,phase:'verifying'});
        if (result.sha256 !== expected.sha256 || !sameLocal(await localHandle.stat()) || !sameLocal(await helpers.lstat(source))) throw new AppError('LOCAL_FILE_CHANGED', '本地文件在上传期间发生变化，上传已停止。');
        const complete = await call('fstat', remoteHandle);
        if (!validRegular(complete, expected.size) || complete.size !== expected.size) throw new AppError('TRANSFER_INTEGRITY_FAILED', '临时文件大小与源文件不一致。');
        await call('close', remoteHandle); remoteHandle = null;
        await beforeCommit?.(sftp, lifecycle);
        await abortable(helpers.requireRemoteSnapshot(sftp, target, precondition.remote), lifecycle.signal);
        lifecycle.signal.throwIfAborted();
        const named = await call('lstat', state.temporary);
        if (!sameRemote(complete, named) || !validRegular(named, expected.size) || await call('realpath', state.temporary) !== state.temporary) throw new AppError('UPLOAD_PARTIAL_CHANGED', '临时文件在提交前发生变化。');
        state.phase = 'committing'; publish();
        await abortable(helpers.rename(sftp, state.temporary, target, {overwrite:precondition.remote.exists}), lifecycle.signal);
      } catch (error) {
        const interrupted = recoverableUpload(error, signal) || recoverableUpload(lifecycle.signal.reason, signal);
        if (!interrupted && state.owned && state.phase !== 'committing' && !['UPLOAD_PAUSED','UPLOAD_PARTIAL_CHANGED','REMOTE_CHANGED'].includes(error.code)) {
          // 主动取消时仍尝试清理自己的临时文件，最多等待半秒，不拖住断线收敛。
          await abortable(sftpCall(sftp, 'unlink', state.temporary), AbortSignal.timeout(500)).catch(() => undefined);
        }
        throw error;
      } finally {
        if (remoteHandle && !lifecycle.signal.aborted) await call('close', remoteHandle).catch(() => undefined);
      }
    }, { ...helpers.timeouts(expected.size), signal });
    return {localPath:source,remotePath:target,bytes:expected.size,sha256:expected.sha256,...(reconciled?{reconciled:true}:{})};
  } finally { await localHandle.close(); }
}
