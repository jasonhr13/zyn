#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  comparePayloadTrees,
  payloadTree,
  payloadTreeDigest,
  verifyMacBundleIdentity,
} = require('./verify-zyn-release-payload.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-payload-integrity-smoke-'));
const expected = path.join(temporary, 'expected');
const actual = path.join(temporary, 'actual');

try {
  fs.mkdirSync(path.join(expected, 'resources', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(expected, 'Zyn.exe'), 'zyn-executable', { mode: 0o755 });
  fs.writeFileSync(path.join(expected, 'resources', 'app.asar'), 'zyn-app');
  fs.writeFileSync(path.join(expected, 'resources', 'engine', 'backend'), 'zyn-engine', { mode: 0o755 });
  fs.symlinkSync('app.asar', path.join(expected, 'resources', 'current-app'));
  fs.cpSync(expected, actual, { recursive: true, dereference: false, verbatimSymlinks: true });

  const verified = comparePayloadTrees(expected, actual, 'test artifact');
  assert.equal(verified.sha256, payloadTreeDigest(payloadTree(expected)));

  fs.rmSync(path.join(actual, 'resources', 'current-app'));
  fs.copyFileSync(
    path.join(actual, 'resources', 'app.asar'),
    path.join(actual, 'resources', 'current-app'),
  );
  assert.throws(() => comparePayloadTrees(expected, actual, 'test artifact'), /payload differs/);
  comparePayloadTrees(expected, actual, 'test artifact', { materializeSymlinks: true });

  fs.rmSync(actual, { recursive: true, force: true });
  fs.cpSync(expected, actual, { recursive: true, dereference: false, verbatimSymlinks: true });

  fs.writeFileSync(path.join(actual, 'resources', 'app.asar'), 'substituted-app');
  assert.throws(
    () => comparePayloadTrees(expected, actual, 'test artifact'),
    /payload differs from the verified app at resources\/app\.asar/,
  );

  fs.cpSync(expected, actual, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
  fs.writeFileSync(path.join(actual, 'unexpected.dll'), 'injected');
  assert.throws(
    () => comparePayloadTrees(expected, actual, 'test artifact'),
    /unexpected payload entry: unexpected\.dll/,
  );

  fs.rmSync(actual, { recursive: true, force: true });
  fs.cpSync(expected, actual, { recursive: true, dereference: false, verbatimSymlinks: true });
  fs.rmSync(path.join(actual, 'resources', 'engine', 'backend'));
  assert.throws(
    () => comparePayloadTrees(expected, actual, 'test artifact'),
    /missing payload entry: resources\/engine\/backend/,
  );

  if (process.platform === 'darwin') {
    const app = path.join(temporary, 'Zyn.app');
    const contents = path.join(app, 'Contents');
    fs.mkdirSync(contents, { recursive: true });
    const plist = path.join(contents, 'Info.plist');
    fs.writeFileSync(plist, JSON.stringify({
      CFBundleName: 'Zyn',
      CFBundleDisplayName: 'Zyn',
      CFBundleExecutable: 'Zyn',
      CFBundleIdentifier: 'com.example.zyn',
    }));
    verifyMacBundleIdentity(app, 'test app');
    fs.writeFileSync(plist, JSON.stringify({
      CFBundleName: 'Zyn',
      CFBundleDisplayName: 'Zyn',
      CFBundleExecutable: 'Zyn',
      LegacyIdentity: 'Polar AIO',
    }));
    assert.throws(() => verifyMacBundleIdentity(app, 'test app'), /Polar product identity/);
  }

  console.log('Zyn release payload integrity smoke test passed.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
