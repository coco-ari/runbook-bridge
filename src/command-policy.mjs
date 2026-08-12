import path from 'node:path';

export const COMMAND_POLICY_VERSION = '1';

const CONTROL_OPERATOR = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '`']);
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish']);
const INLINE_INTERPRETERS = new Map([
  ['python', ['-c']],
  ['python2', ['-c']],
  ['python3', ['-c']],
  ['perl', ['-e', '-E']],
  ['ruby', ['-e']],
  ['node', ['-e', '--eval']],
  ['php', ['-r']],
]);
const PROTECTED_DELETE_TARGETS = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc',
  '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '.', '..', '*', './*',
  '~', '~/*', '$home', '${home}', '$home/*', '${home}/*',
]);
const DISK_COMMANDS = new Set([
  'badblocks', 'cfdisk', 'cryptsetup', 'fdisk', 'lvremove', 'mkfs', 'mkswap', 'parted',
  'pvremove', 'sfdisk', 'vgremove', 'wipefs', 'zpool',
]);
const IDENTITY_COMMANDS = new Set([
  'chpasswd', 'groupadd', 'groupdel', 'groupmod', 'passwd', 'useradd', 'userdel',
  'usermod', 'visudo',
]);
const POWER_COMMANDS = new Set(['halt', 'kexec', 'poweroff', 'reboot', 'shutdown']);
const KERNEL_COMMANDS = new Set(['insmod', 'modprobe', 'rmmod']);
const FILE_DELETE_COMMANDS = new Set(['rm', 'rmdir', 'shred', 'truncate', 'unlink']);
const PACKAGE_COMMANDS = new Set(['apt', 'apt-get', 'aptitude', 'apk', 'dnf', 'dpkg', 'pacman', 'rpm', 'yum', 'zypper']);
const PACKAGE_MODIFY_ACTIONS = new Set([
  'install', 'remove', 'purge', 'update', 'upgrade', 'dist-upgrade', 'full-upgrade',
  'autoremove', 'reinstall', 'downgrade', 'erase', 'add', 'del',
]);
const SENSITIVE_AUTH_PATH_RE = /^(?:\/etc\/(?:passwd|shadow|group|gshadow|sudoers)(?:\/|$)|\/etc\/(?:ssh|sudoers\.d)(?:\/|$)|\/root\/\.ssh\/authorized_keys$)/i;

function baseCommand(value) {
  return path.posix.basename(String(value ?? '').replace(/\\/g, '/')).toLowerCase();
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// This is intentionally a small lexer, not a shell implementation. Its job is
// to make obvious quoting and chaining unable to hide a dangerous command from
// the policy (for example r''m or /sbin/reboot). The Linux account remains the
// real security boundary.
function lexShell(command) {
  const input = String(command ?? '').normalize('NFKC');
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  const pushCurrent = () => {
    if (!started) return;
    tokens.push(current);
    current = '';
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      if (index + 1 >= input.length) return { tokens, parseError: 'dangling-escape' };
      started = true;
      current += input[index + 1];
      index += 1;
      continue;
    }
    if (char === '#' && !started) {
      while (index + 1 < input.length && input[index + 1] !== '\n') index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      pushCurrent();
      if (char === '\n') tokens.push('\n');
      continue;
    }
    if (';&|()<>`'.includes(char)) {
      pushCurrent();
      const pair = `${char}${input[index + 1] ?? ''}`;
      if (['&&', '||', '>>', '<<'].includes(pair)) {
        tokens.push(pair);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }
    started = true;
    current += char;
  }
  pushCurrent();
  return { tokens, parseError: quote ? 'unterminated-quote' : null };
}

function splitSegments(tokens) {
  const segments = [];
  let current = [];
  let precedingOperator = null;
  for (const token of tokens) {
    if (!CONTROL_OPERATOR.has(token)) {
      current.push(token);
      continue;
    }
    if (current.length) segments.push({ tokens: current, precedingOperator });
    current = [];
    precedingOperator = token;
  }
  if (current.length) segments.push({ tokens: current, precedingOperator });
  return segments;
}

function resolveCommand(segment) {
  const tokens = [...segment.tokens];
  let index = 0;
  while (index < tokens.length && ['if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time', 'case', 'esac', '!'].includes(tokens[index].toLowerCase())) index += 1;
  for (let depth = 0; depth < 8; depth += 1) {
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
    if (index >= tokens.length) return null;
    const name = baseCommand(tokens[index]);
    if (name === 'env') {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index += 1;
      continue;
    }
    if (['command', 'exec', 'nohup', 'setsid'].includes(name)) {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
      continue;
    }
    if (name === 'timeout') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
      if (index < tokens.length) index += 1;
      continue;
    }
    if (name === 'nice') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        index += 1;
        if ((option === '-n' || option === '--adjustment') && index < tokens.length) index += 1;
      }
      continue;
    }
    if (name === 'ionice') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        index += 1;
        if (['-c', '--class', '-n', '--classdata', '-t', '--ignore'].includes(option) && index < tokens.length) index += 1;
      }
      continue;
    }
    if (name === 'busybox') {
      index += 1;
      continue;
    }
    return { name, args: tokens.slice(index + 1), precedingOperator: segment.precedingOperator };
  }
  return { name: 'wrapper-depth-exceeded', args: [], precedingOperator: segment.precedingOperator };
}

function hasFlag(args, shortName, longName) {
  return args.some((arg) => arg === longName || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).toLowerCase().includes(shortName.toLowerCase())));
}

function commandTargets(args) {
  let optionsEnded = false;
  return args.filter((arg) => {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      return false;
    }
    if (!optionsEnded && arg.startsWith('-')) return false;
    return true;
  });
}

function isProtectedDeleteTarget(value) {
  const normalized = normalizeText(value).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return (
    PROTECTED_DELETE_TARGETS.has(normalized) ||
    /^\/(?:\*|\{[^}]+\})$/.test(normalized) ||
    /^\$(?:\{|)[a-z_][a-z0-9_]*(?:\}|)(?:\/\*)?$/.test(normalized)
  );
}

function matchesBuiltin(context) {
  for (const command of context.commands) {
    if (!command) continue;
    const { name, args } = command;

    if (['sudo', 'su', 'doas', 'pkexec'].includes(name)) {
      return ['PRIVILEGE_ESCALATION', '禁止切换身份或提升权限。'];
    }
    if (FILE_DELETE_COMMANDS.has(name)) {
      return ['FILE_DELETE', '禁止直接删除或清空服务器文件；请先使用备份或移动方式处理。'];
    }
    if (DISK_COMMANDS.has(name) || name.startsWith('mkfs.')) {
      return ['DISK_DESTRUCTIVE', '禁止格式化、分区或销毁磁盘卷。'];
    }
    if (['mount', 'umount', 'swapon', 'swapoff', 'losetup'].includes(name)) {
      return ['DISK_DESTRUCTIVE', '禁止更改主机磁盘挂载或交换空间。'];
    }
    if (POWER_COMMANDS.has(name) || (name === 'init' && args.some((arg) => ['0', '6'].includes(arg)))) {
      return ['SYSTEM_POWER', '禁止关闭或重启整台服务器。'];
    }
    if (IDENTITY_COMMANDS.has(name)) {
      return ['IDENTITY_MODIFY', '禁止修改服务器用户、用户组或认证配置。'];
    }
    if (KERNEL_COMMANDS.has(name) || (name === 'sysctl' && args.includes('-w'))) {
      return ['SYSTEM_SECURITY', '禁止修改内核模块或运行时内核配置。'];
    }
    if (name === 'eval' || name === 'source' || name === '.') {
      return ['SHELL_DYNAMIC_EVAL', '禁止动态解释生成的 Shell 命令。'];
    }
    if (SHELL_NAMES.has(name) && args.some((arg) => /^-[^-]*c/.test(arg))) {
      return ['SHELL_DYNAMIC_EVAL', '禁止通过 Shell -c 执行嵌套命令。'];
    }
    const interpreterFlags = INLINE_INTERPRETERS.get(name);
    if (interpreterFlags && args.some((arg) => interpreterFlags.includes(arg))) {
      return ['SHELL_DYNAMIC_EVAL', '禁止通过解释器参数执行内联代码。'];
    }
    if (name === 'find' && args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg))) {
      return ['INDIRECT_EXECUTION', '禁止通过 find 删除文件或间接执行命令。'];
    }
    if (['xargs', 'parallel'].includes(name)) {
      return ['INDIRECT_EXECUTION', '禁止使用批处理工具间接执行命令。'];
    }
    if (name === 'awk' && /\bsystem\s*\(/i.test(args.join(' '))) {
      return ['INDIRECT_EXECUTION', '禁止通过 awk 间接执行系统命令。'];
    }
    if (name === 'dd' && args.some((arg) => /^of=\/dev\//i.test(arg))) {
      return ['DISK_DESTRUCTIVE', '禁止直接写入块设备。'];
    }
    if (name === 'shred' && args.some((arg) => /^\/dev\//i.test(arg))) {
      return ['DISK_DESTRUCTIVE', '禁止擦除块设备。'];
    }
    if (name === 'tee' && args.some((arg) => /^\/dev\/(?:sd|vd|xvd|nvme|mmcblk)/i.test(arg))) {
      return ['DISK_DESTRUCTIVE', '禁止直接写入块设备。'];
    }
    if (name === 'iptables' && args.some((arg) => ['-F', '--flush', '-X', '--delete-chain'].includes(arg))) {
      return ['SYSTEM_SECURITY', '禁止清空主机防火墙规则。'];
    }
    if (name === 'nft' && normalizeText(args.join(' ')).includes('flush ruleset')) {
      return ['SYSTEM_SECURITY', '禁止清空主机防火墙规则。'];
    }
    if (name === 'ufw' && args.some((arg) => ['disable', 'reset'].includes(arg.toLowerCase()))) {
      return ['SYSTEM_SECURITY', '禁止关闭或重置主机防火墙。'];
    }
    if (name === 'systemctl') {
      const action = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
      const allowed = new Set(['status', 'is-active', 'is-enabled', 'show', 'list-units', 'list-unit-files', 'start', 'stop', 'restart', 'try-restart', 'reload']);
      if (action && !allowed.has(action)) {
        return ['SYSTEMCTL_ACTION', '该 systemctl 操作不在允许的部署动作范围内。'];
      }
    }
    if (name === 'docker' && normalizeText(args.join(' ')).match(/^(?:system|volume) prune(?: |$)/)) {
      return ['SYSTEM_SECURITY', '禁止执行 Docker 全局清理。'];
    }
    if (name === 'crontab' && args.includes('-r')) {
      return ['SYSTEM_SECURITY', '禁止删除整个 crontab。'];
    }
    if (['chown', 'chgrp', 'setfacl', 'setcap'].includes(name)) {
      return ['PERMISSION_ESCALATION', '禁止改变文件所有者、ACL 或 capabilities。'];
    }
    if (name === 'chmod') {
      const mode = commandTargets(args)[0] ?? '';
      if (/^[2-7][0-7]{3,4}$/.test(mode) || /(?:^|,)[aug]*[+=][^,]*s/.test(mode)) {
        return ['PERMISSION_ESCALATION', '禁止设置 setuid 或 setgid 权限。'];
      }
    }
    if (['tee', 'sed', 'cp', 'mv', 'install', 'truncate'].includes(name) && args.some((arg) => SENSITIVE_AUTH_PATH_RE.test(arg))) {
      return ['PROTECTED_PATH', '禁止修改系统认证、SSH 或 sudo 配置文件。'];
    }
    if (SHELL_NAMES.has(name) && command.precedingOperator === '|') {
      return ['SHELL_DYNAMIC_EVAL', '禁止把其他命令的输出直接交给 Shell 执行。'];
    }
    if (PACKAGE_COMMANDS.has(name)) {
      const normalizedArgs = args.map((arg) => arg.toLowerCase());
      const modifies = normalizedArgs.some((arg) => PACKAGE_MODIFY_ACTIONS.has(arg)) ||
        normalizedArgs.some((arg) => /^-(?:i|u|e|r|p)$/i.test(arg));
      if (modifies) return ['PACKAGE_MODIFY', '禁止安装、升级或删除系统软件包。'];
    }
    if (['pkill', 'killall'].includes(name)) {
      return ['PROCESS_KILL', '禁止按名称批量终止进程。'];
    }
    if (name === 'kill') {
      let signal = 'TERM';
      const targets = [];
      for (const arg of args) {
        if (/^-s$/i.test(arg)) continue;
        if (/^-(?:TERM|HUP|USR1|USR2)$/i.test(arg)) signal = arg.slice(1).toUpperCase();
        else if (/^-[A-Za-z0-9]+$/.test(arg)) signal = arg.slice(1).toUpperCase();
        else targets.push(arg);
      }
      const allowedSignals = new Set(['TERM', 'HUP', 'USR1', 'USR2']);
      if (!allowedSignals.has(signal) || !targets.length || targets.some((target) => !/^\d+$/.test(target) || Number(target) <= 1)) {
        return ['PROCESS_KILL', '仅允许向明确的普通进程 PID 发送 TERM、HUP、USR1 或 USR2。'];
      }
    }
    if (name === 'wget') {
      return ['NETWORK_FETCH', '禁止从外部网络直接下载并落盘。'];
    }
    if (name === 'curl') {
      const urls = args.filter((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg));
      const localOnly = urls.length > 0 && urls.every((value) => {
        try {
          const parsed = new URL(value);
          return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
        } catch {
          return false;
        }
      });
      const writesFile = args.some((arg) => ['-o', '-O', '--output', '--remote-name', '-T', '--upload-file'].includes(arg));
      if (!localOnly || writesFile) return ['NETWORK_FETCH', '仅允许 curl 访问本机健康检查地址，且不能上传或写入文件。'];
    }
  }

  for (let index = 0; index < context.tokens.length - 1; index += 1) {
    if (!['>', '>>'].includes(context.tokens[index])) continue;
    const target = context.tokens[index + 1];
    if (/^\/dev\/(?:sd|vd|xvd|nvme|mmcblk)/i.test(target) || SENSITIVE_AUTH_PATH_RE.test(target)) {
      return ['PROTECTED_PATH', '禁止通过重定向写入块设备或认证配置。'];
    }
  }
  return null;
}

export function evaluateCommandPolicy(command, policy = {}) {
  const enabled = policy?.enabled !== false;
  if (!enabled) return { allowed: true, policyVersion: COMMAND_POLICY_VERSION };
  const raw = String(command ?? '');
  const lexed = lexShell(raw);
  const tokens = lexed.tokens;
  const segments = splitSegments(tokens);
  const context = {
    raw,
    tokens,
    segments,
    commands: segments.map(resolveCommand),
    canonical: normalizeText(tokens.join(' ')),
  };

  for (const phrase of (Array.isArray(policy?.customDeny) ? policy.customDeny : [])) {
    const normalized = normalizeText(lexShell(phrase).tokens.join(' '));
    if (normalized && context.canonical.includes(normalized)) {
      const reason = '命令命中了项目自定义阻止短语。';
      return {
        allowed: false,
        ruleId: 'CUSTOM_DENY',
        reason,
        message: reason,
        policyVersion: COMMAND_POLICY_VERSION,
      };
    }
  }

  if (lexed.parseError) {
    const reason = '命令包含无法可靠检查的 Shell 语法。';
    return {
      allowed: false,
      ruleId: 'UNPARSEABLE_SHELL',
      reason,
      message: reason,
      policyVersion: COMMAND_POLICY_VERSION,
    };
  }
  if (/\$\(|`|\$\{|[<>]\(|(?:^|[;&|()\s])\$[A-Za-z_][A-Za-z0-9_]*\b|<<-?/.test(raw)) {
    const reason = '命令包含动态展开、命令替换或 heredoc，无法安全检查。';
    return {
      allowed: false,
      ruleId: 'SHELL_DYNAMIC_EVAL',
      reason,
      message: reason,
      policyVersion: COMMAND_POLICY_VERSION,
    };
  }

  const builtin = matchesBuiltin(context);
  if (builtin) {
    return {
      allowed: false,
      ruleId: builtin[0],
      reason: builtin[1],
      message: builtin[1],
      policyVersion: COMMAND_POLICY_VERSION,
    };
  }

  return { allowed: true, policyVersion: COMMAND_POLICY_VERSION };
}
