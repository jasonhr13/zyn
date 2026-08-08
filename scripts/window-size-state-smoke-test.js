#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowSize,
  loadWindowSize,
  saveWindowSize,
} = require('../launcher/window-size-state');

assert.deepEqual(normalizeWindowSize(null), DEFAULT_WINDOW_SIZE);
assert.deepEqual(
  normalizeWindowSize({ width: 200, height: 300 }),
  MIN_WINDOW_SIZE,
);
assert.deepEqual(
  normalizeWindowSize({ width: 2000, height: 1400 }, { width: 1280, height: 720 }),
  { width: 1280, height: 720 },
);
assert.deepEqual(
  normalizeWindowSize({ width: 1024.4, height: 768.6 }),
  { width: 1024, height: 769 },
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-window-size-'));
const statePath = path.join(tempDir, 'window-size.json');
try {
  assert.deepEqual(loadWindowSize(statePath, { width: 1600, height: 1000 }), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(saveWindowSize(statePath, { width: 1040, height: 760 }), { width: 1040, height: 760 });
  assert.deepEqual(loadWindowSize(statePath, { width: 1600, height: 1000 }), { width: 1040, height: 760 });
  assert.equal(fs.existsSync(`${statePath}.${process.pid}.tmp`), false);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Window-size normalization, persistence, and atomic replacement passed.');
