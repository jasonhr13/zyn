#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-pokemon-native-'));
const staged = path.join(temporary, 'app');
fs.cpSync(path.join(root, 'extracted', 'asar', 'public'), path.join(staged, 'public'), { recursive: true });

execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), path.join(staged, 'public', 'helpers')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-runtime-brand.js'), staged], { stdio: 'inherit' });

const read = relative => fs.readFileSync(path.join(staged, relative), 'utf8');
const engine = read('public/helpers/target-engine.js');
const electron = read('public/electron.js');
const dataManager = read('public/helpers/data-manager.js');
const page = fs.readFileSync(path.join(root, 'frontend/src/components/pages/pokemoncenter.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'frontend/src/components/page-handler.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'frontend/src/components/store.js'), 'utf8');

assert.match(engine, /const POKEMON_SITE = engineContract\.SITES\.POKEMON_CENTER_US/);
assert.match(engine, /function startPokemonCenter\(/);
assert.match(engine, /function editPokemonCenter\(/);
assert.match(engine, /function stopPokemonCenter\(/);
assert.match(engine, /function validatePokemonInputs\(/);
assert.match(engine, /parsed\.hostname\.endsWith\('\.pokemoncenter\.com'\)/,
  'native adapter must reject arbitrary URLs before Go parses /product/');
assert.match(engine, /\.slice\(0, 3\)/, 'native adapter must enforce Polar\'s three-product multi-cart limit');
assert.match(engine, /profileGroup: p\.group \|\| \(Array\.isArray\(p\.groups\)/);
assert.match(engine, /function addPokemonRotationProfiles\(/);
assert.match(engine, /waitForQueue:/);
assert.match(engine, /allInstock:/);
assert.match(engine, /loopCheckout:/);
assert.match(engine, /QueueEntryDelay:/);
assert.match(engine, /manualCaptchaManager\.handleEnvelope/);
assert.match(engine, /nativeHyperBroker\.handleEnvelope/);

assert.match(electron, /targetEngine\.startPokemonCenter/);
assert.match(electron, /targetEngine\.editPokemonCenter/);
assert.match(electron, /targetEngine\.setPokemonCenterTaskProxy/);
assert.match(electron, /targetEngine\.stopPokemonCenter/);
assert.doesNotMatch(electron, /th\.startPokemonCenter/);
assert.doesNotMatch(electron, /setPokemonSku/);

assert.match(dataManager, /function getPokemonCenterTasks\(/);
assert.match(dataManager, /function savePokemonCenterTasks\(/);
assert.match(dataManager, /pokemon-center-tasks\.json/);

assert.match(page, /placeholder/);
assert.match(page, /MAX_PRODUCTS = 3/);
assert.match(page, /function validateProducts\(/);
assert.match(page, /Tasks per profile/);
assert.match(page, /Loop checkout/);
assert.match(page, /Require all in stock/);
assert.match(page, /Wait for queue \(24\/7\)/);
assert.match(page, /keeps tasks idle until Railway reports/);
assert.match(page, /editPokemonCenter/);
assert.match(page, /setPokemonCenterTaskProxy/);
assert.match(routes, /path="\/pokemoncenter"/);
assert.match(routes, /license\.taskTypes && license\.taskTypes\.pokemoncenter/);
assert.match(store, /taskStatus: \{\}/);
assert.match(store, /case 'pokemonInput'/);

for (const relative of ['public/helpers/target-engine.js', 'public/helpers/data-manager.js', 'public/electron.js']) {
  execFileSync(process.execPath, ['--check', path.join(staged, relative)]);
}

console.log(JSON.stringify({
  ok: true,
  documentedFeatures: ['SKU', 'product URL', 'placeholder', 'quantity clamp', 'three-product multi-cart',
    'loop checkout profile rotation', 'require all in stock', 'wait for queue', 'manual hCaptcha'],
}, null, 2));
