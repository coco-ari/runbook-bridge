import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../src/errors.mjs';

const unavailable = () => new AppError('OVERLAY_STATUS_UNAVAILABLE', '未能取得本机组网状态。');
const boolean = value => typeof value === 'boolean' ? value : null;

// 凭据只用于本机服务请求头；不返回令牌、节点标识、公钥、地址或原始响应。
export async function probeOverlayPeer({ runtime, files, plugin, scope, owner, measure }) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw unavailable();
  let token;
  try {
    token = (await fs.readFile(path.join(process.env.LOCALAPPDATA, 'ZeroTier', 'authtoken.secret'), 'utf8')).trim();
    if (!token || token.length > 512) throw unavailable();
  } catch { throw unavailable(); }
  let port = 9993;
  try {
    const stored = Number((await fs.readFile('C:/ProgramData/ZeroTier/One/zerotier-one.port', 'utf8')).trim());
    if (Number.isInteger(stored) && stored > 0 && stored <= 65535) port = stored;
  } catch { /* 未提供端口文件时使用本机服务默认端口。 */ }
  const get = async endpoint => {
    try {
      const response = await fetch('http://127.0.0.1:' + port + endpoint, {headers:{'X-ZT1-Auth':token},signal:AbortSignal.timeout(4000),redirect:'error'});
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      let length = 0; const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65536) throw unavailable();
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw unavailable(); }
  };
  try {
    let peerId;
    await measure('overlay.target-public-identity', async () => {
      const value = await runtime.withRemoteReadSession(plugin, reader => reader.readBuffer('/var/lib/zerotier-one/identity.public',0,1024));
      const parsed = /^([a-f0-9]{10}):[0-9]+:[a-f0-9]+$/iu.exec(value.content.toString('utf8').trim());
      if (value.truncated || !parsed) throw new AppError('OVERLAY_IDENTITY_INVALID', '目标公开节点标识不可用。');
      peerId = parsed[1].toLowerCase();
    });
    const sample = async label => {
      const [status, peer] = await Promise.all([get('/status'),get('/peer/' + peerId)]);
      if (peer.address !== peerId || !Array.isArray(peer.paths)) throw unavailable();
      const active = peer.paths.filter(item => item.active === true && item.expired !== true);
      console.log(JSON.stringify({feature:'overlay.peer.' + label,status:'observed',online:boolean(status.online),tcpFallbackActive:boolean(status.tcpFallbackActive),
        paths:peer.paths.length,activePaths:active.length,preferredPaths:active.filter(item => item.preferred === true).length,
        latencyMs:Number.isFinite(peer.latency) && peer.latency >= 0 ? peer.latency : null}));
    };
    for (let index = 0; index < 3; index += 1) {
      await measure('overlay.peer-state.' + index, () => sample('before-' + index));
      await measure('overlay.directory.' + index, async () => {
        let timer;
        try {
          // 保持探针进程直到读取或清理超时结束，断线后的非驻留计时器不能让采样静默退出。
          const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new AppError('OVERLAY_PROBE_TIMEOUT', '目录采样超过时限。')), 130_000); });
          const page = await Promise.race([files.listDirectory(owner, {...scope,path:'/usr/bin',deferLinks:true}), deadline]);
          if (page.entries.length === 0) throw new AppError('DIRECTORY_PROBE_EMPTY', '目录诊断未取得条目。');
        } finally { clearTimeout(timer); }
      });
      await measure('overlay.peer-state-after.' + index, () => sample('after-' + index));
    }
  } finally { token = null; }
}
