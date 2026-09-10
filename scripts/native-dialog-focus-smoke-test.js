#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const source = read('frontend/src/native-dialog-focus.js');
assert.match(source, /export function wrapNativeDialogs/);
assert.match(source, /export function installNativeDialogFocusRestore/);
assert.match(source, /export function installWindowsInputFocusGuard/);
assert.match(source, /ipcRenderer\.send\('restoreRendererFocus'\)/);
assert.match(source, /ipcRenderer\.send\('focusRenderer'\)/);

const context = {
  module: { exports: {} },
  exports: {},
  setTimeout,
};
vm.createContext(context);
vm.runInContext(
  `${source.replaceAll('export function ', 'function ')}\nmodule.exports = { wrapNativeDialogs, installNativeDialogFocusRestore };`,
  context,
  { filename: 'native-dialog-focus.js' },
);
const { wrapNativeDialogs } = context.module.exports;

const restored = [];
let confirmCalls = 0;
const wrapped = wrapNativeDialogs({
  restore: () => restored.push('restored'),
  confirm: message => { confirmCalls += 1; return message === 'ok'; },
  alert: () => {},
  prompt: () => null,
  schedule: fn => fn(),
});
assert.equal(wrapped.confirm('ok'), true);
assert.equal(wrapped.confirm('no'), false);
assert.equal(confirmCalls, 2);
assert.deepEqual(restored, ['restored', 'restored'],
  'native confirm must restore renderer focus after both OK and Cancel');

const electron = read('runtime-app/public/electron.js');
assert.match(electron, /ipcMain\.on\('restoreRendererFocus'/,
  'main process must restore window focus after native dialogs');
assert.match(electron, /ipcMain\.on\('focusRenderer'/,
  'main process must offer a non-bouncing renderer focus path');
assert.match(electron, /win\.setEnabled\(false\)/,
  'Windows focus restore must bounce BrowserWindow enabled state');
assert.match(electron, /CalculateNativeWinOcclusion/,
  'Windows must disable Chromium occlusion so RDP keeps delivering keystrokes');

const bootstrap = read('launcher/bootstrap.js');
assert.match(bootstrap, /disableWindowsNativeOcclusion/,
  'packaged Windows builds must disable native occlusion before the original app loads');

const index = read('frontend/src/index.js');
assert.match(index, /installNativeDialogFocusRestore/,
  'renderer bootstrap must wrap native dialogs');
assert.match(index, /installWindowsInputFocusGuard/,
  'renderer bootstrap must restore input focus on RDP click');

const css = read('frontend/src/index.css');
assert.match(css, /input, textarea, select, button, a \{[\s\S]*-webkit-app-region: no-drag/,
  'text controls must stay outside the frameless title-bar drag region');

console.log(JSON.stringify({ ok: true, restored: restored.length, ipc: 'restoreRendererFocus' }));
