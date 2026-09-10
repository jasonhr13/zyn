'use strict';

// How many more cookies a remote harvester may mint. Full Engine's per-task target is the
// absolute bank size (16 tasks × 20 = 320). Remotes used to copy that number onto an empty
// local pool, so workers never parked and kept burning proxy after the engine was full.
function filledCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function remainingOf(absolute, filled) {
  if (absolute === null) return null;
  return Math.max(0, filledCount(absolute) - filledCount(filled));
}

function remainingHarvestTargets({ current = {}, targets = {}, waiting = {} } = {}) {
  const abs = targets && typeof targets === 'object' ? targets : {};
  const have = current && typeof current === 'object' ? current : {};
  const wait = waiting && typeof waiting === 'object' ? waiting : {};
  const login = remainingOf(
    Object.prototype.hasOwnProperty.call(abs, 'login') ? abs.login : 0,
    have.login,
  );
  const atc = remainingOf(
    Object.prototype.hasOwnProperty.call(abs, 'atc') ? abs.atc : 0,
    have.atc,
  );
  return {
    login: login === null ? null : Math.max(login, filledCount(wait.login)),
    atc: atc === null ? null : Math.max(atc, filledCount(wait.atc)),
  };
}

function hasHarvestRoom(room, type) {
  if (!room || typeof room !== 'object') return false;
  const remaining = room[type];
  return remaining === null || remaining > 0;
}

module.exports = {
  remainingHarvestTargets,
  remainingOf,
  hasHarvestRoom,
};
