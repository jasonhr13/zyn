'use strict';

const {
  MAX_SAFE_TIMEOUT_MS,
  evaluateScheduleAction,
  normalizeSchedule,
  scheduleDetailLine,
  timerDelayMs,
} = require('./task-group-schedule');
const {
  buildTargetGroupLaunch,
  groupHasRunningTasks,
  otherTargetGroupRunning,
} = require('./target-group-launch');

function createTaskGroupScheduler(deps = {}) {
  const getGroups = deps.getGroups || (() => []);
  const saveGroups = deps.saveGroups || (groups => groups);
  const getAccounts = deps.getAccounts || (() => []);
  const getProfiles = deps.getProfiles || (() => []);
  const getReadiness = deps.getReadiness || (() => ({ level: 'ready', blockers: [], warnings: [] }));
  const isTaskRunning = deps.isTaskRunning || (() => false);
  const startTarget = deps.startTarget || (() => {});
  const stopTarget = deps.stopTarget || (() => {});
  const canStart = deps.canStart || (() => true);
  const notify = deps.notify || (() => {});
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  const timers = new Map();
  const starting = new Set();
  let disposed = false;
  let paused = false;
  let syncing = false;

  const timerKey = (groupId, kind) => `${groupId}:${kind}`;

  function emit(payload) {
    try { notify(payload); } catch {}
    try { if (payload && payload.line) log(payload.line); } catch {}
  }

  function clearTimer(groupId, kind) {
    const key = timerKey(groupId, kind);
    const handle = timers.get(key);
    if (handle) {
      try { cancelTimeout(handle); } catch {}
      timers.delete(key);
    }
  }

  function clearAllTimers() {
    for (const handle of timers.values()) {
      try { cancelTimeout(handle); } catch {}
    }
    timers.clear();
  }

  function patchGroupSchedule(groupId, mutator) {
    let changed = false;
    const groups = getGroups();
    const next = groups.map(group => {
      if (String(group.id) !== String(groupId)) return group;
      const current = normalizeSchedule(group.schedule, group.site) || { startAt: null, stopAt: null };
      const updated = mutator({ ...current }, group);
      changed = true;
      if (!updated || (updated.startAt == null && updated.stopAt == null)) {
        const { schedule: _schedule, ...rest } = group;
        return { ...rest, updatedAt: now() };
      }
      return { ...group, schedule: updated, updatedAt: now() };
    });
    if (!changed) return null;
    const saved = saveGroups(next);
    return (Array.isArray(saved) ? saved : next)
      .find(group => String(group.id) === String(groupId)) || null;
  }

  const clearStart = groupId => patchGroupSchedule(groupId, schedule => {
    schedule.startAt = null;
    return schedule.stopAt == null ? null : schedule;
  });
  const clearStop = groupId => patchGroupSchedule(groupId, schedule => {
    schedule.stopAt = null;
    return schedule.startAt == null ? null : schedule;
  });
  const clearBoth = groupId => patchGroupSchedule(groupId, () => null);

  function armTimer(groupId, kind, at) {
    clearTimer(groupId, kind);
    const delay = timerDelayMs(at, now());
    if (delay == null) return;
    const fire = () => {
      timers.delete(timerKey(groupId, kind));
      if (at - now() > 250) {
        armTimer(groupId, kind, at);
        return;
      }
      if (kind === 'start') fireStart(groupId);
      else fireStop(groupId);
    };
    const handle = scheduleTimeout(fire, delay);
    handle?.unref?.();
    timers.set(timerKey(groupId, kind), handle);
  }

  function fireStart(groupId) {
    if (disposed || paused) return;
    if (starting.has(String(groupId))) return;
    clearTimer(groupId, 'start');
    const groups = getGroups();
    const group = groups.find(candidate => String(candidate.id) === String(groupId));
    if (!group || String(group.site || 'target').toLowerCase() !== 'target') {
      clearStart(groupId);
      return;
    }
    const schedule = normalizeSchedule(group.schedule, group.site);
    if (!canStart()) {
      emit({ groupId, event: 'start-skipped', line: `[schedule] “${group.name}” waiting — sign in to start` });
      const retryAt = now() + 60_000;
      if (schedule?.stopAt == null || retryAt < schedule.stopAt) armTimer(groupId, 'start', retryAt);
      return;
    }
    const other = otherTargetGroupRunning(groups, groupId, isTaskRunning);
    if (other) {
      emit({
        groupId,
        event: 'start-skipped',
        line: `[schedule] “${group.name}” waiting — “${other.name}” is still running`,
      });
      const retryAt = now() + 60_000;
      if (schedule?.stopAt == null || retryAt < schedule.stopAt) armTimer(groupId, 'start', retryAt);
      else clearStart(groupId);
      return;
    }
    if (groupHasRunningTasks(group, isTaskRunning)) {
      clearStart(groupId);
      emit({ groupId, event: 'start-skipped', line: `[schedule] “${group.name}” is already running` });
      return;
    }
    const finishStart = (readiness) => {
      starting.delete(String(groupId));
      if (disposed || paused) return;
      const latestGroups = getGroups();
      const latest = latestGroups.find(candidate => String(candidate.id) === String(groupId));
      if (!latest || !normalizeSchedule(latest.schedule, latest.site)?.startAt) return;
      const blockers = Array.isArray(readiness && readiness.blockers) ? readiness.blockers : [];
      const warnings = Array.isArray(readiness && readiness.warnings) ? readiness.warnings : [];
      if (blockers.length || (readiness && readiness.level === 'blocked')) {
        clearStart(groupId);
        const reason = blockers.map(item => item && (item.title || item.detail)).filter(Boolean).join(' · ')
          || 'Target readiness check blocked the launch';
        emit({ groupId, event: 'start-failed', readiness, line: `[schedule] “${latest.name}” start blocked — ${reason}` });
        return;
      }
      if (warnings.length) {
        emit({
          groupId,
          event: 'start-warning',
          readiness,
          line: `[schedule] “${latest.name}” readiness warning — ${warnings.map(item => item.title || item.detail).join(' · ')}`,
        });
      }
      const launch = buildTargetGroupLaunch(latest, { accounts: getAccounts(), profiles: getProfiles() });
      if (!launch.ok) {
        clearStart(groupId);
        emit({ groupId, event: 'start-failed', line: `[schedule] “${latest.name}” start failed — ${launch.error}` });
        return;
      }
      clearStart(groupId);
      try {
        startTarget(launch.config);
        emit({
          groupId,
          event: 'start',
          readiness,
          line: `[schedule] “${latest.name}” start fired — ${launch.config.tasks.length} task(s)`
            + (launch.skipped ? `, ${launch.skipped} skipped without profiles` : ''),
        });
      } catch (error) {
        emit({ groupId, event: 'start-failed', line: `[schedule] “${latest.name}” start failed — ${error.message || error}` });
      }
    };
    const failReadiness = (error) => {
      starting.delete(String(groupId));
      clearStart(groupId);
      emit({
        groupId,
        event: 'start-failed',
        line: `[schedule] “${group.name}” start blocked — readiness check failed: ${error && error.message || error}`,
      });
    };
    starting.add(String(groupId));
    try {
      const readiness = getReadiness(group);
      if (readiness && typeof readiness.then === 'function') {
        return readiness.then(finishStart, failReadiness);
      }
      return finishStart(readiness);
    } catch (error) {
      return failReadiness(error);
    }
  }

  function fireStop(groupId) {
    if (disposed) return;
    clearTimer(groupId, 'stop');
    const group = getGroups().find(candidate => String(candidate.id) === String(groupId));
    if (!group) return;
    let stopped = 0;
    const ids = (Array.isArray(group.tasks) ? group.tasks : [])
      .map(task => String(task && task.id || ''))
      .filter(Boolean);
    if (ids.length) {
      try {
        stopTarget(ids);
        stopped = ids.length;
      } catch {}
    }
    // The stop boundary closes the whole window. Clear a still-pending start as well so a group
    // that spent its window waiting for sign-in or another group cannot launch afterward.
    clearBoth(groupId);
    emit({ groupId, event: 'stop', line: `[schedule] “${group.name}” stop fired — ${stopped} task(s) stopped` });
  }

  function processGroup(group) {
    const schedule = normalizeSchedule(group.schedule, group.site);
    if (!schedule) return;
    const decision = evaluateScheduleAction(schedule, {
      now: now(),
      groupRunning: groupHasRunningTasks(group, isTaskRunning),
    });
    if (decision.action === 'stop') return fireStop(group.id);
    if (decision.action === 'start') {
      fireStart(group.id);
      const refreshed = getGroups().find(candidate => String(candidate.id) === String(group.id));
      const stopAt = normalizeSchedule(refreshed && refreshed.schedule, refreshed && refreshed.site)?.stopAt;
      if (stopAt != null && stopAt > now()) armTimer(group.id, 'stop', stopAt);
      return;
    }
    if (decision.action === 'clear-both') {
      clearBoth(group.id);
      emit({ groupId: group.id, event: 'cleared', line: `[schedule] “${group.name}” cleared — ${decision.reason}` });
      return;
    }
    if (decision.action === 'clear-start') {
      clearStart(group.id);
      if (schedule.stopAt != null && schedule.stopAt > now()) armTimer(group.id, 'stop', schedule.stopAt);
      return;
    }
    if (schedule.startAt != null && schedule.startAt > now()) armTimer(group.id, 'start', schedule.startAt);
    if (schedule.stopAt != null && schedule.stopAt > now()) armTimer(group.id, 'stop', schedule.stopAt);
  }

  function sync() {
    if (disposed || paused || syncing) return;
    syncing = true;
    try {
      clearAllTimers();
      for (const group of getGroups()) {
        try { processGroup(group); }
        catch (error) {
          emit({ groupId: group && group.id, event: 'error', line: `[schedule] sync error — ${error.message || error}` });
        }
      }
    } finally {
      syncing = false;
    }
  }

  function dispose() {
    disposed = true;
    clearAllTimers();
    starting.clear();
  }

  function pause() {
    if (disposed) return;
    paused = true;
    clearAllTimers();
  }

  function resume() {
    if (disposed) return;
    paused = false;
    sync();
  }

  function snapshot() {
    return { disposed, paused, armed: [...timers.keys()], maxTimeoutMs: MAX_SAFE_TIMEOUT_MS };
  }

  function describeArmed() {
    return getGroups().filter(group => normalizeSchedule(group.schedule, group.site)).map(group => ({
      id: group.id,
      name: group.name,
      detail: scheduleDetailLine(group.schedule),
      schedule: normalizeSchedule(group.schedule, group.site),
    }));
  }

  return { sync, pause, resume, dispose, snapshot, describeArmed, fireStart, fireStop };
}

module.exports = { createTaskGroupScheduler };
