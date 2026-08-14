#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'runtime-app/public/helpers/task-handler.js'), 'utf8');
assert.match(source, /nodeExecutable/);
assert.equal((source.match(/= nodeEnvironment\(/g) || []).length, 5);
assert.doesNotMatch(source, /bundledNode|vendor[^\n]*node(?:\.exe)?/);
assert.doesNotMatch(source, /const spawnEnv = \{ \.\.\.process\.env/);
console.log(JSON.stringify({ ok: true, electronAsNodeLaunches: 5, wineNodeLaunches: 0 }, null, 2));
