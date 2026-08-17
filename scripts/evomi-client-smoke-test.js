#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { createEvomiClient, validApiKey, EvomiError } = require('../launcher/evomi-client');

assert.equal(validApiKey('evomi-test-key-123456'), true);
assert.equal(validApiKey('  "evomi-test-key-123456"  '), true);
assert.equal(validApiKey('short'), false);
assert.equal(validApiKey('host:8000:user:pass'), false);

const calls = [];
const client = createEvomiClient({
  request: async (request) => {
    calls.push(request);
    assert.equal(request.headers['x-apikey'], 'evomi-test-key-123456');
    assert.equal(/[?&]apikey=/i.test(request.url), false, 'API key leaked into the URL');
    if (request.url.includes('/public/generate')) {
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: { raw: 'core-residential.evomi.com:1000:user:pass\n' },
      };
    }
    if (request.url.includes('/public/settings')) {
      return { status: 200, headers: {}, body: { success: true, data: { rpc: { countries: { US: 'United States' } } } } };
    }
    if (/bad/.test(request.headers['x-apikey'])) {
      return { status: 401, headers: {}, body: { success: false, error: 'nope' } };
    }
    return {
      status: 200,
      headers: {},
      body: { success: true, products: { rpc: { username: 'user', password: 'pass', balance_mb: 2048, endpoint: 'core-residential.evomi.com' } } },
    };
  },
});

(async () => {
  const account = await client.account('evomi-test-key-123456');
  assert.equal(account.products.rpc.balance_mb, 2048);
  const generated = await client.generate('evomi-test-key-123456', {
    product: 'rpc', countries: 'US', format: '2', prepend_protocol: 'false', amount: '10',
  });
  assert.equal(generated.raw.includes('core-residential.evomi.com:1000:user:pass'), true);
  assert.match(calls[calls.length - 1].url, /\/public\/generate\?/);
  await assert.rejects(() => createEvomiClient({
    request: async () => ({ status: 401, headers: {}, body: { success: false, error: 'nope' } }),
  }).account('evomi-test-key-123456'), error => error instanceof EvomiError && error.code === 'unauthorized');
  console.log(JSON.stringify({ ok: true, calls: calls.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
