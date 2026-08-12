const { app, safeStorage } = require('electron');

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  const encrypted = safeStorage.encryptString('ai-ops-safe-storage-smoke');
  const decrypted = safeStorage.decryptString(encrypted);
  if (decrypted !== 'ai-ops-safe-storage-smoke') throw new Error('safeStorage round trip failed');
  console.log('safeStorage verified');
  app.quit();
});
