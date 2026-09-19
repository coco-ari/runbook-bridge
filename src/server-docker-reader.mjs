import path from 'node:path';
import { AppError } from './errors.mjs';

export const DOCKER_SOCKET_DEFAULT = '/var/run/docker.sock';
const ID = /^[a-f0-9]{64}$/u;
const fail = (code, message) => new AppError(code, message);
const quote = value => `'${String(value).replace(/'/gu, `'"'"'`)}'`;
const invalid = () => fail('INVALID_ARGUMENT', 'Docker 请求参数无效。');

export function normalizeDockerSocket(value) {
  if (value === undefined || value === '') return DOCKER_SOCKET_DEFAULT;
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\u0000-\u0020\u007f]/u.test(value) || value.includes('://')) throw invalid();
  return path.posix.normalize(value);
}

function integer(value, fallback, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw invalid();
  return result;
}

export function dockerRequest(kind, input = {}) {
  if (!['list', 'inspect', 'logs', 'stats'].includes(kind)) throw invalid();
  const allowed = kind === 'list' ? ['cursor', 'limit'] : kind === 'logs' ? ['containerId', 'lines', 'maxBytes', 'since', 'until'] : ['containerId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => input[key] !== undefined && !allowed.includes(key))) throw invalid();
  if (kind === 'list') {
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[a-f0-9-]{36}:\d{1,4}$/u.test(input.cursor))) throw invalid();
    return { kind, limit:integer(input.limit, 50, 200), ...(input.cursor ? { cursor:input.cursor } : {}) };
  }
  if (typeof input.containerId !== 'string' || !ID.test(input.containerId)) throw invalid();
  const args = { kind, containerId:input.containerId };
  if (kind !== 'logs') return args;
  Object.assign(args, { lines:integer(input.lines, 200, 2000), maxBytes:integer(input.maxBytes, 65536, 262144) });
  for (const field of ['since', 'until']) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input[field]) || !Number.isFinite(Date.parse(input[field]))) throw invalid();
    args[field] = new Date(input[field]).toISOString();
  }
  if (args.since && args.until && args.since > args.until) throw invalid();
  return args;
}

const LIST_FORMAT = '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},"project":{{json (.Label "com.docker.compose.project")}},"service":{{json (.Label "com.docker.compose.service")}}}';
// 只读取概览字段，不把容器环境变量、完整标签或健康检查日志带入响应。
const INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"restartCount":{{json .RestartCount}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';

export function dockerCommand(socket, request) {
  const { kind, ...input } = request;
  const args = dockerRequest(kind, input);
  // 显式指定 Unix Socket，并清除能够改变 CLI 目标和 TLS 行为的环境变量。
  const base = 'env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_TLS LC_ALL=C docker --host ' + quote('unix://' + normalizeDockerSocket(socket));
  if (kind === 'list') return base + ' container ls --all --no-trunc --last 1001 --format ' + quote(LIST_FORMAT);
  if (kind === 'inspect') return base + ' container inspect --format ' + quote(INSPECT_FORMAT) + ' ' + quote(args.containerId);
  if (kind === 'stats') return base + ' container stats --no-stream --no-trunc --format ' + quote('{{json .}}') + ' ' + quote(args.containerId);
  return base + ' container logs --timestamps --tail ' + args.lines
    + (args.since ? ' --since ' + quote(args.since) : '') + (args.until ? ' --until ' + quote(args.until) : '') + ' ' + quote(args.containerId);
}

export function readDockerChannel(client, socket, request, { signal, timeoutMs = 10000 } = {}) {
  const command = dockerCommand(socket, request);
  const maxBytes = request.kind === 'logs' ? request.maxBytes : 1048576;
  return new Promise((resolve, reject) => {
    let channel, done = false, size = 0, received = 0, stderrSize = 0, stderrTotal = 0, code = null, truncated = false;
    const chunks = [], errors = [];
    const close = stream => { try { stream?.close(); stream?.destroy(); } catch { /* 通道可能已随连接关闭。 */ } };
    const finish = (error, stop = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      client.removeListener('close', disconnected);
      client.removeListener('error', disconnected);
      if (stop || error) close(channel);
      if (error) reject(error);
      else resolve({ stdout:Buffer.concat(chunks).toString('utf8'), stderr:Buffer.concat(errors).toString('utf8'), exitCode:code, truncated });
    };
    const abort = () => finish(fail('DOCKER_CANCELLED', 'Docker 读取已取消。'));
    const disconnected = () => finish(fail('SSH_NOT_CONNECTED', '服务器连接已断开。'));
    const timer = setTimeout(() => finish(fail('DOCKER_TIMEOUT', 'Docker 读取超时，请稍后重试。')), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once:true });
    client.once('close', disconnected);
    client.once('error', disconnected);
    if (signal?.aborted) { abort(); return; }
    try {
      client.exec(command, { pty:false }, (error, stream) => {
        if (done) { stream?.on('error', () => {}); close(stream); return; }
        if (error || !stream) { finish(fail('DOCKER_UNAVAILABLE', '无法建立 Docker 读取通道。')); return; }
        channel = stream;
        const data = (chunk, stderr) => {
          if (done) return;
          const buffer = Buffer.from(chunk);
          if (stderr && stderrSize < 8192) { const part = buffer.subarray(0, 8192 - stderrSize); errors.push(part); stderrSize += part.length; }
          if (stderr && request.kind !== 'logs') {
            stderrTotal += buffer.length;
            if (stderrTotal > 16384) finish(fail('DOCKER_UNAVAILABLE', 'Docker 返回过多错误信息。'));
            return;
          }
          received += buffer.length;
          const remaining = maxBytes - size;
          if (remaining > 0) { const part = buffer.subarray(0, remaining); chunks.push(part); size += part.length; }
          if (buffer.length > remaining) {
            truncated = true;
            if (request.kind === 'logs') { if (received > Math.max(maxBytes, 8192)) finish(null, true); }
            else if (request.kind === 'list') finish(null, true);
            else finish(fail('DOCKER_OUTPUT_LIMIT', 'Docker 详情超过读取上限。'));
          }
        };
        stream.on('data', chunk => data(chunk, false));
        stream.stderr?.on('data', chunk => data(chunk, true));
        stream.on('error', () => finish(fail('DOCKER_UNAVAILABLE', 'Docker 读取通道已关闭。')));
        stream.stderr?.on('error', () => finish(fail('DOCKER_UNAVAILABLE', 'Docker 读取通道已关闭。')));
        stream.on('exit', value => { code = value; });
        stream.once('close', value => { if (Number.isInteger(value)) code = value; finish(); });
      });
    } catch { finish(fail('DOCKER_UNAVAILABLE', '无法建立 Docker 读取通道。')); }
  });
}

export function parseDockerResult(request, raw) {
  if (raw.exitCode !== 0 && !(raw.truncated && raw.exitCode === null)) {
    const error = raw.stderr ?? '';
    if (/no such (?:container|object)/iu.test(error)) throw fail('DOCKER_CONTAINER_NOT_FOUND', '容器已删除，请刷新列表；同名新容器需要重新打开。');
    if (/permission denied/iu.test(error)) throw fail('DOCKER_PERMISSION_DENIED', '当前 SSH 用户没有 Docker Socket 访问权限。');
    if (/not found|no such file/iu.test(error)) throw fail('DOCKER_NOT_INSTALLED', 'Docker CLI 或指定 Socket 不可用，请检查服务器配置。');
    throw fail('DOCKER_UNAVAILABLE', 'Docker 暂不可用，请检查服务、Socket 或日志驱动。');
  }
  const sampledAt = new Date().toISOString();
  if (request.kind === 'logs') return { content:raw.stdout, truncated:raw.truncated, sampledAt, lines:request.lines, maxBytes:request.maxBytes };
  try {
    let text = raw.stdout;
    if (raw.truncated) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const records = text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    if (request.kind === 'list') {
      if (records.some(item => !ID.test(item.id) || ['name','image','state','status','ports'].some(key => typeof item[key] !== 'string'))) throw new Error();
      return { items:records.slice(0, 1000).map(item => ({ ...item, project:item.project ?? '', service:item.service ?? '' })), truncated:raw.truncated || records.length > 1000, sampledAt };
    }
    if (request.kind === 'inspect') {
      const item = records[0];
      if (records.length !== 1 || item?.id !== request.containerId || typeof item.state !== 'string') throw new Error();
      return { ...item, name:String(item.name).replace(/^\//u, ''), sampledAt };
    }
    const item = records[0];
    if (!item) return { available:false, sampledAt };
    if (records.length !== 1 || item.ID !== request.containerId) throw new Error();
    return { available:true, sampledAt, cpu:String(item.CPUPerc), memory:String(item.MemUsage), memoryPercent:String(item.MemPerc), network:String(item.NetIO), block:String(item.BlockIO), pids:String(item.PIDs) };
  } catch { throw fail('DOCKER_INVALID_OUTPUT', 'Docker 返回格式无法识别，请检查 CLI 版本后重试。'); }
}
