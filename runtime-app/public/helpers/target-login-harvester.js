'use strict';

// Singleton Target login harvester. Users configure proxy, cookie TTL, interval delay, and
// browser refresh. Zyn hardcodes the rest and starts/stops the producer from checkout demand.

const LOGIN_HARVESTER_ID = 'zyn-login';
const LOGIN_HARVESTER_NAME = 'Login';
const LOGIN_HARVESTER_STOP_DELAY_MS = 3000;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function normalizeTargetLoginHarvester(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    proxyListName: String(source.proxyListName || ''),
    cookieTtlSec: clampInteger(source.cookieTtlSec, 30, 86400, 600),
    intervalDelaySec: clampInteger(source.intervalDelaySec, 0, 3600, 10),
    loadsPerBrowser: clampInteger(source.loadsPerBrowser, 1, 10, 3),
  };
}

function readTargetLoginHarvesterSettings(settings) {
  const current = settings && settings.targetLoginHarvester;
  if (current && typeof current === 'object') return normalizeTargetLoginHarvester(current);
  const fromList = Array.isArray(settings && settings.targetHarvesters)
    ? settings.targetHarvesters.find(item => item && item.type === 'login')
    : null;
  return normalizeTargetLoginHarvester(fromList || {});
}

function buildTargetLoginHarvesterConfig(settings, enabled) {
  const user = readTargetLoginHarvesterSettings(settings);
  return {
    id: LOGIN_HARVESTER_ID,
    name: LOGIN_HARVESTER_NAME,
    type: 'login',
    engine: 'playwright',
    atcMode: 'v1',
    browser: 'auto',
    proxyListName: user.proxyListName,
    workers: 1,
    input: '',
    cookieTtlSec: user.cookieTtlSec,
    intervalDelaySec: user.intervalDelaySec,
    loadsPerBrowser: user.loadsPerBrowser,
    startSchedule: '',
    stopSchedule: '',
    enabled: enabled === true,
  };
}

function loginStatusText(status) {
  if (status == null) return '';
  if (typeof status === 'string') return status;
  return [status.state, status.label, status.detail].filter(Boolean).join(' ');
}

function loginStatusNeedsHarvester(status) {
  return /\b(?:getting session|logging in|\blogin\b|requesting login code|waiting for code|submitting code|validating login|waiting for shape)\b/i
    .test(loginStatusText(status));
}

function loginStatusClearsHarvester(status) {
  return /\b(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?|adding to cart|carted|submitting payment|submitting cvv|submitting order|successful|checked out|out of stock|waiting for order)\b/i
    .test(loginStatusText(status));
}

function loginHarvesterShouldRun({
  authorized = false,
  runningTaskIds = [],
  latchedTaskIds = [],
  otpPending = false,
  statuses = {},
} = {}) {
  if (authorized !== true) return false;
  if (otpPending) return true;
  const running = runningTaskIds instanceof Set ? runningTaskIds : new Set([...runningTaskIds].map(String));
  const latched = latchedTaskIds instanceof Set ? latchedTaskIds : new Set([...latchedTaskIds].map(String));
  const statusMap = statuses instanceof Map
    ? statuses
    : new Map(Object.entries(statuses || {}));
  for (const id of running) {
    const key = String(id);
    if (latched.has(key) || latched.has(id)) return true;
    if (loginStatusNeedsHarvester(statusMap.get(key) || statusMap.get(id))) return true;
  }
  return false;
}

module.exports = {
  LOGIN_HARVESTER_ID,
  LOGIN_HARVESTER_NAME,
  LOGIN_HARVESTER_STOP_DELAY_MS,
  normalizeTargetLoginHarvester,
  readTargetLoginHarvesterSettings,
  buildTargetLoginHarvesterConfig,
  loginStatusNeedsHarvester,
  loginStatusClearsHarvester,
  loginHarvesterShouldRun,
};
