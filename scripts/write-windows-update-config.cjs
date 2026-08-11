#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const appPath = process.argv[2] && path.resolve(process.argv[2]);
if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/write-windows-update-config.cjs <Zyn-win32-x64>');
  process.exit(2);
}
const output = path.join(appPath, 'resources', 'app-update.yml');
fs.writeFileSync(output, [
  'provider: generic',
  'url: https://updates.zynbot.app/windows',
  'updaterCacheDirName: zyn-updater-x64',
  '',
].join('\n'), { mode: 0o644 });
console.log(output);
