import assert from 'node:assert/strict';
import {
  CANARY_TCINS,
  DEFAULT_CANARY_TCIN,
  createAtcReplayGate,
  canaryCommandFromEnv,
  canaryChildEnv,
  runEngineAtcReplay,
} from './shape-atc-replay.mjs';

assert.equal(DEFAULT_CANARY_TCIN, '15011547');
assert.deepEqual(CANARY_TCINS, ['15011547', '12953662', '54605734']);

const gate = createAtcReplayGate({ sampleEvery: 20, sampleMinIntervalMs: 0 });
assert.equal(gate.engineMayTake(), false, 'warmup starts gated');
assert.equal(gate.reserve(), true, 'first mint is a warmup canary');
assert.equal(gate.reserve(), false, 'in-flight mint is not double-reserved');
assert.equal(gate.reserve(), false, 'a worker wave cannot reserve a second canary');
gate.record({ ok: false, category: 'shape_block' });
assert.equal(gate.engineMayTake(), false);
assert.equal(gate.reserve(), true);
gate.record({ ok: true, category: 'ok' });
assert.equal(gate.engineMayTake(), true, 'one warmup pass opens delivery');
assert.equal(gate.snapshot().recentOk, 1);

let taken = 0;
for (let i = 0; i < 19; i++) {
  if (gate.reserve()) taken++;
}
assert.equal(taken, 0, 'healthy bank does not canary every mint');
assert.equal(gate.reserve(), true, 'the 20th mint is sampled');
gate.record({ ok: true, category: 'ok' });

const failed = createAtcReplayGate({ warmupNeeded: 2, extraOnFail: 1, sampleMinIntervalMs: 0 });
failed.reserve(); failed.record({ ok: false, category: 'shape_block' });
failed.reserve(); failed.record({ ok: false, category: 'shape_block' });
assert.equal(failed.snapshot().warmupNeeded, 3, 'two misses add one extra warmup');
failed.reserve(); failed.record({ ok: false, category: 'shape_block' });
assert.equal(failed.engineMayTake(), false, 'three shape blocks keep the gate closed');

const skipped = createAtcReplayGate();
skipped.record({ skipped: true });
assert.equal(skipped.engineMayTake(), true);
assert.equal(skipped.reserve(), false);
const missingEngine = createAtcReplayGate();
missingEngine.record({ ok: false, category: 'spawn' });
assert.equal(missingEngine.engineMayTake(), true, 'a missing or old engine must not hold the bank');
const oos = createAtcReplayGate();
oos.reserve();
oos.record({ ok: false, category: 'oos' });
assert.equal(oos.engineMayTake(), true, 'an out-of-stock probe SKU must not hold the bank');
const unknown = createAtcReplayGate();
unknown.reserve();
unknown.record({ ok: false, category: 'unknown' });
assert.equal(unknown.engineMayTake(), true, 'an old engine with empty stdout must not hold the bank');
const proxyFail = createAtcReplayGate();
proxyFail.reserve();
proxyFail.record({ ok: false, category: 'proxy' });
assert.equal(proxyFail.engineMayTake(), true, 'a dead canary proxy must not hold the bank');

assert.deepEqual(canaryCommandFromEnv({}), null);
assert.deepEqual(canaryCommandFromEnv({ ZYN_ENGINE_PATH: '/tmp/engine' }), null,
  'downloaded checkout engines must not run ATC canaries');
assert.deepEqual(canaryCommandFromEnv({
  ZYN_SHAPE_CANARY_BIN: '/usr/bin/node',
  ZYN_SHAPE_CANARY_ARGS: '/tmp/stub.mjs',
}), { bin: '/usr/bin/node', args: ['/tmp/stub.mjs'] });
assert.deepEqual(canaryCommandFromEnv({
  ZYN_SHAPE_CANARY_BIN: '/bundled/backend',
}), { bin: '/bundled/backend', args: ['shape-canary'] });
const childEnv = canaryChildEnv({
  ZYN_SHAPE_TOKEN: 'license-token',
  ZYN_PARENT_WATCH: '1',
  PATH: '/usr/bin',
});
assert.equal(childEnv.ZYN_SHAPE_CANARY, '1');
assert.equal('ZYN_SHAPE_TOKEN' in childEnv, false, 'license token must be deleted, not emptied');
assert.equal('ZYN_PARENT_WATCH' in childEnv, false);

const spawned = [];
let stdin = '';
const result = await runEngineAtcReplay({
  bin: '/engine',
  cookie: { headers: { 'user-agent': 'ua' }, proxy: 'h:1:u:p' },
  spawnImpl: (bin, args, options) => {
    spawned.push({
      bin,
      args,
      canary: options.env.ZYN_SHAPE_CANARY,
      token: options.env.ZYN_SHAPE_TOKEN,
      hasToken: 'ZYN_SHAPE_TOKEN' in options.env,
    });
    const handlers = { data: [], error: [], close: [] };
    const stdout = { on: (name, fn) => { if (name === 'data') handlers.data.push(fn); } };
    const stderr = { on: (name, fn) => { if (name === 'data') handlers.error.push(fn); } };
    queueMicrotask(() => {
      for (const fn of handlers.data) fn(Buffer.from('{"ok":true,"status":201,"category":"ok","tcin":"15011547"}'));
      for (const fn of handlers.close) fn(0);
    });
    return {
      stdin: { write(chunk) { stdin += chunk; }, end() {} },
      stdout,
      stderr,
      on: (name, fn) => { if (name === 'close') handlers.close.push(fn); },
      kill() {},
    };
  },
});
assert.equal(result.ok, true);
assert.equal(result.status, 201);
assert.equal(spawned[0].bin, '/engine');
assert.deepEqual(spawned[0].args, ['shape-canary']);
assert.equal(spawned[0].canary, '1');
assert.equal(spawned[0].hasToken, false);
assert.equal(spawned[0].token, undefined);
const payload = JSON.parse(stdin);
assert.deepEqual(payload.tcins, CANARY_TCINS);

let emptyStdout = '';
const silent = await runEngineAtcReplay({
  bin: '/engine',
  cookie: { headers: {}, proxy: '' },
  spawnImpl: () => {
    const handlers = { close: [] };
    queueMicrotask(() => { for (const fn of handlers.close) fn(1); });
    return {
      stdin: { write() {}, end() {} },
      stdout: { on() {} },
      stderr: { on(name, fn) { if (name === 'data') emptyStdout = 'missing ZYN_SHAPE_TOKEN'; fn(Buffer.from(emptyStdout)); } },
      on: (name, fn) => { if (name === 'close') handlers.close.push(fn); },
      kill() {},
    };
  },
});
assert.equal(silent.ok, false);
assert.equal(silent.category, 'spawn', 'empty stdout from an old engine is a spawn miss, not unknown');

const killed = [];
const hung = await runEngineAtcReplay({
  bin: '/engine',
  timeoutMs: 40,
  cookie: { headers: {}, proxy: '' },
  spawnImpl: () => ({
    stdin: { write() {}, end() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill(signal) { killed.push(signal); },
  }),
});
assert.equal(hung.category, 'timeout');
assert.equal(killed[0], 'SIGTERM');
await new Promise(resolve => setTimeout(resolve, 400));
assert.ok(killed.includes('SIGKILL'), 'a hung ConnectFrontend must be SIGKILL-ed');

console.log('shape-atc-replay gate and canary runner passed');
