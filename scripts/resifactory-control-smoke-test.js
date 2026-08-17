#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createResiFactoryControl,
  installResiFactoryIpc,
  uniqueListName,
  KEY_SETTING,
} = require('../launcher/resifactory-control');

const root = path.resolve(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'config', 'runtime-contract.json'), 'utf8'));
const flags = fs.readFileSync(path.join(root, 'launcher', 'feature-flags.js'), 'utf8');
const macBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(root, 'scripts', 'build-zyn-windows.sh'), 'utf8');
assert.equal(contract.features.resiFactory, true);
assert.match(flags, /resiFactory:\s*true/);
assert.match(macBuild, /resifactory-client\.js resifactory-control\.js/);
assert.match(winBuild, /resifactory-client\.js resifactory-control\.js/);
assert.ok(contract.requiredResources.includes('Contents/Resources/app/resifactory-control.js'));

assert.equal(uniqueListName('ResiFactory US', ['ResiFactory US', 'other']), 'ResiFactory US 2');
assert.equal(uniqueListName('ResiFactory US', []), 'ResiFactory US');

const settings = { discordWebhook: 'https://example.invalid/hook' };
const lists = [];
const dataManager = {
  getSettings: () => ({ ...settings }),
  saveSettings(next) { Object.assign(settings, next); },
  getProxies: () => ({ lists: lists.map(list => ({ ...list })) }),
  saveProxyList(name, raw) { lists.push({ name, raw }); },
};

const responses = {
  me: {
    id: 9,
    username: 'jason',
    scopes: ['proxies:generate', 'usage:read', 'pools:read', 'billing:write'],
    balances: { walmart_premium: { gb: 2.5, price_per_gb: 3.2, currency: 'USD' } },
    key: { name: 'Zyn', prefix: 'rf_live_abcd', last4: 'wxyz', spend_cap_usd: 50 },
  },
  pools: {
    pools: [{
      id: 'walmart_premium',
      label: 'Walmart Premium',
      host: 'premium.resifactory.net',
      access: 'granted',
      status: 'available',
      price_per_gb: 3.2,
      currency: 'USD',
      proxy_types: ['rotating', 'sticky'],
      targeting: { geo_supported: true, countries: ['us'], us_states: ['california'] },
    }],
  },
  generate: {
    proxies: [{ host: 'premium.resifactory.net', port: 7777, username: 'user~us~1', password: 'pass' }],
    count: 1,
    is_demo: false,
    country: 'US',
    pool: 'walmart_premium',
    proxy_type: 'sticky',
  },
  topup: {
    id: 44,
    status: 'pending',
    method: 'checkout',
    checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    amount_usd: 3.2,
    gb: 1,
    pool: 'walmart_premium',
  },
  getTopup: { id: 44, status: 'pending', pool: 'walmart_premium', gb: 1, amount_usd: 3.2 },
};

const client = {
  me: async () => structuredClone(responses.me),
  pools: async () => structuredClone(responses.pools),
  generate: async (_key, body) => {
    if (body.forceDemo) return { ...responses.generate, is_demo: true };
    return structuredClone(responses.generate);
  },
  startTopup: async () => structuredClone(responses.topup),
  getTopup: async () => structuredClone(responses.getTopup),
};

const opened = [];
const statuses = [];
const control = createResiFactoryControl({
  dataManager,
  client,
  randomId: () => 'fixedid',
  onStatus: status => statuses.push(status),
  logger: { warn() {} },
});

(async () => {
  await assert.rejects(() => control.connect('nope'), /rf_live_/);
  const connected = await control.connect('rf_live_secretkey');
  assert.equal(connected.connected, true);
  assert.equal(connected.username, 'jason');
  assert.equal(connected.keyLast4, 'wxyz');
  assert.equal(connected.billingReady, true);
  assert.equal(connected.pools[0].gb, 2.5);
  assert.equal(settings[KEY_SETTING], 'rf_live_secretkey');
  assert.equal(JSON.stringify(connected).includes('rf_live_secretkey'), false, 'status leaked the API key');

  dataManager.saveSettings({ discordWebhook: 'https://example.invalid/other' });
  assert.equal(settings[KEY_SETTING], 'rf_live_secretkey', 'renderer saveSettings wiped the ResiFactory key');
  assert.equal(settings.discordWebhook, 'https://example.invalid/other');

  responses.generate.is_demo = true;
  client.generate = async () => ({ ...responses.generate, is_demo: true });
  await assert.rejects(() => control.generate({
    pool: 'walmart_premium', country: 'us', quantity: 10, proxyType: 'sticky',
  }), /demo credentials/);
  assert.equal(lists.length, 0, 'demo credentials were saved');

  client.generate = async () => structuredClone({ ...responses.generate, is_demo: false });
  const generated = await control.generate({
    pool: 'walmart_premium', country: 'us', quantity: 10, proxyType: 'sticky', name: 'RF Target',
  });
  assert.equal(generated.listName, 'RF Target');
  assert.equal(generated.count, 1);
  assert.equal(lists[0].raw, 'premium.resifactory.net:7777:user~us~1:pass');

  const topup = await control.startTopup({ pool: 'walmart_premium', gb: 1 }, {
    openExternal: async (url) => { opened.push(url); },
  });
  assert.equal(opened[0], 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.equal(topup.topup.amountUsd, 3.2);
  assert.equal(control.status().pendingTopup.gb, 1);

  responses.getTopup.status = 'paid';
  responses.me.balances.walmart_premium.gb = 3.5;
  const polled = await control.pollTopup();
  assert.equal(polled.topup.status, 'paid');
  assert.equal(control.status().pendingTopup, null);
  assert.equal(control.status().pools[0].gb, 3.5);

  const handlers = {};
  installResiFactoryIpc({
    ipcMain: {
      removeHandler() {},
      handle(channel, fn) { handlers[channel] = fn; },
    },
    control,
    shell: { openExternal: async () => {} },
    logger: { warn() {} },
  });
  const statusResult = await handlers.resiFactoryStatus();
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.status.connected, true);
  assert.equal(JSON.stringify(statusResult).includes('rf_live_secretkey'), false);

  control.disconnect();
  assert.equal(settings[KEY_SETTING], '');
  assert.equal(control.status().connected, false);

  console.log(JSON.stringify({
    ok: true,
    generated: lists[0].name,
    openedCheckout: opened.length === 1,
    statuses: statuses.length,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
