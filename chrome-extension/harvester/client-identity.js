(() => {
  'use strict';

  const BRIDGE_URL = 'ws://127.0.0.1:4312/ws';
  const CLIENT_ID_KEY = 'zynHarvesterClientId';
  const CLIENT_ID_LOCK = 'zyn-harvester-client-identity';
  const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (typeof globalThis.zynHarvesterClientIdentity === 'function') return;

  function randomClientId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizedClientId(value) {
    const id = String(value || '').trim().toLowerCase();
    return CLIENT_ID_PATTERN.test(id) ? id : '';
  }

  function storedClientId() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([CLIENT_ID_KEY], result => {
          resolve(normalizedClientId(result && result[CLIENT_ID_KEY]));
        });
      } catch {
        resolve('');
      }
    });
  }

  function saveClientId(clientId) {
    return new Promise(resolve => {
      try { chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId }, resolve); }
      catch { resolve(); }
    });
  }

  async function browserName() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function'
          && await navigator.brave.isBrave()) return 'Brave';
    } catch {}

    const brands = Array.isArray(navigator.userAgentData && navigator.userAgentData.brands)
      ? navigator.userAgentData.brands.map(item => String(item && item.brand || '').toLowerCase())
      : [];
    if (brands.some(brand => brand.includes('brave'))) return 'Brave';
    if (brands.some(brand => brand.includes('microsoft edge'))) return 'Edge';
    if (brands.some(brand => brand.includes('opera'))) return 'Opera';

    const userAgent = String(navigator.userAgent || '');
    if (/\bEdg\//.test(userAgent)) return 'Edge';
    if (/\bOPR\//.test(userAgent)) return 'Opera';
    if (/\bVivaldi\//.test(userAgent)) return 'Vivaldi';
    if (/\bChrome\//.test(userAgent)) return 'Chrome';
    return 'Chromium';
  }

  async function ensureClientId() {
    let clientId = await storedClientId();
    if (!clientId) {
      clientId = randomClientId();
      await saveClientId(clientId);
      // Web Locks is available in the Chromium versions that support this MV3 extension, but keep
      // the fallback convergent for unusual contexts that omit it. If two contexts both observed an
      // empty store, use the value that ultimately won the storage write instead of retaining the
      // losing context's temporary UUID until its next restart.
      clientId = await storedClientId() || clientId;
    }
    return clientId;
  }

  const identityPromise = (async () => {
    // The popup and MV3 service worker can initialize together on first launch. A cross-context Web
    // Lock makes the read/create/write atomic for the extension origin, so one browser profile can
    // never briefly report two installation IDs.
    const clientId = navigator.locks && typeof navigator.locks.request === 'function'
      ? await navigator.locks.request(CLIENT_ID_LOCK, ensureClientId)
      : await ensureClientId();
    return Object.freeze({ clientId, browser: await browserName() });
  })();

  globalThis.zynHarvesterClientIdentity = () => identityPromise;
  globalThis.zynHarvesterBridgePayload = async payload => ({
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
    ...await identityPromise,
  });

  if (typeof WebSocket !== 'function' || !WebSocket.prototype
      || typeof WebSocket.prototype.send !== 'function') return;

  const send = WebSocket.prototype.send;
  const socketIsOpen = socket => typeof WebSocket.OPEN !== 'number'
    || socket.readyState === WebSocket.OPEN;
  const sendIfOpen = (socket, data) => {
    if (!socketIsOpen(socket)) return;
    try { send.call(socket, data); } catch {}
  };
  WebSocket.prototype.send = function sendWithZynHarvesterIdentity(data) {
    let message = null;
    if (this.url === BRIDGE_URL && typeof data === 'string') {
      try { message = JSON.parse(data); } catch {}
    }
    if (!message || (message.action !== 'status' && message.action !== 'save')) {
      return send.call(this, data);
    }
    const socket = this;
    globalThis.zynHarvesterBridgePayload(message).then(payload => {
      sendIfOpen(socket, JSON.stringify(payload));
    }, () => sendIfOpen(socket, data));
    return undefined;
  };
})();
