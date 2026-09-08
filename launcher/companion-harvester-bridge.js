'use strict';

const os = require('os');
const { hasHarvestRoom, remainingHarvestTargets } = require('./harvest-room-demand');

const MAX_RECONNECT_MS = 30000;
const DRAIN_MS = 50;
const DRAIN_BATCH = 12;
const SEND_RATE_WINDOW_MS = 2000;
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
    if (!hasHarvestRoom(harvestRoom, type)) return 0;
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
        if (started && activity.connected) scheduleDrain();
      });
    }, DRAIN_MS);
  };

  const handleMessage = (message) => {
    activity.lastSeenAt = timestamp();
    if (message.type === 'registered' || message.type === 'peer-state' || message.type === 'hello') {
      activity.connected = true;
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
            send({ type: 'hello', role: 'companion', hostname: os.hostname().slice(0, 100) });
            logger.info?.(`[remote-harvester] joined room ${room}`);
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
      logger.warn?.(`[remote-harvester] ${activity.lastError}`);
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
      role: 'companion',
      enabled: available(),
      connected: activity.connected === true,
      roomId: activity.roomId,
      lastSeenAt: activity.lastSeenAt,
      lastSentAt: activity.lastSentAt,
      sentCount: activity.sentCount,
      sendRate: sendRate(),
      lastError: String(activity.lastError || '').slice(0, 240),
    }),
    __test: {
      drainOnce,
      applyRemoteDemand,
      harvestRoom: () => ({ ...harvestRoom }),
      DRAIN_MS,
      DRAIN_BATCH,
      setSocket(next) {
        socket = next;
        started = true;
        activity.connected = true;
      },
    },
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

module.exports = {
  createCompanionHarvesterBridge,
  DRAIN_MS,
  DRAIN_BATCH,
  remainingHarvestTargets,
  hasHarvestRoom,
};
