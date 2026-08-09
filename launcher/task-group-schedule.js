'use strict';

// Absolute epoch milliseconds are persisted. Clock and interval inputs resolve when saved.
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;
const CATCH_UP_MS = 15 * 60 * 1000;

function asEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function normalizeSchedule(raw, site = 'target') {
  if (String(site || '').toLowerCase() !== 'target') return null;
  if (!raw || typeof raw !== 'object') return null;
  const startAt = asEpoch(raw.startAt);
  let stopAt = asEpoch(raw.stopAt);
  if (startAt != null && stopAt != null && stopAt <= startAt) stopAt = null;
  if (startAt == null && stopAt == null) return null;
  return { startAt, stopAt };
}

function evaluateScheduleAction(schedule, { now = Date.now(), groupRunning = false } = {}) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return { action: 'none' };
  const { startAt, stopAt } = normalized;

  if (stopAt != null && now >= stopAt) {
    if (groupRunning) return { action: 'stop', reason: 'stop time reached' };
    return { action: 'clear-both', reason: 'stop time already passed' };
  }
  if (startAt != null && now >= startAt) {
    const recentMiss = now - startAt <= CATCH_UP_MS;
    if ((recentMiss || stopAt != null) && !groupRunning) {
      return { action: 'start', reason: 'start time reached' };
    }
    if (groupRunning) return { action: 'clear-start', reason: 'already running past start' };
    if (!recentMiss && stopAt == null) return { action: 'clear-start', reason: 'start missed while app was closed' };
  }
  return { action: 'none', startAt, stopAt };
}

function timerDelayMs(targetAt, now = Date.now()) {
  const at = asEpoch(targetAt);
  if (at == null) return null;
  return Math.min(Math.max(0, at - now), MAX_SAFE_TIMEOUT_MS);
}

function formatLocalTime(epochMs) {
  const value = asEpoch(epochMs);
  if (value == null) return '';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function scheduleDetailLine(schedule) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return '';
  const parts = [];
  if (normalized.startAt != null) parts.push(`start ${formatLocalTime(normalized.startAt)}`);
  if (normalized.stopAt != null) parts.push(`stop ${formatLocalTime(normalized.stopAt)}`);
  return parts.join(', ');
}

module.exports = {
  MAX_SAFE_TIMEOUT_MS,
  CATCH_UP_MS,
  asEpoch,
  normalizeSchedule,
  evaluateScheduleAction,
  timerDelayMs,
  formatLocalTime,
  scheduleDetailLine,
};
