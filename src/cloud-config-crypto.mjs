import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

export const CLOUD_MAX_BYTES = 20 * 1024 * 1024;
export const CLOUD_KDF = Object.freeze({ name:'scrypt', N:131072, r:8, p:1 });
const scrypt = promisify(crypto.scrypt);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const cloudError = (code, message) => new AppError(`CLOUD_${code}`, message);
export const cloudHash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function cloudId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw cloudError('FORMAT_INVALID','云配置标识无效。');
  return value;
}
function bytes(value, length) {
  if (typeof value !== 'string' || value.length > CLOUD_MAX_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw cloudError('FORMAT_INVALID','云配置编码无效。');
  const result = Buffer.from(value,'base64');
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw cloudError('FORMAT_INVALID','云配置编码无效。');
  return result;
}
export function validateCloudMeta(meta) {
  if (meta?.schemaVersion !== 1 || !meta.kdf || Object.keys(meta.kdf).length !== 4 || Object.entries(CLOUD_KDF).some(([key,value]) => meta.kdf[key] !== value)) throw cloudError('FORMAT_UNSUPPORTED','不支持此云仓库格式或密钥派生参数。');
  return {schemaVersion:1,repoId:cloudId(meta.repoId),salt:bytes(meta.salt,32).toString('base64'),kdf:{...CLOUD_KDF}};
}
export function newCloudMeta() {
  return {schemaVersion:1,repoId:crypto.randomUUID(),salt:crypto.randomBytes(32).toString('base64'),kdf:{...CLOUD_KDF}};
}
export async function deriveCloudKeys(password, metadata) {
  const meta = validateCloudMeta(metadata);
  if (typeof password !== 'string' || [...password].length < 16 || Buffer.byteLength(password) > 1024) throw cloudError('PASSWORD_INVALID','仓库密码至少需要 16 个字符，且不能超过 1024 字节。');
  const root = await scrypt(password,Buffer.from(meta.salt,'base64'),32,{N:CLOUD_KDF.N,r:8,p:1,maxmem:256*1024*1024});
  try {
    const derive = purpose => Buffer.from(crypto.hkdfSync('sha256',root,Buffer.from(meta.repoId),`runbook-bridge/cloud/v1/${purpose}`,32));
    return {auth:derive('access').toString('base64url'),encryption:derive('encryption')};
  } finally { root.fill(0); }
}
function header(envelope) {
  if (envelope?.schemaVersion !== 1) throw cloudError('FORMAT_UNSUPPORTED','不支持此云快照格式。');
  return {schemaVersion:1,repoId:cloudId(envelope.repoId),snapshotId:cloudId(envelope.snapshotId),parentId:envelope.parentId === null ? null : cloudId(envelope.parentId)};
}
export function validateCloudEnvelope(envelope) {
  const value = {...header(envelope),nonce:bytes(envelope.nonce,12).toString('base64'),tag:bytes(envelope.tag,16).toString('base64'),ciphertext:bytes(envelope.ciphertext).toString('base64')};
  if (Buffer.byteLength(JSON.stringify(value)) > CLOUD_MAX_BYTES) throw cloudError('TOO_LARGE','云快照超过 20 MiB 限制。');
  return value;
}
export function encryptCloudSnapshot(payload, meta, key, parentId = null) {
  const envelope = {schemaVersion:1,repoId:meta.repoId,snapshotId:crypto.randomUUID(),parentId};
  const plaintext = Buffer.from(JSON.stringify(payload));
  try {
    if (plaintext.length > CLOUD_MAX_BYTES) throw cloudError('TOO_LARGE','云配置内容过大。');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
    cipher.setAAD(Buffer.from(JSON.stringify(header(envelope))));
    const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
    return validateCloudEnvelope({...envelope,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
  } finally { plaintext.fill(0); }
}
export function decryptCloudSnapshot(input, meta, key) {
  const envelope = validateCloudEnvelope(input);
  if (envelope.repoId !== meta.repoId) throw cloudError('SCOPE_MISMATCH','云快照不属于当前仓库。');
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'),{authTagLength:16});
    decipher.setAAD(Buffer.from(JSON.stringify(header(envelope))));
    decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch { throw cloudError('DECRYPT_FAILED','云配置解密或完整性校验失败。'); }
  finally { plaintext?.fill(0); }
}
