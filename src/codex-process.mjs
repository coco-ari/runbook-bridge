import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppError } from './errors.mjs';

const execute = promisify(execFile);
const fail = (code,message) => new AppError(code,message);
export async function resolveCodexExecutable(configured = '') {
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap(dir => names.map(name => path.join(dir,name))),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/codex','/usr/local/bin/codex','/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'] : []),
    path.join(os.homedir(),'.local','bin',names[0]),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const real = await fs.realpath(candidate), info = await fs.stat(real);
      if (!info.isFile()) continue;
      const {stdout} = await execute(real,['--version'],{timeout:10000,maxBuffer:8192,windowsHide:true});
      const version = stdout.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
      if (!version || (+version[1] === 0 && +version[2] < 159)) throw fail('CODEX_VERSION_UNSUPPORTED','需要 Codex CLI 0.159.0 或更新版本，以支持隔离权限配置。');
      return {executable:real,version:version[0]};
    } catch (error) { if (error instanceof AppError) throw error; }
  }
  throw fail('CODEX_NOT_FOUND','未找到可用的 Codex CLI。请安装官方 CLI，或填写可执行文件的绝对路径（Windows 请使用原生 codex.exe）。');
}

// The app-server protocol is newline-delimited JSON. No terminal parsing, shell,
// inherited user config, or raw subprocess errors cross this boundary.
export class CodexProcess extends EventEmitter {
  constructor({executable,cwd,env,spawnImpl = spawn}) {
    super(); this.nextId = 0; this.pending = new Map(); this.buffer = ''; this.closed = false;
    this.child = spawnImpl(executable,['app-server','--listen','stdio://'],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk => this.receive(chunk));
    this.child.stderr.on('data',() => {});
    this.child.stdin.on('error',() => this.finish());
    this.child.on('error',() => this.finish()); this.child.on('exit',() => this.finish());
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8*1024*1024) { this.close(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0,index); this.buffer = this.buffer.slice(index+1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { this.close(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
      if (typeof message.method === 'string') this.emit(message.id === undefined ? 'notification' : 'request',message);
      else if (this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(fail('CODEX_RPC_FAILED','Codex 未能完成请求，请检查登录状态、模型和服务配置。'));
        else entry.resolve(message.result);
      }
    }
  }
  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw fail('CODEX_DISCONNECTED','Codex 进程已断开。');
    const bytes = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(bytes) > 1024*1024 || this.child.stdin.writableLength > 2*1024*1024) throw fail('CODEX_BUSY','Codex 请求队列已满。');
    this.child.stdin.write(bytes);
  }
  request(method,params = {},timeoutMs = 30000) {
    if (this.pending.size >= 64) return Promise.reject(fail('CODEX_BUSY','Codex 请求过多。'));
    const id = ++this.nextId;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('CODEX_TIMEOUT','Codex 响应超时，请重新连接后恢复会话。')); this.close(); },timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.send({id,method,params}); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id,result) { this.send({id,result}); }
  reject(id) { this.send({id,error:{code:-32601,message:'Unsupported by this workspace'}}); }
  async initialize(expectedHome) {
    const result = await this.request('initialize',{clientInfo:{name:'ai_ops_workspace',title:'AI 运维工作台',version:'3.0'},capabilities:{experimentalApi:true}});
    if (!result.codexHome || await fs.realpath(result.codexHome) !== await fs.realpath(expectedHome)) { this.close(); throw fail('CODEX_ISOLATION_FAILED','Codex 状态目录校验失败。'); }
    this.send({method:'initialized'}); return result;
  }
  finish() {
    if (this.closed) return; this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(fail('CODEX_DISCONNECTED','Codex 进程已断开；会话记录已保留。')); }
    this.pending.clear(); this.emit('closed');
  }
  close() {
    this.finish(); this.child.stdin.destroy(); this.child.kill();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); },2000); timer.unref?.();
  }
}
