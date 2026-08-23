#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { engineSourceRoot } = require('./zyn-engine-source.cjs');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-pokemon-native-'));
const staged = path.join(temporary, 'app');
fs.cpSync(path.join(root, 'runtime-app', 'public'), path.join(staged, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, 'runtime-app', 'package.json'), path.join(staged, 'package.json'));

const read = relative => fs.readFileSync(path.join(staged, relative), 'utf8');
const engine = read('public/helpers/target-engine.js');
const electron = read('public/electron.js');
const dataManager = read('public/helpers/data-manager.js');
const page = fs.readFileSync(path.join(root, 'frontend/src/components/pages/pokemoncenter.js'), 'utf8');
const profilesPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/profiles.js'), 'utf8');
const createProfile = fs.readFileSync(path.join(root, 'frontend/src/components/pages/profiles-components/create-modal.js'), 'utf8');
const targetPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/target.js'), 'utf8');
const taskGroups = fs.readFileSync(path.join(root, 'frontend/src/components/pages/task-groups.js'), 'utf8');
const taskRuntime = fs.readFileSync(path.join(root, 'frontend/src/components/target-task-runtime.js'), 'utf8');
const accounts = fs.readFileSync(path.join(root, 'frontend/src/components/pages/accounts.js'), 'utf8');
const targetLaunch = fs.readFileSync(path.join(root, 'launcher/target-group-launch.js'), 'utf8');
const profileImap = fs.readFileSync(path.join(root, 'launcher/profile-imap-control.js'), 'utf8');
const engineRoot = engineSourceRoot();
const pokemonCheckout = fs.readFileSync(path.join(engineRoot, 'sites/pokemonCenter/checkout.go'), 'utf8');
const pokemonEdit = fs.readFileSync(path.join(engineRoot, 'sites/pokemonCenter/edit.go'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'frontend/src/components/page-handler.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'frontend/src/components/store.js'), 'utf8');

// Backup/import merge identity is retailer + email, not email alone. A single inbox can own a
// separate Target and Bandai login, while a blank legacy site aliases Bandai.
const accountImportStart = dataManager.indexOf('if (Array.isArray(bundle.accounts))');
const accountImportEnd = dataManager.indexOf('if (bundle.proxies && Array.isArray(bundle.proxies.lists))', accountImportStart);
assert.ok(accountImportStart >= 0 && accountImportEnd > accountImportStart,
  'site-aware account import fragment is missing');
const accountImportFragment = dataManager.slice(accountImportStart, accountImportEnd);
const runAccountMerge = (current, incoming) => {
  let saved = null;
  const sandbox = {
    bundle: { accounts: incoming },
    mode: 'merge',
    summary: {},
    getAccountsRaw: () => current.map(account => ({ ...account })),
    encryptSecret: value => `enc:${value}`,
    writeJSON: (filename, value) => { assert.equal(filename, 'accounts.json'); saved = value; },
  };
  vm.runInNewContext(`const replace = false; ${accountImportFragment}`, sandbox);
  return { saved: JSON.parse(JSON.stringify(saved)), summary: JSON.parse(JSON.stringify(sandbox.summary)) };
};
const multiSiteAccounts = runAccountMerge([], [
  { id: 'target', site: 'target', email: 'shared@example.com', password: 'target-password' },
  { id: 'bandai', site: 'bandai', email: 'shared@example.com', password: 'bandai-password' },
]);
assert.equal(multiSiteAccounts.saved.length, 2, 'merge dropped a same-email account from another site');
assert.equal(multiSiteAccounts.summary.accounts.added, 2);
const legacyBandaiAccount = runAccountMerge([
  { id: 'legacy', site: '', email: 'shared@example.com', password: 'already-encrypted' },
], [
  { id: 'bandai', site: 'bandai', email: 'shared@example.com', password: 'duplicate-bandai' },
  { id: 'target', site: 'target', email: 'shared@example.com', password: 'target-password' },
]);
assert.deepEqual(legacyBandaiAccount.saved.map(account => account.id), ['legacy', 'target'],
  'blank legacy account site did not alias Bandai during merge');

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
assert.match(engine, /function setPokemonQueueStreamHealth/);
assert.match(engine, /function setSolverLucaKey/);
assert.match(engine, /function publishPokemonQueueProtection/);
assert.match(engine, /from: String\(p\.from \|\| 'discord-monitor'\)/);

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

const bridgeFragment = engine.slice(
  engine.indexOf('const POKEMON_SITE = engineContract.SITES.POKEMON_CENTER_US'),
  engine.indexOf('function handleEngineMessage'),
);
let editedEnvelope = null;
let queuePing = null;
const editSandbox = {
  Buffer,
  URL,
  LOG_LINE_MAX: 1000,
  redactProxies: value => value,
  zynBrandText: value => String(value == null ? '' : value),
  toRenderer: () => {},
  engineContract: {
    SITES: { POKEMON_CENTER_US: 'Pokemon Center US' },
    normalizeStartTask: value => value,
  },
  dm: { getProfiles: () => [{ id: 'profile-1', profileType: 'pokemoncenter' }] },
  sentConfigs: { profiles: {}, proxies: {} },
  buildProfileMap: () => ({}),
  sendConfigs: () => true,
  sendToEngine: value => { editedEnvelope = value; return true; },
  sendStockPing: value => { queuePing = value; return true; },
  runningTaskIds: new Set(),
  nativeHyperBroker: { cancelPending: () => {} },
  manualCaptchaManager: { cancelPending: () => {}, cancelTask: () => {} },
};
vm.runInNewContext(`${bridgeFragment}
pokemonTaskIds.add('task-queue');
pokemonTaskConfigs.set('task-queue', {
  id: 'task-queue', profileId: 'profile-1', products: [{ input: 'placeholder', quantity: '1' }],
  monitorDelay: '3000', retryDelay: '3000', waitForQueue: true,
});
result = editPokemonCenter({ tasks: [{
  id: 'task-queue', profileId: 'profile-1', products: [
    { input: '10-33333-333', quantity: '2' },
    { input: '10-44444-444', quantity: '4' },
  ], monitorDelay: '3000', retryDelay: '3000', waitForQueue: true,
}] });
publishPokemonQueueProtection({ kind: 'captcha' });`, editSandbox);
assert.equal(editSandbox.result.ok, true, 'queued task product edit was rejected');
assert.equal(editedEnvelope.type, 'edit-tasks');
assert.deepEqual(
  JSON.parse(JSON.stringify(editedEnvelope.messages[0].item.map(item => ({ input: item.monitorInput, quantity: item.quantity })))),
  [
    { input: '10-33333-333', quantity: '2' },
    { input: '10-44444-444', quantity: '4' },
  ],
  'queued placeholder task did not receive its replacement products',
);
assert.deepEqual(JSON.parse(JSON.stringify(queuePing)), {
  site: 'PokemonCenter', sku: 'queue', name: 'Site captcha protection detected', from: 'zyn-event-stream',
});

assert.match(electron, /targetEngine\.startPokemonCenter/);
assert.match(electron, /targetEngine\.editPokemonCenter/);
assert.match(electron, /targetEngine\.setPokemonCenterTaskProxy/);
assert.match(electron, /targetEngine\.stopPokemonCenter/);
assert.doesNotMatch(electron, /th\.startPokemonCenter/);
assert.doesNotMatch(electron, /setPokemonSku/);
assert.doesNotMatch(electron, /@electron\/remote|remoteMain\.(?:initialize|enable)/,
  'staged app exposes main-process modules to the renderer');
assert.match(electron, /enableRemoteModule:\s*false/,
  'staged main window does not explicitly disable Electron remote');
assert.doesNotMatch(electron, /enableRemoteModule:\s*true/);

assert.match(dataManager, /function getPokemonCenterTasks\(/);
assert.match(dataManager, /function savePokemonCenterTasks\(/);
assert.match(dataManager, /pokemon-center-tasks\.json/);
assert.match(dataManager, /products: Array\.isArray/);
assert.match(profileImap, /profileType !== 'pokemoncenter'/);

assert.match(page, /placeholder/);
assert.match(page, /MAX_PRODUCTS = 3/);
assert.match(page, /function validateProducts\(/);
assert.match(page, /migrateProductRows\(/);
assert.match(page, /pokemon\.products\.map/);
assert.match(page, /product\.quantity/);
assert.match(page, /ion-md-trash/);
assert.doesNotMatch(page, /title="Delete task">×<\/button>/);
assert.match(page, /productsForTask/);
assert.match(page, /configuredProductCount/);
assert.match(page, /Edit task products/);
assert.match(page, /Save &amp; update task/);
assert.match(page, /including while it is waiting for or passing a queue/);
assert.match(page, /products: undefined/);
assert.match(page, /Tasks per profile/);
assert.match(page, /Loop checkout/);
assert.match(page, /Require all in stock/);
assert.match(page, /Wait for queue \(24\/7\)/);
assert.match(page, /Hide setup/);
assert.match(page, /Show setup/);
assert.match(page, /toggleSetup/);
assert.match(page, /setupSummary/);
assert.match(page, /Queue delay \$\{String\(pokemon\.queueEntryDelay \|\| '0'\)\}/);
assert.match(page, /setupOpen !== false/);
assert.match(page, /taskLogRef = React\.createRef\(\)/);
assert.match(page, /engineLogRef = React\.createRef\(\)/);
assert.match(page, /componentDidUpdate\(prevProps, prevState\)/);
assert.match(page, /node\.scrollTop = node\.scrollHeight/);
assert.match(page, /ref=\{this\.taskLogRef\}/);
assert.match(page, /ref=\{this\.engineLogRef\}/);
assert.match(page, /HTTPS queue-status endpoint every three seconds/);
assert.match(page, /30-second heartbeats, failures\/recovery/);
assert.match(page, /editPokemonCenter/);
assert.match(page, /setPokemonCenterTaskProxy/);
assert.match(page, /applyProductsToAllTasks/);
assert.match(page, /Apply to all tasks/);
assert.match(page, /Task-specific SKUs will be replaced/);
assert.match(routes, /path="\/pokemoncenter"/);
assert.match(routes, /license\.taskTypes && license\.taskTypes\.pokemoncenter/);
assert.match(store, /taskStatus: \{\}/);
assert.match(store, /case 'pokemonInput'/);
assert.match(store, /products: \[\{ id: 'pc_product_1', input: '', quantity: '1' \}\]/);

assert.match(createProfile, /Profile Type \*/);
assert.match(createProfile, /billingSameShipping/);
assert.match(createProfile, /Billing address is the same as shipping/);
assert.match(createProfile, /usesMailbox && this\.state\.imapProvider/);
assert.match(profilesPage, /pokemonCenter \? 'POKÉMON CENTER' : walmart \? 'WALMART' : 'TARGET'/);
assert.match(page, /profile\.profileType === 'pokemoncenter'/);
assert.match(taskGroups, /profileListFrom/);
for (const targetOnly of [targetPage, taskRuntime, accounts, targetLaunch, profileImap]) {
  assert.match(targetOnly, /profileType !== 'pokemoncenter'/);
}
assert.doesNotMatch([page, profilesPage, createProfile].join('\n'), /\bPolar\b/i,
  'customer-facing Pokémon Center and profile UI must use Zyn-only branding');
assert.match(pokemonCheckout, /case "handle-queue"/);
assert.match(pokemonCheckout, /DrainPendingRuntimeEdits/,
  'Pokémon Center checkout does not drain task edits while progressing through the queue');
assert.match(pokemonCheckout, /\[queue-monitor\] HTTPS poll healthy/);
assert.match(pokemonCheckout, /\[queue-monitor\] queue or site protection detected/);
assert.match(pokemonCheckout, /time\.Since\(lastHealthLog\) < 30\*time\.Second/);
assert.match(pokemonEdit, /t\.Inputs = newInputs/);
assert.match(pokemonEdit, /case "get-product", "get-availability", "add-to-cart"/,
  'live product edits do not reset product discovery before carting');

for (const relative of ['public/helpers/target-engine.js', 'public/helpers/data-manager.js', 'public/electron.js']) {
  execFileSync(process.execPath, ['--check', path.join(staged, relative)]);
}

console.log(JSON.stringify({
  ok: true,
  documentedFeatures: ['SKU', 'product URL', 'placeholder', 'quantity clamp', 'three-product multi-cart',
    'loop checkout profile rotation', 'require all in stock', 'wait for queue', 'manual hCaptcha'],
}, null, 2));
