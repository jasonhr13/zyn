import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { __test, downloadSiteOrigin } from '../src/index.js';

test('generates canonical Zyn download links from both production admin domains', () => {
  assert.equal(downloadSiteOrigin(new Request('https://license.rcart.app/api/admin/users/1/download-link')), 'https://zynbot.app');
  assert.equal(downloadSiteOrigin(new Request('https://license.zynbot.app/api/admin/users/1/download-link')), 'https://zynbot.app');
  assert.equal(downloadSiteOrigin(
    new Request('https://license.preview.example/api/admin/users/1/download-link'),
    { DOWNLOAD_SITE_ORIGIN: 'https://preview.example/' },
  ), 'https://preview.example');
});

test('serves the license health endpoint on the Zyn domain', async () => {
  const response = await worker.fetch(new Request('https://license.zynbot.app/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'zyn-license-api', status: 'ok' });
});

test('distinguishes a replacement sign-in from revoked and expired sessions', () => {
  const active = {
    active: 1,
    device_id: 'device-a',
    expires_at: 2000,
    revoked_at: null,
    revoked_reason: null,
  };
  assert.deepEqual(__test.licenseFailure({
    ...active, revoked_at: 900, revoked_reason: 'new_login',
  }, 'device-a', 1000), {
    code: 'session_replaced',
    message: 'You were signed out because another sign-in replaced this session. Sign in again to use Zyn here.',
  });
  assert.equal(__test.licenseFailure({
    ...active, revoked_at: 900, revoked_reason: 'device_limit',
  }, 'device-a', 1000).code, 'session_replaced');
  assert.equal(__test.licenseFailure({
    ...active, revoked_at: 900, revoked_reason: 'device_limit_reduced',
  }, 'device-a', 1000).code, 'session_limit_reduced');
  assert.equal(__test.licenseFailure({
    ...active, revoked_at: 900, revoked_reason: 'expired',
  }, 'device-a', 1000).code, 'session_expired');
  assert.equal(__test.licenseFailure({
    ...active, revoked_at: 900, revoked_reason: 'admin_revoked',
  }, 'device-a', 1000).code, 'session_revoked');
  assert.equal(__test.licenseFailure({ ...active, expires_at: 999 }, 'device-a', 1000).code, 'session_expired');
  assert.equal(__test.licenseFailure(active, 'device-a', 1000), null);
  assert.equal(__test.licenseFailure(active, 'device-b', 1000).code, 'session_device_mismatch');
  assert.equal(__test.canRebindLicense(active, 1000), true);
  assert.equal(__test.canRebindLicense({ ...active, revoked_at: 900 }, 1000), false);

  const rebound = [];
  const rebindDb = {
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = { sql, bindings };
          rebound.push(statement);
          return statement;
        },
      };
    },
  };
  const rebind = __test.licenseRebindStatements(rebindDb, {
    licenseId: 'license-1',
    userId: 'user-1',
    deviceId: 'device-b',
    deviceName: 'Mac',
    now: 1000,
    expiresAt: 2000,
  });
  assert.equal(rebind.length, 2);
  assert.match(rebind[0].sql, /revoked_reason = 'new_login'/);
  assert.deepEqual(rebind[0].bindings, [1000, 'user-1', 'device-b', 'license-1']);
  assert.match(rebind[1].sql, /SET device_id = \?/);
  assert.deepEqual(rebind[1].bindings, ['device-b', 'Mac', 1000, 2000, 'license-1']);
});

test('validates active-device limits and builds an atomic per-device mint plan', () => {
  for (const value of [1, 2, 10]) assert.equal(__test.validMaxActiveDevices(value), true);
  for (const value of [0, 11, 1.5, '2', null, undefined]) {
    assert.equal(__test.validMaxActiveDevices(value), false);
  }
  assert.equal(__test.maxActiveDevicesForUser({ max_active_devices: 7 }), 7);
  assert.equal(__test.maxActiveDevicesForUser({}), 1);

  const prepared = [];
  const db = {
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = { sql, bindings };
          prepared.push(statement);
          return statement;
        },
      };
    },
  };
  const statements = __test.mintLicenseStatements(db, {
    userId: 'user-1',
    authenticatedPasswordHash: 'authenticated-password-hash',
    licenseId: 'license-new',
    tokenHash: 'token-hash',
    deviceId: '0123456789abcdef',
    deviceName: 'Mac',
    now: 1000,
    expiresAt: 2000,
  });

  assert.equal(statements.length, 5);
  assert.equal(prepared.length, 5);
  assert.match(statements[0].sql, /revoked_reason = 'expired'/);
  assert.match(statements[1].sql, /device_id = \?/);
  assert.match(statements[1].sql, /active = 1 AND must_reset_password = 0 AND password_hash = \?/);
  assert.deepEqual(statements[1].bindings, [
    1000, 'user-1', '0123456789abcdef', 'user-1', 'authenticated-password-hash',
  ]);
  assert.match(statements[2].sql, /INSERT INTO licenses/);
  assert.match(statements[2].sql, /active = 1 AND must_reset_password = 0 AND password_hash = \?/);
  assert.deepEqual(statements[2].bindings, [
    'license-new', 'token-hash', '0123456789abcdef', 'Mac', 1000, 1000, 2000,
    'user-1', 'authenticated-password-hash',
  ]);
  assert.match(statements[3].sql, /revoked_reason = \?/);
  assert.match(statements[3].sql, /last_validated_at DESC, created_at DESC, id DESC/);
  assert.match(statements[3].sql, /SELECT max_active_devices FROM users/);
  assert.deepEqual(statements[3].bindings, [
    1000, 'device_limit', 'user-1', 'user-1', 1000, 'license-new', 'user-1',
  ]);
  assert.match(statements[4].sql, /UPDATE users SET last_login_at/);
  assert.match(statements[4].sql, /password_hash = \?/);
  assert.deepEqual(statements[4].bindings, [
    1000, 1000, 'user-1', 'authenticated-password-hash',
  ]);

  const deviceLimitStatements = __test.activeDeviceLimitStatements(db, {
    userId: 'user-1',
    maxActiveDevices: 4,
    now: 3000,
  });
  assert.equal(deviceLimitStatements.length, 2);
  assert.match(deviceLimitStatements[0].sql, /UPDATE users SET max_active_devices = \?/);
  assert.deepEqual(deviceLimitStatements[0].bindings, [4, 3000, 'user-1']);
  assert.match(deviceLimitStatements[1].sql, /SELECT max_active_devices FROM users/);
  assert.deepEqual(deviceLimitStatements[1].bindings, [
    3000, 'device_limit_reduced', 'user-1', 'user-1', 3000, '', 'user-1',
  ]);
});

test('executes the active-device lifecycle against SQLite', async (context) => {
  const sqlite = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (sqlite.error && sqlite.error.code === 'ENOENT') {
    context.skip('sqlite3 is unavailable');
    return;
  }
  assert.equal(sqlite.status, 0, sqlite.stderr);

  const recordingDb = () => ({
    prepare(sql) {
      return { bind: (...bindings) => ({ sql, bindings }) };
    },
  });
  const sqlLiteral = value => {
    if (value == null) return 'NULL';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
  };
  const boundSql = statement => {
    let index = 0;
    const sql = statement.sql.replaceAll('?', () => sqlLiteral(statement.bindings[index++]));
    assert.equal(index, statement.bindings.length, 'statement binding count changed');
    return `${sql};`;
  };
  const transaction = statements => `BEGIN;\n${statements.map(boundSql).join('\n')}\nCOMMIT;`;
  const mint = ({ id, deviceId, now, expiresAt = 10_000, passwordHash = 'hash' }) => transaction(
    __test.mintLicenseStatements(recordingDb(), {
      userId: 'user-1',
      authenticatedPasswordHash: passwordHash,
      licenseId: id,
      tokenHash: `token-${id}`,
      deviceId,
      deviceName: deviceId,
      now,
      expiresAt,
    }),
  );
  const setLimit = (maxActiveDevices, now) => transaction(__test.activeDeviceLimitStatements(
    recordingDb(), { userId: 'user-1', maxActiveDevices, now },
  ));
  const activeIds = label => `
    SELECT '${label}:' || COALESCE(group_concat(id, ','), '') FROM (
      SELECT id FROM licenses
      WHERE user_id = 'user-1' AND revoked_at IS NULL AND expires_at > 0
      ORDER BY id
    );
  `;

  const initial = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  const deviceLimits = await readFile(new URL('../migrations/0010_active_device_limits.sql', import.meta.url), 'utf8');
  const script = `
    ${initial}
    ${deviceLimits}
    INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations,
       must_reset_password, active, created_at, updated_at)
    VALUES ('user-1', 'device-test@example.com', 'hash', 'salt', 100000, 0, 1, 1, 1);

    ${mint({ id: 'a', deviceId: 'A', now: 100 })}
    ${mint({ id: 'b', deviceId: 'B', now: 200 })}
    ${activeIds('limit-one')}

    ${setLimit(3, 250)}
    ${mint({ id: 'c', deviceId: 'C', now: 300 })}
    ${mint({ id: 'd', deviceId: 'D', now: 400 })}
    ${activeIds('limit-three')}

    ${mint({ id: 'e', deviceId: 'E', now: 500 })}
    ${activeIds('overflow')}

    ${mint({ id: 'd2', deviceId: 'D', now: 600 })}
    ${activeIds('same-device')}

    INSERT INTO licenses
      (id, user_id, token_hash, device_id, device_name, created_at, last_validated_at, expires_at)
    VALUES ('expired', 'user-1', 'token-expired', 'F', 'F', 50, 50, 650);
    ${mint({ id: 'g', deviceId: 'G', now: 700 })}
    ${activeIds('expired-cleanup')}
    SELECT 'expired-reason:' || revoked_reason FROM licenses WHERE id = 'expired';

    ${setLimit(1, 800)}
    ${activeIds('reduced')}
    SELECT 'reduced-count:' || COUNT(*) FROM licenses
      WHERE revoked_at = 800 AND revoked_reason = 'device_limit_reduced';

    UPDATE users SET active = 0 WHERE id = 'user-1';
    ${mint({ id: 'disabled', deviceId: 'H', now: 900 })}
    SELECT 'disabled-insert:' || COUNT(*) FROM licenses WHERE id = 'disabled';

    UPDATE users SET active = 1, password_hash = 'new-hash' WHERE id = 'user-1';
    ${mint({ id: 'stale-password', deviceId: 'G', now: 1000 })}
    SELECT 'stale-password-insert:' || COUNT(*) FROM licenses WHERE id = 'stale-password';
    SELECT 'current-session-preserved:' || COUNT(*) FROM licenses
      WHERE id = 'g' AND revoked_at IS NULL;
  `;
  const executed = spawnSync('sqlite3', [':memory:'], { input: script, encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(executed.stdout.trim().split('\n'), [
    'limit-one:b',
    'limit-three:b,c,d',
    'overflow:c,d,e',
    'same-device:c,d2,e',
    'expired-cleanup:d2,e,g',
    'expired-reason:expired',
    'reduced:g',
    'reduced-count:2',
    'disabled-insert:0',
    'stale-password-insert:0',
    'current-session-preserved:1',
  ]);
});

test('ships the Zyn-branded admin assets and both custom domains', async () => {
  const [html, css, javascript, wrangler, migration, analyticsIndexes, deviceLimits, versionState, source] = await Promise.all([
    readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0007_service_config.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0009_global_analytics_indexes.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0010_active_device_limits.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0011_polar_upstream_version.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /Zyn License Admin/);
  assert.match(html, /\/zyn-icon\.png/);
  assert.match(html, /\/favicon\.png/);
  assert.match(html, /\/manifest\.webmanifest/);
  assert.match(css, /--rose:\s*#e11d48/i);
  assert.match(css, /--orange:\s*#f97316/i);
  assert.doesNotMatch(css, /#62d9a7/i);
  assert.match(wrangler, /license\.rcart\.app/);
  assert.match(wrangler, /license\.zynbot\.app/);
  assert.match(html, /id="hyper-api-key" type="password"/);
  assert.match(html, /Installed apps only call the licensed Pokémon Center broker/);
  assert.match(html, /id="pokemon-queue-license" type="password"/);
  assert.match(html, /Installed apps receive only normalized queue and captcha events/);
  assert.match(javascript, /\/api\/admin\/service-config\/hyper/);
  assert.match(javascript, /\/api\/admin\/service-config\/pokemon-queue-events/);
  assert.match(javascript, /\/api\/admin\/service-config\/pokemon-queue-events\/refresh-version/);
  assert.match(javascript, /The saved key is never returned here/);
  assert.match(javascript, /The saved license is never returned here/);
  assert.match(html, /PolarAIO\/downloads/);
  assert.match(html, /id="refresh-pokemon-queue-version"/);
  assert.match(migration, /CREATE TABLE service_config/);
  assert.match(migration, /CREATE TABLE service_rate_windows/);
  assert.match(versionState, /CREATE TABLE service_state/);
  assert.match(wrangler, /POKEMON_QUEUE_RELAY/);
  assert.match(wrangler, /PokemonQueueRelay/);
  assert.match(wrangler, /"\*\/15 \* \* \* \*"/);
  assert.match(source, /PolarAIO\/downloads\/releases\/latest/);
  assert.match(html, /data-admin-tab="analytics"/);
  assert.match(html, /id="admin-page-analytics"/);
  for (const page of ['accounts', 'waiting-list', 'managed-proxies', 'settings', 'analytics']) {
    assert.match(html, new RegExp(`data-admin-tab="${page}"`));
    assert.match(html, new RegExp(`data-admin-page="${page}"`));
  }
  assert.match(html, /Global module availability/);
  assert.match(html, /id="admin-page-settings"/);
  assert.match(html, /id="refresh-waitlist"/);
  assert.match(html, /id="refresh-proxies"/);
  assert.match(html, /Active users/);
  assert.match(html, /Global checkout history/);
  assert.match(javascript, /\/api\/admin\/analytics\/dashboard/);
  assert.match(javascript, /\/api\/admin\/analytics\/users/);
  assert.match(javascript, /\/api\/admin\/analytics\/checkouts/);
  assert.match(javascript, /data-analytics-range/);
  assert.match(javascript, /renderAnalyticsChart/);
  assert.match(javascript, /ADMIN_PAGES = new Set/);
  assert.match(javascript, /window\.history\.replaceState/);
  assert.match(javascript, /\[data-admin-page\]/);
  assert.match(css, /\.analytics-chart-line/);
  assert.match(css, /\.user-device-limit/);
  assert.match(analyticsIndexes, /analytics_events_type_time_idx/);
  assert.match(deviceLimits, /max_active_devices INTEGER NOT NULL DEFAULT 1/);
  assert.match(deviceLimits, /BETWEEN 1 AND 10/);
  assert.match(deviceLimits, /licenses_user_active_device_idx/);
  assert.match(html, /Active devices/);
  assert.match(html, /<th>Devices<\/th>/);
  assert.match(javascript, /maxActiveDevices: nextMaxActiveDevices/);
  assert.match(javascript, /value <= 10/);
  assert.match(source, /async function adminAnalyticsDashboard/);
  assert.match(source, /COUNT\(DISTINCT CASE/);
  assert.match(source, /COUNT\(DISTINCT e\.user_id\) AS active_users/);
  await access(new URL('../public/zyn-icon.png', import.meta.url));
  await access(new URL('../public/favicon.png', import.meta.url));
  await access(new URL('../public/apple-touch-icon.png', import.meta.url));
  await access(new URL('../public/manifest.webmanifest', import.meta.url));
});

test('keeps global analytics behind the admin session boundary', async () => {
  for (const path of [
    '/api/admin/analytics/dashboard',
    '/api/admin/analytics/users',
    '/api/admin/analytics/checkouts',
  ]) {
    const response = await worker.fetch(new Request(`https://license.zynbot.app${path}`), {});
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, message: 'Admin authentication required.' });
  }
});

test('normalizes analytics without accepting identity or payment fields', () => {
  const event = __test.normalizeAnalyticsEvent({
    eventId: '0123456789abcdef0123456789abcdef',
    eventType: 'checkout',
    site: 'pokemoncenter',
    taskId: 'task-1',
    runId: 'run-1',
    orderNumber: 'order-1',
    totalCents: 2500,
    occurredAt: 100000,
    email: 'must-not-store@example.com',
    cardNumber: '4111111111111111',
    items: [{ sku: 'sku-1', name: 'One', unitPriceCents: 1025, quantity: 2 }],
  }, 100000);
  assert.equal(event.site, 'Pokemon Center US');
  assert.equal(event.totalCents, 2500);
  assert.equal(event.items[0].quantity, 2);
  assert.equal(Object.hasOwn(event, 'email'), false);
  assert.equal(JSON.stringify(event).includes('4111111111111111'), false);
  assert.equal(__test.normalizeAnalyticsEvent({ ...event, eventId: 'short' }, 100000), null);
});

test('uses a bounded client range for local-day dashboard queries', () => {
  const now = 1_000_000;
  const window = __test.analyticsWindow(new URL(`https://license.zynbot.app/api/analytics/dashboard?range=today&from=123&to=${now}`), now);
  assert.deepEqual(window, { range: 'today', from: 123, to: now });
  assert.deepEqual(
    __test.analyticsWindow(new URL('https://license.zynbot.app/api/analytics/dashboard?range=30d'), now),
    { range: '30d', from: now - 30 * 24 * 60 * 60 * 1000, to: now + 1 },
  );
});

test('encrypts Hyper credentials with authenticated encryption and returns only status metadata', async () => {
  const secret = 'hyper-test-key-that-must-stay-server-side';
  const env = { SERVICE_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url') };
  const encrypted = await __test.encryptServiceCredential('hyper', secret, env);
  const row = {
    name: 'hyper',
    encrypted_value: encrypted.encryptedValue,
    iv: encrypted.iv,
    fingerprint: encrypted.fingerprint,
    updated_at: 1234,
  };

  assert.equal(await __test.decryptServiceCredential(row, env), secret);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.deepEqual(__test.serviceCredentialJson(row), {
    configured: true,
    fingerprint: encrypted.fingerprint,
    updatedAt: 1234,
  });
  assert.equal(JSON.stringify(__test.serviceCredentialJson(row)).includes(secret), false);
  await assert.rejects(
    __test.decryptServiceCredential(row, {
      SERVICE_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64url'),
    }),
  );
});

test('builds the receive-only upstream URL with only key and version identifiers', () => {
  const raw = __test.pokemonQueueUpstreamUrl('test-license-value');
  const url = new URL(raw);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('key'), 'test-license-value');
  assert.equal(url.searchParams.get('version'), __test.POKEMON_QUEUE_UPSTREAM_VERSION);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['key', 'version']);
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  const pinned = new URL(__test.pokemonQueueUpstreamUrl('test-license-value', 'v0.0.50'));
  assert.equal(pinned.searchParams.get('version'), 'v0.0.50');
  assert.deepEqual([...pinned.searchParams.keys()].sort(), ['key', 'version']);
});

test('accepts only Polar release tags as websocket versions', () => {
  assert.equal(__test.normalizePolarReleaseVersion('v0.0.50'), 'v0.0.50');
  assert.equal(__test.normalizePolarReleaseVersion('0.0.50'), 'v0.0.50');
  assert.equal(__test.normalizePolarReleaseVersion('V0.0.49'), 'v0.0.49');
  assert.equal(__test.normalizePolarReleaseVersion('v0.0.50-m'), '');
  assert.equal(__test.normalizePolarReleaseVersion('latest'), '');
  assert.equal(__test.normalizePolarReleaseVersion('https://evil.example/v1.0.0'), '');
  assert.equal(__test.parsePolarLatestRelease({ tag_name: 'v0.0.50', draft: false, prerelease: false }), 'v0.0.50');
  assert.equal(__test.parsePolarLatestRelease({ tag_name: 'v0.0.50', prerelease: true }), '');
  assert.equal(__test.parsePolarLatestRelease({ tag_name: 'v0.0.50', draft: true }), '');
  assert.equal(__test.parsePolarLatestRelease({ name: '0.0.51' }), 'v0.0.51');
});

function memoryServiceStateDb() {
  const state = new Map();
  const audits = [];
  return {
    state,
    audits,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async first() {
              if (/FROM service_state/.test(sql)) return state.get(bindings[0]) || null;
              return null;
            },
            async run() {
              if (/INSERT INTO service_state/.test(sql)) {
                const [name, value, checkedAt, updatedAt] = bindings;
                const previous = state.get(name);
                state.set(name, {
                  name,
                  value,
                  source: 'github',
                  checked_at: checkedAt,
                  updated_at: previous && previous.value === value ? previous.updated_at : updatedAt,
                });
              }
              if (/INSERT INTO admin_audit/.test(sql)) audits.push({ sql, bindings });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('refreshes the Polar websocket version from the public downloads repo', async () => {
  const db = memoryServiceStateDb();
  const env = { DB: db };
  const fetched = [];
  const first = await __test.refreshPolarUpstreamVersion(env, {
    now: 1000,
    fetch: async (url, options) => {
      fetched.push({ url: String(url), headers: options && options.headers });
      return jsonResponse({ tag_name: 'v0.0.51', draft: false, prerelease: false });
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.version, 'v0.0.51');
  assert.equal(fetched[0].url, __test.POKEMON_QUEUE_RELEASES_URL);
  assert.equal(fetched[0].headers['user-agent'], 'zyn-license-api');
  assert.equal(db.state.get('pokemon-queue-upstream-version').value, 'v0.0.51');
  assert.equal(db.audits.length, 1);

  const same = await __test.refreshPolarUpstreamVersion(env, {
    now: 2000,
    fetch: async () => jsonResponse({ tag_name: 'v0.0.51' }),
  });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(db.audits.length, 1);
  assert.equal(db.state.get('pokemon-queue-upstream-version').checked_at, 2000);
  assert.equal(db.state.get('pokemon-queue-upstream-version').updated_at, 1000);

  const rejected = await __test.refreshPolarUpstreamVersion(env, {
    now: 3000,
    fetch: async () => jsonResponse({ tag_name: 'v0.0.99', prerelease: true }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'invalid_version');
  assert.equal(db.state.get('pokemon-queue-upstream-version').value, 'v0.0.51');
});

test('normalizes only Pokémon Center queue and captcha messages', () => {
  assert.deepEqual(__test.normalizePokemonQueueEvent({
    type: 'cloud-ping',
    data: { site: 'PokemonCenter', type: 'Queue is up!' },
  }), { kind: 'queue' });
  assert.deepEqual(__test.normalizePokemonQueueEvent({
    type: 'cloud-ping',
    data: JSON.stringify({ site: 'PokemonCenter', type: 'Hcaptcha is up (Stage 2)' }),
  }), { kind: 'captcha' });
  assert.deepEqual(__test.normalizePokemonQueueEvent({
    type: 'zephyr-ping',
    data: { type: 'pokemon_center_queue' },
  }), { kind: 'queue' });
  assert.equal(__test.normalizePokemonQueueEvent({
    type: 'cloud-ping',
    data: { site: 'Target', type: 'Queue is up!' },
  }), null);
  assert.equal(__test.normalizePokemonQueueEvent({ type: 'siteConfigs', data: { secret: true } }), null);
});

test('terminates device authentication before the internal queue relay', async () => {
  let internalRequest;
  const response = await __test.brokerPokemonQueueEvents(new Request(
    'https://license.zynbot.app/api/services/pokemon-center/queue-events',
    {
      headers: {
        Upgrade: 'websocket',
        Authorization: 'Bearer desktop-license',
        'x-rcart-device-id': '0123456789abcdef',
        'x-extra-client-header': 'must-not-pass',
      },
    },
  ), {}, {
    authenticate: async () => ({ user_id: 'user-1' }),
    entitlements: async () => ({ pokemoncenter: true }),
    stub: {
      fetch: async (request) => {
        internalRequest = request;
        return new Response('upgraded-for-test');
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(internalRequest.headers.get('upgrade'), 'websocket');
  assert.equal(internalRequest.headers.get('authorization'), null);
  assert.equal(internalRequest.headers.get('x-rcart-device-id'), null);
  assert.equal(internalRequest.headers.get('x-extra-client-header'), null);
  assert.deepEqual([...internalRequest.headers.keys()], ['upgrade']);
});

function hyperRequest(operation = 'reese84') {
  return new Request(`https://license.zynbot.app/api/services/hyper/${operation}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer desktop-license',
      'content-type': 'application/json',
      'x-rcart-device-id': '0123456789abcdef',
    },
    body: JSON.stringify({ url: 'https://www.pokemoncenter.com/' }),
  });
}

function hyperDependencies(overrides = {}) {
  return {
    authenticate: async () => ({ user_id: 'user-1' }),
    entitlements: async () => ({ pokemoncenter: true }),
    credential: async () => 'server-only-hyper-key',
    rateLimit: async () => ({ allowed: true, retryAfter: 1 }),
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    ...overrides,
  };
}

test('brokers only named Hyper operations and injects the API key server-side', async () => {
  let forwarded;
  const response = await __test.brokerHyper(hyperRequest(), {}, 'reese84', hyperDependencies({
    fetch: async (url, init) => {
      forwarded = { url, init };
      return new Response(JSON.stringify({ ok: true, accidentalEcho: 'server-only-hyper-key' }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'retry-after': '4', 'x-secret': 'nope' },
      });
    },
  }));

  assert.equal(forwarded.url, 'https://incapsula.hypersolutions.co/reese84');
  assert.equal(forwarded.init.method, 'POST');
  assert.equal(forwarded.init.headers['x-api-key'], 'server-only-hyper-key');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(forwarded.init.body)), {
    url: 'https://www.pokemoncenter.com/',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('retry-after'), '4');
  assert.equal(response.headers.get('x-secret'), null);
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /server-only-hyper-key/);
  assert.match(responseText, /\[redacted\]/);

  let called = false;
  const rejected = await __test.brokerHyper(hyperRequest('arbitrary'), {}, 'arbitrary', hyperDependencies({
    fetch: async () => { called = true; },
  }));
  assert.equal(rejected.status, 404);
  assert.equal(called, false);
});

test('Hyper broker applies the gzip encoding expected by the UTMVC endpoint', async () => {
  let forwarded;
  const response = await __test.brokerHyper(
    hyperRequest('incapsula-utmvc'),
    {},
    'incapsula-utmvc',
    hyperDependencies({
      fetch: async (url, init) => {
        forwarded = { url, init };
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded.url, 'https://incapsula.hypersolutions.co/utmvc');
  assert.equal(forwarded.init.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(forwarded.init.body).toString('utf8')), {
    url: 'https://www.pokemoncenter.com/',
  });
});

test('Hyper broker fails closed for license, entitlement, configuration, and quota checks', async () => {
  const unauthorized = await __test.brokerHyper(hyperRequest(), {}, 'reese84', hyperDependencies({
    authenticate: async () => null,
  }));
  assert.equal(unauthorized.status, 401);

  const denied = await __test.brokerHyper(hyperRequest(), {}, 'reese84', hyperDependencies({
    entitlements: async () => ({ pokemoncenter: false }),
  }));
  assert.equal(denied.status, 403);

  const unconfigured = await __test.brokerHyper(hyperRequest(), {}, 'reese84', hyperDependencies({
    credential: async () => '',
  }));
  assert.equal(unconfigured.status, 503);

  const limited = await __test.brokerHyper(hyperRequest(), {}, 'reese84', hyperDependencies({
    rateLimit: async () => ({ allowed: false, retryAfter: 17 }),
  }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '17');
});
