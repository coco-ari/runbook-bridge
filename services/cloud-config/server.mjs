import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CLOUD_MAX_BYTES, cloudHash, cloudId, validateCloudMeta, validateCloudEnvelope } from '../../src/cloud-config-crypto.mjs';

function reject(status, code) { throw Object.assign(new Error(code),{status,code}); }
function matches(actual, expected) {
  const a = Buffer.from(cloudHash(actual ?? ''));
  const b = Buffer.from(cloudHash(expected ?? ''));
  return crypto.timingSafeEqual(a,b);
}
async function body(request) {
  if (Number(request.headers['content-length']) > CLOUD_MAX_BYTES) reject(413,'CLOUD_TOO_LARGE');
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > CLOUD_MAX_BYTES) reject(413,'CLOUD_TOO_LARGE');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { reject(400,'CLOUD_FORMAT_INVALID'); }
}

export function createCloudServer({database = ':memory:',adminToken,retention = 20,now = Date.now} = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('管理员令牌至少需要 32 个字符。');
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, auth_hash TEXT NOT NULL, head TEXT);
    CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, repo TEXT NOT NULL REFERENCES repositories(id), parent TEXT, envelope TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshots_repo ON snapshots(repo,sequence);`);
  const buckets = new Map();
  const send = (response,status,value) => {
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request,response) => {
    try {
      const tick = now();
      for (const [key,value] of buckets) if (value.expires <= tick) buckets.delete(key);
      const ip = request.socket.remoteAddress ?? 'unknown';
      const bucket = buckets.get(ip) ?? {count:0,failures:0,expires:tick+60_000};
      if (buckets.size >= 10_000 && !buckets.has(ip)) reject(429,'CLOUD_RATE_LIMITED');
      buckets.set(ip,bucket);
      if (++bucket.count > 180 || bucket.failures >= 20) reject(429,'CLOUD_RATE_LIMITED');
      const url = new URL(request.url,'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') return send(response,200,{ok:true});
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
      if (request.method === 'POST' && url.pathname === '/api/v1/repos') {
        if (!matches(token,adminToken)) { bucket.failures++; reject(401,'CLOUD_AUTH_FAILED'); }
        const input = await body(request);
        const meta = validateCloudMeta(input.metadata);
        if (!/^[a-f0-9]{64}$/.test(input.authHash ?? '')) reject(400,'CLOUD_FORMAT_INVALID');
        if (db.prepare('SELECT id FROM repositories WHERE id=?').get(meta.repoId)) reject(409,'CLOUD_CONFLICT');
        db.prepare('INSERT INTO repositories (id,metadata,auth_hash) VALUES (?,?,?)').run(meta.repoId,JSON.stringify(meta),input.authHash);
        return send(response,201,meta);
      }
      const route = /^\/api\/v1\/repos\/([^/]+)\/(meta|head|versions|snapshots(?:\/[^/]+)?)$/.exec(url.pathname);
      if (!route) reject(404,'CLOUD_NOT_FOUND');
      const repoId = cloudId(route[1]);
      const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId);
      if (!repo) reject(404,'CLOUD_NOT_FOUND');
      if (request.method === 'GET' && route[2] === 'meta') return send(response,200,JSON.parse(repo.metadata));
      if (!token || !matches(cloudHash(token),repo.auth_hash)) { bucket.failures++; reject(401,'CLOUD_AUTH_FAILED'); }
      if (request.method === 'GET' && route[2] === 'head') return send(response,200,{snapshotId:repo.head});
      if (request.method === 'GET' && route[2] === 'versions') {
        return send(response,200,{versions:db.prepare('SELECT id AS snapshotId, created_at AS createdAt, length(envelope) AS bytes FROM snapshots WHERE repo=? ORDER BY sequence DESC').all(repoId)});
      }
      if (request.method === 'GET' && route[2].startsWith('snapshots/')) {
        const row = db.prepare('SELECT envelope FROM snapshots WHERE id=? AND repo=?').get(cloudId(route[2].split('/')[1]),repoId);
        if (!row) reject(404,'CLOUD_NOT_FOUND');
        return send(response,200,JSON.parse(row.envelope));
      }
      if (request.method === 'POST' && route[2] === 'snapshots') {
        const envelope = validateCloudEnvelope(await body(request));
        if (envelope.repoId !== repoId) reject(400,'CLOUD_SCOPE_MISMATCH');
        const expected = request.headers['if-match'];
        if (expected !== (repo.head ?? 'empty') || envelope.parentId !== repo.head) reject(409,'CLOUD_CONFLICT');
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT head FROM repositories WHERE id=?').get(repoId);
          if (current.head !== repo.head) reject(409,'CLOUD_CONFLICT');
          if (db.prepare('SELECT id FROM snapshots WHERE id=?').get(envelope.snapshotId)) reject(409,'CLOUD_CONFLICT');
          const sequence = db.prepare('SELECT coalesce(max(sequence),0)+1 AS next FROM snapshots WHERE repo=?').get(repoId).next;
          db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?)').run(envelope.snapshotId,repoId,repo.head,JSON.stringify(envelope),new Date(tick).toISOString(),sequence);
          db.prepare('UPDATE repositories SET head=? WHERE id=?').run(envelope.snapshotId,repoId);
          db.prepare('DELETE FROM snapshots WHERE repo=? AND id NOT IN (SELECT id FROM snapshots WHERE repo=? ORDER BY sequence DESC LIMIT ?)').run(repoId,repoId,retention);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return send(response,201,{snapshotId:envelope.snapshotId});
      }
      reject(405,'CLOUD_METHOD_NOT_ALLOWED');
    } catch (error) {
      // 不将请求、凭证、数据库错误或正文写入响应和日志。
      const code = typeof error.code === 'string' && /^CLOUD_[A-Z_]+$/.test(error.code) ? error.code : 'CLOUD_SERVER_ERROR';
      if (!response.headersSent) send(response,error.status ?? (code === 'CLOUD_SERVER_ERROR' ? 500 : 400),{error:{code}});
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('close',() => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.env.CLOUD_DATA_DIR ?? '/data';
  await fs.mkdir(directory,{recursive:true});
  const adminToken = (await fs.readFile(process.env.CLOUD_ADMIN_TOKEN_FILE ?? '/run/secrets/cloud_admin_token','utf8')).trim();
  createCloudServer({database:path.join(directory,'cloud.sqlite'),adminToken}).listen(Number(process.env.PORT ?? 3000),'0.0.0.0');
}
