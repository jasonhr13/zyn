import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

// These tests run the real migrations and ingest SQL on SQLite so the idempotent upsert is
// exercised for real. better-sqlite3 is borrowed from the target-monitor service's dependencies;
// when it is not installed the suite is skipped rather than silently faked.
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let Database = null;
for (const candidate of ['better-sqlite3', path.join(here, '..', '..', '..', 'target-monitor', 'node_modules', 'better-sqlite3')]) {
  try { Database = require(candidate); break; } catch {}
}

const DEVICE_A = 'aaaaaaaaaaaaaaaa';
const TOKEN_A = 'license-token-a';
const DEVICE_B = 'bbbbbbbbbbbbbbbb';
const TOKEN_B = 'license-token-b';
const ADMIN_SECRET = 'admin-secret';
const HOUR = 60 * 60 * 1000;

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function adminCookie() {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + 60_000, nonce: 'test' })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ADMIN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
  return `hope_admin=${payload}.${signature}`;
}

// Minimal D1 surface over better-sqlite3.
function d1(db) {
  const statement = (sql, bindings = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...bindings) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...bindings) }),
    run: async () => {
      const info = db.prepare(sql).run(...bindings);
      return { success: true, meta: { changes: info.changes } };
    },
  });
  return {
    prepare: sql => statement(sql),
    batch: async (statements) => {
      const run = db.transaction(() => statements.map(entry => entry.run()));
      return Promise.all(run());
    },
  };
}

async function environment() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = path.join(here, '..', 'migrations');
  for (const file of fs.readdirSync(migrations).sort()) db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  const now = Date.now();
  const user = db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, created_at, updated_at)
    VALUES (?, ?, 'x', 'y', 1, ?, ?)`);
  const license = db.prepare(`INSERT INTO licenses (id, user_id, token_hash, device_id, created_at, last_validated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  user.run('user-a', 'a@example.com', now, now);
  user.run('user-b', 'b@example.com', now, now);
  license.run('license-a', 'user-a', await sha256Hex(TOKEN_A), DEVICE_A, now, now, now + 60_000);
  license.run('license-b', 'user-b', await sha256Hex(TOKEN_B), DEVICE_B, now, now, now + 60_000);
  return { db, env: { DB: d1(db), ADMIN_SESSION_SECRET: ADMIN_SECRET } };
}

function post(env, body, { token = TOKEN_A, device = DEVICE_A } = {}) {
  return worker.fetch(new Request('https://license.zynbot.app/api/analytics/task-telemetry', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-rcart-device-id': device,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env);
}

async function adminShape(env, query = '') {
  const response = await worker.fetch(new Request(`https://license.zynbot.app/api/admin/analytics/shape${query}`, {
    headers: { 'x-hope-admin': '1', cookie: await adminCookie() },
  }), env);
  assert.equal(response.status, 200);
  return response.json();
}

const bucketStart = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
const bucket = (overrides = {}) => ({
  bucketStart, site: 'Target', event: 'cart_attempt', step: '', shapeMethod: 'mobile', cookieType: 'atc',
  engineVersion: '1.7.43', appVersion: '1.7.43', count: 4, cookieAgeMsTotal: 8000, cookieAgeSamples: 4,
  ...overrides,
});

const suite = Database ? test : test.skip;

suite('task telemetry rolls up hourly counters and applies a replayed batch once', async () => {
  const { db, env } = await environment();
  const first = await post(env, { batchId: 'batch-0001-aaaaaaaa', buckets: [bucket(), bucket({ event: 'shape_block_cart', step: 'add-to-cart', count: 1, cookieAgeMsTotal: 300, cookieAgeSamples: 1 })] });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, accepted: 2, duplicate: false });

  // The same batch again (client never saw the response) must not double count.
  const replay = await post(env, { batchId: 'batch-0001-aaaaaaaa', buckets: [bucket()] });
  assert.deepEqual(await replay.json(), { ok: true, accepted: 0, duplicate: true });

  // A later partial-hour flush adds to the existing row.
  const second = await post(env, { batchId: 'batch-0002-aaaaaaaa', buckets: [bucket({ count: 2, cookieAgeMsTotal: 1000, cookieAgeSamples: 1 })] });
  assert.deepEqual(await second.json(), { ok: true, accepted: 1, duplicate: false });

  const rows = db.prepare('SELECT event, count, cookie_age_ms_total, cookie_age_samples FROM analytics_task_rollups WHERE user_id = ? ORDER BY event').all('user-a');
  assert.deepEqual(rows, [
    { event: 'cart_attempt', count: 6, cookie_age_ms_total: 9000, cookie_age_samples: 5 },
    { event: 'shape_block_cart', count: 1, cookie_age_ms_total: 300, cookie_age_samples: 1 },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_task_batches').get().n, 2);
});

suite('task telemetry rejects malformed batches and buckets', async () => {
  const { env } = await environment();
  const cases = [
    [{ batchId: 'short', buckets: [bucket()] }, /batch id/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [] }, /1-500/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [bucket({ event: 'cartAttempt' })] }, /invalid/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [bucket({ site: 'Amazon' })] }, /invalid/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [bucket({ bucketStart: bucketStart + 1 })] }, /invalid/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [bucket({ bucketStart: bucketStart - 60 * 24 * HOUR })] }, /invalid/],
    [{ batchId: 'batch-0001-aaaaaaaa', buckets: [bucket({ count: 0 })] }, /invalid/],
  ];
  for (const [body, message] of cases) {
    const response = await post(env, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).message, message);
  }
  const unauthenticated = await post(env, { batchId: 'batch-0001-aaaaaaaa', buckets: [bucket()] }, { token: 'nope' });
  assert.equal(unauthenticated.status, 401);
});

suite('admin shape report aggregates across users, sources and versions', async () => {
  const { db, env } = await environment();
  await post(env, { batchId: 'batch-0001-aaaaaaaa', buckets: [
    bucket({ count: 10, cookieAgeMsTotal: 20000, cookieAgeSamples: 10 }),
    bucket({ event: 'carted', count: 6, cookieAgeMsTotal: 0, cookieAgeSamples: 0 }),
    bucket({ event: 'shape_block_cart', step: 'add-to-cart', count: 3, cookieAgeMsTotal: 0, cookieAgeSamples: 0 }),
    bucket({ event: 'shape_block_login', step: 'login', cookieType: 'login', count: 2, cookieAgeMsTotal: 0, cookieAgeSamples: 0 }),
  ] });
  await post(env, { batchId: 'batch-0002-bbbbbbbb', buckets: [
    bucket({ shapeMethod: 'extension', engineVersion: '1.7.44', count: 10, cookieAgeMsTotal: 100000, cookieAgeSamples: 10 }),
    bucket({ shapeMethod: 'extension', engineVersion: '1.7.44', event: 'shape_block_cart', step: 'add-to-cart', count: 8, cookieAgeMsTotal: 0, cookieAgeSamples: 0 }),
    bucket({ site: 'Pokemon Center US', shapeMethod: '', cookieType: '', event: 'passed_queue', count: 1, cookieAgeMsTotal: 0, cookieAgeSamples: 0 }),
  ] }, { token: TOKEN_B, device: DEVICE_B });

  const report = await adminShape(env, '?range=30d');
  assert.equal(report.ok, true);
  assert.equal(report.summary.users, 2);
  assert.equal(report.summary.counts.cart_attempt, 20);
  assert.equal(report.summary.counts.carted, 6);
  assert.equal(report.summary.counts.shape_block_cart, 11);
  assert.equal(report.summary.counts.shape_block_login, 2);
  assert.equal(report.summary.counts.passed_queue, 1);
  assert.equal(report.summary.cartBlockRate, 11 / 20);
  assert.equal(report.summary.avgCookieAgeMs, 6000);

  const mobile = report.byMethod.find(row => row.shapeMethod === 'mobile' && row.cookieType === 'atc');
  const extension = report.byMethod.find(row => row.shapeMethod === 'extension');
  assert.equal(mobile.counts.cart_attempt, 10);
  assert.equal(mobile.cartBlockRate, 0.3);
  assert.equal(mobile.avgCookieAgeMs, 2000);
  assert.equal(extension.cartBlockRate, 0.8);
  assert.equal(extension.avgCookieAgeMs, 10000);

  const newer = report.byVersion.find(row => row.engineVersion === '1.7.44');
  assert.equal(newer.users, 1);
  assert.equal(newer.counts.shape_block_cart, 8);

  assert.equal(report.users[0].email, 'b@example.com', 'most blocked user should lead');
  assert.equal(report.users[0].counts.shape_block_cart, 8);
  assert.equal(report.series.length, 1);
  assert.equal(report.series[0].counts.cart_attempt, 20);

  const targetOnly = await adminShape(env, '?range=30d&site=target');
  assert.equal(targetOnly.summary.counts.passed_queue, 0);
  assert.equal(targetOnly.summary.counts.cart_attempt, 20);

  // Users who delete their analytics take their telemetry with them.
  const deleted = await worker.fetch(new Request('https://license.zynbot.app/api/analytics', {
    method: 'DELETE', headers: { authorization: `Bearer ${TOKEN_B}`, 'x-rcart-device-id': DEVICE_B },
  }), env);
  assert.equal(deleted.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_task_rollups WHERE user_id = 'user-b'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_task_batches WHERE user_id = 'user-b'").get().n, 0);
  assert.equal((await adminShape(env, '?range=30d')).summary.users, 1);
});
