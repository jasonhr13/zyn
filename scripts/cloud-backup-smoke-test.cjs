'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  createCloudBackupManager,
  DEFAULT_INTERVAL_MS,
  MAX_ENVELOPE_BYTES,
  __test,
} = require('../launcher/cloud-backup');

const SECRET = 'card-4111111111111111-and-mailbox-password';
const BACKUP_ID = '22222222-2222-4222-8222-222222222222';
const RESTORE_BACKUP_ID = '55555555-5555-4555-8555-555555555555';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_C = '44444444-4444-4444-8444-444444444444';
const ACCOUNT_D = '66666666-6666-4666-8666-666666666666';
const bundle = {
  app: 'secret-lair-bot',
  kind: 'settings-export',
  version: 2,
  exportedAt: 1_786_461_600_000,
  tasks: [],
  targetTasks: { skus: '', tasks: [] },
  round1Profiles: [],
  watchlist: '',
  profiles: [{ id: 'profile-1', cardNumber: SECRET }],
  accounts: [{ email: 'user@example.com', password: 'site-password' }],
  proxies: { lists: [{ name: 'Local', raw: '127.0.0.1:8080:user:pass' }] },
  taskGroups: [{ id: 'group-1', name: 'Target', tasks: [] }],
  settings: { aycdApiKey: 'private-api-key' },
  lastOrders: {},
};

function legacyV1Envelope(value, masterKey) {
  // Independent implementation of the original rCart v1 format. This fixture makes accidental
  // changes to the legacy magic, HKDF context, header AAD, gzip order, nonce, or tag layout fail.
  const backupId = BACKUP_ID;
  const createdAt = bundle.exportedAt;
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const nonce = Buffer.from('00112233445566778899aabb', 'hex');
  const keyFingerprint = crypto.createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
  const header = {
    formatVersion: 1,
    backupId,
    createdAt,
    appVersion: '1.6.91',
    keyFingerprint,
    compression: 'gzip',
    encryption: 'AES-256-GCM',
    salt: salt.toString('base64url'),
    nonce: nonce.toString('base64url'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const derived = Buffer.from(crypto.hkdfSync(
    'sha256', masterKey, salt, Buffer.from(`rcart-cloud-backup/v1/${backupId}`), 32,
  ));
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, nonce);
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([
    cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 })),
    cipher.final(),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([
    Buffer.from('RCARTB1\0', 'ascii'), length, headerBytes, ciphertext, cipher.getAuthTag(),
  ]);
}

function backupMetadata(encrypted, overrides = {}) {
  return {
    id: encrypted.header.backupId,
    createdAt: encrypted.header.createdAt,
    clientCreatedAt: encrypted.header.createdAt,
    deviceName: 'Test Computer',
    sizeBytes: encrypted.buffer.length,
    sha256: crypto.createHash('sha256').update(encrypted.buffer).digest('hex'),
    keyFingerprint: encrypted.header.keyFingerprint,
    formatVersion: 1,
    appVersion: encrypted.header.appVersion,
    ...overrides,
  };
}

const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const legacy = legacyV1Envelope(bundle, masterKey);
assert.deepEqual(__test.decryptBundle(legacy, masterKey).bundle, bundle, 'legacy v1 envelope stopped decrypting');
assert.equal(
  __test.recoveryKeyFor(masterKey),
  'RCART1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  'legacy recovery key text changed',
);
assert.deepEqual(
  __test.masterKeyFromRecovery(`Zyn Recovery Key\n\n${__test.recoveryKeyFor(masterKey)}\n\nKeep this safe.`),
  masterKey,
);

const encrypted = __test.encryptBundle(bundle, masterKey, {
  backupId: BACKUP_ID,
  createdAt: bundle.exportedAt,
  appVersion: '1.6.93',
});
assert.equal(encrypted.buffer.subarray(0, 8).toString('ascii'), 'RCARTB1\0');
assert.equal(encrypted.buffer.includes(Buffer.from(SECRET)), false, 'encrypted file leaked plaintext');
assert.deepEqual(__test.decryptBundle(encrypted.buffer, masterKey).bundle, bundle);
assert.throws(
  () => __test.decryptBundle(encrypted.buffer, crypto.randomBytes(32)),
  /does not match/i,
);

const tampered = Buffer.from(encrypted.buffer);
tampered[tampered.length - 20] ^= 1;
assert.throws(() => __test.decryptBundle(tampered, masterKey), /could not be decrypted/i);
assert.throws(
  () => __test.decryptBundle(encrypted.buffer, masterKey, { maxPlainBytes: 64 }),
  /damaged or too large/i,
  'bounded decompression did not reject output over its cap',
);
assert.throws(
  () => __test.encryptBundle({ ...bundle, app: 'not-zyn' }, masterKey),
  /not a Zyn backup/i,
);
assert.throws(
  () => __test.validateBundle({ ...bundle, settings: JSON.parse('{"__proto__":null}') }),
  /unsafe field|invalid settings/i,
);
assert.throws(
  () => __test.parseEnvelope(Buffer.alloc(MAX_ENVELOPE_BYTES + 1)),
  /20 MB cloud limit/i,
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-cloud-backup-'));
let clipboardText = '';
let imported = null;
let exportSerial = 0;
let accountId = ACCOUNT_A;
let lastUploadedId = '';
let omitIntegrityFor = '';
let uploadBlock = null;
let failNextImportPreview = false;
const apiCalls = [];
const statusEvents = [];
const dataEvents = [];
const remoteBackups = new Map();
let timerSets = 0;

const reverse = value => [...String(value)].reverse().join('');
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(reverse(value), 'utf8'),
  decryptString: value => reverse(value.toString('utf8')),
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function storeRemote(envelope, ownerAccountId) {
  const parsed = __test.parseEnvelope(envelope.buffer);
  const record = {
    buffer: Buffer.from(envelope.buffer),
    header: parsed.header,
    ownerAccountId,
  };
  remoteBackups.set(parsed.header.backupId, record);
  return record;
}

function expectedImportPreview(mode) {
  return {
    mode,
    profiles: 1,
    accounts: 1,
    proxyLists: 1,
    taskGroups: {
      total: 1,
      supported: 0,
      skippedUnsupported: 1,
      skippedBySite: { fixture: 1 },
      skippedCapacity: 0,
    },
    warnings: [`${mode} fixture warning`],
  };
}

const manager = createCloudBackupManager({
  app: { getPath: () => tempDir, getVersion: () => '9.9.9' },
  safeStorage: fakeSafeStorage,
  getAccountId: () => accountId,
  dataManager: {
    exportAll: options => {
      assert.equal(options.includePrivateSettings, true);
      exportSerial += 1;
      return { ...bundle, exportedAt: bundle.exportedAt + exportSerial };
    },
    previewImport: (value, mode) => {
      dataEvents.push(`preview:${mode}`);
      assert.equal(value.app, 'secret-lair-bot');
      if (failNextImportPreview) {
        failNextImportPreview = false;
        throw new Error('fixture import preview rejected this backup');
      }
      return expectedImportPreview(mode);
    },
    importAll: (value, mode) => {
      dataEvents.push(`import:${mode}`);
      imported = { value, mode };
      return { profiles: { set: 1 } };
    },
  },
  api: {
    // Authentication belongs to the authority wrapper. The final argument is only the stable
    // account binding captured before the operation starts; no bearer token enters this module.
    uploadBackup: async function uploadBackup(buffer, metadata, expectedAccountId) {
      apiCalls.push({ method: 'upload', arguments: arguments.length, accountId: expectedAccountId });
      assert.ok(Buffer.isBuffer(buffer));
      assert.equal(typeof metadata, 'object');
      assert.match(expectedAccountId, /^[a-f0-9-]{36}$/);
      if (uploadBlock) {
        const block = uploadBlock;
        uploadBlock = null;
        block.started.resolve();
        await block.release.promise;
      }
      const parsed = __test.parseEnvelope(buffer);
      assert.equal(parsed.header.backupId, metadata.backupId);
      const record = storeRemote({ buffer }, expectedAccountId);
      lastUploadedId = record.header.backupId;
      return { ok: true, backup: backupMetadata({ buffer: record.buffer, header: record.header }) };
    },
    listBackups: async function listBackups(expectedAccountId) {
      apiCalls.push({ method: 'list', arguments: arguments.length, accountId: expectedAccountId });
      return {
        ok: true,
        backups: [...remoteBackups.values()]
          .filter(record => record.ownerAccountId === expectedAccountId)
          .map(record => backupMetadata({ buffer: record.buffer, header: record.header })),
      };
    },
    downloadBackup: async function downloadBackup(backupId, expectedAccountId) {
      apiCalls.push({ method: 'download', arguments: arguments.length, accountId: expectedAccountId });
      const record = remoteBackups.get(backupId);
      if (!record || record.ownerAccountId !== expectedAccountId) {
        return { ok: false, message: 'Backup not found.' };
      }
      return {
        ok: true,
        buffer: Buffer.from(record.buffer),
        headers: backupId === omitIntegrityFor ? {} : {
          'x-rcart-backup-sha256': crypto.createHash('sha256').update(record.buffer).digest('hex'),
        },
      };
    },
    deleteBackup: async function deleteBackup(backupId, expectedAccountId) {
      apiCalls.push({ method: 'delete', arguments: arguments.length, accountId: expectedAccountId });
      const record = remoteBackups.get(backupId);
      assert.equal(record && record.ownerAccountId, expectedAccountId);
      remoteBackups.delete(backupId);
      return { ok: true };
    },
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  clipboard: { writeText: value => { clipboardText = value; } },
  log: { warn: () => {} },
  onStatus: status => statusEvents.push(status),
  timers: { setTimeout: () => { timerSets += 1; return timerSets; }, clearTimeout: () => {} },
});

(async () => {
  try {
    assert.deepEqual(
      { accountBound: manager.status().accountBound, hasKey: manager.status().hasKey },
      { accountBound: true, hasKey: false },
    );
    const accountAStatePath = manager.accountStatePath();
    assert.equal(path.basename(accountAStatePath), `${ACCOUNT_A}.json`);
    const setup = manager.setupKey();
    assert.equal(setup.recoveryKey, undefined, 'setup returned the raw stored recovery key');
    const stateText = fs.readFileSync(accountAStatePath, 'utf8');
    assert.equal(JSON.parse(stateText).accountId, ACCOUNT_A);

    await assert.rejects(() => manager.uploadNow(), /Confirm that you saved/i);
    await manager.copyRecoveryKey();
    assert.match(clipboardText, /^RCART1\.[A-Za-z0-9_-]{43}$/);
    const activeRecoveryKey = clipboardText;
    const activeMasterKey = __test.masterKeyFromRecovery(activeRecoveryKey);
    assert.equal(stateText.includes(activeRecoveryKey.slice('RCART1.'.length)), false, 'state leaked recovery key');
    manager.confirmKey(DEFAULT_INTERVAL_MS);
    const timerAfterEnable = timerSets;

    const damagedActiveState = JSON.parse(fs.readFileSync(accountAStatePath, 'utf8'));
    damagedActiveState.keyring[setup.keyFingerprint] = Buffer.from('damaged-active-key').toString('base64');
    fs.writeFileSync(accountAStatePath, `${JSON.stringify(damagedActiveState, null, 2)}\n`);
    assert.equal(manager.status().keyUnavailable, true);
    assert.equal(manager.status().configuredActiveKeyFingerprint, setup.keyFingerprint);
    const repairedActive = manager.importRecoveryKey(activeRecoveryKey, setup.keyFingerprint);
    assert.equal(repairedActive.activeKeyFingerprint, setup.keyFingerprint);
    assert.equal(repairedActive.addedForRestore, false);
    assert.equal(manager.status().keyConfirmed, true, 'repairing the active key reset its confirmation');
    assert.ok(timerSets > timerAfterEnable, 'repairing an enabled active key did not re-arm scheduling');

    const first = await manager.uploadNow({ force: true, reason: 'setup' });
    assert.equal(first.ok, true);
    const firstUploadId = lastUploadedId;
    const firstUpload = remoteBackups.get(firstUploadId);
    assert.ok(firstUpload && firstUpload.buffer.length > 0);
    assert.equal(firstUpload.buffer.includes(Buffer.from(SECRET)), false);
    assert.equal(manager.status().lastBackupBytes, firstUpload.buffer.length);
    assert.equal(firstUpload.header.keyFingerprint, setup.keyFingerprint);

    const skipped = await manager.uploadNow({ force: false, reason: 'automatic' });
    assert.deepEqual({ ok: skipped.ok, skipped: skipped.skipped, reason: skipped.reason }, {
      ok: true, skipped: true, reason: 'unchanged',
    });
    assert.equal(apiCalls.filter(call => call.method === 'upload').length, 1);

    const listed = await manager.listBackups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, firstUploadId);

    const preview = await manager.preview(firstUploadId);
    assert.equal(preview.preview.profiles, 1);
    assert.equal(preview.preview.proxyLists, 1);

    const restoreMasterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
    const restoreFingerprint = __test.keyFingerprint(restoreMasterKey);
    const restoreEnvelope = __test.encryptBundle(
      { ...bundle, exportedAt: bundle.exportedAt + 5000 },
      restoreMasterKey,
      { backupId: RESTORE_BACKUP_ID, createdAt: bundle.exportedAt + 5000, appVersion: '1.6.91' },
    );
    storeRemote(restoreEnvelope, ACCOUNT_A);
    assert.throws(
      () => manager.importRecoveryKey(__test.recoveryKeyFor(restoreMasterKey), 'aaaaaaaaaaaaaaaa'),
      /does not match/i,
    );
    const importedRestoreKey = manager.importRecoveryKey(
      __test.recoveryKeyFor(restoreMasterKey),
      restoreFingerprint,
    );
    assert.equal(importedRestoreKey.activeKeyFingerprint, setup.keyFingerprint);
    assert.equal(importedRestoreKey.addedForRestore, true);
    assert.deepEqual(
      manager.status().keyFingerprints,
      [setup.keyFingerprint, restoreFingerprint].sort(),
    );
    assert.equal(manager.status().keyConfirmed, true, 'restore-key import reset active-key confirmation');

    // Re-import repairs a damaged restore-key slot without rotating the active upload key.
    const damagedState = JSON.parse(fs.readFileSync(accountAStatePath, 'utf8'));
    damagedState.keyring[restoreFingerprint] = Buffer.from('damaged-safe-storage-entry').toString('base64');
    fs.writeFileSync(accountAStatePath, `${JSON.stringify(damagedState, null, 2)}\n`);
    assert.equal(manager.status().keyFingerprints.includes(restoreFingerprint), false);
    manager.importRecoveryKey(__test.recoveryKeyFor(restoreMasterKey), restoreFingerprint);
    assert.equal(manager.status().activeKeyFingerprint, setup.keyFingerprint);
    assert.equal(manager.status().keyFingerprints.includes(restoreFingerprint), true);

    omitIntegrityFor = RESTORE_BACKUP_ID;
    await assert.rejects(
      () => manager.preview(RESTORE_BACKUP_ID),
      /invalid integrity receipt/i,
      'downloads without an authoritative SHA-256 receipt were accepted',
    );
    omitIntegrityFor = '';
    const restorePreview = await manager.preview(RESTORE_BACKUP_ID, 'replace');
    assert.equal(restorePreview.header.keyFingerprint, restoreFingerprint);
    assert.deepEqual(restorePreview.preview, expectedImportPreview('replace'));

    const afterRestoreImport = await manager.uploadNow({ force: true, reason: 'manual' });
    assert.equal(afterRestoreImport.ok, true);
    const afterRestoreImportId = lastUploadedId;
    assert.equal(
      remoteBackups.get(afterRestoreImportId).header.keyFingerprint,
      setup.keyFingerprint,
      'importing a restore key changed the active upload key',
    );

    const merged = await manager.restore(RESTORE_BACKUP_ID, 'merge');
    assert.equal(merged.ok, true);
    assert.equal(imported.mode, 'merge');
    assert.equal(imported.value.app, 'secret-lair-bot');
    assert.deepEqual(merged.preview, expectedImportPreview('merge'));
    assert.deepEqual(dataEvents.slice(-2), ['preview:merge', 'import:merge']);

    failNextImportPreview = true;
    await assert.rejects(
      () => manager.restore(RESTORE_BACKUP_ID, 'replace'),
      /fixture import preview rejected/i,
    );
    assert.equal(fs.existsSync(path.join(tempDir, 'backups')), false,
      'replace safety snapshot was written before adapter validation');

    const replaced = await manager.restore(RESTORE_BACKUP_ID, 'replace');
    assert.equal(replaced.ok, true);
    assert.equal(imported.mode, 'replace');
    assert.deepEqual(replaced.preview, expectedImportPreview('replace'));
    assert.deepEqual(dataEvents.slice(-2), ['preview:replace', 'import:replace']);
    const safetyFiles = fs.readdirSync(path.join(tempDir, 'backups')).filter(name => name.endsWith('.rcb'));
    assert.equal(safetyFiles.length, 1);
    const safety = fs.readFileSync(path.join(tempDir, 'backups', safetyFiles[0]));
    assert.equal(safety.includes(Buffer.from(SECRET)), false);
    assert.equal(__test.parseEnvelope(safety).header.keyFingerprint, setup.keyFingerprint);
    assert.equal(__test.decryptBundle(safety, activeMasterKey).bundle.app, 'secret-lair-bot');

    assert.deepEqual(await manager.deleteBackup(firstUploadId), { ok: true });
    assert.equal(apiCalls.find(call => call.method === 'list').arguments, 1);
    assert.equal(apiCalls.find(call => call.method === 'download').arguments, 2);
    assert.equal(apiCalls.find(call => call.method === 'delete').arguments, 2);
    assert.equal(apiCalls.find(call => call.method === 'upload').arguments, 3);
    assert.ok(apiCalls.every(call => call.accountId === ACCOUNT_A));
    assert.ok(statusEvents.some(status => status.busy && /Encrypting/.test(status.stage)));

    // Each account gets an independent state file and keyring.
    accountId = ACCOUNT_B;
    assert.deepEqual(
      {
        accountBound: manager.status().accountBound,
        hasKey: manager.status().hasKey,
        keyFingerprints: manager.status().keyFingerprints,
      },
      { accountBound: true, hasKey: false, keyFingerprints: [] },
    );
    const accountBStatePath = manager.accountStatePath();
    assert.notEqual(accountBStatePath, accountAStatePath);
    const setupB = manager.setupKey();
    assert.notEqual(setupB.keyFingerprint, setup.keyFingerprint);
    const accountBStateBeforeRace = fs.readFileSync(accountBStatePath, 'utf8');

    // An operation captures its account once. Switching accounts while the authority request is in
    // flight rejects the result and cannot write completion state into the newly active account.
    accountId = ACCOUNT_A;
    const started = deferred();
    const release = deferred();
    uploadBlock = { started, release };
    const racedUpload = manager.uploadNow({ force: true, reason: 'race-test' });
    await started.promise;
    accountId = ACCOUNT_B;
    release.resolve();
    await assert.rejects(racedUpload, /account changed/i);
    assert.equal(fs.readFileSync(accountBStatePath, 'utf8'), accountBStateBeforeRace);
    const racedCall = apiCalls.filter(call => call.method === 'upload').at(-1);
    assert.equal(racedCall.accountId, ACCOUNT_A, 'in-flight API request lost its captured account binding');

    // A global legacy file is visible but never read or bound until the user explicitly claims it.
    accountId = ACCOUNT_C;
    const legacyMasterKey = Buffer.alloc(32, 0xa5);
    const legacyFingerprint = __test.keyFingerprint(legacyMasterKey);
    const legacyStatePath = path.join(tempDir, 'cloud-backup.json');
    fs.writeFileSync(legacyStatePath, `${JSON.stringify({
      encryptedKey: fakeSafeStorage.encryptString(legacyMasterKey.toString('base64')).toString('base64'),
      keyFingerprint: legacyFingerprint,
      keyConfirmed: true,
      recoveryHandledAt: Date.now(),
      enabled: true,
      intervalMs: DEFAULT_INTERVAL_MS,
    }, null, 2)}\n`, { mode: 0o600 });
    assert.equal(manager.status().legacyStateAvailable, true);
    assert.equal(manager.status().hasKey, false, 'legacy global state was auto-bound');
    assert.equal(fs.existsSync(manager.accountStatePath()), false);

    const timersBeforeClaim = timerSets;
    const claim = manager.claimLegacyState();
    assert.equal(claim.ok, true);
    assert.equal(manager.status().legacyStateAvailable, false);
    assert.equal(manager.status().activeKeyFingerprint, legacyFingerprint);
    assert.equal(manager.status().keyConfirmed, true);
    assert.equal(manager.status().enabled, true);
    assert.ok(timerSets > timersBeforeClaim, 'claiming an enabled legacy state did not arm scheduling');
    const accountCState = JSON.parse(fs.readFileSync(manager.accountStatePath(), 'utf8'));
    assert.equal(accountCState.accountId, ACCOUNT_C);
    assert.equal(accountCState.encryptedKey, undefined);
    assert.equal(typeof accountCState.keyring[legacyFingerprint], 'string');

    // Keep a rollback-compatible global copy. Its account binding makes retries idempotent and
    // prevents a different account from claiming it after a partial migration.
    const boundLegacy = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
    assert.equal(boundLegacy.accountId, ACCOUNT_C);
    assert.equal(typeof boundLegacy.encryptedKey, 'string');
    assert.equal(boundLegacy.keyring, undefined);
    assert.equal(manager.claimLegacyState().resumed, true);
    accountId = ACCOUNT_B;
    assert.equal(manager.status().legacyStateAvailable, false);
    assert.throws(() => manager.claimLegacyState(), /another account/i);

    // A legacy key already placed in an account file also migrates safely. If the old OS-wrapped
    // blob is unavailable, importing the matching recovery key repairs that configured active slot.
    accountId = ACCOUNT_D;
    const legacyRepairMasterKey = Buffer.alloc(32, 0x3c);
    const legacyRepairFingerprint = __test.keyFingerprint(legacyRepairMasterKey);
    const accountDStatePath = manager.accountStatePath();
    fs.mkdirSync(path.dirname(accountDStatePath), { recursive: true });
    fs.writeFileSync(accountDStatePath, `${JSON.stringify({
      accountId: ACCOUNT_D,
      encryptedKey: Buffer.from('unavailable-old-safe-storage').toString('base64'),
      keyFingerprint: legacyRepairFingerprint,
      keyConfirmed: true,
      recoveryHandledAt: Date.now(),
      enabled: true,
      intervalMs: DEFAULT_INTERVAL_MS,
    }, null, 2)}\n`, { mode: 0o600 });
    assert.equal(manager.status().keyUnavailable, true);
    manager.importRecoveryKey(
      __test.recoveryKeyFor(legacyRepairMasterKey),
      legacyRepairFingerprint,
    );
    assert.equal(manager.status().activeKeyFingerprint, legacyRepairFingerprint);
    assert.equal(manager.status().keyConfirmed, true);
    const migratedDState = JSON.parse(fs.readFileSync(accountDStatePath, 'utf8'));
    assert.equal(migratedDState.encryptedKey, undefined);
    assert.equal(typeof migratedDState.keyring[legacyRepairFingerprint], 'string');

    accountId = '';
    assert.equal(manager.status().accountBound, false);
    assert.throws(() => manager.setupKey(), /Sign in/i);
    await assert.rejects(() => manager.listBackups(), /Sign in/i);

    await assert.rejects(
      () => manager.preview('not-a-backup-id'),
      /Sign in/i,
    );
    accountId = ACCOUNT_A;
    await assert.rejects(() => manager.preview('not-a-backup-id'), /identifier is invalid/i);
    console.log('Zyn encrypted cloud backup smoke test passed');
  } finally {
    manager.pause();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
