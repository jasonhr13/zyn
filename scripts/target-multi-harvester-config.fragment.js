const HARVESTER_BROWSERS = new Set(['auto', 'chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'opera', 'chromium']);
// Running is deliberately session-only. Persisted settings describe how a harvester should run,
// but only an explicit Start-button IPC may add its id to this set. This prevents app startup,
// settings saves, proxy edits, restores, and the periodic reconciler from reviving old run state.
const explicitlyStartedHarvesterIds = new Set();

function normalizedManagedHarvesterId(value, fallback = '') {
  return String(value || fallback).replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
}

function setManagedHarvesterRunning(command = {}) {
  const id = normalizedManagedHarvesterId(command && command.id);
  if (!id || (command.running !== true && command.running !== false)) return false;
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  const configured = Array.isArray(settings.targetHarvesters)
    && settings.targetHarvesters.some((raw, index) => normalizedManagedHarvesterId(
      raw && raw.id, `harvester-${index + 1}`,
    ) === id);
  if (!configured) {
    explicitlyStartedHarvesterIds.delete(id);
    return false;
  }
  if (command.running) explicitlyStartedHarvesterIds.add(id);
  else explicitlyStartedHarvesterIds.delete(id);
  return true;
}

function managedHarvesterConfigs() {
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  // A missing setting is a fresh/legacy install with no user-created harvesters. Treat it as an
  // explicit empty managed list so starting checkout cannot resurrect the retired task-owned
  // producer and consume local or proxy bandwidth without the user configuring one.
  if (!Array.isArray(settings.targetHarvesters)) return [];
  const configs = settings.targetHarvesters.map((raw, index) => {
    const type = ['login', 'atc', 'auto'].includes(raw && raw.type) ? raw.type : 'auto';
    const route = String((raw && raw.proxyListName) || '');
    const requestedWorkers = Math.max(1, Math.min(100, parseInt(raw && raw.workers, 10) || 1));
    const id = normalizedManagedHarvesterId(raw && raw.id, `harvester-${index + 1}`);
    return {
      id,
      name: String((raw && raw.name) || `Harvester ${index + 1}`).slice(0, 80),
      type,
      atcMode: raw && raw.atcMode === 'v2' ? 'v2' : 'v1',
      browser: HARVESTER_BROWSERS.has(raw && raw.browser) ? raw.browser : 'auto',
      proxyListName: route,
      // Two home-IP workers are useful; more only duplicates one route and is unnecessarily noisy.
      workers: type === 'login' ? 1 : route ? requestedWorkers : Math.min(2, requestedWorkers),
      input: String((raw && raw.input) || '').slice(0, 12000),
      cookieTtlSec: Math.max(30, Math.min(86400, parseInt(raw && raw.cookieTtlSec, 10) || 600)),
      intervalDelaySec: Math.max(0, Math.min(3600, parseInt(raw && raw.intervalDelaySec, 10) || 0)),
      startSchedule: String((raw && raw.startSchedule) || ''),
      stopSchedule: String((raw && raw.stopSchedule) || ''),
      enabled: explicitlyStartedHarvesterIds.has(id),
    };
  }).filter(config => config.id);
  const configuredIds = new Set(configs.map(config => config.id));
  for (const id of [...explicitlyStartedHarvesterIds]) {
    if (!configuredIds.has(id)) explicitlyStartedHarvesterIds.delete(id);
  }
  return configs;
}

function harvesterScheduleActive(config, now = Date.now()) {
  if (!config.enabled) return false;
  const startsAt = config.startSchedule ? Date.parse(config.startSchedule) : NaN;
  const stopsAt = config.stopSchedule ? Date.parse(config.stopSchedule) : NaN;
  if (Number.isFinite(startsAt) && now < startsAt) return false;
  if (Number.isFinite(stopsAt) && now >= stopsAt) return false;
  return true;
}

function managedHarvesterMode() { return managedHarvesterConfigs() !== null; }
