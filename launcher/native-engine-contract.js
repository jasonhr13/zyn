'use strict';

// Protocol v1 preserves the recovered Go engine's existing `{ type, messages: [] }` envelope.
// New sites and message kinds are additive so already-packaged Target binaries remain compatible.
const PROTOCOL_VERSION = 1;

const SITES = Object.freeze({
  TARGET: 'Target',
  POKEMON_CENTER_US: 'Pokemon Center US',
});

const SITE_KEYS = Object.freeze({
  [SITES.TARGET]: 'target',
  [SITES.POKEMON_CENTER_US]: 'pokemoncenter',
});

const TO_ENGINE = Object.freeze([
  'send-configs', 'start-tasks', 'start-monitors', 'stop-tasks', 'edit-tasks',
  'stock-ping', 'set-task-proxy', 'received-code', 'code-watcher-ready', 'received-token',
  // Reserved for the server-side Hyper broker; this message never carries the Hyper API key.
  'hyper-response',
]);

const FROM_ENGINE = Object.freeze([
  'update-status', 'update-input', 'task-log', 'task-notification', 'product',
  'product-titles', 'request-code', 'account-cookie', 'account-password', 'solve-captcha',
  'analytics-event', 'monitor-bandwidth',
  // Reserved for the server-side Hyper broker.
  'hyper-request',
]);

const HYPER_OPERATIONS = Object.freeze([
  'reese84', 'datadome-tags', 'datadome-interstitial', 'datadome-slider', 'incapsula-utmvc',
]);

const SITE_ALIASES = new Map([
  ['target', SITES.TARGET],
  ['pokemon center', SITES.POKEMON_CENTER_US],
  ['pokemon center us', SITES.POKEMON_CENTER_US],
  ['pokemoncenter', SITES.POKEMON_CENTER_US],
  ['pokemoncenter us', SITES.POKEMON_CENTER_US],
  ['pokemoncenterus', SITES.POKEMON_CENTER_US],
  ['pokemon-center', SITES.POKEMON_CENTER_US],
  ['pokemon-center-us', SITES.POKEMON_CENTER_US],
  ['pcus', SITES.POKEMON_CENTER_US],
]);

function nonEmpty(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function canonicalSite(value, { required = true } = {}) {
  const raw = String(value == null ? '' : value).trim();
  const site = SITE_ALIASES.get(raw.toLowerCase()) || '';
  if (!site && required) throw new Error(`unsupported native-engine site: ${raw || '<empty>'}`);
  return site;
}

function siteKey(value, options) {
  const site = canonicalSite(value, options);
  return site ? SITE_KEYS[site] : '';
}

// Existing commands use id, most events use taskID, and captcha uses taskId. Keep those names on
// the wire and normalize only for Electron's internal routing.
function taskIdOf(message) {
  if (!message || typeof message !== 'object') return '';
  return String(message.taskID || message.taskId || message.id || '').trim();
}

function createEnvelope(type, messages) {
  const messageType = nonEmpty(type, 'native-engine message type');
  if (!Array.isArray(messages)) throw new Error(`native-engine ${messageType} messages must be an array`);
  return { type: messageType, messages };
}

function parseEnvelope(input) {
  let value = input;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = Buffer.from(value).toString('utf8');
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native-engine envelope must be an object');
  }
  return createEnvelope(value.type, value.messages);
}

function normalizeStartTask(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('native-engine start task must be an object');
  }
  const id = nonEmpty(message.id, 'native-engine task id');
  const site = canonicalSite(message.site || message.type);
  const queueEntryDelay = message.QueueEntryDelay == null
    ? (message.queueEntryDelay == null ? '0' : message.queueEntryDelay)
    : message.QueueEntryDelay;
  const normalized = {
    ...message,
    id,
    type: site,
    site,
    // The recovered Go schema uses this capitalized JSON key. Keep it exact.
    QueueEntryDelay: String(queueEntryDelay),
  };
  delete normalized.queueEntryDelay;
  return normalized;
}

const MONITOR_BANDWIDTH_SCHEMA_VERSION = 1;
const MONITOR_BANDWIDTH_MEASUREMENT = 'tls-client-wire';
const MONITOR_BANDWIDTH_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const MONITOR_BANDWIDTH_FUTURE_SKEW_MS = 5 * 60 * 1000;

function monitorBandwidthIdentifier(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const identifier = value.trim();
  if (!MONITOR_BANDWIDTH_ID.test(identifier)) throw new Error(`${label} is invalid`);
  return identifier;
}

function monitorBandwidthInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
  }
  return value;
}

function monitorBandwidthSum(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds the safe integer range`);
  return total;
}

// Monitor bandwidth is deliberately a narrow aggregate. Unknown keys are discarded so a native
// engine can never smuggle request URLs, headers, cookies, proxy credentials, or product inputs to
// the renderer alongside otherwise-valid counters.
function normalizeMonitorBandwidth(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native monitor bandwidth must be an object');
  }
  if (value.schemaVersion !== MONITOR_BANDWIDTH_SCHEMA_VERSION) {
    throw new Error('native monitor bandwidth schema version is unsupported');
  }
  if (value.measurement !== MONITOR_BANDWIDTH_MEASUREMENT) {
    throw new Error('native monitor bandwidth measurement is unsupported');
  }
  if (typeof value.site !== 'string' || canonicalSite(value.site) !== SITES.TARGET) {
    throw new Error('native monitor bandwidth site must be Target');
  }

  const startedAt = monitorBandwidthInteger(value.startedAt, 'monitor startedAt', { positive: true });
  const observedAt = monitorBandwidthInteger(value.observedAt, 'monitor observedAt', { positive: true });
  const currentTime = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  if (observedAt < startedAt) throw new Error('monitor observedAt precedes startedAt');
  if (observedAt > currentTime + MONITOR_BANDWIDTH_FUTURE_SKEW_MS) {
    throw new Error('monitor observedAt is too far in the future');
  }
  if (typeof value.running !== 'boolean') throw new Error('monitor running must be a boolean');

  const proxyDownloadBytes = monitorBandwidthInteger(value.proxyDownloadBytes, 'proxyDownloadBytes');
  const proxyUploadBytes = monitorBandwidthInteger(value.proxyUploadBytes, 'proxyUploadBytes');
  const directDownloadBytes = monitorBandwidthInteger(value.directDownloadBytes, 'directDownloadBytes');
  const directUploadBytes = monitorBandwidthInteger(value.directUploadBytes, 'directUploadBytes');
  const downloadBytes = monitorBandwidthSum(proxyDownloadBytes, directDownloadBytes, 'downloadBytes');
  const uploadBytes = monitorBandwidthSum(proxyUploadBytes, directUploadBytes, 'uploadBytes');
  const totalBytes = monitorBandwidthSum(downloadBytes, uploadBytes, 'totalBytes');
  if (value.downloadBytes !== downloadBytes
      || value.uploadBytes !== uploadBytes
      || value.totalBytes !== totalBytes) {
    throw new Error('native monitor bandwidth totals do not match their components');
  }

  const polls = monitorBandwidthInteger(value.polls, 'polls');
  const failedPolls = monitorBandwidthInteger(value.failedPolls, 'failedPolls');
  if (failedPolls > polls) throw new Error('failedPolls cannot exceed polls');

  return {
    schemaVersion: MONITOR_BANDWIDTH_SCHEMA_VERSION,
    measurement: MONITOR_BANDWIDTH_MEASUREMENT,
    monitorId: monitorBandwidthIdentifier(value.monitorId, 'monitorId'),
    runId: monitorBandwidthIdentifier(value.runId, 'runId'),
    site: SITES.TARGET,
    startedAt,
    observedAt,
    sequence: monitorBandwidthInteger(value.sequence, 'sequence', { positive: true }),
    running: value.running,
    downloadBytes,
    uploadBytes,
    totalBytes,
    proxyDownloadBytes,
    proxyUploadBytes,
    directDownloadBytes,
    directUploadBytes,
    polls,
    failedPolls,
    watchedItems: monitorBandwidthInteger(value.watchedItems, 'watchedItems'),
  };
}

class TaskSiteRegistry {
  constructor() {
    this.sites = new Map();
  }

  register(taskOrId, requestedSite) {
    const message = taskOrId && typeof taskOrId === 'object' ? taskOrId : null;
    const id = nonEmpty(message ? taskIdOf(message) : taskOrId, 'native-engine task id');
    const site = canonicalSite(requestedSite || (message && (message.site || message.siteName || message.type)));
    const existing = this.sites.get(id);
    if (existing && existing !== site) {
      throw new Error(`native-engine task ${id} is already registered to ${existing}`);
    }
    this.sites.set(id, site);
    return site;
  }

  registerStarts(messages) {
    return messages.map(message => {
      const normalized = normalizeStartTask(message);
      this.register(normalized);
      return normalized;
    });
  }

  resolve(message, fallback = '') {
    const explicit = canonicalSite(message && (message.site || message.siteName), { required: false });
    if (explicit) return explicit;
    const id = taskIdOf(message);
    if (id && this.sites.has(id)) return this.sites.get(id);
    return canonicalSite(fallback, { required: false });
  }

  remove(taskOrId) {
    const id = taskIdOf(taskOrId) || String(taskOrId == null ? '' : taskOrId).trim();
    return id ? this.sites.delete(id) : false;
  }

  clear() {
    this.sites.clear();
  }

  snapshot() {
    return Object.fromEntries(this.sites);
  }
}

function buildReceivedToken({ taskId, token, site = '' }) {
  const message = {
    taskId: nonEmpty(taskId, 'captcha task id'),
    token: String(token == null ? '' : token),
  };
  const canonical = canonicalSite(site, { required: false });
  if (canonical) message.site = canonical;
  return createEnvelope('received-token', [message]);
}

function assertNoHyperSecret(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:hyperApiKey|apiKey|x-api-key)$/i.test(key)) {
      throw new Error('Hyper credentials must not cross the native-engine bridge');
    }
    assertNoHyperSecret(child);
  }
}

function buildHyperRequest({ requestId, taskId, site, operation, payload }) {
  const op = nonEmpty(operation, 'Hyper operation');
  if (!HYPER_OPERATIONS.includes(op)) throw new Error(`unsupported Hyper operation: ${op}`);
  assertNoHyperSecret(payload);
  return createEnvelope('hyper-request', [{
    requestId: nonEmpty(requestId, 'Hyper request id'),
    taskId: nonEmpty(taskId, 'Hyper task id'),
    site: canonicalSite(site),
    operation: op,
    payload,
  }]);
}

function buildHyperResponse({ requestId, taskId, site, ok, status = 0, body = '', error = '' }) {
  return createEnvelope('hyper-response', [{
    requestId: nonEmpty(requestId, 'Hyper request id'),
    taskId: nonEmpty(taskId, 'Hyper task id'),
    site: canonicalSite(site),
    ok: ok === true,
    status: Number.isFinite(Number(status)) ? Number(status) : 0,
    body: String(body == null ? '' : body),
    error: String(error == null ? '' : error),
  }]);
}

module.exports = {
  PROTOCOL_VERSION,
  SITES,
  SITE_KEYS,
  TO_ENGINE,
  FROM_ENGINE,
  HYPER_OPERATIONS,
  canonicalSite,
  siteKey,
  taskIdOf,
  createEnvelope,
  parseEnvelope,
  normalizeStartTask,
  normalizeMonitorBandwidth,
  TaskSiteRegistry,
  buildReceivedToken,
  buildHyperRequest,
  buildHyperResponse,
};
