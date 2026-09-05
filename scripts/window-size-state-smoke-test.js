#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowSize,
  normalizeWindowBounds,
  loadWindowBounds,
  saveWindowBounds,
  installWindowStatePersistence,
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
const primary = { workArea: { x: 0, y: 25, width: 1600, height: 975 } };
const left = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
const above = { workArea: { x: 0, y: -1080, width: 1920, height: 1080 } };
const displays = [primary, left, above];
const centered = { width: 1100, height: 700, x: 250, y: 163 };
const onLeft = { width: 1040, height: 760, x: -1700, y: 140 };

class TestWindow extends EventEmitter {
  constructor(bounds, parent = null) {
    super();
    this.bounds = bounds;
    this.parent = parent;
    this.destroyed = false;
  }
  getParentWindow() { return this.parent; }
  getNormalBounds() { return this.bounds; }
  isDestroyed() { return this.destroyed; }
  setMinimumSize(width, height) { this.minimum = { width, height }; }
  setBounds(bounds) { this.bounds = bounds; }
  close() {
    this.emit('close');
    this.destroyed = true;
    this.emit('closed');
  }
}

async function main() {
  try {
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), centered);
    assert.deepEqual(saveWindowBounds(statePath, onLeft), onLeft);
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), onLeft);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 2);
    assert.equal(fs.existsSync(`${statePath}.${process.pid}.tmp`), false);

    // A missing monitor falls back to the primary, retaining the saved size.
    assert.deepEqual(loadWindowBounds(statePath, [primary], primary), { width: 1040, height: 760, x: 280, y: 133 });
    assert.deepEqual(normalizeWindowBounds({ width: 1100, height: 700, x: 100, y: -1000 }, displays, primary), { width: 1100, height: 700, x: 100, y: -1000 });
    assert.deepEqual(normalizeWindowBounds({ width: 1100, height: 700, x: 1450, y: 900 }, [primary], primary), { width: 1100, height: 700, x: 500, y: 300 });
    assert.deepEqual(normalizeWindowBounds({ width: 2000, height: 1400, x: 0, y: 0 }, [primary], primary), primary.workArea);

    // Migrate dimensions-only files, and recover cleanly from invalid state.
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, width: 1040, height: 760 }));
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), { width: 1040, height: 760, x: 280, y: 133 });
    fs.writeFileSync(statePath, 'not valid JSON');
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), centered);
    assert.deepEqual(normalizeWindowBounds({ x: '200', y: null, width: -1, height: Infinity }, displays, primary), centered);

    const app = new EventEmitter();
    const errors = [];
    installWindowStatePersistence({ app, statePath, screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => primary }, log: { error: error => errors.push(error) } });
    const window = new TestWindow({ x: 500, y: 600, width: 1100, height: 700 });
    app.emit('browser-window-created', {}, window);
    assert.deepEqual(window.bounds, centered);
    assert.deepEqual(window.minimum, MIN_WINDOW_SIZE);
    const childBounds = { x: 300, y: 250, width: 400, height: 300 };
    const child = new TestWindow(childBounds, window);
    app.emit('browser-window-created', {}, child);
    assert.deepEqual(child.bounds, childBounds);

    window.bounds = onLeft;
    window.emit('move');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), onLeft, 'Moving saves without requiring a resize or quit');
    const resized = { ...onLeft, width: 1200 };
    window.bounds = resized;
    window.emit('resize');
    window.close();
    assert.deepEqual(loadWindowBounds(statePath, displays, primary), resized, 'Close flushes a pending change');
    const reopened = new TestWindow({});
    app.emit('browser-window-created', {}, reopened);
    assert.deepEqual(reopened.bounds, resized, 'Reopening from the Dock restores the main window too');
    reopened.close();
    assert.deepEqual(errors, []);
    console.log('Window position, monitor fallback, legacy migration, move/close persistence, and reopening passed.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
