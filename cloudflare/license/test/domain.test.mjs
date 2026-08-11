import assert from 'node:assert/strict';
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

test('ships the Zyn-branded admin assets and both custom domains', async () => {
  const [html, css, javascript, wrangler, migration, analyticsIndexes, workerSource] = await Promise.all([
    readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0007_service_config.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0009_global_analytics_indexes.sql', import.meta.url), 'utf8'),
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
  assert.match(javascript, /The saved key is never returned here/);
  assert.match(javascript, /The saved license is never returned here/);
  assert.match(migration, /CREATE TABLE service_config/);
  assert.match(migration, /CREATE TABLE service_rate_windows/);
  assert.match(wrangler, /POKEMON_QUEUE_RELAY/);
  assert.match(wrangler, /PokemonQueueRelay/);
  assert.match(html, /data-admin-tab="analytics"/);
  assert.match(html, /id="admin-page-analytics"/);
  assert.match(html, /Active users/);
  assert.match(html, /Global checkout history/);
  assert.match(javascript, /\/api\/admin\/analytics\/dashboard/);
  assert.match(javascript, /\/api\/admin\/analytics\/users/);
  assert.match(javascript, /\/api\/admin\/analytics\/checkouts/);
  assert.match(javascript, /data-analytics-range/);
  assert.match(javascript, /renderAnalyticsChart/);
  assert.match(css, /\.analytics-chart-line/);
  assert.match(analyticsIndexes, /analytics_events_type_time_idx/);
  assert.match(workerSource, /async function adminAnalyticsDashboard/);
  assert.match(workerSource, /COUNT\(DISTINCT e\.user_id\) AS active_users/);
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
