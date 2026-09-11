#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const source = read('chrome-extension/harvester/remote-harvest-bridge.js');
const context = { console, setTimeout, clearTimeout, URL, WebSocket: undefined };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'remote-harvest-bridge.js' });
const api = context.zynRemoteHarvest;

assert.ok(api);
assert.equal(api.LOCAL_BRIDGE, 'ws://127.0.0.1:4312/ws');

const pairing = api.parsePairingInput(
  'zyn://pair?room=zynm_abcdefghijklmnopqr&token=join-token-value-123456&origin=https://license.zynbot.app',
);
assert.equal(pairing.roomId, 'zynm_abcdefghijklmnopqr');
assert.equal(pairing.joinToken, 'join-token-value-123456');
assert.equal(api.parsePairingInput('https://evil.example/pair'), null);

const ws = new URL(api.websocketUrl({
  ...pairing,
  deviceId: '11111111-2222-4333-a444-555555555555',
}));
assert.equal(ws.pathname, '/api/mobile/ws');
assert.equal(ws.searchParams.get('role'), 'extension');
assert.equal(ws.searchParams.get('token'), pairing.joinToken);

assert.equal(api.licenseDeviceId('11111111-2222-4333-a444-555555555555'), '1111111122224333a444555555555555');
const session = api.parseSessionRecord({
  token: 'license-token-value-123456',
  deviceId: '1111111122224333a444555555555555',
  email: 'a@b.c',
  origin: 'https://license.zynbot.app',
});
assert.equal(session.email, 'a@b.c');
const sessionWs = new URL(api.websocketUrl({
  origin: session.origin,
  roomId: pairing.roomId,
  sessionToken: session.token,
  deviceId: session.deviceId,
}));
assert.equal(sessionWs.searchParams.get('session'), session.token);
assert.equal(sessionWs.searchParams.get('token'), null);
assert.equal(api.parseSessionRecord({ token: 'short', deviceId: 'abc' }), null);

assert.equal(api.statusFromDemand({
  atc: 320,
  login: 0,
  room: { login: 0, atc: 0 },
}).waiting.atc, 0, 'full remote bank must park the extension');
assert.equal(api.statusFromDemand({
  atc: 300,
  room: { atc: 20 },
}).waiting.atc, 20);
assert.equal(api.statusFromDemand({
  atc: 12,
  room: { atc: null },
}).waiting.atc, 1, 'uncapped remaining must keep the extension harvesting');

const capture = api.captureFromSave({
  action: 'save',
  type: 'atc',
  headers: { 'user-agent': 'Chrome' },
  proxy: 'p.shifter.io:443:user:pass',
  expiry: 123,
  clientId: '11111111-2222-4333-a444-555555555555',
}, '11111111-2222-4333-a444-555555555555');
assert.equal(capture.type, 'capture');
assert.equal(capture.source, 'remote');
assert.equal(capture.role, 'extension');
assert.equal(capture.cookieType, 'atc');
assert.equal(capture.headers['user-agent'], 'Chrome');

const html = read('chrome-extension/harvester/index.html');
assert.match(html, /remote-harvest-bridge\.js/);
assert.match(html, /remote-pair-ui\.js/);
assert.match(html, /remotePairInput/);
assert.match(html, /remoteEmail/);
assert.match(html, /remoteSignIn/);
assert.match(read('chrome-extension/harvester/remote-pair-ui.js'), /\/api\/auth\/login/);
assert.match(read('chrome-extension/harvester/remote-pair-ui.js'), /sessionKind: 'harvester'/);

const manifest = JSON.parse(read('chrome-extension/harvester/manifest.json'));
assert.equal(manifest.version, '1.1.9');
assert.equal(manifest.background.service_worker, 'src/sw.js');

const sw = read('chrome-extension/harvester/src/sw.js');
assert.match(sw, /remote-harvest-bridge/);
assert.match(sw, /background\.js/);

const settings = read('frontend/src/components/pages/settings.js');
assert.match(settings, /browser extension/);

console.log(JSON.stringify({ ok: true, version: manifest.version, role: 'extension' }));
