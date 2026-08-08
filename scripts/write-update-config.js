#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const appPath = process.argv[2] && path.resolve(process.argv[2]);
const requestedArch = String(process.argv[3] || '').toLowerCase();
const arch = requestedArch === 'x86_64' ? 'x64' : requestedArch;

if (!appPath || !fs.existsSync(appPath) || !['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/write-update-config.js <Zyn.app> <arm64|x64>');
  process.exit(2);
}

const output = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
const body = [
  'provider: generic',
  `url: https://updates.rcart.app/mac/${arch}`,
  `updaterCacheDirName: zyn-updater-${arch}`,
  '',
].join('\n');
fs.writeFileSync(output, body, { mode: 0o644 });
console.log(output);
