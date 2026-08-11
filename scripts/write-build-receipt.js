#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
const release = String(process.argv[3] || 'R0');
const runtimeMode = String(process.argv[4] || 'bundled');

if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/write-build-receipt.js <Zyn.app> [release]');
  process.exit(2);
}

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
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

const frontendPackage = JSON.parse(fs.readFileSync(
  path.join(projectDir, 'frontend', 'package.json'),
  'utf8',
));
const { FEATURES } = require(path.join(projectDir, 'launcher', 'feature-flags.js'));
const contract = JSON.parse(fs.readFileSync(path.join(projectDir, 'config', 'runtime-contract.json'), 'utf8'));
const resources = path.join(appPath, 'Contents', 'Resources');
const runtimeHash = relative => {
  const file = path.join(resources, relative);
  return fs.existsSync(file) ? sha256(file) : '';
};
const receipt = {
  schemaVersion: 1,
  release,
  builtAt: new Date().toISOString(),
  source: {
    commit: git(['rev-parse', 'HEAD'], 'uncommitted'),
    dirty: git(['status', '--porcelain']) !== '',
  },
  product: {
    name: plistValue('CFBundleDisplayName'),
    version: plistValue('CFBundleShortVersionString'),
    bundleIdentifier: plistValue('CFBundleIdentifier'),
    electron: plistValue('ZynElectronVersion'),
    react: frontendPackage.dependencies.react,
    arch: plistValue('ZynArchitecture'),
  },
  features: FEATURES,
  runtime: {
    delivery: runtimeMode,
    manifest: runtimeMode === 'remote' ? 'https://updates.zynbot.app/runtimes/zyn-manifest-v1.json' : '',
    backendSha256: runtimeHash('engine/backend'),
  },
};

const output = path.join(resources, 'zyn-build.json');
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
console.log(output);
