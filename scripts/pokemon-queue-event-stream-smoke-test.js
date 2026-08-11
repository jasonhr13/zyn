#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createPokemonQueueEvents } = require('../launcher/pokemon-queue-events');

const sockets = [];
const opens = [];
const health = [];
const events = [];
const timeouts = [];
const intervals = [];

function fakeSocket() {
  const listeners = new Map();
  const socket = {
    readyState: 1,
    closed: false,
    on(name, fn) { listeners.set(name, fn); },
    close() { this.closed = true; },
    terminate() { this.closed = true; },
    ping() {},
    pong() { listeners.get('pong')?.(); },
  };
  sockets.push(socket);
  return socket;
}

const authority = {
  openPokemonQueueEvents(handlers) {
    opens.push(handlers);
    return fakeSocket();
  },
};

const monitor = createPokemonQueueEvents({
  authority,
  setHealth: value => health.push(value),
  publish: value => { events.push(value); return true; },
  now: () => 1700000000000,
  scheduleTimeout: (fn, delay) => { const item = { fn, delay }; timeouts.push(item); return item; },
  cancelTimeout: item => { if (item) item.canceled = true; },
  scheduleInterval: (fn, delay) => { const item = { fn, delay }; intervals.push(item); return item; },
  cancelInterval: item => { if (item) item.canceled = true; },
});

monitor.update({ ok: true, taskTypes: { pokemoncenter: true } });
assert.equal(opens.length, 1, 'licensed Pokémon Center access should open the downstream stream');
opens[0].open();
opens[0].message({
  type: 'pokemon-center-queue-health',
  configured: true,
  connected: true,
  connecting: false,
  lastConnectedAt: 1699999999000,
});
assert.equal(health.at(-1).connected, true);
assert.equal(health.at(-1).configured, true);

opens[0].message({
  type: 'pokemon-center-protection', kind: 'queue', detectedAt: 1700000000000, sequence: 7,
});
opens[0].message({
  type: 'pokemon-center-protection', kind: 'queue', detectedAt: 1700000000000, sequence: 7,
});
opens[0].message({ type: 'siteConfigs', data: { mustNeverReachEngine: true } });
assert.deepEqual(events, [{ kind: 'queue', detectedAt: 1700000000000 }]);

opens[0].close();
assert.equal(timeouts.at(-1).delay, 1000, 'the first reconnect should use bounded backoff');
timeouts.at(-1).fn();
assert.equal(opens.length, 2, 'the stream should reconnect after an unexpected close');

monitor.update({ ok: false, taskTypes: { pokemoncenter: false } });
assert.equal(sockets.at(-1).closed, true, 'revocation should close the downstream stream');
assert.deepEqual(monitor.cached(), {
  configured: false,
  connected: false,
  connecting: false,
  lastConnectedAt: 1699999999000,
  lastMessageAt: 0,
  lastEventAt: 0,
});

console.log('pokemon queue event stream smoke test passed');
