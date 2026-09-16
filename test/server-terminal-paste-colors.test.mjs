import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TERMINAL_PASTE_COLORS } from '../src/server-terminal-startup.mjs';

function localBash() {
  if (process.platform !== 'win32') return 'bash';
  const located = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const file of (located.stdout ?? '').trim().split(/\r?\n/u)) {
    const candidate = path.resolve(path.dirname(file), '..', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test('真实 Bash 粘贴使用会话高亮，输入保持整段且确认前不执行', { timeout: 10_000 }, async t => {
  const bash = localBash();
  if (!bash) return t.skip('本机没有用于验证的 Bash');
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8', windowsHide: true });
  const match = version.stdout?.match(/version (\d+)\.(\d+)/u);
  if (!match || Number(match[1]) < 5 || (Number(match[1]) === 5 && Number(match[2]) < 2)) return t.skip('本机 Bash 早于支持自定义活动区域颜色的版本');
  // 不加载用户启动配置或输入配置，也不写入命令历史。
  const child = spawn(bash, ['--noprofile', '--norc', '-i'], {
    env: { ...process.env, TERM: 'xterm-256color', INPUTRC: '/dev/null', HISTFILE: '/dev/null', PS1: 'fixture> ' },
    windowsHide: true,
  });
  let output = ''; let failure;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { failure = error; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const until = async predicate => {
    const limit = Date.now() + 4000;
    while (!predicate() && Date.now() < limit && !failure) await delay(20);
    if (failure) throw failure;
    assert.ok(predicate(), 'Bash 未在时限内返回预期状态');
  };
  child.stdin.write(TERMINAL_PASTE_COLORS + "; builtin bind -v; printf 'ready-%s\\n' 1\n");
  await until(() => output.includes('ready-1'));
  assert.ok(output.includes('set enable-bracketed-paste on'));
  const before = output.length;
  child.stdin.write("\x1b[200~printf 'line-%s\\n' one\nprintf 'line-%s\\n' two\x1b[201~");
  await until(() => output.slice(before).includes('two'));
  const pending = output.slice(before);
  assert.ok(pending.includes('\x1b[27;48;5;23;38;5;195m'), '使用深青色背景和浅色前景');
  assert.ok(pending.includes('\x1b[0m'), '活动区域结束后恢复正常显示');
  assert.ok(!pending.includes('line-one') && !pending.includes('line-two'), '等待 Enter 时尚未执行');
  child.stdin.write('\n');
  await until(() => output.includes('line-one') && output.includes('line-two'));
  child.stdin.end('exit\n');
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
});
