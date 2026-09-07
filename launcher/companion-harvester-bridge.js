'use strict';

const os = require('os');

const MAX_RECONNECT_MS = 30000;
const DRAIN_MS = 750;
const ROOM_POLL_MS = 4000;

function createCompanionHarvesterBridge({
  authority,
  ensureBroker = () => {},
  takeCookie = null,
  applyDemand = null,
  cookieTtlMs = () => 10 * 60 * 1000,
  enabled = () => true,
  logger = console,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  clock = Date.now,
} = {}) {
  if (!authority || typeof authority.getHarvestRoom !== 'function') {
    throw new Error('companion harvester license authority is required');
  }

  let socket = null;
  let reconnectTimer = null;
  let drainTimer = null;
  let roomTimer = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let started = false;
  let roomId = '';
  const activity = {
    connected: false,
    roomId: '',
    lastSeenAt: 0,
    lastSentAt: 0,
    sentCount: 0,
    lastError: '',
  };

  const timestamp = () => {
    try { return Math.max(0, Number(clock()) || 0); }
    catch { return Date.now(); }
  };

  const available = () => {
    try { return enabled() === true && authority.cached?.().ok === true; }
    catch { return false; }
  };

  const send = (payload) => {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const applyRemoteDemand = (message) => {
    if (typeof applyDemand !== 'function') return;
    if (!message || message.type === 'stop') {
      applyDemand(null);
      return;
    }
    const demand = message.demand && typeof message.demand === 'object' ? message.demand : message;
    applyDemand({
      mode: 'per-task',
      basis: String(demand.basis || (Number(demand.activeTasks) > 0 ? 'active' : 'standby')),
      activeTasks: Number(demand.activeTasks) || 0,
      standbyTasks: Number(demand.standbyTasks) || 0,
      atcPerTask: demand.atcPerTask == null ? 3 : Number(demand.atcPerTask) || 0,
      loginTasks: Number(demand.loginTasks) || 0,
      targets: demand.targets && typeof demand.targets === 'object'
        ? demand.targets
        : {
          login: Number(demand.loginTasks || demand.login) || 0,
          atc: demand.atcPerTask === 0 && (Number(demand.activeTasks) || Number(demand.standbyTasks))
            ? null
            : Number(demand.atcTarget != null ? demand.atcTarget : demand.atc) || 0,
        },
    });
  };

  const drainOnce = async () => {
    if (typeof takeCookie !== 'function') return;
    try { await ensureBroker(); } catch {}
    for (const type of ['atc', 'login']) {
      let cookie;
      try { cookie = await takeCookie(type); }
      catch { cookie = null; }
      if (!cookie || !cookie.headers) continue;
      if (!String(cookie.proxy || '').trim()) {
        activity.lastError = 'local harvest cookie had no proxy; not sending';
        continue;
      }
      const sent = send({
        type: 'capture',
        cookieType: type,
        source: 'remote',
        role: 'companion',
        headers: cookie.headers,
        proxy: cookie.proxy,
        expiresAt: cookie.expiresAt,
        harvesterId: cookie.harvesterId || os.hostname().slice(0, 64),
        deviceId: cookie.harvesterId || os.hostname().slice(0, 64),
      });
      if (sent) {
        activity.lastSentAt = timestamp();
        activity.sentCount += 1;
      }
    }
  };

  const scheduleDrain = () => {
    if (!started || drainTimer) return;
    drainTimer = scheduleTimeout(() => {
      drainTimer = null;
      drainOnce().catch((error) => {
        activity.lastError = error.message;
      }).finally(() => {
        if (started && activity.connected) scheduleDrain();
      });
    }, DRAIN_MS);
  };

  const handleMessage = (message) => {
    activity.lastSeenAt = timestamp();
    if (message.type === 'registered' || message.type === 'peer-state' || message.type === 'hello') {
      activity.connected = true;
      send({ type: 'hello', role: 'companion', hostname: os.hostname().slice(0, 100) });
      return;
    }
    if (message.type === 'demand' || message.type === 'start') {
      applyRemoteDemand(message);
      return;
    }
    if (message.type === 'stop') {
      applyRemoteDemand(null);
    }
  };

  const detach = () => {
    generation += 1;
    if (reconnectTimer) cancelTimeout(reconnectTimer);
    reconnectTimer = null;
    if (drainTimer) cancelTimeout(drainTimer);
    drainTimer = null;
    const previous = socket;
    socket = null;
    activity.connected = false;
    try { applyDemand?.(null); } catch {}
    if (!previous) return;
    try { previous.close(1000); } catch {}
  };

  const connect = (nextRoomId) => {
    if (!started || !available()) return;
    const room = String(nextRoomId || roomId || '');
    if (!room) return;
    detach();
    const current = generation;
    let nextSocket;
    try {
      nextSocket = authority.openHarvestRoomEvents(room, {
        role: 'companion',
        handlers: {
          open: () => {
            if (current !== generation) return;
            reconnectAttempt = 0;
            activity.connected = true;
            activity.lastError = '';
            activity.roomId = room;
            send({ type: 'hello', role: 'companion' });
            scheduleDrain();
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
            handleMessage(message);
          },
        },
      });
    } catch (error) {
      activity.lastError = error.message;
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
  };

  const scheduleReconnect = () => {
    if (!started || !available() || reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_MS, 1000 * (2 ** Math.min(5, reconnectAttempt)));
    reconnectAttempt += 1;
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      lookupRoom();
    }, delay);
  };

  const lookupRoom = () => {
    if (!started || !available()) return;
    authority.getHarvestRoom().then((result) => {
      if (!started) return;
      if (result && result.ok === true && result.roomId) {
        roomId = result.roomId;
        activity.roomId = roomId;
        activity.lastError = '';
        connect(roomId);
        return;
      }
      activity.lastError = String(result && result.message || 'Waiting for a Full Engine Zyn.');
      scheduleReconnect();
    }).catch((error) => {
      activity.lastError = error.message;
      scheduleReconnect();
    });
  };

  const scheduleRoomPoll = () => {
    if (roomTimer) return;
    roomTimer = scheduleTimeout(() => {
      roomTimer = null;
      if (started && available() && !activity.connected) lookupRoom();
      if (started) scheduleRoomPoll();
    }, ROOM_POLL_MS);
  };

  return {
    snapshot: () => ({
      enabled: available(),
      connected: activity.connected === true,
      roomId: activity.roomId,
      lastSeenAt: activity.lastSeenAt,
      lastSentAt: activity.lastSentAt,
      sentCount: activity.sentCount,
      lastError: String(activity.lastError || '').slice(0, 240),
    }),
    start() {
      if (started) {
        if (!activity.connected) lookupRoom();
        return this.snapshot();
      }
      started = true;
      lookupRoom();
      scheduleRoomPoll();
      return this.snapshot();
    },
    stop() {
      started = false;
      if (roomTimer) cancelTimeout(roomTimer);
      roomTimer = null;
      detach();
    },
    update() {
      if (!started) return this.snapshot();
      if (!available()) {
        detach();
        return this.snapshot();
      }
      if (!socket) lookupRoom();
      return this.snapshot();
    },
  };
}

module.exports = { createCompanionHarvesterBridge };
