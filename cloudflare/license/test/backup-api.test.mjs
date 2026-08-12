import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const DEVICE_A = 'aaaaaaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbbbbbbbbbb';
const TOKEN_A = 'license-token-a';
const TOKEN_B = 'license-token-b';
const TOKEN_REVOKED = 'license-token-revoked';
const FINGERPRINT = '0123456789abcdef';
const APP_VERSION = '1.6.93';

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

function copyBuffer(value) {
  const bytes = new Uint8Array(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

class MemoryD1 {
  constructor() {
    this.users = new Map();
    this.licenses = [];
    this.backups = new Map();
    this.rateWindows = new Map();
    this.nextRowId = 1;
    this.failNextBackupInsert = 0;
    this.failNextBackupDelete = 0;
    this.failNextRetention = 0;
  }

  prepare(sql) {
    const db = this;
    const normalized = compactSql(sql);
    return {
      bind(...bindings) {
        return {
          first: () => db.first(normalized, bindings),
          all: () => db.all(normalized, bindings),
          run: () => db.run(normalized, bindings),
        };
      },
    };
  }

  async first(sql, bindings) {
    if (sql.includes('FROM licenses l JOIN users u') && sql.includes('l.revoked_at IS NULL')) {
      const [tokenHash] = bindings;
      const license = this.licenses.find(row => row.token_hash === tokenHash && row.revoked_at == null);
      if (!license) return null;
      const user = this.users.get(license.user_id);
      if (!user) return null;
      return {
        license_id: license.id,
        device_id: license.device_id,
        device_name: license.device_name,
        expires_at: license.expires_at,
        user_id: user.id,
        email: user.email,
        active: user.active,
      };
    }
    if (sql.startsWith('SELECT request_count FROM service_rate_windows')) {
      const [userId, service] = bindings;
      return this.rateWindows.get(`${userId}:${service}`) || null;
    }
    if (sql.startsWith('SELECT id FROM encrypted_backups')) {
      const [id, userId] = bindings;
      const row = this.backups.get(id);
      return row && row.user_id === userId ? { id: row.id } : null;
    }
    if (sql.startsWith('SELECT * FROM encrypted_backups')) {
      const [id, userId] = bindings;
      const row = this.backups.get(id);
      return row && row.user_id === userId ? { ...row } : null;
    }
    if (sql.startsWith('SELECT object_key FROM encrypted_backups')) {
      const [id, userId] = bindings;
      const row = this.backups.get(id);
      return row && row.user_id === userId ? { object_key: row.object_key } : null;
    }
    throw new Error(`Unhandled D1 first(): ${sql}`);
  }

  async all(sql, bindings) {
    if (sql.startsWith('DELETE FROM encrypted_backups') && sql.includes('RETURNING object_key')) {
      if (this.failNextRetention > 0) {
        this.failNextRetention -= 1;
        throw new Error('injected retention failure');
      }
      const [outerUserId, innerUserId, retention] = bindings;
      assert.equal(outerUserId, innerUserId);
      const rows = [...this.backups.values()]
        .filter(row => row.user_id === innerUserId)
        .sort((left, right) => right.created_at - left.created_at || right._rowid - left._rowid);
      const expired = rows.slice(Number(retention));
      for (const row of expired) this.backups.delete(row.id);
      return { results: expired.map(row => ({ object_key: row.object_key })) };
    }
    if (sql === 'SELECT id, object_key FROM encrypted_backups WHERE user_id = ?') {
      const [userId] = bindings;
      return {
        results: [...this.backups.values()]
          .filter(row => row.user_id === userId)
          .map(row => ({ id: row.id, object_key: row.object_key })),
      };
    }
    if (sql.includes('SELECT id, created_at, client_created_at, device_name, size_bytes, sha256,')) {
      const [userId, limit] = bindings;
      return {
        results: [...this.backups.values()]
          .filter(row => row.user_id === userId)
          .sort((left, right) => right.created_at - left.created_at || right._rowid - left._rowid)
          .slice(0, Number(limit))
          .map(row => ({ ...row })),
      };
    }
    throw new Error(`Unhandled D1 all(): ${sql}`);
  }

  async run(sql, bindings) {
    if (sql.startsWith('INSERT INTO service_rate_windows')) {
      const [userId, service, windowStartedAt, now] = bindings;
      const key = `${userId}:${service}`;
      const current = this.rateWindows.get(key);
      this.rateWindows.set(key, {
        user_id: userId,
        service,
        window_started_at: windowStartedAt,
        request_count: current && current.window_started_at === windowStartedAt
          ? current.request_count + 1 : 1,
        updated_at: now,
      });
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO encrypted_backups')) {
      if (this.failNextBackupInsert > 0) {
        this.failNextBackupInsert -= 1;
        throw new Error('injected backup insert failure');
      }
      const [
        id, userId, objectKey, createdAt, clientCreatedAt, deviceId, deviceName,
        sizeBytes, sha256, keyFingerprint, appVersion,
      ] = bindings;
      if (this.backups.has(id)) throw new Error('UNIQUE constraint failed: encrypted_backups.id');
      this.backups.set(id, {
        id,
        user_id: userId,
        object_key: objectKey,
        created_at: createdAt,
        client_created_at: clientCreatedAt,
        device_id: deviceId,
        device_name: deviceName,
        size_bytes: sizeBytes,
        sha256,
        key_fingerprint: keyFingerprint,
        format_version: 1,
        app_version: appVersion,
        _rowid: this.nextRowId++,
      });
      return { success: true };
    }
    if (sql.startsWith('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')) {
      if (this.failNextBackupDelete > 0) {
        this.failNextBackupDelete -= 1;
        throw new Error('injected backup delete failure');
      }
      const [id, userId] = bindings;
      const row = this.backups.get(id);
      if (row && row.user_id === userId) this.backups.delete(id);
      return { success: true };
    }
    throw new Error(`Unhandled D1 run(): ${sql}`);
  }
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.putCount = 0;
    this.deleteCount = 0;
    this.failNextPut = 0;
    this.failNextDelete = 0;
    this.failNextBodyRead = 0;
    this.omitNextPutChecksum = 0;
  }

  objectView(entry, withBody = false) {
    const view = {
      key: entry.key,
      version: entry.version,
      size: entry.bytes.length,
      uploaded: entry.uploaded,
      checksums: entry.checksums,
      customMetadata: entry.customMetadata,
      httpMetadata: entry.httpMetadata,
    };
    if (withBody) {
      const snapshot = Uint8Array.from(entry.bytes);
      view.body = new Response(snapshot).body;
      view.arrayBuffer = async () => copyBuffer(snapshot);
    }
    return view;
  }

  async put(key, value, options = {}) {
    this.putCount += 1;
    if (this.failNextPut > 0) {
      this.failNextPut -= 1;
      throw new Error('injected R2 put failure');
    }
    if (options.onlyIf && options.onlyIf.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = Uint8Array.from(new Uint8Array(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    if (options.sha256) {
      assert.equal(Buffer.from(options.sha256).toString('hex'), Buffer.from(digest).toString('hex'));
    }
    // The real R2 condition is atomic. Check again after the asynchronous digest so this mock also
    // exercises simultaneous same-key puts correctly.
    if (options.onlyIf && options.onlyIf.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const omit = this.omitNextPutChecksum > 0;
    if (omit) this.omitNextPutChecksum -= 1;
    const entry = {
      key,
      version: `version-${this.putCount}`,
      bytes,
      uploaded: new Date(),
      checksums: omit ? {} : { sha256: copyBuffer(digest) },
      customMetadata: { ...(options.customMetadata || {}) },
      httpMetadata: { ...(options.httpMetadata || {}) },
      putOptions: options,
    };
    this.objects.set(key, entry);
    return this.objectView(entry);
  }

  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const view = this.objectView(entry, true);
    if (this.failNextBodyRead > 0) {
      this.failNextBodyRead -= 1;
      view.arrayBuffer = async () => { throw new Error('injected R2 body read failure'); };
    }
    return view;
  }

  async delete(keys) {
    this.deleteCount += 1;
    if (this.failNextDelete > 0) {
      this.failNextDelete -= 1;
      throw new Error('injected R2 delete failure');
    }
    for (const key of (Array.isArray(keys) ? keys : [keys])) this.objects.delete(key);
  }

  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    const page = keys.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      objects: page.map(key => this.objectView(this.objects.get(key))),
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }
}

function backupId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function encryptedEnvelope(id, createdAt, appVersion = APP_VERSION) {
  const header = {
    formatVersion: 1,
    backupId: id,
    createdAt,
    appVersion,
    keyFingerprint: FINGERPRINT,
    compression: 'gzip',
    encryption: 'AES-256-GCM',
    salt: Buffer.alloc(16, 7).toString('base64url'),
    nonce: Buffer.alloc(12, 9).toString('base64url'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  return Buffer.concat([
    Buffer.from('RCARTB1\0', 'ascii'),
    headerLength,
    headerBytes,
    Buffer.from([0x9d, 0x42, 0xa1]),
    Buffer.alloc(16, 0x5a),
  ]);
}

async function environment(overrides = {}) {
  const DB = new MemoryD1();
  const BACKUPS = new MemoryR2();
  DB.users.set('user-a', { id: 'user-a', email: 'a@example.com', active: 1 });
  DB.users.set('user-b', { id: 'user-b', email: 'b@example.com', active: 1 });
  DB.licenses.push(
    {
      id: 'license-a', user_id: 'user-a', token_hash: await sha256Hex(TOKEN_A),
      device_id: DEVICE_A, device_name: 'Mac A', expires_at: Date.now() + 60_000, revoked_at: null,
    },
    {
      id: 'license-b', user_id: 'user-b', token_hash: await sha256Hex(TOKEN_B),
      device_id: DEVICE_B, device_name: 'Windows B', expires_at: Date.now() + 60_000, revoked_at: null,
    },
    {
      id: 'license-revoked', user_id: 'user-a', token_hash: await sha256Hex(TOKEN_REVOKED),
      device_id: DEVICE_A, device_name: 'Revoked', expires_at: Date.now() + 60_000,
      revoked_at: Date.now(),
    },
  );
  return { DB, BACKUPS, ...overrides };
}

function requestHeaders(token, deviceId) {
  return {
    authorization: `Bearer ${token}`,
    'x-rcart-device-id': deviceId,
  };
}

function uploadRequest({ id, createdAt, bytes, token = TOKEN_A, deviceId = DEVICE_A }) {
  return new Request(`https://license.zynbot.app/api/backups/${id}`, {
    method: 'PUT',
    headers: {
      ...requestHeaders(token, deviceId),
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-rcart-created-at': String(createdAt),
      'x-rcart-key-fingerprint': FINGERPRINT,
      'x-rcart-app-version': APP_VERSION,
    },
    body: bytes,
  });
}

function backupRequest(method, id, token = TOKEN_A, deviceId = DEVICE_A) {
  return new Request(`https://license.zynbot.app/api/backups/${id}`, {
    method,
    headers: requestHeaders(token, deviceId),
  });
}

function listRequest(token = TOKEN_A, deviceId = DEVICE_A) {
  return new Request('https://license.zynbot.app/api/backups', {
    headers: requestHeaders(token, deviceId),
  });
}

async function upload(env, index, options = {}) {
  const id = backupId(index);
  const createdAt = 1_800_000_000_000 + index;
  const bytes = encryptedEnvelope(id, createdAt);
  const response = await worker.fetch(uploadRequest({ id, createdAt, bytes, ...options }), env);
  return { id, createdAt, bytes, response };
}

test('backup API confines active devices and user-owned objects', async () => {
  const env = await environment();
  const saved = await upload(env, 1);
  assert.equal(saved.response.status, 201);

  const unauthorizedPutCount = env.BACKUPS.putCount;
  const wrongDeviceUpload = await upload(env, 2, { token: TOKEN_A, deviceId: DEVICE_B });
  assert.equal(wrongDeviceUpload.response.status, 401);
  const revokedUpload = await upload(env, 3, { token: TOKEN_REVOKED, deviceId: DEVICE_A });
  assert.equal(revokedUpload.response.status, 401);
  assert.equal(env.BACKUPS.putCount, unauthorizedPutCount, 'unauthorized uploads reached R2');

  const wrongDevice = await worker.fetch(backupRequest('GET', saved.id, TOKEN_A, DEVICE_B), env);
  assert.equal(wrongDevice.status, 401);
  assert.equal((await wrongDevice.json()).code, 'license_invalid');

  const revoked = await worker.fetch(backupRequest('GET', saved.id, TOKEN_REVOKED, DEVICE_A), env);
  assert.equal(revoked.status, 401);

  const crossAccount = await worker.fetch(backupRequest('GET', saved.id, TOKEN_B, DEVICE_B), env);
  assert.equal(crossAccount.status, 404);
  const crossDelete = await worker.fetch(backupRequest('DELETE', saved.id, TOKEN_B, DEVICE_B), env);
  assert.equal(crossDelete.status, 404);
  assert.equal(env.DB.backups.has(saved.id), true);
});

test('backup upload rejects plaintext, rate-limits before R2, and records SHA-256 metadata', async () => {
  const env = await environment({ BACKUP_UPLOAD_RATE_MAX_REQUESTS: '2' });
  const raw = Buffer.from(JSON.stringify({ profiles: [], password: 'must-not-upload' }));
  for (let index = 10; index < 12; index += 1) {
    const response = await worker.fetch(uploadRequest({
      id: backupId(index), createdAt: 1_800_000_000_000 + index, bytes: raw,
    }), env);
    assert.equal(response.status, 400);
  }
  const limited = await worker.fetch(uploadRequest({
    id: backupId(12), createdAt: 1_800_000_000_012, bytes: encryptedEnvelope(backupId(12), 1_800_000_000_012),
  }), env);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'backup_rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(env.BACKUPS.putCount, 0, 'rate limit must run before an R2 write');

  const storedEnv = await environment();
  const saved = await upload(storedEnv, 13);
  assert.equal(saved.response.status, 201);
  const objectKey = `backups/user-a/${saved.id}.rcb`;
  const object = storedEnv.BACKUPS.objects.get(objectKey);
  const expectedSha = await sha256Hex(saved.bytes);
  assert.equal(object.customMetadata.integrityVersion, '1');
  assert.equal(object.customMetadata.sha256, expectedSha);
  assert.equal(object.customMetadata.sizeBytes, String(saved.bytes.length));
  assert.equal(Buffer.from(object.putOptions.sha256).toString('hex'), expectedSha);
  assert.equal(Buffer.from(object.checksums.sha256).toString('hex'), expectedSha);

  const downloaded = await worker.fetch(backupRequest('GET', saved.id), storedEnv);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('x-rcart-backup-sha256'), expectedSha);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), saved.bytes);
});

test('download verifies legacy and current objects, then removes corrupt bytes or metadata', async () => {
  const legacyEnv = await environment();
  const legacy = await upload(legacyEnv, 20);
  assert.equal(legacy.response.status, 201);
  const legacyObject = legacyEnv.BACKUPS.objects.get(`backups/user-a/${legacy.id}.rcb`);
  legacyObject.customMetadata = { keyFingerprint: FINGERPRINT, formatVersion: '1' };
  legacyObject.checksums = {};
  const legacyDownload = await worker.fetch(backupRequest('GET', legacy.id), legacyEnv);
  assert.equal(legacyDownload.status, 200, 'pre-integrity-metadata objects must remain readable');

  const corruptEnv = await environment();
  const corrupt = await upload(corruptEnv, 21);
  const corruptKey = `backups/user-a/${corrupt.id}.rcb`;
  const corruptObject = corruptEnv.BACKUPS.objects.get(corruptKey);
  corruptObject.bytes[corruptObject.bytes.length - 1] ^= 0xff;
  const rejected = await worker.fetch(backupRequest('GET', corrupt.id), corruptEnv);
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.json()).code, 'backup_integrity_failed');
  assert.equal(corruptEnv.BACKUPS.objects.has(corruptKey), false);
  assert.equal(corruptEnv.DB.backups.has(corrupt.id), false);

  const metadataEnv = await environment();
  const metadata = await upload(metadataEnv, 22);
  const metadataKey = `backups/user-a/${metadata.id}.rcb`;
  metadataEnv.BACKUPS.objects.get(metadataKey).customMetadata.sha256 = '0'.repeat(64);
  const metadataRejected = await worker.fetch(backupRequest('GET', metadata.id), metadataEnv);
  assert.equal(metadataRejected.status, 502);
  assert.equal(metadataEnv.BACKUPS.objects.has(metadataKey), false);
  assert.equal(metadataEnv.DB.backups.has(metadata.id), false);

  const transientEnv = await environment();
  const transient = await upload(transientEnv, 23);
  const transientKey = `backups/user-a/${transient.id}.rcb`;
  transientEnv.BACKUPS.failNextBodyRead = 1;
  const transientRejected = await worker.fetch(backupRequest('GET', transient.id), transientEnv);
  assert.equal(transientRejected.status, 503);
  assert.equal((await transientRejected.json()).code, 'backup_read_failed');
  assert.equal(transientEnv.BACKUPS.objects.has(transientKey), true,
    'a transient body read deleted the encrypted object');
  assert.equal(transientEnv.DB.backups.has(transient.id), true,
    'a transient body read deleted the backup metadata');
});

test('concurrent uploads retain exactly ten revisions', async () => {
  const env = await environment();
  const duplicate = await Promise.all([upload(env, 90), upload(env, 90)]);
  assert.deepEqual(duplicate.map(item => item.response.status).sort(), [201, 409]);
  assert.equal([...env.DB.backups.values()].filter(row => row.id === backupId(90)).length, 1);
  assert.equal(env.BACKUPS.objects.has(`backups/user-a/${backupId(90)}.rcb`), true);

  const uploaded = await Promise.all(Array.from({ length: 12 }, (_, offset) => upload(env, 100 + offset)));
  assert.deepEqual(uploaded.map(item => item.response.status), Array(12).fill(201));
  assert.equal([...env.DB.backups.values()].filter(row => row.user_id === 'user-a').length, 10);
  assert.equal([...env.BACKUPS.objects.keys()].filter(key => key.startsWith('backups/user-a/')).length, 10);

  const listed = await worker.fetch(listRequest(), env);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).backups.length, 10);
});

test('partial R2/D1 failures roll back or reconcile inaccessible orphans', async () => {
  const rollbackEnv = await environment();
  rollbackEnv.DB.failNextBackupInsert = 1;
  const failedInsert = await upload(rollbackEnv, 200);
  assert.equal(failedInsert.response.status, 500);
  assert.equal(rollbackEnv.DB.backups.has(failedInsert.id), false);
  assert.equal(rollbackEnv.BACKUPS.objects.has(`backups/user-a/${failedInsert.id}.rcb`), false);

  const orphanEnv = await environment();
  orphanEnv.DB.failNextBackupInsert = 1;
  orphanEnv.BACKUPS.failNextDelete = 1;
  const orphaned = await upload(orphanEnv, 201);
  assert.equal(orphaned.response.status, 500);
  const orphanKey = `backups/user-a/${orphaned.id}.rcb`;
  assert.equal(orphanEnv.BACKUPS.objects.has(orphanKey), true);
  orphanEnv.BACKUPS.objects.get(orphanKey).uploaded = new Date(Date.now() - 10 * 60 * 1000);
  const reconciled = await worker.fetch(listRequest(), orphanEnv);
  assert.equal(reconciled.status, 200);
  assert.equal(orphanEnv.BACKUPS.objects.has(orphanKey), false);

  const putEnv = await environment();
  putEnv.BACKUPS.failNextPut = 1;
  const failedPut = await upload(putEnv, 202);
  assert.equal(failedPut.response.status, 500);
  assert.equal(putEnv.DB.backups.has(failedPut.id), false);

  const checksumEnv = await environment();
  checksumEnv.BACKUPS.omitNextPutChecksum = 1;
  const unconfirmedChecksum = await upload(checksumEnv, 203);
  assert.equal(unconfirmedChecksum.response.status, 500);
  assert.equal(checksumEnv.DB.backups.has(unconfirmedChecksum.id), false);
  assert.equal(checksumEnv.BACKUPS.objects.has(`backups/user-a/${unconfirmedChecksum.id}.rcb`), false);

  const retentionEnv = await environment();
  for (let index = 210; index < 220; index += 1) {
    const result = await upload(retentionEnv, index);
    assert.equal(result.response.status, 201);
  }
  retentionEnv.BACKUPS.failNextDelete = 1;
  const overflow = await upload(retentionEnv, 220);
  assert.equal(overflow.response.status, 201, 'committed upload must not be retried after maintenance failure');
  assert.equal(retentionEnv.DB.backups.size, 10);
  assert.equal(retentionEnv.BACKUPS.objects.size, 11);
  const referenced = new Set([...retentionEnv.DB.backups.values()].map(row => row.object_key));
  const staleKey = [...retentionEnv.BACKUPS.objects.keys()].find(key => !referenced.has(key));
  assert.ok(staleKey);
  retentionEnv.BACKUPS.objects.get(staleKey).uploaded = new Date(Date.now() - 10 * 60 * 1000);
  const cleanup = await worker.fetch(listRequest(), retentionEnv);
  assert.equal(cleanup.status, 200);
  assert.equal(retentionEnv.BACKUPS.objects.size, 10);

  const missingObjectEnv = await environment();
  const missingObject = await upload(missingObjectEnv, 230);
  assert.equal(missingObject.response.status, 201);
  missingObjectEnv.BACKUPS.objects.delete(`backups/user-a/${missingObject.id}.rcb`);
  const missingCleanup = await worker.fetch(listRequest(), missingObjectEnv);
  assert.equal(missingCleanup.status, 200);
  assert.equal(missingObjectEnv.DB.backups.has(missingObject.id), false);
  assert.deepEqual((await missingCleanup.json()).backups, []);
});
