#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare-zyn-electron.cjs'), 'windows-x64'], {
  stdio: 'inherit',
});
process.exit(result.status == null ? 1 : result.status);
