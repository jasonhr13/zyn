const SCHEMA_VERSION = 1;
const MEASUREMENT = 'tls-client-wire';
const MAX_HISTORICAL_RUNS = 32;

const text = (value, maximum) => {
  const normalized = String(value == null ? '' : value).trim();
  return normalized && normalized.length <= maximum ? normalized : '';
};

const integer = (value, minimum = 0) => (
  Number.isSafeInteger(value) && value >= minimum ? value : null
);

const counterFields = Object.freeze([
  'downloadBytes',
  'uploadBytes',
  'totalBytes',
  'proxyDownloadBytes',
  'proxyUploadBytes',
  'directDownloadBytes',
  'directUploadBytes',
  'polls',
  'failedPolls',
]);

export function emptyTargetMonitorBandwidthState() {
  return { version: SCHEMA_VERSION, mainRunId: '', runs: {} };
}

export function isTargetLiveEditMonitor(monitorId) {
  const id = String(monitorId || '').trim().toLowerCase();
  return /(?:^|[^a-z0-9])(?:live-?)?edit(?:[^a-z0-9]|$)/.test(id);
}

// Main already validates this boundary, but the renderer treats telemetry as untrusted input too.
// Invalid counters are ignored rather than being coerced into a convincing-looking zero.
export function normalizeTargetMonitorBandwidth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || value.measurement !== MEASUREMENT) return null;

  const monitorId = text(value.monitorId, 160);
  const runId = text(value.runId, 160);
  const site = text(value.site, 80);
  const startedAt = integer(value.startedAt, 1);
  const observedAt = integer(value.observedAt, 1);
  const sequence = integer(value.sequence, 1);
  const watchedItems = integer(value.watchedItems, 0);
  if (!monitorId || !runId || site.toLowerCase() !== 'target'
    || startedAt == null || observedAt == null || observedAt < startedAt
    || sequence == null || watchedItems == null || typeof value.running !== 'boolean') return null;

  const counters = {};
  for (const field of counterFields) {
    const normalized = integer(value[field], 0);
    if (normalized == null) return null;
    counters[field] = normalized;
  }
  if (counters.totalBytes !== counters.downloadBytes + counters.uploadBytes
    || counters.downloadBytes !== counters.proxyDownloadBytes + counters.directDownloadBytes
    || counters.uploadBytes !== counters.proxyUploadBytes + counters.directUploadBytes
    || counters.failedPolls > counters.polls) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    measurement: MEASUREMENT,
    monitorId,
    runId,
    site: 'Target',
    startedAt,
    observedAt,
    sequence,
    running: value.running,
    watchedItems,
    ...counters,
  };
}

const validState = state => (
  state && state.version === SCHEMA_VERSION && state.runs && typeof state.runs === 'object'
    ? state : emptyTargetMonitorBandwidthState()
);

const countersAreMonotonic = (previous, next) => counterFields.every(field => next[field] >= previous[field]);

// Shared-monitor mode intentionally stops the main scan before later, short live-edit scans run.
// A live-edit run belongs to the latest main module session only when it starts with or after that
// main. An older edit can finish after a replacement main starts, but its earlier bytes must remain
// attached to the previous session.
const belongsToMainSession = (run, main) => (
  isTargetLiveEditMonitor(run.monitorId) && run.startedAt >= main.startedAt
);

function pruneRuns(runs, mainRunId) {
  const entries = Object.values(runs);
  const main = runs[mainRunId];
  if (!main) {
    if (entries.length <= MAX_HISTORICAL_RUNS) return runs;
    entries.sort((a, b) => Number(b.running) - Number(a.running)
      || b.observedAt - a.observedAt || b.startedAt - a.startedAt);
    const keep = new Set(entries.slice(0, MAX_HISTORICAL_RUNS).map(run => run.runId));
    return Object.fromEntries(entries.filter(run => keep.has(run.runId)).map(run => [run.runId, run]));
  }

  // Never prune a live-edit run that contributes to the selected main run. Doing so would make a
  // cumulative total fall after enough edits. Historical runs are bounded once a newer main run
  // makes them irrelevant, while the current run remains exact for its full lifetime.
  const current = entries.filter(run => run.runId === mainRunId
    || belongsToMainSession(run, main));
  const historical = entries.filter(run => !current.includes(run));
  if (historical.length <= MAX_HISTORICAL_RUNS) return runs;
  historical.sort((a, b) => Number(b.running) - Number(a.running)
    || b.observedAt - a.observedAt || b.startedAt - a.startedAt);
  const keep = new Set([
    ...current.map(run => run.runId),
    ...historical.slice(0, MAX_HISTORICAL_RUNS).map(run => run.runId),
  ]);
  return Object.fromEntries(entries.filter(run => keep.has(run.runId)).map(run => [run.runId, run]));
}

// Store the latest cumulative sample for each run. Replacing a sample instead of adding its values
// makes repeated heartbeats and retries idempotent.
export function reduceTargetMonitorBandwidth(state, value) {
  const current = validState(state);
  const incoming = normalizeTargetMonitorBandwidth(value);
  if (!incoming) return current;

  const previous = current.runs[incoming.runId];
  if (previous) {
    if (previous.monitorId !== incoming.monitorId || previous.startedAt !== incoming.startedAt
      || incoming.sequence <= previous.sequence || incoming.observedAt < previous.observedAt
      || (previous.running === false && (!previous.locallyStopped || incoming.running !== false))
      || !countersAreMonotonic(previous, incoming)) return current;
  }

  let mainRunId = current.mainRunId;
  if (!isTargetLiveEditMonitor(incoming.monitorId)) {
    const activeMain = current.runs[mainRunId];
    if (!activeMain || incoming.runId === mainRunId
      || incoming.startedAt > activeMain.startedAt
      || (incoming.startedAt === activeMain.startedAt && incoming.observedAt > activeMain.observedAt)) {
      mainRunId = incoming.runId;
    }
  }

  const runs = pruneRuns({ ...current.runs, [incoming.runId]: incoming }, mainRunId);
  return { version: SCHEMA_VERSION, mainRunId, runs };
}

// The process can disappear before its final sample reaches Electron. A module-level targetDone is
// authoritative liveness information, so freeze any active cumulative runs instead of showing a
// permanent “Measuring” badge. A later engine start uses a new run ID and is unaffected.
export function stopTargetMonitorBandwidthRuns(state) {
  const current = validState(state);
  let changed = false;
  const runs = Object.fromEntries(Object.entries(current.runs).map(([runId, run]) => {
    if (!run.running) return [runId, run];
    changed = true;
    return [runId, { ...run, running: false, locallyStopped: true }];
  }));
  return changed ? { ...current, runs } : current;
}

const intervalsOverlap = (left, right) => (
  left.startedAt <= right.observedAt && left.observedAt >= right.startedAt
);

const transferFields = Object.freeze([
  'proxyDownloadBytes',
  'directDownloadBytes',
  'proxyUploadBytes',
  'directUploadBytes',
]);

function aggregateTransfers(runs) {
  const result = Object.fromEntries(transferFields.map(field => [field, 0]));
  let total = 0;
  let saturated = false;
  for (const run of runs) {
    if (!run.totalBytes) continue;
    const remaining = Number.MAX_SAFE_INTEGER - total;
    if (run.totalBytes <= remaining) {
      for (const field of transferFields) result[field] += run[field];
      total += run.totalBytes;
      continue;
    }

    saturated = true;
    if (remaining <= 0) continue;
    const shares = transferFields.map(field => Math.floor(remaining * (run[field] / run.totalBytes)));
    let allocated = shares.reduce((sum, value) => sum + value, 0);
    let remainder = remaining - allocated;
    for (let index = 0; remainder > 0 && index < transferFields.length; index += 1) {
      if (run[transferFields[index]] <= 0) continue;
      shares[index] += 1;
      allocated += 1;
      remainder -= 1;
    }
    for (let index = 0; index < transferFields.length; index += 1) {
      result[transferFields[index]] += shares[index];
    }
    total += allocated;
  }
  return { ...result, totalBytes: total, saturated };
}

export function targetMonitorBandwidthSummary(state, now = Date.now()) {
  const current = validState(state);
  const runs = Object.values(current.runs).filter(run => normalizeTargetMonitorBandwidth(run));
  if (!runs.length) return { available: false };

  const main = current.runs[current.mainRunId];
  let included;
  if (main) {
    included = runs.filter(run => run.runId === main.runId
      || belongsToMainSession(run, main));
  } else {
    const anchor = runs.slice().sort((a, b) => b.startedAt - a.startedAt || b.observedAt - a.observedAt)[0];
    included = runs.filter(run => intervalsOverlap(run, anchor));
  }

  if (!included.length) return { available: false };
  const safeAdd = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
  const sum = field => included.reduce((total, run) => safeAdd(total, run[field]), 0);
  const startedAt = Math.min(...included.map(run => run.startedAt));
  const observedAt = Math.max(...included.map(run => run.observedAt));
  const running = included.some(run => run.running);
  const incomplete = !running && included.some(run => run.locallyStopped === true);
  const elapsedEnd = running ? Math.max(observedAt, Number(now) || observedAt) : observedAt;
  const elapsedHours = Math.max(1 / 3600, (elapsedEnd - startedAt) / 3600000);
  const transfers = aggregateTransfers(included);
  const {
    proxyDownloadBytes,
    proxyUploadBytes,
    directDownloadBytes,
    directUploadBytes,
    totalBytes,
    saturated,
  } = transfers;
  const downloadBytes = proxyDownloadBytes + directDownloadBytes;
  const uploadBytes = proxyUploadBytes + directUploadBytes;
  const proxyBytes = proxyDownloadBytes + proxyUploadBytes;
  const directBytes = directDownloadBytes + directUploadBytes;

  return {
    available: true,
    measurement: MEASUREMENT,
    running,
    incomplete,
    saturated,
    startedAt,
    observedAt,
    runCount: included.length,
    downloadBytes,
    uploadBytes,
    totalBytes,
    bytesPerHour: totalBytes / elapsedHours,
    proxyDownloadBytes,
    proxyUploadBytes,
    proxyBytes,
    directDownloadBytes,
    directUploadBytes,
    directBytes,
    polls: sum('polls'),
    failedPolls: sum('failedPolls'),
    watchedItems: main ? main.watchedItems : Math.max(...included.map(run => run.watchedItems)),
  };
}

export const TARGET_MONITOR_BANDWIDTH_TOOLTIP =
  'TLS transport bytes measured by the monitor engine. Includes encrypted HTTP traffic and TLS handshakes; excludes DNS, TCP/IP packet framing, and proxy CONNECT setup.';
