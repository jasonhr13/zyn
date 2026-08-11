#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../launcher/native-engine-contract');
const broker = require('../launcher/native-hyper-broker');

(async () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'launcher', 'bootstrap.js'), 'utf8');
  assert.match(bootstrap, /public', 'helpers', 'native-hyper-broker\.js'/);
  assert.match(bootstrap, /broker\.setAuthority\(authority\)/);

  const registry = new contract.TaskSiteRegistry();
  registry.register('pc-1', contract.SITES.POKEMON_CENTER_US);
  registry.register('target-1', contract.SITES.TARGET);
  const calls = [];
  const sent = [];
  broker.setAuthority({
    async hyper(operation, payload) {
      calls.push({ operation, payload });
      return { ok: true, status: 200, body: '{"solution":"safe"}', error: '' };
    },
  });
  const options = { registry, send: envelope => { sent.push(envelope); return true; }, logger: { warn() {} } };

  await broker.handleEnvelope(contract.buildHyperRequest({
    requestId: 'request-1',
    taskId: 'pc-1',
    site: contract.SITES.POKEMON_CENTER_US,
    operation: 'reese84',
    payload: { pageUrl: 'https://www.pokemoncenter.com/' },
  }), options);
  assert.deepEqual(calls, [{
    operation: 'reese84',
    payload: { pageUrl: 'https://www.pokemoncenter.com/' },
  }]);
  assert.equal(sent[0].type, 'hyper-response');
  assert.deepEqual(sent[0].messages[0], {
    requestId: 'request-1', taskId: 'pc-1', site: 'Pokemon Center US',
    ok: true, status: 200, body: '{"solution":"safe"}', error: '',
  });

  await broker.handleEnvelope({
    type: 'hyper-request',
    messages: [{
      requestId: 'request-secret', taskId: 'pc-1', site: 'Pokemon Center US',
      operation: 'reese84', payload: { apiKey: 'must-not-cross' },
    }],
  }, options);
  assert.equal(calls.length, 1, 'secret-bearing request reached the license authority');
  assert.equal(sent.at(-1).messages[0].status, 400);
  assert.equal(JSON.stringify(sent.at(-1)).includes('must-not-cross'), false);

  await broker.handleEnvelope({
    type: 'hyper-request',
    messages: [{
      requestId: 'request-target', taskId: 'target-1', site: 'Pokemon Center US',
      operation: 'reese84', payload: {},
    }],
  }, options);
  assert.equal(sent.at(-1).messages[0].status, 403);
  assert.equal(calls.length, 1, 'non-Pokémon task reached the license authority');

  let release;
  broker.setAuthority({
    hyper: () => new Promise(resolve => { release = resolve; }),
  });
  const first = broker.handleEnvelope(contract.buildHyperRequest({
    requestId: 'request-pending', taskId: 'pc-1', site: 'Pokemon Center US',
    operation: 'datadome-tags', payload: {},
  }), options);
  await Promise.resolve();
  assert.equal(broker.__test.pendingCount(), 1);
  await broker.handleEnvelope(contract.buildHyperRequest({
    requestId: 'request-pending', taskId: 'pc-1', site: 'Pokemon Center US',
    operation: 'datadome-tags', payload: {},
  }), options);
  assert.equal(sent.at(-1).messages[0].status, 409);
  broker.cancelPending();
  release({ ok: true, status: 200, body: '{}', error: '' });
  await first;
  assert.equal(broker.__test.pendingCount(), 0);

  console.log(JSON.stringify({
    ok: true,
    operationAllowlist: true,
    taskSiteBound: true,
    secretGuard: true,
    duplicateCorrelationGuard: true,
    disconnectCancellation: true,
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
