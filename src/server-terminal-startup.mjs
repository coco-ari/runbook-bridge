import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

// 使用 Readline 原生高亮配置，仅影响当前 Bash；旧版不支持时保持原行为。
export const TERMINAL_PASTE_COLORS = "if [ -n \"${BASH_VERSION-}\" ]; then builtin bind 'set active-region-start-color \\e[27;48;5;23;38;5;195m' 2>/dev/null; builtin bind 'set active-region-end-color \\e[0m' 2>/dev/null; fi";

// 固定的人工终端启动配置；不接受 Renderer 或远端输出作为命令内容。
export const DEFAULT_TERMINAL_COLORS = "if command ls --color=auto -d . >/dev/null 2>&1; then export LS_COLORS='di=01;34:ln=01;36:ex=01;32:or=01;31:fi=0:*.zip=01;35:*.tar=01;35:*.gz=01;35:*.jar=01;35'; alias ls='ls --color=auto'; alias ll='ls -alF --color=auto'; else case $(command uname -s) in Darwin|FreeBSD|OpenBSD|NetBSD|DragonFly) export CLICOLOR=1 LSCOLORS=ExFxCxDxBxegedabagacad; alias ls='ls -G'; alias ll='ls -alF -G';; esac; fi" + "; " + TERMINAL_PASTE_COLORS;

export function probeTerminalShell(client, timeoutMs = 1500) {
  if (typeof client.exec !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let channel;
    let output = '';
    let bytes = 0;
    const finish = (supported = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener?.('close', closed);
      client.removeListener?.('end', closed);
      channel?.destroy();
      resolve(supported);
    };
    const closed = () => finish();
    const timer = setTimeout(closed, timeoutMs);
    client.once?.('close', closed);
    client.once?.('end', closed);
    try {
      client.exec("printf '%s' \"$SHELL\"", { pty: false }, (error, stream) => {
        if (stream) stream.on('error', closed);
        if (settled || error) { stream?.destroy(); finish(); return; }
        channel = stream;
        const collect = (chunk, stderr = false) => {
          bytes += chunk.length;
          if (bytes > 4096 || stderr) { finish(); return; }
          output += chunk.toString('utf8');
        };
        stream.on('data', collect);
        stream.stderr?.on('data', (chunk) => collect(chunk, true));
        stream.once('close', (code) => {
          // 仅识别完整路径中的已知 Shell 名称，额外输出与不明 Shell 均跳过。
          finish(code === 0 && /^(?:\/[a-zA-Z0-9._-]+)*\/(?:bash|zsh|sh|dash|ash|ksh|ksh93)$/.test(output));
        });
        stream.resume();
        stream.stderr?.resume();
      });
    } catch { finish(); }
  });
}

// 只隔离新会话的初始化输出；完成标记之后按原始字节转发，不匹配用户命令文本。
export function createTerminalStartup(command, { timeoutMs = 15_000, maxBytes = 1024 * 1024, identifyShell = false } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const label = 'runbook-ready:' + token;
  const marker = Buffer.from('\x1b]' + label + '\x07');
  const shellLabel = 'runbook-shell:' + token + ':';
  const shellPrefix = Buffer.from('\x1b]' + shellLabel);
  let shellPid = null;
  let pending = Buffer.alloc(0);
  let received = 0;
  let settled = false;
  let done = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // 写入或通道初始化可能先失败，保持取消路径没有未处理的 Promise 拒绝。
  void ready.catch(() => undefined);
  const finish = (error) => {
    if (settled) return;
    settled = true;
    done = !error;
    clearTimeout(timer);
    pending = Buffer.alloc(0);
    if (error) rejectReady(error);
    else resolveReady();
  };
  const timer = setTimeout(() => finish(new AppError('TERMINAL_STARTUP_TIMEOUT', '终端初始化超时，请检查登录 Shell 是否等待输入后重新打开终端。')), timeoutMs);
  return {
    // 使用转义形式构造控制字符，避免命令本身的回显被误认成完成标记。
    command: command + (identifyShell ? "; printf '\\033]" + shellLabel + "%s\\007' \"$$\"" : "") + "; printf '\\033]" + label + "\\007'\r",
    get shellPid() { return shellPid; },
    ready,
    get done() { return done; },
    consume(chunk) {
      if (done) return chunk;
      if (settled) return Buffer.alloc(0);
      received += chunk.length;
      if (received > maxBytes) {
        finish(new AppError('TERMINAL_STARTUP_FAILED', '终端初始化输出异常，请检查登录 Shell 的启动配置后重新打开终端。'));
        return Buffer.alloc(0);
      }
      const combined = Buffer.concat([pending, chunk]);
      // 随机帧只用于本会话的初始化元数据，进程号严格限制为十进制整数。
      const shellStart = identifyShell ? combined.indexOf(shellPrefix) : -1;
      if (shellStart !== -1) {
        const shellEnd = combined.indexOf(7, shellStart + shellPrefix.length);
        if (shellEnd !== -1) {
          const value = combined.subarray(shellStart + shellPrefix.length, shellEnd).toString('latin1');
          const pid = Number(value);
          if (/^[1-9][0-9]{0,9}$/u.test(value) && Number.isSafeInteger(pid) && pid <= 2147483647) shellPid = pid;
        }
      }
      const index = combined.indexOf(marker);
      if (index !== -1) {
        const remainder = combined.subarray(index + marker.length);
        finish();
        return remainder;
      }
      // 只保留可能跨包的标记尾部，登录横幅和回显不会累积到终端缓冲。
      pending = Buffer.from(combined.subarray(Math.max(0, combined.length - Math.max(marker.length, shellPrefix.length + 12) + 1)));
      return Buffer.alloc(0);
    },
    cancel() { finish(new AppError('TERMINAL_CLOSED', '终端初始化已取消。')); },
  };
}
