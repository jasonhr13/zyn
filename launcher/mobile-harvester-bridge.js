'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_COOKIE_TTL_MS,
  extensionCookie,
  extensionStatus,
  jsonRequest,
  localProxyGroups,
} = require('./harvester-extension-bridge');
const { remainingHarvestTargets } = require('./harvest-room-demand');

const PAIR_FILE = 'mobile-harvester-pair.json';
const MAX_RECONNECT_MS = 30000;
const HEALTH_MS = 8000;
const PONG_STALE_MS = 25000;
const MAILBOX_PULL_MS = 200;
const MAILBOX_PULL_LIVE_MS = 50;
const MAILBOX_PULL_BATCH = 10;
const MAILBOX_PULL_LIVE_BATCH = 64;
const ANDROID_DOWNLOAD_URL = 'https://updates.zynbot.app/download/android';

function harvesterIdForDevice(deviceId) {
  const digest = crypto.createHash('sha256').update(String(deviceId || 'android')).digest('hex').slice(0, 16);
  return `android-${digest}`;
}

function publicPairing(record) {
  if (!record || !record.roomId) {
    return {
      paired: false,
      roomId: '',
      pairingUrl: '',
      expiresAt: 0,
      downloadUrl: ANDROID_DOWNLOAD_URL,
    };
  }
  return {
    paired: true,
    roomId: String(record.roomId),
    pairingUrl: String(record.pairingUrl || ''),
    expiresAt: Number(record.expiresAt) || 0,
    downloadUrl: ANDROID_DOWNLOAD_URL,
  };
}

function createMobileHarvesterBridge({
  dataDirectory,
  authority,
  enabled = () => true,
  hostRemote = () => false,
  ensureBroker = () => {},
  getCookieBank = async () => ({}),
  getProxyCatalog = () => ({ lists: [] }),
  saveCookie = null,
  takeCookies = null,
  cookieTtlMs = () => DEFAULT_COOKIE_TTL_MS,
  logger = console,
  WebSocketImpl = null,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  clock = Date.now,
} = {}) {
  if (!dataDirectory) throw new Error('mobile harvester dataDirectory is required');
  if (!authority || typeof authority.pairMobileHarvester !== 'function') {
    throw new Error('mobile harvester license authority is required');
  }

  const pairPath = path.join(dataDirectory, PAIR_FILE);
  let pairRecord = null;
  let socket = null;
  let reconnectTimer = null;
  let healthTimer = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let started = false;
  let lastDemandKey = '';
  let demandFlushTimer = null;
  let pullTimer = null;
  let pullInFlight = false;
  let lastPongAt = 0;
  let hostedRoomId = '';
  let mailbox = { login: 0, atc: 0 };
  const activity = {
    connected: false,
    phoneCount: 0,
    companionCount: 0,
    extensionCount: 0,
    lastSeenAt: 0,
    lastSavedAt: 0,
    lastSavedType: '',
    savedCount: 0,
    lastError: '',
  };

  const timestamp = () => {
    try { return Math.max(0, Number(clock()) || 0); }
    catch { return Date.now(); }
  };

  const loadPair = () => {
    if (pairRecord) return pairRecord;
    try {
      const stored = JSON.parse(fs.readFileSync(pairPath, 'utf8'));
      if (stored && stored.roomId && stored.joinToken) pairRecord = stored;
    } catch {}
    return pairRecord;
  };

  const persistPair = (record) => {
    pairRecord = record;
    hostedRoomId = String((record && record.roomId) || hostedRoomId);
    const temporary = `${pairPath}.${process.pid}.tmp`;
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, pairPath);
    fs.chmodSync(pairPath, 0o600);
  };

  const clearPairFile = () => {
    pairRecord = null;
    hostedRoomId = '';
    try { fs.unlinkSync(pairPath); } catch {}
  };

  const settingOn = () => {
    try { return enabled() === true; }
    catch { return false; }
  };

  const remoteHostOn = () => {
    try { return hostRemote() === true; }
    catch { return false; }
  };

  const available = () => {
    try { return (settingOn() || remoteHostOn()) && authority.cached?.().ok === true; }
    catch { return false; }
  };

  const snapshot = () => ({
    ...publicPairing(loadPair()),
    enabled: available(),
    connected: activity.connected === true,
    phoneCount: Math.max(0, Number(activity.phoneCount) || 0),
    companionCount: Math.max(0, Number(activity.companionCount) || 0),
    extensionCount: Math.max(0, Number(activity.extensionCount) || 0),
    lastSeenAt: Number(activity.lastSeenAt) || 0,
    lastSavedAt: Number(activity.lastSavedAt) || 0,
    lastSavedType: String(activity.lastSavedType || ''),
    savedCount: Math.max(0, Number(activity.savedCount) || 0),
    lastError: String(activity.lastError || '').slice(0, 240),
    downloadUrl: ANDROID_DOWNLOAD_URL,
  });

  const send = (payload) => {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const MAX_MOBILE_PROXY_LINES = 1000;

  const catalogLists = () => {
    const groups = localProxyGroups(getProxyCatalog() || { lists: [] });
    const lists = Object.entries(groups).map(([name, lines]) => ({
      name,
      count: Array.isArray(lines) ? lines.length : 0,
    }));
    return { groups, lists };
  };

  const proxyPayload = ({ names = null, includeLines = false } = {}) => {
    const { groups, lists } = catalogLists();
    if (!includeLines) return { type: 'proxies', lists, groups: {} };
    const pick = Array.isArray(names) && names.length
      ? names.map((name) => String(name)).filter((name) => groups[name])
      : Object.keys(groups);
    const capped = {};
    for (const name of pick) {
      capped[name] = groups[name].slice(0, MAX_MOBILE_PROXY_LINES);
    }
    return { type: 'proxies', lists, groups: capped };
  };

  const sendSelectedProxyLists = (names) => {
    const { groups, lists } = catalogLists();
    send({ type: 'proxies', lists, groups: {} });
    const pick = Array.isArray(names) && names.length
      ? names.map((name) => String(name)).filter((name) => groups[name])
      : [];
    for (const name of pick) {
      send({
        type: 'proxies',
        lists,
        groups: { [name]: groups[name].slice(0, MAX_MOBILE_PROXY_LINES) },
      });
    }
  };

  const publishDemand = async ({ force = false } = {}) => {
    try { await ensureBroker(); } catch {}
    let status = {};
    try { status = await getCookieBank(); }
    catch {
      try { status = await jsonRequest({ path: '/status' }); }
      catch { status = {}; }
    }
    const mapped = extensionStatus(status);
    const waitingAtc = Number(mapped.waiting && mapped.waiting.atc) || 0;
    const demand = status && status.demand && typeof status.demand === 'object' ? status.demand : {};
    const demandTargets = demand.targets && typeof demand.targets === 'object' ? demand.targets : {};
    const atcTarget = demandTargets.atc == null
      ? null
      : Number(demandTargets.atc);
    const room = remainingHarvestTargets({
      current: { login: mapped.login, atc: mapped.atc },
      targets: {
        login: Object.prototype.hasOwnProperty.call(demandTargets, 'login') ? demandTargets.login : 0,
        atc: Object.prototype.hasOwnProperty.call(demandTargets, 'atc')
          ? demandTargets.atc
          : (Number.isFinite(atcTarget) ? atcTarget : 0),
      },
    });
    const payload = {
      type: 'demand',
      atc: mapped.atc,
      atcTarget: Number.isFinite(atcTarget) ? atcTarget : waitingAtc,
      waitingAtc,
      login: Number(mapped.login) || 0,
      basis: String(demand.basis || ''),
      activeTasks: Number(demand.activeTasks) || 0,
      standbyTasks: Number(demand.standbyTasks) || 0,
      atcPerTask: demand.atcPerTask == null ? 3 : Number(demand.atcPerTask) || 0,
      loginTasks: Number(demandTargets.login) || 0,
      room,
      demand,
    };
    const paused = payload.basis === 'paused';
    const key = `${payload.atc}:${payload.atcTarget}:${payload.waitingAtc}:${payload.basis}:${payload.activeTasks}:${payload.standbyTasks}:${payload.atcPerTask}:${payload.loginTasks}:${room.login}:${room.atc}`;
    if (!force && key === lastDemandKey && activity.connected) {
      if (paused) send({ type: 'stop', site: 'target' });
      return payload;
    }
    lastDemandKey = key;
    send(payload);
    send(proxyPayload({ includeLines: false }));
    if (paused) send({ type: 'stop', site: 'target' });
    return payload;
  };

  const completeMobileHeaders = (message) => {
    const headers = {};
    const source = message && message.headers && typeof message.headers === 'object' ? message.headers : {};
    for (const [name, value] of Object.entries(source)) {
      const key = String(name || '').toLowerCase();
      const text = String(value == null ? '' : value).trim();
      if (key && text) headers[key] = text;
    }
    if (!headers['user-agent'] && message && message.userAgent) {
      headers['user-agent'] = String(message.userAgent);
    }
    const ua = headers['user-agent'] || '';
    const chrome = ua.match(/Chrome\/(\d+)/);
    const version = chrome ? chrome[1] : '151';
    const isApple = /iPhone|iPad|CPU (iPhone )?OS|Macintosh/.test(ua) && !/Chrome\//.test(ua);
    if (ua && !headers['sec-ch-ua']) {
      headers['sec-ch-ua'] = isApple
        ? '"Not_A Brand";v="99", "Safari";v="18"'
        : `"Chromium";v="${version}", "Not:A-Brand";v="24", "Google Chrome";v="${version}"`;
    }
    if (ua && !headers['sec-ch-ua-platform']) {
      headers['sec-ch-ua-platform'] = isApple ? '"iOS"' : '"Android"';
    }
    if (ua && !headers['sec-ch-ua-mobile']) headers['sec-ch-ua-mobile'] = '?1';
    return headers;
  };

  const handleCapture = async (message) => {
    if (typeof saveCookie !== 'function') throw new Error('authenticated cookie-bank save capability is unavailable');
    try { await ensureBroker(); } catch {}
    let configuredTtl = DEFAULT_COOKIE_TTL_MS;
    try { configuredTtl = cookieTtlMs(); } catch {}
    const remote = String(message && message.source || '').toLowerCase() === 'remote'
      || String(message && message.role || '').toLowerCase() === 'companion';
    const cookie = extensionCookie({
      type: message.cookieType === 'login' ? 'login' : 'atc',
      headers: remote ? (message.headers || {}) : completeMobileHeaders(message),
      proxy: message.proxy,
      expiry: message.expiry || message.expiresAt,
    }, {
      maxTtlMs: configuredTtl,
      harvesterId: remote
        ? String(message.harvesterId || message.deviceId || 'remote').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'remote'
        : harvesterIdForDevice(message.deviceId),
      source: remote ? 'remote' : 'mobile',
    });
    const response = await saveCookie(cookie);
    const saved = Number(response && response.saved) || 0;
    if (!response || response.ok === false || saved < 1) {
      throw new Error('capture was not accepted by the Zyn cookie bank');
    }
    activity.lastSavedAt = timestamp();
    activity.lastSavedType = cookie.type;
    activity.savedCount += saved;
    send({ type: 'capture-ack', ok: true, saved });
    if (!demandFlushTimer) {
      demandFlushTimer = scheduleTimeout(() => {
        demandFlushTimer = null;
        publishDemand({ force: true }).catch(() => {});
      }, 250);
    }
    return saved;
  };

  const takeFromMailbox = async (query) => {
    if (typeof takeCookies === 'function') return takeCookies(query);
    if (typeof authority.takeHarvestCookies === 'function') return authority.takeHarvestCookies(query);
    return { ok: false, cookies: [] };
  };

  const ingestCookies = async (cookies) => {
    if (!Array.isArray(cookies) || !cookies.length || typeof saveCookie !== 'function') return 0;
    try { await ensureBroker(); } catch {}
    const response = await saveCookie(cookies.length === 1 ? cookies[0] : cookies);
    const saved = Number(response && response.saved);
    const count = Number.isFinite(saved) ? saved : (response && response.ok === false ? 0 : cookies.length);
    if (count > 0) {
      activity.lastSavedAt = timestamp();
      activity.lastSavedType = String(cookies[0] && cookies[0].type || 'atc');
      activity.savedCount += count;
    }
    return count;
  };

  const localNeed = async () => {
    let status = {};
    try { status = await getCookieBank(); }
    catch { status = {}; }
    const pools = status && status.pools && typeof status.pools === 'object' ? status.pools : status;
    const demand = status && status.demand && typeof status.demand === 'object' ? status.demand : {};
    const remaining = remainingHarvestTargets({
      current: { login: pools.login, atc: pools.atc },
      targets: demand.targets,
    });
    const waiting = (demand.activity && demand.activity.waiting)
      || (status.activity && status.activity.waiting) || {};
    const live = Number(waiting.atc) > 0;
    const batch = live ? MAILBOX_PULL_LIVE_BATCH : MAILBOX_PULL_BATCH;
    let atc = 0;
    if (remaining.atc === null || live) atc = batch;
    else atc = Math.min(batch, Math.max(0, Number(remaining.atc) || 0));
    return { atc, live };
  };

  const pullMailbox = async () => {
    if (pullInFlight || !remoteHostOn() || !available()) return;
    const need = await localNeed();
    pullInFlight = true;
    try {
      const available = Math.max(0, Number(mailbox.atc) || 0);
      const want = Math.min(need.atc, available, need.live ? MAILBOX_PULL_LIVE_BATCH : MAILBOX_PULL_BATCH);
      if (want > 0) {
        const result = await takeFromMailbox({ type: 'atc', n: want });
        const cookies = Array.isArray(result && result.cookies) ? result.cookies : [];
        if (cookies.length) {
          await ingestCookies(cookies);
          publishDemand({ force: true }).catch(() => {});
        }
        if (result && result.mailbox) {
          mailbox.login = 0;
          mailbox.atc = Number(result.mailbox.atc) || 0;
        } else {
          mailbox.atc = Math.max(0, available - cookies.length);
        }
      }
    } catch (error) {
      activity.lastError = error.message;
      logger.warn?.(`[remote-harvester] mailbox pull: ${error.message}`);
    } finally {
      pullInFlight = false;
      if (mailbox.atc > 0 && remoteHostOn()) {
        schedulePull(need.live ? MAILBOX_PULL_LIVE_MS : MAILBOX_PULL_MS);
      }
    }
  };

  const schedulePull = (delayMs = 50) => {
    if (pullTimer || pullInFlight || !remoteHostOn()) return;
    pullTimer = scheduleTimeout(() => {
      pullTimer = null;
      pullMailbox().catch(() => {});
    }, delayMs);
  };

  const noteMailbox = (message = {}) => {
    mailbox.login = Number(message.login) || 0;
    mailbox.atc = Number(message.atc) || 0;
    if (mailbox.atc > 0 || mailbox.login > 0) schedulePull();
  };

  const handleMessage = async (message) => {
    activity.lastSeenAt = timestamp();
    lastPongAt = timestamp();
    if (message.type === 'pong' || message.type === 'ping') return;
    if (message.type === 'registered' || message.type === 'peer-state') {
      if (message.mailbox) noteMailbox(message.mailbox);
      const previousCompanions = activity.companionCount;
      const previousExtensions = activity.extensionCount;
      activity.connected = true;
      activity.phoneCount = Number(message.phoneCount ?? (message.peer && message.peer.phoneCount)) || activity.phoneCount;
      if (message.peer && typeof message.peer.phoneCount === 'number') {
        activity.phoneCount = message.peer.phoneCount;
      }
      if (typeof message.companionCount === 'number') activity.companionCount = message.companionCount;
      if (message.peer && typeof message.peer.companionCount === 'number') {
        activity.companionCount = message.peer.companionCount;
      }
      if (typeof message.extensionCount === 'number') activity.extensionCount = message.extensionCount;
      if (message.peer && typeof message.peer.extensionCount === 'number') {
        activity.extensionCount = message.peer.extensionCount;
      }
      const companionsJoined = message.type === 'peer-state' && activity.companionCount > previousCompanions;
      const extensionsJoined = message.type === 'peer-state' && activity.extensionCount > previousExtensions;
      const phoneJoined = message.type === 'peer-state' && activity.phoneCount > 0;
      await publishDemand({ force: companionsJoined || extensionsJoined || phoneJoined || message.type === 'registered' });
      return;
    }
    if (message.type === 'hello') {
      await publishDemand({ force: true });
      return;
    }
    if (message.type === 'need-proxies') {
      sendSelectedProxyLists(message.names);
      return;
    }
    if (message.type === 'mailbox') {
      noteMailbox(message);
      return;
    }
    if (message.type === 'capture') {
      return;
    }
  };

  const detach = () => {
    generation += 1;
    if (reconnectTimer) cancelTimeout(reconnectTimer);
    reconnectTimer = null;
    if (demandFlushTimer) cancelTimeout(demandFlushTimer);
    demandFlushTimer = null;
    if (pullTimer) cancelTimeout(pullTimer);
    pullTimer = null;
    const previous = socket;
    socket = null;
    activity.connected = false;
    if (!previous) return;
    try { previous.close(1000); } catch {}
  };

  const ensureDesktopRoom = async () => {
    const existing = loadPair();
    if (typeof authority.ensureHarvestRoom !== 'function') return existing;
    const result = await authority.ensureHarvestRoom();
    if (!result || result.ok !== true || !result.roomId) {
      activity.lastError = String(result && result.message || 'Could not host a harvest room.');
      logger.warn?.(`[remote-harvester] host room: ${activity.lastError}`);
      return existing;
    }
    persistPair({
      roomId: result.roomId,
      joinToken: existing && existing.joinToken || '',
      pairingUrl: existing && existing.pairingUrl || '',
      expiresAt: Number(result.expiresAt) || 0,
    });
    hostedRoomId = String(result.roomId);
    logger.info?.(`[remote-harvester] hosting room ${result.roomId}`);
    return loadPair();
  };

  const connect = () => {
    if (!started || (!settingOn() && !remoteHostOn())) return;
    if (!available()) {
      scheduleReconnect();
      return;
    }
    const record = loadPair();
    if (!record || !record.roomId) {
      if (remoteHostOn()) {
        ensureDesktopRoom().then(() => {
          if (started) connect();
        }).catch((error) => {
          activity.lastError = error.message;
          scheduleReconnect();
        });
      }
      return;
    }
    detach();
    const current = generation;
    let nextSocket;
    try {
      nextSocket = authority.openMobileHarvesterEvents(record.roomId, {
        open: () => {
          if (current !== generation) return;
          reconnectAttempt = 0;
          activity.connected = true;
          activity.lastError = '';
          lastPongAt = timestamp();
          hostedRoomId = String(record.roomId || hostedRoomId);
          send({ type: 'hello', role: 'desktop' });
          publishDemand({ force: true }).catch(() => {});
        },
        close: () => {
          if (current !== generation) return;
          activity.connected = false;
          scheduleReconnect();
        },
        error: () => {
          if (current !== generation) return;
          activity.connected = false;
        },
        message: (message) => {
          if (current !== generation) return;
          handleMessage(message).catch((error) => {
            logger.warn?.(`[mobile-harvester] ${error.message}`);
          });
        },
      });
    } catch (error) {
      activity.lastError = error.message;
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    if (WebSocketImpl && nextSocket) socket = nextSocket;
  };

  const scheduleReconnect = () => {
    if (!started || (!settingOn() && !remoteHostOn()) || reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_MS, 1000 * (2 ** Math.min(5, reconnectAttempt)));
    reconnectAttempt += 1;
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const healthOnce = async () => {
    if (!started || (!settingOn() && !remoteHostOn())) return;
    if (!available()) {
      scheduleReconnect();
      return;
    }
    const now = timestamp();
    const socketLive = socket && socket.readyState === 1 && activity.connected;
    if (socketLive) send({ type: 'ping' });
    if (socketLive && lastPongAt && now - lastPongAt > PONG_STALE_MS) {
      activity.lastError = 'Harvest room went silent. Reconnecting.';
      logger.warn?.(`[remote-harvester] ${activity.lastError}`);
      connect();
      return;
    }
    if (remoteHostOn()) {
      const previousId = hostedRoomId || (loadPair() && loadPair().roomId) || '';
      try {
        const record = await ensureDesktopRoom();
        const nextId = String((record && record.roomId) || '');
        if (nextId && nextId === previousId && socketLive) {
          await publishDemand({ force: true });
          return;
        }
        connect();
      } catch (error) {
        activity.lastError = error.message;
        scheduleReconnect();
      }
      return;
    }
    if (!socketLive) connect();
  };

  const scheduleHealth = () => {
    if (healthTimer) return;
    healthTimer = scheduleTimeout(() => {
      healthTimer = null;
      if (!started) return;
      healthOnce().catch((error) => {
        activity.lastError = error.message;
      }).finally(() => {
        if (started) scheduleHealth();
      });
    }, HEALTH_MS);
  };

  return {
    ANDROID_DOWNLOAD_URL,
    snapshot,
    activity: () => ({
      connected: activity.connected === true,
      phoneCount: activity.phoneCount,
      companionCount: activity.companionCount,
      extensionCount: activity.extensionCount,
      lastSeenAt: activity.lastSeenAt,
      lastSavedAt: activity.lastSavedAt,
      lastSavedType: activity.lastSavedType,
      savedCount: activity.savedCount,
    }),
    async pair() {
      const existing = loadPair();
      const stillGood = existing
        && existing.roomId
        && existing.joinToken
        && existing.pairingUrl
        && (!Number(existing.expiresAt) || Number(existing.expiresAt) > timestamp());
      if (stillGood) {
        if (started) connect();
        return { ok: true, reused: true, ...snapshot() };
      }
      const result = await authority.pairMobileHarvester();
      if (!result || result.ok !== true || !result.roomId || !result.joinToken) {
        return { ok: false, message: String(result && result.message || 'Could not create a pairing code.') };
      }
      persistPair({
        roomId: result.roomId,
        joinToken: result.joinToken,
        pairingUrl: result.pairingUrl,
        expiresAt: result.expiresAt,
      });
      hostedRoomId = String(result.roomId);
      if (started) connect();
      return { ok: true, ...snapshot() };
    },
    async reset() {
      try { await authority.resetMobileHarvester(); } catch {}
      detach();
      clearPairFile();
      lastDemandKey = '';
      return { ok: true, ...snapshot() };
    },
    start() {
      started = true;
      loadPair();
      if (remoteHostOn()) {
        ensureDesktopRoom().then(() => connect()).catch((error) => {
          activity.lastError = error.message;
          logger.warn?.(`[remote-harvester] host start: ${error.message}`);
          scheduleReconnect();
        });
      } else {
        connect();
      }
      scheduleHealth();
      return snapshot();
    },
    async reconnect() {
      started = true;
      lastDemandKey = '';
      activity.lastError = '';
      reconnectAttempt = 0;
      detach();
      try {
        if (remoteHostOn()) await ensureDesktopRoom();
      } catch (error) {
        activity.lastError = error.message;
      }
      connect();
      scheduleHealth();
      return snapshot();
    },
    stop() {
      started = false;
      if (healthTimer) cancelTimeout(healthTimer);
      healthTimer = null;
      detach();
    },
    update() {
      if (!started) return snapshot();
      if (!settingOn() && !remoteHostOn()) {
        detach();
        return snapshot();
      }
      if (!available()) {
        detach();
        scheduleReconnect();
        return snapshot();
      }
      if (remoteHostOn() && !socket) {
        ensureDesktopRoom().then(() => connect()).catch((error) => {
          activity.lastError = error.message;
          scheduleReconnect();
        });
        return snapshot();
      }
      if (!socket) connect();
      else publishDemand().catch(() => {});
      return snapshot();
    },
    __test: {
      handleCapture,
      handleMessage,
      proxyPayload,
      sendSelectedProxyLists,
      publishDemand,
      healthOnce,
      pullMailbox,
      noteMailbox,
      harvesterIdForDevice,
      setSocket(next) {
        socket = next;
        started = true;
        activity.connected = true;
        lastPongAt = timestamp();
      },
    },
  };
}

module.exports = {
  ANDROID_DOWNLOAD_URL,
  HEALTH_MS,
  createMobileHarvesterBridge,
  harvesterIdForDevice,
  publicPairing,
};
