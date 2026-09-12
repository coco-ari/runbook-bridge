// 固定的人工终端启动配置；不接受 Renderer 或远端输出作为命令内容。
export const DEFAULT_TERMINAL_COLORS = "if command ls --color=auto -d . >/dev/null 2>&1; then export LS_COLORS='di=01;34:ln=01;36:ex=01;32:or=01;31:fi=0:*.zip=01;35:*.tar=01;35:*.gz=01;35:*.jar=01;35'; alias ls='ls --color=auto'; alias ll='ls -alF --color=auto'; else case $(command uname -s) in Darwin|FreeBSD|OpenBSD|NetBSD|DragonFly) export CLICOLOR=1 LSCOLORS=ExFxCxDxBxegedabagacad; alias ls='ls -G'; alias ll='ls -alF -G';; esac; fi";

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
