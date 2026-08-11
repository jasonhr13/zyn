#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TASK_GROUP_SCHEMA_VERSION,
  createTaskGroupStore,
} = require('../launcher/task-group-store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-task-groups-'));
let sequence = 0;
const store = createTaskGroupStore(directory, {
  createId: () => `test-${++sequence}`,
  now: 1735689600000,
});

try {
  const legacy = {
    skus: '12345678\nhttps://www.target.com/p/example/-/A-87654321',
    tasks: [
      { id: 'legacy-task', accountId: 'account-1', proxyListName: 'Residential', repeatCheckout: true },
    ],
  };
  const legacyPath = path.join(directory, 'target-tasks.json');
  fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
  const originalLegacy = fs.readFileSync(legacyPath, 'utf8');

  const migrated = store.load();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].name, 'Recovered Target Tasks');
  assert.equal(migrated[0].tasks[0].accountId, 'account-1');
  assert.equal(migrated[0].tasks[0].loopCheckout, true, 'legacy repeat-checkout setting was not migrated');
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), originalLegacy, 'legacy rollback file changed');

  const persisted = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(persisted.version, TASK_GROUP_SCHEMA_VERSION);
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);

  const saved = store.save([{
    id: 'drop-a',
    name: '  Friday Drop  ',
    site: 'unsupported-site',
    skus: '11111111',
    qty: 999,
    proxyListName: 'Local',
    loopCheckout: true,
    schedule: { startAt: 1735689660000, stopAt: 1735693260000 },
    tasks: [
      { id: 'task-a', accountId: 'acct-a', profileId: 'profile-a', cardId: 'card-a', loopCheckout: false },
      { id: 'task-a', accountId: 'acct-b' },
      { id: 'task-b', accountId: 'acct-a' },
      { id: 'task-c', accountId: 'acct-c' },
      { id: 'discard-me' },
    ],
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Friday Drop');
  assert.equal(saved[0].site, 'target');
  assert.equal(saved[0].qty, 99);
  assert.equal(saved[0].loopCheckout, true);
  assert.equal(saved[0].tasks.length, 2);
  assert.equal(saved[0].tasks[0].cardId, 'card-a');
  assert.equal(saved[0].tasks[0].loopCheckout, false, 'task-level loop override was discarded');
  assert.equal(saved[0].tasks[1].loopCheckout, true, 'task did not inherit its group loop default');
  assert.deepEqual(saved[0].schedule, { startAt: 1735689660000, stopAt: 1735693260000 });
  assert.deepEqual(store.load(), saved);

  const backups = fs.readdirSync(path.join(directory, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  console.log('Task-group migration, normalization, backup, permissions, and atomic replacement passed.');
} finally {
  if (directory.startsWith(os.tmpdir() + path.sep + 'zyn-task-groups-')) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
