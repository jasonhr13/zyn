'use strict';

// Compatibility boundary for external Chromium Target cookie harvesters.
//
// The extension speaks a small legacy protocol on 127.0.0.1:4312:
//   WebSocket /ws  { action: 'status', clientId?, browser? }
//   WebSocket /ws  { action: 'save', clientId?, browser?, type, headers, proxy, expiry }
//   HTTP GET /proxies
//
// Zyn's native engine consumes a different, readable HTTP broker on :4727. Keep the opaque
// extension outside the app and translate only its loopback protocol here. In particular, this
// bridge never returns banked headers or managed-proxy credentials.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4312;
const DEFAULT_BROKER_PORT = 4727;
const MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_COOKIE_TTL_MS = 10 * 60 * 1000;
const MIN_COOKIE_TTL_MS = 30 * 1000;
const MAX_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EXTENSION_IDS = 16;
const MAX_ACTIVITY_CLIENTS = 64;
const ACTIVITY_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const REQUIRED_CAPTURED_HEADER_NAMES = Object.freeze([
  'sec-ch-ua-platform',
  'sec-ch-ua',
  'user-agent',
  'x-gyjwza5z-a',
  'x-gyjwza5z-b',
  'x-gyjwza5z-c',
  'x-gyjwza5z-d',
  'x-gyjwza5z-f',
  'x-gyjwza5z-z',
]);
const CAPTURED_HEADER_NAMES = new Set([
  ...REQUIRED_CAPTURED_HEADER_NAMES,
  'x-gyjwza5z-a0',
]);

function isChromeExtensionOrigin(value) {
  return EXTENSION_ORIGIN.test(String(value || '').toLowerCase());
}

function normalizeChromeExtensionId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-p]{32}$/.test(id) ? id : '';
}

function normalizeChromeExtensionIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();
  for (const item of values) {
    for (const token of String(item || '').split(/[\s,;]+/)) {
      const id = normalizeChromeExtensionId(token);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= MAX_EXTENSION_IDS) return ids;
    }
  }
  return ids;
}

function normalizeHarvesterInstanceId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,63}$/.test(id) ? id : '';
}

function normalizeBrowserName(value) {
  const name = String(value || '').trim().toLowerCase();
  const known = {
    brave: 'Brave',
    chrome: 'Chrome',
    chromium: 'Chromium',
    edge: 'Edge',
    opera: 'Opera',
    vivaldi: 'Vivaldi',
  };
  return known[name] || 'Browser extension';
}

function extensionClientIdentity(message = {}, extensionId = '') {
  const normalizedExtensionId = normalizeChromeExtensionId(extensionId);
  if (!normalizedExtensionId) throw new TypeError('invalid extension id');
  const instanceId = normalizeHarvesterInstanceId(
    message.harvesterInstanceId || message.clientId,
  );
  const key = `${normalizedExtensionId}:${instanceId || 'legacy'}`;
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return {
    key,
    extensionId: normalizedExtensionId,
    instanceId,
    browser: normalizeBrowserName(message.browser),
    harvesterId: `browser-extension-${digest}`,
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function jsonRequest({
  host = DEFAULT_HOST,
  port = DEFAULT_BROKER_PORT,
  path = '/',
  method = 'GET',
  body = null,
  timeoutMs = 900,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body == null ? '' : JSON.stringify(body);
    const request = http.request({
      host,
      port,
      path,
      method,
      timeout: timeoutMs,
      headers: {
        ...headers,
        ...(encoded ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
        } : {}),
      },
    }, response => {
      let value = '';
      response.on('data', chunk => {
        value += chunk;
        if (value.length > 1024 * 1024) request.destroy(new Error('broker response is too large'));
      });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(value || '{}'); }
        catch { reject(new Error('broker returned invalid JSON')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`broker returned ${response.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('broker request timed out')));
    if (encoded) request.write(encoded);
    request.end();
  });
}

function extensionStatus(status = {}) {
  const demand = status && typeof status.demand === 'object' ? status.demand : {};
  const pools = status && typeof status.pools === 'object' ? status.pools : {};
  const targets = status && typeof status.targets === 'object'
    ? status.targets : demand && typeof demand.targets === 'object' ? demand.targets : {};
  const waiting = status && status.activity && typeof status.activity.waiting === 'object'
    ? status.activity.waiting : {};
  const effectiveTasks = Number(demand.effectiveTasks);
  const activeTasks = Number(demand.activeTasks);
  const login = Math.max(0, Number(pools.login) || 0);
  const atc = Math.max(0, Number(pools.atc) || 0);
  const rawAtcTarget = targets.atc;
  const atcTarget = Number(rawAtcTarget);
  const hasAuthoritativeTarget = rawAtcTarget !== null && rawAtcTarget !== undefined
    && rawAtcTarget !== '' && Number.isFinite(atcTarget) && atcTarget >= 0;
  return {
    login,
    atc,
    // The old extension multiplies this field by its own Cookies/Task setting. Zyn already has an
    // authoritative per-task target, so represent its exact deficit as a waiter and suppress that
    // second, independently configured multiplier. Keep the legacy mapping only for an old broker
    // that does not publish targets.
    runningTasks: hasAuthoritativeTarget ? 0 : Math.max(0, Number.isFinite(effectiveTasks)
      ? effectiveTasks : Number.isFinite(activeTasks) ? activeTasks : 0),
    waiting: {
      login: Math.max(0, Number(waiting.login) || 0),
      atc: Math.max(0, Number(waiting.atc) || 0,
        hasAuthoritativeTarget ? Math.ceil(atcTarget - atc) : 0),
    },
  };
}

function extensionCookie(message = {}, {
  now = Date.now(),
  maxTtlMs = DEFAULT_COOKIE_TTL_MS,
  harvesterId = 'chrome-extension',
} = {}) {
  const type = String(message.type || '').toLowerCase();
  if (type !== 'login' && type !== 'atc') throw new TypeError('cookie type must be login or atc');
  const sourceHeaders = message.headers && typeof message.headers === 'object' && !Array.isArray(message.headers)
    ? message.headers : {};
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(sourceHeaders)) {
    const name = String(rawName || '').toLowerCase();
    if (!CAPTURED_HEADER_NAMES.has(name) || rawValue == null) continue;
    const value = String(rawValue).slice(0, 8192);
    if (value) headers[name] = value;
  }
  const missing = REQUIRED_CAPTURED_HEADER_NAMES.filter(name => !String(headers[name] || '').trim());
  if (missing.length) throw new TypeError(`capture is missing required headers: ${missing.join(', ')}`);
  const ttl = Math.max(MIN_COOKIE_TTL_MS, Math.min(MAX_COOKIE_TTL_MS,
    Number(maxTtlMs) || DEFAULT_COOKIE_TTL_MS));
  const requestedExpiry = Number(message.expiry);
  const expiresAt = Number.isFinite(requestedExpiry) && requestedExpiry > now
    ? Math.min(requestedExpiry, now + ttl) : now + ttl;
  return {
    type,
    headers,
    proxy: String(message.proxy || '').slice(0, 4096),
    expiresAt,
    harvesterId: String(harvesterId || 'chrome-extension')
      .replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'chrome-extension',
    source: 'extension',
  };
}

function localProxyGroups(catalog = {}) {
  const groups = {};
  const lists = Array.isArray(catalog && catalog.lists) ? catalog.lists : [];
  for (const list of lists) {
    // Managed lists deliberately omit raw. Do not resolve them through getProxyLines here: the
    // extension protocol has no pairing secret, so doing that would punch through Zyn's
    // main-process-only managed credential boundary.
    if (!list || list.managed === true || typeof list.raw !== 'string') continue;
    const name = String(list.name || '').trim().slice(0, 80);
    if (!name || Object.prototype.hasOwnProperty.call(groups, name)) continue;
    const lines = list.raw.replace(/\r/g, '').split('\n')
      .map(line => line.trim()).filter(Boolean).slice(0, 100000);
    if (lines.length) groups[name] = lines;
  }
  return groups;
}

function createHarvesterExtensionBridge({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  brokerHost = DEFAULT_HOST,
  brokerPort = DEFAULT_BROKER_PORT,
  enabled = () => true,
  ensureBroker = () => {},
  getProxyCatalog = () => ({ lists: [] }),
  allowProxyImport = () => false,
  allowedExtensionIds = null,
  allowedExtensionId = () => '',
  saveCookie = null,
  cookieTtlMs = () => DEFAULT_COOKIE_TTL_MS,
  logger = console,
  brokerAttempts = 12,
  brokerRetryMs = 150,
  clock = Date.now,
} = {}) {
  let server = null;
  let webSockets = null;
  let listeningAddress = null;
  let pendingStart = null;
  const clientActivity = new Map();
  let activityEnabled = null;
  let activityConfigurationKey = null;
  let activityGeneration = 0;

  const timestamp = () => {
    try { return Math.max(0, Number(clock()) || 0); }
    catch { return Date.now(); }
  };

  const available = () => {
    try { return enabled() === true; }
    catch { return false; }
  };

  const configuredIds = () => {
    try {
      const value = typeof allowedExtensionIds === 'function'
        ? allowedExtensionIds()
        : allowedExtensionIds == null ? allowedExtensionId() : allowedExtensionIds;
      return normalizeChromeExtensionIds(value);
    } catch { return []; }
  };

  const pruneClientActivity = (ids = configuredIds()) => {
    const allowed = new Set(ids);
    const now = timestamp();
    for (const [key, client] of clientActivity) {
      const stale = client.lastSeenAt > 0 && now >= client.lastSeenAt
        && now - client.lastSeenAt > ACTIVITY_CLIENT_TTL_MS;
      if (!allowed.has(client.extensionId) || stale) clientActivity.delete(key);
    }
  };

  const activityConfiguration = () => {
    const isEnabled = available();
    const ids = configuredIds();
    const configurationKey = `${isEnabled ? 'enabled' : 'disabled'}:${[...ids].sort().join(',')}`;
    if (activityConfigurationKey !== null && activityConfigurationKey !== configurationKey) {
      activityGeneration += 1;
    }
    if (activityEnabled !== null && activityEnabled !== isEnabled) clientActivity.clear();
    activityEnabled = isEnabled;
    activityConfigurationKey = configurationKey;
    pruneClientActivity(ids);
    return { isEnabled, ids, generation: activityGeneration };
  };

  const resetActivity = () => {
    clientActivity.clear();
    activityGeneration += 1;
  };

  const originAllowed = value => {
    const origin = String(value || '').toLowerCase();
    if (!isChromeExtensionOrigin(origin)) return false;
    const extensionId = origin.replace(/^chrome-extension:\/\//, '');
    return configuredIds().includes(extensionId);
  };

  const noteClientActivity = (client, kind, {
    saved = 0,
    type = '',
    generation = -1,
  } = {}) => {
    const access = activityConfiguration();
    if (!access.isEnabled || access.generation !== generation
        || !access.ids.includes(client.extensionId)) return false;
    if (!clientActivity.has(client.key)) {
      while (clientActivity.size >= MAX_ACTIVITY_CLIENTS) {
        let oldestKey = '';
        let oldestSeenAt = Infinity;
        for (const [key, item] of clientActivity) {
          if (item.lastSeenAt < oldestSeenAt) {
            oldestKey = key;
            oldestSeenAt = item.lastSeenAt;
          }
        }
        if (!oldestKey) break;
        clientActivity.delete(oldestKey);
      }
    }
    const at = timestamp();
    const previous = clientActivity.get(client.key) || {
      extensionId: client.extensionId,
      harvesterId: client.harvesterId,
      browser: client.browser,
      lastSeenAt: 0,
      lastStatusAt: 0,
      lastSavedAt: 0,
      lastSavedType: '',
      savedCount: 0,
    };
    const next = {
      ...previous,
      browser: client.browser === 'Browser extension' ? previous.browser : client.browser,
      lastSeenAt: at,
    };
    if (kind === 'status') next.lastStatusAt = at;
    if (kind === 'save') {
      next.lastSavedAt = at;
      next.lastSavedType = String(type || '').toLowerCase();
      next.savedCount += Math.max(0, Number(saved) || 0);
    }
    clientActivity.set(client.key, next);
    return true;
  };

  // The legacy client opens a one-request WebSocket rather than holding a connection open. Expose
  // only successful request/save timestamps; callers decide how recent is recent enough for their
  // presentation and never have to mistake the listening socket for a running harvester.
  const activity = () => {
    const { isEnabled, ids } = activityConfiguration();
    // Treat turning the feature off as the end of this activity session. Re-enabling the same
    // extension IDs must wait for fresh evidence instead of reviving a recent pre-disable save.
    if (!isEnabled) clientActivity.clear();
    const clients = [...clientActivity.values()]
      .sort((a, b) => a.browser.localeCompare(b.browser) || a.harvesterId.localeCompare(b.harvesterId))
      .map(client => ({
        id: client.harvesterId,
        browser: client.browser,
        lastSeenAt: client.lastSeenAt,
        lastStatusAt: client.lastStatusAt,
        lastSavedAt: client.lastSavedAt,
        lastSavedType: client.lastSavedType,
        savedCount: client.savedCount,
      }));
    const latestSaved = clients.reduce((latest, client) => (
      client.lastSavedAt >= (latest && latest.lastSavedAt || 0) ? client : latest
    ), null);
    return {
      enabled: isEnabled,
      configured: ids.length > 0,
      authorizedIdCount: ids.length,
      listening: !!listeningAddress,
      lastSeenAt: Math.max(0, ...clients.map(client => client.lastSeenAt)),
      lastStatusAt: Math.max(0, ...clients.map(client => client.lastStatusAt)),
      lastSavedAt: latestSaved ? latestSaved.lastSavedAt : 0,
      lastSavedType: latestSaved ? latestSaved.lastSavedType : '',
      savedCount: clients.reduce((total, client) => total + client.savedCount, 0),
      clientCount: clients.length,
      clients,
    };
  };

  const broker = async (requestPath, method = 'GET', body = null) => {
    try { await ensureBroker(); } catch {}
    let lastError = null;
    // GET /status is safe to retry while a just-spawned broker begins listening. A save is not:
    // the broker may have inserted it before a timeout or reset hid the response.
    const attempts = method === 'GET' ? Math.max(1, Number(brokerAttempts) || 1) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await jsonRequest({
          host: brokerHost,
          port: brokerPort,
          path: requestPath,
          method,
          body,
        });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await delay(brokerRetryMs);
      }
    }
    throw lastError || new Error('Target cookie broker is unavailable');
  };

  const send = (socket, payload) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
  };

  const handleMessage = async (socket, raw) => {
    let message;
    try {
      if (raw.length > MAX_MESSAGE_BYTES) throw new Error('message is too large');
      message = JSON.parse(String(raw));
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('message must be an object');
      }
    } catch {
      try { socket.close(1003, 'invalid message'); } catch {}
      return;
    }

    try {
      const access = activityConfiguration();
      if (!access.isEnabled || !socket.zynExtensionId
        || !access.ids.includes(socket.zynExtensionId)) {
        throw new Error('extension is no longer authorized');
      }
      const client = extensionClientIdentity(message, socket.zynExtensionId);
      if (message.action === 'status') {
        const status = await broker('/status');
        if (!noteClientActivity(client, 'status', { generation: access.generation })) {
          throw new Error('extension activity session changed');
        }
        send(socket, extensionStatus(status));
        return;
      }
      if (message.action === 'save') {
        let configuredTtl = DEFAULT_COOKIE_TTL_MS;
        try { configuredTtl = cookieTtlMs(); } catch {}
        if (typeof saveCookie !== 'function') {
          throw new Error('authenticated cookie-bank save capability is unavailable');
        }
        const cookie = extensionCookie(message, {
          maxTtlMs: configuredTtl,
          harvesterId: client.harvesterId,
        });
        const response = await saveCookie(cookie);
        const saved = Number(response && response.saved) || 0;
        if (!response || response.ok === false || saved < 1) {
          throw new Error('capture was not accepted by the Zyn cookie bank');
        }
        // Once the bank has accepted a non-idempotent capture, always acknowledge it. Withholding
        // success after a settings/reset race would make the extension retry an already-banked
        // cookie. A stale generation suppresses only the new session's activity attribution.
        noteClientActivity(client, 'save', {
          saved,
          type: cookie.type,
          generation: access.generation,
        });
        send(socket, { ok: true, saved });
        return;
      }
      send(socket, { ok: false, error: 'unsupported action' });
    } catch (error) {
      logger.warn?.(`[harvester-extension] ${message.action || 'request'}: ${error.message}`);
      // The extension treats any JSON reply as success. Closing without a reply is how its existing
      // client correctly reports Disconnected or retries a cookie that was not accepted.
      try { socket.close(1011, 'Zyn cookie broker unavailable'); } catch {}
    }
  };

  const rejectUpgrade = (socket, status = '403 Forbidden') => {
    try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); }
    catch { try { socket.destroy(); } catch {} }
  };

  const respondJson = (response, code, payload, origin = '') => {
    const body = JSON.stringify(payload);
    response.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
    });
    response.end(body);
  };

  const start = () => {
    if (server && listeningAddress) return Promise.resolve(listeningAddress);
    if (pendingStart) return pendingStart.promise;

    const nextWebSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    const nextServer = http.createServer((request, response) => {
      const origin = String(request.headers.origin || '').toLowerCase();
      if (!originAllowed(origin) || !available()) {
        respondJson(response, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === 'OPTIONS' && url.pathname === '/proxies') {
        response.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, OPTIONS',
          vary: 'origin',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/proxies') {
        let catalog = { lists: [] };
        let expose = false;
        try { expose = allowProxyImport() === true; } catch {}
        if (expose) {
          try { catalog = getProxyCatalog() || catalog; }
          catch (error) { logger.warn?.(`[harvester-extension] proxy catalog: ${error.message}`); }
        }
        respondJson(response, 200, { groups: localProxyGroups(catalog) }, origin);
        return;
      }
      respondJson(response, 404, { ok: false, error: 'not found' }, origin);
    });

    nextServer.on('upgrade', (request, socket, head) => {
      const origin = String(request.headers.origin || '').toLowerCase();
      let pathname = '';
      try { pathname = new URL(request.url, `http://${host}:${port}`).pathname; } catch {}
      if (pathname !== '/ws') { rejectUpgrade(socket, '404 Not Found'); return; }
      if (!originAllowed(origin) || !available()) { rejectUpgrade(socket); return; }
      nextWebSockets.handleUpgrade(request, socket, head, client => {
        nextWebSockets.emit('connection', client, request);
      });
    });
    nextWebSockets.on('connection', (socket, request) => {
      socket.zynExtensionId = normalizeChromeExtensionId(
        String(request && request.headers && request.headers.origin || '').replace(/^chrome-extension:\/\//, ''),
      );
      let handled = false;
      socket.on('message', raw => {
        if (handled) return;
        handled = true;
        handleMessage(socket, raw);
      });
      socket.on('error', () => {});
    });

    const state = {
      server: nextServer,
      webSockets: nextWebSockets,
      settled: false,
      resolve: null,
      reject: null,
      promise: null,
    };
    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    pendingStart = state;
    server = nextServer;
    webSockets = nextWebSockets;

    const settle = (kind, value) => {
      if (state.settled) return;
      state.settled = true;
      if (pendingStart === state) pendingStart = null;
      state[kind](value);
    };
    const failed = error => {
      if (server === nextServer) {
        server = null;
        webSockets = null;
        listeningAddress = null;
      }
      try { nextWebSockets.close(); } catch {}
      settle('reject', error);
    };
    state.cancel = error => {
      nextServer.removeListener('error', failed);
      settle('reject', error);
    };
    nextServer.once('error', failed);
    nextServer.listen(port, host, () => {
      nextServer.removeListener('error', failed);
      if (server !== nextServer) {
        try { nextWebSockets.close(); } catch {}
        try { nextServer.close(); } catch {}
        settle('reject', new Error('harvester extension bridge stopped before startup completed'));
        return;
      }
      nextServer.on('error', error => logger.warn?.(`[harvester-extension] server: ${error.message}`));
      listeningAddress = nextServer.address();
      settle('resolve', listeningAddress);
    });
    return state.promise;
  };

  const stop = () => new Promise(resolve => {
    const activeServer = server;
    const activeWebSockets = webSockets;
    const activeStart = pendingStart;
    server = null;
    webSockets = null;
    listeningAddress = null;
    pendingStart = null;
    if (activeStart && !activeStart.settled) {
      activeStart.cancel(new Error('harvester extension bridge stopped before startup completed'));
    }
    if (activeWebSockets) {
      for (const client of activeWebSockets.clients) {
        try { client.terminate(); } catch {}
      }
      try { activeWebSockets.close(); } catch {}
    }
    if (!activeServer) { resolve(); return; }
    try { activeServer.close(() => resolve()); }
    catch { resolve(); }
  });

  return Object.freeze({
    start,
    stop,
    address: () => listeningAddress,
    activity,
    resetActivity,
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_BROKER_PORT,
  DEFAULT_COOKIE_TTL_MS,
  REQUIRED_CAPTURED_HEADER_NAMES,
  CAPTURED_HEADER_NAMES,
  isChromeExtensionOrigin,
  normalizeChromeExtensionId,
  normalizeChromeExtensionIds,
  normalizeHarvesterInstanceId,
  normalizeBrowserName,
  extensionClientIdentity,
  extensionStatus,
  extensionCookie,
  localProxyGroups,
  jsonRequest,
  createHarvesterExtensionBridge,
};
