#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
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
const profilesPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/profiles.js'), 'utf8');
const createProfile = fs.readFileSync(path.join(root, 'frontend/src/components/pages/profiles-components/create-modal.js'), 'utf8');
const targetPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/target.js'), 'utf8');
const taskGroups = fs.readFileSync(path.join(root, 'frontend/src/components/pages/task-groups.js'), 'utf8');
const accounts = fs.readFileSync(path.join(root, 'frontend/src/components/pages/accounts.js'), 'utf8');
const targetLaunch = fs.readFileSync(path.join(root, 'launcher/target-group-launch.js'), 'utf8');
const profileImap = fs.readFileSync(path.join(root, 'launcher/profile-imap-control.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'frontend/src/components/page-handler.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'frontend/src/components/store.js'), 'utf8');

assert.match(engine, /const POKEMON_SITE = engineContract\.SITES\.POKEMON_CENTER_US/);
assert.match(engine, /function startPokemonCenter\(/);
assert.match(engine, /function editPokemonCenter\(/);
assert.match(engine, /function stopPokemonCenter\(/);
assert.match(engine, /function validatePokemonInputs\(/);
assert.match(engine, /function validatePokemonProducts\(/);
assert.match(engine, /parsed\.hostname\.endsWith\('\.pokemoncenter\.com'\)/,
  'native adapter must reject arbitrary URLs before Go parses /product/');
assert.match(engine, /\.slice\(0, 3\)/, 'native adapter must enforce the three-product multi-cart limit');
assert.match(engine, /quantity: product\.quantity/, 'each product quantity must reach the Go task payload');
assert.match(engine, /profileType === 'pokemoncenter'/, 'native tasks must reject non-Pokémon Center profiles');
assert.match(engine, /billingFirstName: billingFirst/);
assert.match(engine, /profileGroup: p\.group \|\| \(Array\.isArray\(p\.groups\)/);
assert.match(engine, /function addPokemonRotationProfiles\(/);
assert.match(engine, /waitForQueue:/);
assert.match(engine, /allInstock:/);
assert.match(engine, /loopCheckout:/);
assert.match(engine, /QueueEntryDelay:/);
assert.match(engine, /manualCaptchaManager\.handleEnvelope/);
assert.match(engine, /nativeHyperBroker\.handleEnvelope/);

const productAdapter = engine.slice(
  engine.indexOf('function normalizePokemonInput'),
  engine.indexOf('function rememberPokemonConfig'),
);
const productSandbox = {
  URL,
  POKEMON_SITE: 'Pokemon Center US',
  engineContract: { normalizeStartTask: value => value },
};
vm.runInNewContext(`${productAdapter}\nresult = pokemonMessage({
  id: 'task-1', profileId: 'profile-1', products: [
    { input: '10-11111-111', quantity: '2' },
    { input: '10-22222-222', quantity: '5' },
  ],
});`, productSandbox);
assert.deepEqual(
  JSON.parse(JSON.stringify(productSandbox.result.item.map(item => ({ input: item.monitorInput, quantity: item.quantity })))),
  [
    { input: '10-11111-111', quantity: '2' },
    { input: '10-22222-222', quantity: '5' },
  ],
  'independent product quantities did not survive native task translation',
);

const profileAdapter = engine.slice(
  engine.indexOf('function normalizeCountry'),
  engine.indexOf('function buildAccountMap'),
);
const profileSandbox = {
  normalizeState: value => String(value || '').toUpperCase(),
  dm: { getProfiles: () => [{
    id: 'profile-1', profileType: 'pokemoncenter', profileName: 'Guest', email: 'guest@example.com', phone: '5551234567',
    shipping: { firstName: 'Ship', lastName: 'Name', address: '1 Ship St', city: 'Ship City', state: 'ca', zipcode: '90001', country: 'US' },
    billingSameShipping: false,
    billing: { firstName: 'Bill', lastName: 'Name', address: '2 Bill St', city: 'Bill City', state: 'ny', zipcode: '10001', country: 'US' },
    payment: { cardNumber: '4111111111111111', cardMonth: '12', cardYear: '2029', cardCvv: '123' },
  }] },
};
vm.runInNewContext(`${profileAdapter}\nresult = buildProfileMap('profile-1', '')['profile-1'];`, profileSandbox);
assert.equal(profileSandbox.result.shippingAddress1, '1 Ship St');
assert.equal(profileSandbox.result.billingFirstName, 'Bill');
assert.equal(profileSandbox.result.billingAddress1, '2 Bill St');
assert.equal(profileSandbox.result.billingState, 'NY');

assert.match(electron, /targetEngine\.startPokemonCenter/);
assert.match(electron, /targetEngine\.editPokemonCenter/);
assert.match(electron, /targetEngine\.setPokemonCenterTaskProxy/);
assert.match(electron, /targetEngine\.stopPokemonCenter/);
assert.doesNotMatch(electron, /th\.startPokemonCenter/);
assert.doesNotMatch(electron, /setPokemonSku/);

assert.match(dataManager, /function getPokemonCenterTasks\(/);
assert.match(dataManager, /function savePokemonCenterTasks\(/);
assert.match(dataManager, /pokemon-center-tasks\.json/);
assert.match(dataManager, /products: Array\.isArray/);
assert.match(dataManager, /p\.profileType !== 'pokemoncenter'/);

assert.match(page, /placeholder/);
assert.match(page, /MAX_PRODUCTS = 3/);
assert.match(page, /function validateProducts\(/);
assert.match(page, /migrateProductRows\(/);
assert.match(page, /pokemon\.products\.map/);
assert.match(page, /product\.quantity/);
assert.match(page, /ion-md-trash/);
assert.doesNotMatch(page, />×<\/button>/);
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
assert.match(store, /products: \[\{ id: 'pc_product_1', input: '', quantity: '1' \}\]/);

assert.match(createProfile, /Profile Type \*/);
assert.match(createProfile, /billingSameShipping/);
assert.match(createProfile, /Billing address is the same as shipping/);
assert.match(createProfile, /!pokemonCenter && this\.state\.imapProvider/);
assert.match(profilesPage, /pokemonCenter \? 'POKÉMON CENTER' : 'TARGET'/);
assert.match(page, /profile\.profileType === 'pokemoncenter'/);
for (const targetOnly of [targetPage, taskGroups, accounts, targetLaunch, profileImap]) {
  assert.match(targetOnly, /profileType !== 'pokemoncenter'/);
}
assert.doesNotMatch([page, profilesPage, createProfile].join('\n'), /\bPolar\b/i,
  'customer-facing Pokémon Center and profile UI must use Zyn-only branding');

for (const relative of ['public/helpers/target-engine.js', 'public/helpers/data-manager.js', 'public/electron.js']) {
  execFileSync(process.execPath, ['--check', path.join(staged, relative)]);
}

console.log(JSON.stringify({
  ok: true,
  documentedFeatures: ['SKU', 'product URL', 'placeholder', 'quantity clamp', 'three-product multi-cart',
    'loop checkout profile rotation', 'require all in stock', 'wait for queue', 'manual hCaptcha'],
}, null, 2));
