export const FAILURE_KINDS = [
  'target_block', 'captcha', 'queue', 'proxy', 'signature',
  'navigation', 'timeout', 'page', 'browser', 'unknown',
];

// ATC interactions already have direct page evidence; do not throw that evidence away and then
// infer it again from operator-facing prose. In particular, `page` is the safe default: an
// unclickable control is not proof that Target blocked the proxy.
export function classifyHarvestPageEvidence({
  confirmedBlock = false,
  confirmedCaptcha = false,
  queued = false,
  navigationFailed = false,
  signatureObserved = false,
} = {}) {
  if (confirmedBlock) return 'target_block';
  if (confirmedCaptcha) return 'captcha';
  if (queued) return 'queue';
  if (navigationFailed) return 'navigation';
  if (signatureObserved) return 'signature';
  return 'page';
}

const COOLDOWN_BASE_MS = {
  target_block: 30_000,
  captcha: 30_000,
  queue: 15_000,
  proxy: 15_000,
  signature: 5_000,
  navigation: 10_000,
  timeout: 10_000,
  page: 15_000,
  browser: 30_000,
  unknown: 10_000,
};

const PROXY_QUARANTINE_BASE_MS = {
  target_block: 120_000,
  captcha: 180_000,
  queue: 30_000,
  proxy: 60_000,
  signature: 15_000,
  navigation: 30_000,
  timeout: 30_000,
  page: 15_000,
};

export function sourceWeight(score = {}) {
  const ok = Math.max(0, Number(score.ok || score.successes) || 0);
  const fail = Math.max(0, Number(score.fail || score.fails) || 0);
  return (ok + 1) / (ok + fail + 2);
}

export function pickWeightedSource(sources, scores = {}, { exploreRate = 0.3, random = Math.random } = {}) {
  const names = [...new Set((Array.isArray(sources) ? sources : []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!names.length) return '';
  if (names.length === 1 || Number(random()) < exploreRate) {
    return names[Math.max(0, Math.min(names.length - 1, Math.floor(Number(random()) * names.length)))];
  }
  let best = names[0];
  let bestScore = sourceWeight(scores[best]);
  for (const name of names.slice(1)) {
    const score = sourceWeight(scores[name]);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

export function classifyHarvestFailure(value) {
  const text = String(value && (value.fail || value.error || value.message || value) || '').toLowerCase();
  // Confirmed blocks and captchas receive longer route quarantine. Require visible-page evidence,
  // not speculative language ("IP may be flagged") or Target's routinely-hit AtaVerifyCaptcha API.
  if (/bot-block|something went wrong|access denied|request rejected|served (its )?bot.block/.test(text)) return 'target_block';
  if (/captcha (challenge|page)|challenge page|verify (that )?you are human/.test(text)) return 'captcha';
  if (/waiting room|\bqueued\b|sorry for the wait|busier than we expected/.test(text)) return 'queue';
  if (/\bsignature\b|missing \[[^\]]*\]/.test(text)) return 'signature';
  if (/proxy|tunnel|econnreset|econnrefused|enotfound|socket hang up|err_(proxy|tunnel|socks|connection)/.test(text)) return 'proxy';
  if (/browser.*(closed|launch|executable)|target page.*closed|context.*closed|executable.*(missing|doesn't exist|not found)/.test(text)) return 'browser';
  if (/navigation|page\.goto|chrome-error|err_(name|address|internet|network|aborted|http2|failed)/.test(text)) return 'navigation';
  if (/timed[_ -]?out|timeout|err_timed_out|no capture/.test(text)) return 'timeout';
  if (/button never|no .*request fired|form never|bounced off|selector|detached|overlay|click/.test(text)) return 'page';
  return 'unknown';
}

export function createHarvestHealth({
  now = () => Date.now(),
  random = () => Math.random(),
  maxCooldownMs = 5 * 60_000,
  maxProxyQuarantineMs = 15 * 60_000,
} = {}) {
  const successes = { total: 0, login: 0, atc: 0 };
  const failures = { total: 0, byCategory: Object.fromEntries(FAILURE_KINDS.map(kind => [kind, 0])) };
  const lanes = {
    login: { consecutiveFailures: 0, cooldownUntil: 0 },
    atc: { consecutiveFailures: 0, cooldownUntil: 0 },
  };
  const quarantined = new Map();
  const backpressureByScope = { lane: 0, proxy: 0, session: 0 };

  const jitteredBackoff = (base, streak, maximum) => {
    const exponential = Math.min(maximum, base * (2 ** Math.min(4, Math.max(0, streak - 1))));
    const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4;
    return Math.min(maximum, Math.max(1, Math.round(exponential * jitter)));
  };

  const cleanQuarantines = () => {
    const time = now();
    for (const [key, entry] of quarantined) if (entry.until <= time) quarantined.delete(key);
  };

  const laneOf = (type) => lanes[type] || lanes.atc;
  const isTypeAvailable = (type) => laneOf(type).cooldownUntil <= now();

  return {
    recordSuccess({ type = 'atc', proxyKey = '' } = {}) {
      const lane = laneOf(type);
      successes.total++;
      successes[type] = (successes[type] || 0) + 1;
      lane.consecutiveFailures = 0;
      lane.cooldownUntil = 0;
      if (proxyKey) quarantined.delete(proxyKey);
    },

    recordFailure({ type = 'atc', category = 'unknown', proxyKey = '' } = {}) {
      const kind = FAILURE_KINDS.includes(category) ? category : 'unknown';
      const lane = laneOf(type);
      failures.total++;
      failures.byCategory[kind]++;

      let proxyQuarantineMs = 0;
      const quarantineBase = PROXY_QUARANTINE_BASE_MS[kind];
      // A proxy-backed harvest has an alternate route, so backpressure belongs to the failed route
      // (or, for browser/unknown failures, the failed session). Only home-IP mode has no smaller
      // scope available and therefore pauses the whole lane.
      const scope = proxyKey ? (quarantineBase ? 'proxy' : 'session') : 'lane';
      backpressureByScope[scope]++;

      let cooldownMs = 0;
      if (scope === 'lane') {
        lane.consecutiveFailures++;
        cooldownMs = jitteredBackoff(COOLDOWN_BASE_MS[kind], lane.consecutiveFailures, maxCooldownMs);
        lane.cooldownUntil = Math.max(lane.cooldownUntil, now() + cooldownMs);
      }

      if (proxyKey && quarantineBase) {
        const previous = quarantined.get(proxyKey);
        const strikes = previous && previous.until > now() ? previous.strikes + 1 : 1;
        proxyQuarantineMs = jitteredBackoff(quarantineBase, strikes, maxProxyQuarantineMs);
        quarantined.set(proxyKey, { until: now() + proxyQuarantineMs, strikes, category: kind });
      }
      return { category: kind, scope, cooldownMs, cooldownUntil: lane.cooldownUntil, proxyQuarantineMs };
    },

    isTypeAvailable,

    coolingTypes() {
      return Object.keys(lanes).filter(type => !isTypeAvailable(type));
    },

    nextCooldownMs() {
      const remaining = Object.values(lanes).map(lane => Math.max(0, lane.cooldownUntil - now())).filter(Boolean);
      return remaining.length ? Math.min(...remaining) : 0;
    },

    isProxyAvailable(proxyKey) {
      if (!proxyKey) return true;
      const entry = quarantined.get(proxyKey);
      if (!entry) return true;
      if (entry.until > now()) return false;
      quarantined.delete(proxyKey);
      return true;
    },

    nextProxyReadyMs(proxyKeys = []) {
      cleanQuarantines();
      const keys = proxyKeys.filter(Boolean);
      if (!keys.length || keys.some(key => !quarantined.has(key))) return 0;
      let earliest = Infinity;
      for (const key of keys) earliest = Math.min(earliest, quarantined.get(key).until);
      return Math.max(0, earliest - now());
    },

    snapshot() {
      cleanQuarantines();
      return {
        successes: { ...successes },
        failures: { total: failures.total, byCategory: { ...failures.byCategory } },
        cooldowns: Object.fromEntries(Object.entries(lanes).map(([type, lane]) => [type, {
          consecutiveFailures: lane.consecutiveFailures,
          remainingMs: Math.max(0, lane.cooldownUntil - now()),
        }])),
        quarantinedProxies: quarantined.size,
        backpressure: {
          byScope: { ...backpressureByScope },
          localizedFailures: backpressureByScope.proxy + backpressureByScope.session,
          laneCooldownFailures: backpressureByScope.lane,
        },
      };
    },
  };
}
