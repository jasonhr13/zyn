#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const WebSocket = require(path.join(root, 'extracted', 'asar', 'node_modules', 'ws'));
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const backend = path.join(root, 'native-backend', `darwin-${arch}`, 'backend');
assert.equal(fs.existsSync(backend), true, `native backend is missing: ${backend}`);

const token = crypto.randomBytes(24).toString('hex');
const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
let child;

const timeout = setTimeout(() => {
  try { child?.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  console.error('native Target protocol smoke test timed out');
  process.exit(124);
}, 10000);

async function main() {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const connected = new Promise((resolve, reject) => {
    server.once('connection', (socket, request) => {
      try {
        assert.equal(request.headers['x-hope-token'], token, 'engine omitted its per-launch bridge token');
        socket.send(JSON.stringify({
          type: 'send-configs',
          messages: [{
            settings: JSON.stringify({
              webhooks: { checkout: '', decline: '' },
              shapeMethod: 'In Bot',
              throttleFallbackGroup: 'Local',
            }),
            profileList: '{}',
            proxyList: '{}',
            accountList: '{}',
          }],
        }));
        resolve(socket);
      } catch (error) {
        reject(error);
      }
    });
  });

  child = spawn(backend, ['-port', String(port), '-key', 'local'], {
    cwd: path.dirname(backend),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOPE_SHAPE_PORT: '4727',
      HOPE_SHAPE_TOKEN: token,
      HOPE_PARENT_WATCH: '1',
    },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => { stderr += String(chunk); });
  child.once('error', error => { throw error; });

  const socket = await connected;
  socket.send(JSON.stringify({
    type: 'stock-ping',
    messages: [{ site: 'Target', productKey: '12345', inStock: true, from: 'protocol-smoke' }],
  }));

  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  const result = await exited;
  assert.equal(result.code, 0, `engine exit=${result.code} signal=${result.signal}\n${stderr}`);
  socket.close();
  await new Promise(resolve => server.close(resolve));
  clearTimeout(timeout);
  console.log(JSON.stringify({ ok: true, arch, authenticatedBridge: true, parentWatch: true }, null, 2));
}

main().catch(error => {
  clearTimeout(timeout);
  try { child?.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  console.error(error.stack || error.message || error);
  process.exit(1);
});
