'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TARGET_PRODUCT_HISTORY_VERSION,
  createTargetProductHistoryStore,
  parseSkus,
} = require('../launcher/target-product-history');

const project = path.join(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-target-history-'));

try {
  let now = 1_000;
  const store = createTargetProductHistoryStore(directory, { now: () => now, maxItems: 3 });

  assert.deepEqual(
    parseSkus('12345678, https://www.target.com/p/example/-/A-87654321\n12345678 - Product'),
    ['12345678', '87654321'],
  );

  const migrated = store.initialize({
    titles: {
      12345678: 'Booster Bundle',
      99999999: 'Existing Cached Product',
    },
    groups: [{ skus: '12345678\nhttps://www.target.com/p/example/-/A-87654321', updatedAt: 900 }],
  });
  assert.deepEqual(migrated.map(item => item.sku), ['99999999', '12345678', '87654321']);
  assert.equal(migrated.find(item => item.sku === '12345678').name, 'Booster Bundle');
  assert.equal(migrated.find(item => item.sku === '87654321').name, '');

  now = 2_000;
  const touched = store.touchSkus(['87654321', '77777777']);
  assert.deepEqual(touched.items.map(item => item.sku), ['77777777', '87654321', '99999999']);
  assert.equal(touched.items.find(item => item.sku === '87654321').useCount, 2);

  now = 3_000;
  const resolved = store.mergeTitles({ 87654321: 'Elite Trainer Box', 77777777: '' });
  assert.equal(resolved.changed, true);
  assert.equal(resolved.items.find(item => item.sku === '87654321').name, 'Elite Trainer Box');
  assert.equal(resolved.items.find(item => item.sku === '77777777').name, '');

  now = 4_000;
  const unchanged = store.mergeTitles({ 87654321: 'Elite Trainer Box' });
  assert.equal(unchanged.changed, false);
  assert.equal(
    unchanged.items.find(item => item.sku === '87654321').lastResolvedAt,
    3_000,
    'repeated monitor polls must not rewrite or reorder history',
  );

  const reopened = createTargetProductHistoryStore(directory, { now: () => 9_000, maxItems: 3 });
  assert.deepEqual(reopened.list(), unchanged.items);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath, 'utf8')).version, TARGET_PRODUCT_HISTORY_VERSION);

  const bootstrap = fs.readFileSync(path.join(project, 'launcher', 'bootstrap.js'), 'utf8');
  const taskGroups = fs.readFileSync(path.join(project, 'frontend', 'src', 'components', 'pages', 'task-groups.js'), 'utf8');
  const macBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn.sh'), 'utf8');
  const windowsBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn-windows.sh'), 'utf8');
  assert.match(bootstrap, /for \(const method of \['startTarget', 'editTargetTasks'\]\)/,
    'all Target monitor entry points must record product history');
  assert.match(bootstrap, /skuTitles\.mergeTitles = incoming =>/,
    'resolved monitor titles must be mirrored into product history');
  assert.match(bootstrap, /ipcMain\.on\('getTargetProductHistory'/,
    'the renderer cannot load persisted product history');
  assert.match(taskGroups, /Recently monitored/);
  assert.match(taskGroups, /Search SKU or name/);
  assert.match(taskGroups, /addProductFromHistory/);
  assert.match(macBuild, /target-product-history\.js/);
  assert.match(windowsBuild, /target-product-history\.js/);

  console.log('target product history smoke test passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
