import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sameTargetBank,
  targetBankMetrics,
  targetBankPresentation,
} from '../frontend/src/components/target-bank-metrics.mjs';
import {
  harvesterExtensionIdsFromSettings,
  normalizeHarvesterExtensionIds,
  parseHarvesterExtensionIds,
} from '../frontend/src/components/harvester-extension-ids.mjs';

assert.equal(normalizeHarvesterExtensionIds(
  `${'A'.repeat(32)}\n${'b'.repeat(32)}\n${'a'.repeat(32)}`),
`${'a'.repeat(32)}\n${'b'.repeat(32)}`);
assert.equal(harvesterExtensionIdsFromSettings({
  targetHarvesterExtensionIds: `${'b'.repeat(32)}\n${'c'.repeat(32)}`,
  targetHarvesterExtensionId: 'a'.repeat(32),
}), `${'b'.repeat(32)}\n${'c'.repeat(32)}\n${'a'.repeat(32)}`,
'merging a singular-ID backup must not hide it behind existing plural settings');
assert.match(parseHarvesterExtensionIds(
  `${'a'.repeat(32)}\nnot-an-extension-id\n${'b'.repeat(32)}`,
  { requireOne: true }).error, /line 2/);
assert.match(parseHarvesterExtensionIds('', { requireOne: true }).error, /at least one/);
const tooManyExtensionIds = Array.from({ length: 17 }, (_value, index) =>
  `${'a'.repeat(30)}${String.fromCharCode(97 + Math.floor(index / 16))}${String.fromCharCode(97 + (index % 16))}`);
assert.match(parseHarvesterExtensionIds(tooManyExtensionIds.join('\n'), { requireOne: true }).error,
  /no more than 16/);

assert.equal(targetBankMetrics(null).online, false);

const bank = {
  login: 2,
  atc: 7,
  proxies: 1200,
  lastBankedAt: 1700000000000,
  inFlight: { login: 0, atc: 1 },
  activity: {
    startedAt: 1234,
    produced: { login: 2, atc: 9 },
    delivered: { login: 0, atc: 2 },
    waiting: { login: 0, atc: 1 },
  },
  health: {
    workerState: 'running',
    activeWorkers: 3,
    configuredWorkers: 4,
    failures: { total: 3, byCategory: { timeout: 2, proxy: 1 } },
    quarantinedProxies: 2,
    cooldowns: { atc: { remainingMs: 8200 } },
    scaling: {
      policy: 'fixed', desiredWorkers: 4, hardLimit: 4,
      recentSamples: 10, recentErrors: 3, recentErrorRate: 0.3,
    },
  },
};

const metrics = targetBankMetrics(bank);
assert.deepEqual({
  login: metrics.login,
  atc: metrics.atc,
  proxies: metrics.proxies,
  workers: `${metrics.activeWorkers}/${metrics.workerLimit}`,
  farmed: metrics.farmedAtc,
  delivered: metrics.deliveredAtc,
  inFlight: metrics.inFlightAtc,
  recentErrors: `${metrics.recentErrors}/${metrics.recentSamples}`,
  cooling: metrics.quarantinedProxies,
  leadingFailure: metrics.leadingFailure.label,
  cooldown: metrics.atcCooldownSec,
  lastBankedAt: metrics.lastBankedAt,
}, {
  login: 2,
  atc: 7,
  proxies: 1200,
  workers: '3/4',
  farmed: 9,
  delivered: 2,
  inFlight: 1,
  recentErrors: '3/10',
  cooling: 2,
  leadingFailure: 'Timeout',
  cooldown: 9,
  lastBankedAt: 1700000000000,
});
assert.equal(sameTargetBank(bank, structuredClone(bank)), true);
assert.equal(metrics.workerState, 'running');
const changed = structuredClone(bank);
changed.atc += 1;
assert.equal(sameTargetBank(bank, changed), false);

const stoppedConfiguration = [{ id: 'target-main', enabled: false }];
const staleRuntimeBank = {
  login: 0,
  atc: 0,
  harvesters: [{ id: 'target-main', activeWorkers: 5 }],
};
const stopped = targetBankPresentation(staleRuntimeBank, stoppedConfiguration, { now: 1800000000000 });
assert.equal(stopped.state, 'stopped');
assert.equal(stopped.label, 'Harvesters stopped');
assert.equal(stopped.activeWorkers, 0, 'stopped configuration must override a stale runtime worker report');
assert.equal(stopped.brokerLabel, 'Broker online');
assert.match(stopped.description, /All harvesters are stopped/);

const harvesting = targetBankPresentation(staleRuntimeBank, [{ id: 'target-main', enabled: true }], { now: 1800000000000 });
assert.equal(harvesting.state, 'working');
assert.equal(harvesting.label, 'Harvesting');
assert.equal(harvesting.activeWorkers, 5);

const readyWhileStopped = targetBankPresentation(
  { ...staleRuntimeBank, login: 2, atc: 3 },
  stoppedConfiguration,
  { now: 1800000000000 },
);
assert.equal(readyWhileStopped.state, 'ready');
assert.equal(readyWhileStopped.label, 'Cookies ready');
assert.match(readyWhileStopped.description, /Harvesters are stopped/);

const scheduled = targetBankPresentation(staleRuntimeBank, [{
  id: 'later', enabled: true, startSchedule: '2030-01-01T00:00:00.000Z',
}], { now: Date.parse('2029-01-01T00:00:00.000Z') });
assert.equal(scheduled.state, 'scheduled');
assert.equal(scheduled.label, 'Waiting for schedule');

const dynamicDemand = {
  login: 2,
  atc: 7,
  targets: { login: 99, atc: 99 },
  demand: {
    mode: 'per-task',
    basis: 'active',
    activeTasks: 4,
    standbyTasks: 0,
    effectiveTasks: 4,
    atcPerTask: 3,
    targets: { login: 4, atc: 12 },
  },
  harvesters: [{ id: 'atc-main', activeWorkers: 2 }],
};
const dynamicMetrics = targetBankMetrics(dynamicDemand);
assert.deepEqual({
  demandReported: dynamicMetrics.demandReported,
  basis: dynamicMetrics.demandBasis,
  activeTasks: dynamicMetrics.activeTasks,
  effectiveTasks: dynamicMetrics.effectiveTasks,
  perTask: dynamicMetrics.atcPerTask,
  target: dynamicMetrics.atcTarget,
  deficit: dynamicMetrics.atcDeficit,
}, {
  demandReported: true,
  basis: 'active',
  activeTasks: 4,
  effectiveTasks: 4,
  perTask: 3,
  target: 12,
  deficit: 5,
}, 'canonical demand.targets must drive the renderer instead of the compatibility top-level target');

const atcHarvester = [{ id: 'atc-main', type: 'atc', enabled: true }];
const filling = targetBankPresentation(dynamicDemand, atcHarvester, { now: 1800000000000 });
assert.equal(filling.state, 'filling');
assert.equal(filling.label, 'Filling ATC bank');
assert.equal(filling.demandLabel, '3 per task · 4 active');
assert.match(filling.description, /7 of 12 ATC cookies ready/);

const readyDynamic = targetBankPresentation({ ...dynamicDemand, atc: 12 }, atcHarvester, { now: 1800000000000 });
assert.equal(readyDynamic.state, 'ready');
assert.equal(readyDynamic.label, 'ATC target ready');

const uncappedDemand = {
  ...dynamicDemand,
  atc: 40,
  demand: {
    ...dynamicDemand.demand,
    atcPerTask: 0,
    targets: { login: 4, atc: null },
  },
  targets: { login: 4, atc: null },
};
const uncappedMetrics = targetBankMetrics(uncappedDemand);
assert.equal(uncappedMetrics.atcUnlimited, true);
assert.equal(uncappedMetrics.atcTargetLabel, '∞');
assert.equal(uncappedMetrics.atcDeficit, 0);
assert.equal(uncappedMetrics.atcSurplus, 0);
const uncappedFilling = targetBankPresentation(uncappedDemand, atcHarvester, { now: 1800000000000 });
assert.equal(uncappedFilling.state, 'filling');
assert.equal(uncappedFilling.label, 'Filling uncapped ATC bank');
assert.equal(uncappedFilling.demandLabel, 'No limit · 4 active');
assert.match(uncappedFilling.description, /no bank limit is set/i);
const uncappedWithoutHarvester = targetBankPresentation(uncappedDemand, [], { now: 1800000000000 });
assert.equal(uncappedWithoutHarvester.state, 'deficit');
assert.equal(uncappedWithoutHarvester.label, 'Uncapped bank needs a harvester');

const pausedUncappedSetting = targetBankPresentation({
  ...uncappedDemand,
  demand: {
    ...uncappedDemand.demand,
    basis: 'paused', effectiveTasks: 0, targets: { login: 0, atc: 0 },
  },
  targets: { login: 0, atc: 0 },
}, atcHarvester, { now: 1800000000000 });
assert.equal(pausedUncappedSetting.state, 'paused', 'paused demand must override the zero/unlimited setting');
assert.equal(pausedUncappedSetting.demandLabel, 'No limit · paused');

const overTarget = targetBankPresentation({ ...dynamicDemand, atc: 14 }, atcHarvester, { now: 1800000000000 });
assert.equal(overTarget.state, 'over-target');
assert.equal(overTarget.atcSurplus, 2);
assert.match(overTarget.description, /Extra valid cookies are retained/);

const noAtcHarvester = targetBankPresentation(dynamicDemand, [{
  id: 'login-main', type: 'login', enabled: true,
}], { now: 1800000000000 });
assert.equal(noAtcHarvester.state, 'deficit');
assert.equal(noAtcHarvester.activeAtcHarvesters, 0);
assert.match(noAtcHarvester.description, /no active ATC-capable harvester/);

const now = 1800000000000;
const extensionConfigured = targetBankPresentation(dynamicDemand, [], {
  now, externalAtcHarvesterEnabled: true,
});
assert.equal(extensionConfigured.state, 'working');
assert.equal(extensionConfigured.label, 'Waiting for browser extensions');
assert.equal(extensionConfigured.activeHarvesters, 0,
  'an external extension must not corrupt managed-harvester totals');
assert.equal(extensionConfigured.activeAtcHarvesters, 0,
  'an external extension must not be presented as a managed ATC harvester');

const disabledExtensionWithStaleClients = targetBankPresentation({
  ...dynamicDemand,
  extensionHarvester: {
    enabled: false,
    configured: false,
    lastSeenAt: now - 1000,
    clientCount: 1,
    clients: [{
      id: 'stale-chrome-client',
      browser: 'Chrome',
      lastSeenAt: now - 1000,
      lastStatusAt: now - 1000,
    }],
  },
}, [], { now });
assert.equal(disabledExtensionWithStaleClients.extensionHarvesterEnabled, false);
assert.equal(disabledExtensionWithStaleClients.extensionHarvesterReachable, false);
assert.equal(disabledExtensionWithStaleClients.extensionHarvesterClientCount, 0);
assert.equal(disabledExtensionWithStaleClients.extensionHarvesterReachableCount, 0,
  'disabled extension activity must not expose stale clients as live');
assert.deepEqual(disabledExtensionWithStaleClients.extensionHarvesterBrowsers, []);
assert.equal(disabledExtensionWithStaleClients.extensionConnectionLabel, '');
assert.equal(disabledExtensionWithStaleClients.extensionConnectionCompactLabel, '');

const reachableExtensionBank = {
  ...dynamicDemand,
  extensionHarvester: {
    enabled: true, configured: true, listening: true,
    lastSeenAt: now - 5000, lastStatusAt: now - 5000,
    clientCount: 2,
    clients: [
      { id: 'chrome-client', browser: 'Chrome', lastSeenAt: now - 5000, lastStatusAt: now - 5000 },
      { id: 'brave-client', browser: 'Brave', lastSeenAt: now - 4000, lastStatusAt: now - 4000 },
    ],
  },
};
const extensionReachable = targetBankPresentation(reachableExtensionBank, [], { now });
assert.equal(extensionReachable.state, 'working');
assert.equal(extensionReachable.label, 'Waiting for browser cookies');
assert.equal(extensionReachable.extensionHarvesterReachable, true);
assert.equal(extensionReachable.extensionHarvesterReachableCount, 2);
assert.deepEqual(extensionReachable.extensionHarvesterBrowsers, ['Chrome', 'Brave']);
assert.match(extensionReachable.description, /2 browser harvesters are reachable/);

const extensionRecentlySaved = targetBankPresentation({
  ...reachableExtensionBank,
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    lastSavedAt: now - 5000, lastSavedType: 'atc', savedCount: 2,
    clients: reachableExtensionBank.extensionHarvester.clients.map(client => ({
      ...client, lastSavedAt: now - 5000, lastSavedType: 'atc', savedCount: 1,
    })),
  },
}, [], { now });
assert.equal(extensionRecentlySaved.state, 'filling');
assert.equal(extensionRecentlySaved.label, 'Filling ATC bank');
assert.equal(extensionRecentlySaved.extensionAtcRecentlySaved, true);
assert.match(extensionRecentlySaved.description, /2 browser harvesters recently saved an ATC cookie/);
assert.equal(extensionRecentlySaved.extensionConnectionLabel,
  '2 browser harvesters live (Chrome, Brave) · 2 accepted this session');
assert.equal(extensionRecentlySaved.extensionConnectionCompactLabel, '2 ext live · 2 saved');

const staleExtensionSave = targetBankPresentation({
  ...reachableExtensionBank,
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    lastSeenAt: now - 31000, lastStatusAt: now - 31000,
    lastSavedAt: now - 31000, lastSavedType: 'atc', savedCount: 2,
    clients: reachableExtensionBank.extensionHarvester.clients.map(client => ({
      ...client, lastSeenAt: now - 31000, lastStatusAt: now - 31000,
    })),
  },
}, [], { now });
assert.equal(staleExtensionSave.state, 'working');
assert.equal(staleExtensionSave.label, 'Waiting for browser extensions');
assert.equal(staleExtensionSave.extensionAtcRecentlySaved, false);

const recentLoginSave = targetBankPresentation({
  ...reachableExtensionBank,
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    lastSavedAt: now - 5000, lastSavedType: 'login', savedCount: 1,
  },
}, [], { now });
assert.equal(recentLoginSave.state, 'working', 'a login save must not claim the ATC bank is filling');

const mixedRecentSaves = targetBankPresentation({
  ...reachableExtensionBank,
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    // Brave saved login most recently, but Chrome's earlier ATC save is still inside the active window.
    lastSavedAt: now - 2000, lastSavedType: 'login', savedCount: 2,
    clients: [
      {
        ...reachableExtensionBank.extensionHarvester.clients[0],
        lastSavedAt: now - 10000, lastSavedType: 'atc', savedCount: 1,
      },
      {
        ...reachableExtensionBank.extensionHarvester.clients[1],
        lastSavedAt: now - 2000, lastSavedType: 'login', savedCount: 1,
      },
    ],
  },
}, [], { now });
assert.equal(mixedRecentSaves.state, 'filling',
  'a newer login save from one browser must not hide another browser\'s recent ATC save');
assert.match(mixedRecentSaves.description, /Chrome harvester recently saved an ATC cookie/);

const extensionReady = targetBankPresentation({
  ...reachableExtensionBank,
  atc: 12,
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    lastSavedAt: now - 5000, lastSavedType: 'atc', savedCount: 2,
  },
}, [], { now });
assert.equal(extensionReady.state, 'ready');
assert.equal(extensionReady.label, 'ATC target ready', 'bank readiness must outrank extension recency');

const extensionBrokerStarting = targetBankPresentation(null, [], {
  now, externalAtcHarvesterEnabled: true,
});
assert.equal(extensionBrokerStarting.state, 'offline');
assert.equal(extensionBrokerStarting.label, 'Broker offline',
  'configuration alone must not claim that a broker startup is in progress');

const tandemExtensionSave = targetBankPresentation({
  ...reachableExtensionBank,
  harvesters: [{ id: 'managed-atc', activeWorkers: 0 }],
  extensionHarvester: {
    ...reachableExtensionBank.extensionHarvester,
    lastSavedAt: now - 5000, lastSavedType: 'atc', savedCount: 1,
    clients: reachableExtensionBank.extensionHarvester.clients.map((client, index) => index === 0
      ? { ...client, lastSavedAt: now - 5000, lastSavedType: 'atc', savedCount: 1 }
      : client),
  },
}, [{ id: 'managed-atc', enabled: true, type: 'atc' }], { now });
assert.equal(tandemExtensionSave.label, 'Filling ATC bank');
assert.match(tandemExtensionSave.description, /The Chrome harvester also recently saved/,
  'tandem presentation must preserve visible extension attribution');

const pausedDynamic = targetBankPresentation({
  ...dynamicDemand,
  demand: {
    ...dynamicDemand.demand,
    basis: 'paused',
    activeTasks: 0,
    effectiveTasks: 0,
    targets: { login: 0, atc: 0 },
  },
}, atcHarvester, { now: 1800000000000 });
assert.equal(pausedDynamic.state, 'paused');
assert.equal(pausedDynamic.demandLabel, '3 per task · paused');
assert.match(pausedDynamic.description, /remain available until used or expired/);

// The recovered broker's compact payload remains supported while the renderer also accepts the
// richer upstream health payload above.
const compact = targetBankMetrics({ login: 5, atc: 8, proxies: 9 });
assert.deepEqual({
  online: compact.online,
  login: compact.login,
  atc: compact.atc,
  proxies: compact.proxies,
  activeWorkers: compact.activeWorkers,
  workerLimit: compact.workerLimit,
}, {
  online: true,
  login: 5,
  atc: 8,
  proxies: 9,
  activeWorkers: 0,
  workerLimit: 0,
});

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskGroups = fs.readFileSync(path.join(root, 'frontend/src/components/pages/task-groups.js'), 'utf8');
const targetPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/target.js'), 'utf8');
const settingsPage = fs.readFileSync(path.join(root, 'frontend/src/components/pages/settings.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'frontend/src/App.css'), 'utf8');
const rendererEntry = fs.readFileSync(path.join(root, 'frontend/src/index.js'), 'utf8');
assert.match(taskGroups, /ipcRenderer\.invoke\('targetCookieBank'\)/);
assert.match(taskGroups, /<small>Login<\/small>/);
assert.match(taskGroups, /<small>ATC<\/small>/);
assert.match(taskGroups, /<small>Shared Cookie Bank<\/small>/);
assert.match(taskGroups, /bank\.brokerLabel/);
assert.doesNotMatch(taskGroups, /Replay \$\{bank\.replay\.label\}/);
assert.doesNotMatch(taskGroups, /<small>Replay<\/small>/);
assert.match(taskGroups, /<span>ATC per task<\/span>/);
assert.doesNotMatch(taskGroups, /workerDescription/);
assert.doesNotMatch(taskGroups, /<small>Run output<\/small>/);
assert.doesNotMatch(taskGroups, /<small>Cooling routes<\/small>/);
assert.doesNotMatch(taskGroups, /<small>Top failure<\/small>/);
assert.doesNotMatch(taskGroups, /target-global-harvester-summary/);
assert.match(taskGroups, /aria-label="Target ATC cookies per task"/);
assert.match(taskGroups, /targetAtcCookiesPerTask/);
assert.match(taskGroups, /Set 0 for no bank limit/);
assert.doesNotMatch(taskGroups, /max="20"/);
assert.match(taskGroups, /min="0"/);
assert.match(taskGroups, /bank\.atcTargetLabel/);
assert.match(taskGroups, /const availableHarvesters = this\.state\.harvesters\.map\(harvester =>[\s\S]{0,180}enabled: false/,
  'main bank summary must not count harvesters whose proxy group is unavailable');
assert.match(taskGroups, /syncTargetHarvesters/);
assert.match(taskGroups, /bank\.atcTarget/);
assert.match(taskGroups, /bank\.demandLabel/);
assert.doesNotMatch(taskGroups, /Per-type limit/);
assert.match(taskGroups, /targetBankPresentation\(this\.state\.bank, availableHarvesters/);
assert.match(taskGroups, /extensionHarvesterConfigured = \(\) =>/);
assert.equal((taskGroups.match(/externalAtcHarvesterEnabled: this\.extensionHarvesterConfigured\(\)/g) || []).length, 1,
  'the harvester bank presentation must receive the configured extension source');
assert.match(taskGroups, /renderHarvesterDrawer\(\)/);
assert.match(taskGroups, /className=\{`target-harvester-rail/);
assert.match(taskGroups, /id="target-harvester-drawer"/);
assert.match(taskGroups, /aria-controls="target-harvester-drawer"/);
assert.match(taskGroups, /Proxy bandwidth/);
assert.match(taskGroups, /Total proxy data/);
assert.match(taskGroups, /heavy assets blocked/);
assert.match(taskGroups, /Per cookie/);
assert.match(taskGroups, /HARVESTER_DRAWER_STORAGE_KEY/);
assert.doesNotMatch(taskGroups, /renderHarvesterManager\(\)/);
assert.doesNotMatch(taskGroups, /workerLimit \|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);
assert.match(styles, /\.cookie-bank-prominent \{ display: grid; grid-template-columns:/,
  'prominent bank header must keep its controls on one grid row');
assert.match(styles, /\.cookie-bank-prominent \.cookie-bank-copy em \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
  'long bank status must truncate instead of wrapping the controls');
assert.match(styles, /\.cookie-bank-stopped/);
assert.match(styles, /\.cookie-bank-paused/);
assert.match(styles, /\.cookie-bank-filling/);
assert.match(styles, /\.cookie-bank-deficit/);
assert.match(styles, /\.cookie-bank-over-target/);
assert.match(styles, /\.cookie-bank-broker/);
assert.doesNotMatch(styles, /\.cookie-bank-health/);
assert.match(styles, /\.target-harvester-rail \{/);
assert.match(styles, /\.target-harvester-drawer \{/);
assert.match(styles, /\.target-harvester-drawer-content \{[^}]*overflow-y: auto;/);
const defaultDrawerLayer = styles.match(/\n\.target-harvester-drawer-layer \{[^}]+\}/)?.[0] || '';
const defaultModal = styles.match(/\n\.modal \{[^}]+\}/)?.[0] || '';
assert.doesNotMatch(defaultDrawerLayer, /backdrop-filter/);
assert.doesNotMatch(defaultModal, /backdrop-filter/);
assert.match(styles, /body\.platform-darwin \.target-harvester-drawer-layer \{[^}]*backdrop-filter/);
assert.match(styles, /body\.platform-darwin \.modal,\s*body\.platform-darwin \.glass-surface \{[^}]*backdrop-filter/);
assert.match(rendererEntry, /classList\.add\(`platform-\$\{platform\}`\)/);
assert.match(styles, /\.target-harvester-bandwidth-summary \{/);
assert.match(styles, /\.target-harvester-bandwidth \{ grid-area: bandwidth; \}/);
assert.match(targetPage, />ATC TASK<\/span>/);
assert.match(targetPage, /targetAtcCookiesPerTask/);
assert.match(targetPage, /Set 0 for no bank limit/);
assert.doesNotMatch(targetPage, /max="20"/);
assert.match(targetPage, /bankMetrics\.atcTargetLabel/);
assert.doesNotMatch(targetPage, />BANK SIZE<\/span>/);
assert.match(settingsPage, /ATC cookies per task/);
assert.match(settingsPage, /targetAtcCookiesPerTask/);
assert.match(settingsPage, /Set 0 for no bank limit/);
assert.doesNotMatch(settingsPage, /max="20"/);
assert.doesNotMatch(settingsPage, />Cookie bank size<\/label>/);

console.log('Target cookie-bank metrics smoke test passed');
