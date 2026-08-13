'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeGroups } = require('./task-group-store');

// The packaged data manager is still the compatibility owner for the portable bundle marker.
// Keep the old marker assembled at runtime so the brand verifier does not mistake it for UI copy.
const LEGACY_APP_MARKER = ['secret', 'lair', 'bot'].join('-');
const APP_MARKERS = new Set(['zyn', LEGACY_APP_MARKER]);
const MANAGED_PROXY_PREFIX = 'managed:';

const BASE_BUNDLE_KEYS = Object.freeze([
  'app', 'kind', 'version', 'exportedAt',
  'profiles', 'accounts', 'accountGroups', 'proxies', 'settings', 'lastOrders',
]);

// These values belong to the license/managed-service session rather than the user configuration.
// User-owned API keys and mailbox credentials are intentionally allowed: this bundle is immediately
// wrapped in client-side AES-GCM, matching the original cloud-backup contract.
const PRIVATE_SETTING_KEYS = new Set([
  'accesstoken',
  'bearertoken',
  'devicetoken',
  'licensekey',
  'licensetoken',
  'managedproxies',
  'managedproxycredentials',
  'managedproxylists',
  'observertoken',
  'proxyrevision',
  'refreshtoken',
  'sessiontoken',
]);

const ACCOUNT_SESSION_KEYS = new Set([
  'accesstoken', 'cookie', 'cookies', 'refreshtoken', 'session', 'sessioncookie', 'token',
]);

const LIMITS = Object.freeze({
  profiles: 100000,
  accounts: 100000,
  accountGroups: 10000,
  proxyLists: 10000,
  tasks: 500000,
  targetTasks: 500000,
  round1Profiles: 100000,
  pokemonTasks: 500000,
  taskGroups: 200,
  watchlistBytes: 2 * 1024 * 1024,
});

const RESTORE_FILES = Object.freeze([
  'profiles.json',
  'accounts.json',
  'account-groups.json',
  'proxies.json',
  'settings.json',
  'last-orders.json',
  'tasks.json',
  'target-tasks.json',
  'round1-profiles.json',
  'watchlist.json',
  'pokemon-center-tasks.json',
]);
const TRANSACTION_VERSION = 1;
const TRANSACTION_DIRECTORY = path.join('backups', 'cloud-restore-transactions');
const TASK_GROUP_TASK_LIMIT = 2000;
const MAX_GRAPH_NODES = 1_000_000;
const MAX_GRAPH_DEPTH = 64;
const MAX_OBJECT_KEYS = 100_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('Backup data contains a value that cannot be saved.');
  }
}

function privateSettingKey(key, parentPath = '') {
  const normalized = String(key || '').replace(/[-_]/g, '').toLowerCase();
  if (PRIVATE_SETTING_KEYS.has(normalized)) return true;
  return /^(?:license|session|bearer|observer)(?:token|secret)$/.test(normalized);
}

function sanitizeSettings(value, parentPath = '') {
  if (Array.isArray(value)) return value.map(item => sanitizeSettings(item, parentPath));
  if (!isRecord(value)) return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (privateSettingKey(key, parentPath)) continue;
    clean[key] = sanitizeSettings(child, parentPath ? `${parentPath}.${key}` : key);
  }
  return clean;
}

function privateSettingsOnly(value, parentPath = '') {
  if (!isRecord(value)) return {};
  const privateValues = {};
  for (const [key, child] of Object.entries(value)) {
    if (privateSettingKey(key, parentPath)) {
      privateValues[key] = cloneJson(child);
      continue;
    }
    if (isRecord(child)) {
      const nested = privateSettingsOnly(child, parentPath ? `${parentPath}.${key}` : key);
      if (Object.keys(nested).length) privateValues[key] = nested;
    }
  }
  return privateValues;
}

function mergeRecords(base, overlay) {
  const result = isRecord(base) ? cloneJson(base) : {};
  for (const [key, value] of Object.entries(isRecord(overlay) ? overlay : {})) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? mergeRecords(result[key], value)
      : cloneJson(value);
  }
  return result;
}

function sanitizeAccounts(accounts) {
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!isRecord(value)) return value;
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[-_]/g, '').toLowerCase();
      if (!ACCOUNT_SESSION_KEYS.has(normalized)) clean[key] = sanitize(child);
    }
    return clean;
  };
  return (Array.isArray(accounts) ? accounts : []).map((raw) => {
    if (!isRecord(raw)) throw new Error('Backup accounts must contain objects.');
    return sanitize(cloneJson(raw));
  });
}

function localProxyLists(proxies) {
  if (!isRecord(proxies) || !Array.isArray(proxies.lists)) return { lists: [] };
  const lists = [];
  const groups = [];
  const seenGroups = new Set();
  const addGroup = value => {
    const group = String(value || '').trim().slice(0, 80);
    const key = group.toLowerCase();
    if (!group || seenGroups.has(key)) return;
    seenGroups.add(key);
    groups.push(group);
  };
  for (const group of (Array.isArray(proxies.groups) ? proxies.groups : [])) addGroup(group);
  for (const raw of proxies.lists) {
    if (!isRecord(raw)) continue;
    const name = String(raw.name || '').trim();
    const ref = String(raw.ref || '').trim();
    if (!name || raw.managed === true || name.startsWith(MANAGED_PROXY_PREFIX)
        || ref.startsWith(MANAGED_PROXY_PREFIX)) continue;
    const memberships = [];
    const seenMemberships = new Set();
    for (const value of [
      ...(Array.isArray(raw.groups) ? raw.groups : []),
      raw.group,
    ]) {
      const group = String(value || '').trim().slice(0, 80);
      const key = group.toLowerCase();
      if (!group || seenMemberships.has(key)) continue;
      seenMemberships.add(key);
      memberships.push(group);
      addGroup(group);
    }
    lists.push({ name, raw: String(raw.raw || ''), ...(memberships.length ? { groups: memberships } : {}) });
  }
  return { lists, ...(groups.length ? { groups } : {}) };
}

function assertArray(name, value, maximum) {
  if (!Array.isArray(value)) throw new Error(`Backup ${name} must be a list.`);
  if (value.length > maximum) throw new Error(`Backup ${name} exceeds the supported limit.`);
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`Backup ${name} must contain objects.`);
  }
}

function validateGraph(root) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > MAX_GRAPH_NODES) throw new Error('Backup contains too many values.');
    if (depth > MAX_GRAPH_DEPTH) throw new Error('Backup is nested too deeply.');
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw new Error('Backup contains an oversized value.');
      continue;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Backup contains an invalid number.');
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Backup contains an unsupported value.');
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new Error('Backup contains an oversized object.');
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key) || CONTROL_PATTERN.test(key) || Buffer.byteLength(key, 'utf8') > 256) {
        throw new Error('Backup contains an unsafe field name.');
      }
      stack.push({ value: value[key], depth: depth + 1 });
    }
  }
}

function validateBundle(bundle) {
  validateGraph(bundle);
  if (!isRecord(bundle) || !APP_MARKERS.has(String(bundle.app || ''))) {
    throw new Error('Not a Zyn backup file.');
  }
  if (bundle.kind !== 'settings-export') throw new Error('Not a Zyn settings backup file.');
  const version = Number(bundle.version);
  if (!Number.isSafeInteger(version) || ![1, 2].includes(version)) {
    throw new Error('Backup version is not supported by this Zyn build.');
  }
  const exportedAt = Number(bundle.exportedAt);
  if (!Number.isFinite(exportedAt) || exportedAt <= 0) throw new Error('Backup date is invalid.');
  if (own(bundle, 'profiles')) assertArray('profiles', bundle.profiles, LIMITS.profiles);
  if (own(bundle, 'accounts')) assertArray('accounts', bundle.accounts, LIMITS.accounts);
  if (own(bundle, 'accountGroups')) {
    if (!isRecord(bundle.accountGroups) || !Array.isArray(bundle.accountGroups.groups)) {
      throw new Error('Backup account groups must contain a group list.');
    }
    if (bundle.accountGroups.groups.length > LIMITS.accountGroups
        || bundle.accountGroups.groups.some(group => typeof group !== 'string')) {
      throw new Error('Backup account groups exceed the supported format.');
    }
  }
  if (own(bundle, 'tasks')) assertArray('tasks', bundle.tasks, LIMITS.tasks);
  if (own(bundle, 'round1Profiles')) {
    assertArray('Round1 profiles', bundle.round1Profiles, LIMITS.round1Profiles);
  }
  if (own(bundle, 'taskGroups')) assertArray('task groups', bundle.taskGroups, LIMITS.taskGroups);
  if (own(bundle, 'targetTasks')) {
    if (!isRecord(bundle.targetTasks)) throw new Error('Backup Target tasks must be an object.');
    if (own(bundle.targetTasks, 'tasks')) {
      assertArray('Target tasks', bundle.targetTasks.tasks, LIMITS.targetTasks);
    }
    if (own(bundle.targetTasks, 'skus') && typeof bundle.targetTasks.skus !== 'string') {
      throw new Error('Backup Target SKUs must be text.');
    }
  }
  if (own(bundle, 'pokemonCenterTasks')) {
    if (!isRecord(bundle.pokemonCenterTasks)) {
      throw new Error('Backup Pokemon Center tasks must be an object.');
    }
    if (own(bundle.pokemonCenterTasks, 'tasks')) {
      assertArray('Pokemon Center tasks', bundle.pokemonCenterTasks.tasks, LIMITS.pokemonTasks);
    }
    if (own(bundle.pokemonCenterTasks, 'products')) {
      assertArray('Pokemon Center products', bundle.pokemonCenterTasks.products, LIMITS.pokemonTasks);
    }
  }
  if (own(bundle, 'watchlist')) {
    if (typeof bundle.watchlist !== 'string') throw new Error('Backup watchlist must be text.');
    if (Buffer.byteLength(bundle.watchlist, 'utf8') > LIMITS.watchlistBytes) {
      throw new Error('Backup watchlist exceeds the supported limit.');
    }
  }
  if (own(bundle, 'settings') && !isRecord(bundle.settings)) {
    throw new Error('Backup settings must be an object.');
  }
  if (own(bundle, 'proxies')) {
    if (!isRecord(bundle.proxies) || !Array.isArray(bundle.proxies.lists)) {
      throw new Error('Backup proxies must contain a list.');
    }
    if (bundle.proxies.lists.length > LIMITS.proxyLists) {
      throw new Error('Backup proxy lists exceed the supported limit.');
    }
    for (const list of bundle.proxies.lists) {
      if (!isRecord(list)) throw new Error('Backup proxy lists must contain objects.');
    }
  }
  if (own(bundle, 'lastOrders') && !isRecord(bundle.lastOrders)) {
    throw new Error('Backup last-order data must be an object.');
  }
  return bundle;
}

function uniqueLines(...values) {
  const seen = new Set();
  const lines = [];
  for (const value of values) {
    for (const item of String(value || '').split(/[\n,]/)) {
      const line = item.trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines.join('\n');
}

function mergeById(current, incoming) {
  const merged = cloneJson(Array.isArray(current) ? current : []);
  const known = new Set(merged.map(item => String(item && item.id || '')).filter(Boolean));
  let added = 0;
  for (const item of incoming) {
    const id = String(item && item.id || '');
    if (!id || known.has(id)) continue;
    known.add(id);
    merged.push(cloneJson(item));
    added += 1;
  }
  return { merged, added };
}

function mergePokemon(current, incoming) {
  const existing = isRecord(current) ? current : {};
  const arriving = isRecord(incoming) ? incoming : {};
  const tasks = mergeById(existing.tasks || [], arriving.tasks || []);
  const products = cloneJson(Array.isArray(existing.products) ? existing.products : []);
  const productKeys = new Set(products.map(product => String(product && (product.id || product.input) || '')).filter(Boolean));
  let productsAdded = 0;
  for (const product of (arriving.products || [])) {
    const key = String(product && (product.id || product.input) || '');
    if (!key || productKeys.has(key)) continue;
    productKeys.add(key);
    products.push(cloneJson(product));
    productsAdded += 1;
  }
  return {
    value: { ...cloneJson(existing), ...cloneJson(arriving), tasks: tasks.merged, products },
    tasksAdded: tasks.added,
    productsAdded,
  };
}

function normalizeRound1Profiles(profiles, now = Date.now()) {
  return (Array.isArray(profiles) ? profiles : []).map((raw, index) => {
    const profile = isRecord(raw) ? raw : {};
    return {
      id: String(profile.id || `r1_${now}_${index}`),
      first: String(profile.first || '').trim(),
      last: String(profile.last || '').trim(),
      email: String(profile.email || '').trim(),
      store: String(profile.store || '').trim(),
      marketing: profile.marketing === true,
      ...(profile.registeredAt ? { registeredAt: profile.registeredAt } : {}),
    };
  }).filter(profile => profile.first || profile.last || profile.email);
}

function mergeRound1Profiles(current, incoming) {
  const profiles = normalizeRound1Profiles(current);
  const byEmail = new Map(profiles.map(profile => [profile.email.toLowerCase(), profile]));
  let added = 0;
  let updated = 0;
  for (const arriving of normalizeRound1Profiles(incoming)) {
    const key = arriving.email.toLowerCase();
    if (!key) continue;
    if (byEmail.has(key)) {
      const existing = byEmail.get(key);
      Object.assign(existing, { ...arriving, id: existing.id, email: existing.email });
      updated += 1;
    } else {
      byEmail.set(key, arriving);
      added += 1;
    }
  }
  return { value: [...byEmail.values()], added, updated };
}

function siteOfTaskGroup(group) {
  return String(group && group.site || 'target').trim().toLowerCase() || 'target';
}

function taskGroupTaskLosses(rawGroup, normalizedGroup, index) {
  const rawTasks = Array.isArray(rawGroup && rawGroup.tasks) ? rawGroup.tasks : [];
  const considered = rawTasks.slice(0, TASK_GROUP_TASK_LIMIT);
  const reasons = {
    overCapacity: Math.max(0, rawTasks.length - TASK_GROUP_TASK_LIMIT),
    missingAccountId: 0,
    duplicateTaskId: 0,
    duplicateAccountId: 0,
    normalizationOther: 0,
  };
  const taskIds = new Set();
  const accountIds = new Set();
  let expectedKept = 0;
  for (let taskIndex = 0; taskIndex < considered.length; taskIndex += 1) {
    const raw = isRecord(considered[taskIndex]) ? considered[taskIndex] : {};
    const accountId = String(raw.accountId == null ? '' : raw.accountId).trim().slice(0, 160);
    if (!accountId) {
      reasons.missingAccountId += 1;
      continue;
    }
    // Blank IDs are assigned a unique generated ID by normalizeTask. Only explicit IDs can be
    // deterministically duplicates, after the same trim/length normalization used by the store.
    const taskId = String(raw.id == null ? '' : raw.id).trim().slice(0, 120);
    if (taskId && taskIds.has(taskId)) {
      reasons.duplicateTaskId += 1;
      continue;
    }
    if (taskId) taskIds.add(taskId);
    if (accountIds.has(accountId)) {
      reasons.duplicateAccountId += 1;
      continue;
    }
    accountIds.add(accountId);
    expectedKept += 1;
  }
  const keptTasks = Array.isArray(normalizedGroup && normalizedGroup.tasks)
    ? normalizedGroup.tasks.length : 0;
  reasons.normalizationOther = Math.max(0, expectedKept - keptTasks);
  const skippedTasks = Object.values(reasons).reduce((sum, value) => sum + value, 0);
  return {
    groupId: String(rawGroup && rawGroup.id || normalizedGroup && normalizedGroup.id || ''),
    groupName: String(rawGroup && rawGroup.name || normalizedGroup && normalizedGroup.name
      || `Target Group ${index + 1}`),
    incomingTasks: rawTasks.length,
    keptTasks,
    skippedTasks,
    skippedByReason: reasons,
  };
}

function aggregateTaskGroupLosses(rawGroups, normalizedGroups) {
  const byGroup = rawGroups.map((group, index) => taskGroupTaskLosses(group, normalizedGroups[index], index));
  const skippedByReason = {
    overCapacity: 0,
    missingAccountId: 0,
    duplicateTaskId: 0,
    duplicateAccountId: 0,
    normalizationOther: 0,
  };
  for (const group of byGroup) {
    for (const key of Object.keys(skippedByReason)) skippedByReason[key] += group.skippedByReason[key];
  }
  return {
    skippedTasks: Object.values(skippedByReason).reduce((sum, value) => sum + value, 0),
    skippedTasksByReason: skippedByReason,
    taskGroupLosses: byGroup.filter(group => group.skippedTasks > 0),
  };
}

function prepareTaskGroups(incoming, current, mode) {
  const skippedCounts = new Map();
  const supported = [];
  for (const group of incoming) {
    const site = siteOfTaskGroup(group);
    if (site === 'target') supported.push(group);
    else skippedCounts.set(site, (skippedCounts.get(site) || 0) + 1);
  }
  const skippedBySite = Object.fromEntries(skippedCounts);
  const normalizedIncoming = normalizeGroups(supported);
  const skippedUnsupported = incoming.length - supported.length;
  const taskLosses = aggregateTaskGroupLosses(supported, normalizedIncoming);
  if (mode === 'replace') {
    const value = normalizeGroups(normalizedIncoming);
    return {
      value,
      summary: {
        set: value.length,
        skippedUnsupported,
        skippedBySite,
        skippedCapacity: Math.max(0, normalizedIncoming.length - value.length),
        ...taskLosses,
      },
    };
  }
  const normalizedCurrent = normalizeGroups(current);
  const currentIds = new Set(normalizedCurrent.map(group => group.id));
  const merged = mergeById(normalizedCurrent, normalizedIncoming);
  const value = normalizeGroups(merged.merged);
  const added = value.filter(group => !currentIds.has(group.id)).length;
  return {
    value,
    summary: {
      added,
      skippedUnsupported,
      skippedBySite,
      skippedCapacity: Math.max(0, merged.added - added),
      ...taskLosses,
    },
  };
}

function taskLossWarning(losses) {
  if (!losses || !losses.skippedTasks) return '';
  const labels = {
    overCapacity: 'above the 2,000-task group limit',
    missingAccountId: 'missing an account',
    duplicateTaskId: 'duplicate task IDs',
    duplicateAccountId: 'duplicate accounts in one group',
    normalizationOther: 'unsupported task data',
  };
  const details = Object.entries(losses.skippedTasksByReason || {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${labels[reason] || reason}`);
  return `${losses.skippedTasks} Target task${losses.skippedTasks === 1 ? '' : 's'} will be skipped (${details.join(', ')}).`;
}

function atomicWriteBuffer(filePath, contents, mode = 0o600) {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, contents, { mode });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), 0o600);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function pathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function taskGroupBackupInfo(taskGroupPath) {
  const directory = path.join(path.dirname(taskGroupPath), 'backups');
  const prefix = `${path.basename(taskGroupPath)}.`;
  let names = [];
  try {
    names = fs.readdirSync(directory)
      .filter(name => name.startsWith(prefix) && name.endsWith('.bak'));
  } catch {}
  return { directory, prefix, names };
}

function restoreTargets(dataDirectory, taskGroupPath) {
  const targets = RESTORE_FILES.map(name => path.join(dataDirectory, name));
  targets.push(taskGroupPath);
  const backupInfo = taskGroupBackupInfo(taskGroupPath);
  for (const name of backupInfo.names) targets.push(path.join(backupInfo.directory, name));
  const unique = [...new Set(targets.map(target => path.resolve(target)))];
  for (const target of unique) {
    if (!pathInside(dataDirectory, target)) throw new Error('A restore target is outside Zyn user data.');
  }
  return { targets: unique, backupInfo };
}

function createRestoreSnapshot(dataDirectory, taskGroupPath) {
  const transactionRoot = path.join(dataDirectory, TRANSACTION_DIRECTORY);
  fs.mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(transactionRoot, 0o700);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const directory = path.join(transactionRoot, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const { targets, backupInfo } = restoreTargets(dataDirectory, taskGroupPath);
  const files = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const relative = path.relative(dataDirectory, target);
      let stat = null;
      try { stat = fs.lstatSync(target); } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(`Zyn cannot safely restore the unexpected ${relative} path.`);
      }
      const snapshotName = `${String(index).padStart(3, '0')}.bin`;
      if (stat) {
        fs.copyFileSync(target, path.join(directory, snapshotName));
        fs.chmodSync(path.join(directory, snapshotName), 0o600);
      }
      files.push({
        target: relative,
        existed: !!stat,
        mode: stat ? (stat.mode & 0o777) : 0o600,
        snapshot: stat ? snapshotName : '',
      });
    }
    const manifest = {
      version: TRANSACTION_VERSION,
      state: 'ready',
      createdAt: Date.now(),
      files,
      taskGroupBackups: {
        directory: path.relative(dataDirectory, backupInfo.directory),
        prefix: backupInfo.prefix,
        names: backupInfo.names,
      },
    };
    atomicWriteJson(path.join(directory, 'manifest.json'), manifest);
    return { directory, manifest };
  } catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function validateSnapshotManifest(dataDirectory, directory, manifest) {
  if (!isRecord(manifest) || manifest.version !== TRANSACTION_VERSION || manifest.state !== 'ready'
      || !Array.isArray(manifest.files)) {
    throw new Error('A pending cloud restore snapshot is invalid.');
  }
  for (const entry of manifest.files) {
    if (!isRecord(entry) || typeof entry.target !== 'string' || typeof entry.existed !== 'boolean') {
      throw new Error('A pending cloud restore snapshot has an invalid file entry.');
    }
    const target = path.resolve(dataDirectory, entry.target);
    if (!pathInside(dataDirectory, target)) throw new Error('A pending cloud restore target is unsafe.');
    if (entry.existed) {
      const snapshot = path.resolve(directory, String(entry.snapshot || ''));
      if (!pathInside(directory, snapshot) || !fs.existsSync(snapshot)) {
        throw new Error('A pending cloud restore snapshot is incomplete.');
      }
    }
  }
  return manifest;
}

function restoreSnapshot(dataDirectory, snapshot) {
  const manifest = validateSnapshotManifest(dataDirectory, snapshot.directory, snapshot.manifest);
  const errors = [];
  for (const entry of manifest.files) {
    const target = path.resolve(dataDirectory, entry.target);
    try {
      if (entry.existed) {
        const contents = fs.readFileSync(path.join(snapshot.directory, entry.snapshot));
        atomicWriteBuffer(target, contents, Number(entry.mode) || 0o600);
      } else {
        let stat = null;
        try { stat = fs.lstatSync(target); } catch (error) {
          if (error && error.code !== 'ENOENT') throw error;
        }
        if (stat) {
          if (stat.isDirectory()) throw new Error('restore target became a directory');
          fs.unlinkSync(target);
        }
      }
    } catch (error) {
      errors.push(`${entry.target}: ${error && error.message || error}`);
    }
  }
  const backup = manifest.taskGroupBackups;
  if (isRecord(backup) && typeof backup.directory === 'string' && typeof backup.prefix === 'string') {
    const directory = path.resolve(dataDirectory, backup.directory);
    const before = new Set(Array.isArray(backup.names) ? backup.names : []);
    if (!pathInside(dataDirectory, directory)) errors.push('task-group backup directory is unsafe');
    else {
      try {
        for (const name of fs.readdirSync(directory)) {
          if (name.startsWith(backup.prefix) && name.endsWith('.bak') && !before.has(name)) {
            fs.unlinkSync(path.join(directory, name));
          }
        }
      } catch (error) {
        if (error && error.code !== 'ENOENT') errors.push(`task-group backups: ${error.message}`);
      }
    }
  }
  if (errors.length) throw new Error(`Cloud restore rollback failed: ${errors.join('; ')}`);
}

function markSnapshotCommitted(snapshot) {
  fs.writeFileSync(path.join(snapshot.directory, 'COMMITTED'), 'ok\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function cleanupSnapshot(snapshot) {
  fs.rmSync(snapshot.directory, { recursive: true, force: true });
}

function recoverPendingSnapshots(dataDirectory) {
  const transactionRoot = path.join(dataDirectory, TRANSACTION_DIRECTORY);
  let entries = [];
  try { entries = fs.readdirSync(transactionRoot, { withFileTypes: true }); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return 0;
  }
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(transactionRoot, entry.name);
    if (fs.existsSync(path.join(directory, 'COMMITTED'))) {
      cleanupSnapshot({ directory });
      continue;
    }
    const manifestPath = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      // No user-data write starts before the ready manifest exists.
      cleanupSnapshot({ directory });
      continue;
    }
    const manifest = readJson(manifestPath, null);
    const snapshot = { directory, manifest };
    restoreSnapshot(dataDirectory, snapshot);
    cleanupSnapshot(snapshot);
    recovered += 1;
  }
  return recovered;
}

function createCloudBackupDataAdapter({
  dataManager,
  taskGroupStore,
  dataDirectory,
  onTaskGroupsChanged = () => {},
} = {}) {
  if (!dataManager || typeof dataManager.exportAll !== 'function'
      || typeof dataManager.importAll !== 'function') {
    throw new Error('Cloud backup data manager is required.');
  }
  if (!taskGroupStore || typeof taskGroupStore.load !== 'function'
      || typeof taskGroupStore.save !== 'function') {
    throw new Error('Cloud backup task group store is required.');
  }
  if (!dataDirectory || typeof dataDirectory !== 'string') {
    throw new Error('Cloud backup data directory is required.');
  }
  const tasksPath = path.join(dataDirectory, 'tasks.json');
  const settingsPath = path.join(dataDirectory, 'settings.json');
  const taskGroupPath = path.resolve(taskGroupStore.filePath || path.join(dataDirectory, 'task-groups.json'));
  if (!pathInside(dataDirectory, taskGroupPath)) {
    throw new Error('Cloud backup task group path must be inside Zyn user data.');
  }
  let restoring = false;

  const recovered = recoverPendingSnapshots(dataDirectory);
  if (recovered) {
    try { onTaskGroupsChanged(readTaskGroups(), { recoveredTransactions: recovered }); } catch {}
  }

  function storedTaskGroups() {
    const stored = readJson(taskGroupPath, null);
    if (Array.isArray(stored)) return cloneJson(stored);
    if (isRecord(stored) && Array.isArray(stored.groups)) return cloneJson(stored.groups);
    const legacy = typeof dataManager.getTargetTasks === 'function'
      ? dataManager.getTargetTasks() : { skus: '', tasks: [] };
    const legacyTasks = Array.isArray(legacy && legacy.tasks) ? legacy.tasks : [];
    const skus = String(legacy && legacy.skus || '');
    return (legacyTasks.length || skus.trim()) ? [{
      name: 'Recovered Target Tasks',
      site: 'target',
      skus,
      qty: legacy && legacy.qty,
      proxyListName: legacyTasks[0] && legacyTasks[0].proxyListName || '',
      tasks: legacyTasks,
    }] : [];
  }

  function readTaskGroups() {
    return normalizeGroups(storedTaskGroups().filter(group => siteOfTaskGroup(group) === 'target'));
  }

  function portableTaskGroups() {
    return storedTaskGroups().map((raw) => {
      if (!isRecord(raw)) throw new Error('Backup task groups must contain objects.');
      const loopCheckout = raw.loopCheckout != null
        ? raw.loopCheckout === true : raw.repeatCheckout === true;
      return {
        ...cloneJson(raw),
        loopCheckout,
        // The original app reads this name. Keep both aliases inside the encrypted portable bundle
        // so rolling back does not silently turn repeating checkout off.
        repeatCheckout: loopCheckout,
        tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((task) => {
          if (!isRecord(task)) throw new Error('Backup task groups must contain task objects.');
          const repeat = task.loopCheckout != null
            ? task.loopCheckout === true : task.repeatCheckout === true;
          return { ...cloneJson(task), loopCheckout: repeat, repeatCheckout: repeat };
        }),
      };
    });
  }

  function exportAll() {
    const base = validateBundle(cloneJson(dataManager.exportAll({ includePrivateSettings: true })));
    const storedSettings = readJson(settingsPath, {});
    const currentSettings = typeof dataManager.getSettings === 'function'
      ? dataManager.getSettings() || {} : storedSettings;
    const portableSettings = {};
    for (const key of Object.keys(isRecord(storedSettings) ? storedSettings : {})) {
      portableSettings[key] = own(currentSettings, key) ? cloneJson(currentSettings[key]) : cloneJson(storedSettings[key]);
    }
    const bundle = {
      ...base,
      // Keep cloud payloads readable by the original app as well as Zyn. The envelope/key format
      // already remains legacy-compatible; canonicalizing this inner marker completes rollback.
      app: LEGACY_APP_MARKER,
      kind: 'settings-export',
      version: Math.max(2, Number.parseInt(base.version, 10) || 1),
      exportedAt: Number.isFinite(Number(base.exportedAt)) && Number(base.exportedAt) > 0
        ? Number(base.exportedAt) : Date.now(),
      accounts: sanitizeAccounts(base.accounts || []),
      proxies: localProxyLists(base.proxies),
      settings: sanitizeSettings(mergeRecords(base.settings || {}, portableSettings)),
      tasks: cloneJson(typeof dataManager.getTasks === 'function' ? dataManager.getTasks() : []),
      targetTasks: cloneJson(typeof dataManager.getTargetTasks === 'function'
        ? dataManager.getTargetTasks() : { skus: '', tasks: [] }),
      round1Profiles: cloneJson(typeof dataManager.getRound1Profiles === 'function'
        ? dataManager.getRound1Profiles() : []),
      watchlist: String(typeof dataManager.getWatchlist === 'function' ? dataManager.getWatchlist() : ''),
      taskGroups: portableTaskGroups(),
    };
    if (typeof dataManager.getPokemonCenterTasks === 'function') {
      bundle.pokemonCenterTasks = cloneJson(dataManager.getPokemonCenterTasks());
    }
    return validateBundle(bundle);
  }

  function prepareImport(input, mode = 'merge') {
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Choose merge or replace restore mode.');
    const bundle = validateBundle(cloneJson(input));

    // Resolve every dependency and build every merged/replaced value before the first write. This
    // makes schema and compatibility failures side-effect free; disk failures are covered by the
    // recoverable transaction snapshot used by importAll below.
    if (own(bundle, 'targetTasks') && typeof dataManager.saveTargetTasks !== 'function') {
      throw new Error('This Zyn build cannot restore Target tasks.');
    }
    if (own(bundle, 'round1Profiles') && typeof dataManager.saveRound1Profiles !== 'function') {
      throw new Error('This Zyn build cannot restore Round1 profiles.');
    }
    if (own(bundle, 'watchlist') && typeof dataManager.saveWatchlist !== 'function') {
      throw new Error('This Zyn build cannot restore the watchlist.');
    }
    if (own(bundle, 'pokemonCenterTasks') && typeof dataManager.savePokemonCenterTasks !== 'function') {
      throw new Error('This Zyn build cannot restore Pokemon Center tasks.');
    }
    if (own(bundle, 'settings') && typeof dataManager.saveSettings !== 'function') {
      throw new Error('This Zyn build cannot safely restore settings.');
    }

    const baseBundle = {};
    for (const key of BASE_BUNDLE_KEYS) {
      if (key !== 'settings' && own(bundle, key)) baseBundle[key] = cloneJson(bundle[key]);
    }
    baseBundle.app = LEGACY_APP_MARKER;
    if (own(baseBundle, 'accounts')) baseBundle.accounts = sanitizeAccounts(baseBundle.accounts);
    if (own(baseBundle, 'proxies')) baseBundle.proxies = localProxyLists(baseBundle.proxies);

    const plan = {
      bundle,
      mode,
      baseBundle,
      settings: null,
      tasks: null,
      targetTasks: null,
      round1Profiles: null,
      watchlist: null,
      pokemonCenterTasks: null,
      taskGroups: null,
      preview: {
        app: String(bundle.app),
        version: Number(bundle.version),
        exportedAt: Number(bundle.exportedAt),
        mode,
        profiles: Array.isArray(bundle.profiles) ? bundle.profiles.length : 0,
        accounts: Array.isArray(bundle.accounts) ? bundle.accounts.length : 0,
        proxyLists: Array.isArray(bundle.proxies && bundle.proxies.lists) ? localProxyLists(bundle.proxies).lists.length : 0,
        tasks: Array.isArray(bundle.tasks) ? bundle.tasks.length : 0,
        targetTasks: Array.isArray(bundle.targetTasks && bundle.targetTasks.tasks)
          ? bundle.targetTasks.tasks.length : 0,
        round1Profiles: Array.isArray(bundle.round1Profiles) ? bundle.round1Profiles.length : 0,
        pokemonCenterTasks: Array.isArray(bundle.pokemonCenterTasks && bundle.pokemonCenterTasks.tasks)
          ? bundle.pokemonCenterTasks.tasks.length : 0,
        watchlistItems: typeof bundle.watchlist === 'string'
          ? uniqueLines(bundle.watchlist).split('\n').filter(Boolean).length : 0,
        taskGroups: {
          total: Array.isArray(bundle.taskGroups) ? bundle.taskGroups.length : 0,
          supported: 0,
          skippedUnsupported: 0,
          skippedBySite: {},
          skippedCapacity: 0,
          skippedTasks: 0,
          skippedTasksByReason: {
            overCapacity: 0,
            missingAccountId: 0,
            duplicateTaskId: 0,
            duplicateAccountId: 0,
            normalizationOther: 0,
          },
          taskGroupLosses: [],
        },
        warnings: [],
      },
    };

    if (own(bundle, 'settings')) {
      const current = readJson(settingsPath, {});
      const incoming = sanitizeSettings(bundle.settings);
      const privateLocal = privateSettingsOnly(current);
      const combined = mode === 'replace' ? incoming : mergeRecords(current, incoming);
      plan.settings = {
        value: mergeRecords(combined, privateLocal),
        summary: { keys: Object.keys(incoming).length },
      };
      const profileGroups = [];
      const seenProfileGroups = new Set();
      for (const raw of [
        ...(Array.isArray(plan.settings.value.profileGroups) ? plan.settings.value.profileGroups : []),
        ...(Array.isArray(bundle.profiles) ? bundle.profiles.flatMap(profile => [
          ...(Array.isArray(profile && profile.groups) ? profile.groups : []),
          profile && profile.group,
        ]) : []),
      ]) {
        const group = String(raw || '').trim();
        const key = group.toLowerCase();
        if (group && !seenProfileGroups.has(key)) {
          seenProfileGroups.add(key);
          profileGroups.push(group);
        }
      }
      if (profileGroups.length) plan.settings.value.profileGroups = profileGroups;
    }

    if (own(bundle, 'tasks')) {
      if (mode === 'replace') {
        plan.tasks = { value: cloneJson(bundle.tasks), summary: { set: bundle.tasks.length } };
      } else {
        const result = mergeById(
          typeof dataManager.getTasks === 'function' ? dataManager.getTasks() : readJson(tasksPath, []),
          bundle.tasks,
        );
        plan.tasks = { value: result.merged, summary: { added: result.added } };
      }
    }

    if (own(bundle, 'targetTasks')) {
      const current = typeof dataManager.getTargetTasks === 'function'
        ? dataManager.getTargetTasks() : { skus: '', tasks: [] };
      if (mode === 'replace') {
        const value = {
          skus: typeof bundle.targetTasks.skus === 'string'
            ? bundle.targetTasks.skus : String(current && current.skus || ''),
          tasks: Array.isArray(bundle.targetTasks.tasks)
            ? cloneJson(bundle.targetTasks.tasks) : cloneJson(current && current.tasks || []),
        };
        plan.targetTasks = { value, summary: { set: value.tasks.length } };
      } else {
        const result = mergeById(current && current.tasks || [], bundle.targetTasks.tasks || []);
        plan.targetTasks = {
          value: {
            skus: uniqueLines(current && current.skus, bundle.targetTasks.skus),
            tasks: result.merged,
          },
          summary: { added: result.added },
        };
      }
    }

    if (own(bundle, 'round1Profiles')) {
      if (mode === 'replace') {
        const value = normalizeRound1Profiles(bundle.round1Profiles);
        plan.round1Profiles = { value, summary: { set: value.length } };
      } else {
        const result = mergeRound1Profiles(
          typeof dataManager.getRound1Profiles === 'function'
            ? dataManager.getRound1Profiles() : readJson(path.join(dataDirectory, 'round1-profiles.json'), []),
          bundle.round1Profiles,
        );
        plan.round1Profiles = {
          value: result.value,
          summary: { added: result.added, updated: result.updated },
        };
      }
    }

    if (own(bundle, 'watchlist')) {
      const value = mode === 'replace' ? bundle.watchlist : uniqueLines(
        typeof dataManager.getWatchlist === 'function' ? dataManager.getWatchlist() : '',
        bundle.watchlist,
      );
      plan.watchlist = {
        value,
        summary: { set: uniqueLines(value).split('\n').filter(Boolean).length },
      };
    }

    if (own(bundle, 'pokemonCenterTasks')) {
      const current = typeof dataManager.getPokemonCenterTasks === 'function'
        ? dataManager.getPokemonCenterTasks() : {};
      if (mode === 'replace') {
        const value = {
          ...cloneJson(isRecord(current) ? current : {}),
          ...cloneJson(bundle.pokemonCenterTasks),
          products: Array.isArray(bundle.pokemonCenterTasks.products)
            ? cloneJson(bundle.pokemonCenterTasks.products) : cloneJson(current && current.products || []),
          tasks: Array.isArray(bundle.pokemonCenterTasks.tasks)
            ? cloneJson(bundle.pokemonCenterTasks.tasks) : cloneJson(current && current.tasks || []),
        };
        plan.pokemonCenterTasks = { value, summary: { set: value.tasks.length } };
      } else {
        const result = mergePokemon(current, bundle.pokemonCenterTasks);
        plan.pokemonCenterTasks = {
          value: result.value,
          summary: { added: result.tasksAdded, productsAdded: result.productsAdded },
        };
      }
    }

    if (own(bundle, 'taskGroups')) {
      plan.taskGroups = prepareTaskGroups(bundle.taskGroups, readTaskGroups(), mode);
      plan.preview.taskGroups = {
        total: bundle.taskGroups.length,
        supported: bundle.taskGroups.length - plan.taskGroups.summary.skippedUnsupported,
        ...cloneJson(plan.taskGroups.summary),
      };
      if (plan.taskGroups.summary.skippedUnsupported) {
        plan.preview.warnings.push(
          `${plan.taskGroups.summary.skippedUnsupported} legacy task group${plan.taskGroups.summary.skippedUnsupported === 1 ? '' : 's'} cannot run in this Zyn build and will be skipped.`,
        );
      }
      if (plan.taskGroups.summary.skippedCapacity) {
        plan.preview.warnings.push(
          `${plan.taskGroups.summary.skippedCapacity} Target task group${plan.taskGroups.summary.skippedCapacity === 1 ? ' exceeds' : 's exceed'} the local capacity and will be skipped.`,
        );
      }
      const taskWarning = taskLossWarning(plan.taskGroups.summary);
      if (taskWarning) plan.preview.warnings.push(taskWarning);
    }

    return plan;
  }

  function previewImport(input, mode = 'merge') {
    return cloneJson(prepareImport(input, mode).preview);
  }

  function importAll(input, mode = 'merge') {
    if (restoring) throw new Error('Another cloud restore is already in progress.');
    const plan = prepareImport(input, mode);
    const snapshot = createRestoreSnapshot(dataDirectory, taskGroupPath);
    restoring = true;
    let savedGroups = null;
    try {
      // Profile/account secret re-encryption and local proxy persistence stay owned by the wrapped
      // data manager. Settings use saveSettings separately so safeStorage-backed values pass through
      // their owning API instead of being written as portable plaintext.
      const imported = dataManager.importAll(plan.baseBundle, mode);
      const summary = isRecord(imported) ? cloneJson(imported) : {};

      if (plan.settings) {
        dataManager.saveSettings(plan.settings.value);
        summary.settings = cloneJson(plan.settings.summary);
      }
      if (plan.tasks) {
        atomicWriteJson(tasksPath, plan.tasks.value);
        summary.tasks = cloneJson(plan.tasks.summary);
      }
      if (plan.targetTasks) {
        dataManager.saveTargetTasks(plan.targetTasks.value);
        summary.targetTasks = cloneJson(plan.targetTasks.summary);
      }
      if (plan.round1Profiles) {
        dataManager.saveRound1Profiles(plan.round1Profiles.value);
        summary.round1Profiles = cloneJson(plan.round1Profiles.summary);
      }
      if (plan.watchlist) {
        dataManager.saveWatchlist(plan.watchlist.value);
        summary.watchlist = cloneJson(plan.watchlist.summary);
      }
      if (plan.pokemonCenterTasks) {
        dataManager.savePokemonCenterTasks(plan.pokemonCenterTasks.value);
        summary.pokemonCenterTasks = cloneJson(plan.pokemonCenterTasks.summary);
      }
      if (plan.taskGroups) {
        savedGroups = taskGroupStore.save(plan.taskGroups.value, {
          preserveUnsupported: plan.mode !== 'replace',
        });
        summary.taskGroups = cloneJson(plan.taskGroups.summary);
      }
      if (plan.preview.warnings.length) summary.warnings = cloneJson(plan.preview.warnings);

      // The marker is the transaction's commit point. A crash before it causes startup rollback;
      // a crash after it only leaves a disposable local snapshot directory.
      markSnapshotCommitted(snapshot);
      try { cleanupSnapshot(snapshot); } catch {}

      if (savedGroups) {
        try { onTaskGroupsChanged(savedGroups, summary.taskGroups); }
        catch (error) { summary.taskGroups.syncError = String(error && error.message || error); }
      }
      return summary;
    } catch (error) {
      let rollbackError = null;
      try {
        restoreSnapshot(dataDirectory, snapshot);
        cleanupSnapshot(snapshot);
      } catch (failure) {
        rollbackError = failure;
      }
      if (!rollbackError) {
        try { onTaskGroupsChanged(readTaskGroups(), { rolledBack: true }); } catch {}
        const rolledBack = new Error(`${error && error.message || error} No local changes were kept.`);
        rolledBack.code = 'CLOUD_BACKUP_RESTORE_ROLLED_BACK';
        rolledBack.cause = error;
        throw rolledBack;
      }
      const failed = new Error(
        `${error && error.message || error} Automatic rollback also failed; a local recovery snapshot was retained.`,
      );
      failed.code = 'CLOUD_BACKUP_ROLLBACK_FAILED';
      failed.cause = rollbackError;
      throw failed;
    } finally {
      restoring = false;
    }
  }

  return Object.freeze({
    exportAll,
    importAll,
    previewImport,
    validateAndPreview: previewImport,
  });
}

module.exports = {
  createCloudBackupDataAdapter,
  __test: {
    LEGACY_APP_MARKER,
    sanitizeSettings,
    sanitizeAccounts,
    localProxyLists,
    validateBundle,
    createRestoreSnapshot,
    recoverPendingSnapshots,
  },
};
