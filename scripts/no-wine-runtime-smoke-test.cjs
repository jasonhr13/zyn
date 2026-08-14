#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const bootstrap = read('launcher/bootstrap.js');
const runtimePaths = read('native-farmer/runtime-paths.js');
const macBuild = read('scripts/build-zyn.sh');
const windowsBuild = read('scripts/build-zyn-windows.sh');
const windowsVerify = read('scripts/verify-zyn-windows-build.cjs');
const signer = read('scripts/sign-zyn-bundle.cjs');
const contract = JSON.parse(read('config/runtime-contract.json'));

assert.doesNotMatch(bootstrap, /bundledWine|winePrefix|wineserver|ZYN_WINE|spawnWithBundledWine/);
assert.match(runtimePaths, /return process\.execPath/);
assert.match(runtimePaths, /ELECTRON_RUN_AS_NODE = '1'/);
assert.match(macBuild, /rm -rf "\$RESOURCES\/wine"/);
assert.doesNotMatch(windowsBuild, /vendor\/node\.exe|bundled Windows Node/);
assert.doesNotMatch(windowsVerify, /vendor\/node\.exe/);
assert.doesNotMatch(signer, /wineEntitlements|Resources.*wine/);
assert.equal(fs.existsSync(path.join(root, 'release/entitlements.wine.plist')), false);
assert.deepEqual(contract.windowsLaunchers, []);
assert.equal(JSON.stringify(contract).includes('Resources/wine'), false);
assert.equal(JSON.stringify(contract).includes('vendor/node'), false);

console.log(JSON.stringify({
  ok: true,
  nativeEngine: true,
  electronAsNode: true,
  wineRuntime: false,
  bundledNode: false,
}, null, 2));
