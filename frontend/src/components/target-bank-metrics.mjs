const count = (value) => Math.max(0, Number(value) || 0);

export function formatBandwidth(bytes) {
  let value = count(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function targetHarvesterBandwidth(runtime, now = Date.now()) {
  const raw = (runtime && runtime.bandwidth) || {};
  const downloadBytes = count(raw.downloadBytes);
  const uploadBytes = count(raw.uploadBytes);
  const totalBytes = count(raw.totalBytes || downloadBytes + uploadBytes);
  const proxyBytes = count(raw.proxyBytes);
  const directBytes = count(raw.directBytes);
  const cookies = count(raw.cookies);
  const startedAt = count(raw.startedAt || (runtime && runtime.startedAt));
  const elapsedHours = startedAt > 0 ? Math.max(1 / 3600, (count(now) - startedAt) / 3600000) : 0;
  return {
    available: raw.available === true,
    supported: raw.supported !== false,
    attempts: count(raw.attempts),
    cookies,
    downloadBytes,
    uploadBytes,
    totalBytes,
    proxyBytes,
    directBytes,
    proxyDownloadBytes: count(raw.proxyDownloadBytes),
    proxyUploadBytes: count(raw.proxyUploadBytes),
    directDownloadBytes: count(raw.directDownloadBytes),
    directUploadBytes: count(raw.directUploadBytes),
    proxyCookies: count(raw.proxyCookies),
    directCookies: count(raw.directCookies),
    requests: count(raw.requests),
    blockedRequests: count(raw.blockedRequests),
    cachedRequests: count(raw.cachedRequests),
    failedRequests: count(raw.failedRequests),
    proxyRequests: count(raw.proxyRequests),
    proxyBlockedRequests: count(raw.proxyBlockedRequests),
    proxyCachedRequests: count(raw.proxyCachedRequests),
    proxyFailedRequests: count(raw.proxyFailedRequests),
    unmeasuredAttempts: count(raw.unmeasuredAttempts),
    bytesPerHour: elapsedHours > 0 ? totalBytes / elapsedHours : 0,
    bytesPerCookie: cookies > 0 ? totalBytes / cookies : 0,
    byType: raw.byType || {},
  };
}

export function targetBandwidthSummary(harvesters, now = Date.now()) {
  const summary = {
    available: false,
    totalBytes: 0,
    proxyBytes: 0,
    directBytes: 0,
    proxyDownloadBytes: 0,
    proxyUploadBytes: 0,
    proxyCookies: 0,
    requests: 0,
    blockedRequests: 0,
    cachedRequests: 0,
    failedRequests: 0,
    unmeasuredAttempts: 0,
    bytesPerHour: 0,
    bytesPerProxyCookie: 0,
  };
  for (const runtime of Array.isArray(harvesters) ? harvesters : []) {
    const item = targetHarvesterBandwidth(runtime, now);
    summary.available = summary.available || item.available;
    summary.totalBytes += item.totalBytes;
    summary.proxyBytes += item.proxyBytes;
    summary.directBytes += item.directBytes;
    summary.proxyDownloadBytes += item.proxyDownloadBytes;
    summary.proxyUploadBytes += item.proxyUploadBytes;
    summary.proxyCookies += item.proxyCookies;
    summary.requests += item.proxyRequests;
    summary.blockedRequests += item.proxyBlockedRequests;
    summary.cachedRequests += item.proxyCachedRequests;
    summary.failedRequests += item.proxyFailedRequests;
    summary.unmeasuredAttempts += item.unmeasuredAttempts;
    summary.bytesPerHour += item.proxyBytes && item.totalBytes
      ? item.bytesPerHour * (item.proxyBytes / item.totalBytes) : 0;
  }
  summary.bytesPerProxyCookie = summary.proxyCookies > 0
    ? summary.proxyBytes / summary.proxyCookies : 0;
  return summary;
}

const FAILURE_LABELS = {
  target_block: 'Target block',
  captcha: 'Captcha',
  queue: 'Waiting room',
  proxy: 'Proxy',
  signature: 'Signature',
  navigation: 'Navigation',
  timeout: 'Timeout',
  page: 'Page',
  browser: 'Browser',
  unknown: 'Unknown',
};

// Keeping status normalization in one place lets this renderer accept
// the compact recovered broker payload today and the richer activity/health payload without another
// UI rewrite when the JavaScript farmer is updated later.
export function targetBankMetrics(bank) {
  const online = !!bank;
  const health = (bank && bank.health) || {};
  const activity = (bank && bank.activity) || {};
  const scaling = health.scaling || {};
  const failures = health.failures || {};
  const backpressure = health.backpressure || {};
  const categories = failures.byCategory || {};
  const leadingFailure = Object.entries(categories)
    .map(([category, value]) => ({ category, count: count(value) }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count)[0] || null;
  const recentSamples = count(scaling.recentSamples);
  const recentErrors = count(scaling.recentErrors);
  const decisionSamples = count(scaling.decisionSamples);
  const decisionErrors = count(scaling.decisionErrors);
  const lastDownscale = scaling.lastDownscale || {};
  const recovery = scaling.recovery || {};
  const lastUpscale = recovery.lastUpscale || {};
  const scheduling = scaling.scheduling || {};
  const browsers = Array.isArray(health.browsers) ? health.browsers : [];
  const activeBrowsers = browsers.filter(browser => count(browser && browser.activeWorkers) > 0);
  const recentErrorRate = Number.isFinite(Number(scaling.recentErrorRate))
    ? Math.max(0, Math.min(1, Number(scaling.recentErrorRate)))
    : recentSamples ? Math.min(1, recentErrors / recentSamples) : 0;

  return {
    online,
    login: count(bank && bank.login),
    atc: count(bank && bank.atc),
    proxies: count(bank && bank.proxies),
    farmedAtc: count(activity.produced && activity.produced.atc != null
      ? activity.produced.atc
      : health.successes && health.successes.atc),
    deliveredAtc: count(activity.delivered && activity.delivered.atc),
    waitingAtc: count(activity.waiting && activity.waiting.atc),
    inFlightAtc: count(bank && bank.inFlight && bank.inFlight.atc),
    activeWorkers: count(health.activeWorkers),
    busyWorkers: count(health.busyWorkers),
    configuredWorkers: count(health.configuredWorkers),
    workerLimit: count(scaling.desiredWorkers || scaling.hardLimit || health.configuredWorkers),
    workerState: String(health.workerState || (online && bank && bank.health && !count(health.configuredWorkers)
      && !browsers.length && String((health.browser && health.browser.mode) || '') !== 'broker-only'
      ? 'detecting' : '')),
    workerPolicy: String(scaling.policy || 'adaptive'),
    failureTotal: count(failures.total),
    quarantinedProxies: count(health.quarantinedProxies),
    localizedFailures: count(backpressure.localizedFailures),
    leadingFailure: leadingFailure && {
      ...leadingFailure,
      label: FAILURE_LABELS[leadingFailure.category] || leadingFailure.category,
    },
    recentSamples,
    recentErrors,
    recentErrorPercent: Math.round(recentErrorRate * 100),
    decisionSamples,
    decisionErrors,
    distinctPressureSources: count(scaling.distinctPressureSources),
    requiredDistinctPressureSources: count(scaling.requiredDistinctPressureSources),
    scaleDowns: count(scaling.scaleDowns),
    lastScaleDownReason: String(lastDownscale.reason || ''),
    recoveryActive: recovery.active === true,
    recoveryEligibleSec: Math.ceil(count(recovery.eligibleInMs) / 1000),
    recoverySuccesses: count(recovery.successes),
    requiredRecoverySuccesses: count(recovery.requiredSuccesses),
    recoveryHealthySources: count(recovery.distinctHealthySources),
    requiredRecoverySources: count(recovery.requiredDistinctSources),
    recoveryScaleUps: count(recovery.scaleUps),
    lastScaleUpReason: String(lastUpscale.reason || ''),
    schedulerSlots: count(scheduling.slotCount),
    browserRotations: count(scheduling.rotations),
    activeBrowserCount: activeBrowsers.length,
    activeBrowserMix: activeBrowsers.map(browser =>
      `${String(browser.label || browser.key || 'Browser')} ${count(browser.activeWorkers)}`).join(', '),
    atcCooldownSec: Math.ceil(count(health.cooldowns && health.cooldowns.atc && health.cooldowns.atc.remainingMs) / 1000),
    browserMode: String((health.browser && health.browser.mode) || ''),
    startedAt: count(activity.startedAt),
    lastBankedAt: count(bank && bank.lastBankedAt),
  };
}

const scheduleState = (harvester, now) => {
  if (!harvester || !harvester.enabled) return 'stopped';
  const startsAt = harvester.startSchedule ? Date.parse(harvester.startSchedule) : NaN;
  const stopsAt = harvester.stopSchedule ? Date.parse(harvester.stopSchedule) : NaN;
  if (Number.isFinite(startsAt) && now < startsAt) return 'scheduled';
  if (Number.isFinite(stopsAt) && now >= stopsAt) return 'stopped';
  return 'running';
};

// The broker can stay online while every producer is stopped, so broker reachability must not be
// presented as harvester activity. This view model combines the shared pool with the authoritative
// harvester configuration and lets a stopped configuration override a briefly stale runtime report.
export function targetBankPresentation(bank, harvesters = [], options = {}) {
  const metrics = targetBankMetrics(bank);
  const now = Number(options.now) || Date.now();
  const configured = Array.isArray(harvesters) ? harvesters : [];
  const runtimes = bank && Array.isArray(bank.harvesters) ? bank.harvesters : [];
  let activeHarvesters = 0;
  let activeWorkers = 0;
  let scheduledHarvesters = 0;

  for (const harvester of configured) {
    const state = scheduleState(harvester, now);
    if (state === 'scheduled') {
      scheduledHarvesters += 1;
      continue;
    }
    if (state !== 'running') continue;
    activeHarvesters += 1;
    const runtime = runtimes.find(item => String(item && item.id) === String(harvester.id));
    activeWorkers += count(runtime && runtime.activeWorkers);
  }

  const bankedCookies = metrics.login + metrics.atc;
  const requestedAt = count(options.brokerStartRequestedAt);
  const waitingForBroker = !metrics.online
    && (activeHarvesters > 0 || options.checkoutRunning === true || requestedAt > 0);
  const brokerTimedOut = waitingForBroker && requestedAt > 0 && now - requestedAt >= 45000;
  let state;
  let label;
  let description;

  if (!metrics.online) {
    state = brokerTimedOut ? 'error' : waitingForBroker ? 'starting' : 'offline';
    label = brokerTimedOut ? 'Broker failed to start' : waitingForBroker ? 'Starting broker' : 'Broker offline';
    description = brokerTimedOut
      ? 'The cookie broker did not answer within 45 seconds. Check Engine & Monitor Log for the startup error.'
      : waitingForBroker
        ? 'Opening the shared cookie bank for Target tasks and harvesters.'
        : 'Start a Target task or harvester to open the shared cookie bank.';
  } else if (bankedCookies > 0) {
    state = 'ready';
    label = 'Cookies ready';
    description = `${metrics.login} login and ${metrics.atc} ATC cookies available from all harvesters. `
      + (activeHarvesters > 0
        ? `${activeHarvesters} harvester${activeHarvesters === 1 ? '' : 's'} running.`
        : 'Harvesters are stopped; banked cookies remain available until they expire.');
  } else if (activeHarvesters > 0) {
    state = 'working';
    label = activeWorkers > 0 ? 'Harvesting' : 'Starting harvesters';
    description = activeWorkers > 0
      ? 'The shared bank is empty. Running harvesters will add cookies here as they succeed.'
      : 'The shared bank is empty. Enabled harvesters are starting or detecting their browsers.';
  } else if (scheduledHarvesters > 0) {
    state = 'scheduled';
    label = 'Waiting for schedule';
    description = 'The shared bank is empty. No harvester is running yet; the next one is scheduled.';
  } else {
    state = 'stopped';
    label = configured.length ? 'Harvesters stopped' : 'No harvesters';
    description = configured.length
      ? 'The shared bank is empty. All harvesters are stopped; open the Harvesters sidebar to start one.'
      : 'The shared bank is empty. Open the Harvesters sidebar to create one.';
  }

  return {
    ...metrics,
    state,
    label,
    description,
    brokerLabel: metrics.online ? 'Broker online' : state === 'starting' ? 'Broker starting' : 'Broker offline',
    activeHarvesters,
    activeWorkers,
    scheduledHarvesters,
    bankedCookies,
  };
}

export function sameTargetBank(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
