import {
  MAILBOX_TAKE_MAX,
  enqueueMailboxCookie,
  mailboxSnapshot,
  normalizeMailboxCookie,
  takeMailboxCookies,
} from './harvest-mailbox.js';

const encoder = new TextEncoder();

export const MOBILE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MOBILE_MAX_PHONES = 3;
export const MOBILE_MAX_COMPANIONS = 8;
export const MOBILE_MAX_EXTENSIONS = 8;
export const MOBILE_MAX_DESKTOPS = 10;
export const MOBILE_MAX_MESSAGE_BYTES = 256 * 1024;
export const MOBILE_BINDING = 'MOBILE_HARVESTER';

const ROOM_ID_PATTERN = /^zynm_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const PHONE_TYPES = new Set(['hello', 'need-proxies', 'capture', 'log', 'status', 'error', 'ping']);
const COMPANION_TYPES = new Set(['hello', 'capture', 'log', 'status', 'error', 'ping']);
const EXTENSION_TYPES = new Set(['hello', 'need-proxies', 'capture', 'log', 'status', 'error', 'ping']);
const DESKTOP_TYPES = new Set([
  'hello', 'demand', 'proxies', 'start', 'stop', 'capture-ack', 'log', 'error', 'ping',
]);
const MAILBOX_CONTROL_TYPES = new Set(['hello', 'need-proxies', 'ping']);

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

export function shouldReplaceMobilePeer(meta, role, deviceId) {
  const current = String((meta && meta.role) || '');
  const incoming = String(role || '');
  if (!current || current !== incoming) return false;
  const existingId = String((meta && meta.deviceId) || '');
  const nextId = String(deviceId || '');
  if (!existingId || !nextId || existingId === 'unknown' || nextId === 'unknown') return false;
  return existingId === nextId;
}

export function canAcceptMobilePeer(stats, role) {
  const desktopCount = stats && stats.desktopCount != null
    ? Math.max(0, Number(stats.desktopCount) || 0)
    : (stats && stats.desktopOnline ? 1 : 0);
  const phoneCount = Math.max(0, Number(stats && stats.phoneCount) || 0);
  const companionCount = Math.max(0, Number(stats && stats.companionCount) || 0);
  const extensionCount = Math.max(0, Number(stats && stats.extensionCount) || 0);
  if (role === 'desktop') return desktopCount < MOBILE_MAX_DESKTOPS;
  if (role === 'phone') return phoneCount < MOBILE_MAX_PHONES;
  if (role === 'companion') return companionCount < MOBILE_MAX_COMPANIONS;
  if (role === 'extension') return extensionCount < MOBILE_MAX_EXTENSIONS;
  return false;
}

function addRemaining(sum, value) {
  if (sum === null || value === null) return null;
  return sum + Math.max(0, Number(value) || 0);
}

export function sumHarvestDemand(demands) {
  const list = Array.isArray(demands)
    ? demands.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  if (!list.length) {
    return {
      type: 'demand',
      atc: 0,
      login: 0,
      atcTarget: 0,
      waitingAtc: 0,
      activeTasks: 0,
      standbyTasks: 0,
      atcPerTask: 0,
      loginTasks: 0,
      room: { login: 0, atc: 0 },
      engines: 0,
      basis: 'paused',
    };
  }
  let atc = 0;
  let login = 0;
  let atcTarget = 0;
  let waitingAtc = 0;
  let activeTasks = 0;
  let standbyTasks = 0;
  let loginTasks = 0;
  let atcPerTask = 0;
  let roomAtc = 0;
  let roomLogin = 0;
  let liveBasis = '';
  for (const demand of list) {
    const basis = String(demand.basis || '');
    if (basis !== 'paused' && !liveBasis) liveBasis = basis || 'live';
    atc += Math.max(0, Number(demand.atc) || 0);
    login += Math.max(0, Number(demand.login) || 0);
    atcTarget += Math.max(0, Number(demand.atcTarget) || 0);
    waitingAtc += Math.max(0, Number(demand.waitingAtc) || 0);
    activeTasks += Math.max(0, Number(demand.activeTasks) || 0);
    standbyTasks += Math.max(0, Number(demand.standbyTasks) || 0);
    loginTasks += Math.max(0, Number(demand.loginTasks) || 0);
    const per = Number(demand.atcPerTask);
    if (Number.isFinite(per) && per > atcPerTask) atcPerTask = per;
    const room = demand.room && typeof demand.room === 'object' ? demand.room : {};
    if (Object.prototype.hasOwnProperty.call(room, 'atc')) roomAtc = addRemaining(roomAtc, room.atc);
    if (Object.prototype.hasOwnProperty.call(room, 'login')) roomLogin = addRemaining(roomLogin, room.login);
  }
  return {
    type: 'demand',
    atc,
    login,
    atcTarget,
    waitingAtc,
    activeTasks,
    standbyTasks,
    atcPerTask,
    loginTasks,
    room: { login: roomLogin, atc: roomAtc },
    engines: list.length,
    basis: liveBasis || 'paused',
  };
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

async function roomForCapture(request, env, url, { authenticate } = {}) {
  const joinToken = String(url.searchParams.get('token') || '');
  const roomId = String(url.searchParams.get('room') || '');
  if (joinToken && validRoomId(roomId)) {
    const room = await activeRoomById(env, roomId);
    if (!room) return { error: json({ ok: false, code: 'room_not_found', message: 'Pairing expired. Generate a new QR code in Zyn.' }, 404) };
    const tokenHash = await sha256Hex(joinToken);
    if (tokenHash !== room.token_hash) {
      return { error: json({ ok: false, code: 'join_invalid', message: 'This pairing code is no longer valid.' }, 403) };
    }
    const deviceId = String(url.searchParams.get('deviceId') || request.headers.get('x-rcart-device-id') || 'extension');
    return { room, deviceId, source: 'extension' };
  }
  const identity = await authenticate(request, env);
  if (!identity) {
    return { error: json({ ok: false, code: 'license_invalid', message: 'Sign in again to harvest into this Zyn account.' }, 401) };
  }
  const room = await activeRoomForUser(env, identity.user_id);
  if (!room) {
    return { error: json({
      ok: false,
      code: 'room_not_found',
      message: 'No Full Engine Zyn is hosting a harvest room. Sign in as Full Engine on the machine that runs tasks.',
    }, 404) };
  }
  return {
    room,
    deviceId: String(identity.device_id || ''),
    source: normalizeSessionKind(identity.session_kind) === 'harvester' ? 'extension' : 'remote',
  };
}

export async function captureHarvestCookie(request, env, url, { authenticate } = {}) {
  const resolved = await roomForCapture(request, env, url, { authenticate });
  if (resolved.error) return resolved.error;
  const stub = mobileRoomStub(env, resolved.room.room_id);
  if (!stub) {
    return json({ ok: false, code: 'service_unavailable', message: 'Harvest mailbox is unavailable.' }, 503);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, code: 'invalid_json', message: 'Capture was not valid JSON.' }, 400); }
  const internal = new URL('https://mobile-harvester.internal/mailbox/capture');
  return stub.fetch(new Request(internal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      deviceId: resolved.deviceId,
      source: body && body.source ? body.source : resolved.source,
    }),
  }));
}

export async function takeHarvestCookies(request, env, url, { authenticate } = {}) {
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to take harvest cookies.' }, 401);
  }
  if (normalizeSessionKind(identity.session_kind) !== 'engine') {
    return json({
      ok: false,
      code: 'engine_required',
      message: 'Only Full Engine Zyn can pull cookies from the harvest mailbox.',
    }, 403);
  }
  const room = await activeRoomForUser(env, identity.user_id);
  if (!room) {
    return json({ ok: false, code: 'room_not_found', message: 'No harvest room is online.' }, 404);
  }
  const stub = mobileRoomStub(env, room.room_id);
  if (!stub) {
    return json({ ok: false, code: 'service_unavailable', message: 'Harvest mailbox is unavailable.' }, 503);
  }
  let type = String(url.searchParams.get('type') || 'atc');
  let n = url.searchParams.get('n');
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body === 'object') {
        if (body.type) type = String(body.type);
        if (body.n != null) n = body.n;
      }
    } catch {}
  }
  const internal = new URL('https://mobile-harvester.internal/mailbox/take');
  return stub.fetch(new Request(internal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: type === 'login' ? 'login' : 'atc', n: Number(n) || MAILBOX_TAKE_MAX }),
  }));
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
    const joinToken = String(url.searchParams.get('token') || '');
    const sessionToken = String(url.searchParams.get('session') || '');
    if (joinToken) {
      const tokenHash = await sha256Hex(joinToken);
      if (tokenHash !== room.token_hash) {
        return json({ ok: false, code: 'join_invalid', message: 'This pairing code is no longer valid.' }, 403);
      }
      if (!validDeviceId(deviceId)) {
        return json({ ok: false, code: 'invalid_request', message: 'Extension device id is required.' }, 400);
      }
    } else if (sessionToken) {
      if (!validDeviceId(deviceId)) {
        return json({ ok: false, code: 'invalid_request', message: 'Extension device id is required.' }, 400);
      }
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${sessionToken}`);
      headers.set('x-rcart-device-id', deviceId);
      const identity = await authenticate(new Request(request.url, { method: 'GET', headers }), env);
      if (!identity || identity.user_id !== room.user_id) {
        return json({
          ok: false,
          code: 'license_invalid',
          message: 'Sign in again to harvest into this Zyn account.',
        }, 401);
      }
      deviceId = String(identity.device_id || deviceId);
    } else {
      return json({ ok: false, code: 'join_required', message: 'Sign in with your Zyn account, or paste a pairing URL.' }, 401);
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
  if (url.pathname === '/api/harvester/capture' && request.method === 'POST') {
    return captureHarvestCookie(request, env, url, dependencies);
  }
  if (url.pathname === '/api/harvester/capture') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }
  if (url.pathname === '/api/harvester/take' && (request.method === 'POST' || request.method === 'GET')) {
    return takeHarvestCookies(request, env, url, dependencies);
  }
  if (url.pathname === '/api/harvester/take') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }
  return null;
}

export class MobileHarvesterRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mailbox = null;
  }

  cookieKey(id) {
    return `cookie:${String(id || '')}`;
  }

  async loadMailbox() {
    if (this.mailbox) return this.mailbox;
    try {
      const ids = await this.state.storage.get('mailbox-ids');
      if (Array.isArray(ids) && ids.length) {
        const keys = ids.map((id) => this.cookieKey(id));
        const values = new Map();
        for (let i = 0; i < keys.length; i += 100) {
          const chunk = await this.state.storage.get(keys.slice(i, i + 100));
          if (chunk && typeof chunk.forEach === 'function') chunk.forEach((value, key) => values.set(key, value));
        }
        this.mailbox = ids.map((id) => values.get(this.cookieKey(id))).filter((cookie) => cookie && cookie.type === 'atc');
        return this.mailbox;
      }
      const stored = await this.state.storage.get('mailbox');
      this.mailbox = Array.isArray(stored)
        ? stored.filter((cookie) => cookie && cookie.type === 'atc')
        : [];
      if (this.mailbox.length) await this.persistMailbox(this.mailbox);
    } catch {
      this.mailbox = [];
    }
    return this.mailbox;
  }

  async persistMailbox(list) {
    const next = (Array.isArray(list) ? list : []).filter((cookie) => cookie && cookie.type === 'atc');
    const previous = Array.isArray(this.mailbox) ? this.mailbox : [];
    this.mailbox = next;
    try {
      const nextIds = new Set(next.map((cookie) => cookie.id));
      const removed = [];
      for (const cookie of previous) {
        if (cookie && cookie.id && !nextIds.has(cookie.id)) removed.push(this.cookieKey(cookie.id));
      }
      for (let i = 0; i < removed.length; i += 100) {
        await this.state.storage.delete(removed.slice(i, i + 100));
      }
      const previousIds = new Set(previous.map((cookie) => cookie && cookie.id).filter(Boolean));
      const puts = { 'mailbox-ids': next.map((cookie) => cookie.id) };
      for (const cookie of next) {
        if (!previousIds.has(cookie.id)) puts[this.cookieKey(cookie.id)] = cookie;
      }
      const entries = Object.entries(puts);
      for (let i = 0; i < entries.length; i += 100) {
        await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
      }
      try { await this.state.storage.delete('mailbox'); } catch {}
    } catch {}
    return this.mailbox;
  }

  mailboxNotice(list, now = Date.now()) {
    const snapshot = mailboxSnapshot(list, now);
    return { type: 'mailbox', login: snapshot.login, atc: snapshot.atc, remaining: snapshot.remaining };
  }

  notifyMailbox(list) {
    const notice = this.mailboxNotice(list);
    this.broadcast(notice, (peer) => (
      peer.role === 'desktop' || peer.role === 'extension' || peer.role === 'companion' || peer.role === 'phone'
    ));
    return notice;
  }

  async enqueueFromMessage(raw, extra = {}) {
    const now = Date.now();
    const current = await this.loadMailbox();
    let cookie;
    try {
      cookie = normalizeMailboxCookie({ ...raw, ...extra }, { now, id: randomToken(12) });
    } catch (error) {
      return { ok: false, saved: 0, reason: /ATC only/i.test(error.message) ? 'login' : 'invalid',
        message: error.message, mailbox: mailboxSnapshot(current, now) };
    }
    const next = enqueueMailboxCookie(current, cookie, { now });
    await this.persistMailbox(next.list);
    const mailbox = mailboxSnapshot(next.list, now);
    if (next.saved > 0) this.notifyMailbox(next.list);
    return { ok: next.saved > 0, saved: next.saved, reason: next.reason, mailbox };
  }

  async takeFromMailbox({ type, n } = {}) {
    const now = Date.now();
    const current = await this.loadMailbox();
    const next = takeMailboxCookies(current, { type: type === 'login' ? 'login' : 'atc', n, now });
    await this.persistMailbox(next.list);
    const mailbox = mailboxSnapshot(next.list, now);
    this.notifyMailbox(next.list);
    return { ok: true, cookies: next.cookies, mailbox };
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

  peerState(exclude) {
    let desktopCount = 0;
    let phoneCount = 0;
    let companionCount = 0;
    let extensionCount = 0;
    for (const socket of this.sockets()) {
      const meta = this.attachment(socket);
      if (typeof exclude === 'function' && exclude(meta, socket)) continue;
      const role = meta.role;
      if (role === 'desktop') desktopCount += 1;
      else if (role === 'phone') phoneCount += 1;
      else if (role === 'companion') companionCount += 1;
      else if (role === 'extension') extensionCount += 1;
    }
    return {
      desktopOnline: desktopCount > 0,
      desktopCount,
      phoneCount,
      companionCount,
      extensionCount,
    };
  }

  replaceMatchingPeers(role, deviceId) {
    for (const socket of this.sockets()) {
      if (!shouldReplaceMobilePeer(this.attachment(socket), role, deviceId)) continue;
      try { socket.close(4000, 'replaced'); } catch {}
    }
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
    if (url.pathname === '/mailbox/capture' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); }
      catch { return json({ ok: false, saved: 0, message: 'Capture was not valid JSON.' }, 400); }
      const result = await this.enqueueFromMessage(body);
      return json(result, result.ok ? 200 : result.reason === 'full' ? 200 : 400);
    }
    if (url.pathname === '/mailbox/take' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); }
      catch { body = {}; }
      const result = await this.takeFromMailbox(body);
      return json(result);
    }
    if (url.pathname === '/mailbox' && request.method === 'GET') {
      const list = await this.loadMailbox();
      return json({ ok: true, mailbox: mailboxSnapshot(list) });
    }
    if (url.pathname !== '/client') return new Response('Not found.', { status: 404 });
    if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 });
    }
    const role = normalizeRole(url.searchParams.get('role'));
    const deviceId = String(url.searchParams.get('deviceId') || 'unknown').slice(0, 128);
    if (!role) return new Response('Invalid role.', { status: 400 });
    this.replaceMatchingPeers(role, deviceId);
    const stats = this.peerState(meta => shouldReplaceMobilePeer(meta, role, deviceId));
    if (!canAcceptMobilePeer(stats, role)) {
      return json({
        ok: false,
        code: role === 'desktop' ? 'desktop_limit' : 'phone_limit',
        message: role === 'desktop'
          ? 'This account already has the maximum number of Full Engine desktops in the harvest room.'
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

  async announce(socket) {
    const meta = this.attachment(socket);
    if (!meta || meta.announced) return meta;
    const next = { ...meta, announced: true };
    try { socket.serializeAttachment(next); } catch {}
    const peer = this.peerState();
    const payload = {
      type: 'registered',
      role: next.role,
      deviceId: next.deviceId,
      desktopOnline: peer.desktopOnline,
      phoneCount: peer.phoneCount,
      peer,
    };
    if (next.role === 'extension' || next.role === 'companion' || next.role === 'phone'
        || next.role === 'desktop') {
      payload.mailbox = mailboxSnapshot(await this.loadMailbox());
    }
    this.send(socket, payload);
    this.broadcast({ type: 'peer-state', ...peer });
    return next;
  }

  async webSocketMessage(socket, raw) {
    const meta = await this.announce(socket) || this.attachment(socket) || {};
    const role = meta.role;
    const parsed = parseMobileClientMessage(raw, role);
    if (!parsed.ok) {
      this.send(socket, { type: 'error', code: parsed.code, message: 'Message rejected.' });
      return;
    }
    if (parsed.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    if (parsed.type === 'capture') {
      const result = await this.enqueueFromMessage(parsed.message, {
        role,
        deviceId: meta.deviceId,
        source: parsed.message.source || role,
      });
      this.send(socket, {
        type: 'capture-ack',
        ok: result.ok === true,
        saved: result.saved,
        mailbox: result.mailbox,
        message: result.ok ? undefined : (result.message || 'Capture was not accepted.'),
      });
      return;
    }
    if (parsed.type === 'log' || parsed.type === 'status' || parsed.type === 'error') {
      return;
    }
    if (role === 'desktop') {
      if (parsed.type === 'demand' || parsed.type === 'start') {
        this.rememberDesktopDemand(socket, parsed.message);
        this.publishAggregatedDemand();
        return;
      }
      if (parsed.type === 'stop') {
        const current = (this.attachment(socket) || {}).demand || {};
        this.rememberDesktopDemand(socket, {
          ...current,
          type: 'demand',
          basis: 'paused',
          waitingAtc: 0,
          activeTasks: 0,
          room: { login: 0, atc: 0 },
        });
        this.publishAggregatedDemand();
        return;
      }
      this.broadcast(parsed.message, (peer) => (
        peer.role === 'phone' || peer.role === 'companion' || peer.role === 'extension'
      ));
    } else if (MAILBOX_CONTROL_TYPES.has(parsed.type)) {
      this.broadcast(parsed.message, (peer) => peer.role === 'desktop');
    }
  }

  rememberDesktopDemand(socket, demand) {
    const meta = this.attachment(socket) || {};
    if (meta.role !== 'desktop') return;
    try { socket.serializeAttachment({ ...meta, demand }); } catch {}
  }

  publishAggregatedDemand() {
    const demands = [];
    for (const socket of this.sockets()) {
      const meta = this.attachment(socket);
      if (meta && meta.role === 'desktop' && meta.demand) demands.push(meta.demand);
    }
    const aggregated = sumHarvestDemand(demands);
    const harvesters = (peer) => (
      peer.role === 'phone' || peer.role === 'companion' || peer.role === 'extension'
    );
    this.broadcast(aggregated, harvesters);
    if (aggregated.basis === 'paused') this.broadcast({ type: 'stop', site: 'target' }, harvesters);
  }

  async webSocketClose() {
    this.broadcast({ type: 'peer-state', ...this.peerState() });
    this.publishAggregatedDemand();
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'error'); } catch {}
    this.broadcast({ type: 'peer-state', ...this.peerState() });
    this.publishAggregatedDemand();
  }
}
