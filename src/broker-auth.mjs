import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function rotateBrokerToken(dataRoot) {
  await fs.mkdir(dataRoot, { recursive: true });
  return writeNewBrokerToken(path.join(dataRoot, 'broker.token'));
}

async function writeNewBrokerToken(tokenPath) {
  const token = crypto.randomBytes(32).toString('base64url');
  const temp = `${tokenPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, tokenPath);
    return token;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readBrokerToken(dataRoot) {
  return (await fs.readFile(path.join(dataRoot, 'broker.token'), 'utf8')).trim();
}
