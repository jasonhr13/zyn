#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-bank-demand-'));
const botDirectory = path.join(temporary, 'bot');
const token = 'dynamic-bank-test-token';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const request = (port, method, requestPath, payload, authenticated = false) => new Promise((resolve, reject) => {
  const body = payload == null ? '' : JSON.stringify(payload);
  const req = http.request({
    host: '127.0.0.1', port, path: requestPath, method, timeout: 3000,
    headers: {
      ...(authenticated ? { 'x-zyn-token': token } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    },
  }, (res) => {
    let response = '';
    res.on('data', chunk => { response += chunk; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(response || '{}'); } catch {}
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error(`${method} ${requestPath} timed out`)));
  if (body) req.write(body);
  req.end();
});

const waitFor = async (check, message) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

const headers = Object.fromEntries([
  'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
  'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
  'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
].map(key => [key, `test-${key}`]));

let broker = null;
let producer = null;
try {
  fs.cpSync(path.join(root, 'native-farmer'), botDirectory, { recursive: true });
  fs.symlinkSync(
    path.join(root, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'node_modules'),
    path.join(temporary, 'node_modules'), 'dir',
  );
  const port = await freePort();
  const output = [];
  broker = spawn(process.execPath, [
    path.join(botDirectory, 'shape-farmer.mjs'), '--noFarm=true', '--poolSize=5',
  ], {
    cwd: botDirectory,
    env: { ...process.env, ZYN_SHAPE_PORT: String(port), ZYN_SHAPE_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  broker.stdout.on('data', chunk => output.push(String(chunk)));
  broker.stderr.on('data', chunk => output.push(String(chunk)));

  const initial = await waitFor(async () => {
    const response = await request(port, 'GET', '/status');
    return response.status === 200 ? response.body : null;
  }, `broker did not start:\n${output.join('')}`);
  assert.deepEqual(initial.targets, { login: 5, atc: 5 });

  producer = spawn(process.execPath, [
    path.join(botDirectory, 'shape-farmer.mjs'), '--producer=true', '--harvesterId=demand-producer',
    '--harvesterName=Demand Producer', '--harvesterType=atc', '--types=atc',
    '--browsers=smoke-unavailable', '--workers=1', '--poolSize=5',
  ], {
    cwd: botDirectory,
    env: {
      ...process.env, ZYN_SHAPE_PORT: String(port), ZYN_SHAPE_TOKEN: token,
      ZYN_PARENT_WATCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  producer.stdout.on('data', chunk => output.push(String(chunk)));
  producer.stderr.on('data', chunk => output.push(String(chunk)));
  const producerStartedAt = await waitFor(async () => {
    const status = (await request(port, 'GET', '/status')).body;
    const item = status.harvesters.find(candidate => candidate.id === 'demand-producer');
    return item && item.startedAt;
  }, `producer did not publish status:\n${output.join('')}`);

  const unauthorized = await request(port, 'POST', '/demand', {
    activeTasks: 2, standbyTasks: 6, atcPerTask: 3,
  });
  assert.equal(unauthorized.status, 401, 'only the parent app may update bank demand');

  const update = await request(port, 'POST', '/demand', {
    activeTasks: 2, standbyTasks: 6, atcPerTask: 3,
  }, true);
  assert.equal(update.status, 200);
  assert.deepEqual(update.body.demand, {
    mode: 'per-task', basis: 'active', activeTasks: 2, standbyTasks: 6,
    effectiveTasks: 2, atcPerTask: 3, targets: { login: 2, atc: 6 },
  });
  const mirrored = await waitFor(async () => {
    const status = (await request(port, 'GET', '/status')).body;
    const item = status.harvesters.find(candidate => candidate.id === 'demand-producer');
    return item?.demand?.mode === 'per-task' ? item : null;
  }, `producer did not mirror live demand:\n${output.join('')}`);
  assert.equal(mirrored.startedAt, producerStartedAt, 'producer updates targets without restarting');
  assert.deepEqual(mirrored.targets, { login: 2, atc: 6 });

  const unauthorizedSave = await request(port, 'POST', '/saveCookies', {
    type: 'atc', headers, proxy: '',
  });
  assert.equal(unauthorizedSave.status, 401, 'only authenticated app producers may add bank entries');

  const batch = await request(port, 'POST', '/saveCookies', Array.from({ length: 7 }, () => ({
    type: 'atc', headers, proxy: '',
  })), true);
  assert.equal(batch.body.saved, 6, 'the broker is authoritative when producers race the target');

  await request(port, 'POST', '/demand', {
    activeTasks: 1, standbyTasks: 6, atcPerTask: 2, basis: 'active',
  }, true);
  const downscaled = (await request(port, 'GET', '/status')).body;
  assert.equal(downscaled.pools.atc, 6, 'downscaling must preserve valid cookies already in the bank');
  assert.deepEqual(downscaled.demand, {
    mode: 'per-task', basis: 'active', activeTasks: 1, standbyTasks: 6,
    effectiveTasks: 1, atcPerTask: 2, targets: { login: 1, atc: 2 },
  });
  const parked = await request(port, 'POST', '/saveCookies', { type: 'atc', headers, proxy: '' }, true);
  assert.equal(parked.body.saved, 0, 'new prewarm work is rejected while an over-target bank drains');

  for (let index = 0; index < 6; index++) {
    const consumed = await request(port, 'GET', '/cookie?type=atc', null, true);
    assert.equal(consumed.body.ok, true);
  }
  await request(port, 'POST', '/demand', {
    activeTasks: 4, standbyTasks: 10, atcPerTask: 4, basis: 'paused',
  }, true);
  const pausedSave = await request(port, 'POST', '/saveCookies', { type: 'atc', headers, proxy: '' }, true);
  assert.equal(pausedSave.body.saved, 0, 'an explicit zero target pauses prewarm');

  const pendingCookie = request(port, 'GET', '/cookie?type=atc&wait=1&timeout=2000', null, true);
  await waitFor(async () => {
    const status = (await request(port, 'GET', '/status')).body;
    return status.activity.waiting.atc === 1;
  }, 'broker never registered the waiting checkout');
  const waiterSave = await request(port, 'POST', '/saveCookies', { type: 'atc', headers, proxy: '' }, true);
  assert.equal(waiterSave.body.saved, 1, 'live waiter demand bypasses a paused prewarm target');
  const delivered = await pendingCookie;
  assert.equal(delivered.body.ok, true);
  assert.equal((await request(port, 'GET', '/status')).body.pools.atc, 0,
    'the waiter receives the cookie directly rather than growing the paused bank');

  console.log('Dynamic Shape broker demand, auth, downscale, and waiter behavior passed');
} finally {
  if (producer && producer.exitCode == null) producer.kill('SIGTERM');
  if (broker && broker.exitCode == null) broker.kill('SIGTERM');
  fs.rmSync(temporary, { recursive: true, force: true });
}
