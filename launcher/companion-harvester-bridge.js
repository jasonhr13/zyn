'use strict';

const os = require('os');
const { hasHarvestRoom, remainingHarvestTargets } = require('./harvest-room-demand');

const MAX_RECONNECT_MS = 30000;
const DRAIN_MS = 50;
const DRAIN_BATCH = 12;
const SEND_RATE_WINDOW_MS = 2000;
const ROOM_POLL_MS = 4000;
const ENGINE_MISSING_MS = 12000;
const ENGINE_STALE_MS = 20000;
const PONG_STALE_MS = 25000;

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
  let lastPongAt = 0;
  const activity = {
    socketOpen: false,
    engineOnline: false,
    roomId: '',
    lastSeenAt: 0,
    lastSentAt: 0,
    socketOpenedAt: 0,
    sentCount: 0,
    lastError: '',
  };
  let sendMarks = [];
  // Fail closed until Full Engine publishes remaining room. Copying the absolute bank target
  // (16×20=320) onto an empty local pool is what kept remote ATC workers minting after the cap.
  let harvestRoom = { login: 0, atc: 0 };

  const timestamp = () => {
    try { return Math.max(0, Number(clock()) || 0); }
    catch { return Date.now(); }
  };

  const available = () => {
    try { return enabled() === true && authority.cached?.().ok === true; }
    catch { return false; }
  };

  const linked = () => activity.socketOpen === true && activity.engineOnline === true;

  const send = (payload) => {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const parkDemand = () => {
    harvestRoom = { login: 0, atc: 0 };
    activity.engineOnline = false;
    if (typeof applyDemand === 'function') applyDemand(null);
  };

  const applyRemoteDemand = (message) => {
    if (!message || message.type === 'stop') {
      harvestRoom = { login: 0, atc: 0 };
      if (typeof applyDemand === 'function') applyDemand(null);
      return;
    }
    const nested = message.demand && typeof message.demand === 'object' ? message.demand : null;
    const demand = nested && (nested.basis || nested.targets || nested.activeTasks || nested.standbyTasks)
      ? nested
      : message;
    const atcPerTask = demand.atcPerTask == null ? 3 : Number(demand.atcPerTask) || 0;
    const activeTasks = Number(demand.activeTasks) || 0;
    const standbyTasks = Number(demand.standbyTasks) || 0;
    const absoluteTargets = demand.targets && typeof demand.targets === 'object'
      ? demand.targets
      : {
        login: Number(demand.loginTasks || demand.login) || 0,
        atc: atcPerTask === 0 && (activeTasks || standbyTasks)
          ? null
          : Number(demand.atcTarget != null ? demand.atcTarget : 0) || 0,
      };
    const room = message.room && typeof message.room === 'object'
      ? remainingHarvestTargets({ current: {}, targets: message.room })
      : remainingHarvestTargets({
        current: { login: message.login, atc: message.atc },
        targets: absoluteTargets,
      });
    harvestRoom = room;
    activity.engineOnline = true;
    activity.lastError = '';
    if (typeof applyDemand !== 'function') return;
    applyDemand({
      mode: 'per-task',
      basis: String(demand.basis || (activeTasks > 0 ? 'active' : 'standby')),
      activeTasks,
      standbyTasks,
      atcPerTask,
      loginTasks: Number(demand.loginTasks) || 0,
      targets: room,
    });
  };

  const noteSend = () => {
    const now = timestamp();
    sendMarks.push(now);
    const cutoff = now - SEND_RATE_WINDOW_MS;
    if (sendMarks.length > 400 || sendMarks[0] <= cutoff) {
      sendMarks = sendMarks.filter(mark => mark > cutoff);
    }
  };

  const sendRate = () => {
    const now = timestamp();
    const cutoff = now - SEND_RATE_WINDOW_MS;
    sendMarks = sendMarks.filter(mark => mark > cutoff);
    return sendMarks.length / (SEND_RATE_WINDOW_MS / 1000);
  };

  const drainType = async (type) => {
    if (!linked() || !hasHarvestRoom(harvestRoom, type)) return 0;
    let forwarded = 0;
    for (let index = 0; index < DRAIN_BATCH; index += 1) {
      if (!socket || socket.readyState !== 1) {
        activity.lastError = 'harvest room is not connected';
        break;
      }
      let cookie;
      try { cookie = await takeCookie(type); }
      catch { cookie = null; }
      if (!cookie || !cookie.headers) break;
      if (!String(cookie.proxy || '').trim()) {
        logger.warn?.('[remote-harvester] sending cookie without a harvest proxy — checkout must use the same egress');
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
      if (!sent) {
        activity.lastError = 'harvest room is not connected';
        break;
      }
      activity.lastSentAt = timestamp();
      activity.sentCount += 1;
      activity.lastError = '';
      noteSend();
      forwarded += 1;
    }
    return forwarded;
  };

  const drainOnce = async () => {
    if (typeof takeCookie !== 'function') return;
    await drainType('atc');
    await drainType('login');
  };

  const scheduleDrain = () => {
    if (!started || drainTimer) return;
    drainTimer = scheduleTimeout(() => {
      drainTimer = null;
      drainOnce().catch((error) => {
        activity.lastError = error.message;
      }).finally(() => {
        if (started && activity.socketOpen) scheduleDrain();
      });
    }, DRAIN_MS);
  };

  const markAlive = (engine = false) => {
    const now = timestamp();
    activity.lastSeenAt = now;
    lastPongAt = now;
    if (engine) {
      activity.engineOnline = true;
      if (activity.lastError === 'Waiting for Full Engine to join the harvest room.') {
        activity.lastError = '';
      }
    }
  };

  const handleMessage = (message) => {
    markAlive(false);
    if (message.type === 'pong') return;
    if (message.type === 'registered' || message.type === 'peer-state') {
      activity.socketOpen = true;
      const desktop = message.desktopOnline === true
        || (message.peer && message.peer.desktopOnline === true);
      activity.engineOnline = desktop;
      if (!desktop) {
        harvestRoom = { login: 0, atc: 0 };
        if (typeof applyDemand === 'function') applyDemand(null);
        activity.lastError = 'Waiting for Full Engine to join the harvest room.';
      }
      return;
    }
    if (message.type === 'hello') {
      activity.engineOnline = true;
      activity.lastError = '';
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
    activity.socketOpen = false;
    parkDemand();
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
            activity.socketOpen = true;
            activity.socketOpenedAt = timestamp();
            lastPongAt = timestamp();
            activity.lastError = 'Waiting for Full Engine to join the harvest room.';
            activity.roomId = room;
            try {
              nextSocket.send(JSON.stringify({
                type: 'hello',
                role: 'companion',
                hostname: os.hostname().slice(0, 100),
              }));
            } catch {}
            logger.info?.(`[remote-harvester] joined room ${room}`);
            scheduleDrain();
          },
          close: () => {
            if (current !== generation) return;
            activity.socketOpen = false;
            parkDemand();
            scheduleReconnect();
          },
          error: () => {
            if (current !== generation) return;
            activity.socketOpen = false;
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
        if (!activity.lastError) activity.lastError = '';
        connect(roomId);
        return;
      }
      activity.lastError = String(result && result.message || 'Waiting for a Full Engine Zyn.');
      logger.warn?.(`[remote-harvester] ${activity.lastError}`);
      scheduleReconnect();
    }).catch((error) => {
      activity.lastError = error.message;
      scheduleReconnect();
    });
  };

  const healthOnce = async () => {
    if (!started || !available()) return;
    const now = timestamp();
    if (activity.socketOpen && socket && socket.readyState === 1) {
      send({ type: 'ping' });
      if (lastPongAt && now - lastPongAt > PONG_STALE_MS) {
        activity.lastError = 'Harvest room went silent. Reconnecting.';
        connect(roomId);
        return;
      }
      if (activity.engineOnline && activity.lastSeenAt && now - activity.lastSeenAt > ENGINE_STALE_MS) {
        activity.lastError = 'Full Engine went silent. Reconnecting.';
        connect(roomId);
        return;
      }
    }
    let result;
    try { result = await authority.getHarvestRoom(); }
    catch (error) {
      if (!activity.socketOpen) {
        activity.lastError = error.message;
        scheduleReconnect();
      }
      return;
    }
    if (!started) return;
    if (result && result.ok === true && result.roomId) {
      const nextId = String(result.roomId);
      const sameRoom = nextId === roomId;
      const socketLive = activity.socketOpen && socket && socket.readyState === 1;
      activity.roomId = nextId;
      if (!sameRoom) {
        roomId = nextId;
        connect(nextId);
        return;
      }
      if (!socketLive) {
        roomId = nextId;
        connect(nextId);
        return;
      }
      if (!activity.engineOnline && activity.socketOpenedAt
        && now - activity.socketOpenedAt >= ENGINE_MISSING_MS) {
        connect(nextId);
      }
      return;
    }
    if (!activity.engineOnline) {
      activity.lastError = String(result && result.message || 'Waiting for a Full Engine Zyn.');
      if (!activity.socketOpen) scheduleReconnect();
    }
  };

  const scheduleRoomPoll = () => {
    if (roomTimer) return;
    roomTimer = scheduleTimeout(() => {
      roomTimer = null;
      if (!started) return;
      Promise.resolve(healthOnce()).catch((error) => {
        activity.lastError = error.message;
      }).finally(() => {
        if (started) scheduleRoomPoll();
      });
    }, ROOM_POLL_MS);
  };

  const snapshot = () => ({
    role: 'companion',
    enabled: available(),
    connected: linked(),
    socketOpen: activity.socketOpen === true,
    engineOnline: activity.engineOnline === true,
    roomId: activity.roomId,
    lastSeenAt: activity.lastSeenAt,
    lastSentAt: activity.lastSentAt,
    sentCount: activity.sentCount,
    sendRate: sendRate(),
    lastError: String(activity.lastError || '').slice(0, 240),
  });

  return {
    snapshot,
    __test: {
      drainOnce,
      applyRemoteDemand,
      handleMessage,
      healthOnce,
      harvestRoom: () => ({ ...harvestRoom }),
      DRAIN_MS,
      DRAIN_BATCH,
      ENGINE_MISSING_MS,
      setSocket(next) {
        socket = next;
        started = true;
        activity.socketOpen = true;
        activity.socketOpenedAt = timestamp();
        lastPongAt = timestamp();
      },
    },
    start() {
      if (started) {
        if (!activity.socketOpen) lookupRoom();
        return snapshot();
      }
      started = true;
      lookupRoom();
      scheduleRoomPoll();
      return snapshot();
    },
    reconnect() {
      if (!started) return this.start();
      activity.lastError = '';
      reconnectAttempt = 0;
      lookupRoom();
      return snapshot();
    },
    stop() {
      started = false;
      if (roomTimer) cancelTimeout(roomTimer);
      roomTimer = null;
      detach();
    },
    update() {
      if (!started) return snapshot();
      if (!available()) {
        detach();
        return snapshot();
      }
      if (!socket) lookupRoom();
      return snapshot();
    },
  };
}

module.exports = {
  createCompanionHarvesterBridge,
  DRAIN_MS,
  DRAIN_BATCH,
  ROOM_POLL_MS,
  ENGINE_MISSING_MS,
  remainingHarvestTargets,
  hasHarvestRoom,
};
