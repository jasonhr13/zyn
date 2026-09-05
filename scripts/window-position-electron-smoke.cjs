#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('../bot-runtime/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const modulePath = path.resolve(process.argv[2] || path.join(root, 'launcher/window-size-state.js'));
const { normalizeWindowBounds } = require(modulePath);
const executablePath = path.join(root, `vendor/electron-v43.3.0-darwin-${process.arch}/Electron.app/Contents/MacOS/Electron`);

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-window-position-'));
  const statePath = path.join(tempDir, 'window-size.json');
  const harness = path.join(tempDir, 'main.cjs');
  // Exercise the production window-state module with native Electron windows, isolated from
  // profiles, licenses, engines, and the user's real window preferences.
  fs.writeFileSync(harness, `
    const { app, BrowserWindow, screen } = require('electron');
    const path = require('path');
    app.setPath('userData', process.env.ZYN_WINDOW_TEST_DATA);
    app.on('window-all-closed', () => {});
    require(process.env.ZYN_WINDOW_TEST_MODULE).installWindowStatePersistence({
      app, screen, statePath: path.join(app.getPath('userData'), 'window-size.json'),
    });
    app.whenReady().then(() => {
      const window = new BrowserWindow({ width: 1100, height: 700, frame: false, show: false });
      window.loadURL('data:text/html,<title>Zyn window position test</title>');
    });
  `);
  let instance;
  const launch = async () => {
    instance = await electron.launch({ executablePath, args: [harness], env: {
      ...process.env, ZYN_WINDOW_TEST_DATA: tempDir, ZYN_WINDOW_TEST_MODULE: modulePath,
    } });
    await instance.firstWindow();
  };
  const currentBounds = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  try {
    await launch();
    const { displays, primary } = await instance.evaluate(({ screen }) => ({
      displays: screen.getAllDisplays(), primary: screen.getPrimaryDisplay(),
    }));
    assert.deepEqual(await currentBounds(), normalizeWindowBounds(null, displays, primary), 'First launch centers in the work area');
    const target = normalizeWindowBounds({ width: 1000, height: 650, x: primary.workArea.x + 60, y: primary.workArea.y + 75 }, displays, primary);
    await instance.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds, false), target);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (fs.existsSync(statePath)) {
        const { version, ...saved } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (JSON.stringify(saved) === JSON.stringify(target)) break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const { version, ...saved } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(version, 2);
    assert.deepEqual(saved, target, 'Native move and resize events persist bounds');
    await instance.close();
    instance = null;

    await launch();
    assert.deepEqual(await currentBounds(), target, 'A fresh Electron process restores the saved position');
    const reopened = await instance.evaluate(async ({ BrowserWindow }) => {
      const previous = BrowserWindow.getAllWindows()[0];
      await new Promise(resolve => {
        previous.once('closed', resolve);
        previous.close();
      });
      const window = new BrowserWindow({ width: 1100, height: 700, frame: false, show: false });
      return window.getBounds();
    });
    assert.deepEqual(reopened, target, 'Recreating a closed window in the same process restores its position');
    console.log(JSON.stringify({ ok: true, nativeWindowEvents: true, relaunch: true, reopen: true, restored: target }, null, 2));
  } finally {
    if (instance) await instance.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
