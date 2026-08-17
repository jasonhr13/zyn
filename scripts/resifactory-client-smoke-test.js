#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { createResiFactoryClient, validApiKey, userMessage, ResiFactoryError } = require('../launcher/resifactory-client');

assert.equal(validApiKey('rf_live_abc123'), true);
assert.equal(validApiKey('  "Bearer rf_live_ab_cd-ef9012"  '), true);
assert.equal(validApiKey('ak_not_this'), false);
assert.equal(validApiKey('rf_live_xx'), false);
assert.match(userMessage('spend_cap_exceeded'), /spend cap/);

const calls = [];
const client = createResiFactoryClient({
  request: async (request) => {
    calls.push(request);
    if (request.url.endsWith('/me') && /bad/.test(request.headers.authorization)) {
      return { status: 401, headers: {}, body: { error: { code: 'unauthorized', message: 'nope', request_id: 'req_1' } } };
    }
    if (request.url.endsWith('/proxies')) {
      assert.equal(request.headers['idempotency-key'], 'idem-1');
      assert.equal(request.body.format, 'json');
      return { status: 200, headers: { 'rf-strict': '1' }, body: { proxies: [], is_demo: false } };
    }
    return { status: 200, headers: {}, body: { username: 'buyer' } };
  },
});

(async () => {
  await assert.rejects(() => client.me('rf_live_badkey'), error => (
    error instanceof ResiFactoryError && error.code === 'unauthorized' && /invalid or has been revoked/.test(error.message)
  ));
  const me = await client.me('rf_live_goodkey');
  assert.equal(me.username, 'buyer');
  assert.equal(calls[calls.length - 1].headers.authorization, 'Bearer rf_live_goodkey');
  await client.generate('rf_live_goodkey', { country: 'us', quantity: 10, format: 'json' }, 'idem-1');
  assert.match(calls[calls.length - 1].url, /\/proxies$/);
  console.log(JSON.stringify({ ok: true, calls: calls.length }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
