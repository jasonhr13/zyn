#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'launcher', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
const userDataDirectory = process.argv[4];
if (!port || !screenshotPath || !userDataDirectory) {
  console.error('Usage: node scripts/profile-imap-runtime-smoke-test.js <debug-port> <screenshot-path> <user-data-dir>');
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
      const authoritative = await ipc.invoke('licenseStatus');
      const deniedTest = await ipc.invoke('testProfileImap', {
        host: 'imap.invalid', port: 993, user: 'denied@example.com', password: 'never-sent'
      });
      const lockedBadge = document.querySelector('.license-gate-badge')?.textContent.trim() || '';

      ipc.emit('licenseStatus', {}, {
        ok: true,
        email: 'r6-renderer-test@example.com',
        offline: false,
        taskTypes: { pokemoncenter: true, round1: true }
      });
      await wait(250);
      location.hash = '#/profiles';
      await wait(350);
      const newButton = [...document.querySelectorAll('button')].find(button => button.textContent.includes('New Profile'));
      if (!newButton) throw new Error('New Profile button was not found');
      newButton.click();
      await wait(200);

      const modal = document.querySelector('.modal');
      const provider = modal?.querySelector('select.form-select');
      const inputs = [...(modal?.querySelectorAll('input.form-input') || [])];
      const byPlaceholder = placeholder => inputs.find(input => input.placeholder === placeholder);
      const setInput = (input, value) => {
        if (!input) throw new Error('Missing profile input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const setSelect = (select, value) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };

      setSelect(provider, 'imap.gmail.com');
      await wait(50);
      const allInputs = [...modal.querySelectorAll('input.form-input')];
      const findNow = placeholder => allInputs.find(input => input.placeholder === placeholder);
      setInput(byPlaceholder('e.g. John - Chase Sapphire'), 'R6 Mailbox Profile');
      setInput(byPlaceholder('john@example.com'), 'checkout@example.com');
      setInput(findNow('mailbox@example.com'), 'mailbox-r6@example.com');
      setInput(findNow('App-specific password'), 'mail box secret');
      setInput(byPlaceholder('John'), 'Mail');
      setInput(byPlaceholder('Doe'), 'Tester');
      setInput(byPlaceholder('123 Main St'), '6 Profile Way');
      setInput(byPlaceholder('New York'), 'Testville');
      setInput(byPlaceholder('NY'), 'CA');
      setInput(byPlaceholder('10001'), '90006');
      setInput(byPlaceholder('4111 1111 1111 1111'), '4111111111111111');
      setInput(byPlaceholder('12'), '12');
      setInput(byPlaceholder('2027'), '2099');
      setInput(byPlaceholder('123'), '123');
      await wait(100);

      const originalInvoke = ipc.invoke;
      ipc.invoke = function profileImapTest(channel, ...args) {
        if (channel === 'testProfileImap') return Promise.resolve({ ok: true, message: 'Connection successful. The mailbox credentials are valid.' });
        return originalInvoke.call(this, channel, ...args);
      };
      const testButton = [...modal.querySelectorAll('button')].find(button => button.textContent.includes('Test IMAP Connection'));
      testButton.click();
      await wait(100);
      const testResult = modal.textContent.includes('Connection successful. The mailbox credentials are valid.');
      ipc.invoke = originalInvoke;

      const saveButton = [...modal.querySelectorAll('button')].find(button => button.textContent.includes('Save Profile'));
      saveButton.click();
      await wait(250);
      const profiles = ipc.sendSync('getProfiles') || [];
      const created = profiles.find(profile => profile.profileName === 'R6 Mailbox Profile');
      return {
        electron: process.versions.electron,
        authoritativeOk: authoritative?.ok,
        gateBadge: lockedBadge,
        deniedTest,
        providerCount: provider?.options.length || 0,
        testResult,
        modalClosed: !document.querySelector('.modal'),
        profile: created ? {
          id: created.id,
          email: created.email,
          imap: created.imap,
        } : null,
        cardShowsMailbox: document.body.textContent.includes('OTP: mailbox-r6@example.com'),
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  socket.close();

  const profilesPath = path.join(userDataDirectory, 'profiles.json');
  const rawProfiles = fs.readFileSync(profilesPath, 'utf8');
  const result = {
    ...evaluated.result.value,
    encryptedAtRest: !rawProfiles.includes('mail box secret') && /"password":\s*"enc:/.test(rawProfiles),
    paymentEncryptedAtRest: !rawProfiles.includes('4111111111111111')
      && !rawProfiles.includes('"cardCvv": "123"')
      && /"cardNumber":\s*"enc:/.test(rawProfiles)
      && /"cardCvv":\s*"enc:/.test(rawProfiles),
    profileFileMode: fs.statSync(profilesPath).mode & 0o777,
    rendererExceptions,
    rendererErrors,
    screenshotPath,
  };
  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.authoritativeOk, false);
  assert.equal(result.gateBadge, 'ZYNAIO');
  assert.equal(result.deniedTest.ok, false);
  assert.match(result.deniedTest.message, /Sign in/i);
  assert.equal(result.providerCount, 6);
  assert.equal(result.testResult, true);
  assert.equal(result.modalClosed, true);
  assert.equal(result.profile.email, 'checkout@example.com');
  assert.deepEqual(result.profile.imap, {
    host: 'imap.gmail.com', port: 993, user: 'mailbox-r6@example.com', password: 'mail box secret',
  });
  assert.equal(result.cardShowsMailbox, true);
  assert.equal(result.encryptedAtRest, true);
  assert.equal(result.paymentEncryptedAtRest, true);
  assert.equal(result.profileFileMode, 0o600);
  assert.equal(rendererExceptions, 0);
  assert.equal(rendererErrors, 0);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
