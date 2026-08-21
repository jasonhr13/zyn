#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('../launcher/node_modules/ws');
const {
  createHarvesterExtensionBridge,
  extensionClientIdentity,
  extensionCookie,
  extensionStatus,
  isChromeExtensionOrigin,
  jsonRequest,
  localProxyGroups,
  normalizeChromeExtensionId,
  normalizeChromeExtensionIds,
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

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

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

function openWebSocket(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, handshakeTimeout: 2000 });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function sendOnWebSocket(socket, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      settled = true;
      reject(new Error('WebSocket request timed out'));
    }, 3000);
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
    socket.once('close', code => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`WebSocket closed before reply (${code})`)); }
    });
    socket.send(JSON.stringify(payload));
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
  const deferredStatusRequests = [];
  const broker = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/status') {
      statusTokenSeen = !!request.headers['x-zyn-token'];
      const sendStatus = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          pools: { login: 2, atc: 5 },
          demand: { activeTasks: 0, effectiveTasks: 4, targets: { login: 4, atc: 8 } },
          targets: { login: 4, atc: 8 },
          activity: { waiting: { login: 0, atc: 1 } },
        }));
      };
      const pending = deferredStatusRequests.shift();
      if (pending) {
        pending.reached.resolve();
        pending.release.promise.then(sendStatus);
      } else {
        sendStatus();
      }
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
  let bridgeEnabled = true;
  let configuredExtensionId = 'a'.repeat(32);
  let activityNow = 1700000000000;
  const bridge = createHarvesterExtensionBridge({
    port: 0,
    brokerPort: brokerAddress.port,
    enabled: () => bridgeEnabled,
    allowedExtensionId: () => configuredExtensionId,
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
    allowProxyImport: () => true,
    getProxyCatalog: () => ({
      lists: [
        { name: 'Local pool', raw: '1.2.3.4:80\r\n\n5.6.7.8:81:user:pass' },
        { name: 'Managed pool', managed: true, raw: 'secret.example:443:user:pass' },
        { name: 'Metadata only', count: 12 },
      ],
    }),
    cookieTtlMs: () => 120000,
    clock: () => activityNow,
    logger: { warn() {} },
  });

  try {
    const address = await bridge.start();
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
    assert.deepEqual(bridge.activity(), {
      enabled: true,
      configured: true,
      authorizedIdCount: 1,
      listening: true,
      lastSeenAt: 0,
      lastStatusAt: 0,
      lastSavedAt: 0,
      lastSavedType: '',
      savedCount: 0,
      clientCount: 0,
      clients: [],
    });

    assert.equal(isChromeExtensionOrigin(EXTENSION_ORIGIN), true);
    assert.equal(isChromeExtensionOrigin('https://target.com'), false);
    assert.equal(normalizeChromeExtensionId('A'.repeat(32)), 'a'.repeat(32));
    assert.equal(normalizeChromeExtensionId('not-an-extension-id'), '');
    assert.deepEqual(normalizeChromeExtensionIds([
      ` ${'A'.repeat(32)},${'b'.repeat(32)} `, 'a'.repeat(32), 'invalid',
    ]), ['a'.repeat(32), 'b'.repeat(32)]);
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
      demand: { mode: 'legacy', activeTasks: 2, effectiveTasks: 2 },
      targets: { login: null, atc: null },
      activity: { waiting: {} },
    }), {
      login: 1,
      atc: 3,
      runningTasks: 2,
      waiting: { login: 0, atc: 0 },
    }, 'an uncapped legacy target must not look like an authoritative zero');
    assert.deepEqual(extensionStatus({
      pools: { login: 1, atc: 300 },
      demand: { mode: 'per-task', activeTasks: 2, effectiveTasks: 2, targets: { atc: null } },
      targets: { login: 2, atc: null },
      activity: { waiting: {} },
    }), {
      login: 1,
      atc: 300,
      runningTasks: 2,
      waiting: { login: 0, atc: 1 },
    }, 'an uncapped dynamic target must keep browser harvesting active');
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
    assert.equal(bridge.activity().lastSeenAt, activityNow,
      'a successful extension status request must publish reachability');
    assert.equal(bridge.activity().lastStatusAt, activityNow);
    assert.equal(bridge.activity().lastSavedAt, 0,
      'a status request must not be presented as a harvested cookie');
    assert.equal(statusTokenSeen, false, 'the broker token leaked to the unauthenticated status route');

    activityNow += 1000;
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
      harvesterId: extensionClientIdentity({}, configuredExtensionId).harvesterId,
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
    assert.deepEqual(bridge.activity(), {
      enabled: true,
      configured: true,
      authorizedIdCount: 1,
      listening: true,
      lastSeenAt: activityNow,
      lastStatusAt: activityNow - 1000,
      lastSavedAt: activityNow,
      lastSavedType: 'atc',
      savedCount: 1,
      clientCount: 1,
      clients: [{
        id: extensionClientIdentity({}, configuredExtensionId).harvesterId,
        browser: 'Browser extension',
        lastSeenAt: activityNow,
        lastStatusAt: activityNow - 1000,
        lastSavedAt: activityNow,
        lastSavedType: 'atc',
        savedCount: 1,
      }],
    }, 'an accepted extension capture must publish source-specific bank activity');

    const savesBeforeIncomplete = saveRequests;
    const activityBeforeRejectedSaves = bridge.activity();
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
    assert.deepEqual(bridge.activity(), activityBeforeRejectedSaves,
      'rejected, invalid, or ambiguous saves must not claim successful extension activity');

    const proxies = await httpGet(address.port, '/proxies', EXTENSION_ORIGIN);
    assert.equal(proxies.status, 200);
    assert.equal(proxies.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    assert.deepEqual(proxies.json, {
      groups: { 'Local pool': ['1.2.3.4:80', '5.6.7.8:81:user:pass'] },
    });
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
    assert.deepEqual(bridge.activity(), activityBeforeRejectedSaves,
      'a rejected extension origin must not update activity');

    configuredExtensionId = 'b'.repeat(32);
    assert.deepEqual(bridge.activity(), {
      enabled: true,
      configured: true,
      authorizedIdCount: 1,
      listening: true,
      lastSeenAt: 0,
      lastStatusAt: 0,
      lastSavedAt: 0,
      lastSavedType: '',
      savedCount: 0,
      clientCount: 0,
      clients: [],
    }, 'changing the configured extension ID must clear the previous extension activity');
    activityNow += 1000;
    await wsRequest(wsUrl, { action: 'status' }, OTHER_EXTENSION_ORIGIN);
    assert.equal(bridge.activity().lastStatusAt, activityNow);
    assert.equal(bridge.activity().lastSavedAt, 0,
      'the new extension ID must not inherit the previous extension save');

    bridge.resetActivity();
    assert.equal(bridge.activity().lastStatusAt, 0,
      'an explicit settings reset must clear extension activity immediately');
    await wsRequest(wsUrl, { action: 'status' }, OTHER_EXTENSION_ORIGIN);

    const socketOpenedBeforeDisable = await openWebSocket(wsUrl, OTHER_EXTENSION_ORIGIN);
    const savesBeforeDisable = saveCapabilityCalls;
    bridgeEnabled = false;
    await assert.rejects(sendOnWebSocket(socketOpenedBeforeDisable, {
      action: 'save', type: 'atc', headers: SHAPE_HEADERS, proxy: '',
    }), /closed before reply/);
    assert.equal(saveCapabilityCalls, savesBeforeDisable,
      'a socket opened before extension harvesting was disabled remained authorized');
    assert.deepEqual(bridge.activity(), {
      enabled: false,
      configured: true,
      authorizedIdCount: 1,
      listening: true,
      lastSeenAt: 0,
      lastStatusAt: 0,
      lastSavedAt: 0,
      lastSavedType: '',
      savedCount: 0,
      clientCount: 0,
      clients: [],
    }, 'turning extension harvesting off must end its activity session');
    bridgeEnabled = true;
    assert.equal(bridge.activity().lastStatusAt, 0,
      're-enabling the same extension ID must require fresh extension activity');

    const socketOpenedBeforeIdChange = await openWebSocket(wsUrl, OTHER_EXTENSION_ORIGIN);
    configuredExtensionId = 'a'.repeat(32);
    await assert.rejects(sendOnWebSocket(socketOpenedBeforeIdChange, { action: 'status' }),
      /closed before reply/);
    assert.equal(bridge.activity().lastSeenAt, 0,
      'a socket opened under the previous extension ID remained authorized');

    const multiBrowserCookies = [];
    const deferredSaveRequests = [];
    let multiBrowserIds = ['a'.repeat(32), 'b'.repeat(32)];
    const multiBrowserBridge = createHarvesterExtensionBridge({
      port: 0,
      brokerPort: brokerAddress.port,
      enabled: () => true,
      allowedExtensionIds: () => multiBrowserIds,
      saveCookie: async cookie => {
        const pending = deferredSaveRequests.shift();
        if (pending) {
          pending.reached.resolve(cookie);
          const response = await pending.release.promise;
          if (response && response.ok !== false && Number(response.saved) > 0) {
            multiBrowserCookies.push(cookie);
          }
          return response;
        }
        multiBrowserCookies.push(cookie);
        return { ok: true, saved: 1 };
      },
      clock: () => activityNow,
      logger: { warn() {} },
    });
    try {
      const multiAddress = await multiBrowserBridge.start();
      const multiUrl = `ws://127.0.0.1:${multiAddress.port}/ws`;
      const chrome = { clientId: 'c'.repeat(32), browser: 'Chrome' };
      const chromeProfileTwo = { clientId: 'd'.repeat(32), browser: 'Chrome' };
      const brave = { clientId: 'e'.repeat(32), browser: 'Brave' };

      await Promise.all([
        wsRequest(multiUrl, { action: 'status', ...chrome }, EXTENSION_ORIGIN),
        wsRequest(multiUrl, { action: 'status', ...chromeProfileTwo }, EXTENSION_ORIGIN),
        wsRequest(multiUrl, { action: 'status', ...brave }, OTHER_EXTENSION_ORIGIN),
      ]);
      assert.deepEqual(multiBrowserBridge.activity().clients.map(client => client.browser).sort(),
        ['Brave', 'Chrome', 'Chrome'],
        'same-origin profiles and different Chromium browsers must be tracked independently');

      const saveResults = await Promise.all([
        wsRequest(multiUrl, {
          action: 'save', ...chrome, type: 'atc', headers: SHAPE_HEADERS, proxy: 'chrome-proxy',
        }, EXTENSION_ORIGIN),
        wsRequest(multiUrl, {
          action: 'save', ...chromeProfileTwo, type: 'atc', headers: SHAPE_HEADERS, proxy: 'chrome-profile-two',
        }, EXTENSION_ORIGIN),
        wsRequest(multiUrl, {
          action: 'save', ...brave, type: 'atc', headers: SHAPE_HEADERS, proxy: 'brave-proxy',
        }, OTHER_EXTENSION_ORIGIN),
      ]);
      assert.ok(saveResults.every(result => result.ok === true && result.saved === 1));
      assert.equal(multiBrowserCookies.length, 3);
      assert.equal(new Set(multiBrowserCookies.map(cookie => cookie.harvesterId)).size, 3,
        'each browser/profile capture needs a distinct bank attribution');
      assert.equal(multiBrowserBridge.activity().savedCount, 3);
      assert.equal(multiBrowserBridge.activity().clientCount, 3);
      await assert.rejects(
        wsRequest(multiUrl, { action: 'status', clientId: 'f'.repeat(32), browser: 'Edge' },
          `chrome-extension://${'c'.repeat(32)}`),
        /Unexpected server response: 403|socket hang up/,
      );

      const braveSocket = await openWebSocket(multiUrl, OTHER_EXTENSION_ORIGIN);
      multiBrowserIds = ['a'.repeat(32)];
      await assert.rejects(sendOnWebSocket(braveSocket, { action: 'status', ...brave }),
        /closed before reply/);
      await wsRequest(multiUrl, { action: 'status', ...chrome }, EXTENSION_ORIGIN);
      assert.equal(multiBrowserBridge.activity().clients.some(client => client.browser === 'Chrome'), true,
        'removing Brave authorization disrupted the still-authorized Chrome harvester');
      assert.equal(multiBrowserBridge.activity().clients.some(client => client.browser === 'Brave'), false,
        'removed browser authorization retained stale activity');

      await Promise.all(Array.from({ length: 70 }, (_value, index) => wsRequest(multiUrl, {
        action: 'status',
        clientId: `flood${String(index).padStart(8, '0')}`,
        browser: 'Chromium',
      }, EXTENSION_ORIGIN)));
      assert.equal(multiBrowserBridge.activity().clientCount, 64,
        'message-supplied client IDs must not grow bridge activity without bound');

      multiBrowserBridge.resetActivity();
      const statusBeforeReset = { reached: deferred(), release: deferred() };
      deferredStatusRequests.push(statusBeforeReset);
      const pendingStatusBeforeReset = wsRequest(
        multiUrl, { action: 'status', ...chrome }, EXTENSION_ORIGIN,
      );
      await statusBeforeReset.reached.promise;
      multiBrowserBridge.resetActivity();
      statusBeforeReset.release.resolve();
      await assert.rejects(pendingStatusBeforeReset, /closed before reply/,
        'a status admitted before an activity reset received a reply in the new session');
      assert.equal(multiBrowserBridge.activity().clientCount, 0,
        'a deferred pre-reset status completion repopulated extension activity');

      multiBrowserIds = ['a'.repeat(32), 'b'.repeat(32)];
      multiBrowserBridge.activity();
      const statusBeforeRevocation = { reached: deferred(), release: deferred() };
      deferredStatusRequests.push(statusBeforeRevocation);
      const pendingStatusBeforeRevocation = wsRequest(
        multiUrl, { action: 'status', ...brave }, OTHER_EXTENSION_ORIGIN,
      );
      await statusBeforeRevocation.reached.promise;
      multiBrowserIds = ['a'.repeat(32)];
      statusBeforeRevocation.release.resolve();
      await assert.rejects(pendingStatusBeforeRevocation, /closed before reply/,
        'a status admitted before ID revocation received a reply after revocation');
      assert.equal(multiBrowserBridge.activity().clients.some(client => client.browser === 'Brave'), false,
        'a deferred status from a revoked extension repopulated activity');

      const cookiesBeforeResetSave = multiBrowserCookies.length;
      const saveBeforeReset = { reached: deferred(), release: deferred() };
      deferredSaveRequests.push(saveBeforeReset);
      const pendingSaveBeforeReset = wsRequest(multiUrl, {
        action: 'save', ...chrome, type: 'atc', headers: SHAPE_HEADERS, proxy: 'reset-race-proxy',
      }, EXTENSION_ORIGIN);
      await saveBeforeReset.reached.promise;
      multiBrowserBridge.resetActivity();
      saveBeforeReset.release.resolve({ ok: true, saved: 1 });
      assert.deepEqual(await pendingSaveBeforeReset, { ok: true, saved: 1 },
        'an accepted pre-reset save must be acknowledged so the extension does not retry it');
      assert.equal(multiBrowserCookies.length, cookiesBeforeResetSave + 1,
        'resetting activity cancelled a save already accepted by the cookie bank');
      assert.equal(multiBrowserBridge.activity().savedCount, 0,
        'an accepted pre-reset save completion repopulated extension activity');

      multiBrowserIds = ['a'.repeat(32), 'b'.repeat(32)];
      multiBrowserBridge.activity();
      const cookiesBeforeRevokedSave = multiBrowserCookies.length;
      const saveBeforeRevocation = { reached: deferred(), release: deferred() };
      deferredSaveRequests.push(saveBeforeRevocation);
      const pendingSaveBeforeRevocation = wsRequest(multiUrl, {
        action: 'save', ...brave, type: 'atc', headers: SHAPE_HEADERS, proxy: 'revoked-race-proxy',
      }, OTHER_EXTENSION_ORIGIN);
      await saveBeforeRevocation.reached.promise;
      multiBrowserIds = ['a'.repeat(32)];
      saveBeforeRevocation.release.resolve({ ok: true, saved: 1 });
      assert.deepEqual(await pendingSaveBeforeRevocation, { ok: true, saved: 1 },
        'an accepted save from a revoked ID must still be acknowledged exactly once');
      assert.equal(multiBrowserCookies.length, cookiesBeforeRevokedSave + 1,
        'revoking an extension cancelled a save already accepted by the cookie bank');
      assert.equal(multiBrowserBridge.activity().clients.some(client => client.browser === 'Brave'), false,
        'an accepted save from a revoked extension repopulated activity');
    } finally {
      await multiBrowserBridge.stop();
    }

    const bootstrap = fs.readFileSync(path.join(project, 'launcher', 'bootstrap.js'), 'utf8');
    const macBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn.sh'), 'utf8');
    const windowsBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn-windows.sh'), 'utf8');
    const contract = JSON.parse(fs.readFileSync(
      path.join(project, 'config', 'runtime-contract.json'), 'utf8'));
    assert.match(bootstrap, /createHarvesterExtensionBridge/,
      'Zyn bootstrap does not create the extension compatibility bridge');
    assert.match(bootstrap, /allowProxyImport: \(\) => true/,
      'Zyn bootstrap does not export user-owned proxy lists to the extension Import button');
    assert.match(bootstrap, /getProxyCatalog:/,
      'Zyn bootstrap does not wire the proxy catalog into the extension bridge');
    assert.match(bootstrap, /allowedExtensionIds: configuredExtensionIds/,
      'Zyn bootstrap does not pin the configured browser extension IDs');
    assert.match(bootstrap, /saveCookie: cookie =>/,
      'Zyn bootstrap does not use the Target engine authenticated-save capability');
    assert.match(bootstrap, /targetEngine\.saveHarvesterCookie\(cookie\)/,
      'Zyn bootstrap bypasses the Target engine authenticated-save capability');
    assert.match(bootstrap, /extensionHarvester: bridge\.activity\(\)/,
      'the Target cookie-bank IPC does not include safe extension activity');
    assert.match(bootstrap, /resetHarvesterExtensionActivity[^\n]+bridge\.resetActivity\(\)/,
      'extension settings changes do not reset prior bridge activity');
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
