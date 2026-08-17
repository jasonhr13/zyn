#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createResiFactoryControl } = require('../launcher/resifactory-control');
const { createEvomiControl, installEvomiIpc, KEY_SETTING } = require('../launcher/evomi-control');

const root = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime-contract.json'), 'utf8'));
const flags = fs.readFileSync(path.join(root, 'launcher', 'feature-flags.js'), 'utf8');
const macBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn-windows.sh'), 'utf8');
assert.equal(contract.features.evomi, true);
assert.match(flags, /evomi:\s*true/);
assert.match(macBuild, /evomi-client\.js evomi-control\.js/);
assert.match(winBuild, /evomi-client\.js evomi-control\.js/);
assert.ok(contract.requiredResources.includes('Contents/Resources/app/evomi-control.js'));

const settings = { discordWebhook: 'https://example.invalid/hook', resiFactoryApiKey: 'rf_live_keepme' };
const lists = [];
const dataManager = {
  getSettings: () => ({ ...settings }),
  saveSettings(next) {
    Object.keys(settings).forEach(key => { delete settings[key]; });
    Object.assign(settings, next);
  },
  getProxies: () => ({ lists: lists.map(list => ({ ...list })) }),
  saveProxyList(name, raw) { lists.push({ name, raw }); },
};

const client = {
  account: async () => ({
    success: true,
    products: {
      rpc: {
        username: 'user',
        password: 'pass',
        balance_mb: 2048,
        endpoint: 'core-residential.evomi.com',
      },
      static_residential: { packages: [] },
    },
  }),
  settings: async () => ({
    success: true,
    data: { rpc: { countries: { US: 'United States', DE: 'Germany' }, regions: { data: ['california'] } } },
  }),
  generate: async (_key, query) => {
    assert.equal(query.format, '2');
    assert.equal(query.prepend_protocol, 'false');
    assert.equal(query.countries, 'US');
    assert.equal(query.session, 'sticky');
    return { raw: 'core-residential.evomi.com:1000:user-US:pass\nhttp://core-residential.evomi.com:1000:user2:pass' };
  },
};

createResiFactoryControl({
  dataManager,
  client: { me: async () => ({ username: 'rf', scopes: [], key: {}, balances: {} }) },
  logger: { warn() {} },
});

const statuses = [];
const control = createEvomiControl({
  dataManager,
  client,
  onStatus: status => statuses.push(status),
  logger: { warn() {} },
});

(async () => {
  await assert.rejects(() => control.connect('short'), /Evomi API key/);
  const connected = await control.connect('evomi-test-key-123456');
  assert.equal(connected.connected, true);
  assert.equal(connected.pools.length, 1);
  assert.equal(connected.pools[0].id, 'rpc');
  assert.equal(connected.pools[0].gb, 2);
  assert.deepEqual(connected.pools[0].countries, ['us', 'de']);
  assert.equal(settings[KEY_SETTING], 'evomi-test-key-123456');
  assert.equal(settings.resiFactoryApiKey, 'rf_live_keepme');
  assert.equal(JSON.stringify(connected).includes('evomi-test-key-123456'), false);

  dataManager.saveSettings({ discordWebhook: 'https://example.invalid/other' });
  assert.equal(settings[KEY_SETTING], 'evomi-test-key-123456', 'renderer saveSettings wiped the Evomi key');
  assert.equal(settings.resiFactoryApiKey, 'rf_live_keepme', 'Evomi wrap dropped the ResiFactory key');

  const generated = await control.generate({
    pool: 'rpc', country: 'us', quantity: 10, proxyType: 'sticky', sessionDuration: 30, name: 'Evomi US',
  });
  assert.equal(generated.listName, 'Evomi US');
  assert.equal(generated.count, 2);
  assert.equal(lists[0].raw, 'core-residential.evomi.com:1000:user-US:pass\ncore-residential.evomi.com:1000:user2:pass');

  const handlers = {};
  installEvomiIpc({
    ipcMain: {
      removeHandler() {},
      handle(channel, fn) { handlers[channel] = fn; },
    },
    control,
    logger: { warn() {} },
  });
  const statusResult = await handlers.evomiStatus();
  assert.equal(statusResult.ok, true);
  assert.equal(JSON.stringify(statusResult).includes('evomi-test-key-123456'), false);

  control.disconnect();
  assert.equal(settings[KEY_SETTING], '');
  assert.equal(control.status().connected, false);

  console.log(JSON.stringify({ ok: true, generated: lists[0].name, statuses: statuses.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
