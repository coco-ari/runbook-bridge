import { AppError } from './errors.mjs';

// 只接收当前人工终端启动时记录的进程号，不接受路径或任意命令。
export function readTerminalDirectoryChannel(client, pid, { signal, timeoutMs = 3000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw new AppError('TERMINAL_DIRECTORY_UNAVAILABLE', '当前终端暂不支持读取工作目录，请输入路径定位。');
  const command = 'command readlink -- /proc/' + pid + '/cwd';
  return new Promise((resolve, reject) => {
    let channel, settled = false, bytes = 0, exitCode = null;
    const chunks = [];
    const failure = (code = 'TERMINAL_DIRECTORY_UNAVAILABLE') => new AppError(code, '无法读取当前终端的工作目录。此功能需要 Linux 和可访问的 Shell 进程。');
    const close = stream => { try { stream?.close(); stream?.destroy(); } catch { /* 只释放当前目录查询通道。 */ } };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      client.removeListener?.('close', disconnected);
      client.removeListener?.('error', disconnected);
      if (!error) {
        try {
          const output = new TextDecoder('utf-8', { fatal:true }).decode(Buffer.concat(chunks));
          const path = output.endsWith('\n') ? output.slice(0, -1) : '';
          if (exitCode !== 0 || !path.startsWith('/') || /[\u0000-\u001f\u007f-\u009f]/u.test(path) || Buffer.byteLength(path) > 4096) throw failure();
          resolve({ path });
        } catch { error = failure(); }
      }
      close(channel);
      if (error) reject(error);
    };
    const aborted = () => finish(failure('TERMINAL_CLOSED'));
    const disconnected = () => finish(failure('TERMINAL_CLOSED'));
    const timer = setTimeout(() => finish(failure('TERMINAL_DIRECTORY_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once:true });
    client.once?.('close', disconnected);
    client.once?.('error', disconnected);
    if (signal?.aborted) { aborted(); return; }
    try {
      client.exec(command, { pty:false }, (error, stream) => {
        if (stream) stream.on('error', () => finish(failure()));
        if (settled) { close(stream); return; }
        if (error || !stream) { finish(failure()); return; }
        channel = stream;
        const collect = (chunk, retain) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 4097) { finish(failure('TERMINAL_DIRECTORY_OUTPUT_LIMIT')); return; }
          if (retain) chunks.push(Buffer.from(chunk));
        };
        stream.on('data', chunk => collect(chunk, true));
        stream.stderr?.on('data', chunk => collect(chunk, false));
        stream.stderr?.on('error', () => finish(failure()));
        stream.on('exit', code => { exitCode = code; });
        stream.once('close', code => { if (Number.isInteger(code)) exitCode = code; finish(); });
        stream.resume();
        stream.stderr?.resume();
      });
    } catch { finish(failure()); }
  });
}
