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

export const MAILBOX_MAX_ATC = 1000;
export const MAILBOX_MAX_LOGIN = 0;
export const MAILBOX_TAKE_MAX = 64;
export const MAILBOX_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAILBOX_MIN_TTL_MS = 30 * 1000;
export const MAILBOX_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAILBOX_MAX_COOKIE_BYTES = 64 * 1024;

export function mailboxCookieType(value) {
  return String(value || '').toLowerCase() === 'login' ? 'login' : 'atc';
}

export function mailboxCaps() {
  return { login: MAILBOX_MAX_LOGIN, atc: MAILBOX_MAX_ATC };
}

export function pruneMailbox(list, now = Date.now()) {
  const ts = Number(now) || Date.now();
  return (Array.isArray(list) ? list : []).filter((cookie) => Number(cookie && cookie.expiresAt) > ts);
}

export function mailboxCounts(list, now = Date.now()) {
  const live = pruneMailbox(list, now);
  let login = 0;
  let atc = 0;
  for (const cookie of live) {
    if (cookie.type === 'login') login += 1;
    else atc += 1;
  }
  return { login, atc };
}

export function mailboxSnapshot(list, now = Date.now(), caps = mailboxCaps()) {
  const counts = mailboxCounts(list, now);
  const loginCap = Math.max(0, Number(caps.login) || 0);
  const atcCap = Math.max(0, Number(caps.atc) || 0);
  return {
    login: counts.login,
    atc: counts.atc,
    remaining: {
      login: Math.max(0, loginCap - counts.login),
      atc: Math.max(0, atcCap - counts.atc),
    },
  };
}

export function normalizeMailboxCookie(raw, {
  now = Date.now(),
  ttlMs = MAILBOX_DEFAULT_TTL_MS,
  id = '',
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('capture must be an object');
  }
  const type = mailboxCookieType(raw.cookieType || (raw.type === 'login' || raw.type === 'atc' ? raw.type : ''));
  if (type === 'login') throw new Error('remote mailbox is ATC only');
  const sourceHeaders = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
    ? raw.headers : {};
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(sourceHeaders)) {
    const name = String(rawName || '').toLowerCase();
    if (!CAPTURED_HEADER_NAMES.has(name) || rawValue == null) continue;
    const value = String(rawValue).slice(0, 8192);
    if (value) headers[name] = value;
  }
  const missing = REQUIRED_CAPTURED_HEADER_NAMES.filter((name) => !String(headers[name] || '').trim());
  if (missing.length) throw new Error(`capture is missing required headers: ${missing.join(', ')}`);
  const ttl = Math.max(MAILBOX_MIN_TTL_MS, Math.min(MAILBOX_MAX_TTL_MS, Number(ttlMs) || MAILBOX_DEFAULT_TTL_MS));
  const requestedExpiry = Number(raw.expiresAt || raw.expiry);
  const expiresAt = Number.isFinite(requestedExpiry) && requestedExpiry > now
    ? Math.min(requestedExpiry, now + ttl) : now + ttl;
  const cookie = {
    id: String(id || raw.id || '').slice(0, 80),
    type,
    headers,
    proxy: String(raw.proxy || '').slice(0, 4096),
    expiresAt,
    createdAt: now,
    harvesterId: String(raw.harvesterId || raw.deviceId || 'remote')
      .replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'remote',
    source: String(raw.source || raw.role || 'remote').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'remote',
  };
  if (JSON.stringify(cookie).length > MAILBOX_MAX_COOKIE_BYTES) {
    throw new Error('capture is too large');
  }
  return cookie;
}

export function enqueueMailboxCookie(list, cookie, { now = Date.now(), caps = mailboxCaps() } = {}) {
  const pruned = pruneMailbox(list, now);
  if (!cookie || cookie.type !== 'atc') {
    return { list: pruned, saved: 0, reason: cookie && cookie.type === 'login' ? 'login' : 'invalid' };
  }
  const cap = Math.max(0, Number(caps.atc) || 0);
  const count = pruned.filter((item) => item.type === cookie.type).length;
  if (count >= cap) return { list: pruned, saved: 0, reason: 'full' };
  return { list: [...pruned, cookie], saved: 1, reason: '' };
}

export function takeMailboxCookies(list, {
  type = 'atc',
  n = MAILBOX_TAKE_MAX,
  now = Date.now(),
} = {}) {
  const pruned = pruneMailbox(list, now);
  const want = Math.max(0, Math.min(MAILBOX_TAKE_MAX, Math.floor(Number(n) || 0)));
  const cookieType = mailboxCookieType(type);
  if (!want || cookieType === 'login') return { list: pruned, cookies: [] };
  const cookies = [];
  const keep = [];
  for (const cookie of pruned) {
    if (cookies.length < want && cookie.type === cookieType) cookies.push(cookie);
    else keep.push(cookie);
  }
  return { list: keep, cookies };
}
