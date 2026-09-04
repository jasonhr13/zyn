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
assert.equal(contract.canonicalSite('Walmart'), 'Walmart');
assert.equal(contract.siteKey('walmart'), 'walmart');

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
assert.equal(contract.FROM_ENGINE.includes('task-telemetry'), true);
assert.equal(contract.FROM_ENGINE.includes('monitor-bandwidth'), true);

const monitorBandwidth = {
  schemaVersion: 1,
  measurement: 'tls-client-wire',
  monitorId: 'target-monitor',
  runId: 'run-0123456789abcdef',
  site: 'target',
  startedAt: 1_000_000,
  observedAt: 1_060_000,
  sequence: 1,
  running: true,
  downloadBytes: 6_000,
  uploadBytes: 600,
  totalBytes: 6_600,
  proxyDownloadBytes: 5_000,
  proxyUploadBytes: 500,
  directDownloadBytes: 1_000,
  directUploadBytes: 100,
  polls: 20,
  failedPolls: 2,
  watchedItems: 3,
  cookie: 'must-not-cross',
  proxyUrl: 'http://user:password@proxy.example:1234',
};
assert.deepEqual(contract.normalizeMonitorBandwidth(monitorBandwidth, 1_060_000), {
  schemaVersion: 1,
  measurement: 'tls-client-wire',
  monitorId: 'target-monitor',
  runId: 'run-0123456789abcdef',
  site: 'Target',
  startedAt: 1_000_000,
  observedAt: 1_060_000,
  sequence: 1,
  running: true,
  downloadBytes: 6_000,
  uploadBytes: 600,
  totalBytes: 6_600,
  proxyDownloadBytes: 5_000,
  proxyUploadBytes: 500,
  directDownloadBytes: 1_000,
  directUploadBytes: 100,
  polls: 20,
  failedPolls: 2,
  watchedItems: 3,
});

function invalidMonitorBandwidth(patch) {
  return () => contract.normalizeMonitorBandwidth({ ...monitorBandwidth, ...patch }, 1_060_000);
}

assert.throws(invalidMonitorBandwidth({ schemaVersion: 2 }), /schema version/);
assert.throws(invalidMonitorBandwidth({ measurement: 'application-body' }), /measurement/);
assert.throws(invalidMonitorBandwidth({ site: 'Pokemon Center US' }), /site must be Target/);
assert.throws(invalidMonitorBandwidth({ monitorId: 'bad monitor id' }), /monitorId is invalid/);
assert.throws(invalidMonitorBandwidth({ runId: 123 }), /runId must be a string/);
assert.throws(invalidMonitorBandwidth({ startedAt: 0 }), /positive safe integer/);
assert.throws(invalidMonitorBandwidth({ observedAt: 999_999 }), /precedes startedAt/);
assert.throws(invalidMonitorBandwidth({ observedAt: 1_360_001 }), /too far in the future/);
assert.throws(invalidMonitorBandwidth({ sequence: 0 }), /sequence must be a positive safe integer/);
assert.throws(invalidMonitorBandwidth({ sequence: '1' }), /sequence must be a positive safe integer/);
assert.throws(invalidMonitorBandwidth({ running: 1 }), /running must be a boolean/);
assert.throws(invalidMonitorBandwidth({ proxyDownloadBytes: -1 }), /nonnegative safe integer/);
assert.throws(invalidMonitorBandwidth({ directUploadBytes: 1.5 }), /nonnegative safe integer/);
assert.throws(invalidMonitorBandwidth({ polls: Number.MAX_SAFE_INTEGER + 1 }), /nonnegative safe integer/);
assert.throws(invalidMonitorBandwidth({ failedPolls: 21 }), /cannot exceed polls/);
assert.throws(invalidMonitorBandwidth({ watchedItems: -1 }), /nonnegative safe integer/);
assert.throws(invalidMonitorBandwidth({ downloadBytes: 5_999 }), /totals do not match/);
assert.throws(invalidMonitorBandwidth({ totalBytes: 6_599 }), /totals do not match/);
assert.throws(invalidMonitorBandwidth({
  proxyDownloadBytes: Number.MAX_SAFE_INTEGER,
  directDownloadBytes: 1,
}), /exceeds the safe integer range/);

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

const targetBridgePath = path.join(root, 'runtime-app', 'public', 'helpers', 'target-engine.js');
const targetBridge = fs.readFileSync(targetBridgePath, 'utf8');
assert.match(targetBridge, /type: 'Target',[\s\S]{0,40}site: 'Target'/,
  'Target start payload no longer carries its existing type/site fields');
assert.match(targetBridge, /const ENGINE_PORT = 8727/,
  'the established single-engine loopback transport changed unexpectedly');
assert.equal((targetBridge.match(/function spawnEngine\(/g) || []).length, 1,
  'the bridge must own exactly one native-engine spawn path');

const { engineSourceRoot } = require('./zyn-engine-source.cjs');
const goRoot = engineSourceRoot();
assert.ok(fs.existsSync(path.join(goRoot, 'go.mod')), `missing Zyn engine Go module: ${goRoot}`);
const schema = fs.readFileSync(path.join(goRoot, 'frontend', 'schema.go'), 'utf8');
const websocket = fs.readFileSync(path.join(goRoot, 'frontend', 'ws.go'), 'utf8');
const monitorFrontend = fs.readFileSync(path.join(goRoot, 'frontend', 'monitor.go'), 'utf8');
const frontendFunctions = fs.readFileSync(path.join(goRoot, 'frontend', 'functions.go'), 'utf8');
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
assert.match(taskSchema, /Account\s+string\s+`json:"account,omitempty"`/);
assert.match(taskSchema, /Profile\s+string\s+`json:"profile,omitempty"`/);
assert.match(monitorFrontend, /"status":\s+"Cloud Disconnected",[\s\S]{0,100}"running":\s+false/,
  'a rejected monitor start must emit terminal liveness so the launcher can retry it');
assert.match(frontendFunctions, /"status":\s+"Idle",[\s\S]{0,100}"running":\s+false/,
  'an already-absent monitor stop must acknowledge terminal liveness after reconnect');

console.log(JSON.stringify({
  ok: true,
  protocolVersion: contract.PROTOCOL_VERSION,
  sites: Object.values(contract.SITES),
  toEngine: contract.TO_ENGINE.length,
  fromEngine: contract.FROM_ENGINE.length,
  goSchemaChecked: fs.existsSync(goRoot),
}, null, 2));
