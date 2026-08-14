#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'launcher', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
if (!port || !screenshotPath) {
  console.error('Usage: node scripts/license-enforcement-runtime-smoke-test.js <debug-port> <screenshot-path>');
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
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
  let rendererExceptions = 0;
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
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') rendererExceptions += 1;
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') rendererErrors += 1;
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(350);
      const license = await ipc.invoke('licenseStatus');
      const email = document.querySelector('.license-gate-card input[type="email"]');
      const password = document.querySelector('.license-gate-card input[type="password"]');
      const submit = document.querySelector('.license-gate-card button[type="submit"]');
      if (!email || !password || !submit) throw new Error('Account gate controls were not found');

      email.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const frameTimes = [];
      for (let index = 0; index < 60; index += 1) {
        const started = performance.now();
        nativeSetter.call(email, email.value + 'a');
        email.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        frameTimes.push(performance.now() - started);
      }
      const insertedCharacters = email.value.length;
      nativeSetter.call(email, '');
      email.dispatchEvent(new Event('input', { bubbles: true }));

      let denialPushes = 0;
      const onLicense = () => { denialPushes += 1; };
      ipc.on('licenseStatus', onLicense);
      ipc.send('startTarget', { tasks: [{ id: 'must-not-start' }], skus: ['12345678'], qty: 1 });
      const round1Accepted = ipc.sendSync('startRound1', { profileIds: [], url: 'https://example.com' });
      const rotateAccepted = ipc.sendSync('startPbandaiRotate', { profileIds: [], codes: [] });
      const scriptResult = await ipc.invoke('runBotScript', 'generate-bandai.mjs', [], 'r4-block-test');
      await wait(350);
      ipc.removeListener('licenseStatus', onLicense);
      const retiredActivation = await ipc.invoke('activateLicense', 'legacy-key-must-not-work');
      const sortedFrames = [...frameTimes].sort((left, right) => left - right);
      return {
        electron: process.versions.electron,
        appVersion: ipc.sendSync('getAppVersion'),
        license: {
          ok: license && license.ok,
          reason: license && license.reason,
          rendererKeys: Object.keys(license || {}).sort()
        },
        gate: {
          present: Boolean(document.querySelector('.license-gate-r4')),
          badge: document.querySelector('.license-gate-badge')?.textContent.trim(),
          title: document.querySelector('.license-gate-title')?.textContent.trim(),
          acknowledgementPresent: Boolean(document.querySelector('.license-gate-acknowledge')),
          legacyKeyCopyPresent: document.body.textContent.includes('Enter your license key'),
          submitInitiallyDisabled: submit.disabled,
          insertedCharacters,
          averageFrameMs: frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length,
          p95FrameMs: sortedFrames[Math.floor(sortedFrames.length * 0.95)]
        },
        launchBoundary: {
          denialPushes,
          round1Accepted,
          rotateAccepted,
          botScriptBlocked: scriptResult && scriptResult.success === false && /sign in/i.test(scriptResult.error || ''),
          legacyKeyRejected: retiredActivation && retiredActivation.ok === false
        }
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { ...evaluated.result.value, rendererExceptions, rendererErrors, screenshotPath };
  console.log(JSON.stringify(report, null, 2));
  socket.close();

  const sensitiveStatus = report.license.rendererKeys.some(key => /token|password|device|hwid|reset|key/i.test(key));
  if (report.license.ok !== false
    || !report.gate.present
    || report.gate.badge !== 'ZYN'
    || report.gate.title !== 'Sign in to Zyn'
    || report.gate.acknowledgementPresent
    || report.gate.legacyKeyCopyPresent
    || !report.gate.submitInitiallyDisabled
    || report.gate.insertedCharacters !== 60
    || sensitiveStatus
    || report.launchBoundary.denialPushes < 3
    || report.launchBoundary.round1Accepted !== false
    || report.launchBoundary.rotateAccepted !== false
    || !report.launchBoundary.botScriptBlocked
    || !report.launchBoundary.legacyKeyRejected
    || rendererExceptions
    || rendererErrors) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
