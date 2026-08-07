#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
const release = String(process.argv[3] || 'R0');

if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/write-build-receipt.js <Hope.app> [release]');
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
const resources = path.join(appPath, 'Contents', 'Resources');
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
    electron: plistValue('HopeElectronVersion'),
    react: frontendPackage.dependencies.react,
  },
  features: FEATURES,
  runtime: {
    backendSha256: sha256(path.join(resources, 'engine', 'backend.exe')),
    windowsNodeSha256: sha256(path.join(resources, 'vendor', 'node.exe')),
    wineSha256: sha256(path.join(resources, 'wine', 'bin', 'wine')),
  },
};

const output = path.join(resources, 'hope-build.json');
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
console.log(output);
