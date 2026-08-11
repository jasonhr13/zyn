#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/verify-zyn-windows-build.cjs <Zyn-win32-x64>');
  process.exit(2);
}
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const resources = path.join(appPath, 'resources');
const required = [
  'Zyn.exe',
  'resources/Zyn.ico',
  'resources/app-update.yml',
  'resources/zyn-build.json',
  'resources/app-original.asar',
  'resources/app/bootstrap.js',
  'resources/app/license-session-reason.js',
  'resources/app/runtime-manager.js',
  'resources/app/target-product-history.js',
  'resources/app/package.json',
  'resources/app/node_modules/imapflow/package.json',
  'resources/app/node_modules/ws/package.json',
  'resources/engine/backend.exe',
  'resources/vendor/node.exe',
  'resources/bot/shape-farmer.mjs',
  'resources/bot/shape-browser-pool.mjs',
  'resources/node_modules/playwright-core/browsers.json',
];
for (const relative of required) {
  assert.equal(fs.existsSync(path.join(appPath, relative)), true, `${relative} is missing`);
}
assert.equal(fs.existsSync(path.join(resources, 'vendor', 'ms-playwright')), false,
  'Chromium must download after sign-in, not ship in the Windows app');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function peMachine(file) {
  const body = fs.readFileSync(file);
  assert.equal(body.subarray(0, 2).toString('ascii'), 'MZ', `${path.basename(file)} is not a PE executable`);
  const pe = body.readUInt32LE(0x3c);
  assert.equal(body.subarray(pe, pe + 4).toString('binary'), 'PE\u0000\u0000', `${path.basename(file)} has no PE header`);
  return body.readUInt16LE(pe + 4);
}
for (const relative of ['Zyn.exe', 'resources/engine/backend.exe', 'resources/vendor/node.exe']) {
  assert.equal(peMachine(path.join(appPath, relative)), 0x8664, `${relative} is not Windows x64`);
}

const expectedEngine = contract.nativeEngines['windows-x64'];
assert.ok(expectedEngine, 'Windows native-engine contract is missing');
assert.equal(
  sha256(path.join(appPath, expectedEngine.path)),
  expectedEngine.sha256,
  'Windows native backend SHA-256 does not match the release contract',
);
const receipt = JSON.parse(fs.readFileSync(path.join(resources, 'zyn-build.json'), 'utf8'));
assert.equal(receipt.release, contract.appRelease);
assert.equal(receipt.product.name, 'Zyn');
assert.equal(receipt.product.version, contract.product.version);
assert.equal(receipt.product.platform, 'win32');
assert.equal(receipt.product.arch, 'x64');
assert.equal(receipt.runtime.delivery, 'remote');
assert.equal(receipt.runtime.backendSha256, expectedEngine.sha256);

const update = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
assert.match(update, /^url: https:\/\/updates\.rcart\.app\/windows$/m);
assert.match(update, /^updaterCacheDirName: zyn-updater-x64$/m);
const bootstrap = fs.readFileSync(path.join(resources, 'app', 'bootstrap.js'), 'utf8');
assert.match(bootstrap, /process\.platform === 'win32'[\s\S]{0,100}'https:\/\/updates\.rcart\.app\/windows'/);
assert.match(bootstrap, /process\.platform === 'win32' \? 'backend\.exe' : 'backend'/);
const runtimeManager = fs.readFileSync(path.join(resources, 'app', 'runtime-manager.js'), 'utf8');
assert.match(runtimeManager, /win32: \['chromium'\]/);
assert.match(runtimeManager, /this\.platform === 'win32' \? 'tar\.exe'/);

const launcherPackage = JSON.parse(fs.readFileSync(path.join(resources, 'app', 'package.json'), 'utf8'));
assert.equal(launcherPackage.productName, 'Zyn');
assert.equal(launcherPackage.version, contract.product.version);
const asar = require(path.join(projectRoot, 'frontend', 'node_modules', '@electron', 'asar'));
const originalPackage = JSON.parse(asar.extractFile(
  path.join(resources, 'app-original.asar'),
  'package.json',
).toString('utf8'));
assert.equal(originalPackage.name, 'zyn');
assert.equal(originalPackage.productName, 'Zyn');
assert.equal(originalPackage.version, contract.product.version);

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  version: contract.product.version,
  platform: 'win32',
  arch: 'x64',
  runtimeMode: 'remote',
}, null, 2));
