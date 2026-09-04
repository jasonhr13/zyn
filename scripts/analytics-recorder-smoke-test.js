#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAnalyticsService } = require('../launcher/analytics-recorder');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-analytics-'));
  let email = 'one@example.com';
  let online = false;
  let dashboardOnline = true;
  const uploaded = [];
  const authority = {
    cached: () => ({ ok: true, email }),
    async recordAnalytics(events) {
      if (!online) return { ok: false, status: 0 };
      uploaded.push(...events);
      return { ok: true, accepted: events.length };
    },
    async analyticsDashboard() {
      return dashboardOnline
        ? { ok: true, summary: { checkouts: 1 }, series: [] }
        : { ok: false, status: 0 };
    },
    async analyticsCheckouts() { return { ok: false, status: 0 }; },
    async deleteAnalytics() { return { ok: true, deleted: 1 }; },
  };
  const service = createAnalyticsService({ dataDirectory: root, authority });
  const event = {
    eventId: '0123456789abcdef0123456789abcdef', eventType: 'checkout', site: 'Target',
    taskId: 'task-1', runId: 'run-1', totalCents: 1999, occurredAt: Date.now(),
    account: 'target-account@example.com', profile: 'Target Main',
    profileEmail: 'must-not-persist@example.com', cardNumber: '4111111111111111',
    items: [{ sku: '123', name: 'Item', quantity: 1, unitPriceCents: 1999 }],
  };
  assert.equal(service.record(event), true);
  await service.flush();
  assert.equal(service.pending(), 1);
  const raw = fs.readFileSync(service.outboxPath, 'utf8');
  assert.equal(raw.includes('one@example.com'), false);
  assert.equal(raw.includes('must-not-persist@example.com'), false);
  assert.equal(raw.includes('4111111111111111'), false);
  assert.equal(raw.includes('target-account@example.com'), true);

  email = 'two@example.com';
  online = true;
  await service.flush();
  assert.equal(uploaded.length, 0, 'an account switch uploaded another account\'s outbox');
  email = 'one@example.com';
  await service.flush();
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].account, 'target-account@example.com');
  assert.equal(uploaded[0].profile, 'Target Main');
  assert.equal(Object.hasOwn(uploaded[0], 'profileEmail'), false);
  assert.equal(service.pending(), 0);
  const onlineView = await service.dashboard({ range: '30d', from: 10, to: 20 });
  assert.equal(onlineView.summary.checkouts, 1);
  dashboardOnline = false;
  const cachedView = await service.dashboard({ range: '30d', from: 11, to: 21 });
  assert.equal(cachedView.offline, true);
  assert.equal(cachedView.summary.checkouts, 1);
  service.dispose();
  console.log(JSON.stringify({ ok: true, accountBound: true, privacyFiltered: true, offlineCache: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
