const textOf = (status) => [...new Set([
  (status && status.label) || '',
  status && typeof status.state === 'string' ? status.state : '',
].map(value => String(value).trim().toLowerCase()).filter(Boolean))].join(' ');

export const TARGET_DROP_BUCKETS = Object.freeze([
  { key: 'running', label: 'Running', hint: 'Every live task', icon: 'activity' },
  { key: 'watching', label: 'Waiting for restock', hint: 'Parked until stock', icon: 'eye' },
  { key: 'atc', label: 'Adding to cart', hint: 'In the ATC loop', icon: 'cart' },
  { key: 'submitting', label: 'Submitting order', hint: 'Carted, finishing checkout', icon: 'send' },
  { key: 'attention', label: 'Need attention', hint: 'OTP, soft block, decline', icon: 'warning' },
  { key: 'success', label: 'Checked out', hint: 'Waiting on Target', icon: 'check' },
]);

const PHASE_TONE = Object.freeze({
  idle: 'idle',
  running: 'checkout',
  watching: 'watching',
  atc: 'carting',
  submitting: 'submitting',
  attention: 'error',
  success: 'success',
});

// Instantaneous event from the latest engine label. Retryable limiter/shape lines are not
// Attention: sticky phase keeps the task in ATC or submitting across those loops.
export function targetPhaseEvent(status, previous = '') {
  if (!status) return '';
  const text = textOf(status);
  const prev = previous || 'idle';
  const inCheckout = prev === 'atc' || prev === 'submitting';
  const taskState = Number(status.taskState);
  if (taskState === 3) return 'success';
  if (/^could not (?:switch|clear)/.test(text)) return 'attention';
  if (/^product found:/.test(text)) return 'atc';
  // Profile/proxy switch lines reuse "Switched To …" at restock AND after cart. Hold the current
  // card; do not start Submitting from a cold start.
  if (/^rotated profile to:/.test(text)
    || /^(?:switch(?:ed)? to|throttled - switched to)\b/.test(text)) return 'hold';
  if (/\b(?:success(?:ful)?|checked out|waiting for order|getting order status|order not finished processing|removing filler item)\b/.test(text)) {
    return 'success';
  }
  if (/(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?)/.test(text)
    || /^out of stock$/.test(text)) {
    return 'watch';
  }
  // Same engine string warms an empty cart at task start and later reads the cart after ATC.
  if (/\bgetting cart info\b/.test(text)) return inCheckout ? 'submit' : 'setup';
  // Filler ATC before restock is still setup. After stock it is the ATC loop.
  if (/\bcarting filler item\b/.test(text)) {
    return (inCheckout || prev === 'watching') ? 'atc' : 'setup';
  }
  if (/\b(?:adding to cart|getting cart(?! info)|using alternate cart flow)\b/.test(text)
    || /^product in stock\b/.test(text)
    || /^limit reached$/.test(text)) {
    return 'atc';
  }
  if (/\b(?:dco rate limited|rate[ -]?limited|ratelimited|waiting for shape|getting shape)\b/.test(text)) {
    return 'retry';
  }
  if (taskState === 4) return 'attention';
  if (/\b(?:shape soft block|payment declined|product not found|bad session|locked|proxy block|error building client|code timed out|code wait failed|cancelled|canceled|no valid tcin|invalid|invaild)\b/.test(text)) {
    return 'attention';
  }
  if (/\b(?:error|fail(?:ed|ure)?|declin(?:e|ed))\b/.test(text)) return 'attention';
  if (/\b(?:carted|preparing checkout|setting address|setting payment|submitting payment|submitting cvv|submitting order|out of stock, checking cart|rotating profile|throttled|finishing on home ip)\b/.test(text)) {
    return 'submit';
  }
  if (/\b(?:preparing runtime|starting(?: task)?|completed task init|getting session|logging in|login|requesting login code|waiting for code|submitting code|validating login|getting details|setting details|rotating proxy|setting proxy|proxy updated)\b/.test(text)) {
    return 'setup';
  }
  if (/^(?:idle|stopped|(?:task )?limit reached)$/.test(text)) return 'idle';
  return '';
}

export function targetStickyPhase(status, previous = '', extras = {}) {
  if (extras.otpRequest) return 'attention';
  const prev = previous || 'idle';
  const running = targetTaskIsRunning(status);
  const event = targetPhaseEvent(status, prev);
  if (!running) {
    if (event === 'success') return 'success';
    if (event === 'attention') return 'attention';
    return 'idle';
  }
  if (event === 'success') return 'success';
  if (event === 'attention') return 'attention';
  if (event === 'submit') return 'submitting';
  if (event === 'atc') return 'atc';
  if (event === 'watch') return 'watching';
  if (prev === 'atc' || prev === 'submitting') return prev;
  if (event === 'setup') return 'running';
  if (event === 'retry' || event === 'hold') return prev === 'idle' ? 'running' : prev;
  if (running && prev !== 'idle') return prev;
  return 'running';
}

export function withStickyPhase(entry, previous) {
  const next = entry && typeof entry === 'object' ? entry : {};
  const phase = targetStickyPhase(next, previous && previous.phase);
  if (next.phase === phase) return next;
  return { ...next, phase };
}

export function targetDisplayedPhase(status, extras = {}) {
  if (extras.otpRequest) return 'attention';
  if (status && status.phase) return status.phase;
  return targetStickyPhase(status, '');
}

export function taskMatchesDropBucket(bucket, status, extras = {}) {
  if (bucket === 'running') return targetTaskIsRunning(status);
  const phase = targetDisplayedPhase(status, extras);
  return phase === bucket;
}

// Runtime liveness and visual phase are deliberately separate. A retriable red error can still be
// running, and a looping task remains running during its brief Successful status.
export function targetTaskIsReauthenticating(status, otpRequest) {
  if (otpRequest) return true;
  const text = [...new Set([
    (status && status.label) || '',
    status && typeof status.state === 'string' ? status.state : '',
    (status && status.detail) || '',
  ].map(value => String(value).trim().toLowerCase()).filter(Boolean))].join(' ');
  if (!text) return false;
  return /\b(?:error refreshing session|bad session|logging in|requesting login code|waiting for code|submitting code|code timed out|code wait failed)\b/i.test(text);
}

export function targetTaskIsRunning(status) {
  if (!status) return false;
  if (status.running === true) return true;
  if (status.running === false) return false;
  const text = textOf(status);
  if (/^(?:idle|stopped|(?:task )?limit reached)$/.test(text)) return false;
  if (/^(?:product found:|rotated profile to:|switch(?:ed)? to|throttled - switched to)/.test(text)) return true;
  return !!text && !/\b(?:successful|checked out|payment declined)\b/.test(text);
}

// Adding-to-cart is current-state only so the pulse can show who is mid-ATC. Carted and failed
// counts are this restock wave. Checkouts stay for the whole run. A live submitting status still
// counts once if its carted event has not arrived yet, so the first submit is not blank.
export function targetDropPhase(status) {
  const phase = status && status.phase;
  if (phase === 'atc') return 'carting';
  if (phase === 'submitting') return 'submitting';
  if (!status) return '';
  const text = textOf(status);
  if (/\b(?:adding to cart|using alternate cart flow)\b/.test(text)) return 'carting';
  if (/\b(?:submitting payment|submitting cvv|submitting order)\b/.test(text)) return 'submitting';
  return '';
}

export const TARGET_DROP_WAVE_OOS_MS = 1500;
export const EMPTY_DROP_WAVE = Object.freeze({ at: 0, oosSince: 0, ended: false });

// The shared Target monitor. Task lines such as "Out of Stock, Checking Cart" must not count.
export function targetMonitorStockPhase(status) {
  if (!status) return '';
  const text = textOf(status);
  if (!text) return '';
  if (/^out of stock$/.test(text)) return 'oos';
  if (/^product in stock$/.test(text) || /^in stock$/.test(text)) return 'in-stock';
  return '';
}

export function targetHasLiveDropWork(taskStatus) {
  const statuses = taskStatus && typeof taskStatus === 'object' ? Object.values(taskStatus) : [];
  for (const status of statuses) {
    const sticky = targetDisplayedPhase(status);
    if (sticky === 'atc' || sticky === 'submitting') return true;
    const phase = targetDropPhase(status);
    if (phase === 'carting' || phase === 'submitting') return true;
  }
  return false;
}

function emptyWaveOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return outcome;
  if (!(Number(outcome.waveCarted) || Number(outcome.waveDeclines))) return outcome;
  return { ...outcome, waveCarted: 0, waveDeclines: 0 };
}

function zeroWaveOutcomes(taskOutcomes) {
  if (!taskOutcomes || typeof taskOutcomes !== 'object') return taskOutcomes;
  let changed = false;
  const next = {};
  for (const [taskId, outcome] of Object.entries(taskOutcomes)) {
    const cleared = emptyWaveOutcome(outcome);
    next[taskId] = cleared;
    if (cleared !== outcome) changed = true;
  }
  return changed ? next : taskOutcomes;
}

// Quiet OOS for TARGET_DROP_WAVE_OOS_MS with nobody carting/submitting ends the wave:
// carted/failed chips go to 0, successful checkouts stay. One OOS poll does not wipe.
export function applyTargetDropWave(target, now) {
  if (!target || typeof target !== 'object') return target;
  const at = Number(now) || 0;
  const phase = targetMonitorStockPhase(target.monitorStatus);
  const live = targetHasLiveDropWork(target.taskStatus);
  const wave = target.dropWave && typeof target.dropWave === 'object'
    ? target.dropWave
    : EMPTY_DROP_WAVE;
  let nextWave = wave;
  let nextOutcomes = target.taskOutcomes;

  if (phase === 'in-stock') {
    if (wave.oosSince || wave.ended) {
      nextWave = { at: Number(wave.at) || 0, oosSince: 0, ended: false };
    }
  } else if (phase === 'oos' && live) {
    if (wave.oosSince) nextWave = { ...wave, oosSince: 0 };
  } else if (phase === 'oos' && !live && !wave.ended) {
    if (!wave.oosSince) {
      nextWave = { ...wave, oosSince: at };
    } else if (at - Number(wave.oosSince) >= TARGET_DROP_WAVE_OOS_MS) {
      nextOutcomes = zeroWaveOutcomes(target.taskOutcomes);
      nextWave = { at, oosSince: 0, ended: true };
    }
  }

  if (nextWave === wave && nextOutcomes === target.taskOutcomes) return target;
  return { ...target, dropWave: nextWave, taskOutcomes: nextOutcomes };
}

const countOf = (reader, task) => (
  typeof reader === 'function' ? Math.max(0, Number(reader(task)) || 0) : 0
);

export function summarizeGroupDropPulse(tasks, {
  statusFor, checkoutCountFor, cartedCountFor, declineCountFor,
} = {}) {
  const statusOf = typeof statusFor === 'function' ? statusFor : () => null;
  let carting = 0;
  let submitting = 0;
  let checkouts = 0;
  let failures = 0;
  for (const task of (Array.isArray(tasks) ? tasks : [])) {
    const phase = targetDropPhase(statusOf(task));
    const carted = countOf(cartedCountFor, task);
    if (phase === 'carting') carting += 1;
    submitting += carted || (phase === 'submitting' ? 1 : 0);
    checkouts += countOf(checkoutCountFor, task);
    failures += countOf(declineCountFor, task);
  }
  return { carting, submitting, checkouts, failures };
}

export function targetStatusTone(status) {
  if (!status) return 'idle';
  if (status.phase && PHASE_TONE[status.phase]) return PHASE_TONE[status.phase];
  const text = textOf(status);
  const taskState = Number(status.taskState);
  const color = String(status.color || '').trim().toLowerCase();

  if (taskState === 3) return 'success';
  if (taskState === 4) return 'error';

  // Dynamic names follow these prefixes. Classify the operation before scanning their content so
  // a product/profile/proxy named “Successful”, “Stopped”, or “Waiting For Restock” cannot change
  // the task's phase.
  if (/^could not (?:switch|clear)/.test(text)) return 'error';
  if (/^product found:/.test(text)) return 'carting';
  if (/^rotated profile to:/.test(text)
    || /^(?:switch(?:ed)? to|throttled - switched to)\b/.test(text)) return 'submitting';

  // These confirmation states are intentionally green before the final status arrives, making it
  // obvious at a glance that the task is waiting on Target rather than still building the order.
  if (/\b(?:success(?:ful)?|checked out|waiting for order|getting order status|order not finished processing|removing filler item)\b/.test(text)) {
    return 'success';
  }

  // Known restock phrases override the engine's raw color (Out Of Stock is emitted as red even
  // though it is the normal steady state for a monitor).
  if (/(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?)/.test(text)
    || /^out of stock$/.test(text)) {
    return 'watching';
  }

  // Prefixes are checked before generic error words so a product name containing “error” or
  // “blocked” cannot turn a healthy Product Found status red.
  if (/^product in stock\b/.test(text)
    || /\b(?:adding to cart|carting filler item|getting cart(?! info)|using alternate cart flow)\b/.test(text)
    || /^limit reached$/.test(text)) {
    return 'carting';
  }

  if (/\b(?:error|fail(?:ed|ure)?|declin(?:e|ed)|cancelled|canceled|blocked|could not|invalid|invaild|timed out|rate[ -]?limited|ratelimited|no valid tcin|product not found|bad session|locked)\b/.test(text)) {
    return 'error';
  }

  // Once Target has accepted an item into the cart, use a dedicated order-submission tone. These
  // steps used to share the blue setup/Shape color, which made the most important phase invisible
  // when scanning a large task group.
  if (/\b(?:carted|get(?:ting)? cart info|preparing checkout|setting address|setting payment|submitting payment|submitting cvv|submitting order|out of stock, checking cart|rotating profile|throttled|finishing on home ip)\b/.test(text)) {
    return 'submitting';
  }

  if (/\b(?:preparing runtime|starting(?: task)?|completed task init|getting session|logging in|login|requesting login code|waiting for code|submitting code|validating login|getting details|setting details|waiting for shape|rotating proxy|setting proxy|proxy updated)\b/.test(text)) {
    return 'checkout';
  }

  if (color === '#fb5454' || color === '#ff5a5a') return 'error';
  return targetTaskIsRunning(status) ? 'checkout' : 'idle';
}
