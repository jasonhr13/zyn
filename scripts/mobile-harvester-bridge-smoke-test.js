#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createMobileHarvesterBridge,
  harvesterIdForDevice,
} = require('../launcher/mobile-harvester-bridge');
const { extensionCookie, localProxyGroups } = require('../launcher/harvester-extension-bridge');

const SHAPE_HEADERS = Object.fromEntries([
  'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
  'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
  'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
].map(name => [name, `captured-${name}`]));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-mobile-bridge-'));

function fakeAuthority(overrides = {}) {
  let pairCalls = 0;
  return {
    cached: () => ({ ok: true }),
    pairCalls: () => pairCalls,
    pairMobileHarvester: async () => {
      pairCalls += 1;
      return {
        ok: true,
        roomId: 'zynm_abcdefghijklmnopqr',
        joinToken: 'join-token-value-123456',
        pairingUrl: 'zyn://pair?room=zynm_abcdefghijklmnopqr&token=join-token-value-123456',
        expiresAt: Date.now() + 60_000,
      };
    },
    resetMobileHarvester: async () => ({ ok: true, revoked: true }),
    openMobileHarvesterEvents: () => {
      throw new Error('socket not used in this test');
    },
    ...overrides,
  };
}

async function main() {
  const authority = fakeAuthority();
  const saved = [];
  const bridge = createMobileHarvesterBridge({
    dataDirectory: tmp,
    authority,
    enabled: () => true,
    saveCookie: async cookie => {
      saved.push(cookie);
      return { ok: true, saved: 1 };
    },
    getProxyCatalog: () => ({
      lists: [
        { name: 'Mine', managed: false, raw: 'user:pass@1.1.1.1:8000' },
        { name: 'Resi', managed: true, raw: 'secret:cred@9.9.9.9:8000' },
      ],
    }),
    getCookieBank: async () => ({ pools: { atc: 0, login: 0 }, demand: { targets: { atc: 2 } } }),
    logger: { warn() {}, info() {} },
  });

  const paired = await bridge.pair();
  assert.equal(paired.ok, true);
  assert.equal(paired.roomId, 'zynm_abcdefghijklmnopqr');
  assert.match(paired.pairingUrl, /^zyn:\/\//);
  assert.equal(fs.existsSync(path.join(tmp, 'mobile-harvester-pair.json')), true);
  const pairedAgain = await bridge.pair();
  assert.equal(pairedAgain.ok, true);
  assert.equal(pairedAgain.reused, true);
  assert.equal(pairedAgain.roomId, paired.roomId);
  assert.equal(authority.pairCalls(), 1);

  const namesOnly = bridge.__test.proxyPayload();
  assert.deepEqual(namesOnly.groups, {});
  assert.deepEqual(namesOnly.lists, [{ name: 'Mine', count: 1 }]);
  const withLines = bridge.__test.proxyPayload({ includeLines: true });
  assert.deepEqual(Object.keys(withLines.groups), ['Mine']);
  assert.equal(withLines.groups.Resi, undefined);
  assert.deepEqual(withLines.lists, [{ name: 'Mine', count: 1 }]);

  const sent = [];
  bridge.__test.setSocket({
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
  });
  await bridge.__test.publishDemand();
  assert.equal(sent.some(message => message.type === 'proxies'), true);
  sent.length = 0;
  await bridge.__test.publishDemand();
  assert.equal(sent.some(message => message.type === 'proxies'), false);
  sent.length = 0;
  await bridge.__test.handleMessage({ type: 'hello' });
  assert.equal(sent.some(message => message.type === 'proxies'), true);
  sent.length = 0;
  await bridge.__test.handleMessage({ type: 'peer-state', phoneCount: 1 });
  assert.equal(sent.some(message => message.type === 'proxies'), true);
  sent.length = 0;
  await bridge.__test.handleMessage({ type: 'need-proxies', names: ['Mine'] });
  const proxyMessages = sent.filter(message => message.type === 'proxies');
  assert.equal(proxyMessages.length, 2);
  assert.ok(proxyMessages.some(message => message.groups && message.groups.Mine));

  await bridge.__test.handleCapture({
    type: 'atc',
    headers: { ...SHAPE_HEADERS, cookie: 'should-drop', authorization: 'nope' },
    proxy: 'http://user:pass@1.1.1.1:8000',
    deviceId: 'phone-device-1',
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'mobile');
  assert.equal(saved[0].type, 'atc');
  assert.equal(saved[0].headers.cookie, undefined);
  assert.equal(saved[0].headers.authorization, undefined);
  assert.equal(saved[0].headers['x-gyjwza5z-a'], 'captured-x-gyjwza5z-a');
  assert.equal(saved[0].harvesterId, harvesterIdForDevice('phone-device-1'));

  saved.length = 0;
  await bridge.__test.handleCapture({
    cookieType: 'atc',
    headers: {
      'x-gyjwza5z-a': 'a',
      'x-gyjwza5z-b': 'b',
      'x-gyjwza5z-c': 'c',
      'x-gyjwza5z-d': 'd',
      'x-gyjwza5z-f': 'f',
      'x-gyjwza5z-z': 'z',
    },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    proxy: 'http://user:pass@1.1.1.1:8000',
    deviceId: 'phone-device-1',
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].headers['user-agent'].includes('Android 14'), true);
  assert.ok(saved[0].headers['sec-ch-ua']);
  assert.equal(saved[0].headers['sec-ch-ua-platform'], '"Android"');

  await assert.rejects(() => bridge.__test.handleCapture({
    type: 'atc',
    headers: { 'user-agent': 'only-ua' },
    proxy: '',
  }), /missing required headers/);

  const managed = localProxyGroups({
    lists: [{ name: 'Resi', managed: true, raw: 'secret' }],
  });
  assert.deepEqual(managed, {});

  const cookie = extensionCookie({
    type: 'atc',
    headers: SHAPE_HEADERS,
    proxy: 'http://1.1.1.1:8000',
  }, { source: 'mobile', harvesterId: 'android-test' });
  assert.equal(cookie.source, 'mobile');

  await bridge.reset();
  assert.equal(bridge.snapshot().paired, false);
  fs.rmSync(tmp, { recursive: true, force: true });

  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-mobile-bridge-retry-'));
  fs.writeFileSync(path.join(retryDir, 'mobile-harvester-pair.json'), `${JSON.stringify({
    roomId: 'zynm_retryroomabcdefghij',
    joinToken: 'join-token-retry',
    pairingUrl: 'zyn://pair?room=zynm_retryroomabcdefghij&token=join-token-retry',
    expiresAt: Date.now() + 60_000,
  }, null, 2)}\n`);
  let licenseOk = false;
  let opens = 0;
  const timers = [];
  const retryAuthority = fakeAuthority({
    cached: () => ({ ok: licenseOk }),
    openMobileHarvesterEvents: () => {
      opens += 1;
      return { readyState: 1, send() {}, close() {} };
    },
  });
  const retryBridge = createMobileHarvesterBridge({
    dataDirectory: retryDir,
    authority: retryAuthority,
    enabled: () => true,
    scheduleTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ fn, ms, id });
      return id;
    },
    cancelTimeout: (id) => {
      const index = timers.findIndex(timer => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    logger: { warn() {}, info() {} },
  });
  retryBridge.start();
  assert.equal(opens, 0, 'desktop must not join before the license session is ready');
  assert.ok(timers.length >= 1, 'desktop must retry joining after launch');
  licenseOk = true;
  retryBridge.update();
  assert.equal(opens, 1, 'desktop must join the room once the license session is ready');
  fs.rmSync(retryDir, { recursive: true, force: true });

  console.log('mobile harvester bridge smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
