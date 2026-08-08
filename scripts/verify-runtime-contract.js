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
  const browserPool = fs.readFileSync(path.join(resources, 'bot', 'shape-browser-pool.mjs'), 'utf8');
  const upstream = JSON.parse(fs.readFileSync(path.join(projectDir, 'config', 'native-farmer-upstream.json'), 'utf8'));
  for (const [filename, entry] of Object.entries(upstream.files)) {
    if (!filename.endsWith('.mjs')) continue;
    const expected = typeof entry === 'string' ? entry : entry.sha256;
    assert.equal(sha256(path.join(resources, 'bot', filename)), expected,
      `${filename} no longer matches pinned ${upstream.commit}`);
  }
  for (const key of ['chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'chromium']) {
    assert.match(browserPool, new RegExp(`key: '${key}'`), `native browser pool omits ${key}`);
  }
  assert.match(browserPool, /channel: 'chromium'/, 'Chromium-family browsers lack an explicit full-browser channel');

  const asar = require(path.join(projectDir, 'frontend', 'node_modules', '@electron', 'asar'));
  const targetEngine = asar.extractFile(path.join(resources, 'app-original.asar'), 'public/helpers/target-engine.js').toString('utf8');
  const runtimePaths = asar.extractFile(path.join(resources, 'app-original.asar'), 'public/helpers/runtime-paths.js').toString('utf8');
  assert.match(targetEngine, /'--headless=true'/, 'control plane does not request headless mode');
  assert.doesNotMatch(targetEngine, /'--headless=false'/, 'control plane still requests headed mode');
  assert.match(targetEngine, /const findNodeExe = nodeExecutable/, 'Target farmer does not use native Node boundary');
  assert.match(targetEngine, /nodeEnvironment\(\{ FORCE_COLOR/, 'Target farmer does not use native environment');
  assert.match(runtimePaths, /ELECTRON_RUN_AS_NODE = '1'/, 'packaged farmer does not reuse Electron as Node');
  assert.match(targetEngine, /`--capturesPerLoad=\$\{capturesPerLoad\}`/, 'control plane omits cookies-per-page');
  assert.match(targetEngine, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/, 'control plane omits browser reuse');
  assert.match(targetEngine, /`--blockHeavyResources=\$\{blockHeavyResources\}`/, 'control plane omits bandwidth control');
  assert.match(targetEngine, /`--browsers=auto`/, 'control plane does not request the six-browser pool');
  assert.match(targetEngine, /`--sessionReady=\$\{hasSession\}`/, 'control plane omits cold-login coordination');
  assert.match(targetEngine, /signalFarmerSessionReady\(\)/, 'control plane omits session-ready handoff');
  assert.match(farmer, /bag\.length >= CAPTURES_PER_LOAD/, 'farmer lacks multi-capture');
  assert.match(farmer, /randomLoadsForBrowser\(LOADS_PER_BROWSER\)/, 'farmer lacks browser reuse');
  assert.match(farmer, /argOf\('blockHeavyResources', 'true'\)/, 'farmer lacks heavy-resource blocking');
  assert.match(farmer, /activeWorkers: scale\.activeWorkers/, 'farmer omits resolved worker count');
  assert.match(farmer, /configuredWorkers: startedWorkerCount/, 'farmer omits configured worker count');
  assert.match(targetEngine, /health: j\.health \|\| null/, 'control plane drops broker worker health');

  const manifest = JSON.parse(asar.extractFile(path.join(resources, 'app-original.asar'), 'build/asset-manifest.json').toString('utf8'));
  const rendererBundlePath = `build/${manifest.files['main.js'].replace(/^\.\//, '')}`;
  const rendererBundle = asar.extractFile(path.join(resources, 'app-original.asar'), rendererBundlePath).toString('utf8');
  assert.match(rendererBundle, /Cookies per page load/, 'packaged Settings omits cookies-per-page');
  assert.match(rendererBundle, /Page loads per browser/, 'packaged Settings omits browser reuse');
  assert.match(rendererBundle, /Block images, video & fonts while farming/, 'packaged Settings omits bandwidth control');
  assert.match(rendererBundle, /Starting broker/, 'packaged task groups omit broker startup state');
  assert.match(rendererBundle, /only this task/, 'packaged task groups omit per-task logs');
  assert.doesNotMatch(rendererBundle, /R2 groups existing Target controls only/, 'packaged task groups retain the stale R2 boundary');

  const browsers = JSON.parse(fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const chromium = browsers.browsers.find((browser) => browser.name === 'chromium');
  assert.ok(chromium, 'regular Chromium descriptor is missing');
  assert.equal(
    fs.existsSync(path.join(resources, 'vendor', 'ms-playwright', `chromium-${chromium.revision}`, 'chrome-win64', 'chrome.exe')),
    true,
    'regular Chromium executable is missing',
  );
  const nativeChromium = path.join(resources, 'vendor', 'ms-playwright-mac-arm64', `chromium-${chromium.revision}`);
  assert.equal(fs.existsSync(nativeChromium), true, 'native regular Chromium revision is missing');
  const nativeExecutable = [
    path.join(nativeChromium, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(nativeChromium, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(nativeChromium, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(nativeExecutable, 'native regular Chromium executable is missing');
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
