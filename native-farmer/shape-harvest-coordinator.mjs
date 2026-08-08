const TYPES = ['login', 'atc'];

const countOf = (source, type) => {
  const value = source && source[type];
  return Array.isArray(value) ? value.length : Math.max(0, Number(value) || 0);
};

// Coordinates the asynchronous farmer loops before any of them launches a browser. JavaScript runs
// this reservation synchronously, so five workers observing an empty bank cannot all choose login
// before the first one has had a chance to publish its cookie.
//
// targetPool <= 0 means uncapped: workers keep pre-warming until the TTL prunes entries. A positive
// value is a soft ceiling that only stops prewarm once the bank is deep enough.
export function createHarvestCoordinator({
  allowedTypes = TYPES,
  targetPool = 0,
  sessionReady = false,
  loginConcurrency = 1,
  continuousLogin = false,
  workerStaggerMs = 2000,
  now = () => Date.now(),
} = {}) {
  const allowed = new Set(allowedTypes.filter(type => TYPES.includes(type)));
  const parsedPool = Number(targetPool);
  const uncapped = !(parsedPool > 0);
  const limit = uncapped ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(parsedPool));
  const loginLimit = Math.max(1, Number(loginConcurrency) || 1);
  const stagger = Math.max(0, Number(workerStaggerMs) || 0);
  const inFlight = { login: 0, atc: 0 };
  let ready = sessionReady === true;
  let readyAt = ready ? now() : 0;
  // Only stagger after a mid-run session unlock. A process that starts already session-ready
  // (saved account cookie) launches every ATC worker immediately — matching friend throughput.
  let applyStagger = false;
  let loginHarvested = false;

  const workerIsUnlocked = (workerId) => {
    if (!ready || !applyStagger) return true;
    return now() >= readyAt + Math.max(0, Number(workerId) || 0) * stagger;
  };

  const underBankCap = (type, pools) =>
    uncapped || (countOf(pools, type) + inFlight[type] < limit);

  const canReserve = (type, pools, waiters, unavailable) => {
    if (unavailable.has(type)) return false;
    const demand = countOf(waiters, type) > 0;
    if (type === 'login' && inFlight.login >= loginLimit) return false;

    // ATC harvests stub cart_items on in-stock product pages — they do not need an account
    // session. Pre-warm ATC whenever the type is allowed so the bank climbs immediately even
    // before the engine finishes (or restores) a Target login.
    //
    // Login prewarms only while cold: one shot to mint a credential_validations cookie. Once the
    // engine has a session, further login harvests are demand-only (expired session recovery).
    let prewarm = false;
    if (type === 'atc' && allowed.has(type)) {
      prewarm = true;
    } else if (type === 'login' && allowed.has(type) && continuousLogin) {
      // A dedicated Target Login harvester is an operator-selected producer lane, not the automatic
      // farmer's one-shot cold-login helper. Keep its login bank topped up while still enforcing a
      // single in-flight login browser.
      prewarm = true;
    } else if (
      type === 'login'
      && allowed.has(type)
      && !ready
      && !loginHarvested
      && countOf(pools, type) === 0
    ) {
      prewarm = true;
    }
    if (!demand && !prewarm) return false;
    return underBankCap(type, pools);
  };

  const chooseType = (pools, waiters, unavailable) => {
    const candidates = TYPES.filter(type => canReserve(type, pools, waiters, unavailable));
    if (!candidates.length) return null;

    const demanded = candidates.filter(type => countOf(waiters, type) > 0);
    const choices = demanded.length ? demanded : candidates;
    return choices.sort((a, b) =>
      (countOf(pools, a) + inFlight[a]) - (countOf(pools, b) + inFlight[b]))[0];
  };

  return {
    reserve({ pools = {}, waiters = {}, workerId = 0, unavailableTypes = [] } = {}) {
      if (!workerIsUnlocked(workerId)) return null;
      const unavailable = unavailableTypes instanceof Set ? unavailableTypes : new Set(unavailableTypes);
      const type = chooseType(pools, waiters, unavailable);
      if (!type) return null;
      inFlight[type]++;
      let released = false;
      return {
        type,
        release({ success = false } = {}) {
          if (released) return;
          released = true;
          if (type === 'login' && success && !ready) loginHarvested = true;
          inFlight[type] = Math.max(0, inFlight[type] - 1);
        },
      };
    },

    markSessionReady() {
      if (ready) return false;
      ready = true;
      readyAt = now();
      applyStagger = stagger > 0;
      return true;
    },

    noteLoginHarvested() {
      if (!ready) loginHarvested = true;
    },

    state() {
      return {
        sessionReady: ready,
        readyAt,
        loginHarvested,
        uncapped,
        applyStagger,
        inFlight: { ...inFlight },
      };
    },
  };
}
