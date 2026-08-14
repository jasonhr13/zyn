#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../frontend/node_modules/@electron/asar');

const root = path.resolve(__dirname, '..');
const app = path.resolve(process.argv[2] || path.join(root, 'dist', 'Zyn-mac-arm64.app'));
const resources = app.endsWith('.app')
  ? path.join(app, 'Contents', 'Resources')
  : path.join(app, 'resources');
const archive = path.join(resources, 'app-original.asar');

assert.equal(fs.existsSync(archive), true, `Missing packaged runtime archive: ${archive}`);
assert.equal(fs.existsSync(path.join(resources, 'bot', 'target-register.mjs')), true,
  'Packaged Target generator script is missing');

const mainAssets = asar.listPackage(archive)
  .filter(file => /build\/static\/js\/main\..*\.js$/.test(file));
assert.equal(mainAssets.length, 1, `Expected one compiled renderer asset, found ${mainAssets.length}`);
const source = asar.extractFile(archive, mainAssets[0].replace(/^\//, '')).toString('utf8');

for (const text of [
  'Generate Target Accounts',
  'Target signup does not use SMS or an address',
  'Account webhook',
  'Add Catchall',
  'Create matching profiles from',
  'Jig shipping',
]) assert.equal(source.includes(text), true, `Packaged Accounts generator is missing: ${text}`);

console.log(JSON.stringify({
  ok: true,
  app,
  renderer: mainAssets[0],
  liveAccountsGenerator: true,
}, null, 2));
