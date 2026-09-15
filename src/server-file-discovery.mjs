import { AppError } from './errors.mjs';
import { BoundedReadCache } from './bounded-read-cache.mjs';
import { normalizeRemotePath, namePattern, globMatches, withinRoot } from './server-read-utils.mjs';

export class ServerFileDiscovery {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.cache = new BoundedReadCache({ now, ttlMs:15_000 });
  }

  async find(reader, { path:remotePath, pattern = '*', maxDepth = 6, maxResults = 500, acceptsFile = null, cacheScope = null, rootIdentity = null, refresh = false, timeBudgetMs = 20_000 } = {}) {
    if (typeof refresh !== 'boolean') throw new AppError('INVALID_ARGUMENT','refresh 必须是布尔值。');
    const root = normalizeRemotePath(remotePath);
    const filter = namePattern(pattern);
    const depthLimit = Math.min(Math.max(Number(maxDepth) || 0, 0), 12);
    const resultLimit = Math.min(Math.max(Number(maxResults) || 500, 1), 1000);
    const queue = [{path:root,depth:0}];
    const files = [];
    const skipped = [];
    const deadline = this.now() + timeBudgetMs;
    let directories = 0;
    let entriesRead = 0;
    let cacheHits = 0;
    let truncated = false;
    const list = async current => {
      try {
        let identity;
        if (reader.statPath && cacheScope) {
          identity = current.depth === 0 && rootIdentity ? rootIdentity : await reader.statPath(current.path);
          if (identity.type !== 'directory' || (identity.canonicalPath ?? identity.path) !== current.path) throw new AppError('SOURCE_NOT_ALLOWED','目录已经变化或包含符号链接，已停止遍历。');
        }
        const load = async () => {
          const entries = await reader.listDirectory(current.path);
          return {entries:[...entries],truncated:Boolean(entries.truncated)};
        };
        const result = identity
          ? await this.cache.read(JSON.stringify([cacheScope,reader.generation,current.path,identity.size,identity.mtime]),load,{refresh})
          : {value:await load(),hit:false};
        if (result.hit) cacheHits += 1;
        return {current,...result.value,cached:result.hit};
      } catch (error) {
        if (current.depth === 0 || error?.code !== 'SOURCE_NOT_FOUND') throw error;
        skipped.push({path:current.path,code:error.code});
        return {current,entries:[],truncated:true};
      }
    };
    while (queue.length && files.length < resultLimit && directories < 200 && entriesRead < 10_000 && this.now() < deadline) {
      const listed = await Promise.all(queue.splice(0,Math.min(2,queue.length,200-directories)).map(list));
      for (const {current,entries,truncated:limited,cached} of listed) {
        truncated ||= limited;
        directories += 1;
        for (const entry of entries) {
          if (files.length >= resultLimit || entriesRead >= 10_000) { truncated = true; break; }
          entriesRead += 1;
          if (entry.canonicalPath && !withinRoot(root,entry.canonicalPath) && !entry.isSymbolicLink) throw new AppError('SOURCE_NOT_ALLOWED','目录条目超出搜索根目录。');
          if (entry.isFile && !entry.isSymbolicLink && entry.canonicalPath && globMatches(filter,entry.name) && (!acceptsFile || acceptsFile(entry))) {
            files.push({path:entry.canonicalPath,name:entry.name,size:entry.size,mtime:entry.mtime,...(cached ? {fromCachedListing:true} : {})});
          }
          if (entry.isDirectory && !entry.isSymbolicLink && current.depth < depthLimit && entry.canonicalPath) queue.push({path:entry.canonicalPath,depth:current.depth+1});
        }
      }
    }
    truncated ||= queue.length > 0 || files.length >= resultLimit || directories >= 200 || entriesRead >= 10_000;
    return {
      root,pattern:filter,files,truncated,skipped,
      remainingDirectories:queue.slice(0,32).map(entry => ({path:entry.path,maxDepth:Math.max(0,depthLimit-entry.depth)})),
      scanned:{directories,entries:entriesRead},cache:{hits:cacheHits},
      limitsApplied:{maxDepth:depthLimit,maxResults:resultLimit,maxDirectories:200,maxEntries:10_000,timeBudgetMs},
    };
  }
}
