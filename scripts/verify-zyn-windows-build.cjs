#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PELibrary = require('../release-tools/node_modules/pe-library');
const ResEdit = require('../release-tools/node_modules/resedit');
const {
  assertNoLegacyBrand,
  verifyZynPackagedBrand,
} = require('./verify-zyn-packaged-brand-boundary.cjs');

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
  'resources/app/harvester-extension-bridge.js',
  'resources/app/cloud-backup.js',
  'resources/app/cloud-backup-data.js',
  'resources/app/target-product-history.js',
  'resources/app/target-cookie-standby.js',
  'resources/app/package.json',
  'resources/app/node_modules/imapflow/package.json',
  'resources/app/node_modules/ws/package.json',
  'resources/engine/backend.exe',
  'resources/bot/shape-farmer.mjs',
  'resources/bot/shape-bank-demand.mjs',
  'resources/bot/shape-browser-pool.mjs',
  'resources/bot/target-register.mjs',
  'resources/bot/shared.mjs',
  'resources/node_modules/imapflow/package.json',
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
assert.equal(
  sha256(path.join(resources, 'Zyn.ico')),
  sha256(path.join(projectRoot, 'assets', 'brand', 'Zyn.ico')),
  'packaged Zyn.ico does not match the reviewed Zyn application icon',
);
function peMachine(file) {
  const body = fs.readFileSync(file);
  assert.equal(body.subarray(0, 2).toString('ascii'), 'MZ', `${path.basename(file)} is not a PE executable`);
  const pe = body.readUInt32LE(0x3c);
  assert.equal(body.subarray(pe, pe + 4).toString('binary'), 'PE\u0000\u0000', `${path.basename(file)} has no PE header`);
  return body.readUInt16LE(pe + 4);
}
for (const relative of ['Zyn.exe', 'resources/engine/backend.exe']) {
  assert.equal(peMachine(path.join(appPath, relative)), 0x8664, `${relative} is not Windows x64`);
}

const executable = PELibrary.NtExecutable.from(
  fs.readFileSync(path.join(appPath, 'Zyn.exe')),
  { ignoreCert: true },
);
const executableResources = PELibrary.NtExecutableResource.from(executable);
function iconFingerprints(items) {
  return items.map((item) => {
    const icon = item.data || item;
    return crypto.createHash('sha256').update(Buffer.from(icon.bin)).digest('hex');
  }).sort();
}
const reviewedIconFingerprints = iconFingerprints(
  ResEdit.Data.IconFile.from(fs.readFileSync(path.join(projectRoot, 'assets', 'brand', 'Zyn.ico'))).icons,
);
const executableIconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(executableResources.entries);
assert.ok(executableIconGroups.length > 0, 'Zyn.exe has no Windows icon resources');
for (const group of executableIconGroups) {
  assert.deepEqual(
    iconFingerprints(group.getIconItemsFromEntries(executableResources.entries)),
    reviewedIconFingerprints,
    'Zyn.exe icon resources do not match the reviewed Zyn application icon',
  );
}
const versionEntries = ResEdit.Resource.VersionInfo.fromEntries(executableResources.entries);
assert.ok(versionEntries.length > 0, 'Zyn.exe has no Windows version information');
const versionStrings = versionEntries.flatMap(version => version
  .getAllLanguagesForStringValues()
  .map(language => version.getStringValues(language)));
assert.ok(versionStrings.length > 0, 'Zyn.exe has no localized Windows version strings');
for (const values of versionStrings) {
  assert.equal(values.ProductName, 'Zyn', 'Zyn.exe ProductName must be Zyn');
  assert.equal(values.FileDescription, 'Zyn', 'Zyn.exe FileDescription must be Zyn');
  assert.equal(values.InternalName, 'Zyn', 'Zyn.exe InternalName must be Zyn');
  assert.equal(values.OriginalFilename, 'Zyn.exe', 'Zyn.exe OriginalFilename must be Zyn.exe');
  assertNoLegacyBrand(JSON.stringify(values), 'Zyn.exe Windows version information');
}

const expectedEngine = contract.nativeEngines['windows-x64'];
assert.ok(expectedEngine, 'Windows native-engine contract is missing');
const brandVerification = verifyZynPackagedBrand({
  resources,
  engineFile: path.join(appPath, expectedEngine.path),
  label: appPath,
});
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
assert.match(update, /^url: https:\/\/updates\.zynbot\.app\/windows$/m);
assert.match(update, /^updaterCacheDirName: zyn-updater-x64$/m);
const bootstrap = fs.readFileSync(path.join(resources, 'app', 'bootstrap.js'), 'utf8');
assert.match(bootstrap, /process\.platform === 'win32'[\s\S]{0,100}'https:\/\/updates\.zynbot\.app\/windows'/);
assert.match(bootstrap, /process\.platform === 'win32' \? 'backend\.exe' : 'backend'/);
assert.match(bootstrap, /setTargetHarvestAuthorized\?\.\(authorized === true\)/,
  'Windows launcher does not connect Target harvesting to license state');
assert.match(bootstrap, /targetEngine\.saveHarvesterCookie\(cookie\)/,
  'Windows launcher bypasses the Target engine authenticated extension-save capability');
const runtimeManager = fs.readFileSync(path.join(resources, 'app', 'runtime-manager.js'), 'utf8');
assert.match(runtimeManager, /win32: \['chromium', 'engine'\]/);
assert.match(runtimeManager, /process\.env\.ZYN_ENGINE_PATH = entry/);
assert.match(runtimeManager, /this\.platform === 'win32' \? 'tar\.exe'/);

const launcherPackage = JSON.parse(fs.readFileSync(path.join(resources, 'app', 'package.json'), 'utf8'));
assert.equal(launcherPackage.productName, 'Zyn');
assert.equal(launcherPackage.version, contract.product.version);
const asar = require(path.join(projectRoot, 'frontend', 'node_modules', '@electron', 'asar'));
const originalPackage = JSON.parse(asar.extractFile(
  path.join(resources, 'app-original.asar'),
  'package.json',
).toString('utf8'));
const targetEngine = asar.extractFile(
  path.join(resources, 'app-original.asar'),
  'public/helpers/target-engine.js',
).toString('utf8');
const nativeEngineContract = asar.extractFile(
  path.join(resources, 'app-original.asar'),
  'public/helpers/native-engine-contract.js',
).toString('utf8');
assert.match(targetEngine, /function targetCookieDemand\(\)/,
  'Windows Target bridge omits dynamic cookie-bank demand');
assert.match(targetEngine, /path: '\/demand'/,
  'Windows Target bridge does not publish dynamic demand');
assert.match(targetEngine, /let targetHarvestAuthorized = false/,
  'Windows Target harvest gate does not default closed');
assert.match(targetEngine, /function saveHarvesterCookie\(cookie\)/,
  'Windows Target bridge omits authenticated extension saves');
assert.match(targetEngine, /module\.exports = \{[^}]*saveHarvesterCookie/,
  'Windows Target bridge does not export its narrow extension-save capability');
assert.doesNotMatch(targetEngine, /harvesterBrokerToken/,
  'Windows Target bridge exports its raw broker token');
assert.match(targetEngine, /case 'monitor-bandwidth':/,
  'Windows Target bridge does not accept native monitor bandwidth events');
assert.match(targetEngine, /const telemetry = engineContract\.normalizeMonitorBandwidth\(m\)/,
  'Windows Target bridge does not sanitize native monitor bandwidth');
assert.match(targetEngine, /toRenderer\('targetMonitorBandwidth', telemetry\)/,
  'Windows Target bridge does not forward sanitized monitor bandwidth');
assert.match(nativeEngineContract, /function normalizeMonitorBandwidth\(/,
  'Windows native-engine contract omits monitor bandwidth validation');
assert.match(nativeEngineContract, /'analytics-event', 'monitor-bandwidth'/,
  'Windows native-engine contract does not allow the monitor bandwidth envelope');
const shapeFarmer = fs.readFileSync(path.join(resources, 'bot', 'shape-farmer.mjs'), 'utf8');
assert.match(shapeFarmer,
  /u\.pathname === '\/saveCookies'[\s\S]{0,100}if \(!tokenOk\(req\)\)/,
  'Windows cookie broker accepts unauthenticated extension writes');
const rendererManifest = JSON.parse(asar.extractFile(
  path.join(resources, 'app-original.asar'),
  'build/asset-manifest.json',
).toString('utf8'));
const rendererBundle = asar.extractFile(
  path.join(resources, 'app-original.asar'),
  `build/${rendererManifest.files['main.js'].replace(/^\.\//, '')}`,
).toString('utf8');
assert.match(rendererBundle, /ATC per task/,
  'Windows renderer omits the dynamic ATC-per-task control');
assert.match(rendererBundle, /ATC bank needs a harvester/,
  'Windows renderer omits the dynamic bank deficit warning');
assert.match(rendererBundle, /Monitor bandwidth/,
  'Windows renderer omits monitor bandwidth telemetry');
assert.match(rendererBundle, /TLS transport bytes measured by the monitor engine/,
  'Windows renderer omits monitor bandwidth measurement semantics');
assert.equal(originalPackage.name, 'zyn');
assert.equal(originalPackage.productName, 'Zyn');
assert.equal(originalPackage.description, 'Zyn Checkout Automation');
assert.equal(originalPackage.version, contract.product.version);

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  version: contract.product.version,
  platform: 'win32',
  arch: 'x64',
  runtimeMode: 'remote',
  brandVerification,
}, null, 2));
