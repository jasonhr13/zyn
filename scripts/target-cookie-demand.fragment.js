// Dynamic Target cookie-bank demand. The broker is the only authority that accepts cookies, while
// this bridge is the only authority that knows which checkout tasks actually reached the engine.
// Keep those concerns separate: publish counts and a per-task setting, never task ids or secrets.
const TARGET_ATC_COOKIES_PER_TASK_DEFAULT = 3;
const TARGET_ATC_COOKIES_PER_TASK_MAX = 20;
const TARGET_COOKIE_TASK_MAX = 1000;
const TARGET_COOKIE_TOTAL_MAX = 10000;
const targetCookieActiveTaskIds = new Set();
const targetCookieStandbySources = new Map();
// The launcher explicitly opens this latch after the replacement license authority reports an
// active session. Task-group bootstrap runs before that authority exists, so default-deny here is
// what prevents saved harvesters from consuming local/proxy bandwidth while signed out.
let targetHarvestAuthorized = false;
let targetCookieDemandRetryTimer = null;
let targetCookieDemandInFlight = false;
let lastTargetCookieDemandKey = '';

function normalizeTargetCookieTaskCount(value) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(TARGET_COOKIE_TASK_MAX, parsed)) : 0;
}

function targetAtcCookiesPerTask() {
  let configured;
  try { configured = (dm.getSettings() || {}).targetAtcCookiesPerTask; } catch {}
  const parsed = Number.parseInt(String(configured == null ? '' : configured), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(TARGET_ATC_COOKIES_PER_TASK_MAX, parsed)
    : TARGET_ATC_COOKIES_PER_TASK_DEFAULT;
}

function targetCookieDemand() {
  const activeTasks = Math.min(TARGET_COOKIE_TASK_MAX, targetCookieActiveTaskIds.size);
  // Once the Task Groups store has loaded, it is authoritative even at zero. Its initial migration
  // leaves the old target-tasks.json in place, so taking max forever would make deleted groups spring
  // back from that stale legacy copy and prevent the bank from scaling down.
  const taskGroupStandby = targetCookieStandbySources.get('task-groups') || 0;
  const hasLiveLegacyStandby = targetCookieStandbySources.has('legacy-live');
  const standbyTasks = taskGroupStandby > 0
    ? taskGroupStandby
    : hasLiveLegacyStandby
      ? targetCookieStandbySources.get('legacy-live')
      : targetCookieStandbySources.has('task-groups')
        ? 0
        : Math.max(0, ...targetCookieStandbySources.values());
  const basis = !targetHarvestAuthorized
    ? 'paused'
    : activeTasks ? 'active' : standbyTasks ? 'standby' : 'paused';
  const effectiveTasks = basis === 'paused' ? 0 : activeTasks || standbyTasks;
  const atcPerTask = targetAtcCookiesPerTask();
  return {
    mode: 'per-task',
    basis,
    activeTasks,
    standbyTasks,
    effectiveTasks,
    atcPerTask,
    targets: {
      // A login Shape signature is consumed when a task must establish or recover its Target
      // session. ATC is the hot path and receives the operator-selected reserve per task.
      login: effectiveTasks,
      atc: Math.min(TARGET_COOKIE_TOTAL_MAX, effectiveTasks * atcPerTask),
    },
  };
}

function scheduleTargetCookieDemandRetry() {
  if (quitting || (!targetHarvestAuthorized && !farmerProc) || targetCookieDemandRetryTimer) return;
  targetCookieDemandRetryTimer = setTimeout(() => {
    targetCookieDemandRetryTimer = null;
    publishTargetCookieDemand();
  }, 500);
  targetCookieDemandRetryTimer.unref?.();
}

function publishTargetCookieDemand() {
  if (quitting || (!targetHarvestAuthorized && !farmerProc)) return targetCookieDemand();
  if (targetCookieDemandInFlight) {
    scheduleTargetCookieDemandRetry();
    return targetCookieDemand();
  }
  const demand = targetCookieDemand();
  const key = JSON.stringify(demand);
  const body = JSON.stringify({
    basis: demand.basis,
    activeTasks: demand.activeTasks,
    standbyTasks: demand.standbyTasks,
    atcPerTask: demand.atcPerTask,
  });
  targetCookieDemandInFlight = true;
  const req = http.request({
    host: '127.0.0.1', port: SHAPE_PORT, path: '/demand', method: 'POST', timeout: 1200,
    headers: {
      'x-zyn-token': SHAPE_TOKEN,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, (res) => {
    res.resume();
    res.on('end', () => {
      targetCookieDemandInFlight = false;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        lastTargetCookieDemandKey = key;
        if (JSON.stringify(targetCookieDemand()) !== key) scheduleTargetCookieDemandRetry();
        return;
      }
      scheduleTargetCookieDemandRetry();
    });
  });
  req.on('error', () => {
    targetCookieDemandInFlight = false;
    scheduleTargetCookieDemandRetry();
  });
  req.on('timeout', () => req.destroy(new Error('cookie demand request timed out')));
  req.end(body);
  return demand;
}

function syncTargetCookieBankDemand() {
  const demand = targetCookieDemand();
  const key = JSON.stringify(demand);
  if (!targetHarvestAuthorized) {
    // A broker that was created while authorized may remain as the lightweight owner of the
    // persisted bank. Publish an explicit zero target so extension posts and in-flight producer
    // work cannot keep prefarming after revocation. Before first authorization there is no broker
    // and therefore nothing to contact or retry.
    if (farmerProc && key !== lastTargetCookieDemandKey) publishTargetCookieDemand();
    return demand;
  }
  ensureHarvesterBroker();
  if (key !== lastTargetCookieDemandKey || !farmerProc) publishTargetCookieDemand();
  return demand;
}

function setTargetHarvestAuthorized(authorized) {
  const next = authorized === true;
  targetHarvestAuthorized = next;
  lastTargetCookieDemandKey = '';
  if (!next) {
    // stopHarvesterProducer deletes before killing, so each child's exit callback cannot resurrect
    // itself; its delayed ensureHarvesterBroker call also observes this closed latch.
    for (const id of [...harvesterProcs.keys()]) stopHarvesterProducer(id);
    if (!farmerProc && targetCookieDemandRetryTimer) clearTimeout(targetCookieDemandRetryTimer);
    if (!farmerProc) targetCookieDemandRetryTimer = null;
  }
  return syncTargetCookieBankDemand();
}

function setTargetCookieStandbyTasks(source, count) {
  const name = String(source || 'external').slice(0, 40);
  const normalized = normalizeTargetCookieTaskCount(count);
  targetCookieStandbySources.set(name, normalized);
  return syncTargetCookieBankDemand();
}

function acceptTargetCookieTasks(tasks) {
  let changed = false;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String(task && task.id || '');
    if (id && !targetCookieActiveTaskIds.has(id)) {
      targetCookieActiveTaskIds.add(id);
      changed = true;
    }
  }
  if (changed) syncTargetCookieBankDemand();
  return changed;
}

function releaseTargetCookieTask(taskId) {
  const removed = targetCookieActiveTaskIds.delete(String(taskId || ''));
  if (removed) syncTargetCookieBankDemand();
  return removed;
}

function clearTargetCookieTasks() {
  if (!targetCookieActiveTaskIds.size) return false;
  targetCookieActiveTaskIds.clear();
  syncTargetCookieBankDemand();
  return true;
}

try {
  const legacy = dm.getTargetTasks && dm.getTargetTasks();
  const count = Array.isArray(legacy && legacy.tasks) ? legacy.tasks.length : 0;
  if (count > 0) targetCookieStandbySources.set('legacy-migrated', normalizeTargetCookieTaskCount(count));
} catch {}
