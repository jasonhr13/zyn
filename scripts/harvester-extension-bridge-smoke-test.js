#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('../launcher/node_modules/ws');
const {
  createHarvesterExtensionBridge,
  extensionCookie,
  extensionStatus,
  isChromeExtensionOrigin,
  jsonRequest,
  localProxyGroups,
  normalizeChromeExtensionId,
} = require('../launcher/harvester-extension-bridge');

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXTENSION_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
const BROKER_TOKEN = 'bridge-broker-token';
const SHAPE_HEADERS = Object.fromEntries([
  'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
  'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
  'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
].map(name => [name, `captured-${name}`]));
const project = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

function wsRequest(url, payload, origin = EXTENSION_ORIGIN) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, handshakeTimeout: 2000 });
    let settled = false;
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      settled = true;
      reject(new Error('WebSocket request timed out'));
    }, 3000);
    socket.once('open', () => socket.send(JSON.stringify(payload)));
    socket.once('message', raw => {
      clearTimeout(timer);
      settled = true;
      try { resolve(JSON.parse(String(raw))); }
      catch (error) { reject(error); }
      try { socket.close(); } catch {}
    });
    socket.once('error', error => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    socket.once('close', (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`WebSocket closed before reply (${code})`)); }
    });
  });
}

function httpGet(port, path, origin) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers: origin ? { origin } : {},
      timeout: 2000,
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(body || '{}'); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, json });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
  });
}

(async () => {
  let savedCookie = null;
  let saveRequests = 0;
  let statusTokenSeen = false;
  const broker = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/status') {
      statusTokenSeen = !!request.headers['x-zyn-token'];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        pools: { login: 2, atc: 5 },
        demand: { activeTasks: 0, effectiveTasks: 4, targets: { login: 4, atc: 8 } },
        targets: { login: 4, atc: 8 },
        activity: { waiting: { login: 0, atc: 1 } },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/saveCookies') {
      if (request.headers['x-zyn-token'] !== BROKER_TOKEN) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      saveRequests += 1;
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        savedCookie = JSON.parse(body);
        if (savedCookie.headers['x-gyjwza5z-a'] === 'ambiguous-response') {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, saved: savedCookie.type === 'login' ? 0 : 1 }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const brokerAddress = await listen(broker);

  let ensureCalls = 0;
  let saveCapabilityCalls = 0;
  const bridge = createHarvesterExtensionBridge({
    port: 0,
    brokerPort: brokerAddress.port,
    enabled: () => true,
    allowedExtensionId: () => 'a'.repeat(32),
    saveCookie: cookie => {
      saveCapabilityCalls += 1;
      return jsonRequest({
        host: '127.0.0.1',
        port: brokerAddress.port,
        path: '/saveCookies',
        method: 'POST',
        body: cookie,
        headers: { 'x-zyn-token': BROKER_TOKEN },
      });
    },
    ensureBroker: () => { ensureCalls += 1; },
    getProxyCatalog: () => ({
      lists: [
        { name: 'Local pool', raw: '1.2.3.4:80\r\n\n5.6.7.8:81:user:pass' },
        { name: 'Managed pool', managed: true, raw: 'secret.example:443:user:pass' },
        { name: 'Metadata only', count: 12 },
      ],
    }),
    cookieTtlMs: () => 120000,
    logger: { warn() {} },
  });

  try {
    const address = await bridge.start();
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    assert.equal(isChromeExtensionOrigin(EXTENSION_ORIGIN), true);
    assert.equal(isChromeExtensionOrigin('https://target.com'), false);
    assert.equal(normalizeChromeExtensionId('A'.repeat(32)), 'a'.repeat(32));
    assert.equal(normalizeChromeExtensionId('not-an-extension-id'), '');
    assert.deepEqual(extensionStatus({
      pools: { login: 1, atc: 3 },
      demand: { activeTasks: 2, effectiveTasks: 7, targets: { atc: 10 } },
      targets: { atc: 10 },
      activity: { waiting: { atc: 4 } },
    }), {
      login: 1,
      atc: 3,
      runningTasks: 0,
      waiting: { login: 0, atc: 7 },
    });
    assert.deepEqual(extensionStatus({
      pools: { login: 1, atc: 3 },
      demand: { activeTasks: 2, effectiveTasks: 2 },
      targets: { login: null, atc: null },
      activity: { waiting: {} },
    }), {
      login: 1,
      atc: 3,
      runningTasks: 2,
      waiting: { login: 0, atc: 0 },
    }, 'an uncapped legacy target must not look like an authoritative zero');
    assert.deepEqual(extensionCookie({
      type: 'atc',
      headers: {
        ...SHAPE_HEADERS,
        'X-GYJWZA5Z-A': 'value',
        Cookie: 'target-session=must-not-cross',
        authorization: 'must-not-cross',
      },
      proxy: '1.2.3.4:80:user:pass',
      expiry: 999999,
    }, { now: 1000, maxTtlMs: 60000 }), {
      type: 'atc',
      headers: { ...SHAPE_HEADERS, 'x-gyjwza5z-a': 'value' },
      proxy: '1.2.3.4:80:user:pass',
      expiresAt: 61000,
      harvesterId: 'chrome-extension',
      source: 'extension',
    });
    assert.throws(() => extensionCookie({ type: 'other', headers: {} }),
      /cookie type must be login or atc/);
    assert.throws(() => extensionCookie({ type: 'atc', headers: { 'x-gyjwza5z-a': 'partial' } }),
      /capture is missing required headers/);
    assert.deepEqual(localProxyGroups({ lists: [
      { name: 'Local', raw: 'one\ntwo' },
      { name: 'Managed', managed: true, raw: 'secret' },
    ] }), { Local: ['one', 'two'] });

    const status = await wsRequest(wsUrl, { action: 'status' });
    assert.deepEqual(status, {
      login: 2,
      atc: 5,
      runningTasks: 0,
      waiting: { login: 0, atc: 3 },
    });
    assert.equal(statusTokenSeen, false, 'the broker token leaked to the unauthenticated status route');

    const beforeSave = Date.now();
    const save = await wsRequest(wsUrl, {
      action: 'save',
      type: 'atc',
      headers: {
        ...SHAPE_HEADERS,
        'x-gyjwza5z-a': 'captured',
        Cookie: 'target-session=must-not-cross',
        Authorization: 'must-not-cross',
      },
      proxy: '9.8.7.6:3128:user:pass',
      expiry: Date.now() + 86400000,
    });
    assert.deepEqual(save, { ok: true, saved: 1 });
    assert.deepEqual(savedCookie, {
      type: 'atc',
      headers: { ...SHAPE_HEADERS, 'x-gyjwza5z-a': 'captured' },
      proxy: '9.8.7.6:3128:user:pass',
      expiresAt: savedCookie.expiresAt,
      harvesterId: 'chrome-extension',
      source: 'extension',
    });
    assert.ok(savedCookie.expiresAt >= beforeSave + 119000
      && savedCookie.expiresAt <= Date.now() + 120000,
    'extension expiry was not clamped to Zyn\'s configured TTL');
    assert.equal('cookie' in savedCookie.headers, false);
    assert.equal('authorization' in savedCookie.headers, false);
    assert.ok(ensureCalls >= 1, 'status must ensure the Zyn broker');
    assert.equal(saveCapabilityCalls, 1,
      'the accepted capture did not use exactly one authenticated save capability call');

    const savesBeforeIncomplete = saveRequests;
    await assert.rejects(wsRequest(wsUrl, {
      action: 'save', type: 'atc', headers: { 'x-gyjwza5z-a': 'partial' }, proxy: '',
    }), /closed before reply/);
    assert.equal(saveRequests, savesBeforeIncomplete,
      'an incomplete capture reached the cookie broker');

    await assert.rejects(wsRequest(wsUrl, {
      action: 'save', type: 'login', headers: SHAPE_HEADERS, proxy: '',
    }), /closed before reply/);
    assert.equal(saveRequests, savesBeforeIncomplete + 1,
      'a broker rejection was unexpectedly retried or skipped');

    const savesBeforeAmbiguousResponse = saveRequests;
    await assert.rejects(wsRequest(wsUrl, {
      action: 'save', type: 'atc',
      headers: { ...SHAPE_HEADERS, 'x-gyjwza5z-a': 'ambiguous-response' }, proxy: '',
    }), /closed before reply/);
    assert.equal(saveRequests, savesBeforeAmbiguousResponse + 1,
      'a non-idempotent save was retried after an ambiguous response failure');

    const proxies = await httpGet(address.port, '/proxies', EXTENSION_ORIGIN);
    assert.equal(proxies.status, 200);
    assert.equal(proxies.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    assert.deepEqual(proxies.json, { groups: {} });
    assert.equal(JSON.stringify(proxies.json).includes('secret.example'), false,
      'managed proxy credentials crossed the extension bridge');

    const browserPage = await httpGet(address.port, '/proxies', 'https://target.com');
    assert.equal(browserPage.status, 403);
    await assert.rejects(
      wsRequest(wsUrl, { action: 'status' }, 'https://target.com'),
      /Unexpected server response: 403|socket hang up/,
    );
    await assert.rejects(
      wsRequest(wsUrl, { action: 'status' }, OTHER_EXTENSION_ORIGIN),
      /Unexpected server response: 403|socket hang up/,
    );

    const bootstrap = fs.readFileSync(path.join(project, 'launcher', 'bootstrap.js'), 'utf8');
    const macBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn.sh'), 'utf8');
    const windowsBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn-windows.sh'), 'utf8');
    const contract = JSON.parse(fs.readFileSync(
      path.join(project, 'config', 'runtime-contract.json'), 'utf8'));
    assert.match(bootstrap, /createHarvesterExtensionBridge/,
      'Zyn bootstrap does not create the extension compatibility bridge');
    assert.match(bootstrap, /allowProxyImport: \(\) => false/,
      'Zyn bootstrap can expose proxy credentials through the legacy endpoint');
    assert.match(bootstrap, /allowedExtensionId: configuredExtensionId/,
      'Zyn bootstrap does not pin the configured Chrome extension ID');
    assert.match(bootstrap, /saveCookie: cookie =>/,
      'Zyn bootstrap does not use the Target engine authenticated-save capability');
    assert.match(bootstrap, /targetEngine\.saveHarvesterCookie\(cookie\)/,
      'Zyn bootstrap bypasses the Target engine authenticated-save capability');
    assert.match(macBuild, /harvester-extension-bridge\.js/,
      'macOS packaging omits the extension bridge');
    assert.match(windowsBuild, /harvester-extension-bridge\.js/,
      'Windows packaging omits the extension bridge');
    assert.ok(contract.requiredResources.includes(
      'Contents/Resources/app/harvester-extension-bridge.js'),
    'runtime contract omits the extension bridge');

    const foreignServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ owner: 'foreign' }));
    });
    const foreignAddress = await listen(foreignServer);
    const conflictingBridge = createHarvesterExtensionBridge({
      port: foreignAddress.port,
      enabled: () => true,
      logger: { warn() {} },
    });
    try {
      await assert.rejects(conflictingBridge.start(), error => error && error.code === 'EADDRINUSE');
      const stillForeign = await httpGet(foreignAddress.port, '/', '');
      assert.deepEqual(stillForeign.json, { owner: 'foreign' },
        'the bridge disturbed a foreign listener while handling a port conflict');
    } finally {
      await conflictingBridge.stop();
      await close(foreignServer);
    }

    const earlyStopBridge = createHarvesterExtensionBridge({
      port: 0,
      enabled: () => true,
      allowedExtensionId: () => 'a'.repeat(32),
      logger: { warn() {} },
    });
    const pendingStart = earlyStopBridge.start();
    await earlyStopBridge.stop();
    await assert.rejects(pendingStart, /stopped before startup completed/);

    console.log(JSON.stringify({
      ok: true,
      websocket: ['status', 'save'],
      http: ['/proxies'],
      originRestricted: true,
      extensionIdPinned: true,
      brokerAuthenticated: true,
      nonIdempotentSaveRetries: 0,
      earlyStopSettled: true,
      packagedFor: ['darwin', 'win32'],
      foreignPortPreserved: true,
      managedProxyCredentialsExposed: false,
    }, null, 2));
  } finally {
    await bridge.stop();
    await close(broker);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
