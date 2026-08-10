// Adaptive browser selection for the Shape farmer. Browser processes still start with an even
// round-robin distribution; after a short exploration phase, new sessions favor the browser that
// produces the strongest mix of successful cookies, cookie yield, proxy-byte efficiency, and
// successful-page latency. A browser can never consume every worker, so live changes continue to
// receive enough exploration traffic to recover.

const count = value => Math.max(0, Number(value) || 0);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const ratio = (numerator, denominator, fallback = 0) => denominator > 0 ? numerator / denominator : fallback;

function uniqueBrowsers(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).filter(browser => {
    const key = String(browser && browser.key || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(browser => ({ ...browser, key: String(browser.key) }));
}

export function createShapeBrowserOptimizer({
  browsers = [],
  workerCount = 1,
  minimumSamples = 3,
  maximumBrowserShare = 0.6,
  explorationWeight = 0.2,
  concurrencyPenalty = 0.12,
  now = () => Date.now(),
} = {}) {
  const candidates = uniqueBrowsers(browsers);
  if (!candidates.length) throw new Error('Browser optimizer requires at least one detected browser');
  const browserByKey = new Map(candidates.map(browser => [browser.key, browser]));
  const configuredWorkers = Math.max(1, Math.floor(count(workerCount) || 1));
  const sampleFloor = Math.max(1, Math.floor(count(minimumSamples) || 1));
  const shareCeiling = candidates.length === 1 || configuredWorkers === 1
    ? configuredWorkers
    : Math.min(configuredWorkers - 1,
      Math.max(1, Math.ceil(configuredWorkers * clamp(Number(maximumBrowserShare) || 0.6, 0.2, 0.9))));
  const leases = new Map();
  const metrics = new Map(candidates.map((browser, index) => [browser.key, {
    key: browser.key,
    label: browser.label || browser.key,
    order: index,
    attempts: 0,
    decisionAttempts: 0,
    excludedProxyFailures: 0,
    successes: 0,
    failures: 0,
    cookies: 0,
    decisionCookies: 0,
    measuredAttempts: 0,
    totalBytes: 0,
    decisionMeasuredAttempts: 0,
    decisionMeasuredBytes: 0,
    decisionMeasuredCookies: 0,
    durationMs: 0,
    successfulDurationMs: 0,
    activeWorkers: 0,
    selections: 0,
    lastSelectedAt: 0,
    lastSuccessAt: 0,
    failuresByCategory: {},
  }]));
  let selectionCount = 0;
  let lastSelection = null;

  const rankedMetrics = () => {
    const values = [...metrics.values()];
    const yields = values.map(item => ratio(item.decisionCookies, item.decisionAttempts));
    const bestYield = Math.max(0, ...yields);
    const bytesPerCookieValues = values
      .filter(item => item.decisionMeasuredAttempts > 0 && item.decisionMeasuredCookies > 0)
      .map(item => item.decisionMeasuredBytes / item.decisionMeasuredCookies);
    const bestBytesPerCookie = bytesPerCookieValues.length ? Math.min(...bytesPerCookieValues) : 0;
    const successfulDurations = values.filter(item => item.successes > 0)
      .map(item => item.successfulDurationMs / item.successes).filter(value => value > 0);
    const bestDurationMs = successfulDurations.length ? Math.min(...successfulDurations) : 0;
    const totalDecisionAttempts = values.reduce((sum, item) => sum + item.decisionAttempts, 0);

    return values.map(item => {
      const successRate = ratio(item.successes, item.decisionAttempts);
      // A one-success/one-failure prior prevents a tiny sample from immediately dominating.
      const smoothedSuccess = (item.successes + 1) / (item.decisionAttempts + 2);
      const cookieYield = ratio(item.decisionCookies, item.decisionAttempts);
      const yieldScore = bestYield > 0 ? clamp(cookieYield / bestYield, 0, 1) : 0;
      const decisionBytesPerCookie = item.decisionMeasuredCookies > 0
        ? item.decisionMeasuredBytes / item.decisionMeasuredCookies : 0;
      const bandwidthScore = item.decisionMeasuredAttempts === 0
        ? 0.5
        : decisionBytesPerCookie > 0 && bestBytesPerCookie > 0
          ? clamp(bestBytesPerCookie / decisionBytesPerCookie, 0, 1)
          : 0;
      const successfulAverageMs = item.successes > 0
        ? item.successfulDurationMs / item.successes : 0;
      const speedScore = successfulAverageMs > 0 && bestDurationMs > 0
        ? clamp(bestDurationMs / successfulAverageMs, 0, 1) : 0;
      const qualityScore = 0.45 * smoothedSuccess
        + 0.20 * yieldScore
        + 0.25 * bandwidthScore
        + 0.10 * speedScore;
      const explorationBonus = Number(explorationWeight) * Math.sqrt(
        Math.log(totalDecisionAttempts + 2) / (item.decisionAttempts + 1),
      );
      const activePenalty = Number(concurrencyPenalty) * ratio(item.activeWorkers, configuredWorkers);
      return {
        ...item,
        successRate,
        cookieYield,
        bytesPerCookie: item.cookies > 0 ? item.totalBytes / item.cookies : 0,
        decisionBytesPerCookie,
        averageDurationMs: ratio(item.durationMs, item.attempts),
        successfulAverageMs,
        qualityScore,
        selectionScore: qualityScore + explorationBonus - activePenalty,
      };
    });
  };

  const chooseBrowser = () => {
    let ranked = rankedMetrics();
    const belowShareCeiling = ranked.filter(item => item.activeWorkers < shareCeiling);
    if (belowShareCeiling.length) ranked = belowShareCeiling;
    const exploring = ranked.filter(item => item.decisionAttempts < sampleFloor);
    const pool = exploring.length ? exploring : ranked;
    pool.sort((left, right) => exploring.length
      ? left.decisionAttempts - right.decisionAttempts
        || left.activeWorkers - right.activeWorkers
        || left.selections - right.selections
        || left.order - right.order
      : right.selectionScore - left.selectionScore
        || left.activeWorkers - right.activeWorkers
        || left.selections - right.selections
        || left.order - right.order);
    return { metric: pool[0], reason: exploring.length ? 'exploration' : 'performance' };
  };

  const release = workerId => {
    const id = String(workerId);
    const key = leases.get(id);
    if (!key) return false;
    leases.delete(id);
    const metric = metrics.get(key);
    if (metric) metric.activeWorkers = Math.max(0, metric.activeWorkers - 1);
    return true;
  };

  return {
    acquire(workerId, preferredKey = '') {
      const id = String(workerId);
      release(id);
      const preferred = browserByKey.has(String(preferredKey || ''))
        ? metrics.get(String(preferredKey)) : null;
      const selected = preferred ? { metric: preferred, reason: 'initial-round-robin' } : chooseBrowser();
      const selectedMetric = metrics.get(selected.metric.key);
      selectedMetric.activeWorkers += 1;
      selectedMetric.selections += 1;
      selectedMetric.lastSelectedAt = now();
      leases.set(id, selectedMetric.key);
      selectionCount += 1;
      lastSelection = {
        workerId: id,
        key: selectedMetric.key,
        label: selectedMetric.label,
        reason: selected.reason,
        at: now(),
      };
      return browserByKey.get(selectedMetric.key);
    },

    release,

    recordOutcome({
      workerId = '',
      browserKey = '',
      success = false,
      cookies = 0,
      durationMs = 0,
      bandwidth = null,
      failureCategory = '',
    } = {}) {
      const key = String(browserKey || leases.get(String(workerId)) || '');
      const metric = metrics.get(key);
      if (!metric) return false;
      const cookieCount = Math.floor(count(cookies));
      const elapsed = count(durationMs);
      const measured = bandwidth && bandwidth.supported === true;
      const bytes = measured ? count(bandwidth.totalBytes
        || count(bandwidth.downloadBytes) + count(bandwidth.uploadBytes)) : 0;
      const category = String(failureCategory || (success ? '' : 'unknown'));
      const comparable = success || category !== 'proxy';

      metric.attempts += 1;
      metric.cookies += cookieCount;
      metric.durationMs += elapsed;
      if (measured) {
        metric.measuredAttempts += 1;
        metric.totalBytes += bytes;
      }
      if (success) metric.lastSuccessAt = now();
      if (!success) metric.failuresByCategory[category] = (metric.failuresByCategory[category] || 0) + 1;

      // A dead proxy says nothing about its assigned browser. Retain its real bandwidth/cost in
      // telemetry, but exclude it from the browser ranking so random proxy quality cannot train the
      // optimizer toward or away from a browser by accident.
      if (!comparable) {
        metric.excludedProxyFailures += 1;
        return true;
      }
      metric.decisionAttempts += 1;
      metric.decisionCookies += cookieCount;
      if (success) {
        metric.successes += 1;
        metric.successfulDurationMs += elapsed;
      } else {
        metric.failures += 1;
      }
      if (measured) {
        metric.decisionMeasuredAttempts += 1;
        metric.decisionMeasuredBytes += bytes;
        metric.decisionMeasuredCookies += cookieCount;
      }
      return true;
    },

    snapshot() {
      const ranked = rankedMetrics().sort((left, right) =>
        right.qualityScore - left.qualityScore || left.order - right.order);
      const learning = ranked.some(item => item.decisionAttempts < sampleFloor);
      const view = item => ({
        key: item.key,
        label: item.label,
        attempts: item.attempts,
        decisionAttempts: item.decisionAttempts,
        excludedProxyFailures: item.excludedProxyFailures,
        successes: item.successes,
        failures: item.failures,
        successRate: item.successRate,
        cookies: item.cookies,
        cookiesPerAttempt: item.cookieYield,
        measuredAttempts: item.measuredAttempts,
        totalBytes: item.totalBytes,
        bytesPerCookie: item.bytesPerCookie,
        averageDurationMs: item.averageDurationMs,
        successfulAverageMs: item.successfulAverageMs,
        qualityScore: item.qualityScore,
        selectionScore: item.selectionScore,
        activeWorkers: item.activeWorkers,
        selections: item.selections,
        lastSelectedAt: item.lastSelectedAt,
        lastSuccessAt: item.lastSuccessAt,
        failuresByCategory: { ...item.failuresByCategory },
      });
      return {
        policy: candidates.length > 1 ? 'adaptive-efficiency' : 'fixed-browser',
        learning,
        minimumSamples: sampleFloor,
        maximumActivePerBrowser: shareCeiling,
        workerCount: configuredWorkers,
        totalAttempts: ranked.reduce((sum, item) => sum + item.attempts, 0),
        decisionAttempts: ranked.reduce((sum, item) => sum + item.decisionAttempts, 0),
        selections: selectionCount,
        leader: learning || !ranked.length ? null : view(ranked[0]),
        browsers: ranked.map(view),
        lastSelection: lastSelection && { ...lastSelection },
      };
    },
  };
}
