#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createClient,
  computeHwid,
  DEVICE_ID_FILE,
  loadPersistedDeviceId,
  savePersistedDeviceId,
  validDeviceId,
} = require('../launcher/license-client');

const roots = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-device-id-'));
  roots.push(root);
  return root;
};

try {
  assert.equal(validDeviceId(computeHwid()), true);
  assert.equal(validDeviceId('0123456789abcdef'), true);
  assert.equal(validDeviceId('short'), false);

  const root = temporary();
  assert.equal(loadPersistedDeviceId(root), '');
  assert.equal(savePersistedDeviceId(root, 'AaBbCcDdEeFf0011'), true);
  assert.equal(loadPersistedDeviceId(root), 'aabbccddeeff0011');
  assert.equal(fs.existsSync(path.join(root, DEVICE_ID_FILE)), true);

  const first = createClient({ dataDirectory: root });
  assert.equal(first.deviceId, 'aabbccddeeff0011');
  first.setDeviceId('ffffffffffffffff');
  assert.equal(first.deviceId, 'ffffffffffffffff');
  assert.equal(loadPersistedDeviceId(root), 'ffffffffffffffff');

  const restored = createClient({ dataDirectory: root });
  assert.equal(restored.deviceId, 'ffffffffffffffff', 'a later client must reuse the install device id');

  const fresh = temporary();
  const generated = createClient({ dataDirectory: fresh });
  assert.equal(validDeviceId(generated.deviceId), true);
  assert.equal(loadPersistedDeviceId(fresh), generated.deviceId);
  assert.equal(createClient({ dataDirectory: fresh }).deviceId, generated.deviceId);

  console.log('license client device-id smoke test passed');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
