#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'launcher', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
if (!port) {
  console.error('Usage: node scripts/zyn-production-session-smoke.cjs <debug-port>');
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('Zyn renderer target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let rendererErrors = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown'
      || (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')) {
      rendererErrors += 1;
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await send('Runtime.enable');
  await send('Log.enable');

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const license = await ipc.invoke('licenseStatus', { force: true });
      let runtime = await ipc.invoke('runtimeStatus');
      const deadline = Date.now() + 360000;
      while (license && license.ok && !runtime.ready && runtime.state !== 'error' && Date.now() < deadline) {
        await wait(1000);
        runtime = await ipc.invoke('runtimeStatus');
      }
      return {
        version: ipc.sendSync('getAppVersion'),
        title: document.title,
        license: { ok: Boolean(license && license.ok), offline: Boolean(license && license.offline), reason: license && license.reason || '' },
        runtime: { ready: Boolean(runtime && runtime.ready), state: runtime && runtime.state, percent: runtime && runtime.percent, error: runtime && runtime.error || '' },
        gatePresent: Boolean(document.querySelector('.license-gate-r4')),
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  const report = { ...evaluated.result.value, rendererErrors };
  console.log(JSON.stringify(report, null, 2));
  socket.close();
  if (report.license.ok && (!report.runtime.ready || report.runtime.state !== 'ready')) process.exitCode = 1;
  if (rendererErrors) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
