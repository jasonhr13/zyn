'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const zlib = require('zlib');

// Keep the original v1 wire identity. Existing cloud objects and RCART1 recovery keys depend on
// these exact values even though every user-facing surface now calls the application Zyn.
const MAGIC = Buffer.from('RCARTB1\0', 'ascii');
const FORMAT_VERSION = 1;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 20 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_NODES = 1_000_000;
const MAX_BUNDLE_DEPTH = 64;
const MAX_OBJECT_KEYS = 100_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_KEYRING_KEYS = 32;
const STATE_VERSION = 2;
const LEGACY_STATE_FILE = 'cloud-backup.json';
const ACCOUNT_STATE_DIRECTORY = 'cloud-backup-accounts';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const ALLOWED_INTERVALS = new Set([
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LEGACY_APP_MARKER = ['secret', 'lair', 'bot'].join('-');
const APP_MARKERS = new Set(['zyn', LEGACY_APP_MARKER]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function boundedMessage(error, fallback = 'Unknown backup error.') {
  const value = String(error && error.message || error || fallback).replace(/[\r\n\t]+/g, ' ').trim();
  return (value || fallback).slice(0, 500);
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function recoveryKeyFor(masterKey) {
  const key = Buffer.from(masterKey || []);
  if (key.length !== 32) throw new Error('The recovery key material is invalid.');
  return `RCART1.${base64Url(key)}`;
}

function masterKeyFromRecovery(value) {
  const raw = String(value || '').trim();
  const prefixed = raw.match(/RCART1\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i);
  const match = prefixed || raw.match(/^([A-Za-z0-9_-]{43})$/);
  if (!match) throw new Error('That recovery key is not valid.');
  const key = Buffer.from(match[1], 'base64url');
  if (key.length !== 32) throw new Error('That recovery key is not valid.');
  return key;
}

function keyFingerprint(masterKey) {
  const key = Buffer.from(masterKey || []);
  if (key.length !== 32) throw new Error('The recovery key material is invalid.');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function deriveBackupKey(masterKey, salt, backupId) {
  const key = Buffer.from(masterKey || []);
  const saltBytes = Buffer.from(salt || []);
  if (key.length !== 32 || saltBytes.length !== 16 || !UUID_PATTERN.test(String(backupId || ''))) {
    throw new Error('The backup encryption parameters are invalid.');
  }
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    key,
    saltBytes,
    Buffer.from(`rcart-cloud-backup/v1/${backupId}`, 'utf8'),
    32,
  ));
}

function validTimestamp(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function cleanVersion(value) {
  const version = String(value || '');
  if (version.length > 40 || CONTROL_PATTERN.test(version)) throw new Error('The backup app version is invalid.');
  return version;
}

function makeHeader({ backupId, createdAt, appVersion, fingerprint, salt, nonce }) {
  if (!UUID_PATTERN.test(String(backupId || '')) || !validTimestamp(createdAt)) {
    throw new Error('The backup identity is invalid.');
  }
  if (!FINGERPRINT_PATTERN.test(String(fingerprint || ''))) {
    throw new Error('The backup key fingerprint is invalid.');
  }
  const saltBytes = Buffer.from(salt || []);
  const nonceBytes = Buffer.from(nonce || []);
  if (saltBytes.length !== 16 || nonceBytes.length !== 12) {
    throw new Error('The backup encryption parameters are invalid.');
  }
  return {
    formatVersion: FORMAT_VERSION,
    backupId: String(backupId).toLowerCase(),
    createdAt: Number(createdAt),
    appVersion: cleanVersion(appVersion),
    keyFingerprint: String(fingerprint).toLowerCase(),
    compression: 'gzip',
    encryption: 'AES-256-GCM',
    salt: base64Url(saltBytes),
    nonce: base64Url(nonceBytes),
  };
}

function decodeJson(bytes, invalidMessage) {
  try {
    return JSON.parse(utf8Decoder.decode(Buffer.from(bytes)));
  } catch {
    throw new Error(invalidMessage);
  }
}

function validateBundleGraph(bundle) {
  const stack = [{ value: bundle, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > MAX_BUNDLE_NODES) throw new Error('The decrypted backup contains too many values.');
    if (depth > MAX_BUNDLE_DEPTH) throw new Error('The decrypted backup is nested too deeply.');
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
        throw new Error('The decrypted backup contains an oversized value.');
      }
      continue;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('The decrypted backup contains an invalid number.');
      }
      continue;
    }
    if (typeof value !== 'object') throw new Error('The decrypted backup contains an unsupported value.');
    if (seen.has(value)) throw new Error('The decrypted backup contains a circular value.');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_BUNDLE_NODES) throw new Error('The decrypted backup contains an oversized list.');
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new Error('The decrypted backup contains an oversized object.');
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key) || Buffer.byteLength(key, 'utf8') > 256 || CONTROL_PATTERN.test(key)) {
        throw new Error('The decrypted backup contains an unsafe field name.');
      }
      stack.push({ value: value[key], depth: depth + 1 });
    }
  }
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || !APP_MARKERS.has(String(bundle.app || '')) || bundle.kind !== 'settings-export'
      || ![1, 2].includes(Number(bundle.version)) || !validTimestamp(bundle.exportedAt)) {
    throw new Error('The decrypted file is not a Zyn backup.');
  }
  for (const field of ['tasks', 'round1Profiles', 'profiles', 'accounts', 'taskGroups']) {
    if (bundle[field] != null && !Array.isArray(bundle[field])) {
      throw new Error(`The decrypted backup has an invalid ${field} section.`);
    }
  }
  for (const field of ['targetTasks', 'proxies', 'settings', 'lastOrders']) {
    if (bundle[field] != null
        && (!bundle[field] || typeof bundle[field] !== 'object' || Array.isArray(bundle[field]))) {
      throw new Error(`The decrypted backup has an invalid ${field} section.`);
    }
  }
  if (bundle.proxies != null && !Array.isArray(bundle.proxies.lists)) {
    throw new Error('The decrypted backup has an invalid proxy list section.');
  }
  if (bundle.watchlist != null && typeof bundle.watchlist !== 'string') {
    throw new Error('The decrypted backup has an invalid watchlist section.');
  }
  validateBundleGraph(bundle);
  return bundle;
}

function serializeBundle(bundle) {
  validateBundle(bundle);
  let serialized;
  try { serialized = JSON.stringify(bundle); }
  catch { throw new Error('Zyn could not serialize the backup data.'); }
  const plain = Buffer.from(serialized, 'utf8');
  if (!plain.length || plain.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error('The backup data is too large to encrypt safely.');
  }
  return plain;
}

function encryptBundle(bundle, masterKey, {
  backupId = crypto.randomUUID(),
  createdAt = Date.now(),
  appVersion = '',
} = {}) {
  const key = Buffer.from(masterKey || []);
  if (key.length !== 32) throw new Error('The recovery key material is invalid.');
  const plain = serializeBundle(bundle);
  // exportedAt records envelope creation, not a configuration change. Excluding it from the local
  // dedupe hash prevents unchanged automatic backups from uploading a new revision every interval.
  const comparable = { ...bundle };
  delete comparable.exportedAt;
  // This tag is persisted locally for unchanged-data dedupe. Key it so the state file cannot be
  // used as an oracle for guesses about sensitive profile/settings contents.
  const contentHash = crypto.createHmac('sha256', key)
    .update('zyn-cloud-backup-content/v1\0', 'utf8')
    .update(JSON.stringify(comparable), 'utf8')
    .digest('hex');
  const compressed = zlib.gzipSync(plain, { level: 9 });
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const fingerprint = keyFingerprint(key);
  const header = makeHeader({ backupId, createdAt, appVersion, fingerprint, salt, nonce });
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length < 2 || headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error('The backup header is too large.');
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveBackupKey(key, salt, header.backupId), nonce);
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  const buffer = Buffer.concat([MAGIC, headerLength, headerBytes, ciphertext, authTag]);
  if (buffer.length > MAX_ENVELOPE_BYTES) {
    throw new Error('The encrypted backup is larger than the 20 MB cloud limit.');
  }
  return {
    buffer,
    header,
    contentHash,
    plainBytes: plain.length,
    compressedBytes: compressed.length,
  };
}

function validateHeader(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)
      || header.formatVersion !== FORMAT_VERSION
      || header.compression !== 'gzip'
      || header.encryption !== 'AES-256-GCM'
      || !UUID_PATTERN.test(String(header.backupId || ''))
      || !validTimestamp(header.createdAt)
      || !FINGERPRINT_PATTERN.test(String(header.keyFingerprint || ''))
      || !/^[A-Za-z0-9_-]{22}$/.test(String(header.salt || ''))
      || !/^[A-Za-z0-9_-]{16}$/.test(String(header.nonce || ''))) {
    throw new Error('This backup format is not supported.');
  }
  cleanVersion(header.appVersion);
  const salt = Buffer.from(header.salt, 'base64url');
  const nonce = Buffer.from(header.nonce, 'base64url');
  if (salt.length !== 16 || nonce.length !== 12
      || base64Url(salt) !== header.salt || base64Url(nonce) !== header.nonce) {
    throw new Error('This backup format is not supported.');
  }
  return header;
}

function parseEnvelope(buffer) {
  const raw = Buffer.from(buffer || []);
  if (raw.length > MAX_ENVELOPE_BYTES) throw new Error('The encrypted backup is larger than the 20 MB cloud limit.');
  if (raw.length < MAGIC.length + 4 + AUTH_TAG_BYTES + 1
      || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('That file is not a Zyn encrypted backup.');
  }
  const headerLength = raw.readUInt32BE(MAGIC.length);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('The backup header is invalid.');
  const headerStart = MAGIC.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (ciphertextStart > raw.length - AUTH_TAG_BYTES - 1) throw new Error('The backup file is incomplete.');
  const headerBytes = raw.subarray(headerStart, ciphertextStart);
  const header = validateHeader(decodeJson(headerBytes, 'The backup header is invalid.'));
  return {
    header,
    headerBytes,
    ciphertext: raw.subarray(ciphertextStart, raw.length - AUTH_TAG_BYTES),
    authTag: raw.subarray(raw.length - AUTH_TAG_BYTES),
  };
}

function decryptBundle(buffer, masterKey, { maxPlainBytes = MAX_DECOMPRESSED_BYTES } = {}) {
  const key = Buffer.from(masterKey || []);
  if (key.length !== 32) throw new Error('The recovery key material is invalid.');
  const parsed = parseEnvelope(buffer);
  if (keyFingerprint(key) !== String(parsed.header.keyFingerprint).toLowerCase()) {
    throw new Error('This recovery key does not match the selected backup.');
  }
  let compressed;
  try {
    const salt = Buffer.from(parsed.header.salt, 'base64url');
    const nonce = Buffer.from(parsed.header.nonce, 'base64url');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveBackupKey(key, salt, parsed.header.backupId),
      nonce,
    );
    decipher.setAAD(parsed.headerBytes);
    decipher.setAuthTag(parsed.authTag);
    compressed = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch {
    throw new Error('The backup could not be decrypted. Check the recovery key and try again.');
  }
  const requestedLimit = Number(maxPlainBytes);
  const outputLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_DECOMPRESSED_BYTES)
    : MAX_DECOMPRESSED_BYTES;
  let plain;
  try { plain = zlib.gunzipSync(compressed, { maxOutputLength: outputLimit }); }
  catch { throw new Error('The decrypted backup data is damaged or too large.'); }
  if (!plain.length || plain.length > outputLimit) {
    throw new Error('The decrypted backup data is damaged or too large.');
  }
  const bundle = validateBundle(decodeJson(plain, 'The decrypted backup data is damaged.'));
  return { bundle, header: parsed.header };
}

function previewBundle(bundle) {
  validateBundle(bundle);
  return {
    exportedAt: Number(bundle.exportedAt) || 0,
    profiles: Array.isArray(bundle.profiles) ? bundle.profiles.length : 0,
    accounts: Array.isArray(bundle.accounts) ? bundle.accounts.length : 0,
    proxyLists: Array.isArray(bundle.proxies && bundle.proxies.lists) ? bundle.proxies.lists.length : 0,
    taskGroups: Array.isArray(bundle.taskGroups) ? bundle.taskGroups.length : 0,
    legacyTasks: (Array.isArray(bundle.tasks) ? bundle.tasks.length : 0)
      + (Array.isArray(bundle.targetTasks && bundle.targetTasks.tasks) ? bundle.targetTasks.tasks.length : 0),
  };
}

function normalizeBackupMetadata(raw) {
  const backup = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!UUID_PATTERN.test(String(backup.id || ''))
      || !validTimestamp(backup.createdAt)
      || !Number.isSafeInteger(Number(backup.sizeBytes))
      || Number(backup.sizeBytes) <= 0 || Number(backup.sizeBytes) > MAX_ENVELOPE_BYTES
      || !SHA256_PATTERN.test(String(backup.sha256 || ''))
      || !FINGERPRINT_PATTERN.test(String(backup.keyFingerprint || ''))
      || Number(backup.formatVersion) !== FORMAT_VERSION) {
    throw new Error('The backup service returned invalid metadata.');
  }
  const deviceName = String(backup.deviceName || '');
  const appVersion = cleanVersion(backup.appVersion);
  if (deviceName.length > 100 || CONTROL_PATTERN.test(deviceName)) {
    throw new Error('The backup service returned invalid metadata.');
  }
  return {
    id: String(backup.id).toLowerCase(),
    createdAt: Number(backup.createdAt),
    clientCreatedAt: validTimestamp(backup.clientCreatedAt) ? Number(backup.clientCreatedAt) : 0,
    deviceName,
    sizeBytes: Number(backup.sizeBytes),
    sha256: String(backup.sha256).toLowerCase(),
    keyFingerprint: String(backup.keyFingerprint).toLowerCase(),
    formatVersion: FORMAT_VERSION,
    appVersion,
  };
}

function createCloudBackupManager({
  app,
  safeStorage,
  dataManager,
  api,
  getAccountId,
  dialog,
  clipboard,
  log = console,
  onStatus = () => {},
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (!app || typeof app.getPath !== 'function' || typeof app.getVersion !== 'function') {
    throw new Error('Zyn backup requires an application adapter.');
  }
  if (!dataManager || typeof dataManager.exportAll !== 'function' || typeof dataManager.importAll !== 'function') {
    throw new Error('Zyn backup requires a data adapter.');
  }
  if (typeof getAccountId !== 'function') {
    throw new Error('Zyn backup requires a stable account identity provider.');
  }
  const requiredApi = ['listBackups', 'uploadBackup', 'downloadBackup', 'deleteBackup'];
  if (!api || requiredApi.some(method => typeof api[method] !== 'function')) {
    throw new Error('Zyn backup requires an authenticated backup API.');
  }

  const dataDirectory = app.getPath('userData');
  const legacyStatePath = path.join(dataDirectory, LEGACY_STATE_FILE);
  const accountStateDirectory = path.join(dataDirectory, ACCOUNT_STATE_DIRECTORY);
  let timer = null;
  let schedulerRunning = false;
  let busyAccountId = '';
  let stage = '';

  function currentAccountId() {
    let raw = '';
    try { raw = String(getAccountId() || '').trim().toLowerCase(); } catch { return ''; }
    return UUID_PATTERN.test(raw) ? raw : '';
  }

  function captureAccount(required = true) {
    const accountId = currentAccountId();
    if (!accountId) {
      if (required) throw new Error('Sign in to a Zyn account before using encrypted cloud backup.');
      return null;
    }
    return Object.freeze({
      accountId,
      statePath: path.join(accountStateDirectory, `${accountId}.json`),
    });
  }

  function sameAccount(context) {
    return Boolean(context && currentAccountId() === context.accountId);
  }

  function assertAccount(context) {
    if (!sameAccount(context)) {
      throw new Error('The signed-in Zyn account changed while the backup operation was running. Try again.');
    }
  }

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable());
    } catch { return false; }
  }

  function readStateFile(filePath, invalidMessage) {
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STATE_BYTES) throw new Error(invalidMessage);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed;
    } catch {
      throw new Error(invalidMessage);
    }
  }

  function normalizedKeyring(state) {
    if (state.keyring == null) return {};
    if (!state.keyring || typeof state.keyring !== 'object' || Array.isArray(state.keyring)) {
      throw new Error('The encrypted backup keyring is damaged.');
    }
    const entries = Object.entries(state.keyring);
    if (entries.length > MAX_KEYRING_KEYS) throw new Error('The encrypted backup keyring has too many keys.');
    const keyring = {};
    for (const [rawFingerprint, rawEncrypted] of entries) {
      const fingerprint = String(rawFingerprint || '').toLowerCase();
      const encrypted = String(rawEncrypted || '');
      if (!FINGERPRINT_PATTERN.test(fingerprint) || !encrypted || encrypted.length > 64 * 1024
          || !/^[A-Za-z0-9+/=]+$/.test(encrypted)) {
        throw new Error('The encrypted backup keyring is damaged.');
      }
      keyring[fingerprint] = encrypted;
    }
    return keyring;
  }

  function writeJsonAtomic(filePath, value, oversizedMessage) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new Error(oversizedMessage);
    }
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch {}
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function writeState(context, value) {
    assertAccount(context);
    const next = {
      ...(value && typeof value === 'object' ? value : {}),
      stateVersion: STATE_VERSION,
      accountId: context.accountId,
    };
    normalizedKeyring(next);
    writeJsonAtomic(context.statePath, next, 'This account’s encrypted backup settings are too large.');
    return next;
  }

  function decryptStoredKey(encrypted, expectedFingerprint = '') {
    if (!encrypted || !encryptionAvailable()) return null;
    try {
      const plain = safeStorage.decryptString(Buffer.from(String(encrypted), 'base64'));
      const key = Buffer.from(plain, 'base64');
      if (key.length !== 32) return null;
      const fingerprint = keyFingerprint(key);
      if (expectedFingerprint && fingerprint !== String(expectedFingerprint).toLowerCase()) return null;
      return key;
    } catch { return null; }
  }

  function migrateLegacyKey(context, state) {
    const legacyEncrypted = String(state.encryptedKey || '');
    if (!legacyEncrypted) return state;
    const masterKey = decryptStoredKey(legacyEncrypted);
    if (!masterKey) return state;
    return finishLegacyKeyMigration(context, state, masterKey, legacyEncrypted);
  }

  function finishLegacyKeyMigration(context, state, masterKey, encryptedKey) {
    const fingerprint = keyFingerprint(masterKey);
    const legacyFingerprint = FINGERPRINT_PATTERN.test(String(state.keyFingerprint || ''))
      ? String(state.keyFingerprint).toLowerCase() : '';
    if (legacyFingerprint && legacyFingerprint !== fingerprint) {
      throw new Error('The legacy encrypted backup key does not match its fingerprint.');
    }
    const keyring = normalizedKeyring(state);
    if (!keyring[fingerprint] && Object.keys(keyring).length >= MAX_KEYRING_KEYS) {
      throw new Error('The encrypted backup keyring has too many keys.');
    }
    keyring[fingerprint] = String(encryptedKey || '') || protectKey(masterKey);
    const existingActive = FINGERPRINT_PATTERN.test(String(state.activeKeyFingerprint || ''))
      ? String(state.activeKeyFingerprint).toLowerCase() : '';
    const activeKeyFingerprint = existingActive || fingerprint;
    const next = {
      ...state,
      keyring,
      activeKeyFingerprint,
      confirmedKeyFingerprint: String(state.confirmedKeyFingerprint || '')
        || (state.keyConfirmed === true && activeKeyFingerprint === fingerprint ? fingerprint : ''),
      recoveryHandledKeyFingerprint: String(state.recoveryHandledKeyFingerprint || '')
        || (Number(state.recoveryHandledAt) > 0 && activeKeyFingerprint === fingerprint ? fingerprint : ''),
    };
    delete next.encryptedKey;
    delete next.keyFingerprint;
    delete next.keyConfirmed;
    return writeState(context, next);
  }

  function readState(context, { migrate = true } = {}) {
    assertAccount(context);
    const stored = readStateFile(context.statePath, 'This account’s encrypted backup settings are damaged.')
      || { accountId: context.accountId, stateVersion: STATE_VERSION, keyring: {} };
    if (stored.accountId && String(stored.accountId).toLowerCase() !== context.accountId) {
      throw new Error('These encrypted backup settings belong to a different Zyn account.');
    }
    normalizedKeyring(stored);
    return migrate ? migrateLegacyKey(context, stored) : stored;
  }

  function mutate(context, changes) {
    assertAccount(context);
    return writeState(context, { ...readState(context), ...changes });
  }

  function loadKey(context, fingerprint, state = null) {
    const wanted = String(fingerprint || '').toLowerCase();
    if (!FINGERPRINT_PATTERN.test(wanted)) return null;
    const current = state || readState(context);
    const keyring = normalizedKeyring(current);
    return decryptStoredKey(keyring[wanted], wanted);
  }

  function activeKey(context, state = null) {
    const current = state || readState(context);
    const fingerprint = String(current.activeKeyFingerprint || '').toLowerCase();
    const masterKey = loadKey(context, fingerprint, current);
    return masterKey ? { masterKey, fingerprint } : null;
  }

  function configuredActiveFingerprint(state) {
    const configured = String(state && state.activeKeyFingerprint || '').toLowerCase();
    if (FINGERPRINT_PATTERN.test(configured)) return configured;
    const legacy = String(state && state.keyFingerprint || '').toLowerCase();
    return state && state.encryptedKey && FINGERPRINT_PATTERN.test(legacy) ? legacy : '';
  }

  function availableKeyFingerprints(context, state) {
    const keyring = normalizedKeyring(state);
    return Object.keys(keyring).filter(fingerprint => Boolean(decryptStoredKey(keyring[fingerprint], fingerprint))).sort();
  }

  function protectKey(masterKey) {
    const key = Buffer.from(masterKey || []);
    if (key.length !== 32) throw new Error('The recovery key material is invalid.');
    if (!encryptionAvailable()) {
      throw new Error('Your operating system cannot securely store the backup key right now.');
    }
    return safeStorage.encryptString(key.toString('base64')).toString('base64');
  }

  function storeKey(context, masterKey, { activate = false } = {}) {
    const key = Buffer.from(masterKey || []);
    const fingerprint = keyFingerprint(key);
    const state = readState(context);
    const keyring = normalizedKeyring(state);
    // A matching entry can still be unusable when the OS keychain changed or the stored blob was
    // damaged. Re-importing the recovery key repairs that one slot without changing the upload key.
    if (!decryptStoredKey(keyring[fingerprint], fingerprint)) {
      if (Object.keys(keyring).length >= MAX_KEYRING_KEYS) {
        if (!keyring[fingerprint]) throw new Error('The encrypted backup keyring has reached its key limit.');
      }
      keyring[fingerprint] = protectKey(key);
    }
    const next = { ...state, keyring, lastError: '' };
    if (activate) {
      next.activeKeyFingerprint = fingerprint;
      next.confirmedKeyFingerprint = '';
      next.recoveryHandledKeyFingerprint = '';
      next.recoveryHandledAt = 0;
      next.enabled = false;
      next.lastContentHash = '';
      next.lastContentKeyFingerprint = '';
    }
    writeState(context, next);
    return { masterKey: key, fingerprint };
  }

  function intervalOf(state) {
    const value = Number(state && state.intervalMs);
    return ALLOWED_INTERVALS.has(value) ? value : DEFAULT_INTERVAL_MS;
  }

  function legacyAvailable(context = null) {
    try {
      const legacy = readStateFile(legacyStatePath, 'The legacy encrypted backup settings are damaged.');
      if (!legacy) return false;
      const boundAccountId = String(legacy.accountId || '').trim().toLowerCase();
      if (!boundAccountId) return !context || !fs.existsSync(context.statePath);
      return Boolean(
        context
        && boundAccountId === context.accountId
        && !fs.existsSync(context.statePath)
      );
    } catch { return false; }
  }

  function unboundStatus() {
    return {
      available: encryptionAvailable(),
      accountBound: false,
      legacyStateAvailable: legacyAvailable(),
      hasKey: false,
      hasActiveUploadKey: false,
      keyUnavailable: false,
      keyConfirmed: false,
      keyFingerprint: '',
      activeKeyFingerprint: '',
      configuredActiveKeyFingerprint: '',
      keyFingerprints: [],
      recoveryHandled: false,
      enabled: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      lastBackupAt: 0,
      lastBackupBytes: 0,
      lastBackupId: '',
      lastError: '',
      nextBackupAt: 0,
      busy: Boolean(busyAccountId),
      stage: busyAccountId ? 'Finishing a previous account operation…' : '',
    };
  }

  function statusFor(context) {
    if (!context) return unboundStatus();
    let state;
    try { state = readState(context); }
    catch (error) {
      return {
        ...unboundStatus(),
        accountBound: true,
        legacyStateAvailable: legacyAvailable(context),
        lastError: boundedMessage(error),
      };
    }
    const active = activeKey(context, state);
    const activeFingerprint = active ? active.fingerprint : '';
    const configuredActive = configuredActiveFingerprint(state);
    const keyFingerprints = availableKeyFingerprints(context, state);
    const keyConfirmed = Boolean(activeFingerprint
      && String(state.confirmedKeyFingerprint || '').toLowerCase() === activeFingerprint);
    const recoveryHandled = Boolean(activeFingerprint
      && String(state.recoveryHandledKeyFingerprint || '').toLowerCase() === activeFingerprint
      && Number(state.recoveryHandledAt) > 0);
    const enabled = Boolean(active && keyConfirmed && state.enabled === true);
    const intervalMs = intervalOf(state);
    const lastRunAt = Math.max(Number(state.lastBackupAt) || 0, Number(state.lastCheckedAt) || 0);
    const dueAt = enabled
      ? Math.max(lastRunAt ? lastRunAt + intervalMs : Date.now(), Number(state.nextAttemptAt) || 0)
      : 0;
    return {
      available: encryptionAvailable(),
      accountBound: true,
      legacyStateAvailable: legacyAvailable(context),
      hasKey: Boolean(active),
      hasActiveUploadKey: Boolean(active),
      keyUnavailable: Boolean((configuredActive || state.encryptedKey) && !active),
      keyConfirmed,
      keyFingerprint: activeFingerprint,
      activeKeyFingerprint: activeFingerprint,
      configuredActiveKeyFingerprint: configuredActive,
      keyFingerprints,
      recoveryHandled,
      enabled,
      intervalMs,
      lastBackupAt: Number(state.lastBackupAt) || 0,
      lastBackupBytes: Number(state.lastBackupBytes) || 0,
      lastBackupId: String(state.lastBackupId || ''),
      lastError: String(state.lastError || '').slice(0, 500),
      nextBackupAt: dueAt,
      busy: Boolean(busyAccountId),
      stage: busyAccountId && busyAccountId !== context.accountId
        ? 'Finishing a previous account operation…' : stage,
    };
  }

  function status() {
    return statusFor(captureAccount(false));
  }

  function publish() {
    const current = status();
    try { onStatus(current); } catch {}
    return current;
  }

  function requireActiveKey(context, state = null) {
    const current = state || readState(context);
    const active = activeKey(context, current);
    if (active) return active;
    if (current.activeKeyFingerprint || current.encryptedKey) {
      throw new Error(
        'This device can no longer unlock its active recovery key. Import the original recovery key before enabling backups.',
      );
    }
    throw new Error('Create an active recovery key before enabling backups.');
  }

  async function callServer(context, operation, fallbackMessage) {
    assertAccount(context);
    try {
      const result = await operation();
      assertAccount(context);
      return result;
    } catch (error) {
      if (!sameAccount(context)) throw error;
      log.warn?.(`[backup] server request: ${boundedMessage(error)}`);
      throw new Error(fallbackMessage);
    }
  }

  function markRecoveryHandled(context, fingerprint) {
    mutate(context, {
      recoveryHandledAt: Date.now(),
      recoveryHandledKeyFingerprint: fingerprint,
    });
    return publish();
  }

  function setupKey() {
    const context = captureAccount();
    const state = readState(context);
    let active = activeKey(context, state);
    if (!active) {
      if (state.activeKeyFingerprint || state.encryptedKey) {
        throw new Error(
          'This device can no longer unlock its active recovery key. Import the original recovery key instead of creating a new one.',
        );
      }
      active = storeKey(context, crypto.randomBytes(32), { activate: true });
    }
    publish();
    return {
      keyFingerprint: active.fingerprint,
      activeKeyFingerprint: active.fingerprint,
    };
  }

  function revealKeyFor(context) {
    const active = requireActiveKey(context);
    return {
      recoveryKey: recoveryKeyFor(active.masterKey),
      keyFingerprint: active.fingerprint,
      activeKeyFingerprint: active.fingerprint,
    };
  }

  async function copyRecoveryKey(mainWindow) {
    const context = captureAccount();
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('The clipboard is unavailable.');
    if (!dialog || typeof dialog.showMessageBox !== 'function') {
      throw new Error('The recovery-key confirmation dialog is unavailable.');
    }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Copy Zyn recovery key?',
      message: 'Copy the full recovery key to the system clipboard?',
      detail: 'Anyone with this key and access to your encrypted backup can restore its contents. Your operating system may sync clipboard contents.',
      buttons: ['Copy recovery key', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    assertAccount(context);
    if (!confirmation || confirmation.response !== 0) return { ok: false, canceled: true };
    const revealed = revealKeyFor(context);
    clipboard.writeText(revealed.recoveryKey);
    assertAccount(context);
    markRecoveryHandled(context, revealed.keyFingerprint);
    return { ok: true };
  }

  async function saveRecoveryKey(mainWindow) {
    const context = captureAccount();
    if (!dialog || typeof dialog.showSaveDialog !== 'function') throw new Error('The save dialog is unavailable.');
    const revealed = revealKeyFor(context);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Zyn recovery key',
      defaultPath: 'Zyn-recovery-key.zyn-recovery-key',
      filters: [{ name: 'Zyn Recovery Key', extensions: ['zyn-recovery-key', 'rcart-recovery-key'] }],
    });
    assertAccount(context);
    if (canceled || !filePath) return { ok: false, canceled: true };
    const contents = [
      'Zyn Recovery Key',
      '',
      revealed.recoveryKey,
      '',
      'Keep this file somewhere secure. Zyn cannot restore your encrypted backups without it.',
    ].join('\n');
    fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    assertAccount(context);
    markRecoveryHandled(context, revealed.keyFingerprint);
    return { ok: true };
  }

  function importRecoveryKey(value, expectedFingerprint = '') {
    const context = captureAccount();
    const masterKey = masterKeyFromRecovery(value);
    const fingerprint = keyFingerprint(masterKey);
    const expected = String(expectedFingerprint || '').toLowerCase();
    if (expected && (!FINGERPRINT_PATTERN.test(expected) || fingerprint !== expected)) {
      throw new Error('This recovery key does not match the selected backup.');
    }
    const before = readState(context);
    const previousConfiguredActive = configuredActiveFingerprint(before);
    const activateForBackup = !previousConfiguredActive;
    storeKey(context, masterKey, { activate: activateForBackup });
    let after = readState(context);
    if (after.encryptedKey && !after.activeKeyFingerprint
        && configuredActiveFingerprint(after) === fingerprint) {
      // The OS may no longer decrypt the old safeStorage blob. A matching recovery key repairs the
      // same configured active slot; it does not rotate uploads to a different fingerprint.
      const importedCiphertext = normalizedKeyring(after)[fingerprint];
      after = finishLegacyKeyMigration(context, after, masterKey, importedCiphertext);
    }
    const afterConfiguredActive = configuredActiveFingerprint(after);
    if (previousConfiguredActive && previousConfiguredActive !== afterConfiguredActive) {
      throw new Error('Importing a restore key attempted to change the active upload key.');
    }
    if (activateForBackup && afterConfiguredActive === fingerprint) {
      // This device had no upload key. Importing proves the operator already holds it, so treat
      // it as saved and confirmed. Do not turn automatic backup on; they still choose that here.
      after = mutate(context, {
        recoveryHandledAt: Date.now(),
        recoveryHandledKeyFingerprint: fingerprint,
        confirmedKeyFingerprint: fingerprint,
        lastError: '',
      });
    }
    const activeFingerprint = activeKey(context, after)?.fingerprint || '';
    if (schedulerRunning) schedule(context);
    publish();
    return {
      ok: true,
      keyFingerprint: fingerprint,
      activeKeyFingerprint: activeFingerprint,
      addedForRestore: Boolean(activeFingerprint && fingerprint !== activeFingerprint),
      activatedForBackup: activateForBackup && activeFingerprint === fingerprint,
    };
  }

  function clearTimer() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  function schedule(context = captureAccount(false)) {
    clearTimer();
    if (!schedulerRunning || !context || !sameAccount(context)) return;
    const current = statusFor(context);
    if (!current.enabled) return;
    const delay = Math.max(5000, current.nextBackupAt - Date.now());
    timer = timers.setTimeout(() => {
      timer = null;
      if (!sameAccount(context)) {
        schedule();
        return;
      }
      uploadFor(context, { force: false, reason: 'automatic' })
        .catch((error) => log.warn?.(`[backup] automatic backup: ${boundedMessage(error)}`));
    }, delay);
  }

  function start() {
    schedulerRunning = true;
    const context = captureAccount(false);
    schedule(context);
    return publish();
  }

  function pause() {
    schedulerRunning = false;
    clearTimer();
    return publish();
  }

  function confirmKey(intervalMs = DEFAULT_INTERVAL_MS) {
    const context = captureAccount();
    const state = readState(context);
    const active = requireActiveKey(context, state);
    if (String(state.recoveryHandledKeyFingerprint || '').toLowerCase() !== active.fingerprint
        || !Number(state.recoveryHandledAt)) {
      throw new Error('Save or copy the active recovery key before enabling backups.');
    }
    const normalizedInterval = Number(intervalMs);
    if (!ALLOWED_INTERVALS.has(normalizedInterval)) throw new Error('Choose a supported backup interval.');
    mutate(context, {
      confirmedKeyFingerprint: active.fingerprint,
      enabled: true,
      intervalMs: normalizedInterval,
      lastError: '',
    });
    schedulerRunning = true;
    schedule(context);
    return publish();
  }

  function setSchedule(intervalMs) {
    const context = captureAccount();
    const value = Number(intervalMs);
    if (value === 0) {
      mutate(context, { enabled: false });
      schedule(context);
      return publish();
    }
    const state = readState(context);
    const active = requireActiveKey(context, state);
    if (!ALLOWED_INTERVALS.has(value)) throw new Error('Choose a supported backup interval.');
    if (String(state.confirmedKeyFingerprint || '').toLowerCase() !== active.fingerprint) {
      throw new Error('Confirm that you saved the active recovery key first.');
    }
    mutate(context, { enabled: true, intervalMs: value, lastError: '' });
    schedule(context);
    return publish();
  }

  function enterBusy(context, nextStage) {
    if (busyAccountId) throw new Error('A backup or restore is already in progress.');
    busyAccountId = context.accountId;
    stage = nextStage;
    publish();
  }

  function setStage(context, nextStage) {
    if (busyAccountId !== context.accountId) return;
    stage = nextStage;
    publish();
  }

  function leaveBusy(context) {
    if (busyAccountId === context.accountId) {
      busyAccountId = '';
      stage = '';
    }
    publish();
  }

  async function uploadFor(context, { force = true, reason = 'manual' } = {}) {
    assertAccount(context);
    clearTimer();
    const stateBefore = readState(context);
    const active = requireActiveKey(context, stateBefore);
    if (String(stateBefore.confirmedKeyFingerprint || '').toLowerCase() !== active.fingerprint) {
      throw new Error('Confirm that you saved the active recovery key first.');
    }
    enterBusy(context, 'Encrypting on this device…');
    try {
      const bundle = dataManager.exportAll({ includePrivateSettings: true });
      const encrypted = encryptBundle(bundle, active.masterKey, { appVersion: app.getVersion() });
      const state = readState(context);
      if (!force && state.lastContentHash === encrypted.contentHash
          && state.lastContentKeyFingerprint === active.fingerprint) {
        mutate(context, {
          lastCheckedAt: Date.now(),
          lastError: '',
          consecutiveFailures: 0,
          nextAttemptAt: 0,
        });
        return { ok: true, skipped: true, reason: 'unchanged' };
      }
      setStage(context, 'Uploading encrypted backup…');
      const result = await callServer(context, () => api.uploadBackup(encrypted.buffer, {
        backupId: encrypted.header.backupId,
        createdAt: encrypted.header.createdAt,
        keyFingerprint: encrypted.header.keyFingerprint,
        appVersion: encrypted.header.appVersion,
      }, context.accountId), 'Zyn could not save the backup. Check your connection and try again.');
      if (!result || !result.ok) {
        throw new Error(boundedMessage(result && result.message, 'Zyn could not save the backup.'));
      }
      const returned = result.backup ? normalizeBackupMetadata(result.backup) : null;
      if (returned && returned.id !== encrypted.header.backupId) {
        throw new Error('The backup service returned the wrong backup receipt.');
      }
      assertAccount(context);
      mutate(context, {
        lastBackupAt: encrypted.header.createdAt,
        lastBackupBytes: encrypted.buffer.length,
        lastBackupId: encrypted.header.backupId,
        lastContentHash: encrypted.contentHash,
        lastContentKeyFingerprint: active.fingerprint,
        lastCheckedAt: Date.now(),
        lastError: '',
        lastReason: String(reason || '').slice(0, 40),
        consecutiveFailures: 0,
        nextAttemptAt: 0,
      });
      return { ok: true, backup: returned || result.backup || null, bytes: encrypted.buffer.length };
    } catch (error) {
      if (sameAccount(context)) {
        const state = readState(context);
        const failures = Math.min(8, (Number(state.consecutiveFailures) || 0) + 1);
        const backoffMs = Math.min(60 * 60 * 1000, 5 * 60 * 1000 * (2 ** (failures - 1)));
        mutate(context, {
          lastError: boundedMessage(error),
          lastAttemptAt: Date.now(),
          consecutiveFailures: failures,
          nextAttemptAt: Date.now() + backoffMs,
        });
      }
      throw error;
    } finally {
      leaveBusy(context);
      if (schedulerRunning) schedule();
    }
  }

  function uploadNow(options) {
    return uploadFor(captureAccount(), options);
  }

  async function listBackups() {
    const context = captureAccount();
    const result = await callServer(
      context,
      () => api.listBackups(context.accountId),
      'Zyn could not list your backups. Check your connection and try again.',
    );
    if (!result || !result.ok || !Array.isArray(result.backups) || result.backups.length > 10) {
      throw new Error(boundedMessage(result && result.message, 'The backup service returned an invalid list.'));
    }
    return result.backups.map(normalizeBackupMetadata);
  }

  function validateBackupId(backupId) {
    const id = String(backupId || '').toLowerCase();
    if (!UUID_PATTERN.test(id)) throw new Error('The selected backup identifier is invalid.');
    return id;
  }

  async function downloadDecryptedFor(context, backupId) {
    assertAccount(context);
    const id = validateBackupId(backupId);
    const result = await callServer(
      context,
      () => api.downloadBackup(id, context.accountId),
      'Zyn could not download that backup. Check your connection and try again.',
    );
    if (!result || !result.ok || !Buffer.isBuffer(result.buffer)) {
      throw new Error(boundedMessage(result && result.message, 'Zyn could not download that backup.'));
    }
    if (!result.buffer.length || result.buffer.length > MAX_ENVELOPE_BYTES) {
      throw new Error('The downloaded backup is incomplete or too large.');
    }
    const responseHeaders = result.headers && typeof result.headers === 'object' ? result.headers : {};
    const expectedSha = String(responseHeaders['x-rcart-backup-sha256'] || '').toLowerCase();
    if (!SHA256_PATTERN.test(expectedSha)) {
      throw new Error('The backup service returned an invalid integrity receipt.');
    }
    const actualSha = crypto.createHash('sha256').update(result.buffer).digest('hex');
    if (actualSha !== expectedSha) throw new Error('The downloaded backup is incomplete or damaged.');
    const parsed = parseEnvelope(result.buffer);
    if (parsed.header.backupId !== id) {
      throw new Error('The downloaded backup does not match the selected revision.');
    }
    const fingerprint = String(parsed.header.keyFingerprint).toLowerCase();
    const masterKey = loadKey(context, fingerprint);
    if (!masterKey) {
      throw new Error(`Import the recovery key matching fingerprint ${fingerprint} before restoring this backup.`);
    }
    const decrypted = decryptBundle(result.buffer, masterKey);
    return { ...decrypted, decryptionKey: masterKey };
  }

  function normalizeRestoreMode(mode) {
    return mode === 'replace' ? 'replace' : 'merge';
  }

  function previewImport(bundle, mode) {
    const normalizedMode = normalizeRestoreMode(mode);
    if (typeof dataManager.previewImport === 'function') {
      return dataManager.previewImport(bundle, normalizedMode);
    }
    return { ...previewBundle(bundle), mode: normalizedMode, warnings: [] };
  }

  async function preview(backupId, mode = 'merge') {
    const context = captureAccount();
    const { bundle, header } = await downloadDecryptedFor(context, backupId);
    assertAccount(context);
    return { ok: true, header, preview: previewImport(bundle, mode) };
  }

  async function restore(backupId, mode = 'merge') {
    const context = captureAccount();
    enterBusy(context, 'Downloading encrypted backup…');
    try {
      const { bundle, header, decryptionKey } = await downloadDecryptedFor(context, backupId);
      const normalizedMode = normalizeRestoreMode(mode);
      // Run the adapter's complete compatibility/capacity preview before creating a safety file or
      // writing local data. The same result is returned so the confirmation and result describe the
      // exact supported/skipped items evaluated for this mode.
      const importPreview = previewImport(bundle, normalizedMode);
      if (normalizedMode === 'replace') {
        setStage(context, 'Creating encrypted safety snapshot…');
        const safetyKey = activeKey(context)?.masterKey || decryptionKey;
        const safety = encryptBundle(dataManager.exportAll({ includePrivateSettings: true }), safetyKey, {
          appVersion: app.getVersion(),
        });
        const backupDir = path.join(dataDirectory, 'backups');
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const safetyPath = path.join(backupDir, `pre-cloud-restore-${Date.now()}.rcb`);
        fs.writeFileSync(safetyPath, safety.buffer, { mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(safetyPath, 0o600); } catch {}
        const oldSafety = fs.readdirSync(backupDir)
          .filter(name => /^pre-cloud-restore-\d+\.rcb$/.test(name))
          .sort().reverse().slice(5);
        for (const name of oldSafety) fs.unlinkSync(path.join(backupDir, name));
      }
      assertAccount(context);
      setStage(context, normalizedMode === 'replace' ? 'Replacing local data…' : 'Merging local data…');
      const summary = dataManager.importAll(bundle, normalizedMode);
      mutate(context, {
        lastRestoreAt: Date.now(),
        lastRestoreId: header.backupId,
        lastError: '',
        lastContentHash: '',
        lastContentKeyFingerprint: '',
      });
      return { ok: true, summary, header, preview: importPreview };
    } catch (error) {
      if (sameAccount(context)) mutate(context, { lastError: boundedMessage(error) });
      throw error;
    } finally {
      leaveBusy(context);
      schedule();
    }
  }

  async function deleteBackup(backupId) {
    const context = captureAccount();
    const id = validateBackupId(backupId);
    const result = await callServer(
      context,
      () => api.deleteBackup(id, context.accountId),
      'Zyn could not delete that backup. Check your connection and try again.',
    );
    if (!result || !result.ok) {
      throw new Error(boundedMessage(result && result.message, 'Zyn could not delete that backup.'));
    }
    return { ok: true };
  }

  function claimLegacyState() {
    const context = captureAccount();
    assertAccount(context);
    const legacy = readStateFile(legacyStatePath, 'The legacy encrypted backup settings are damaged.');
    if (!legacy) throw new Error('No unclaimed legacy backup settings are available.');
    const boundAccountId = String(legacy.accountId || '').trim().toLowerCase();
    if (boundAccountId && (!UUID_PATTERN.test(boundAccountId) || boundAccountId !== context.accountId)) {
      throw new Error('The legacy encrypted backup settings are already bound to another account.');
    }
    const accountStateExists = fs.existsSync(context.statePath);
    if (accountStateExists && !boundAccountId) {
      throw new Error('This Zyn account already has encrypted backup settings.');
    }

    // Bind the rollback-compatible global file first. If the process stops before the account copy
    // completes, only this same account may resume the claim. The original app ignores the extra field.
    const boundLegacy = boundAccountId ? legacy : { ...legacy, accountId: context.accountId };
    if (!boundAccountId) {
      writeJsonAtomic(legacyStatePath, boundLegacy, 'The legacy encrypted backup settings are too large.');
    }
    assertAccount(context);
    if (!accountStateExists) writeState(context, boundLegacy);
    // Migration is permitted only after an explicit claim copied the legacy file under the bound
    // account. The global rollback copy intentionally stays in its legacy encryptedKey form.
    readState(context);
    if (schedulerRunning) schedule(context);
    return { ok: true, status: publish(), resumed: Boolean(boundAccountId || accountStateExists) };
  }

  function triggerDue() {
    if (!schedulerRunning) return;
    const context = captureAccount(false);
    const current = statusFor(context);
    if (context && current.enabled && current.nextBackupAt <= Date.now() + 1000) {
      uploadFor(context, { force: false, reason: 'resume' })
        .catch((error) => log.warn?.(`[backup] resume: ${boundedMessage(error)}`));
    } else schedule(context);
  }

  return Object.freeze({
    status,
    claimLegacyState,
    accountStatePath: () => captureAccount().statePath,
    setupKey,
    copyRecoveryKey,
    saveRecoveryKey,
    importRecoveryKey,
    confirmKey,
    setSchedule,
    uploadNow,
    listBackups,
    preview,
    restore,
    deleteBackup,
    start,
    pause,
    triggerDue,
  });
}

module.exports = {
  createCloudBackupManager,
  ALLOWED_INTERVALS,
  DEFAULT_INTERVAL_MS,
  MAX_ENVELOPE_BYTES,
  MAX_DECOMPRESSED_BYTES,
  __test: {
    encryptBundle,
    decryptBundle,
    parseEnvelope,
    recoveryKeyFor,
    masterKeyFromRecovery,
    keyFingerprint,
    deriveBackupKey,
    makeHeader,
    previewBundle,
    validateBundle,
    normalizeBackupMetadata,
  },
};
