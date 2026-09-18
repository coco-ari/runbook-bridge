import { AppError } from './errors.mjs';

const COMMANDS = Object.freeze({
  system: "LC_ALL=C; export LC_ALL; printf '__RB_OS__\\n'; uname -s; printf '__RB_CPU__\\n'; head -n 1 /proc/stat; printf '__RB_CORES__\\n'; getconf _NPROCESSORS_ONLN; printf '__RB_MEMORY__\\n'; cat /proc/meminfo",
  disks: 'LC_ALL=C df -P -k -l',
});

export function metricsCommand(kind) {
  if (!Object.hasOwn(COMMANDS, kind)) throw new AppError('INVALID_ARGUMENT', '服务器指标采样类型无效。');
  return COMMANDS[kind];
}

// 超时覆盖通道建立和读取；只释放采集通道，不能关闭共享 SSH 连接。
export function readMetricsChannel(client, kind, { signal, timeoutMs = 3000, maxBytes = 65536 } = {}) {
  const command = metricsCommand(kind);
  return new Promise((resolve, reject) => {
    let channel, settled = false, bytes = 0, exitCode = null;
    const chunks = [];
    const failure = code => new AppError(code, '服务器指标暂时无法读取。');
    const close = stream => { try { stream?.close(); stream?.destroy(); } catch { /* 采集通道可能已经结束。 */ } };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      client.removeListener('close', disconnected);
      client.removeListener('error', disconnected);
      if (error) { close(channel); reject(error); }
      else resolve({ stdout:Buffer.concat(chunks).toString('utf8'), exitCode });
    };
    const abort = () => finish(failure('METRICS_CANCELLED'));
    const disconnected = () => finish(failure('SSH_NOT_CONNECTED'));
    const timer = setTimeout(() => finish(failure('METRICS_TIMEOUT')), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once:true });
    client.once('close', disconnected);
    client.once('error', disconnected);
    if (signal?.aborted) { abort(); return; }
    try {
      client.exec(command, { pty:false }, (error, stream) => {
        if (settled) { stream?.on('error', () => {}); close(stream); return; }
        if (error || !stream) { finish(failure('METRICS_UNAVAILABLE')); return; }
        channel = stream;
        const data = (chunk, retain) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) { finish(failure('METRICS_OUTPUT_LIMIT')); return; }
          if (retain) chunks.push(Buffer.from(chunk));
        };
        stream.on('error', () => finish(failure('METRICS_UNAVAILABLE')));
        stream.on('data', chunk => data(chunk, true));
        stream.stderr?.on('error', () => finish(failure('METRICS_UNAVAILABLE')));
        stream.stderr?.on('data', chunk => data(chunk, false));
        stream.on('exit', code => { exitCode = code; });
        stream.once('close', code => { if (Number.isInteger(code)) exitCode = code; finish(); });
      });
    } catch { finish(failure('METRICS_UNAVAILABLE')); }
  });
}

function numeric(value) {
  const number = Number(value);
  return /^\d+$/u.test(value) && Number.isSafeInteger(number) ? number : null;
}

export function parseSystemMetrics(text) {
  const os = text.match(/(?:^|\n)__RB_OS__\r?\n([^\r\n]+)/u)?.[1];
  if (os && os !== 'Linux') return { unsupported:true };
  if (os !== 'Linux') throw new AppError('METRICS_INVALID', '服务器指标格式无法识别。');
  const fields = text.match(/(?:^|\n)cpu\s+([0-9 ]+)/u)?.[1].trim().split(/\s+/u).slice(0, 8).map(numeric);
  const cores = numeric(text.match(/__RB_CORES__\r?\n(\d+)/u)?.[1] ?? '');
  const totalKb = numeric(text.match(/^MemTotal:\s+(\d+)\s+kB$/mu)?.[1] ?? '');
  const availableKb = numeric(text.match(/^MemAvailable:\s+(\d+)\s+kB$/mu)?.[1] ?? '');
  let cpu = null;
  if (fields?.length >= 4 && fields.every(value => value !== null)) {
    const total = fields.reduce((sum, value) => sum + value, 0);
    const idle = fields[3] + (fields[4] ?? 0);
    if (Number.isSafeInteger(total) && total > 0) cpu = { total, idle, cores:cores > 0 ? cores : null };
  }
  const memory = totalKb > 0 && availableKb !== null && availableKb <= totalKb && Number.isSafeInteger(totalKb * 1024)
    ? { total:totalKb * 1024, available:availableKb * 1024, used:(totalKb - availableKb) * 1024, percent:(1 - availableKb / totalKb) * 100 }
    : null;
  return { unsupported:false, cpu, memory };
}

export function cpuPercent(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

export function parseDiskMetrics(text) {
  const items = [];
  let truncated = false;
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+(\/.*)$/u);
    if (!match) continue;
    const [, filesystem, totalKb, usedKb, availableKb, percent, escapedMount] = match;
    const mount = escapedMount.replace(/\\(040|011|012|134)/gu, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(mount) || mount.length > 4096) continue;
    if (mount !== '/' && (/^(?:tmpfs|devtmpfs|udev|overlay|shm|none)$/u.test(filesystem) || /^\/(?:proc|sys|dev|run)(?:\/|$)/u.test(mount))) continue;
    const total = Number(totalKb) * 1024, used = Number(usedKb) * 1024, available = Math.max(0, Number(availableKb) * 1024), usage = Number(percent);
    if (![total, used, available, usage].every(Number.isSafeInteger) || total <= 0 || usage > 10000) continue;
    if (items.some(item => item.mount === mount)) continue;
    items.push({ mount, total, used, available, percent:usage });
  }
  if (!items.length) throw new AppError('METRICS_INVALID', '本地磁盘用量暂时无法识别。');
  items.sort((a,b) => a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount));
  if (items.length > 64) { items.length = 64; truncated = true; }
  return { items, truncated };
}
