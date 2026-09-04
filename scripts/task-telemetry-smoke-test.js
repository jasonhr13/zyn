#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recorder = require('../launcher/analytics-recorder');
const contract = require('../launcher/native-engine-contract');

const { createAnalyticsService, __test: { normalizeTelemetryEvent } } = recorder;

async function main() {
  assert.equal(contract.FROM_ENGINE.includes('task-telemetry'), true);

  // Normalization: unknown events and sites are dropped, labels are compacted, and the
  // bucket is aligned to the hour so partial uploads from one hour add up server-side.
  assert.equal(normalizeTelemetryEvent({ event: 'cartAttempt', site: 'Target' }), null);
  assert.equal(normalizeTelemetryEvent({ event: 'cart_attempt', site: 'Amazon' }), null);
  const hour = 60 * 60 * 1000;
  const at = Date.now() - 3 * 24 * hour + 12345;
  const normalized = normalizeTelemetryEvent({
    event: 'Shape_Block_Cart', site: 'target', step: 'Add To Cart', shapeMethod: 'Mobile ',
    cookieType: 'ATC', cookieAgeMs: 4200.7, occurredAt: at, engineVersion: '1.7.43',
  }, at);
  assert.deepEqual(normalized, {
    event: 'shape_block_cart', site: 'Target', step: 'add-to-cart', shapeMethod: 'mobile',
    cookieType: 'atc', cookieAgeMs: 0, engineVersion: '1.7.43', appVersion: '',
    bucketStart: Math.floor(at / hour) * hour,
  });
  assert.equal(normalizeTelemetryEvent({ event: 'carted', site: 'Target', cookieAgeMs: 4200 }).cookieAgeMs, 4200);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-telemetry-'));
  let email = 'one@example.com';
  let online = false;
  let dropResponse = false;
  const uploads = [];
  const timers = [];
  const authority = {
    cached: () => ({ ok: true, email }),
    async recordAnalytics() { return { ok: false, status: 0 }; },
    async recordTaskTelemetry(batch) {
      if (!online) return { ok: false, status: 0 };
      uploads.push(JSON.parse(JSON.stringify(batch)));
      if (dropResponse) return { ok: false, status: 0 };
      return { ok: true, accepted: batch.buckets.length };
    },
  };
  const service = createAnalyticsService({
    dataDirectory: root,
    authority,
    appVersion: '1.7.44',
    scheduleTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
    cancelTimeout: () => {},
  });
  recorder.setService(service);

  const base = { site: 'Target', shapeMethod: 'mobile', cookieType: 'atc', engineVersion: 'v9', occurredAt: at };
  assert.equal(recorder.recordTelemetry({ ...base, event: 'cart_attempt', cookieAgeMs: 1000 }), true);
  assert.equal(recorder.recordTelemetry({ ...base, event: 'cart_attempt', cookieAgeMs: 3000 }), true);
  assert.equal(recorder.recordTelemetry({ ...base, event: 'cart_attempt', cookieAgeMs: 0 }), true);
  assert.equal(recorder.recordTelemetry({ ...base, event: 'shape_block_cart', step: 'add-to-cart', cookieAgeMs: 500 }), true);
  assert.equal(recorder.recordTelemetry({ ...base, event: 'cart_attempt', occurredAt: at + 2 * hour }), true);
  assert.equal(recorder.recordTelemetry({ ...base, event: 'not_a_thing' }), false);
  assert.equal(service.telemetryPending(), 3, 'events did not roll up into three buckets');

  // Offline: the batch is sealed with a stable id and survives on disk without the email.
  await service.flushTelemetry();
  assert.equal(uploads.length, 0);
  assert.equal(service.telemetryPending(), 3);
  const raw = fs.readFileSync(service.telemetryPath, 'utf8');
  assert.equal(raw.includes('one@example.com'), false);
  const stored = JSON.parse(raw);
  assert.equal(stored.batches.length, 1);
  const batchId = stored.batches[0].batchId;
  assert.match(batchId, /^[0-9a-f-]{36}$/);

  // Another account signed in must not upload the first account's counters.
  email = 'two@example.com';
  online = true;
  await service.flushTelemetry();
  assert.equal(uploads.length, 0, 'an account switch uploaded another account\'s telemetry');

  // Lost response: the same batch id is retried, so the service can ignore the replay.
  email = 'one@example.com';
  dropResponse = true;
  await service.flushTelemetry();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].batchId, batchId);
  dropResponse = false;
  await service.flushTelemetry();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].batchId, batchId);
  assert.equal(service.telemetryPending(), 0);

  const buckets = uploads[1].buckets;
  assert.equal(buckets.length, 3);
  const attempts = buckets.find(bucket => bucket.event === 'cart_attempt' && bucket.bucketStart === normalized.bucketStart);
  assert.deepEqual(attempts, {
    bucketStart: normalized.bucketStart, site: 'Target', event: 'cart_attempt', step: '',
    shapeMethod: 'mobile', cookieType: 'atc', engineVersion: 'v9', appVersion: '1.7.44',
    count: 3, cookieAgeMsTotal: 4000, cookieAgeSamples: 2,
  });
  const block = buckets.find(bucket => bucket.event === 'shape_block_cart');
  assert.equal(block.step, 'add-to-cart');
  assert.equal(block.count, 1);
  for (const bucket of buckets) {
    for (const key of ['taskId', 'runId', 'account', 'profile', 'orderNumber']) {
      assert.equal(Object.hasOwn(bucket, key), false, `${key} leaked into a telemetry bucket`);
    }
  }

  // A malformed batch the service rejects is dropped rather than retried forever.
  recorder.recordTelemetry({ ...base, event: 'carted' });
  authority.recordTaskTelemetry = async () => ({ ok: false, status: 400, message: 'bad batch' });
  await service.flushTelemetry();
  assert.equal(service.telemetryPending(), 0);

  // A throttled upload keeps the batch for retry.
  recorder.recordTelemetry({ ...base, event: 'carted' });
  authority.recordTaskTelemetry = async () => ({ ok: false, status: 429 });
  await service.flushTelemetry();
  assert.equal(service.telemetryPending(), 1);

  assert.equal(timers.some(timer => timer.delay === 60 * 1000), true, 'no periodic telemetry flush was scheduled');
  service.dispose();
  console.log(JSON.stringify({ ok: true, rollup: true, idempotentBatches: true, accountBound: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
