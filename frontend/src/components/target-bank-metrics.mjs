const count = (value) => Math.max(0, Number(value) || 0);

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

export function sameTargetBank(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
