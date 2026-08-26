#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  clampWorkers,
  desktopOnlineFrom,
  flattenProxyGroups,
  mergeProxyGroups,
  normalizeProxyGroups,
  parsePairingInput,
  proxyToUrl,
  selectedProxyLines,
  websocketUrl,
} = require('../mobile/src/protocol');

const parsed = parsePairingInput('zyn://pair?room=zynm_abcdefghijklmnop&token=join-token-value-1234&origin=https://license.zynbot.app');
assert.deepEqual(parsed, {
  roomId: 'zynm_abcdefghijklmnop',
  joinToken: 'join-token-value-1234',
  origin: 'https://license.zynbot.app',
});
assert.equal(parsePairingInput('https://license.zynbot.app/api/mobile/pair'), null);
assert.deepEqual(
  parsePairingInput('  "zyn://pair?room=zynm_abcdefghijklmnop&token=join-token-value-1234"  '),
  parsed,
);
assert.deepEqual(
  parsePairingInput('Pair with Zyn: zyn://pair?room=zynm_abcdefghijklmnop&token=join-token-value-1234&origin=https://license.zynbot.app'),
  parsed,
);

const url = websocketUrl({
  origin: 'https://license.zynbot.app',
  roomId: 'zynm_abcdefghijklmnop',
  joinToken: 'join-token-value-1234',
  deviceId: 'android-1',
});
assert.match(url, /^wss:\/\/license\.zynbot.app\/api\/mobile\/ws\?/);
assert.match(url, /role=phone/);
assert.doesNotMatch(url, /Bearer/);
assert.deepEqual(flattenProxyGroups({ Mine: ['a', ' ', 'b'] }), ['a', 'b']);
const groups = normalizeProxyGroups({ Mine: ['a', 'b'], Resi: ['c'], Empty: [] });
assert.deepEqual(groups.map((group) => group.name), ['Mine', 'Resi']);
assert.deepEqual(selectedProxyLines(groups, ['Mine']), ['a', 'b']);
assert.deepEqual(selectedProxyLines(groups, ['Mine', 'Resi']), ['a', 'b', 'c']);
assert.equal(clampWorkers(0), 1);
assert.equal(clampWorkers(9), 6);
assert.equal(clampWorkers('3'), 3);
assert.equal(desktopOnlineFrom({ type: 'registered', peer: { desktopOnline: true } }), true);
assert.equal(desktopOnlineFrom({ type: 'peer-state', desktopOnline: false }), false);
assert.equal(desktopOnlineFrom({ type: 'registered' }), null);
assert.deepEqual(normalizeProxyGroups({}, [{ name: 'Mine', count: 4 }]).map((group) => group.name), ['Mine']);
const merged = mergeProxyGroups(
  [{ name: 'Mine', lines: [], count: 4 }],
  { lists: [{ name: 'Mine', count: 4 }, { name: 'ISP', count: 2 }], groups: { ISP: ['a', 'b'] } },
);
assert.deepEqual(merged.map((group) => group.name), ['Mine', 'ISP']);
assert.deepEqual(merged.find((group) => group.name === 'ISP').lines, ['a', 'b']);
assert.equal(proxyToUrl('1.2.3.4:8000:user:pass'), 'http://user:pass@1.2.3.4:8000');
assert.equal(proxyToUrl('user:pass@1.2.3.4:8000'), 'http://user:pass@1.2.3.4:8000');
assert.equal(proxyToUrl('1.2.3.4:8000:user:p:a:ss'), 'http://user:p:a:ss@1.2.3.4:8000');
console.log('mobile protocol smoke test passed');
