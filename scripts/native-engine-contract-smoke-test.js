#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contract = require(path.join(root, 'launcher', 'native-engine-contract'));

assert.equal(contract.PROTOCOL_VERSION, 1);
assert.equal(contract.canonicalSite('target'), 'Target');
assert.equal(contract.canonicalSite('Pokemon Center'), 'Pokemon Center US');
assert.equal(contract.canonicalSite('pokemon-center-us'), 'Pokemon Center US');
assert.equal(contract.siteKey('PCUS'), 'pokemoncenter');
assert.throws(() => contract.canonicalSite('Walmart'), /unsupported native-engine site/);

const start = contract.normalizeStartTask({
  id: 'pc-1',
  type: 'Pokemon Center',
  mode: 'Default',
  item: [],
  monitorItems: [],
  queueEntryDelay: 1250,
});
assert.equal(start.type, 'Pokemon Center US');
assert.equal(start.site, 'Pokemon Center US');
assert.equal(start.QueueEntryDelay, '1250');
assert.equal(Object.hasOwn(start, 'queueEntryDelay'), false);

const registry = new contract.TaskSiteRegistry();
registry.register('target-1', 'Target');
registry.register(start);
assert.equal(registry.resolve({ taskID: 'target-1', type: 'checkout' }), 'Target');
assert.equal(registry.resolve({ taskId: 'pc-1', type: 'declined' }), 'Pokemon Center US');
assert.equal(registry.resolve({ taskID: 'unknown', site: 'PokemonCenter' }), 'Pokemon Center US');
assert.throws(() => registry.register('pc-1', 'Target'), /already registered/);
assert.deepEqual(registry.snapshot(), { 'target-1': 'Target', 'pc-1': 'Pokemon Center US' });
registry.remove({ taskID: 'target-1' });
assert.equal(registry.resolve({ taskID: 'target-1' }), '');

const wire = contract.createEnvelope('stop-tasks', [{ id: 'pc-1' }]);
assert.deepEqual(contract.parseEnvelope(Buffer.from(JSON.stringify(wire))), wire);
assert.throws(() => contract.createEnvelope('stop-tasks', { id: 'pc-1' }), /must be an array/);
assert.throws(() => contract.parseEnvelope('{"type":"stop-tasks"}'), /must be an array/);
assert.equal(contract.FROM_ENGINE.includes('analytics-event'), true);

assert.deepEqual(contract.buildReceivedToken({
  taskId: 'pc-1',
  token: 'manual-token',
  site: 'Pokemon Center',
}), {
  type: 'received-token',
  messages: [{ taskId: 'pc-1', token: 'manual-token', site: 'Pokemon Center US' }],
});

const hyper = contract.buildHyperRequest({
  requestId: 'request-1',
  taskId: 'pc-1',
  site: 'Pokemon Center US',
  operation: 'reese84',
  payload: { pageUrl: 'https://www.pokemoncenter.com/' },
});
assert.equal(hyper.type, 'hyper-request');
assert.equal(hyper.messages[0].operation, 'reese84');
assert.throws(() => contract.buildHyperRequest({
  requestId: 'request-2', taskId: 'pc-1', site: 'Pokemon Center US', operation: 'arbitrary-url', payload: {},
}), /unsupported Hyper operation/);
assert.throws(() => contract.buildHyperRequest({
  requestId: 'request-3', taskId: 'pc-1', site: 'Pokemon Center US', operation: 'reese84',
  payload: { headers: { 'x-api-key': 'must-not-cross' } },
}), /must not cross/);

const targetBridgePath = path.join(root, 'extracted', 'asar', 'public', 'helpers', 'target-engine.js');
const targetBridge = fs.readFileSync(targetBridgePath, 'utf8');
assert.match(targetBridge, /type: 'Target',[\s\S]{0,40}site: 'Target'/,
  'Target start payload no longer carries its existing type/site fields');
assert.match(targetBridge, /const ENGINE_PORT = 8727/,
  'the established single-engine loopback transport changed unexpectedly');
assert.equal((targetBridge.match(/function spawnEngine\(/g) || []).length, 1,
  'the bridge must own exactly one native-engine spawn path');

const goRoot = process.env.POLAR_BACKEND_SOURCE
  ? path.resolve(process.env.POLAR_BACKEND_SOURCE)
  : path.resolve(root, '..', 'polar-backend-source');
if (fs.existsSync(goRoot)) {
  const schema = fs.readFileSync(path.join(goRoot, 'frontend', 'schema.go'), 'utf8');
  const websocket = fs.readFileSync(path.join(goRoot, 'frontend', 'ws.go'), 'utf8');
  const captcha = fs.readFileSync(path.join(goRoot, 'bot-base', 'captcha', 'captcha.go'), 'utf8');
  const taskSchema = fs.readFileSync(path.join(goRoot, 'bot-base', 'task', 'schema.go'), 'utf8');
  assert.match(schema, /QueueEntryDelay string `json:"QueueEntryDelay"`/,
    'Go queue-entry field spelling drifted from the compatibility contract');
  for (const type of ['send-configs', 'start-tasks', 'stop-tasks', 'edit-tasks', 'received-token']) {
    assert.match(websocket, new RegExp(`case "${type}"`), `Go frontend no longer accepts ${type}`);
  }
  assert.match(captcha, /"type": "solve-captcha"/);
  assert.match(captcha, /"taskId":\s+solve\.TaskID/);
  assert.match(taskSchema, /type AnalyticsEventMessage struct/);
  assert.match(taskSchema, /TotalCents\s+int64\s+`json:"totalCents"`/);
}

console.log(JSON.stringify({
  ok: true,
  protocolVersion: contract.PROTOCOL_VERSION,
  sites: Object.values(contract.SITES),
  toEngine: contract.TO_ENGINE.length,
  fromEngine: contract.FROM_ENGINE.length,
  goSchemaChecked: fs.existsSync(goRoot),
}, null, 2));
