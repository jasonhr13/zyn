#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
const release = String(process.argv[3] || 'R0');
if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/write-windows-build-receipt.cjs <Zyn-win32-x64> [release]');
  process.exit(2);
}

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
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

const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const { FEATURES } = require(path.join(projectRoot, 'launcher', 'feature-flags.js'));
const receipt = {
  schemaVersion: 1,
  release,
  builtAt: new Date().toISOString(),
  source: {
    commit: git(['rev-parse', 'HEAD'], 'uncommitted'),
    dirty: git(['status', '--porcelain']) !== '',
  },
  product: {
    name: contract.product.name,
    version: contract.product.version,
    bundleIdentifier: contract.product.bundleIdentifier,
    electron: contract.product.electronVersion,
    react: contract.product.reactVersion,
    platform: 'win32',
    arch: 'x64',
  },
  features: FEATURES,
  runtime: {
    delivery: 'remote',
    manifest: 'https://updates.rcart.app/runtimes/zyn-manifest-v1.json',
    backendSha256: sha256(path.join(appPath, 'resources', 'engine', 'backend.exe')),
  },
};
const output = path.join(appPath, 'resources', 'zyn-build.json');
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
console.log(output);
