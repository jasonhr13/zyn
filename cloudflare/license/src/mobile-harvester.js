const encoder = new TextEncoder();

export const MOBILE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MOBILE_MAX_PHONES = 3;
export const MOBILE_MAX_COMPANIONS = 8;
export const MOBILE_MAX_EXTENSIONS = 8;
export const MOBILE_MAX_MESSAGE_BYTES = 256 * 1024;
export const MOBILE_BINDING = 'MOBILE_HARVESTER';

const ROOM_ID_PATTERN = /^zynm_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const PHONE_TYPES = new Set(['hello', 'need-proxies', 'capture', 'log', 'status', 'error']);
const COMPANION_TYPES = new Set(['hello', 'capture', 'log', 'status', 'error']);
const EXTENSION_TYPES = new Set(['hello', 'need-proxies', 'capture', 'log', 'status', 'error']);
const DESKTOP_TYPES = new Set([
  'hello', 'demand', 'proxies', 'start', 'stop', 'capture-ack', 'log', 'error',
]);

export function mobilePairingUrl(origin, roomId, joinToken) {
  const url = new URL('zyn://pair');
  url.searchParams.set('room', roomId);
  url.searchParams.set('token', joinToken);
  url.searchParams.set('origin', String(origin || '').replace(/\/+$/, ''));
  return url.toString();
}

export function parseMobilePairingUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'zyn:') return null;
    const room = url.searchParams.get('room') || '';
    const token = url.searchParams.get('token') || '';
    const origin = url.searchParams.get('origin') || '';
    if (!ROOM_ID_PATTERN.test(room) || token.length < 16) return null;
    return { roomId: room, joinToken: token, origin };
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function validRoomId(value) {
  return ROOM_ID_PATTERN.test(String(value || ''));
}

function validDeviceId(value) {
  return DEVICE_ID_PATTERN.test(String(value || ''));
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role === 'desktop' || role === 'phone' || role === 'companion' || role === 'extension'
    ? role : '';
}

function normalizeSessionKind(value) {
  return String(value || '').trim().toLowerCase() === 'harvester' ? 'harvester' : 'engine';
}

export function allowedMobileMessageType(role, type) {
  const name = String(type || '');
  if (role === 'phone') return PHONE_TYPES.has(name);
  if (role === 'companion') return COMPANION_TYPES.has(name);
  if (role === 'extension') return EXTENSION_TYPES.has(name);
  if (role === 'desktop') return DESKTOP_TYPES.has(name);
  return false;
}

export function parseMobileClientMessage(raw, role, maxBytes = MOBILE_MAX_MESSAGE_BYTES) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text || encoder.encode(text).length > maxBytes) {
    return { ok: false, code: 'message_too_large' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid_json' };
  }
  const type = String(parsed.type || '');
  if (!allowedMobileMessageType(role, type)) {
    return { ok: false, code: 'type_not_allowed' };
  }
  return { ok: true, message: parsed, type };
}

export function canAcceptMobilePeer(stats, role) {
  const desktopOnline = Boolean(stats && stats.desktopOnline);
  const phoneCount = Math.max(0, Number(stats && stats.phoneCount) || 0);
  const companionCount = Math.max(0, Number(stats && stats.companionCount) || 0);
  const extensionCount = Math.max(0, Number(stats && stats.extensionCount) || 0);
  if (role === 'desktop') return !desktopOnline;
  if (role === 'phone') return phoneCount < MOBILE_MAX_PHONES;
  if (role === 'companion') return companionCount < MOBILE_MAX_COMPANIONS;
  if (role === 'extension') return extensionCount < MOBILE_MAX_EXTENSIONS;
  return false;
}

async function activeRoomForUser(env, userId) {
  const now = Date.now();
  return env.DB.prepare(`
    SELECT room_id, user_id, license_id, token_hash, created_at, expires_at, revoked_at
    FROM mobile_rooms
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId, now).first();
}

async function activeRoomById(env, roomId) {
  if (!validRoomId(roomId)) return null;
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT room_id, user_id, license_id, token_hash, created_at, expires_at, revoked_at
    FROM mobile_rooms
    WHERE room_id = ?
  `).bind(roomId).first();
  if (!row || row.revoked_at || Number(row.expires_at) <= now) return null;
  return row;
}

export async function pairMobileRoom(request, env, { authenticate } = {}) {
  if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405);
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to pair a mobile harvester.' }, 401);
  }
  const now = Date.now();
  const roomId = `zynm_${randomToken(18)}`;
  const joinToken = randomToken(32);
  const tokenHash = await sha256Hex(joinToken);
  const expiresAt = now + MOBILE_ROOM_TTL_MS;
  await env.DB.prepare(`
    UPDATE mobile_rooms SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(now, identity.user_id).run();
  await env.DB.prepare(`
    INSERT INTO mobile_rooms (room_id, user_id, license_id, token_hash, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).bind(roomId, identity.user_id, identity.license_id, tokenHash, now, expiresAt).run();
  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    roomId,
    joinToken,
    expiresAt,
    pairingUrl: mobilePairingUrl(origin, roomId, joinToken),
    wsPath: '/api/mobile/ws',
  });
}

export async function ensureHarvestRoom(request, env, { authenticate } = {}) {
  if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405);
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to host remote harvesters.' }, 401);
  }
  if (normalizeSessionKind(identity.session_kind) !== 'engine') {
    return json({
      ok: false,
      code: 'engine_required',
      message: 'Only Full Engine Zyn can host the cookie bank for remote harvesters.',
    }, 403);
  }
  const existing = await activeRoomForUser(env, identity.user_id);
  if (existing) {
    return json({
      ok: true,
      roomId: existing.room_id,
      expiresAt: Number(existing.expires_at) || 0,
      created: false,
    });
  }
  const now = Date.now();
  const roomId = `zynm_${randomToken(18)}`;
  const joinToken = randomToken(32);
  const tokenHash = await sha256Hex(joinToken);
  const expiresAt = now + MOBILE_ROOM_TTL_MS;
  await env.DB.prepare(`
    INSERT INTO mobile_rooms (room_id, user_id, license_id, token_hash, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).bind(roomId, identity.user_id, identity.license_id, tokenHash, now, expiresAt).run();
  return json({
    ok: true,
    roomId,
    expiresAt,
    created: true,
  });
}

export async function getHarvestRoom(request, env, { authenticate } = {}) {
  if (request.method !== 'GET') return json({ ok: false, message: 'Method not allowed.' }, 405);
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to join a harvest room.' }, 401);
  }
  const room = await activeRoomForUser(env, identity.user_id);
  if (!room) {
    return json({
      ok: false,
      code: 'room_not_found',
      message: 'No Full Engine Zyn is hosting a harvest room. Sign in as Full Engine on the machine that runs tasks.',
    }, 404);
  }
  return json({
    ok: true,
    roomId: room.room_id,
    expiresAt: Number(room.expires_at) || 0,
  });
}

export async function resetMobileRoom(request, env, { authenticate } = {}) {
  if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405);
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to reset mobile pairing.' }, 401);
  }
  await env.DB.prepare(`
    UPDATE mobile_rooms SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(Date.now(), identity.user_id).run();
  return json({ ok: true, revoked: true });
}

function mobileRoomStub(env, roomId) {
  if (!env[MOBILE_BINDING]) return null;
  const id = env[MOBILE_BINDING].idFromName(roomId);
  return env[MOBILE_BINDING].get(id);
}

export async function connectMobileWebSocket(request, env, url, { authenticate } = {}) {
  if (request.method !== 'GET') return json({ ok: false, message: 'Method not allowed.' }, 405);
  if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return json({ ok: false, code: 'websocket_required', message: 'WebSocket upgrade required.' }, 426);
  }
  const role = normalizeRole(url.searchParams.get('role'));
  const roomId = String(url.searchParams.get('room') || '');
  if (!role || !validRoomId(roomId)) {
    return json({ ok: false, code: 'invalid_request', message: 'Room and role are required.' }, 400);
  }

  let deviceId = String(url.searchParams.get('deviceId') || request.headers.get('x-rcart-device-id') || '');
  const room = await activeRoomById(env, roomId);
  if (!room) {
    return json({ ok: false, code: 'room_not_found', message: 'Pairing expired. Generate a new QR code in Zyn.' }, 404);
  }

  if (role === 'extension') {
    const token = String(url.searchParams.get('token') || '');
    if (!token) {
      return json({ ok: false, code: 'join_required', message: 'Extension join token is required.' }, 401);
    }
    const tokenHash = await sha256Hex(token);
    if (tokenHash !== room.token_hash) {
      return json({ ok: false, code: 'join_invalid', message: 'This pairing code is no longer valid.' }, 403);
    }
    if (!validDeviceId(deviceId)) {
      return json({ ok: false, code: 'invalid_request', message: 'Extension device id is required.' }, 400);
    }
  } else if (role === 'desktop' || role === 'companion') {
    const identity = await authenticate(request, env);
    if (!identity || identity.user_id !== room.user_id) {
      return json({
        ok: false,
        code: 'license_invalid',
        message: role === 'companion'
          ? 'Sign in again to send cookies to this Zyn account.'
          : 'Sign in again to connect this desktop.',
      }, 401);
    }
    const kind = normalizeSessionKind(identity.session_kind);
    if (role === 'desktop' && kind !== 'engine') {
      return json({
        ok: false,
        code: 'engine_required',
        message: 'Only Full Engine Zyn can host the cookie bank.',
      }, 403);
    }
    if (role === 'companion' && kind !== 'harvester') {
      return json({
        ok: false,
        code: 'harvester_required',
        message: 'Sign in as Harvester only to send cookies to another Zyn.',
      }, 403);
    }
    deviceId = String(identity.device_id || deviceId);
  } else {
    const token = String(url.searchParams.get('token') || '');
    if (!token) {
      return json({ ok: false, code: 'join_required', message: 'Phone join token is required.' }, 401);
    }
    const tokenHash = await sha256Hex(token);
    if (tokenHash !== room.token_hash) {
      return json({ ok: false, code: 'join_invalid', message: 'This pairing code is no longer valid.' }, 403);
    }
    if (!validDeviceId(deviceId)) {
      return json({ ok: false, code: 'invalid_request', message: 'Phone device id is required.' }, 400);
    }
  }

  const stub = mobileRoomStub(env, room.room_id);
  if (!stub) {
    return json({ ok: false, code: 'service_unavailable', message: 'Mobile harvester relay is unavailable.' }, 503);
  }
  const internal = new URL('https://mobile-harvester.internal/client');
  internal.searchParams.set('role', role);
  internal.searchParams.set('deviceId', deviceId || 'unknown');
  const headers = new Headers();
  headers.set('Upgrade', 'websocket');
  const connection = request.headers.get('Connection');
  if (connection) headers.set('Connection', connection);
  const wsKey = request.headers.get('Sec-WebSocket-Key');
  if (wsKey) headers.set('Sec-WebSocket-Key', wsKey);
  const wsVersion = request.headers.get('Sec-WebSocket-Version');
  if (wsVersion) headers.set('Sec-WebSocket-Version', wsVersion);
  return stub.fetch(new Request(internal, {
    method: 'GET',
    headers,
  }));
}

export async function handleMobileRoutes(request, env, url, dependencies) {
  if (url.pathname === '/api/mobile/pair' && request.method === 'POST') {
    return pairMobileRoom(request, env, dependencies);
  }
  if (url.pathname === '/api/mobile/pair/reset' && request.method === 'POST') {
    return resetMobileRoom(request, env, dependencies);
  }
  if (url.pathname === '/api/mobile/pair' || url.pathname === '/api/mobile/pair/reset') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }
  if (url.pathname === '/api/mobile/ws') {
    return connectMobileWebSocket(request, env, url, dependencies);
  }
  if (url.pathname === '/api/harvester/room' && request.method === 'POST') {
    return ensureHarvestRoom(request, env, dependencies);
  }
  if (url.pathname === '/api/harvester/room' && request.method === 'GET') {
    return getHarvestRoom(request, env, dependencies);
  }
  if (url.pathname === '/api/harvester/room') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }
  return null;
}

export class MobileHarvesterRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  sockets() {
    return this.state.getWebSockets().filter((socket) => socket.readyState === 1);
  }

  attachment(socket) {
    try {
      return socket.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  peerState() {
    let desktopOnline = false;
    let phoneCount = 0;
    let companionCount = 0;
    let extensionCount = 0;
    for (const socket of this.sockets()) {
      const role = this.attachment(socket).role;
      if (role === 'desktop') desktopOnline = true;
      else if (role === 'phone') phoneCount += 1;
      else if (role === 'companion') companionCount += 1;
      else if (role === 'extension') extensionCount += 1;
    }
    return { desktopOnline, phoneCount, companionCount, extensionCount };
  }

  send(socket, payload) {
    try { socket.send(JSON.stringify(payload)); } catch {}
  }

  broadcast(payload, predicate) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.sockets()) {
      if (predicate && !predicate(this.attachment(socket), socket)) continue;
      try { socket.send(encoded); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/client') return new Response('Not found.', { status: 404 });
    if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 });
    }
    const role = normalizeRole(url.searchParams.get('role'));
    const deviceId = String(url.searchParams.get('deviceId') || 'unknown').slice(0, 128);
    if (!role) return new Response('Invalid role.', { status: 400 });
    const stats = this.peerState();
    if (!canAcceptMobilePeer(stats, role)) {
      return json({
        ok: false,
        code: role === 'desktop' ? 'desktop_connected' : 'phone_limit',
        message: role === 'desktop'
          ? 'Another Zyn desktop is already connected to this room.'
          : role === 'companion'
            ? 'This account already has the maximum number of remote harvesters.'
            : role === 'extension'
              ? 'This pairing already has the maximum number of browser extensions.'
            : 'This pairing already has the maximum number of phones.',
      }, 409);
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role, deviceId, announced: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  announce(socket) {
    const meta = this.attachment(socket);
    if (!meta || meta.announced) return meta;
    const next = { ...meta, announced: true };
    try { socket.serializeAttachment(next); } catch {}
    const peer = this.peerState();
    this.send(socket, {
      type: 'registered',
      role: next.role,
      deviceId: next.deviceId,
      desktopOnline: peer.desktopOnline,
      phoneCount: peer.phoneCount,
      peer,
    });
    this.broadcast({ type: 'peer-state', ...peer });
    return next;
  }

  async webSocketMessage(socket, raw) {
    const meta = this.announce(socket) || this.attachment(socket) || {};
    const role = meta.role;
    const parsed = parseMobileClientMessage(raw, role);
    if (!parsed.ok) {
      this.send(socket, { type: 'error', code: parsed.code, message: 'Message rejected.' });
      return;
    }
    if (role === 'desktop') {
      this.broadcast(parsed.message, (peer) => (
        peer.role === 'phone' || peer.role === 'companion' || peer.role === 'extension'
      ));
    } else {
      this.broadcast(parsed.message, (peer) => peer.role === 'desktop');
    }
  }

  async webSocketClose() {
    this.broadcast({ type: 'peer-state', ...this.peerState() });
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'error'); } catch {}
    this.broadcast({ type: 'peer-state', ...this.peerState() });
  }
}
