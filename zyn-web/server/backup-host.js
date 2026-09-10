'use strict';

const { createCloudBackupManager, __test } = require('../../launcher/cloud-backup');
const { createCloudBackupDataAdapter } = require('../../launcher/cloud-backup-data');
const { createWorkspaceData } = require('./workspace');
const { fileSafeStorage } = require('./license-host');

function createBackupHost({
  store,
  dataDirectory,
  authority,
  safeStorage = fileSafeStorage(),
  logger = console,
} = {}) {
  if (!store || !dataDirectory || !authority) {
    throw new Error('backup host requires store, dataDirectory, and license authority');
  }
  const dataManager = createWorkspaceData(store);
  const backupData = createCloudBackupDataAdapter({
    dataManager,
    taskGroupStore: store.taskGroups,
    dataDirectory,
  });
  const manager = createCloudBackupManager({
    app: {
      getPath: () => dataDirectory,
      getVersion: () => '0.1.0-web',
    },
    safeStorage,
    dataManager: backupData,
    api: authority,
    getAccountId: () => authority.backupAccountId(),
    dialog: null,
    clipboard: null,
    log: logger,
  });

  const importBundle = (bundle, mode = 'merge') => backupData.importAll(bundle, mode === 'replace' ? 'replace' : 'merge');

  return {
    status: () => manager.status(),
    importKey(recoveryKey, expectedFingerprint = '') {
      return manager.importRecoveryKey(recoveryKey, expectedFingerprint);
    },
    list: () => manager.listBackups(),
    preview: (backupId, mode) => manager.preview(backupId, mode),
    restore: (backupId, mode) => manager.restore(backupId, mode),
    importBundle,
    importPayload(payload = {}) {
      const mode = payload.mode === 'replace' ? 'replace' : 'merge';
      if (payload.bundle && typeof payload.bundle === 'object') {
        return importBundle(payload.bundle, mode);
      }
      const encoded = String(payload.rcbBase64 || '').trim();
      if (encoded) {
        const recoveryKey = String(payload.recoveryKey || '').trim();
        if (!recoveryKey) throw new Error('Encrypted backups need the Zyn recovery key.');
        const decrypted = __test.decryptBundle(
          Buffer.from(encoded, 'base64'),
          __test.masterKeyFromRecovery(recoveryKey),
        );
        return importBundle(decrypted.bundle, mode);
      }
      throw new Error('Provide a Zyn export JSON bundle or an encrypted backup.');
    },
  };
}

module.exports = { createBackupHost };
