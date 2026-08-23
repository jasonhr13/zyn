'use strict';

const { normalizeTaskTypeAccess } = require('./task-type-access');

const MAX_RECONNECT_MS = 30000;
const HEARTBEAT_MS = 30000;

function wantsQueueRelay(status = {}) {
  const taskTypes = normalizeTaskTypeAccess(status.taskTypes);
  return status.ok === true && (taskTypes.pokemoncenter === true || taskTypes.walmart === true);
}

function createPokemonQueueEvents({
  authority,
  setHealth = () => {},
  publish = () => false,
  onSolverConfig = () => {},
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  scheduleInterval = setInterval,
  cancelInterval = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (!authority || typeof authority.openPokemonQueueEvents !== 'function') {
    throw new Error('Pokémon Center queue event authority is required');
  }
  let enabled = false;
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let lastEventKey = '';
  let health = { configured: false, connected: false, connecting: false };

  const emitHealth = (next = {}) => {
    health = {
      ...health,
      configured: next.configured === true,
      connected: next.connected === true,
      connecting: next.connecting === true,
      lastConnectedAt: Math.max(0, Number(next.lastConnectedAt ?? health.lastConnectedAt) || 0),
      lastMessageAt: Math.max(0, Number(next.lastMessageAt ?? health.lastMessageAt) || 0),
      lastEventAt: Math.max(0, Number(next.lastEventAt ?? health.lastEventAt) || 0),
    };
    try { setHealth({ ...health }); } catch {}
  };

  const clearTimers = () => {
    if (reconnectTimer) cancelTimeout(reconnectTimer);
    if (heartbeatTimer) cancelInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  };

  const detach = ({ terminate = false } = {}) => {
    generation += 1;
    clearTimers();
    const previous = socket;
    socket = null;
    if (!previous) return;
    try {
      if (terminate && typeof previous.terminate === 'function') previous.terminate();
      else previous.close(1000);
    } catch {}
  };

  const scheduleReconnect = () => {
    if (!enabled || reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_MS, 1000 * (2 ** Math.min(5, reconnectAttempt)));
    reconnectAttempt += 1;
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const clearSolverConfig = () => {
    try { onSolverConfig(''); } catch {}
  };

  const handleMessage = (message) => {
    if (message.type === 'pokemon-center-queue-health') {
      emitHealth(message);
      return;
    }
    if (message.type === 'solver-config') {
      try { onSolverConfig(String(message.lucaApiKey || '').trim()); } catch {}
      return;
    }
    if (message.type !== 'pokemon-center-protection') return;
    const kind = String(message.kind || '').toLowerCase();
    if (kind !== 'queue' && kind !== 'captcha') return;
    const detectedAt = Number(message.detectedAt) || now();
    const eventKey = `${kind}:${detectedAt}:${Number(message.sequence) || 0}`;
    if (eventKey === lastEventKey) return;
    lastEventKey = eventKey;
    try { publish({ kind, detectedAt }); } catch {}
  };

  function connect() {
    if (!enabled || socket) return;
    const currentGeneration = ++generation;
    emitHealth({ ...health, connected: false, connecting: true });
    let nextSocket;
    try {
      nextSocket = authority.openPokemonQueueEvents({
        open: () => {
          if (generation !== currentGeneration || socket !== nextSocket) return;
          reconnectAttempt = 0;
          nextSocket.__zynAlive = true;
          emitHealth({ ...health, connected: true, connecting: true, lastConnectedAt: now() });
          heartbeatTimer = scheduleInterval(() => {
            if (!socket || socket !== nextSocket || socket.readyState !== 1) return;
            if (nextSocket.__zynAlive === false) {
              try { nextSocket.terminate(); } catch {}
              return;
            }
            nextSocket.__zynAlive = false;
            try { nextSocket.ping(); } catch { try { nextSocket.terminate(); } catch {} }
          }, HEARTBEAT_MS);
        },
        message: (message) => {
          if (generation === currentGeneration && socket === nextSocket) handleMessage(message);
        },
        close: () => {
          if (generation !== currentGeneration || socket !== nextSocket) return;
          socket = null;
          if (heartbeatTimer) cancelInterval(heartbeatTimer);
          heartbeatTimer = null;
          emitHealth({ ...health, connected: false, connecting: enabled });
          scheduleReconnect();
        },
        error: () => {
          if (generation !== currentGeneration || socket !== nextSocket) return;
          emitHealth({ ...health, connected: false, connecting: enabled });
        },
      });
      socket = nextSocket;
      if (typeof socket.on === 'function') {
        socket.on('pong', () => { if (socket === nextSocket) nextSocket.__zynAlive = true; });
      }
    } catch {
      socket = null;
      emitHealth({ ...health, connected: false, connecting: enabled });
      scheduleReconnect();
    }
  }

  return Object.freeze({
    update(status = {}) {
      const shouldEnable = wantsQueueRelay(status);
      if (enabled === shouldEnable) {
        if (enabled && !socket && !reconnectTimer) connect();
        return;
      }
      enabled = shouldEnable;
      if (!enabled) {
        detach();
        reconnectAttempt = 0;
        emitHealth({ configured: false, connected: false, connecting: false });
        clearSolverConfig();
        return;
      }
      connect();
    },
    dispose() {
      enabled = false;
      detach();
      reconnectAttempt = 0;
      emitHealth({ configured: false, connected: false, connecting: false });
      clearSolverConfig();
    },
    cached: () => ({ ...health }),
  });
}

module.exports = { createPokemonQueueEvents, wantsQueueRelay, HEARTBEAT_MS, MAX_RECONNECT_MS };
