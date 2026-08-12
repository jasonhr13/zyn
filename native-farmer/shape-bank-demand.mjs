export const MAX_DYNAMIC_ACTIVE_TASKS = 1000;
export const MAX_DYNAMIC_COOKIE_TARGET = 10000;
export const MAX_DYNAMIC_ATC_PER_TASK = Number.MAX_SAFE_INTEGER;

const clampInteger = (value, minimum, maximum, field) => {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) {
    throw new TypeError(`${field} must be a number`);
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(Number(value))));
};

const normalizeBasis = (value) => {
  const normalized = String(value || 'active').trim().toLowerCase();
  if (!['active', 'standby', 'paused'].includes(normalized)) {
    throw new TypeError('basis must be active, standby, or paused');
  }
  return normalized;
};

// Keeps the legacy pool-size meaning intact until the app explicitly publishes live task demand.
// `null` is serialized as JSON null and means uncapped; dynamic zero is therefore unambiguous.
export function createBankDemand({ legacyPool = 0 } = {}) {
  const parsedLegacy = Number(legacyPool);
  const legacyTarget = parsedLegacy > 0 ? Math.floor(parsedLegacy) : null;
  let targets = { login: legacyTarget, atc: legacyTarget };
  let demand = {
    mode: 'legacy', basis: 'active', activeTasks: 0, standbyTasks: 0,
    effectiveTasks: null, atcPerTask: null, targets: { ...targets },
  };

  const snapshot = () => ({
    demand: { ...demand, targets: { ...targets } },
    targets: { ...targets },
  });

  return {
    apply(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('demand must be an object');
      }
      const activeTasks = clampInteger(
        input.activeTasks, 0, MAX_DYNAMIC_ACTIVE_TASKS, 'activeTasks',
      );
      const standbyTasks = input.standbyTasks === undefined
        ? 0
        : clampInteger(input.standbyTasks, 0, MAX_DYNAMIC_ACTIVE_TASKS, 'standbyTasks');
      const rawAtcPerTask = Number(input.atcPerTask);
      if (!Number.isFinite(rawAtcPerTask) || rawAtcPerTask < 0) {
        throw new TypeError('atcPerTask must be a non-negative number');
      }
      const atcPerTask = clampInteger(input.atcPerTask, 0, MAX_DYNAMIC_ATC_PER_TASK, 'atcPerTask');
      const basis = input.basis === undefined || input.basis === null || input.basis === ''
        ? activeTasks > 0 ? 'active' : standbyTasks > 0 ? 'standby' : 'paused'
        : normalizeBasis(input.basis);
      const effectiveTasks = basis === 'paused'
        ? 0
        : basis === 'standby' ? standbyTasks : activeTasks;
      targets = {
        login: Math.min(effectiveTasks, MAX_DYNAMIC_COOKIE_TARGET),
        // Zero is the explicit user-facing "no limit" sentinel. Paused demand remains a real zero
        // so signing out or stopping every task always parks prewarm workers.
        atc: effectiveTasks > 0 && atcPerTask === 0
          ? null
          : Math.min(effectiveTasks * atcPerTask, MAX_DYNAMIC_COOKIE_TARGET),
      };
      demand = {
        mode: 'per-task', basis, activeTasks, standbyTasks, effectiveTasks, atcPerTask,
        targets: { ...targets },
      };
      return snapshot();
    },

    snapshot,

    target(type) {
      return Object.prototype.hasOwnProperty.call(targets, type) ? targets[type] : 0;
    },

    accepts(type, depth, waiting = false) {
      if (waiting) return true;
      const target = Object.prototype.hasOwnProperty.call(targets, type) ? targets[type] : 0;
      return target === null || Math.max(0, Number(depth) || 0) < target;
    },
  };
}
