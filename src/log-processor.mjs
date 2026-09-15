import { Worker } from 'node:worker_threads';
import { AppError } from './errors.mjs';

// 重用少量本地计算线程，避免解压和逐行扫描阻塞 Electron 主线程。
export class LogProcessor {
  constructor({ maxWorkers = 2, timeoutMs = 60_000, idleMs = 2000, workerUrl = new URL('./log-processing-worker.mjs', import.meta.url) } = {}) {
    Object.assign(this, { maxWorkers, timeoutMs, idleMs, workerUrl });
    this.workers = new Set();
    this.queue = [];
  }

  run(operation, args, { timeoutMs = this.timeoutMs } = {}) {
    if (this.queue.length >= 8) throw new AppError('LOG_SEARCH_BUSY', '本地日志处理队列已满，请稍后重试。');
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, args, resolve, reject, deadline:Date.now() + Math.min(timeoutMs,this.timeoutMs) });
      this.drain();
    });
  }

  createWorker() {
    const state = { worker:new Worker(this.workerUrl, { execArgv:[], resourceLimits:{ maxOldGenerationSizeMb:384 } }), task:null, timer:null };
    this.workers.add(state);
    state.worker.on('message', message => {
      const task = state.task;
      if (!task) return;
      state.task = null;
      clearTimeout(state.timer);
      if (message.error) task.reject(new AppError(message.error.code, message.error.message, message.error.details));
      else {
        if (task.operation === 'expand') {
          for (const snapshot of message.result.snapshots) snapshot.content = Buffer.from(snapshot.content.buffer, snapshot.content.byteOffset, snapshot.content.byteLength);
        }
        task.resolve(message.result);
      }
      state.worker.unref();
      state.timer = setTimeout(() => this.remove(state), this.idleMs);
      state.timer.unref();
      this.drain();
    });
    state.worker.on('error', () => this.remove(state, new AppError('LOG_PROCESSING_FAILED', '本地日志处理线程已退出，请缩小搜索范围。')));
    state.worker.on('exit', () => {
      if (this.workers.has(state)) this.remove(state, new AppError('LOG_PROCESSING_FAILED', '本地日志处理线程已退出。'));
    });
    return state;
  }

  remove(state, error) {
    if (!this.workers.delete(state)) return;
    clearTimeout(state.timer);
    if (state.task) state.task.reject(error ?? new AppError('LOG_PROCESSING_CANCELLED', '本地日志处理已取消。'));
    state.task = null;
    void state.worker.terminate();
    this.drain();
  }

  drain() {
    while (this.queue.length) {
      const idle = [...this.workers].find(state => !state.task);
      if (!idle && this.workers.size >= this.maxWorkers) return;
      let state;
      try { state = idle ?? this.createWorker(); }
      catch {
        this.queue.shift().reject(new AppError('LOG_PROCESSING_FAILED', '无法启动本地日志处理线程。'));
        continue;
      }
      clearTimeout(state.timer);
      state.task = this.queue.shift();
      state.worker.ref();
      state.timer = setTimeout(() => this.remove(state, new AppError('LOG_PROCESSING_TIMEOUT', '本地日志处理超时，请缩小搜索范围。')), Math.max(1,state.task.deadline - Date.now()));
      try { state.worker.postMessage({ operation:state.task.operation, args:state.task.args }); }
      catch { this.remove(state, new AppError('LOG_PROCESSING_FAILED', '无法传递日志处理任务。')); }
    }
  }

  close() {
    for (const task of this.queue.splice(0)) task.reject(new AppError('LOG_PROCESSING_CANCELLED', '本地日志处理已取消。'));
    for (const state of this.workers) this.remove(state);
  }
}

export const logProcessor = new LogProcessor();
