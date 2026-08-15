#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');
const {
  normalizeWatchedItems,
  createTaskGroupStore,
} = require('../launcher/task-group-store');
const { parseWatchedItems, buildTargetGroupLaunch } = require('../launcher/target-group-launch');
const { engineSourceRoot } = require('./zyn-engine-source.cjs');

const engine = read('runtime-app/public/helpers/target-engine.js');
const groups = read('frontend/src/components/pages/task-groups.js');
const styles = read('frontend/src/App.css');
const goMonitor = fs.readFileSync(
  path.join(engineSourceRoot(), 'sites/target/monitor_sub.go'),
  'utf8',
);

assert.match(engine, /function engineItemsFor\(/);
assert.match(engine, /priority: priorityBySku\[sku\] === true/);
assert.match(engine, /priorityBySku/);
assert.match(engine, /abandons the current product before payment/);
assert.match(groups, /setSkuPriority/);
assert.match(groups, /watchListSummary/);
assert.match(groups, /Mark as priority/);
assert.match(groups, /addWatchedSkus/);
assert.match(groups, /removeSku/);
assert.doesNotMatch(groups, /className="form-input group-sku-input"/);
assert.match(styles, /\.target-sku-priority\.active/);
assert.match(styles, /\.target-sku-watch-list/);
assert.match(goMonitor, /func \(t \*TargetTask\) shouldAbandonSelected\(\)/);
assert.match(goMonitor, /func \(t \*TargetTask\) shouldPivotToPriority\(\)/);
assert.match(goMonitor, /func \(t \*TargetTask\) checkoutCommitted\(\)/);

assert.deepEqual(normalizeWatchedItems({
  items: [
    { sku: '11111111', maxPrice: '20', priority: true },
    { sku: '22222222', maxPrice: '' },
  ],
}), [
  { sku: '11111111', maxPrice: '20.00', priority: true },
  { sku: '22222222', maxPrice: '' },
]);

assert.deepEqual(parseWatchedItems({
  items: [
    { sku: '11111111', priority: true },
    { sku: '22222222' },
  ],
}), [
  { sku: '11111111', maxPrice: '', priority: true },
  { sku: '22222222', maxPrice: '' },
]);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-sku-priority-'));
try {
  const store = createTaskGroupStore(directory, {
    createId: () => 'priority-test',
    now: 1735689600000,
  });
  const saved = store.save([{
    name: 'Priority Drop',
    items: [
      { sku: '11111111', priority: true },
      { sku: '22222222' },
    ],
    tasks: [{ accountId: 'acct-a' }],
  }]);
  assert.equal(saved[0].items[0].priority, true);
  assert.equal(saved[0].items[1].priority, undefined);

  const launch = buildTargetGroupLaunch(saved[0], {
    accounts: [{ id: 'acct-a', email: 'buyer@example.com' }],
    profiles: [{ id: 'profile-a', email: 'buyer@example.com' }],
  });
  assert.equal(launch.ok, true);
  assert.equal(launch.config.items[0].priority, true);
  assert.equal(launch.config.items[1].priority, undefined);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('Target SKU priority persist, launch, UI, and engine contract smoke test passed');
