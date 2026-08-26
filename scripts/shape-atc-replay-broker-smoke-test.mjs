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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-atc-bank-'));
const botDirectory = path.join(temporary, 'bot');
const token = 'replay-canary-token';
const headers = Object.fromEntries([
  'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
  'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
  'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
].map(key => [key, `test-${key}`]));

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
    host: '127.0.0.1', port, path: requestPath, method, timeout: 8000,
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
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

fs.cpSync(path.join(root, 'native-farmer'), botDirectory, { recursive: true });
const dependencies = path.join(root, 'bot-runtime', 'node_modules');
fs.symlinkSync(dependencies, path.join(temporary, 'node_modules'), 'dir');

const port = await freePort();
const output = [];
const child = spawn(process.execPath, [
  path.join(botDirectory, 'shape-farmer.mjs'), '--noFarm=true', '--poolSize=8',
], {
  cwd: botDirectory,
  env: {
    ...process.env,
    ZYN_SHAPE_PORT: String(port),
    ZYN_SHAPE_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => output.push(String(chunk)));
child.stderr.on('data', chunk => output.push(String(chunk)));

try {
  await waitFor(async () => {
    const status = await request(port, 'GET', '/status');
    return status.status === 200 && status.body.app === 'zyn-shape-broker';
  }, `broker did not start:\n${output.join('')}`);

  await Promise.all(Array.from({ length: 8 }, () => request(port, 'POST', '/saveCookies', {
    type: 'atc', headers, proxy: '127.0.0.1:9',
  }, true)));
  const afterWave = await request(port, 'GET', '/status');
  assert.equal(afterWave.body.pools.atc, 8, 'every harvested ATC cookie must land in the bank');
  assert.equal(afterWave.body.replay, undefined, 'broker must not expose a replay gate');

  const delivered = await request(port, 'GET', '/cookie?type=atc', null, true);
  assert.equal(delivered.body.ok, true, 'the engine must be able to take an ATC cookie immediately');
  assert.equal(delivered.body.cookie.proxy, '127.0.0.1:9');
} finally {
  try { child.kill(); } catch {}
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
}

console.log('ATC broker delivers cookies without a replay gate');
