const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100000;
const LICENSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 20 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_SESSION_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_BLOCK_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const MAX_PROXY_LIST_BYTES = 5 * 1024 * 1024;
const MAX_PROXY_LINES = 50000;
const MAX_MANAGED_LISTS = 20;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const BACKUP_RETENTION = 10;
// D1 limits both a string and a complete row to 2,000,000 bytes. Keep headroom for the remaining
// columns and AES-GCM/base64 overhead; unusually incompressible pools get a useful split-list error.
const MAX_STORED_PROXY_CHARS = 1800000;
const COMPRESSED_PROXY_PREFIX = 'gz1:';
const DOWNLOAD_SITE_ORIGIN = 'https://rcart.app';
// Target is the always-available base module. Optional task types are registered here and inserted
// into D1 on first use, so adding a future module does not require another schema redesign.
const TASK_TYPE_REGISTRY = Object.freeze([
  { key: 'pokemoncenter', label: 'Pokémon Center' },
  { key: 'round1', label: 'Round1' },
]);
let taskTypeRegistryEnsured = false;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%*-_';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function proxyEncryptionKey(env) {
  const bytes = base64UrlToBytes(String(env.PROXY_ENCRYPTION_KEY || ''));
  if (bytes.length !== 32) throw new Error('Managed proxy encryption key is not configured.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encryptProxyList(raw, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const compressed = await gzipBytes(encoder.encode(raw));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await proxyEncryptionKey(env),
    compressed,
  );
  const encryptedRaw = `${COMPRESSED_PROXY_PREFIX}${bytesToBase64Url(new Uint8Array(encrypted))}`;
  if (encryptedRaw.length > MAX_STORED_PROXY_CHARS) {
    const error = new Error('That proxy list cannot fit in encrypted storage even after compression. Split it into two managed lists.');
    error.code = 'PROXY_STORAGE_LIMIT';
    throw error;
  }
  return { encryptedRaw, iv: bytesToBase64Url(iv) };
}

async function decryptProxyList(row, env) {
  const stored = String(row.encrypted_raw || '');
  const compressed = stored.startsWith(COMPRESSED_PROXY_PREFIX);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(row.iv) },
    await proxyEncryptionKey(env),
    base64UrlToBytes(compressed ? stored.slice(COMPRESSED_PROXY_PREFIX.length) : stored),
  );
  return decoder.decode(compressed ? await gunzipBytes(new Uint8Array(plain)) : plain);
}

function proxyListInput(body) {
  const name = String(body && body.name || '').trim();
  const source = String(body && body.raw || '').replace(/\r/g, '');
  if (!name || name.length > 80) return { error: 'Use a list name between 1 and 80 characters.' };
  if (encoder.encode(source).length > MAX_PROXY_LIST_BYTES) {
    return { error: 'That proxy list is too large (5 MB maximum).' };
  }
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Paste at least one proxy.' };
  if (lines.length > MAX_PROXY_LINES) return { error: `A list can contain at most ${MAX_PROXY_LINES} proxies.` };
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split(':');
    const port = Number(parts[1]);
    if (![2, 4].includes(parts.length) || !parts[0] || !Number.isInteger(port)
        || port < 1 || port > 65535 || (parts.length === 4 && (!parts[2] || !parts[3]))) {
      return { error: `Line ${index + 1} must use host:port or host:port:user:pass.` };
    }
  }
  return { name, raw: lines.join('\n'), count: lines.length };
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] || 0) ^ (b[index] || 0);
  return mismatch === 0;
}

async function passwordHash(password, salt, pepper, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${password}\0${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations,
  }, material, 256);
  return bytesToHex(bits);
}

async function newPasswordRecord(password, env) {
  const salt = randomToken(16);
  return {
    salt,
    hash: await passwordHash(password, salt, env.PASSWORD_PEPPER, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS,
  };
}

async function verifyPassword(password, user, env) {
  const hash = await passwordHash(password, user.password_salt, env.PASSWORD_PEPPER, user.password_iterations);
  return constantTimeEqual(hash, user.password_hash);
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validDeviceId(value) {
  return /^[a-f0-9]{16,128}$/i.test(String(value || ''));
}

function apiHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: apiHeaders(headers) });
}

async function bodyJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new Error('JSON body required');
  return request.json();
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function rateKey(kind, identity, request) {
  return sha256(`${kind}:${String(identity || '').toLowerCase()}:${clientIp(request)}`);
}

async function rateBlocked(env, key, now) {
  const row = await env.DB.prepare(
    'SELECT failures, window_started_at, blocked_until FROM auth_attempts WHERE key = ?',
  ).bind(key).first();
  if (!row) return 0;
  if (row.blocked_until > now) return Math.ceil((row.blocked_until - now) / 1000);
  if (now - row.window_started_at > RATE_WINDOW_MS) {
    await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
  }
  return 0;
}

async function rateFailure(env, key, now) {
  const row = await env.DB.prepare(
    'SELECT failures, window_started_at FROM auth_attempts WHERE key = ?',
  ).bind(key).first();
  const inWindow = row && now - row.window_started_at <= RATE_WINDOW_MS;
  const failures = inWindow ? row.failures + 1 : 1;
  const windowStarted = inWindow ? row.window_started_at : now;
  const blockedUntil = failures >= RATE_MAX_FAILURES ? now + RATE_BLOCK_MS : 0;
  await env.DB.prepare(`
    INSERT INTO auth_attempts (key, failures, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures,
      window_started_at = excluded.window_started_at,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at
  `).bind(key, failures, windowStarted, blockedUntil, now).run();
}

async function rateSuccess(env, key) {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}

async function managedProxyRows(env) {
  const result = await env.DB.prepare(`
    SELECT id, name, encrypted_raw, iv, proxy_count, updated_at
    FROM managed_proxy_lists ORDER BY name COLLATE NOCASE
  `).all();
  return result.results || [];
}

async function managedProxyRevision(rows) {
  return sha256(rows.map(row => [
    String(row.id || ''), String(row.name || ''), Number(row.proxy_count) || 0, Number(row.updated_at) || 0,
  ].join(':')).join('\n'));
}

async function managedProxyListsForUser(env, proxyAccess, rows = null) {
  if (!Number(proxyAccess)) return [];
  const lists = [];
  for (const row of (rows || await managedProxyRows(env))) {
    try {
      lists.push({
        id: row.id,
        name: row.name,
        raw: await decryptProxyList(row, env),
        count: Number(row.proxy_count) || 0,
        updatedAt: Number(row.updated_at) || 0,
      });
    } catch (error) {
      // A damaged/old row must not invalidate the user's license. Skip only that list and keep the
      // app usable while recording enough context for the operator to replace it.
      console.error(`managed proxy list ${row.id} could not be decrypted`, error && error.message);
    }
  }
  return lists;
}

function defaultTaskTypeAccess() {
  return Object.fromEntries(TASK_TYPE_REGISTRY.map(type => [type.key, false]));
}

async function ensureTaskTypeRegistry(env) {
  if (taskTypeRegistryEnsured) return;
  const now = Date.now();
  await env.DB.batch(TASK_TYPE_REGISTRY.map(type => env.DB.prepare(`
    INSERT OR IGNORE INTO task_types (key, label, enabled_for_all, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).bind(type.key, type.label, now, now)));
  taskTypeRegistryEnsured = true;
}

async function taskTypeDefinitions(env) {
  await ensureTaskTypeRegistry(env);
  const result = await env.DB.prepare(`
    SELECT key, label, enabled_for_all, updated_at
    FROM task_types ORDER BY label COLLATE NOCASE
  `).all();
  const supported = new Set(TASK_TYPE_REGISTRY.map(type => type.key));
  return (result.results || []).filter(type => supported.has(type.key)).map(type => ({
    key: type.key,
    label: type.label,
    enabledForAll: Number(type.enabled_for_all) === 1,
    updatedAt: Number(type.updated_at) || 0,
  }));
}

async function taskTypeEntitlements(env, user) {
  const access = defaultTaskTypeAccess();
  const userId = String(user && (user.id || user.user_id) || '');
  if (!userId) return access;
  try {
    const definitions = await taskTypeDefinitions(env);
    const overrides = await env.DB.prepare(`
      SELECT task_type, enabled FROM user_task_type_access WHERE user_id = ?
    `).bind(userId).all();
    const byType = new Map((overrides.results || []).map(row => [row.task_type, Number(row.enabled) === 1]));
    for (const type of definitions) {
      access[type.key] = byType.has(type.key) ? byType.get(type.key) : type.enabledForAll;
    }
  } catch (error) {
    // A desktop deployed just before the migration must fail closed for optional modules without
    // locking every user out of the base Target app.
    console.error('task type entitlements unavailable', error && error.message);
  }
  return access;
}

async function licenseEntitlements(env, user, knownRevision = '') {
  const taskTypes = await taskTypeEntitlements(env, user);
  const proxyAccess = Number(user.proxy_access) === 1;
  if (!proxyAccess) {
    return { taskTypes, proxyAccess: false, proxyRevision: '', proxyListCount: 0, proxyListsChanged: true, managedProxyLists: [] };
  }
  const rows = await managedProxyRows(env);
  const proxyRevision = await managedProxyRevision(rows);
  if (knownRevision && constantTimeEqual(knownRevision, proxyRevision)) {
    return { taskTypes, proxyAccess: true, proxyRevision, proxyListCount: rows.length, proxyListsChanged: false };
  }
  return {
    taskTypes,
    proxyAccess: true,
    proxyRevision,
    proxyListCount: rows.length,
    proxyListsChanged: true,
    managedProxyLists: await managedProxyListsForUser(env, true, rows),
  };
}

async function mintLicense(env, user, deviceId, deviceName) {
  const now = Date.now();
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const expiresAt = now + LICENSE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'new_login'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id),
    env.DB.prepare(`
      INSERT INTO licenses
        (id, user_id, token_hash, device_id, device_name, created_at, last_validated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), user.id, tokenHash, deviceId, deviceName, now, now, expiresAt),
    env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, user.id),
  ]);
  return {
    ok: true,
    licenseToken: token,
    email: user.email,
    expiresAt,
    ...await licenseEntitlements(env, user),
  };
}

async function login(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const deviceId = String(body.deviceId || '');
  const deviceName = String(body.deviceName || '').slice(0, 100);
  if (!email || !password || password.length > 256 || !validDeviceId(deviceId)) {
    return json({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' }, 401);
  }

  const now = Date.now();
  const key = await rateKey('user-login', email, request);
  const retryAfter = await rateBlocked(env, key, now);
  if (retryAfter) return json({ ok: false, code: 'rate_limited', message: 'Too many attempts. Try again later.' }, 429, { 'retry-after': String(retryAfter) });

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  let passwordOk = false;
  if (user) passwordOk = await verifyPassword(password, user, env);
  else await passwordHash(password, 'AAAAAAAAAAAAAAAAAAAAAA', env.PASSWORD_PEPPER, PASSWORD_ITERATIONS);

  if (!user || !passwordOk) {
    await rateFailure(env, key, now);
    return json({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' }, 401);
  }
  await rateSuccess(env, key);
  if (!user.active) return json({ ok: false, code: 'account_disabled', message: 'This account is disabled.' }, 403);

  if (user.must_reset_password) {
    const resetToken = randomToken(32);
    const resetHash = await sha256(resetToken);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.id),
      env.DB.prepare(`
        INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(resetHash, user.id, now, now + RESET_TTL_MS),
    ]);
    return json({
      ok: false,
      code: 'password_reset_required',
      message: 'Choose a new password to continue.',
      resetToken,
      email: user.email,
    }, 403);
  }

  return json(await mintLicense(env, user, deviceId, deviceName));
}

async function resetPassword(request, env) {
  const body = await bodyJson(request);
  const resetToken = String(body.resetToken || '');
  const password = String(body.newPassword || '');
  const deviceId = String(body.deviceId || '');
  const deviceName = String(body.deviceName || '').slice(0, 100);
  if (resetToken.length < 32 || password.length < 10 || password.length > 256 || !validDeviceId(deviceId)) {
    return json({ ok: false, code: 'invalid_reset', message: 'Use a password of at least 10 characters.' }, 400);
  }

  const tokenHash = await sha256(resetToken);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT u.* FROM password_reset_tokens r
    JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.consumed_at IS NULL AND r.expires_at > ?
  `).bind(tokenHash, now).first();
  if (!row || !row.active) return json({ ok: false, code: 'invalid_reset', message: 'This password reset has expired. Sign in again.' }, 401);

  const record = await newPasswordRecord(password, env);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
        must_reset_password = 0, updated_at = ? WHERE id = ?
    `).bind(record.hash, record.salt, record.iterations, now, row.id),
    env.DB.prepare('UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ?')
      .bind(now, tokenHash),
    env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'password_reset'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, row.id),
  ]);
  return json(await mintLicense(env, row, deviceId, deviceName));
}

function bearer(request) {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function validateLicense(request, env) {
  const token = bearer(request);
  const body = await bodyJson(request);
  const deviceId = String(body.deviceId || '');
  const knownProxyRevision = /^[a-f0-9]{64}$/i.test(String(body.proxyRevision || ''))
    ? String(body.proxyRevision).toLowerCase() : '';
  if (!token || !validDeviceId(deviceId)) return json({ ok: false, code: 'license_invalid' }, 401);

  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT l.id AS license_id, l.device_id, l.expires_at,
      u.id AS user_id, u.email, u.active, u.proxy_access
    FROM licenses l JOIN users u ON u.id = l.user_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL
  `).bind(tokenHash).first();
  if (!row || !row.active || row.device_id !== deviceId || row.expires_at <= now) {
    return json({ ok: false, code: row && !row.active ? 'account_disabled' : 'license_invalid' }, 401);
  }

  const expiresAt = now + LICENSE_TTL_MS;
  await env.DB.prepare('UPDATE licenses SET last_validated_at = ?, expires_at = ? WHERE id = ?')
    .bind(now, expiresAt, row.license_id).run();
  return json({
    ok: true,
    email: row.email,
    expiresAt,
    ...await licenseEntitlements(env, row, knownProxyRevision),
  });
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'logout'
      WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(Date.now(), tokenHash).run();
  }
  return json({ ok: true });
}

function validBackupId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function inspectBackupEnvelope(bytes) {
  const magic = [82, 67, 65, 82, 84, 66, 49, 0]; // RCARTB1\0
  if (bytes.length < magic.length + 4 + 16) return null;
  for (let index = 0; index < magic.length; index += 1) if (bytes[index] !== magic[index]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(magic.length);
  const headerStart = magic.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (headerLength < 2 || headerLength > 64 * 1024 || ciphertextStart + 16 >= bytes.length) return null;
  try {
    const header = JSON.parse(decoder.decode(bytes.subarray(headerStart, ciphertextStart)));
    if (header.formatVersion !== 1 || header.compression !== 'gzip' || header.encryption !== 'AES-256-GCM'
        || !validBackupId(header.backupId) || !/^[a-f0-9]{16}$/i.test(String(header.keyFingerprint || ''))
        || !/^[A-Za-z0-9_-]{22}$/.test(String(header.salt || ''))
        || !/^[A-Za-z0-9_-]{16}$/.test(String(header.nonce || ''))) return null;
    return header;
  } catch { return null; }
}

async function authenticatedLicense(request, env) {
  const token = bearer(request);
  const deviceId = String(request.headers.get('x-rcart-device-id') || '');
  if (!token || !validDeviceId(deviceId)) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT l.id AS license_id, l.device_id, l.device_name, l.expires_at,
      u.id AS user_id, u.email, u.active
    FROM licenses l JOIN users u ON u.id = l.user_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL
  `).bind(tokenHash).first();
  if (!row || !row.active || row.device_id !== deviceId || Number(row.expires_at) <= now) return null;
  return row;
}

function backupJson(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at) || 0,
    clientCreatedAt: Number(row.client_created_at) || 0,
    deviceName: String(row.device_name || ''),
    sizeBytes: Number(row.size_bytes) || 0,
    sha256: String(row.sha256 || ''),
    keyFingerprint: String(row.key_fingerprint || ''),
    formatVersion: Number(row.format_version) || 1,
    appVersion: String(row.app_version || ''),
  };
}

async function listBackups(request, env) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  const result = await env.DB.prepare(`
    SELECT id, created_at, client_created_at, device_name, size_bytes, sha256,
      key_fingerprint, format_version, app_version
    FROM encrypted_backups WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).bind(identity.user_id, BACKUP_RETENTION).all();
  return json({ ok: true, backups: (result.results || []).map(backupJson) });
}

async function putBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  if (!validBackupId(backupId)) return json({ ok: false, message: 'Invalid backup identifier.' }, 400);
  const type = String(request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/octet-stream')) return json({ ok: false, message: 'Encrypted backup body required.' }, 415);
  const declaredLength = Number(request.headers.get('content-length'));
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_BACKUP_BYTES) {
    return json({ ok: false, message: 'Encrypted backups must be 20 MB or smaller.' }, 413);
  }
  const keyFingerprint = String(request.headers.get('x-rcart-key-fingerprint') || '').toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(keyFingerprint)) return json({ ok: false, message: 'Invalid backup key fingerprint.' }, 400);
  const appVersion = String(request.headers.get('x-rcart-app-version') || '').slice(0, 40);
  const clientCreatedAt = Number(request.headers.get('x-rcart-created-at')) || 0;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES) {
    return json({ ok: false, message: 'Encrypted backups must be 20 MB or smaller.' }, 413);
  }
  const envelope = inspectBackupEnvelope(bytes);
  if (!envelope || envelope.backupId !== backupId || envelope.keyFingerprint !== keyFingerprint
      || Number(envelope.createdAt) !== clientCreatedAt
      || String(envelope.appVersion || '') !== appVersion) {
    return json({ ok: false, message: 'Invalid encrypted backup envelope.' }, 400);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM encrypted_backups WHERE id = ? AND user_id = ?',
  ).bind(backupId, identity.user_id).first();
  if (existing) return json({ ok: false, message: 'That backup already exists.' }, 409);

  const now = Date.now();
  const objectKey = `backups/${identity.user_id}/${backupId}.rcb`;
  const digest = bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
  await env.BACKUPS.put(objectKey, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { keyFingerprint, formatVersion: '1' },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO encrypted_backups
        (id, user_id, object_key, created_at, client_created_at, device_id, device_name,
          size_bytes, sha256, key_fingerprint, format_version, app_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      backupId, identity.user_id, objectKey, now, clientCreatedAt,
      identity.device_id, String(identity.device_name || '').slice(0, 100),
      bytes.length, digest, keyFingerprint, appVersion,
    ).run();
  } catch (error) {
    await env.BACKUPS.delete(objectKey);
    throw error;
  }

  // Keep a small revision history. Each object has a unique id, so two devices can upload without
  // overwriting one another; retention is applied by the server's receipt time.
  const expired = await env.DB.prepare(`
    SELECT id, object_key FROM encrypted_backups WHERE user_id = ?
    ORDER BY created_at DESC LIMIT -1 OFFSET ?
  `).bind(identity.user_id, BACKUP_RETENTION).all();
  for (const old of (expired.results || [])) {
    await env.BACKUPS.delete(old.object_key);
    await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
      .bind(old.id, identity.user_id).run();
  }

  return json({
    ok: true,
    backup: backupJson({
      id: backupId,
      created_at: now,
      client_created_at: clientCreatedAt,
      device_name: identity.device_name,
      size_bytes: bytes.length,
      sha256: digest,
      key_fingerprint: keyFingerprint,
      format_version: 1,
      app_version: appVersion,
    }),
  }, 201);
}

async function getBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  const row = await env.DB.prepare(`
    SELECT * FROM encrypted_backups WHERE id = ? AND user_id = ?
  `).bind(backupId, identity.user_id).first();
  if (!row) return json({ ok: false, message: 'Backup not found.' }, 404);
  const object = await env.BACKUPS.get(row.object_key);
  if (!object) {
    await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
      .bind(backupId, identity.user_id).run();
    return json({ ok: false, message: 'Backup not found.' }, 404);
  }
  return new Response(object.body, {
    headers: apiHeaders({
      'content-type': 'application/octet-stream',
      'content-length': String(row.size_bytes),
      'x-rcart-backup-sha256': String(row.sha256),
    }),
  });
}

async function deleteBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  const row = await env.DB.prepare(
    'SELECT object_key FROM encrypted_backups WHERE id = ? AND user_id = ?',
  ).bind(backupId, identity.user_id).first();
  if (!row) return json({ ok: false, message: 'Backup not found.' }, 404);
  await env.BACKUPS.delete(row.object_key);
  await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
    .bind(backupId, identity.user_id).run();
  return json({ ok: true });
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function adminCookie(env) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_MS, nonce: randomToken(12) })));
  return `${payload}.${await hmac(payload, env.ADMIN_SESSION_SECRET)}`;
}

function cookieValue(request, name) {
  for (const pair of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

async function adminAuthorized(request, env) {
  const value = cookieValue(request, 'hope_admin');
  const [payload, signature] = value.split('.');
  if (!payload || !signature || !constantTimeEqual(signature, await hmac(payload, env.ADMIN_SESSION_SECRET))) return false;
  try {
    const session = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return Number(session.exp) > Date.now();
  } catch {
    return false;
  }
}

function adminSetCookie(value, maxAge = Math.floor(ADMIN_SESSION_MS / 1000)) {
  return `hope_admin=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function audit(env, action, user = null, detail = '') {
  await env.DB.prepare(`
    INSERT INTO admin_audit (id, action, target_user_id, target_email, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), action, user && user.id, user && user.email, detail, Date.now()).run();
}

async function mintDownloadLink(env, user) {
  if (!Number(user.active)) {
    const error = new Error('Enable this account before generating a download link.');
    error.code = 'ACCOUNT_DISABLED';
    throw error;
  }
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + DOWNLOAD_ACCESS_TTL_MS;
  await env.DB.batch([
    // Only the newest unused invitation remains valid. Consumed rows are retained for the audit
    // trail until normal database maintenance removes them.
    env.DB.prepare(`
      DELETE FROM download_access_tokens WHERE user_id = ? AND consumed_at IS NULL
    `).bind(user.id),
    env.DB.prepare(`
      INSERT INTO download_access_tokens
        (id, user_id, token_hash, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).bind(crypto.randomUUID(), user.id, await sha256(token), now, expiresAt),
  ]);
  await audit(env, 'download_link_generated', user, String(expiresAt));
  const origin = String(env.DOWNLOAD_SITE_ORIGIN || DOWNLOAD_SITE_ORIGIN).replace(/\/+$/, '');
  return {
    downloadUrl: `${origin}/download?key=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

async function createDownloadLink(env, user) {
  try {
    return json({ ok: true, ...await mintDownloadLink(env, user) });
  } catch (error) {
    if (error && error.code === 'ACCOUNT_DISABLED') return json({ ok: false, message: error.message }, 409);
    throw error;
  }
}

function validOpaqueToken(value) {
  return /^[A-Za-z0-9_-]{40,128}$/.test(String(value || ''));
}

async function redeemDownloadAccess(request, env) {
  const body = await bodyJson(request);
  const token = String(body.key || '');
  const now = Date.now();

  const row = validOpaqueToken(token) ? await env.DB.prepare(`
    SELECT t.id, t.user_id
    FROM download_access_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ? AND u.active = 1
  `).bind(await sha256(token), now).first() : null;
  if (!row) {
    return json({ ok: false, code: 'invalid_download_key', message: 'This download link is invalid or has expired.' }, 401);
  }

  // The conditional update is the single-use boundary. If two requests race, exactly one can
  // consume the key and mint a browser session.
  const consumed = await env.DB.prepare(`
    UPDATE download_access_tokens SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
  `).bind(now, row.id, now).run();
  if (!Number(consumed.meta && consumed.meta.changes)) {
    return json({ ok: false, code: 'invalid_download_key', message: 'This download link is invalid or has expired.' }, 401);
  }

  const sessionToken = randomToken();
  const expiresAt = now + DOWNLOAD_SESSION_MS;
  await env.DB.prepare(`
    INSERT INTO download_sessions
      (id, user_id, session_hash, created_at, expires_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).bind(crypto.randomUUID(), row.user_id, await sha256(sessionToken), now, expiresAt, now).run();
  return json({ ok: true, sessionToken, expiresAt });
}

async function validateDownloadSession(request, env) {
  const body = await bodyJson(request);
  const sessionToken = String(body.sessionToken || '');
  if (!validOpaqueToken(sessionToken)) return json({ ok: false, code: 'download_session_invalid' }, 401);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT s.id, s.expires_at
    FROM download_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1
  `).bind(await sha256(sessionToken), now).first();
  if (!row) return json({ ok: false, code: 'download_session_invalid' }, 401);
  await env.DB.prepare('UPDATE download_sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now, row.id).run();
  return json({ ok: true, expiresAt: Number(row.expires_at) });
}

async function adminLogin(request, env) {
  const body = await bodyJson(request);
  const password = String(body.password || '');
  const now = Date.now();
  const key = await rateKey('admin-login', 'admin', request);
  const retryAfter = await rateBlocked(env, key, now);
  if (retryAfter) return json({ ok: false, message: 'Too many attempts. Try again later.' }, 429, { 'retry-after': String(retryAfter) });

  const supplied = await sha256(password);
  const expected = await sha256(env.ADMIN_PASSWORD || randomToken());
  if (!constantTimeEqual(supplied, expected)) {
    await rateFailure(env, key, now);
    return json({ ok: false, message: 'Invalid admin password.' }, 401);
  }
  await rateSuccess(env, key);
  return json({ ok: true }, 200, { 'set-cookie': adminSetCookie(await adminCookie(env)) });
}

async function adminUsers(env) {
  const [result, taskTypes, overrideResult] = await Promise.all([
    env.DB.prepare(`
    SELECT u.id, u.email, u.active, u.proxy_access, u.must_reset_password,
      u.created_at, u.updated_at, u.last_login_at,
      SUM(CASE WHEN l.revoked_at IS NULL AND l.expires_at > ? THEN 1 ELSE 0 END) AS active_licenses,
      MAX(l.last_validated_at) AS last_validated_at
    FROM users u LEFT JOIN licenses l ON l.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).bind(Date.now()).all(),
    taskTypeDefinitions(env),
    env.DB.prepare('SELECT user_id, task_type, enabled FROM user_task_type_access').all(),
  ]);
  const overridesByUser = new Map();
  for (const row of (overrideResult.results || [])) {
    if (!overridesByUser.has(row.user_id)) overridesByUser.set(row.user_id, new Map());
    overridesByUser.get(row.user_id).set(row.task_type, Number(row.enabled) === 1);
  }
  const users = (result.results || []).map(user => {
    const overrides = overridesByUser.get(user.id) || new Map();
    return {
      ...user,
      task_types: Object.fromEntries(taskTypes.map(type => {
        const override = overrides.has(type.key) ? overrides.get(type.key) : null;
        return [type.key, {
          override,
          enabled: override === null ? type.enabledForAll : override,
        }];
      })),
    };
  });
  return json({ ok: true, taskTypes, users });
}

async function adminTaskTypes(env) {
  return json({ ok: true, taskTypes: await taskTypeDefinitions(env) });
}

async function updateTaskType(request, env, key) {
  const supported = TASK_TYPE_REGISTRY.find(type => type.key === key);
  if (!supported) return json({ ok: false, message: 'Task type not found.' }, 404);
  const body = await bodyJson(request);
  if (typeof body.enabledForAll !== 'boolean') {
    return json({ ok: false, message: 'enabledForAll must be true or false.' }, 400);
  }
  await ensureTaskTypeRegistry(env);
  const now = Date.now();
  const statements = [env.DB.prepare(`
    UPDATE task_types SET enabled_for_all = ?, updated_at = ? WHERE key = ?
  `).bind(body.enabledForAll ? 1 : 0, now, key)];
  // "Enable globally" means every current user gets access immediately. Clear explicit denies;
  // the operator can add a new per-user Disabled override afterward if an exception is needed.
  if (body.enabledForAll) {
    statements.push(env.DB.prepare(`
      DELETE FROM user_task_type_access WHERE task_type = ? AND enabled = 0
    `).bind(key));
  }
  await env.DB.batch(statements);
  await audit(env, body.enabledForAll ? 'task_type_global_enabled' : 'task_type_global_disabled', null, key);
  return json({ ok: true, key, enabledForAll: body.enabledForAll });
}

async function createUserRecord(env, email, auditDetail = '') {
  const password = randomPassword();
  const record = await newPasswordRecord(password, env);
  const user = { id: crypto.randomUUID(), email };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, must_reset_password, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).bind(user.id, email, record.hash, record.salt, record.iterations, now, now).run();
  await audit(env, 'user_created', user, auditDetail);
  return {
    user: { ...user, active: 1, proxy_access: 0, must_reset_password: 1 },
    temporaryPassword: password,
  };
}

async function createUser(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, message: 'Enter a valid email address.' }, 400);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ ok: false, message: 'That email already exists.' }, 409);

  const created = await createUserRecord(env, email);
  return json({
    ok: true,
    ...created,
  }, 201);
}

async function joinWaitlist(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, message: 'Enter a valid email address.' }, 400);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO waitlist_entries (id, email, created_at, updated_at, invited_at, user_id)
    VALUES (?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), email, now, now).run();
  // Always return the same response for new and existing addresses so this public endpoint cannot
  // be used to enumerate the waiting list.
  return json({ ok: true, message: 'You are on the Zyn waiting list.' }, 202);
}

async function adminWaitlist(env) {
  const result = await env.DB.prepare(`
    SELECT w.id, w.email, w.created_at, w.updated_at, w.invited_at, w.user_id,
      u.active AS user_active, u.must_reset_password
    FROM waitlist_entries w
    LEFT JOIN users u ON u.id = w.user_id
    ORDER BY CASE WHEN w.invited_at IS NULL THEN 0 ELSE 1 END, w.created_at DESC
  `).all();
  return json({ ok: true, entries: result.results || [] });
}

async function inviteWaitlistEntry(env, id) {
  const entry = await env.DB.prepare(`
    SELECT id, email, invited_at, user_id FROM waitlist_entries WHERE id = ?
  `).bind(id).first();
  if (!entry) return json({ ok: false, message: 'Waiting-list entry not found.' }, 404);

  let user = await env.DB.prepare(`
    SELECT id, email, active, proxy_access, must_reset_password FROM users WHERE email = ?
  `).bind(entry.email).first();
  let temporaryPassword = '';
  let accountCreated = false;
  if (!user) {
    const created = await createUserRecord(env, entry.email, 'waitlist_invite');
    user = created.user;
    temporaryPassword = created.temporaryPassword;
    accountCreated = true;
  }
  if (!Number(user.active)) {
    return json({ ok: false, message: 'This email already has a disabled account. Enable it before inviting.' }, 409);
  }

  const download = await mintDownloadLink(env, user);
  const invitedAt = Date.now();
  await env.DB.prepare(`
    UPDATE waitlist_entries SET invited_at = ?, updated_at = ?, user_id = ? WHERE id = ?
  `).bind(invitedAt, invitedAt, user.id, entry.id).run();
  await audit(env, 'waitlist_invited', user, entry.id);
  return json({
    ok: true,
    entry: { ...entry, invited_at: invitedAt, user_id: user.id },
    user,
    accountCreated,
    temporaryPassword,
    ...download,
  }, accountCreated ? 201 : 200);
}

async function deleteWaitlistEntry(env, id) {
  const entry = await env.DB.prepare('SELECT id, email FROM waitlist_entries WHERE id = ?').bind(id).first();
  if (!entry) return json({ ok: false, message: 'Waiting-list entry not found.' }, 404);
  await env.DB.prepare('DELETE FROM waitlist_entries WHERE id = ?').bind(id).run();
  await audit(env, 'waitlist_entry_deleted', null, entry.email);
  return json({ ok: true });
}

async function adminUser(env, id) {
  return env.DB.prepare(
    'SELECT id, email, active, proxy_access, must_reset_password FROM users WHERE id = ?',
  ).bind(id).first();
}

async function revokeUser(env, user, reason = 'admin_revoked') {
  const result = await env.DB.prepare(`
    UPDATE licenses SET revoked_at = ?, revoked_reason = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(Date.now(), reason, user.id).run();
  await audit(env, 'licenses_revoked', user, String(result.meta && result.meta.changes || 0));
  return json({ ok: true, revoked: result.meta && result.meta.changes || 0 });
}

async function resetUserPassword(env, user) {
  const password = randomPassword();
  const record = await newPasswordRecord(password, env);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
        must_reset_password = 1, updated_at = ? WHERE id = ?
    `).bind(record.hash, record.salt, record.iterations, now, user.id),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.id),
    env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'admin_password_reset'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id),
  ]);
  await audit(env, 'password_reset_generated', user);
  return json({ ok: true, temporaryPassword: password });
}

async function updateUser(request, env, user) {
  const body = await bodyJson(request);
  const now = Date.now();
  const statements = [];
  let active = Number(user.active) === 1;
  let proxyAccess = Number(user.proxy_access) === 1;
  if (typeof body.active === 'boolean') {
    active = body.active;
    statements.push(env.DB.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?')
      .bind(active ? 1 : 0, now, user.id));
    if (!active) statements.push(env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'account_disabled'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id));
    if (!active) statements.push(env.DB.prepare(`
      UPDATE download_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id));
  }
  if (typeof body.proxyAccess === 'boolean') {
    proxyAccess = body.proxyAccess;
    statements.push(env.DB.prepare('UPDATE users SET proxy_access = ?, updated_at = ? WHERE id = ?')
      .bind(proxyAccess ? 1 : 0, now, user.id));
  }
  const taskTypeChanges = [];
  if (body.taskTypeOverrides && typeof body.taskTypeOverrides === 'object' && !Array.isArray(body.taskTypeOverrides)) {
    await ensureTaskTypeRegistry(env);
    for (const type of TASK_TYPE_REGISTRY) {
      if (!Object.hasOwn(body.taskTypeOverrides, type.key)) continue;
      const override = body.taskTypeOverrides[type.key];
      if (override === null) {
        statements.push(env.DB.prepare(`
          DELETE FROM user_task_type_access WHERE user_id = ? AND task_type = ?
        `).bind(user.id, type.key));
      } else if (typeof override === 'boolean') {
        statements.push(env.DB.prepare(`
          INSERT INTO user_task_type_access (user_id, task_type, enabled, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, task_type) DO UPDATE SET
            enabled = excluded.enabled, updated_at = excluded.updated_at
        `).bind(user.id, type.key, override ? 1 : 0, now));
      } else {
        return json({ ok: false, message: `${type.label} access must be enabled, disabled, or inherited.` }, 400);
      }
      taskTypeChanges.push({ type, override });
    }
  }
  if (!statements.length) return json({ ok: false, message: 'No supported changes supplied.' }, 400);
  await env.DB.batch(statements);
  if (typeof body.active === 'boolean') await audit(env, active ? 'user_enabled' : 'user_disabled', user);
  if (typeof body.proxyAccess === 'boolean') {
    await audit(env, proxyAccess ? 'proxy_access_enabled' : 'proxy_access_disabled', user);
  }
  for (const change of taskTypeChanges) {
    const mode = change.override === null ? 'inherit' : (change.override ? 'enabled' : 'disabled');
    await audit(env, 'user_task_type_changed', user, `${change.type.key}:${mode}`);
  }
  return json({ ok: true, active, proxyAccess, taskTypes: await taskTypeEntitlements(env, user) });
}

async function deleteUser(env, user) {
  await audit(env, 'user_deleted', user);
  try {
    const backups = await env.DB.prepare(
      'SELECT object_key FROM encrypted_backups WHERE user_id = ?',
    ).bind(user.id).all();
    for (const backup of (backups.results || [])) await env.BACKUPS.delete(backup.object_key);
  } catch (error) {
    // During a rolling deployment the table may not exist yet. No objects can exist before that
    // migration, so user deletion should still proceed.
    console.error('backup cleanup before user deletion failed', error && error.message);
  }
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return json({ ok: true });
}

async function adminProxyLists(env) {
  const result = await env.DB.prepare(`
    SELECT id, name, encrypted_raw, iv, proxy_count, created_at, updated_at
    FROM managed_proxy_lists ORDER BY name COLLATE NOCASE
  `).all();
  const lists = [];
  for (const row of (result.results || [])) {
    try {
      lists.push({
        id: row.id,
        name: row.name,
        raw: await decryptProxyList(row, env),
        count: Number(row.proxy_count) || 0,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
      });
    } catch {
      lists.push({
        id: row.id,
        name: row.name,
        raw: '',
        count: Number(row.proxy_count) || 0,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
        decryptError: true,
      });
    }
  }
  return json({ ok: true, proxyLists: lists });
}

async function createProxyList(request, env) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM managed_proxy_lists').first();
  if (Number(count && count.count) >= MAX_MANAGED_LISTS) {
    return json({ ok: false, message: `A maximum of ${MAX_MANAGED_LISTS} managed lists is supported.` }, 409);
  }
  const input = proxyListInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const existing = await env.DB.prepare('SELECT id FROM managed_proxy_lists WHERE name = ?')
    .bind(input.name).first();
  if (existing) return json({ ok: false, message: 'A proxy list with that name already exists.' }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  let encrypted;
  try { encrypted = await encryptProxyList(input.raw, env); }
  catch (error) {
    if (error && error.code === 'PROXY_STORAGE_LIMIT') return json({ ok: false, message: error.message }, 400);
    throw error;
  }
  await env.DB.prepare(`
    INSERT INTO managed_proxy_lists
      (id, name, encrypted_raw, iv, proxy_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, input.name, encrypted.encryptedRaw, encrypted.iv, input.count, now, now).run();
  await audit(env, 'proxy_list_created', null, `${input.name}:${input.count}`);
  return json({
    ok: true,
    proxyList: { id, name: input.name, count: input.count, createdAt: now, updatedAt: now },
  }, 201);
}

async function updateProxyList(request, env, id) {
  const current = await env.DB.prepare('SELECT id, name FROM managed_proxy_lists WHERE id = ?').bind(id).first();
  if (!current) return json({ ok: false, message: 'Proxy list not found.' }, 404);
  const input = proxyListInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const existing = await env.DB.prepare('SELECT id FROM managed_proxy_lists WHERE name = ? AND id != ?')
    .bind(input.name, id).first();
  if (existing) return json({ ok: false, message: 'A proxy list with that name already exists.' }, 409);
  const now = Date.now();
  let encrypted;
  try { encrypted = await encryptProxyList(input.raw, env); }
  catch (error) {
    if (error && error.code === 'PROXY_STORAGE_LIMIT') return json({ ok: false, message: error.message }, 400);
    throw error;
  }
  await env.DB.prepare(`
    UPDATE managed_proxy_lists
    SET name = ?, encrypted_raw = ?, iv = ?, proxy_count = ?, updated_at = ? WHERE id = ?
  `).bind(input.name, encrypted.encryptedRaw, encrypted.iv, input.count, now, id).run();
  await audit(env, 'proxy_list_updated', null, `${input.name}:${input.count}`);
  return json({
    ok: true,
    proxyList: { id, name: input.name, count: input.count, updatedAt: now },
  });
}

async function deleteProxyList(env, id) {
  const current = await env.DB.prepare('SELECT id, name FROM managed_proxy_lists WHERE id = ?').bind(id).first();
  if (!current) return json({ ok: false, message: 'Proxy list not found.' }, 404);
  await env.DB.prepare('DELETE FROM managed_proxy_lists WHERE id = ?').bind(id).run();
  await audit(env, 'proxy_list_deleted', null, current.name);
  return json({ ok: true });
}

async function adminRoute(request, env, url) {
  if (url.pathname === '/api/admin/login' && request.method === 'POST') return adminLogin(request, env);

  if (request.headers.get('x-hope-admin') !== '1' || !await adminAuthorized(request, env)) {
    return json({ ok: false, message: 'Admin authentication required.' }, 401);
  }
  if (url.pathname === '/api/admin/session' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': adminSetCookie('', 0) });
  }
  if (url.pathname === '/api/admin/users' && request.method === 'GET') return adminUsers(env);
  if (url.pathname === '/api/admin/users' && request.method === 'POST') return createUser(request, env);
  if (url.pathname === '/api/admin/waitlist' && request.method === 'GET') return adminWaitlist(env);
  if (url.pathname === '/api/admin/task-types' && request.method === 'GET') return adminTaskTypes(env);
  if (url.pathname === '/api/admin/proxy-lists' && request.method === 'GET') return adminProxyLists(env);
  if (url.pathname === '/api/admin/proxy-lists' && request.method === 'POST') return createProxyList(request, env);

  const proxyMatch = url.pathname.match(/^\/api\/admin\/proxy-lists\/([0-9a-f-]+)$/i);
  if (proxyMatch && request.method === 'PUT') return updateProxyList(request, env, proxyMatch[1]);
  if (proxyMatch && request.method === 'DELETE') return deleteProxyList(env, proxyMatch[1]);
  if (proxyMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const taskTypeMatch = url.pathname.match(/^\/api\/admin\/task-types\/([a-z0-9_-]+)$/i);
  if (taskTypeMatch && request.method === 'PATCH') return updateTaskType(request, env, taskTypeMatch[1].toLowerCase());
  if (taskTypeMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const waitlistMatch = url.pathname.match(/^\/api\/admin\/waitlist\/([0-9a-f-]+)(?:\/(invite))?$/i);
  if (waitlistMatch && waitlistMatch[2] === 'invite' && request.method === 'POST') {
    return inviteWaitlistEntry(env, waitlistMatch[1]);
  }
  if (waitlistMatch && !waitlistMatch[2] && request.method === 'DELETE') {
    return deleteWaitlistEntry(env, waitlistMatch[1]);
  }
  if (waitlistMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const match = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)(?:\/(revoke|reset-password|download-link))?$/i);
  if (!match) return json({ ok: false, message: 'Not found.' }, 404);
  const user = await adminUser(env, match[1]);
  if (!user) return json({ ok: false, message: 'User not found.' }, 404);
  if (match[2] === 'revoke' && request.method === 'POST') return revokeUser(env, user);
  if (match[2] === 'reset-password' && request.method === 'POST') return resetUserPassword(env, user);
  if (match[2] === 'download-link' && request.method === 'POST') return createDownloadLink(env, user);
  if (!match[2] && request.method === 'PATCH') return updateUser(request, env, user);
  if (!match[2] && request.method === 'DELETE') return deleteUser(env, user);
  return json({ ok: false, message: 'Method not allowed.' }, 405);
}

async function api(request, env, url) {
  if (url.pathname.startsWith('/api/admin/')) return adminRoute(request, env, url);
  if (url.pathname === '/api/waitlist' && request.method === 'POST') return joinWaitlist(request, env);
  if (url.pathname === '/api/download/redeem' && request.method === 'POST') return redeemDownloadAccess(request, env);
  if (url.pathname === '/api/download/session' && request.method === 'POST') return validateDownloadSession(request, env);
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (url.pathname === '/api/auth/reset-password' && request.method === 'POST') return resetPassword(request, env);
  if (url.pathname === '/api/license/validate' && request.method === 'POST') return validateLicense(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (url.pathname === '/api/backups' && request.method === 'GET') return listBackups(request, env);
  const backupMatch = url.pathname.match(/^\/api\/backups\/([0-9a-f-]+)$/i);
  if (backupMatch && request.method === 'PUT') return putBackup(request, env, backupMatch[1]);
  if (backupMatch && request.method === 'GET') return getBackup(request, env, backupMatch[1]);
  if (backupMatch && request.method === 'DELETE') return deleteBackup(request, env, backupMatch[1]);
  if (backupMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);
  return json({ ok: false, message: 'Not found.' }, 404);
}

function secureAsset(response) {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ service: 'zyn-license-api', status: 'ok' });
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname === '/' || url.pathname === '/admin') {
        return Response.redirect(`${url.origin}/admin/`, 302);
      }
      return secureAsset(await env.ASSETS.fetch(request));
    } catch (error) {
      console.error('request failed', error && error.stack || error);
      return json({ ok: false, message: 'Request failed.' }, 500);
    }
  },
};
