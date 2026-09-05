#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');
const renderedFiles = [
  'frontend/public/index.html',
  'frontend/src/index.css',
  'frontend/src/App.css',
  'frontend/src/components/title-bar.js',
  'frontend/src/components/sidebar.js',
  'frontend/src/components/license-gate.js',
  'frontend/src/components/pages/modules.js',
  'frontend/src/components/pages/pokemoncenter.js',
  'frontend/src/components/pages/profiles.js',
  'frontend/src/components/pages/profiles-components/create-modal.js',
  'frontend/src/components/pages/proxies.js',
  'frontend/src/components/pages/settings.js',
];
const rendered = renderedFiles.map(read).join('\n');
const licenseGate = read('frontend/src/components/license-gate.js');

assert.match(rendered, /Zyn/, 'rendered shell does not contain the Zyn brand');
assert.doesNotMatch(rendered, /\bHope\b/i, 'rendered shell still contains the previous brand');
assert.doesNotMatch(rendered, /\brCart\b/i, 'rendered shell still contains the retired rCart product name');
assert.doesNotMatch(rendered, /\bPolar\b/i, 'rendered shell contains a retired product name');
assert.doesNotMatch(rendered, /control[ -]plane/i, 'rendered shell still contains retired terminology');
assert.doesNotMatch(licenseGate, /one active sign-in/i, 'license gate still promises a single active sign-in');
assert.match(licenseGate, /assigned active-device limit/i, 'license gate does not explain the account device limit');
assert.match(licenseGate, /least recently active session/i, 'license gate does not explain session replacement at the limit');
for (const color of ['#450A0A', '#7F1D1D', '#BE123C', '#E11D48', '#F97316', '#FBBF24']) {
  assert.match(read('frontend/src/index.css'), new RegExp(color, 'i'), `theme omits ${color}`);
}

const contract = JSON.parse(read('config/runtime-contract.json'));
assert.equal(contract.product.name, 'Zyn');
assert.equal(contract.product.bundleIdentifier, 'com.thwebco.zyn');
assert.equal(contract.appRelease, 'R8.56');
assert.ok(fs.statSync(path.join(project, 'assets/brand/Zyn.icns')).size > 100_000, 'Zyn icon is missing');
assert.ok(fs.statSync(path.join(project, 'frontend/public/zyn-icon.png')).size > 100_000, 'renderer icon is missing');

console.log(JSON.stringify({
  ok: true,
  product: contract.product.name,
  release: contract.appRelease,
  palette: ['#450A0A', '#7F1D1D', '#BE123C', '#E11D48', '#F97316', '#FBBF24'],
}, null, 2));
