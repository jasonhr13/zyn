#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  createCompanionHarvesterBridge,
  DRAIN_MS,
  DRAIN_BATCH,
} = require('../launcher/companion-harvester-bridge');

assert.equal(DRAIN_MS, 50, 'remote drain interval should stay tight enough to empty a filling harvest pool');
assert.equal(DRAIN_BATCH, 12);

const remaining = { atc: 20, login: 3 };
const sent = [];
const bridge = createCompanionHarvesterBridge({
  authority: {
    cached: () => ({ ok: true, sessionKind: 'harvester' }),
    getHarvestRoom: async () => ({ ok: true, roomId: 'zynm_abcdefghijklmnop' }),
    openHarvestRoomEvents: () => ({ readyState: 1, send() {}, close() {} }),
  },
  takeCookie: async (type) => {
    if (!remaining[type]) return null;
    remaining[type] -= 1;
    return {
      headers: { 'user-agent': 'ua', 'x-gyjwza5z-a': 'token' },
      proxy: '1.1.1.1:80',
      harvesterId: 'win-box',
    };
  },
  enabled: () => true,
  logger: { warn() {}, info() {} },
});

async function main() {
  bridge.__test.setSocket({
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
    close() {},
  });

  await bridge.__test.drainOnce();
  const atc = sent.filter(item => item.cookieType === 'atc');
  const login = sent.filter(item => item.cookieType === 'login');
  assert.equal(atc.length, 12, 'one drain must forward a batch of ATC cookies');
  assert.equal(login.length, 3, 'login drain must stop when the local bank is empty');
  assert.equal(remaining.atc, 8);
  assert.equal(remaining.login, 0);
  assert.equal(bridge.snapshot().sentCount, 15);
  assert.ok(bridge.snapshot().sendRate > 0, 'snapshot must expose a live send rate');
  assert.equal(sent[0].source, 'remote');
  assert.equal(sent[0].role, 'companion');

  await bridge.__test.drainOnce();
  assert.equal(sent.filter(item => item.cookieType === 'atc').length, 20);
  assert.equal(bridge.snapshot().sentCount, 23);

  console.log(JSON.stringify({
    ok: true,
    drainMs: DRAIN_MS,
    drainBatch: DRAIN_BATCH,
    sent: bridge.snapshot().sentCount,
    sendRate: bridge.snapshot().sendRate,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
