#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { evaluateTargetReadiness } = require('../launcher/target-readiness');

const group = {
  id: 'group-1',
  name: 'Friday drop',
  site: 'target',
  items: [
    { sku: '12345678', maxPrice: '24.99' },
    { sku: '87654321', maxPrice: '' },
  ],
  skus: '12345678\n87654321',
  stockConfidence: 'confirmed-10-plus',
  tasks: [{ id: 'task-1', accountId: 'account-1', proxyListName: 'Residential' }],
};
const accounts = [{
  id: 'account-1', email: 'buyer@example.com', site: 'target', hasPassword: true, cookie: 'saved-session',
}];
const profiles = [{ id: 'profile-1', email: 'buyer@example.com' }];

const ready = evaluateTargetReadiness(group, {
  accounts,
  profiles,
  proxyCounts: { Residential: { ok: true, count: 25 } },
  bank: { atc: 3, login: 0 },
  settings: { targetAtcCookiesPerTask: '3', targetHarvesters: [] },
});
assert.equal(ready.level, 'ready');
assert.equal(ready.counts.priceLimitedSkus, 1);
assert.equal(ready.blockers.length, 0);
assert.equal(ready.warnings.length, 0);

const warning = evaluateTargetReadiness({
  ...group,
  tasks: [{ ...group.tasks[0], proxyListName: '' }],
}, {
  accounts: [{ ...accounts[0], cookie: '' }],
  profiles,
  proxyCounts: {},
  bank: null,
  settings: { targetAtcCookiesPerTask: '3', targetHarvesters: [] },
});
assert.equal(warning.level, 'warning');
assert.ok(warning.warnings.some(item => item.code === 'local-proxy'));
assert.ok(warning.warnings.some(item => item.code === 'cookie-bank-offline'));
assert.ok(warning.warnings.some(item => item.code === 'no-atc-harvester'));

const blocked = evaluateTargetReadiness({
  ...group,
  items: [{ sku: '12345678', maxPrice: 'twelve' }],
}, {
  accounts: [{ ...accounts[0], hasPassword: false, cookie: '' }],
  profiles: [],
  proxyCounts: { Residential: { ok: false, count: 0 } },
  bank: { atc: 0, login: 0 },
  settings: { targetAtcCookiesPerTask: '3', targetHarvesters: [] },
});
assert.equal(blocked.level, 'blocked');
for (const code of ['invalid-max-price', 'missing-credentials', 'missing-profile', 'proxy-unavailable']) {
  assert.ok(blocked.blockers.some(item => item.code === code), `missing readiness blocker ${code}`);
}

const selected = evaluateTargetReadiness({
  ...group,
  tasks: [
    ...group.tasks,
    { id: 'task-2', accountId: 'deleted-account', proxyListName: 'Missing' },
  ],
}, {
  taskIds: ['task-1'],
  accounts,
  profiles,
  proxyCounts: { Residential: { ok: true, count: 25 } },
  bank: { atc: 3, login: 0 },
  settings: { targetAtcCookiesPerTask: '3' },
});
assert.equal(selected.level, 'ready', 'single-task readiness included an unselected broken task');
assert.equal(selected.counts.tasks, 1);

console.log('Target readiness blockers, warnings, selection, cookie demand, and per-SKU price validation passed.');
