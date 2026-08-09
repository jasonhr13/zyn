'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TASK_GROUP_SCHEMA_VERSION = 2;
const TASK_GROUP_FILE = 'task-groups.json';
const LEGACY_TARGET_FILE = 'target-tasks.json';
const MAX_GROUPS = 200;
const MAX_TASKS_PER_GROUP = 2000;

function boundedText(value, maximum, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text.slice(0, maximum);
}

function quantity(value) {
  return Math.max(1, Math.min(99, Number.parseInt(value, 10) || 2));
}

function normalizeSchedule(raw, site = 'target') {
  if (String(site || '').toLowerCase() !== 'target' || !raw || typeof raw !== 'object') return null;
  const epoch = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
  };
  const startAt = epoch(raw.startAt);
  let stopAt = epoch(raw.stopAt);
  if (startAt != null && stopAt != null && stopAt <= startAt) stopAt = null;
  return startAt == null && stopAt == null ? null : { startAt, stopAt };
}

function safeId(value, prefix, createId) {
  return boundedText(value, 120) || `${prefix}_${createId()}`;
}

function normalizeTask(raw, group, index, createId) {
  const task = raw && typeof raw === 'object' ? raw : {};
  const accountId = boundedText(task.accountId, 160);
  if (!accountId) return null;
  return {
    id: safeId(task.id, `task${index + 1}`, createId),
    accountId,
    profileId: boundedText(task.profileId, 160),
    proxyListName: boundedText(task.proxyListName, 240, group.proxyListName),
    cardId: boundedText(task.cardId, 160),
    createdAt: Number(task.createdAt) > 0 ? Math.floor(Number(task.createdAt)) : group.createdAt,
  };
}

function normalizeGroup(raw, index = 0, options = {}) {
  const group = raw && typeof raw === 'object' ? raw : {};
  const createId = options.createId || (() => crypto.randomUUID());
  const now = options.now || Date.now();
  const createdAt = Number(group.createdAt) > 0 ? Math.floor(Number(group.createdAt)) : now;
  const normalized = {
    id: safeId(group.id, `group${index + 1}`, createId),
    name: boundedText(group.name, 80, `Target Group ${index + 1}`) || `Target Group ${index + 1}`,
    site: 'target',
    skus: String(group.skus || '').slice(0, 20000),
    qty: quantity(group.qty),
    proxyListName: boundedText(group.proxyListName, 240),
    createdAt,
    updatedAt: Number(group.updatedAt) > 0 ? Math.floor(Number(group.updatedAt)) : now,
    tasks: [],
  };
  const schedule = normalizeSchedule(group.schedule, normalized.site);
  if (schedule) normalized.schedule = schedule;
  normalized.tasks = (Array.isArray(group.tasks) ? group.tasks : [])
    .slice(0, MAX_TASKS_PER_GROUP)
    .map((task, taskIndex) => normalizeTask(task, normalized, taskIndex, createId))
    .filter(Boolean)
    .filter((task, taskIndex, tasks) => tasks.findIndex(candidate => candidate.id === task.id) === taskIndex)
    .filter((task, taskIndex, tasks) => tasks.findIndex(candidate => candidate.accountId === task.accountId) === taskIndex);
  return normalized;
}

function normalizeGroups(groups, options = {}) {
  const seen = new Set();
  return (Array.isArray(groups) ? groups : [])
    .slice(0, MAX_GROUPS)
    .map((group, index) => normalizeGroup(group, index, options))
    .map((group) => {
      if (!seen.has(group.id)) {
        seen.add(group.id);
        return group;
      }
      const createId = options.createId || (() => crypto.randomUUID());
      const next = { ...group, id: `group_${createId()}` };
      seen.add(next.id);
      return next;
    });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function backupCurrent(filePath, maximum = 5) {
  if (!fs.existsSync(filePath)) return;
  const directory = path.join(path.dirname(filePath), 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `${path.basename(filePath)}.`;
  const backup = path.join(directory, `${prefix}${Date.now()}.bak`);
  fs.copyFileSync(filePath, backup);
  fs.chmodSync(backup, 0o600);
  const old = fs.readdirSync(directory)
    .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
    .sort()
    .reverse()
    .slice(maximum);
  for (const name of old) fs.unlinkSync(path.join(directory, name));
}

function createTaskGroupStore(dataDirectory, options = {}) {
  const filePath = path.join(dataDirectory, TASK_GROUP_FILE);
  const legacyPath = path.join(dataDirectory, LEGACY_TARGET_FILE);
  const normalizeOptions = {
    createId: options.createId || (() => crypto.randomUUID()),
    now: options.now || Date.now(),
  };

  const write = (groups, withBackup = true) => {
    const clean = normalizeGroups(groups, normalizeOptions);
    if (withBackup) {
      try { backupCurrent(filePath); } catch {}
    }
    atomicWrite(filePath, { version: TASK_GROUP_SCHEMA_VERSION, groups: clean });
    return clean;
  };

  const migrateLegacy = () => {
    const legacy = readJson(legacyPath, { skus: '', tasks: [] });
    const tasks = Array.isArray(legacy && legacy.tasks) ? legacy.tasks : [];
    const skus = String((legacy && legacy.skus) || '');
    const groups = (tasks.length || skus.trim()) ? [{
      name: 'Recovered Target Tasks',
      site: 'target',
      skus,
      qty: legacy && legacy.qty,
      proxyListName: (tasks[0] && tasks[0].proxyListName) || '',
      tasks,
    }] : [];
    return write(groups, false);
  };

  return Object.freeze({
    filePath,
    load() {
      if (!fs.existsSync(filePath)) return migrateLegacy();
      const stored = readJson(filePath, { groups: [] });
      return normalizeGroups(Array.isArray(stored) ? stored : stored.groups, normalizeOptions);
    },
    save(groups) {
      return write(groups, true);
    },
  });
}

module.exports = {
  TASK_GROUP_SCHEMA_VERSION,
  normalizeSchedule,
  normalizeGroup,
  normalizeGroups,
  createTaskGroupStore,
};
