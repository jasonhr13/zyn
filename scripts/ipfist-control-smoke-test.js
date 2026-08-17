#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createResiFactoryControl } = require('../launcher/resifactory-control');
const { createEvomiControl } = require('../launcher/evomi-control');
const { createIpfistControl, installIpfistIpc, KEY_SETTING } = require('../launcher/ipfist-control');

const root = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime-contract.json'), 'utf8'));
const flags = fs.readFileSync(path.join(root, 'launcher', 'feature-flags.js'), 'utf8');
const macBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn-windows.sh'), 'utf8');
assert.equal(contract.features.ipfist, true);
assert.match(flags, /ipfist:\s*true/);
assert.match(macBuild, /ipfist-client\.js ipfist-control\.js/);
assert.match(winBuild, /ipfist-client\.js ipfist-control\.js/);
assert.ok(contract.requiredResources.includes('Contents/Resources/app/ipfist-control.js'));

const settings = {
  discordWebhook: 'https://example.invalid/hook',
  resiFactoryApiKey: 'rf_live_keepme',
  evomiApiKey: 'evomi-test-key-123456',
};
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
  bandwidth: async () => ({
    code: 200,
    message: '成功',
    body: {
      basicTotalBandWidth: 6,
      basicUsedBandwidth: 0,
      premiumTotalBandWidth: 0.5,
      premiumUsedBandwidth: 0,
    },
  }),
  config: async (_key, mealType) => ({
    code: 200,
    body: {
      usProxyUrl: [`${mealType}.ipfist.com`],
      unitPrice: mealType === 'premium' ? 4 : 1.5,
      countries: ['US', 'DE'],
    },
  }),
  searchLocations: async () => ({ code: 200, body: [{ state: 'california' }, { stateCode: 'TX' }] }),
  generate: async (_key, query) => {
    assert.equal(query.mealType, 'basic');
    assert.equal(query.format, '0');
    assert.equal(query.country, 'US');
    assert.equal(query.lifeTime, '30');
    assert.equal(query.num, '10');
    return { raw: 'gw.ipfist.com:8000:user-US:pass\nhttp://gw.ipfist.com:8000:user2:pass' };
  },
};

createResiFactoryControl({
  dataManager,
  client: { me: async () => ({ username: 'rf', scopes: [], key: {}, balances: {} }) },
  logger: { warn() {} },
});
createEvomiControl({
  dataManager,
  client: {
    account: async () => ({ success: true, products: {} }),
    settings: async () => ({ success: true, data: {} }),
  },
  logger: { warn() {} },
});

const statuses = [];
const control = createIpfistControl({
  dataManager,
  client,
  onStatus: status => statuses.push(status),
  logger: { warn() {} },
});

(async () => {
  await assert.rejects(() => control.connect('short'), /ak_/);
  const connected = await control.connect('ak_testkey_residential01');
  assert.equal(connected.connected, true);
  assert.equal(connected.pools.length, 2);
  assert.equal(connected.pools[0].id, 'basic');
  assert.equal(connected.pools[0].gb, 6);
  assert.equal(connected.pools[0].pricePerGb, 1.5);
  assert.deepEqual(connected.pools[0].countries, ['us', 'de']);
  assert.deepEqual(connected.pools[0].usStates, ['california', 'TX']);
  assert.equal(connected.pools[1].id, 'premium');
  assert.equal(connected.pools[1].gb, 0.5);
  assert.equal(settings[KEY_SETTING], 'ak_testkey_residential01');
  assert.equal(settings.resiFactoryApiKey, 'rf_live_keepme');
  assert.equal(settings.evomiApiKey, 'evomi-test-key-123456');
  assert.equal(JSON.stringify(connected).includes('ak_testkey_residential01'), false);

  dataManager.saveSettings({ discordWebhook: 'https://example.invalid/other' });
  assert.equal(settings[KEY_SETTING], 'ak_testkey_residential01', 'renderer saveSettings wiped the IPFist key');
  assert.equal(settings.resiFactoryApiKey, 'rf_live_keepme', 'IPFist wrap dropped the ResiFactory key');
  assert.equal(settings.evomiApiKey, 'evomi-test-key-123456', 'IPFist wrap dropped the Evomi key');

  const generated = await control.generate({
    pool: 'basic', country: 'us', quantity: 10, proxyType: 'sticky', sessionDuration: 30, name: 'IPFist US',
  });
  assert.equal(generated.listName, 'IPFist US');
  assert.equal(generated.count, 2);
  assert.equal(lists[0].raw, 'gw.ipfist.com:8000:user-US:pass\ngw.ipfist.com:8000:user2:pass');

  const handlers = {};
  installIpfistIpc({
    ipcMain: {
      removeHandler() {},
      handle(channel, fn) { handlers[channel] = fn; },
    },
    control,
    logger: { warn() {} },
  });
  const statusResult = await handlers.ipfistStatus();
  assert.equal(statusResult.ok, true);
  assert.equal(JSON.stringify(statusResult).includes('ak_testkey_residential01'), false);

  control.disconnect();
  assert.equal(settings[KEY_SETTING], '');
  assert.equal(control.status().connected, false);

  console.log(JSON.stringify({ ok: true, generated: lists[0].name, statuses: statuses.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
