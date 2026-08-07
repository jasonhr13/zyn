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
  assert.equal(Object.values(FEATURES).every(value => value === false), true, 'R0 flags are not all disabled');
});

check('build receipt', () => {
  const receipt = JSON.parse(fs.readFileSync(
    path.join(appPath, 'Contents', 'Resources', 'hope-build.json'),
    'utf8',
  ));
  assert.equal(receipt.release, contract.controlPlaneRelease);
  assert.equal(receipt.product.bundleIdentifier, product.bundleIdentifier);
  assert.equal(receipt.runtime.backendSha256, contract.immutableResources[0].sha256);
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
