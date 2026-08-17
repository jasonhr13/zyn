#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  createIpfistClient,
  validApiKey,
  remainingGb,
  planPrice,
  proxyText,
  IpfistError,
} = require('../launcher/ipfist-client');

assert.equal(validApiKey('ak_testkey_residential01'), true);
assert.equal(validApiKey('  "Bearer ak_testkey_residential01"  '), true);
assert.equal(validApiKey('ak_short'), false);
assert.equal(validApiKey('rf_live_not_ipfist'), false);
assert.equal(remainingGb({ data: { basic: 12.5, premium: 0.25 } }, 'basic'), 12.5);
assert.equal(remainingGb({ result: { premiumRemain: 3 } }, 'premium'), 3);
assert.equal(remainingGb({ data: { basic: { remainGb: 8 } } }, 'basic'), 8);
assert.equal(remainingGb({
  code: 200,
  message: '成功',
  body: {
    basicTotalBandWidth: 0,
    basicUsedBandwidth: 0,
    premiumTotalBandWidth: 30,
    premiumUsedBandwidth: 0,
    totalBandWidth: 30,
    usedBandwidth: 0,
  },
}, 'premium'), 30);
assert.equal(remainingGb({
  code: 200,
  body: { basicTotalBandWidth: 10, basicUsedBandwidth: 2.5, premiumTotalBandWidth: 0, premiumUsedBandwidth: 0 },
}, 'basic'), 7.5);
assert.equal(planPrice({ data: { pricePerGb: 2.4 } }), 2.4);
assert.equal(planPrice({ code: 200, body: { unitPrice: 4 } }), 4);
assert.equal(proxyText({ raw: 'gw.ipfist.com:8000:user:pass\n' }).includes('gw.ipfist.com'), true);
assert.equal(proxyText({ data: 'gw.ipfist.com:8000:user:pass' }), 'gw.ipfist.com:8000:user:pass');
assert.equal(proxyText({ code: 200, body: 'gw.ipfist.com:1818:user:pass' }), 'gw.ipfist.com:1818:user:pass');

const calls = [];
const client = createIpfistClient({
  request: async (request) => {
    calls.push(request);
    assert.equal(request.headers.authorization, 'Bearer ak_testkey_residential01');
    assert.equal(/[?&](api[_-]?key|authorization)=/i.test(request.url), false, 'API key leaked into the URL');
    if (request.url.includes('/api/ProxyLogic/Generate')) {
      assert.match(request.url, /mealType=basic/);
      assert.match(request.url, /num=10/);
      assert.match(request.url, /format=0/);
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: { raw: 'gw.ipfist.com:8000:user-US:pass\n' },
      };
    }
    if (request.url.includes('/api/ProxyLogic/GetProxyConfig')) {
      return { status: 200, headers: {}, body: { success: true, data: { host: 'gw.ipfist.com' } } };
    }
    if (request.url.includes('/api/DynamicPlan/GetPlanByMealType')) {
      return { status: 200, headers: {}, body: { code: 200, data: { pricePerGb: 1.8 } } };
    }
    if (request.url.includes('/api/Location/Search')) {
      assert.equal(request.method, 'POST');
      return { status: 200, headers: {}, body: { data: [{ state: 'california' }, { stateCode: 'TX' }] } };
    }
    if (/bad/.test(request.headers.authorization)) {
      return { status: 401, headers: {}, body: { success: false, msg: 'nope' } };
    }
    return {
      status: 200,
      headers: {},
      body: { succeeded: true, data: { basicRemain: 4, premiumRemain: 1.5 } },
    };
  },
});

(async () => {
  const bandwidth = await client.bandwidth('ak_testkey_residential01');
  assert.equal(remainingGb(bandwidth, 'basic'), 4);
  const generated = await client.generate('ak_testkey_residential01', {
    mealType: 'basic', num: '10', country: 'US', format: '0', lifeTime: '0',
  });
  assert.equal(generated.raw.includes('gw.ipfist.com:8000:user-US:pass'), true);
  assert.match(calls[calls.length - 1].url, /\/api\/ProxyLogic\/Generate\?/);
  const locations = await client.searchLocations('ak_testkey_residential01', { countryCode: 'US', mealType: 'basic' });
  assert.equal(locations.data[0].state, 'california');
  await assert.rejects(() => createIpfistClient({
    request: async () => ({ status: 401, headers: {}, body: { success: false, msg: 'nope' } }),
  }).bandwidth('ak_testkey_residential01'), error => error instanceof IpfistError && error.code === 'unauthorized');
  await assert.rejects(() => createIpfistClient({
    request: async () => ({ status: 403, headers: {}, body: { success: false, msg: 'scope' } }),
  }).bandwidth('ak_testkey_residential01'), error => error instanceof IpfistError && error.code === 'forbidden');
  console.log(JSON.stringify({ ok: true, calls: calls.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
