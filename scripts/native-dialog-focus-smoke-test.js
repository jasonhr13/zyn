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
assert.match(source, /sendSync\('nativeConfirm'/);
assert.match(source, /sendSync\('nativeAlert'/);
assert.match(source, /NATIVE_DIALOG_RESTORE_DELAYS_MS/);

const context = {
  module: { exports: {} },
  exports: {},
  setTimeout,
};
vm.createContext(context);
vm.runInContext(
  `${source.replaceAll('export function ', 'function ').replaceAll('export const ', 'const ')}\nmodule.exports = { wrapNativeDialogs, installNativeDialogFocusRestore };`,
  context,
  { filename: 'native-dialog-focus.js' },
);
const { wrapNativeDialogs } = context.module.exports;

const restored = [];
const scheduled = [];
let confirmCalls = 0;
const wrapped = wrapNativeDialogs({
  restore: () => restored.push('restored'),
  confirm: message => { confirmCalls += 1; return message === 'ok'; },
  alert: () => {},
  prompt: () => null,
  schedule: (fn, ms) => { scheduled.push(ms); fn(); },
});
assert.equal(wrapped.confirm('ok'), true);
assert.equal(wrapped.confirm('no'), false);
assert.equal(confirmCalls, 2);
assert.deepEqual(scheduled, [0, 32, 100, 0, 32, 100],
  'Windows native dialogs must restore focus after the MessageBox HWND is gone');
assert.equal(restored.length, 6,
  'native confirm must restore renderer focus after both OK and Cancel');

const electron = read('runtime-app/public/electron.js');
assert.match(electron, /ipcMain\.on\('restoreRendererFocus'/,
  'main process must restore window focus after native dialogs');
assert.match(electron, /ipcMain\.on\('focusRenderer'/,
  'main process must offer a non-bouncing renderer focus path');
assert.match(electron, /ipcMain\.on\('nativeConfirm'/,
  'main process must host confirm so Windows parents the MessageBox to Zyn');
assert.match(electron, /ipcMain\.on\('nativeAlert'/,
  'main process must host alert so Windows parents the MessageBox to Zyn');
assert.match(electron, /dialog\.showMessageBoxSync\(win/,
  'hosted confirm/alert must pass the BrowserWindow as the MessageBox parent');
assert.match(electron, /win\.setEnabled\(false\)/,
  'Windows focus restore must bounce BrowserWindow enabled state');
assert.match(electron, /setFocusable\(false\)/,
  'Windows focus restore must bounce focusable after hardware-compositing dialogs');
assert.match(electron, /app\.focus\(\{ steal: true \}\)/,
  'Windows focus restore must steal activation back from the MessageBox');
assert.match(electron, /CalculateNativeWinOcclusion/,
  'Windows must disable Chromium occlusion so RDP keeps delivering keystrokes');

const bootstrap = read('launcher/bootstrap.js');
assert.match(bootstrap, /disableWindowsNativeOcclusion/,
  'packaged Windows builds must disable native occlusion before the original app loads');
assert.match(bootstrap, /installGpuCompositing/,
  'packaged Windows builds must decide GPU compositing before the original app loads');

const index = read('frontend/src/index.js');
assert.match(index, /installNativeDialogFocusRestore/,
  'renderer bootstrap must wrap native dialogs');
assert.match(index, /installWindowsInputFocusGuard/,
  'renderer bootstrap must restore input focus on RDP click');

const css = read('frontend/src/index.css');
assert.match(css, /input, textarea, select, button, a \{[\s\S]*-webkit-app-region: no-drag/,
  'text controls must stay outside the frameless title-bar drag region');

console.log(JSON.stringify({ ok: true, restored: restored.length, ipc: 'restoreRendererFocus' }));
