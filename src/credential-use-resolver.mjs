import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { getPluginConnectionAdapter } from './plugin-connection-adapters.mjs';

const GRANT_PURPOSES = new Set([
  'tls-probe',
  'server-auth',
  'resource-discovery',
  'resource-access',
  'health-check',
]);

function credentialIntentMode(intent) {
  const mode = typeof intent === 'string'
    ? intent
    : intent?.mutation ?? intent?.mode ?? 'unchanged';
  if (['unchanged','none','replace','rebind-existing','clear-explicit'].includes(mode)) return mode;
  throw new AppError('INVALID_ARGUMENT', '凭据使用意图无效。');
}

function nonEmptySecrets(vault, plugin, temporarySecrets) {
  if (typeof vault?.normalizeSecrets === 'function') {
    return vault.normalizeSecrets(plugin,temporarySecrets ?? {});
  }
  return Object.fromEntries(
    Object.entries(temporarySecrets ?? {})
      .map(([key,value]) => [key,String(value ?? '')])
      .filter(([,value]) => value.length > 0),
  );
}

function sameIdentity(adapter, committedPlugin, draft) {
  return JSON.stringify(adapter.credentialIdentity(committedPlugin))
    === JSON.stringify(adapter.credentialIdentity(draft));
}

function assertMainCaller(caller) {
  if (caller !== 'main') {
    throw new AppError('CREDENTIAL_ACCESS_DENIED', '凭据只能由受信任的主进程运行时使用。');
  }
}

export class CredentialUseResolver {
  constructor(credentialVault, {now = Date.now} = {}) {
    this.credentialVault = credentialVault;
    this.now = now;
    this.grants = new Map();
  }

  createOneTimeGrant({
    editSessionId,
    draftGeneration,
    purpose,
    draft,
    ttlMs = 60_000,
  } = {}) {
    if (!String(editSessionId ?? '') || !Number.isInteger(draftGeneration)
      || !GRANT_PURPOSES.has(purpose) || !draft?.pluginType) {
      throw new AppError('INVALID_ARGUMENT', '一次性凭据授权范围无效。');
    }
    const adapter = getPluginConnectionAdapter(draft.pluginType);
    const grantId = crypto.randomUUID();
    const createdAt = this.now();
    const expiresAt = createdAt + Math.min(Math.max(Number(ttlMs) || 0,1),5 * 60_000);
    const record = {
      grantId,
      editSessionId:String(editSessionId),
      draftGeneration,
      purpose,
      pluginType:draft.pluginType,
      targetDigest:adapter.validationDigest(draft,purpose),
      createdAt,
      expiresAt,
    };
    this.grants.set(grantId,record);
    return {...record};
  }

  revokeGrant(grantOrId) {
    const grantId = typeof grantOrId === 'string' ? grantOrId : grantOrId?.grantId;
    return grantId ? this.grants.delete(grantId) : false;
  }

  revokeSession(editSessionId) {
    let revoked = 0;
    for (const [grantId,grant] of this.grants) {
      if (grant.editSessionId === String(editSessionId) && this.grants.delete(grantId)) revoked += 1;
    }
    return revoked;
  }

  consumeGrant({
    oneTimeGrant,
    editSessionId,
    draftGeneration,
    purpose,
    draft,
  }) {
    const grantId = typeof oneTimeGrant === 'string' ? oneTimeGrant : oneTimeGrant?.grantId;
    const grant = grantId ? this.grants.get(grantId) : null;
    if (grantId) this.grants.delete(grantId);
    const adapter = getPluginConnectionAdapter(draft.pluginType);
    const digest = adapter.validationDigest(draft,purpose);
    if (!grant
      || grant.expiresAt <= this.now()
      || grant.editSessionId !== String(editSessionId ?? '')
      || grant.draftGeneration !== draftGeneration
      || grant.purpose !== purpose
      || grant.pluginType !== draft.pluginType
      || grant.targetDigest !== digest) {
      throw new AppError(
        'CREDENTIAL_GRANT_INVALID',
        '一次性凭据授权已过期或不属于当前编辑与验证请求。',
      );
    }
    return grant;
  }

  async loadCommitted(committedPlugin, source) {
    if (!committedPlugin) {
      throw new AppError('CREDENTIAL_NOT_FOUND', '当前插件没有可复用的已保存凭据。');
    }
    const secrets = await this.credentialVault.load(committedPlugin) ?? {};
    return {source,secrets:{...secrets}};
  }

  async resolve({
    committedPlugin = null,
    draft,
    credentialIntent = 'unchanged',
    temporarySecrets = {},
    oneTimeGrant = null,
    editSessionId = null,
    draftGeneration = null,
    purpose,
    caller,
  } = {}) {
    assertMainCaller(caller);
    if (!draft?.pluginType || !GRANT_PURPOSES.has(purpose)) {
      throw new AppError('INVALID_ARGUMENT', '凭据解析目标或用途无效。');
    }
    const adapter = getPluginConnectionAdapter(draft.pluginType);
    if (committedPlugin && committedPlugin.pluginType !== draft.pluginType) {
      throw new AppError('INVALID_ARGUMENT', '不能跨插件类型复用凭据。');
    }
    const mode = credentialIntentMode(credentialIntent);
    const replacements = nonEmptySecrets(this.credentialVault,draft,temporarySecrets);
    if (Object.keys(replacements).length > 0) {
      return {source:'temporary',secrets:{...replacements}};
    }
    if (mode === 'clear-explicit') return {source:'cleared',secrets:{}};
    if (!committedPlugin) return {source:'none',secrets:{}};
    if (sameIdentity(adapter,committedPlugin,draft)) {
      return this.loadCommitted(committedPlugin,'saved');
    }
    if (mode === 'rebind-existing') {
      return this.loadCommitted(committedPlugin,'rebound');
    }
    if (oneTimeGrant) {
      this.consumeGrant({oneTimeGrant,editSessionId,draftGeneration,purpose,draft});
      return this.loadCommitted(committedPlugin,'one-time-grant');
    }
    throw new AppError(
      'CREDENTIAL_REBIND_REQUIRED',
      '连接目标、账号或安全路径已经变化。请选择新密码、明确沿用已保存凭据，或授予本次验证使用权。',
      {purpose},
    );
  }
}

export const credentialUseResolverInternals = {
  credentialIntentMode,
  nonEmptySecrets,
  sameIdentity,
};
