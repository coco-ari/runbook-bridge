import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createTerminalCommandAudit, summarizeTerminalCommand } from '../src/server-terminal-audit.mjs';

test('命令摘要保留常见动作与资源，隐藏脚本和凭据参数', () => {
  assert.equal(summarizeTerminalCommand('ls -lah /var/log'),'ls -lah /var/log');
  assert.equal(summarizeTerminalCommand('systemctl restart fixture.service'),'systemctl restart fixture.service');
  for (const command of ['systemctl restart --password fixture-private','docker login --password fixture-private','systemctl set-environment TOKEN=fixture-private','mysql -pfixture-private','curl -H "Authorization: Bearer fixture-private" https://example.invalid','echo fixture-private','bash -c "echo fixture-private"','fixture-private','TOKEN=fixture-private ls']) {
    assert.doesNotMatch(summarizeTerminalCommand(command),/fixture-private/u);
  }
});

test('终端执行帧支持跨块，普通输出和密码输入不成为命令记录', () => {
  const entries = [];
  const audit = createTerminalCommandAudit(entry => entries.push(entry));
  const token = audit.command.match(/runbook-command:([a-f0-9]{32})/u)[1];
  const frame = (id,code,text) => Buffer.from('\x1b]runbook-command:' + token + ':' + id + ':' + code + ':' + Buffer.from(text).toString('hex') + '\x07');
  audit.consume(frame(1,0,'初始化'));
  audit.noteInput(Buffer.from('sudo systemctl restart fixture.service\r'));
  assert.equal(audit.consume(Buffer.from('Password: ')).toString(),'Password: ');
  audit.noteInput(Buffer.from('fixture-private\r'));
  assert.equal(entries.length,0);
  const data = Buffer.concat([Buffer.from('输出'),frame(2,1,'sudo systemctl restart fixture.service'),Buffer.from('提示符')]);
  const output = [];
  for (const byte of data) output.push(audit.consume(Buffer.from([byte])));
  assert.equal(Buffer.concat(output).toString(),'输出提示符');
  assert.equal(entries.length,1);
  assert.equal(entries[0].summary,'sudo systemctl restart fixture.service');
  assert.equal(entries[0].exitCode,1);
  assert.doesNotMatch(JSON.stringify(entries),/fixture-private/u);
  audit.consume(frame(2,1,'sudo systemctl restart fixture.service'));
  assert.equal(entries.length,1);
  audit.consume(Buffer.from('\x1b]runbook-command:other:3:0:6c73\x07'));
  assert.equal(entries.length,1);
});

function localBash() {
  if (process.platform !== 'win32') return 'bash';
  const located = spawnSync('where.exe',['git'],{encoding:'utf8',windowsHide:true});
  for (const file of (located.stdout ?? '').trim().split(/\r?\n/u)) {
    const candidate = path.resolve(path.dirname(file),'..','bin','bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test('真实 Bash 记录每条完成命令并保留原提示钩子与退出码', {timeout:15000}, async t => {
  const bash = localBash();
  if (!bash) return t.skip('本机未安装可用于验证的 Bash');
  const entries = [];
  const audit = createTerminalCommandAudit(entry => entries.push(entry));
  const child = spawn(bash,['--noprofile','--norc','-i'],{
    env:{...process.env,TERM:'dumb',INPUTRC:'/dev/null',HISTFILE:'/dev/null',HISTCONTROL:'',PS1:'fixture> '},windowsHide:true,
  });
  let output = '';
  child.stdout.on('data',chunk => { output += audit.consume(chunk); });
  child.stderr.on('data',chunk => { output += audit.consume(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const until = async predicate => {
    const end = Date.now()+5000;
    while (!predicate() && Date.now()<end) await delay(20);
    assert.ok(predicate(),'Bash 未返回预期的执行记录');
  };
  child.stdin.write("PROMPT_COMMAND='printf existing-prompt'; " + audit.command + '\n');
  await until(() => audit.available);
  assert.ok(output.includes('existing-prompt'));
  audit.noteInput(Buffer.from('pwd\nfalse\necho fixture-private\n'));
  child.stdin.write('pwd\nfalse\necho fixture-private\n');
  await until(() => entries.length >= 3);
  assert.deepEqual(entries.slice(0,3).map(entry => [entry.summary,entry.exitCode]),[['pwd',0],['false',1],['echo [参数已隐藏]',0]]);
  assert.doesNotMatch(JSON.stringify(entries),/fixture-private/u);
  child.stdin.end('exit\n');
});
