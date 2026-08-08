#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarvestCoordinator } from '../native-farmer/shape-harvest-coordinator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-multi-harvester-'));
const botDirectory = path.join(temporary, 'bot');
const token = 'multi-harvester-smoke-token';

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
    host: '127.0.0.1', port, path: requestPath, method, timeout: 2500,
    headers: {
      ...(authenticated ? { 'x-hope-token': token } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    },
  }, (res) => {
    let response = '';
    res.on('data', chunk => { response += chunk; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(response || '{}'); } catch {}
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
      else reject(new Error(`${method} ${requestPath} returned ${res.statusCode}: ${response}`));
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error(`${method} ${requestPath} timed out`)));
  if (body) req.write(body);
  req.end();
});

const waitForBroker = async (port, output) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await request(port, 'GET', '/status'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`broker did not start:\n${output.join('')}`);
};

const shapeHeaders = Object.fromEntries([
  'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
  'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
  'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
].map(key => [key, `smoke-${key}`]));

let child = null;
let producer = null;
try {
  fs.cpSync(path.join(root, 'native-farmer'), botDirectory, { recursive: true });
  const dependencies = path.join(root, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'node_modules');
  assert.equal(fs.existsSync(path.join(dependencies, 'playwright', 'package.json')), true,
    'runtime base is missing Playwright dependencies');
  fs.symlinkSync(dependencies, path.join(temporary, 'node_modules'), 'dir');

  const port = await freePort();
  const output = [];
  child = spawn(process.execPath, [
    path.join(botDirectory, 'shape-farmer.mjs'),
    '--noFarm=true',
    '--poolSize=5',
    '--cookieTtlMs=600000',
    `--bankFile=${path.join(temporary, 'bank.json')}`,
  ], {
    cwd: botDirectory,
    env: { ...process.env, HOPE_SHAPE_PORT: String(port), HOPE_SHAPE_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  await waitForBroker(port, output);

  // A real producer process must coexist with the broker instead of trying to bind the same port.
  // An unavailable browser selection keeps this smoke test lightweight while still exercising
  // producer boot, broker status publication, and parent-owned lifecycle.
  producer = spawn(process.execPath, [
    path.join(botDirectory, 'shape-farmer.mjs'),
    '--producer=true', '--harvesterId=actual', '--harvesterName=Actual Producer',
    '--harvesterType=atc', '--browsers=smoke-unavailable', '--workers=2',
  ], {
    cwd: botDirectory,
    env: {
      ...process.env,
      HOPE_SHAPE_PORT: String(port),
      HOPE_SHAPE_TOKEN: token,
      HOPE_PARENT_WATCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let actualPublished = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await request(port, 'GET', '/status');
    if (status.harvesters.some(item => item.id === 'actual')) { actualPublished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(actualPublished, true, 'producer process did not publish to the shared broker');

  for (const status of [
    { id: 'home', name: 'Home ATC', type: 'atc', route: 'Local', configuredWorkers: 2, activeWorkers: 2 },
    { id: 'proxy', name: 'Proxy ATC', type: 'atc', route: 'ISP', configuredWorkers: 8, activeWorkers: 8 },
  ]) {
    await request(port, 'POST', '/harvesterStatus', status, true);
  }
  const aggregated = await request(port, 'GET', '/status');
  for (const id of ['actual', 'home', 'proxy']) {
    assert.equal(aggregated.harvesters.some(item => item.id === id), true, `missing ${id} telemetry`);
  }
  assert.equal(aggregated.health.activeWorkers, 10);
  assert.equal(aggregated.health.configuredWorkers, 10);

  const save = await request(port, 'POST', '/saveCookies', {
    type: 'atc', headers: shapeHeaders, proxy: '127.0.0.1:9000:user:pass',
    expiresAt: Date.now() + 5000, harvesterId: 'proxy', source: 'inBotV2',
  });
  assert.equal(save.saved, 1);
  const cookie = await request(port, 'GET', '/cookie?type=atc', null, true);
  assert.equal(cookie.ok, true);
  assert.equal(cookie.cookie.proxy, '127.0.0.1:9000:user:pass');
  assert.equal(cookie.cookie.type, 'atc');
  assert.equal(cookie.cookie.source, 'inBotV2');
  assert.equal(cookie.cookie.harvesterId, 'proxy');
  assert.ok(cookie.cookie.expiresAt > Date.now());

  await request(port, 'POST', '/saveCookies', {
    type: 'login', headers: shapeHeaders, proxy: '', expiresAt: Date.now() + 50, harvesterId: 'home',
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const pruned = await request(port, 'GET', '/status');
  assert.equal(pruned.pools.login, 0, 'per-cookie expiration must be honored by the shared bank');

  const loginCoordinator = createHarvestCoordinator({
    allowedTypes: ['login'], targetPool: 3, continuousLogin: true, loginConcurrency: 1,
  });
  const first = loginCoordinator.reserve({ pools: { login: [], atc: [] } });
  assert.equal(first.type, 'login');
  assert.equal(loginCoordinator.reserve({ pools: { login: [], atc: [] } }), null,
    'dedicated login harvesters still enforce one in-flight login worker');
  first.release({ success: true });
  assert.equal(loginCoordinator.reserve({ pools: { login: [{}], atc: [] } }).type, 'login',
    'dedicated login harvesters replenish beyond the automatic one-shot login cookie');

  console.log('Target multi-harvester broker, telemetry, expiration, and typed login lane passed');
} finally {
  if (producer && producer.exitCode == null) producer.kill('SIGTERM');
  if (child && child.exitCode == null) child.kill('SIGTERM');
  fs.rmSync(temporary, { recursive: true, force: true });
}
