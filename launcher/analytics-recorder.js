'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUTBOX_FILE = 'analytics-outbox.json';
const CACHE_FILE = 'analytics-cache.json';
const TELEMETRY_FILE = 'task-telemetry-outbox.json';
const MAX_OUTBOX_EVENTS = 2000;
const BATCH_SIZE = 20;
const RETRY_MS = 30000;
// Task telemetry is high volume (every cart attempt), so it is rolled up locally into hourly
// buckets and uploaded as counters once a minute rather than as one row per event.
const TELEMETRY_BUCKET_MS = 60 * 60 * 1000;
const TELEMETRY_FLUSH_MS = 60 * 1000;
const TELEMETRY_SAVE_MS = 5 * 1000;
const TELEMETRY_MAX_BUCKETS = 4000;
const TELEMETRY_MAX_BATCHES = 48;
const TELEMETRY_EVENTS = new Set([
  'cart_attempt', 'carted', 'checkout', 'decline', 'shape_ready', 'shape_unavailable',
  'shape_block_login', 'shape_block_cart', 'shape_block_precart', 'shape_soft_block',
  'dco_rate_limited', 'rate_limited_429', 'passed_queue',
]);

let configuredService = null;

function setService(service) {
  configuredService = service && typeof service.record === 'function' ? service : null;
}

function record(event) {
  if (!configuredService) return false;
  return configuredService.record(event);
}

function recordTelemetry(event) {
  if (!configuredService || typeof configuredService.recordTelemetry !== 'function') return false;
  return configuredService.recordTelemetry(event);
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
    account: text(value.account, 254),
    profile: text(value.profile, 160),
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

function telemetrySite(value) {
  const compact = text(value, 80).toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'target') return 'Target';
  if (['pokemoncenter', 'pokemoncenterus'].includes(compact)) return 'Pokemon Center US';
  if (compact === 'walmart') return 'Walmart';
  return '';
}

function telemetryLabel(value) {
  return text(value, 80).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeTelemetryEvent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = telemetryLabel(value.event);
  const site = telemetrySite(value.site);
  if (!TELEMETRY_EVENTS.has(event) || !site) return null;
  const occurredAt = integer(value.occurredAt, 0, now + 5 * 60 * 1000, now);
  return {
    event,
    site,
    step: telemetryLabel(value.step),
    shapeMethod: telemetryLabel(value.shapeMethod),
    cookieType: telemetryLabel(value.cookieType),
    cookieAgeMs: integer(value.cookieAgeMs, 0, 7 * 24 * 60 * 60 * 1000, 0),
    engineVersion: text(value.engineVersion, 40),
    appVersion: text(value.appVersion, 40),
    bucketStart: Math.floor(occurredAt / TELEMETRY_BUCKET_MS) * TELEMETRY_BUCKET_MS,
  };
}

function telemetryBucketKey(event) {
  return [
    event.bucketStart, event.site, event.event, event.step, event.shapeMethod,
    event.cookieType, event.engineVersion, event.appVersion,
  ].join('\u0000');
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
  appVersion = '',
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
  const telemetryPath = path.join(dataDirectory, TELEMETRY_FILE);
  let outbox = readJson(outboxPath, { version: 1, entries: [] });
  if (!Array.isArray(outbox.entries)) outbox = { version: 1, entries: [] };
  let cache = readJson(cachePath, { version: 1, owners: {} });
  if (!cache.owners || typeof cache.owners !== 'object') cache = { version: 1, owners: {} };
  let flushInFlight = null;
  let retryTimer = null;
  let telemetry = readJson(telemetryPath, { version: 1, pending: {}, batches: [] });
  if (!telemetry.pending || typeof telemetry.pending !== 'object') telemetry.pending = {};
  if (!Array.isArray(telemetry.batches)) telemetry.batches = [];
  telemetry.batches = telemetry.batches.filter(batch => batch && typeof batch.owner === 'string'
    && typeof batch.batchId === 'string' && Array.isArray(batch.buckets));
  let telemetryDirty = false;
  let telemetrySaveTimer = null;
  let telemetryFlushTimer = null;
  let telemetryInFlight = null;

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

  const saveTelemetry = () => {
    telemetryDirty = false;
    try { atomicWrite(telemetryPath, telemetry); }
    catch (error) { logger.warn?.(`[analytics] save telemetry: ${error.message}`); }
  };
  const scheduleTelemetrySave = () => {
    telemetryDirty = true;
    if (telemetrySaveTimer) return;
    telemetrySaveTimer = scheduleTimeout(() => {
      telemetrySaveTimer = null;
      if (telemetryDirty) saveTelemetry();
    }, TELEMETRY_SAVE_MS);
    if (telemetrySaveTimer && typeof telemetrySaveTimer.unref === 'function') telemetrySaveTimer.unref();
  };
  const scheduleTelemetryFlush = (delay = TELEMETRY_FLUSH_MS) => {
    if (telemetryFlushTimer) return;
    telemetryFlushTimer = scheduleTimeout(() => {
      telemetryFlushTimer = null;
      flushTelemetry().catch(() => {});
    }, delay);
    if (telemetryFlushTimer && typeof telemetryFlushTimer.unref === 'function') telemetryFlushTimer.unref();
  };
  const telemetryPending = owner => Object.keys((owner && telemetry.pending[owner]) || {}).length
    + telemetry.batches.filter(batch => batch.owner === owner).reduce((sum, batch) => sum + batch.buckets.length, 0);

  // Seal the owner's pending buckets into an idempotent batch. A batch keeps its id across
  // retries so the service can ignore a replay whose response was lost.
  function sealTelemetry(owner) {
    const buckets = Object.values(telemetry.pending[owner] || {});
    if (!buckets.length) return;
    delete telemetry.pending[owner];
    telemetry.batches.push({ owner, batchId: crypto.randomUUID(), buckets });
    if (telemetry.batches.length > TELEMETRY_MAX_BATCHES) {
      telemetry.batches.splice(0, telemetry.batches.length - TELEMETRY_MAX_BATCHES);
    }
  }

  async function flushTelemetry() {
    if (telemetryInFlight) return telemetryInFlight;
    const owner = activeOwner();
    if (!owner) return { ok: false, pending: 0 };
    sealTelemetry(owner);
    const batch = telemetry.batches.find(entry => entry.owner === owner);
    if (!batch) {
      if (telemetryDirty) saveTelemetry();
      return { ok: true, pending: 0 };
    }
    saveTelemetry();
    telemetryInFlight = (async () => {
      const result = await authority.recordTaskTelemetry({ batchId: batch.batchId, buckets: batch.buckets });
      // A 4xx other than auth or throttling means the service rejected the batch shape;
      // retrying cannot fix it, so drop the batch instead of wedging the queue.
      const status = Number(result && result.status) || 0;
      const rejected = !(result && result.ok === true) && status >= 400 && status < 500
        && status !== 401 && status !== 429;
      if ((result && result.ok === true) || rejected) {
        if (rejected) logger.warn?.(`[analytics] telemetry batch rejected: ${result.message || status}`);
        telemetry.batches = telemetry.batches.filter(entry => entry.batchId !== batch.batchId);
        saveTelemetry();
        if (telemetry.batches.some(entry => entry.owner === owner)) scheduleTelemetryFlush(0);
      } else {
        scheduleTelemetryFlush();
      }
      return { ...(result || {}), pending: telemetryPending(owner) };
    })();
    try { return await telemetryInFlight; } finally { telemetryInFlight = null; }
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
    telemetryPath,
    recordTelemetry(value) {
      const owner = activeOwner();
      const event = normalizeTelemetryEvent(value, now());
      if (!event || !owner) return false;
      if (!event.appVersion) event.appVersion = text(appVersion, 40);
      const pending = telemetry.pending[owner] || (telemetry.pending[owner] = {});
      const key = telemetryBucketKey(event);
      let bucket = pending[key];
      if (!bucket) {
        if (Object.keys(pending).length >= TELEMETRY_MAX_BUCKETS) return false;
        bucket = pending[key] = {
          bucketStart: event.bucketStart, site: event.site, event: event.event, step: event.step,
          shapeMethod: event.shapeMethod, cookieType: event.cookieType,
          engineVersion: event.engineVersion, appVersion: event.appVersion,
          count: 0, cookieAgeMsTotal: 0, cookieAgeSamples: 0,
        };
      }
      bucket.count += 1;
      if (event.cookieAgeMs > 0) {
        bucket.cookieAgeMsTotal += event.cookieAgeMs;
        bucket.cookieAgeSamples += 1;
      }
      scheduleTelemetrySave();
      scheduleTelemetryFlush();
      return true;
    },
    flushTelemetry,
    telemetryPending: () => telemetryPending(activeOwner()),
    sessionChanged() {
      flush().catch(() => {});
      flushTelemetry().catch(() => {});
    },
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
      if (telemetrySaveTimer) cancelTimeout(telemetrySaveTimer);
      telemetrySaveTimer = null;
      if (telemetryFlushTimer) cancelTimeout(telemetryFlushTimer);
      telemetryFlushTimer = null;
      if (telemetryDirty) saveTelemetry();
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
  TELEMETRY_FILE,
  TELEMETRY_EVENTS,
  setService,
  record,
  recordTelemetry,
  createAnalyticsService,
  __test: { normalizeEvent, normalizeTelemetryEvent, telemetryBucketKey, ownerKey, sanitizeQuery },
};
