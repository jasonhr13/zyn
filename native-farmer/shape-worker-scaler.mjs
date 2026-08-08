// Fixed-concurrency lease scheduler for the Shape farmer. Harvest failures recycle the failed
// browser session and apply route/lane backpressure in shape-harvest-health; they never remove a
// worker slot. Extra loops exist only so a low concurrency ceiling can rotate fairly across every
// detected browser channel.
const NON_PRESSURE_FAILURES = new Set(['proxy']);

export function createShapeWorkerScaler({
  configuredWorkers,
  browserCount,
  proxyCapacity,
  windowSize = 10,
  minDistinctPressureSources = 2,
  workerKeys = [],
  fairnessRotationEvery = 2,
} = {}) {
  const configuredCeiling = Math.max(1, Math.floor(Number(configuredWorkers) || 1));
  const availableBrowsers = Math.max(1, Math.floor(Number(browserCount) || 1));
  // No configured proxies preserves the farmer's existing single home-IP lane.
  const availableProxies = Math.max(1, Math.floor(Number(proxyCapacity) || 1));
  const hardLimit = Math.max(1, Math.min(configuredCeiling, availableProxies));
  const suppliedWorkerKeys = Array.isArray(workerKeys)
    ? workerKeys.map(key => String(key || 'browser')).filter(Boolean)
    : [];
  const slotKeys = suppliedWorkerKeys.length ? [...suppliedWorkerKeys] : ['browser'];
  const suppliedCount = slotKeys.length;
  while (slotKeys.length < hardLimit) slotKeys.push(slotKeys[slotKeys.length % suppliedCount]);

  const activeWorkerIds = new Set();
  const workerActivations = Array(slotKeys.length).fill(0);
  const workerLeaseCompletions = Array(slotKeys.length).fill(0);
  const lastActivatedOrder = Array(slotKeys.length).fill(0);
  const browserActivations = new Map(slotKeys.map(key => [key, 0]));
  let activationSequence = 0;
  let activeWorkers = 0;
  let scheduleRotations = 0;
  let lastRotation = null;
  const rotationEvery = Math.max(1, Math.floor(Number(fairnessRotationEvery) || 1));
  const windowLimit = Math.max(1, Math.floor(Number(windowSize) || 1));
  const requiredDistinctSources = Math.min(hardLimit,
    Math.max(1, Math.floor(Number(minDistinctPressureSources) || 1)));
  const recent = [];
  const evidence = [];

  const push = ({ pressure, success = false, scope = '', sourceKey = '' }) => {
    recent.push(pressure ? 1 : 0);
    evidence.push({ pressure: !!pressure, success: !!success, scope, sourceKey });
    while (recent.length > windowLimit) recent.shift();
    while (evidence.length > windowLimit) evidence.shift();
  };
  const failuresIn = samples => samples.reduce((sum, value) =>
    sum + (typeof value === 'number' ? value : value.pressure ? 1 : 0), 0);
  const rateOf = samples => samples.length ? failuresIn(samples) / samples.length : 0;
  const distinctPressureSources = () => new Set(evidence
    .filter(sample => sample.pressure && sample.sourceKey)
    .map(sample => sample.sourceKey)).size;
  const activeBrowserCounts = () => {
    const counts = new Map(slotKeys.map(key => [key, 0]));
    for (const id of activeWorkerIds) counts.set(slotKeys[id], (counts.get(slotKeys[id]) || 0) + 1);
    return counts;
  };
  const chooseInactiveWorker = () => {
    const activeCounts = activeBrowserCounts();
    const candidates = slotKeys.map((_, id) => id).filter(id => !activeWorkerIds.has(id));
    candidates.sort((a, b) => {
      const keyA = slotKeys[a], keyB = slotKeys[b];
      return (activeCounts.get(keyA) || 0) - (activeCounts.get(keyB) || 0)
        || (browserActivations.get(keyA) || 0) - (browserActivations.get(keyB) || 0)
        || workerActivations[a] - workerActivations[b]
        || a - b;
    });
    return candidates[0];
  };
  const activateNextWorker = () => {
    const id = chooseInactiveWorker();
    if (!Number.isInteger(id)) return -1;
    activeWorkerIds.add(id);
    activeWorkers = activeWorkerIds.size;
    workerActivations[id]++;
    lastActivatedOrder[id] = ++activationSequence;
    browserActivations.set(slotKeys[id], (browserActivations.get(slotKeys[id]) || 0) + 1);
    return id;
  };
  const deactivateWorker = (preferredWorkerId) => {
    const preferred = preferredWorkerId == null ? NaN : Number(preferredWorkerId);
    let id = activeWorkerIds.has(preferred) ? preferred : null;
    if (id == null) {
      const counts = activeBrowserCounts();
      id = [...activeWorkerIds].sort((a, b) =>
        (counts.get(slotKeys[b]) || 0) - (counts.get(slotKeys[a]) || 0)
        || lastActivatedOrder[b] - lastActivatedOrder[a]
        || b - a)[0];
    }
    if (!Number.isInteger(id)) return -1;
    activeWorkerIds.delete(id);
    workerLeaseCompletions[id] = 0;
    activeWorkers = activeWorkerIds.size;
    return id;
  };
  const maybeRotateCompletedWorker = (workerId) => {
    const completed = Number(workerId);
    if (!activeWorkerIds.has(completed) || activeWorkerIds.size >= slotKeys.length) return null;
    workerLeaseCompletions[completed]++;
    if (workerLeaseCompletions[completed] < rotationEvery) return null;
    // The deactivate/activate pair is synchronous: externally-observed concurrency remains fixed.
    const fromBrowser = slotKeys[completed];
    deactivateWorker(completed);
    const activated = activateNextWorker();
    if (activated < 0) {
      activeWorkerIds.add(completed);
      activeWorkers = activeWorkerIds.size;
      return null;
    }
    scheduleRotations++;
    lastRotation = {
      fromWorkerId: completed,
      toWorkerId: activated,
      fromBrowser,
      toBrowser: slotKeys[activated],
    };
    return lastRotation;
  };

  // Fill the route-bounded ceiling immediately. Browser keys repeat round-robin when the operator
  // requests more workers than there are detected browser channels.
  for (let i = 0; i < hardLimit; i++) activateNextWorker();

  return {
    isActive(workerId) {
      return activeWorkerIds.has(Number(workerId));
    },

    recordSuccess({ sourceKey = '', workerId = null } = {}) {
      push({ pressure: false, success: true, sourceKey: String(sourceKey || '') });
      maybeRotateCompletedWorker(workerId);
      return null;
    },

    recordFailure({ category = 'unknown', scope = 'session', sourceKey = '', workerId = null } = {}) {
      const pressure = !NON_PRESSURE_FAILURES.has(category);
      const normalizedScope = ['lane', 'proxy', 'session'].includes(scope) ? scope : 'session';
      const normalizedSource = String(sourceKey || (normalizedScope === 'lane' ? 'lane' : ''));
      push({ pressure, success: false, scope: normalizedScope, sourceKey: normalizedSource });
      maybeRotateCompletedWorker(workerId);
      return null;
    },

    snapshot() {
      return {
        policy: 'fixed',
        desiredWorkers: hardLimit,
        activeWorkers,
        configuredCeiling,
        hardLimit,
        browserCount: availableBrowsers,
        proxyCapacity: availableProxies,
        recentSamples: recent.length,
        recentErrors: failuresIn(recent),
        recentErrorRate: rateOf(recent),
        decisionSamples: evidence.length,
        decisionErrors: failuresIn(evidence),
        decisionErrorRate: rateOf(evidence),
        distinctPressureSources: distinctPressureSources(),
        requiredDistinctPressureSources: requiredDistinctSources,
        // Retained for renderer compatibility with older adaptive brokers. Fixed policy never moves
        // these counters because failures are handled by session recycle and route quarantine.
        scaleDowns: 0,
        lastDownscale: null,
        recovery: {
          active: false,
          eligibleInMs: 0,
          successes: 0,
          distinctHealthySources: 0,
          requiredSuccesses: 0,
          requiredDistinctSources: 0,
          scaleUps: 0,
          lastUpscale: null,
        },
        scheduling: {
          slotCount: slotKeys.length,
          activeWorkerIds: [...activeWorkerIds].sort((a, b) => a - b),
          activeBrowserCounts: Object.fromEntries(activeBrowserCounts()),
          browserActivations: Object.fromEntries(browserActivations),
          rotations: scheduleRotations,
          rotationEvery,
          activeLeaseCompletions: Object.fromEntries([...activeWorkerIds]
            .sort((a, b) => a - b).map(id => [id, workerLeaseCompletions[id]])),
          lastRotation: lastRotation && { ...lastRotation },
        },
      };
    },
  };
}
