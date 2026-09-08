#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  createCompanionHarvesterBridge,
  DRAIN_MS,
  DRAIN_BATCH,
  remainingHarvestTargets,
  hasHarvestRoom,
} = require('../launcher/companion-harvester-bridge');

assert.equal(DRAIN_MS, 50, 'remote drain interval should stay tight enough to empty a filling harvest pool');
assert.equal(DRAIN_BATCH, 12);

const remaining = { atc: 20, login: 3 };
const sent = [];
let brokerCalls = 0;
const demands = [];
const bridge = createCompanionHarvesterBridge({
  authority: {
    cached: () => ({ ok: true, sessionKind: 'harvester' }),
    getHarvestRoom: async () => ({ ok: true, roomId: 'zynm_abcdefghijklmnop' }),
    openHarvestRoomEvents: () => ({ readyState: 1, send() {}, close() {} }),
  },
  ensureBroker: () => { brokerCalls += 1; },
  applyDemand: demand => { demands.push(demand); },
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
  assert.deepEqual(remainingHarvestTargets({
    current: { login: 0, atc: 320 },
    targets: { login: 0, atc: 320 },
  }), { login: 0, atc: 0 });
  assert.deepEqual(remainingHarvestTargets({
    current: { login: 0, atc: 300 },
    targets: { login: 0, atc: 320 },
  }), { login: 0, atc: 20 });
  assert.equal(remainingHarvestTargets({
    current: { atc: 12 },
    targets: { login: 2, atc: null },
  }).atc, null, 'uncapped ATC must keep remaining null');
  assert.equal(hasHarvestRoom({ login: 0, atc: 0 }, 'atc'), false);
  assert.equal(hasHarvestRoom({ login: 0, atc: null }, 'atc'), true);

  bridge.__test.setSocket({
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
    close() {},
  });

  await bridge.__test.drainOnce();
  assert.equal(sent.length, 0, 'drain must not forward cookies before Full Engine publishes remaining room');
  assert.equal(remaining.atc, 20, 'local cookies must stay parked while the engine is at cap');

  bridge.__test.applyRemoteDemand({
    type: 'demand',
    atc: 320,
    login: 0,
    demand: {
      basis: 'active',
      activeTasks: 16,
      standbyTasks: 0,
      atcPerTask: 20,
      loginTasks: 0,
      targets: { login: 0, atc: 320 },
    },
  });
  assert.deepEqual(bridge.__test.harvestRoom(), { login: 0, atc: 0 });
  assert.deepEqual(demands.at(-1).targets, { login: 0, atc: 0 },
    'remote demand must park workers when Full Engine is at the ATC cap');
  await bridge.__test.drainOnce();
  assert.equal(sent.length, 0, 'drain must not burn cookies the engine will reject at the cap');
  assert.equal(remaining.atc, 20);

  bridge.__test.applyRemoteDemand({
    type: 'demand',
    atc: 300,
    login: 0,
    demand: {
      basis: 'active',
      activeTasks: 16,
      standbyTasks: 0,
      atcPerTask: 20,
      loginTasks: 0,
      targets: { login: 0, atc: 320 },
    },
  });
  assert.deepEqual(bridge.__test.harvestRoom(), { login: 0, atc: 20 },
    'without a room field, remaining must be absolute target minus live engine fill');

  bridge.__test.applyRemoteDemand({
    type: 'demand',
    atc: 0,
    login: 0,
    room: { login: 3, atc: 20 },
    demand: {
      basis: 'active',
      activeTasks: 16,
      standbyTasks: 0,
      atcPerTask: 20,
      loginTasks: 0,
      targets: { login: 0, atc: 320 },
    },
  });
  assert.deepEqual(bridge.__test.harvestRoom(), { login: 3, atc: 20 });
  assert.deepEqual(demands.at(-1).targets, { login: 3, atc: 20 });

  await bridge.__test.drainOnce();
  assert.equal(brokerCalls, 0, 'cookie drain must not resync harvester producers on the main thread');
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

  bridge.__test.applyRemoteDemand({
    type: 'demand',
    atc: 320,
    login: 0,
    demand: {
      basis: 'active',
      activeTasks: 16,
      atcPerTask: 20,
      targets: { login: 0, atc: 320 },
    },
  });
  const sentAtCap = sent.length;
  await bridge.__test.drainOnce();
  assert.equal(sent.length, sentAtCap, 'a later cap must stop draining leftover local cookies');

  let rooms = 0;
  let currentRoom = 'zynm_abcdefghijklmnop';
  const opened = [];
  const repair = createCompanionHarvesterBridge({
    authority: {
      cached: () => ({ ok: true, sessionKind: 'harvester' }),
      getHarvestRoom: async () => {
        rooms += 1;
        return { ok: true, roomId: currentRoom };
      },
      openHarvestRoomEvents: (roomId) => {
        opened.push(roomId);
        return { readyState: 1, send() {}, close() {} };
      },
    },
    enabled: () => true,
    logger: { warn() {}, info() {} },
    scheduleTimeout: () => 1,
    cancelTimeout() {},
  });
  repair.start();
  for (let i = 0; i < 10 && !opened.length; i += 1) await Promise.resolve();
  assert.equal(opened[0], 'zynm_abcdefghijklmnop');
  assert.equal(repair.snapshot().connected, false, 'socket open is not a Full Engine link');
  repair.__test.handleMessage({
    type: 'peer-state',
    desktopOnline: true,
    companionCount: 1,
    peer: { desktopOnline: true, companionCount: 1 },
  });
  assert.equal(repair.snapshot().connected, true);
  assert.equal(repair.snapshot().engineOnline, true);
  currentRoom = 'zynm_newroomabcdefghijk';
  await repair.__test.healthOnce();
  assert.equal(opened.at(-1), 'zynm_newroomabcdefghijk', 'companion must follow the live Full Engine room');
  repair.__test.handleMessage({ type: 'peer-state', desktopOnline: false, peer: { desktopOnline: false } });
  assert.equal(repair.snapshot().connected, false);
  assert.equal(repair.snapshot().engineOnline, false);

  console.log(JSON.stringify({
    ok: true,
    drainMs: DRAIN_MS,
    drainBatch: DRAIN_BATCH,
    sent: bridge.snapshot().sentCount,
    sendRate: bridge.snapshot().sendRate,
    rooms,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
