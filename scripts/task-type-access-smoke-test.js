#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  OPTIONAL_TASK_TYPES,
  normalizeTaskTypeAccess,
  removedTaskTypes,
} = require('../launcher/task-type-access');
const { installTaskTypeIpcGuard } = require('../launcher/task-type-ipc-guard');

assert.deepEqual(OPTIONAL_TASK_TYPES, [
  { key: 'pokemoncenter', label: 'Pokémon Center' },
  { key: 'walmart', label: 'Walmart' },
  { key: 'round1', label: 'Round1' },
]);
assert.deepEqual(normalizeTaskTypeAccess(), { pokemoncenter: false, walmart: false, round1: false });
assert.deepEqual(normalizeTaskTypeAccess({ pokemoncenter: true, round1: 'true', future: true }), {
  pokemoncenter: true,
  walmart: false,
  round1: false,
});
assert.deepEqual(normalizeTaskTypeAccess({}, true), { pokemoncenter: true, walmart: true, round1: true });
assert.deepEqual(removedTaskTypes(
  { pokemoncenter: true, round1: true },
  { pokemoncenter: false, round1: true },
), ['pokemoncenter']);

const listeners = new Map();
const ipcMain = {
  on(channel, listener) {
    listeners.set(channel, listener);
    return this;
  },
};
let status = { ok: true, taskTypes: normalizeTaskTypeAccess() };
const blocked = [];
const restore = installTaskTypeIpcGuard({
  ipcMain,
  authority: { cached: () => status },
  onBlocked: event => blocked.push(event),
});
let round1Calls = 0;
let pokemonCalls = 0;
let walmartCalls = 0;
let baseCalls = 0;
ipcMain.on('startRound1', event => { round1Calls += 1; event.returnValue = true; });
ipcMain.on('startPokemonCenter', () => { pokemonCalls += 1; });
ipcMain.on('startWalmart', event => { walmartCalls += 1; event.returnValue = true; });
ipcMain.on('startTarget', () => { baseCalls += 1; });
restore();

const deniedRound1 = {};
listeners.get('startRound1')(deniedRound1, {});
assert.equal(deniedRound1.returnValue, false);
assert.equal(round1Calls, 0);
listeners.get('startPokemonCenter')({}, {});
assert.equal(pokemonCalls, 0);
const deniedWalmart = {};
listeners.get('startWalmart')(deniedWalmart, {});
assert.equal(deniedWalmart.returnValue, false);
assert.equal(walmartCalls, 0);
listeners.get('startTarget')({}, {});
assert.equal(baseCalls, 1);
assert.deepEqual(blocked.map(event => event.taskType), ['round1', 'pokemoncenter', 'walmart']);

status = { ok: true, taskTypes: { pokemoncenter: true, walmart: true, round1: true } };
const allowedRound1 = {};
listeners.get('startRound1')(allowedRound1, {});
listeners.get('startPokemonCenter')({}, {});
listeners.get('startWalmart')({}, {});
assert.equal(allowedRound1.returnValue, true);
assert.equal(round1Calls, 1);
assert.equal(pokemonCalls, 1);
assert.equal(walmartCalls, 1);

// The archived handler still owns the unlicensed response and therefore must receive this case.
status = { ok: false, taskTypes: { pokemoncenter: false, walmart: false, round1: false } };
listeners.get('startRound1')({}, {});
assert.equal(round1Calls, 2);

console.log(JSON.stringify({
  ok: true,
  registry: OPTIONAL_TASK_TYPES.map(({ key }) => key),
  failClosed: true,
  optionalIpcBlocked: blocked.length,
  baseIpcUnaffected: baseCalls,
}, null, 2));
