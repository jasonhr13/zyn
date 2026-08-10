const HARVESTER_BROWSERS = new Set(['auto', 'chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'opera', 'chromium']);
function managedHarvesterConfigs() {
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  // A missing setting is a fresh/legacy install with no user-created harvesters. Treat it as an
  // explicit empty managed list so starting checkout cannot resurrect the retired task-owned
  // producer and consume local or proxy bandwidth without the user configuring one.
  if (!Array.isArray(settings.targetHarvesters)) return [];
  return settings.targetHarvesters.map((raw, index) => {
    const type = ['login', 'atc', 'auto'].includes(raw && raw.type) ? raw.type : 'auto';
    const route = String((raw && raw.proxyListName) || '');
    const requestedWorkers = Math.max(1, Math.min(100, parseInt(raw && raw.workers, 10) || 1));
    return {
      id: String((raw && raw.id) || `harvester-${index + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 64),
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
      enabled: !!(raw && raw.enabled),
    };
  }).filter(config => config.id);
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
