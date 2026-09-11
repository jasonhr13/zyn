(() => {
  'use strict';

  const LOCAL_BRIDGE = 'ws://127.0.0.1:4312/ws';
  const STORAGE_KEY = 'zynHarvesterRemotePairing';
  const SESSION_KEY = 'zynHarvesterLicenseSession';
  const LICENSE_ORIGIN = 'https://license.zynbot.app';
  const ROOM_ID_PATTERN = /^zynm_[A-Za-z0-9_-]{16,64}$/;
  const REQUEST_TIMEOUT_MS = 8000;

  function licenseDeviceId(clientId) {
    return String(clientId || '').replace(/-/g, '').toLowerCase();
  }

  function parsePairingInput(value) {
    const text = String(value || '').trim().replace(/^['"]+|['"]+$/g, '');
    if (!text) return null;
    const embedded = text.match(/zyn:\/\/[^\s"'<>]+/i);
    const candidate = embedded ? embedded[0] : text;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'zyn:') return null;
      const roomId = url.searchParams.get('room') || '';
      const joinToken = url.searchParams.get('token') || '';
      const origin = url.searchParams.get('origin') || 'https://license.zynbot.app';
      if (!ROOM_ID_PATTERN.test(roomId) || joinToken.length < 16) return null;
      return { roomId, joinToken, origin };
    } catch {
      return null;
    }
  }

  function captureUrl({ origin, roomId, joinToken, sessionToken, deviceId }) {
    const url = new URL('/api/harvester/capture', origin || LICENSE_ORIGIN);
    if (!sessionToken) {
      url.searchParams.set('room', roomId);
      url.searchParams.set('token', joinToken);
      url.searchParams.set('deviceId', deviceId || 'extension');
    }
    return url.toString();
  }

  async function postCapture(connection, payload) {
    const headers = { 'content-type': 'application/json' };
    if (connection && connection.sessionToken) {
      headers.authorization = `Bearer ${connection.sessionToken}`;
      headers['x-rcart-device-id'] = connection.deviceId || connection.sessionDeviceId || 'extension';
    }
    const response = await fetch(captureUrl(connection), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && body && body.ok !== true) {
      const error = new Error(body.message || 'Capture was not accepted.');
      error.body = body;
      throw error;
    }
    return body;
  }

  function websocketUrl({ origin, roomId, joinToken, sessionToken, deviceId }) {
    const url = new URL('/api/mobile/ws', origin || LICENSE_ORIGIN);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.searchParams.set('room', roomId);
    url.searchParams.set('role', 'extension');
    url.searchParams.set('deviceId', deviceId);
    if (sessionToken) url.searchParams.set('session', sessionToken);
    else url.searchParams.set('token', joinToken);
    return url.toString();
  }

  function parseSessionRecord(value) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!record) return null;
    const token = String(record.token || '').trim();
    const deviceId = licenseDeviceId(record.deviceId);
    const origin = String(record.origin || LICENSE_ORIGIN).replace(/\/+$/, '') || LICENSE_ORIGIN;
    const email = String(record.email || '').trim();
    if (token.length < 16 || deviceId.length < 16) return null;
    return { token, deviceId, origin, email, expiresAt: Number(record.expiresAt) || 0 };
  }

  async function fetchHarvestRoom(session) {
    const response = await fetch(`${session.origin}/api/harvester/room`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${session.token}`,
        'x-rcart-device-id': session.deviceId,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body || body.ok !== true || !ROOM_ID_PATTERN.test(body.roomId || '')) {
      const error = new Error(body.message || 'No Full Engine harvest room is online.');
      error.code = body.code || 'room_not_found';
      throw error;
    }
    return { roomId: body.roomId, origin: session.origin };
  }

  function remainingOf(value) {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function statusFromDemand(message = {}) {
    if (!message || (message.atc == null && message.atcTarget == null && !message.room && !message.mailbox && !message.remaining)) {
      return { login: 0, atc: 0, runningTasks: 0, waiting: { login: 0, atc: 1 } };
    }
    const room = message.room && typeof message.room === 'object' ? message.room : {};
    const mailbox = (message.mailbox && message.mailbox.remaining)
      || message.mailboxRemaining
      || message.remaining
      || {};
    const atc = Math.max(0, Number(message.atc) || 0);
    const login = Math.max(0, Number(message.login) || 0);
    let remainingAtc = Object.prototype.hasOwnProperty.call(room, 'atc')
      ? remainingOf(room.atc)
      : remainingOf(message.atcTarget != null ? Number(message.atcTarget) - atc : message.waitingAtc);
    if (Object.prototype.hasOwnProperty.call(mailbox, 'atc')) {
      const mailboxAtc = remainingOf(mailbox.atc);
      if (mailboxAtc === 0) remainingAtc = 0;
      else if (remainingAtc !== null && mailboxAtc !== null) remainingAtc = Math.min(remainingAtc, mailboxAtc);
    }
    const waitingAtc = remainingAtc === null ? 1 : remainingAtc;
    return {
      login,
      atc,
      runningTasks: 0,
      waiting: { login: 0, atc: waitingAtc },
    };
  }

  function captureFromSave(message = {}, deviceId = '') {
    const type = String(message.type || message.cookieType || '').toLowerCase() === 'login'
      ? 'login' : 'atc';
    return {
      type: 'capture',
      cookieType: type,
      source: 'remote',
      role: 'extension',
      headers: message.headers && typeof message.headers === 'object' ? message.headers : {},
      proxy: String(message.proxy || ''),
      expiresAt: Number(message.expiry || message.expiresAt) || 0,
      harvesterId: String(message.clientId || deviceId || 'extension').replace(/[^a-z0-9_-]/gi, '').slice(0, 64),
      deviceId: String(deviceId || message.clientId || 'extension').slice(0, 128),
    };
  }

  function proxyGroupsFromMessage(message = {}) {
    const groups = {};
    const source = message.groups && typeof message.groups === 'object' ? message.groups : {};
    for (const [name, lines] of Object.entries(source)) {
      if (!Array.isArray(lines) || !lines.length) continue;
      groups[String(name)] = lines.map(line => String(line || '').trim()).filter(Boolean);
    }
    return { groups };
  }

  globalThis.zynRemoteHarvest = {
    LOCAL_BRIDGE,
    STORAGE_KEY,
    SESSION_KEY,
    LICENSE_ORIGIN,
    licenseDeviceId,
    parsePairingInput,
    parseSessionRecord,
    websocketUrl,
    fetchHarvestRoom,
    statusFromDemand,
    captureFromSave,
    captureUrl,
    postCapture,
    proxyGroupsFromMessage,
  };

  const NativeWebSocket = typeof WebSocket === 'function' ? WebSocket : null;
  if (!NativeWebSocket) return;

  let cachedPairing = undefined;
  const storage = globalThis.chrome && chrome.storage && chrome.storage.local;

  function connectionFromStore(result) {
    const session = parseSessionRecord(result && result[SESSION_KEY]);
    if (session) return { ...session, sessionToken: session.token };
    return parsePairingInput(result && result[STORAGE_KEY]);
  }

  function readPairing() {
    if (cachedPairing !== undefined) return Promise.resolve(cachedPairing);
    if (!storage || typeof storage.get !== 'function') {
      cachedPairing = null;
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      try {
        storage.get([STORAGE_KEY, SESSION_KEY], result => {
          cachedPairing = connectionFromStore(result);
          resolve(cachedPairing);
        });
      } catch {
        cachedPairing = null;
        resolve(null);
      }
    });
  }

  if (storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      if (!changes[STORAGE_KEY] && !changes[SESSION_KEY]) return;
      cachedPairing = undefined;
    });
  }

  async function deviceId() {
    try {
      if (typeof globalThis.zynHarvesterClientIdentity === 'function') {
        const identity = await globalThis.zynHarvesterClientIdentity();
        return String(identity && identity.clientId || '').slice(0, 128);
      }
    } catch {}
    return `ext-${Math.random().toString(36).slice(2, 12)}`;
  }

  function attachHandlers(socket, handlers) {
    socket.onopen = event => { if (typeof handlers.onopen === 'function') handlers.onopen(event); };
    socket.onmessage = event => { if (typeof handlers.onmessage === 'function') handlers.onmessage(event); };
    socket.onerror = event => { if (typeof handlers.onerror === 'function') handlers.onerror(event); };
    socket.onclose = event => { if (typeof handlers.onclose === 'function') handlers.onclose(event); };
  }

  function openRemoteRoom(pairing, handlers) {
    const holder = {
      url: LOCAL_BRIDGE,
      readyState: NativeWebSocket.CONNECTING,
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send() {},
      close() {},
    };
    let room = null;
    let demand = null;
    let proxies = null;
    let pending = null;
    let closed = false;
    let id = 'extension';
    let liveConnection = pairing;

    const fail = error => {
      if (closed) return;
      closed = true;
      holder.readyState = NativeWebSocket.CLOSED;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        pending = null;
      }
      try { room && room.close(); } catch {}
      if (typeof holder.onerror === 'function') holder.onerror({ type: 'error', message: error.message });
      if (typeof holder.onclose === 'function') holder.onclose({ type: 'close' });
    };

    const reply = payload => {
      if (typeof holder.onmessage === 'function') {
        holder.onmessage({ data: JSON.stringify(payload) });
      }
    };

    const wait = match => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending && pending.timer === timer) pending = null;
        reject(new Error('ws timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending = { match, resolve, reject, timer };
    });

    deviceId().then(async nextId => {
      id = pairing.sessionToken
        ? (pairing.deviceId || licenseDeviceId(nextId) || 'extension')
        : (nextId || 'extension');
      if (closed) return;
      let live = pairing;
      if (pairing.sessionToken && !pairing.roomId) {
        const roomInfo = await fetchHarvestRoom(pairing);
        live = { ...pairing, roomId: roomInfo.roomId, origin: roomInfo.origin };
      }
      if (closed) return;
      liveConnection = { ...live, deviceId: id };
      room = new NativeWebSocket(websocketUrl({ ...live, deviceId: id }));
      const timer = setTimeout(() => fail(new Error('ws timeout')), REQUEST_TIMEOUT_MS);
      room.onopen = () => {
        try { room.send(JSON.stringify({ type: 'hello', role: 'extension', deviceId: id })); } catch {}
      };
      room.onmessage = event => {
        let message = null;
        try { message = JSON.parse(String(event && event.data || '')); } catch {}
        if (!message || typeof message !== 'object') return;
        if (message.type === 'demand' || message.type === 'start') demand = message;
        if (message.type === 'mailbox') {
          demand = { ...(demand || {}), mailbox: message, remaining: message.remaining };
        }
        if (message.type === 'proxies') proxies = proxyGroupsFromMessage(message);
        if (message.type === 'stop') demand = { ...(demand || {}), room: { login: 0, atc: 0 } };
        if ((message.type === 'registered' || message.type === 'hello' || message.type === 'demand')
            && holder.readyState === NativeWebSocket.CONNECTING) {
          clearTimeout(timer);
          holder.readyState = NativeWebSocket.OPEN;
          if (typeof holder.onopen === 'function') holder.onopen({ type: 'open' });
        }
        if (pending && pending.match(message)) {
          clearTimeout(pending.timer);
          const finish = pending.resolve;
          pending = null;
          finish(message);
        }
      };
      room.onerror = () => fail(new Error('ws error'));
      room.onclose = () => {
        if (holder.readyState === NativeWebSocket.OPEN || holder.readyState === NativeWebSocket.CONNECTING) {
          fail(new Error('ws closed'));
        }
      };
    }).catch(error => fail(error));

    holder.send = data => {
      let message = null;
      try { message = JSON.parse(String(data)); } catch {}
      if (!message || typeof message !== 'object') return;
      if (!room || room.readyState !== NativeWebSocket.OPEN) {
        fail(new Error('harvest room is not connected'));
        return;
      }
      if (message.action === 'status') {
        reply(statusFromDemand(demand || {}));
        return;
      }
      if (message.action === 'proxies') {
        if (proxies) { reply(proxies); return; }
        try { room.send(JSON.stringify({ type: 'need-proxies', names: [] })); } catch {}
        wait(item => item.type === 'proxies').then(item => {
          proxies = proxyGroupsFromMessage(item);
          reply(proxies);
        }).catch(fail);
        return;
      }
      if (message.action !== 'save') return;
      postCapture(liveConnection, captureFromSave(message, id)).then(item => {
        if (item && item.mailbox) {
          demand = { ...(demand || {}), mailbox: item.mailbox, remaining: item.mailbox.remaining };
        }
        if (item && item.reason === 'full') {
          demand = { ...(demand || {}), room: { login: 0, atc: 0 }, remaining: { login: 0, atc: 0 } };
          reply({ ok: true, saved: 0 });
          return;
        }
        if (!item || item.ok !== true) {
          fail(new Error((item && item.message) || 'capture was not accepted'));
          return;
        }
        reply({ ok: true, saved: Number(item.saved) || 1 });
      }).catch(fail);
    };
    holder.close = () => {
      closed = true;
      holder.readyState = NativeWebSocket.CLOSED;
      try { room && room.close(); } catch {}
    };
    attachHandlers(holder, handlers);
    return holder;
  }

  function WrappedWebSocket(url, protocols) {
    if (String(url) !== LOCAL_BRIDGE) {
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    }
    const handlers = { onopen: null, onmessage: null, onerror: null, onclose: null };
    const holder = {
      url: LOCAL_BRIDGE,
      readyState: NativeWebSocket.CONNECTING,
      get onopen() { return handlers.onopen; },
      set onopen(value) { handlers.onopen = value; },
      get onmessage() { return handlers.onmessage; },
      set onmessage(value) { handlers.onmessage = value; },
      get onerror() { return handlers.onerror; },
      set onerror(value) { handlers.onerror = value; },
      get onclose() { return handlers.onclose; },
      set onclose(value) { handlers.onclose = value; },
      send() {},
      close() {},
    };
    readPairing().then(pairing => {
      const live = pairing
        ? openRemoteRoom(pairing, handlers)
        : (protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols));
      holder.readyState = live.readyState;
      holder.send = (...args) => live.send(...args);
      holder.close = (...args) => live.close(...args);
      if (pairing) return;
      attachHandlers(live, handlers);
    });
    return holder;
  }
  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
  WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  globalThis.WebSocket = WrappedWebSocket;
})();
