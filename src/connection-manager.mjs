function relevantCredentials(config, secrets) {
  return {
    ...(config.auth.type === 'password' && secrets.password ? { password: secrets.password } : {}),
    ...(config.auth.type === 'privateKey' && secrets.privateKeyPassphrase
      ? { privateKeyPassphrase: secrets.privateKeyPassphrase }
      : {}),
    ...(config.proxy.type !== 'direct' && secrets.proxyPassword
      ? { proxyPassword: secrets.proxyPassword }
      : {}),
  };
}

export class ConnectionManager {
  constructor(projectStore, credentialStore, broker) {
    this.projectStore = projectStore;
    this.credentialStore = credentialStore;
    this.broker = broker;
  }

  async connect(projectId, suppliedSecrets = {}) {
    const config = await this.projectStore.get(projectId);
    let savedSecrets = {};
    if (config.credentials.remember) {
      try {
        savedSecrets = await this.credentialStore.load(projectId, config);
      } catch (error) {
        const replacementProvided = ['password', 'privateKeyPassphrase', 'proxyPassword'].some(
          (key) => suppliedSecrets[key] !== undefined && String(suppliedSecrets[key]) !== '',
        );
        if (!replacementProvided) throw error;
      }
    }
    const secrets = { ...savedSecrets };
    for (const key of ['password', 'privateKeyPassphrase', 'proxyPassword', 'acceptHostKey']) {
      if (suppliedSecrets[key] !== undefined && String(suppliedSecrets[key]) !== '') {
        secrets[key] = String(suppliedSecrets[key]);
      }
    }
    const connection = await this.broker.connect(projectId, secrets);
    try {
      if (config.credentials.remember) {
        await this.credentialStore.save(projectId, relevantCredentials(config, secrets), config);
      } else {
        await this.credentialStore.clear(projectId);
      }
    } catch (error) {
      await this.broker.disconnect(projectId, 'credential-save-failed');
      throw error;
    }
    return connection;
  }
}
