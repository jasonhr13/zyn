#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarvestCoordinator } from '../native-farmer/shape-harvest-coordinator.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('../launcher/node_modules/ws');
const { createHarvesterExtensionBridge } = require('../launcher/harvester-extension-bridge');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-multi-harvester-'));
const botDirectory = path.join(temporary, 'bot');
const token = 'multi-harvester-smoke-token';
const extensionIds = ['a'.repeat(32), 'b'.repeat(32)];
const extensionOrigins = extensionIds.map(id => `chrome-extension://${id}`);

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
      ...(authenticated ? { 'x-zyn-token': token } : {}),
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

const extensionRequest = (url, payload, origin = extensionOrigins[0]) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { origin, handshakeTimeout: 2000 });
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { socket.close(); } catch {}
    if (error) reject(error);
    else resolve(value);
  };
  const timer = setTimeout(() => {
    try { socket.terminate(); } catch {}
    finish(new Error('extension request timed out'));
  }, 3000);
  socket.once('open', () => socket.send(JSON.stringify(payload)));
  socket.once('message', raw => {
    try { finish(null, JSON.parse(String(raw))); }
    catch (error) { finish(error); }
  });
  socket.once('error', error => finish(error));
  socket.once('close', code => {
    if (!settled) finish(new Error(`extension socket closed before reply (${code})`));
  });
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
let extensionBridge = null;
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
    env: { ...process.env, ZYN_SHAPE_PORT: String(port), ZYN_SHAPE_TOKEN: token },
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
      ZYN_SHAPE_PORT: String(port),
      ZYN_SHAPE_TOKEN: token,
      ZYN_PARENT_WATCH: '1',
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
  const actualStatus = await request(port, 'GET', '/status');
  const actualRuntime = actualStatus.harvesters.find(item => item.id === 'actual');
  assert.equal(actualRuntime.bandwidth.measurement, 'chromium-cdp');
  assert.equal(actualRuntime.bandwidth.attempts, 0);

  for (const status of [
    {
      id: 'home', name: 'Home ATC', type: 'atc', route: 'Local', configuredWorkers: 2, activeWorkers: 2,
      bandwidth: { directBytes: 900000, proxyBytes: 0, requests: 20 },
    },
    {
      id: 'proxy', name: 'Proxy ATC', type: 'atc', route: 'ISP', configuredWorkers: 8, activeWorkers: 8,
      bandwidth: { directBytes: 0, proxyBytes: 4200000, requests: 80 },
    },
  ]) {
    await request(port, 'POST', '/harvesterStatus', status, true);
  }
  const aggregated = await request(port, 'GET', '/status');
  for (const id of ['actual', 'home', 'proxy']) {
    assert.equal(aggregated.harvesters.some(item => item.id === id), true, `missing ${id} telemetry`);
  }
  assert.equal(aggregated.health.activeWorkers, 10);
  assert.equal(aggregated.health.configuredWorkers, 10);
  assert.equal(aggregated.harvesters.find(item => item.id === 'proxy').bandwidth.proxyBytes, 4200000,
    'broker must preserve per-harvester bandwidth telemetry');

  extensionBridge = createHarvesterExtensionBridge({
    port: 0,
    brokerPort: port,
    enabled: () => true,
    allowedExtensionIds: () => extensionIds,
    ensureBroker: () => {},
    saveCookie: cookie => request(port, 'POST', '/saveCookies', cookie, true),
    logger: { warn() {} },
  });
  const extensionAddress = await extensionBridge.start();

  const managedSave = await request(port, 'POST', '/saveCookies', {
    type: 'atc', headers: shapeHeaders, proxy: '127.0.0.1:9000:user:pass',
    expiresAt: Date.now() + 30000, harvesterId: 'proxy', source: 'inBotV2',
  }, true);
  assert.equal(managedSave.saved, 1);
  const extensionUrl = `ws://127.0.0.1:${extensionAddress.port}/ws`;
  const [chromeSave, braveSave] = await Promise.all([
    extensionRequest(extensionUrl, {
      action: 'save', type: 'atc', headers: shapeHeaders,
      proxy: '127.0.0.1:9001:extension:user', expiry: Date.now() + 30000,
      clientId: 'c'.repeat(32), browser: 'Chrome',
    }, extensionOrigins[0]),
    extensionRequest(extensionUrl, {
      action: 'save', type: 'atc', headers: shapeHeaders,
      proxy: '127.0.0.1:9002:extension:user', expiry: Date.now() + 30000,
      clientId: 'd'.repeat(32), browser: 'Brave',
    }, extensionOrigins[1]),
  ]);
  assert.deepEqual(chromeSave, { ok: true, saved: 1 });
  assert.deepEqual(braveSave, { ok: true, saved: 1 });

  const tandemStatus = await request(port, 'GET', '/status');
  assert.equal(tandemStatus.pools.atc, 3,
    'managed, Chrome, and Brave captures must add to the same cookie bank');
  assert.equal(tandemStatus.harvesters.some(item => item.id === 'actual'), true,
    'accepting an extension capture must not stop the managed producer');

  const tandemCookies = [];
  for (let index = 0; index < 3; index++) {
    const result = await request(port, 'GET', '/cookie?type=atc', null, true);
    assert.equal(result.ok, true);
    tandemCookies.push(result.cookie);
  }
  const managedCookie = tandemCookies.find(cookie => cookie.source === 'inBotV2');
  const extensionCookies = tandemCookies.filter(cookie => cookie.source === 'extension');
  assert.equal(managedCookie.proxy, '127.0.0.1:9000:user:pass');
  assert.equal(managedCookie.harvesterId, 'proxy');
  assert.deepEqual(extensionCookies.map(cookie => cookie.proxy).sort(), [
    '127.0.0.1:9001:extension:user',
    '127.0.0.1:9002:extension:user',
  ]);
  assert.equal(new Set(extensionCookies.map(cookie => cookie.harvesterId)).size, 2,
    'Chrome and Brave cookies must retain distinct harvester attribution');
  assert.ok(tandemCookies.every(cookie => cookie.type === 'atc' && cookie.expiresAt > Date.now()));

  await request(port, 'POST', '/saveCookies', {
    type: 'login', headers: shapeHeaders, proxy: '', expiresAt: Date.now() + 50, harvesterId: 'home',
  }, true);
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

  console.log('Target multi-harvester broker, extension tandem, telemetry, expiration, and typed login lane passed');
} finally {
  if (extensionBridge) await extensionBridge.stop();
  if (producer && producer.exitCode == null) producer.kill('SIGTERM');
  if (child && child.exitCode == null) child.kill('SIGTERM');
  fs.rmSync(temporary, { recursive: true, force: true });
}
