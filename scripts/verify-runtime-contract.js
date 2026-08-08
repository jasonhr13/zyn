#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
const contractPath = path.join(projectDir, 'config', 'runtime-contract.json');

if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/verify-runtime-contract.js <Hope.app>');
  process.exit(2);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const failures = [];

function check(label, operation) {
  try {
    operation();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plistValue(key) {
  return execFileSync('plutil', [
    '-extract', key, 'raw', path.join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim();
}

for (const resource of contract.immutableResources) {
  check(resource.path, () => {
    const file = path.join(appPath, resource.path);
    assert.equal(fs.statSync(file).isFile(), true, 'is not a regular file');
    assert.equal(sha256(file), resource.sha256, 'SHA-256 does not match the frozen contract');
  });
}

for (const relative of contract.requiredResources) {
  check(relative, () => assert.equal(fs.existsSync(path.join(appPath, relative)), true, 'is missing'));
}

for (const link of contract.symlinks) {
  check(link.path, () => {
    const file = path.join(appPath, link.path);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'is not a symbolic link');
    assert.equal(fs.readlinkSync(file), link.target, 'points at the wrong target');
  });
}

const product = contract.product;
const plistChecks = {
  CFBundleDisplayName: product.name,
  CFBundleShortVersionString: product.version,
  CFBundleIdentifier: product.bundleIdentifier,
  HopeElectronVersion: product.electronVersion,
  HopeReactVersion: product.reactVersion,
  HopeControlPlaneRelease: contract.controlPlaneRelease,
};
for (const [key, expected] of Object.entries(plistChecks)) {
  check(`Info.plist ${key}`, () => assert.equal(plistValue(key), expected));
}

check('feature flags', () => {
  const flagsPath = path.join(appPath, 'Contents', 'Resources', 'app', 'feature-flags.js');
  const { CONTROL_PLANE_RELEASE, FEATURES } = require(flagsPath);
  assert.equal(CONTROL_PLANE_RELEASE, contract.controlPlaneRelease);
  assert.deepEqual(FEATURES, contract.features, 'packaged feature flags do not match the release contract');
});

check('build receipt', () => {
  const receipt = JSON.parse(fs.readFileSync(
    path.join(appPath, 'Contents', 'Resources', 'hope-build.json'),
    'utf8',
  ));
  assert.equal(receipt.release, contract.controlPlaneRelease);
  assert.equal(receipt.product.bundleIdentifier, product.bundleIdentifier);
  assert.equal(receipt.runtime.backendSha256, contract.immutableResources[0].sha256);
  assert.deepEqual(receipt.features, contract.features);
});

check('Target farmer New Headless launch contract', () => {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const farmer = fs.readFileSync(path.join(resources, 'bot', 'shape-farmer.mjs'), 'utf8');
  assert.match(farmer, /const HEADLESS = argOf\('headless', 'true'\) === 'true'/, 'farmer does not default to headless');
  assert.match(farmer, /\{ key: 'chromium', channel: 'chromium', realBrand: false \}/, 'bundled Chromium lacks its explicit channel');
  assert.doesNotMatch(farmer, /\{ key: 'chromium', channel: null, realBrand: false \}/, 'bundled Chromium can fall through to headless shell');

  const asar = require(path.join(projectDir, 'frontend', 'node_modules', '@electron', 'asar'));
  const targetEngine = asar.extractFile(path.join(resources, 'app-original.asar'), 'public/helpers/target-engine.js').toString('utf8');
  assert.match(targetEngine, /'--headless=true'/, 'control plane does not request headless mode');
  assert.doesNotMatch(targetEngine, /'--headless=false'/, 'control plane still requests headed mode');

  const browsers = JSON.parse(fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const chromium = browsers.browsers.find((browser) => browser.name === 'chromium');
  assert.ok(chromium, 'regular Chromium descriptor is missing');
  assert.equal(
    fs.existsSync(path.join(resources, 'vendor', 'ms-playwright', `chromium-${chromium.revision}`, 'chrome-win64', 'chrome.exe')),
    true,
    'regular Chromium executable is missing',
  );
  const coreBundle = fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf8');
  assert.match(coreBundle, /options\.channel && registry\.isChromiumAlias\(options\.channel\)[\s\S]{0,80}return "chromium"/, 'Playwright does not map the chromium channel to regular Chromium');
});

if (failures.length) {
  console.error(`Runtime contract failed for ${appPath}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  release: contract.controlPlaneRelease,
  immutableResources: contract.immutableResources.length,
  requiredResources: contract.requiredResources.length,
  windowsLaunchers: contract.windowsLaunchers,
}, null, 2));
