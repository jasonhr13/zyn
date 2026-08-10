'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUTBOX_FILE = 'analytics-outbox.json';
const CACHE_FILE = 'analytics-cache.json';
const MAX_OUTBOX_EVENTS = 2000;
const BATCH_SIZE = 20;
const RETRY_MS = 30000;

let configuredService = null;

function setService(service) {
  configuredService = service && typeof service.record === 'function' ? service : null;
}

function record(event) {
  if (!configuredService) return false;
  return configuredService.record(event);
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function integer(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeEvent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = text(value.eventType, 20).toLowerCase();
  if (!['carted', 'checkout', 'decline'].includes(type)) return null;
  const compactSite = text(value.site, 80).toLowerCase().replace(/[^a-z]/g, '');
  const site = compactSite === 'target' ? 'Target'
    : (['pokemoncenter', 'pokemoncenterus'].includes(compactSite) ? 'Pokemon Center US' : '');
  if (!site) return null;
  const eventId = text(value.eventId, 80);
  if (!/^[a-z0-9-]{16,80}$/i.test(eventId)) return null;
  return {
    eventId,
    eventType: type,
    site,
    taskId: text(value.taskId, 160),
    runId: text(value.runId, 160),
    orderNumber: text(value.orderNumber, 160),
    totalCents: integer(value.totalCents, 0, 1000000000, 0),
    occurredAt: integer(value.occurredAt, 0, now + 5 * 60 * 1000, now),
    items: (Array.isArray(value.items) ? value.items : []).slice(0, 20).map((item) => ({
      sku: text(item && item.sku, 120),
      name: text(item && item.name, 300),
      image: text(item && item.image, 1000),
      productUrl: /^https?:\/\//i.test(text(item && item.productUrl, 1000))
        ? text(item && item.productUrl, 1000) : '',
      size: text(item && item.size, 120),
      unitPriceCents: integer(item && item.unitPriceCents, 0, 100000000, 0),
      quantity: integer(item && item.quantity, 1, 999, 1),
    })),
  };
}

function ownerKey(status) {
  const email = status && status.ok === true ? text(status.email, 254).toLowerCase() : '';
  return email ? crypto.createHash('sha256').update(`zyn-analytics:${email}`).digest('hex') : '';
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function readJson(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function sanitizeQuery(query = {}) {
  const range = ['today', '30d', '90d', 'all'].includes(query.range) ? query.range : 'all';
  return {
    range,
    from: integer(query.from, 0, Date.now() + 5 * 60 * 1000, 0),
    to: integer(query.to, 0, Date.now() + 5 * 60 * 1000, Date.now() + 1),
    ...(query.page != null ? { page: integer(query.page, 1, 1000000, 1) } : {}),
    ...(query.pageSize != null ? { pageSize: integer(query.pageSize, 1, 100, 20) } : {}),
    ...(query.search != null ? { search: text(query.search, 120) } : {}),
  };
}

function createAnalyticsService({
  dataDirectory,
  authority,
  ipcMain,
  now = () => Date.now(),
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  onUpdated = () => {},
  logger = console,
} = {}) {
  if (!dataDirectory) throw new Error('analytics dataDirectory is required');
  if (!authority) throw new Error('analytics license authority is required');
  const outboxPath = path.join(dataDirectory, OUTBOX_FILE);
  const cachePath = path.join(dataDirectory, CACHE_FILE);
  let outbox = readJson(outboxPath, { version: 1, entries: [] });
  if (!Array.isArray(outbox.entries)) outbox = { version: 1, entries: [] };
  let cache = readJson(cachePath, { version: 1, owners: {} });
  if (!cache.owners || typeof cache.owners !== 'object') cache = { version: 1, owners: {} };
  let flushInFlight = null;
  let retryTimer = null;

  const status = () => authority.cached ? authority.cached() : null;
  const activeOwner = () => ownerKey(status());
  const pendingCount = owner => outbox.entries.filter(entry => entry.owner === owner).length;
  const saveOutbox = () => {
    try { atomicWrite(outboxPath, outbox); }
    catch (error) { logger.warn?.(`[analytics] save outbox: ${error.message}`); }
  };
  const saveCache = () => {
    try { atomicWrite(cachePath, cache); }
    catch (error) { logger.warn?.(`[analytics] save cache: ${error.message}`); }
  };
  const notify = payload => {
    try { onUpdated({ pending: pendingCount(activeOwner()), ...(payload || {}) }); } catch {}
  };
  const scheduleRetry = () => {
    if (retryTimer) return;
    retryTimer = scheduleTimeout(() => {
      retryTimer = null;
      flush().catch(() => {});
    }, RETRY_MS);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  async function flush() {
    if (flushInFlight) return flushInFlight;
    const owner = activeOwner();
    if (!owner) return { ok: false, pending: 0 };
    const batch = outbox.entries.filter(entry => entry.owner === owner).slice(0, BATCH_SIZE);
    if (!batch.length) return { ok: true, pending: 0 };
    flushInFlight = (async () => {
      const result = await authority.recordAnalytics(batch.map(entry => entry.event));
      if (result && result.ok === true) {
        const uploaded = new Set(batch.map(entry => `${entry.owner}:${entry.event.eventId}`));
        outbox.entries = outbox.entries.filter(entry => !uploaded.has(`${entry.owner}:${entry.event.eventId}`));
        saveOutbox();
        notify({ synced: true });
        if (pendingCount(owner)) scheduleTimeout(() => flush().catch(() => {}), 0);
      } else {
        scheduleRetry();
      }
      return { ...(result || {}), pending: pendingCount(owner) };
    })();
    try { return await flushInFlight; } finally { flushInFlight = null; }
  }

  function storeCache(owner, key, result) {
    const ownerCache = cache.owners[owner] || {};
    ownerCache[key] = { at: now(), result };
    const newest = Object.entries(ownerCache).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
    cache.owners[owner] = Object.fromEntries(newest);
    saveCache();
  }

  async function query(kind, queryValue, fetcher) {
    const owner = activeOwner();
    if (!owner) return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
    const clean = sanitizeQuery(queryValue);
    // Range endpoints move on every refresh, so cache the semantic view rather than its exact
    // millisecond bounds. Otherwise an offline refresh could never find the preceding online copy.
    const key = `${kind}:${JSON.stringify({
      range: clean.range,
      page: clean.page || 1,
      pageSize: clean.pageSize || 20,
      search: clean.search || '',
    })}`;
    flush().catch(() => {});
    const result = await fetcher(clean);
    if (result && result.ok === true) {
      const value = { ...result, pending: pendingCount(owner), offline: false };
      storeCache(owner, key, value);
      return value;
    }
    const saved = cache.owners[owner] && cache.owners[owner][key];
    if (saved && saved.result) {
      return {
        ...saved.result,
        pending: pendingCount(owner),
        offline: true,
        message: 'Showing the last synced analytics while the service is unavailable.',
      };
    }
    return { ...(result || {}), pending: pendingCount(owner), offline: true };
  }

  const service = {
    outboxPath,
    cachePath,
    record(value) {
      const event = normalizeEvent(value, now());
      const owner = activeOwner();
      if (!event || !owner) return false;
      const duplicate = outbox.entries.some(entry => entry.owner === owner && entry.event.eventId === event.eventId);
      if (duplicate) return true;
      outbox.entries.push({ owner, event });
      if (outbox.entries.length > MAX_OUTBOX_EVENTS) outbox.entries.splice(0, outbox.entries.length - MAX_OUTBOX_EVENTS);
      saveOutbox();
      notify({ recorded: true });
      scheduleTimeout(() => flush().catch(() => {}), 0);
      return true;
    },
    flush,
    sessionChanged() { flush().catch(() => {}); },
    dashboard(queryValue) {
      return query('dashboard', queryValue, clean => authority.analyticsDashboard(clean));
    },
    checkouts(queryValue) {
      return query('checkouts', queryValue, clean => authority.analyticsCheckouts(clean));
    },
    async deleteAll() {
      const owner = activeOwner();
      if (!owner) return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
      const result = await authority.deleteAnalytics();
      if (result && result.ok === true) {
        outbox.entries = outbox.entries.filter(entry => entry.owner !== owner);
        delete cache.owners[owner];
        saveOutbox();
        saveCache();
        notify({ deleted: true });
      }
      return result;
    },
    pending: () => pendingCount(activeOwner()),
    dispose() {
      if (retryTimer) cancelTimeout(retryTimer);
      retryTimer = null;
    },
  };

  if (ipcMain) {
    ipcMain.removeHandler('analyticsDashboard');
    ipcMain.handle('analyticsDashboard', (_event, queryValue) => service.dashboard(queryValue));
    ipcMain.removeHandler('analyticsCheckouts');
    ipcMain.handle('analyticsCheckouts', (_event, queryValue) => service.checkouts(queryValue));
    ipcMain.removeHandler('deleteAnalytics');
    ipcMain.handle('deleteAnalytics', () => service.deleteAll());
  }
  return service;
}

module.exports = {
  OUTBOX_FILE,
  CACHE_FILE,
  setService,
  record,
  createAnalyticsService,
  __test: { normalizeEvent, ownerKey, sanitizeQuery },
};
