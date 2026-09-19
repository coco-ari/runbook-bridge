import { CLOUD_MAX_BYTES, cloudError, cloudId, validateCloudMeta } from './cloud-config-crypto.mjs';

function allowsInternalHttp(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export class CloudConfigClient {
  constructor({fetchImpl = globalThis.fetch} = {}) {
    this.fetch = fetchImpl;
  }
  origin(value) {
    let url;
    try { url = new URL(value); } catch { throw cloudError('URL_INVALID','请输入有效的仓库链接。'); }
    const internalHttp = url.protocol === 'http:' && allowsInternalHttp(url.hostname);
    if ((url.protocol !== 'https:' && !internalHttp) || url.username || url.password || url.search || url.hash) throw cloudError('URL_INVALID','公网仓库必须使用 HTTPS；HTTP 仅支持内网 IPv4 地址或回环地址，且链接不能包含凭证或附加参数。');
    return url;
  }
  repository(value) {
    const url = this.origin(value);
    const match = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw cloudError('URL_INVALID','仓库链接应包含协议、服务地址和 /r/仓库标识。');
    return {origin:url.origin,repoId:cloudId(match[1]),url:`${url.origin}/r/${match[1]}`};
  }
  async request(origin,route,{method = 'GET',token,body,parentId} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),30_000);
    try {
      const text = body === undefined ? undefined : JSON.stringify(body);
      if (text && Buffer.byteLength(text) > CLOUD_MAX_BYTES) throw cloudError('TOO_LARGE','云快照超过 20 MiB 限制。');
      const response = await this.fetch(`${origin}${route}`,{method,redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(text ? {'Content-Type':'application/json'} : {}),...(token ? {Authorization:`Bearer ${token}`} : {}),...(parentId !== undefined ? {'If-Match':parentId ?? 'empty'} : {})},body:text});
      const fail = {
        401:['AUTH_FAILED','仓库密码或管理员令牌错误。'],403:['AUTH_FAILED','无权访问此仓库。'],404:['NOT_FOUND','仓库或历史版本不存在。'],409:['CONFLICT','云端已更新，请重新预览后再上传。'],413:['TOO_LARGE','云快照超过服务端限制。'],429:['RATE_LIMITED','请求过于频繁，请稍后重试。'],
      };
      if (!response.ok) { await response.body?.cancel(); const [code,message] = fail[response.status] ?? ['SERVER_ERROR','云服务请求失败，请稍后重试。']; throw cloudError(code,message); }
      if (Number(response.headers.get('content-length')) > CLOUD_MAX_BYTES) throw cloudError('TOO_LARGE','云服务返回内容过大。');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > CLOUD_MAX_BYTES) { controller.abort(); throw cloudError('TOO_LARGE','云服务返回内容过大。'); }
        chunks.push(Buffer.from(chunk));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw cloudError('FORMAT_INVALID','云服务返回格式无效。'); }
    } catch (error) {
      if (error?.code?.startsWith('CLOUD_')) throw error;
      throw cloudError('NETWORK_FAILED','无法连接云仓库，请检查网络、HTTPS 证书和服务地址。');
    } finally { clearTimeout(timer); }
  }
  async metadata(repositoryUrl) {
    const location = this.repository(repositoryUrl);
    const metadata = validateCloudMeta(await this.request(location.origin,`/api/v1/repos/${location.repoId}/meta`));
    if (metadata.repoId !== location.repoId) throw cloudError('SCOPE_MISMATCH','云仓库标识与链接不一致。');
    return {...location,metadata};
  }
  call(session,route,options = {}) {
    return this.request(session.origin,`/api/v1/repos/${session.repoId}/${route}`,{...options,token:session.keys.auth});
  }
}
