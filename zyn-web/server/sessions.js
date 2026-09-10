'use strict';

const crypto = require('crypto');

const FILE = 'web-session.json';
const COOKIE = 'zyn_session';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function createWebSessions(store) {
  const read = () => store.readJSON(FILE, {});
  return {
    cookieName: COOKIE,
    create() {
      const token = crypto.randomBytes(24).toString('hex');
      store.writeJSON(FILE, { token, createdAt: Date.now() });
      return token;
    },
    check(token) {
      const stored = String((read() && read().token) || '');
      const sent = String(token || '');
      if (!stored || !sent || stored.length !== sent.length) return false;
      return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(sent));
    },
    fromRequest(req) {
      return this.check(parseCookies(req)[COOKIE]);
    },
    clear() {
      store.writeJSON(FILE, {});
    },
    setCookieHeader(token, { secure = false } = {}) {
      const parts = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${MAX_AGE_SEC}`,
      ];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },
    clearCookieHeader({ secure = false } = {}) {
      const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },
  };
}

module.exports = { createWebSessions, parseCookies };
