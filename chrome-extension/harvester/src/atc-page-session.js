'use strict';

// Stay on a warm Target PDP after a good ATC capture. Reload + proxy rotate + session
// wipe only when this page life is exhausted — not after every cookie.
export const ATC_PAGE_COOKIE_LIMIT = 6;
export const ATC_PAGE_LIFE_MS = 15_000;

export function createAtcPageSession(now = Date.now()) {
  return { count: 0, startedAt: Number(now) || Date.now() };
}

export function atcPageSessionExhausted(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return false;
  const count = Number(session.count) || 0;
  const startedAt = Number(session.startedAt) || 0;
  if (count >= ATC_PAGE_COOKIE_LIMIT) return true;
  return startedAt > 0 && (Number(now) || Date.now()) - startedAt >= ATC_PAGE_LIFE_MS;
}

export function noteAtcPageCapture(session, now = Date.now()) {
  const clock = Number(now) || Date.now();
  const next = {
    count: (session && Number(session.count) || 0) + 1,
    startedAt: session && Number(session.startedAt) || clock,
  };
  return { session: next, exhausted: atcPageSessionExhausted(next, clock) };
}
