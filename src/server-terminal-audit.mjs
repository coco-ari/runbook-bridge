import crypto from 'node:crypto';

const KNOWN = new Set('ls pwd cd cat head tail less more grep find stat wc du df free ps top uname whoami id date uptime hostname systemctl service journalctl docker git npm pnpm node python python3 java sh bash zsh sudo su env export echo printf curl wget mysql redis-cli ssh scp rsync tar unzip chmod chown mkdir touch cp mv rm rmdir ln kill pkill true false sleep exit clear history'.split(' '));
const PATH_COMMANDS = new Set('ls cd cat head tail less more stat wc du find mkdir touch cp mv rm rmdir ln chmod chown'.split(' '));
const SAFE_WORDS = new Set('status start stop restart reload enable disable is-active list-units list-unit-files daemon-reload ps logs stats inspect images containers version info aux get describe apply delete rollout diff pull push fetch checkout branch log show'.split(' '));

// 摘要只保留常见命令、受限选项与资源目标；任意参数、脚本正文及未知命令均隐藏。
export function summarizeTerminalCommand(value) {
  if (typeof value !== 'string' || !value.trim()) return '命令内容未由 Shell 提供';
  const text = value.trim().slice(0,4096);
  const words = text.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/gu) ?? [];
  let index = 0;
  const output = [];
  if (words[0] === 'sudo') { output.push('sudo'); index++; }
  const command = words[index++] ?? '';
  if (!KNOWN.has(command)) return '自定义命令（内容已隐藏）';
  output.push(command);
  if (/[;&|\x60$()<>\r\n]/u.test(text)) return output.join(' ') + '（组合命令或参数已隐藏）';
  if (/(?:password|passwd|token|secret|authorization|credential|api[-_]?key|private[-_]?key)/iu.test(text)) return output.join(' ') + ' [参数已隐藏]';
  let hidden = false;
  const resourceActions = new Set('status start stop restart reload is-active logs stats inspect'.split(' '));
  const hasResourceAction = resourceActions.has(words[index]) || (command === 'service' && resourceActions.has(words[index + 1]));
  for (const word of words.slice(index, index + 40)) {
    const flag = /^(?:-[ahlrRfstn]+|--(?:all|human-readable|help|version|no-pager|follow))$/u.test(word);
    const path = PATH_COMMANDS.has(command) && /^(?:\/|\.\.?\/)[a-zA-Z0-9_./*?-]{1,200}$/u.test(word);
    const resource = hasResourceAction && ['systemctl','service','docker'].includes(command) && /^[a-zA-Z0-9_.@-]{1,80}$/u.test(word);
    const subcommand = ['git','docker','systemctl','service','journalctl','ps'].includes(command) && SAFE_WORDS.has(word);
    if ((flag && !['echo','printf','export','env','mysql','redis-cli','curl','wget','ssh','su','sh','bash','zsh'].includes(command)) || path || resource || subcommand) output.push(word);
    else hidden = true;
  }
  if (hidden || words.length > index + 40) output.push('[参数已隐藏]');
  return output.join(' ').slice(0,1024);
}

export function createTerminalCommandAudit(onCommand) {
  const token = crypto.randomBytes(16).toString('hex');
  const name = '__rbb_audit_' + token.slice(0,8);
  const prefix = Buffer.from('\x1b]runbook-command:' + token + ':');
  let pending = Buffer.alloc(0);
  let historyId = null;
  let submitted = false;
  let input = false;
  let available = false;
  // 固定函数只影响当前交互会话，不改启动文件、历史策略或现有 DEBUG trap。
  const hook = name + '() { local rbb_code=$? rbb_text rbb_hex; if [ -n "$' + '{BASH_VERSION-}" ]; then rbb_text=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null); rbb_text="$' + '{rbb_text#*[0-9]  }"; else rbb_text=$(builtin fc -ln -1 2>/dev/null); fi; rbb_text='
    + '$' + '{rbb_text:0:4096}; rbb_hex=$(builtin printf \'%s\' "$rbb_text" | command od -An -v -tx1 | command tr -d \' \\n\'); builtin printf \'\\033]runbook-command:'
    + token + ':%s:%s:%s\\007\' "$' + '{HISTCMD:-0}" "$rbb_code" "$rbb_hex"; return "$rbb_code"; }';
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const bash = hook + '; if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == \'declare -a\'* ]]; then PROMPT_COMMAND=(' + name
    + ' "$' + '{PROMPT_COMMAND[@]}"); else PROMPT_COMMAND="' + name + '$' + '{PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi';
  const zsh = hook + '; precmd_functions=(' + name + ' "$' + '{precmd_functions[@]}")';
  const command = 'if [ -n "$' + '{BASH_VERSION-}" ]; then if ( unset PROMPT_COMMAND ) 2>/dev/null; then eval ' + quote(bash) + '; fi; elif [ -n "$' + '{ZSH_VERSION-}" ]; then if ( unset precmd_functions ) 2>/dev/null; then eval ' + quote(zsh) + '; fi; fi';
  const frame = body => {
    const match = /^([0-9]{1,12}):([0-9]{1,3}):((?:[0-9a-f]{2})*)$/u.exec(body);
    if (!match || Number(match[2]) > 255) return;
    available = true;
    const changed = historyId !== null && historyId !== match[1];
    if (changed || submitted) {
      const summary = changed ? summarizeTerminalCommand(Buffer.from(match[3],'hex').toString('utf8')) : '命令内容未由 Shell 提供';
      onCommand({summary,exitCode:Number(match[2]),known:changed});
    }
    historyId = match[1];
    submitted = false; input = false;
  };
  return {
    command,
    get available() { return available; },
    noteInput(data) {
      // 只保留是否有输入的布尔状态；不缓存人工键入内容，也不从密码提示推断命令。
      for (const byte of data) {
        if (byte === 13 || byte === 10) { submitted ||= input; input = false; }
        else if (byte === 3) { submitted ||= input; input = false; }
        else input = true;
      }
    },
    consume(chunk) {
      let data = Buffer.concat([pending,chunk]);
      pending = Buffer.alloc(0);
      const output = [];
      while (data.length) {
        const start = data.indexOf(prefix);
        if (start < 0) {
          let suffix = Math.min(data.length,prefix.length - 1);
          while (suffix > 0 && !data.subarray(data.length - suffix).equals(prefix.subarray(0,suffix))) suffix--;
          output.push(data.subarray(0,data.length - suffix));
          pending = Buffer.from(data.subarray(data.length - suffix));
          break;
        }
        output.push(data.subarray(0,start));
        const end = data.indexOf(7,start + prefix.length);
        if (end < 0 && data.length - start <= 33000) { pending = Buffer.from(data.subarray(start)); break; }
        if (end < 0 || end - start > 33000) { output.push(data.subarray(start,start + prefix.length)); data = data.subarray(start + prefix.length); continue; }
        frame(data.subarray(start + prefix.length,end).toString('ascii'));
        data = data.subarray(end + 1);
      }
      return Buffer.concat(output);
    },
  };
}
