#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyTargetMonitorBandwidthState,
  normalizeTargetMonitorBandwidth,
  reduceTargetMonitorBandwidth,
  stopTargetMonitorBandwidthRuns,
  targetMonitorBandwidthSummary,
} from '../frontend/src/components/target-monitor-bandwidth.mjs';

const BASE_TIME = 1_800_000_000_000;

function sample(overrides = {}) {
  const downloadBytes = overrides.downloadBytes == null ? 0 : overrides.downloadBytes;
  const uploadBytes = overrides.uploadBytes == null ? 0 : overrides.uploadBytes;
  const proxyDownloadBytes = overrides.proxyDownloadBytes == null ? downloadBytes : overrides.proxyDownloadBytes;
  const proxyUploadBytes = overrides.proxyUploadBytes == null ? uploadBytes : overrides.proxyUploadBytes;
  const directDownloadBytes = overrides.directDownloadBytes == null
    ? downloadBytes - proxyDownloadBytes : overrides.directDownloadBytes;
  const directUploadBytes = overrides.directUploadBytes == null
    ? uploadBytes - proxyUploadBytes : overrides.directUploadBytes;
  return {
    schemaVersion: 1,
    measurement: 'tls-client-wire',
    monitorId: 'target-monitor',
    runId: 'main-1',
    site: 'Target',
    startedAt: BASE_TIME,
    observedAt: BASE_TIME,
    sequence: 1,
    running: true,
    downloadBytes,
    uploadBytes,
    totalBytes: downloadBytes + uploadBytes,
    proxyDownloadBytes,
    proxyUploadBytes,
    directDownloadBytes,
    directUploadBytes,
    polls: 0,
    failedPolls: 0,
    watchedItems: 3,
    ...overrides,
  };
}

let state = emptyTargetMonitorBandwidthState();
assert.deepEqual(targetMonitorBandwidthSummary(state, BASE_TIME), { available: false },
  'an old engine with no samples must not render an authoritative zero');

const first = sample();
assert.ok(normalizeTargetMonitorBandwidth(first));
state = reduceTargetMonitorBandwidth(state, first);
assert.equal(targetMonitorBandwidthSummary(state, BASE_TIME).totalBytes, 0,
  'the engine start sample makes a real zero authoritative');

const measured = sample({
  sequence: 2,
  observedAt: BASE_TIME + 3_600_000,
  downloadBytes: 3_600_000,
  uploadBytes: 400_000,
  totalBytes: 4_000_000,
  proxyDownloadBytes: 3_000_000,
  proxyUploadBytes: 300_000,
  directDownloadBytes: 600_000,
  directUploadBytes: 100_000,
  polls: 100,
  failedPolls: 2,
});
state = reduceTargetMonitorBandwidth(state, measured);
let summary = targetMonitorBandwidthSummary(state, BASE_TIME + 3_600_000);
assert.equal(summary.downloadBytes, 3_600_000);
assert.equal(summary.uploadBytes, 400_000);
assert.equal(summary.proxyBytes, 3_300_000);
assert.equal(summary.directBytes, 700_000);
assert.equal(summary.polls, 100);
assert.equal(summary.failedPolls, 2);
assert.equal(summary.bytesPerHour, 4_000_000);

const beforeStale = state;
state = reduceTargetMonitorBandwidth(state, sample({
  sequence: 2,
  observedAt: BASE_TIME + 3_700_000,
  downloadBytes: 9_000_000,
  totalBytes: 9_000_000,
  proxyDownloadBytes: 9_000_000,
}));
assert.equal(state, beforeStale, 'a duplicate/stale sequence must be ignored by reference');
assert.equal(targetMonitorBandwidthSummary(state, BASE_TIME + 3_700_000).totalBytes, 4_000_000,
  'a cumulative retry must replace nothing and never double count');

const editStart = BASE_TIME + 1_800_000;
state = reduceTargetMonitorBandwidth(state, sample({
  monitorId: 'target-monitor-edit-1',
  runId: 'edit-1',
  startedAt: editStart,
  observedAt: BASE_TIME + 3_600_000,
  downloadBytes: 600_000,
  uploadBytes: 50_000,
  totalBytes: 650_000,
  proxyDownloadBytes: 0,
  proxyUploadBytes: 0,
  directDownloadBytes: 600_000,
  directUploadBytes: 50_000,
  polls: 8,
  watchedItems: 1,
}));
summary = targetMonitorBandwidthSummary(state, BASE_TIME + 3_600_000);
assert.equal(summary.runCount, 2, 'the main and overlapping live-edit monitors are both represented');
assert.equal(summary.totalBytes, 4_650_000);
assert.equal(summary.polls, 108);
assert.equal(summary.watchedItems, 3, 'overlapping workers must not double-count watched items');

state = reduceTargetMonitorBandwidth(state, sample({
  monitorId: 'target-monitor-edit-1',
  runId: 'edit-1',
  startedAt: editStart,
  observedAt: BASE_TIME + 3_700_000,
  sequence: 2,
  running: false,
  downloadBytes: 700_000,
  uploadBytes: 60_000,
  totalBytes: 760_000,
  proxyDownloadBytes: 0,
  proxyUploadBytes: 0,
  directDownloadBytes: 700_000,
  directUploadBytes: 60_000,
  polls: 9,
  watchedItems: 1,
}));
assert.equal(targetMonitorBandwidthSummary(state, BASE_TIME + 4_000_000).totalBytes, 4_760_000,
  'a completed overlapping worker remains part of this run');

const oldMain = state.runs['main-1'];
state = reduceTargetMonitorBandwidth(state, sample({
  runId: 'main-2',
  startedAt: BASE_TIME + 7_200_000,
  observedAt: BASE_TIME + 7_200_000,
  watchedItems: 5,
}));
summary = targetMonitorBandwidthSummary(state, BASE_TIME + 7_200_000);
assert.equal(summary.totalBytes, 0, 'completed live edits before the new main run must not leak into it');
assert.equal(summary.runCount, 1);

let postScanEditState = reduceTargetMonitorBandwidth(emptyTargetMonitorBandwidthState(), sample({
  runId: 'post-scan-main',
  observedAt: BASE_TIME + 1_000,
  sequence: 2,
  running: false,
  downloadBytes: 100,
  totalBytes: 100,
  proxyDownloadBytes: 100,
}));
postScanEditState = reduceTargetMonitorBandwidth(postScanEditState, sample({
  monitorId: 'target-monitor-edit-after-main',
  runId: 'post-scan-edit',
  startedAt: BASE_TIME + 5_000,
  observedAt: BASE_TIME + 6_000,
  running: true,
  downloadBytes: 50,
  totalBytes: 50,
  proxyDownloadBytes: 0,
  directDownloadBytes: 50,
  watchedItems: 1,
}));
const postScanSummary = targetMonitorBandwidthSummary(postScanEditState, BASE_TIME + 6_000);
assert.equal(postScanSummary.running, true,
  'a live-edit scan after the main shared scan is hidden as already complete');
assert.equal(postScanSummary.runCount, 2);
assert.equal(postScanSummary.totalBytes, 150,
  'a live-edit scan after the main shared scan is omitted from this-run bandwidth');

let crossingGenerationState = reduceTargetMonitorBandwidth(emptyTargetMonitorBandwidthState(), sample({
  runId: 'crossing-main-old',
  observedAt: BASE_TIME + 1_000,
  sequence: 2,
  running: false,
  downloadBytes: 100,
  totalBytes: 100,
  proxyDownloadBytes: 100,
}));
crossingGenerationState = reduceTargetMonitorBandwidth(crossingGenerationState, sample({
  monitorId: 'target-monitor-edit-crossing',
  runId: 'crossing-edit-old',
  startedAt: BASE_TIME + 5_000,
  observedAt: BASE_TIME + 20_000,
  running: false,
  downloadBytes: 75,
  totalBytes: 75,
  proxyDownloadBytes: 0,
  directDownloadBytes: 75,
  watchedItems: 1,
}));
crossingGenerationState = reduceTargetMonitorBandwidth(crossingGenerationState, sample({
  runId: 'crossing-main-new',
  startedAt: BASE_TIME + 10_000,
  observedAt: BASE_TIME + 10_000,
  watchedItems: 2,
}));
const crossingGenerationSummary = targetMonitorBandwidthSummary(
  crossingGenerationState,
  BASE_TIME + 20_000,
);
assert.equal(crossingGenerationSummary.runCount, 1,
  'an edit that began under the previous main generation leaked into the replacement run');
assert.equal(crossingGenerationSummary.totalBytes, 0);

state = reduceTargetMonitorBandwidth(state, {
  ...oldMain,
  sequence: oldMain.sequence + 1,
  observedAt: BASE_TIME + 7_300_000,
});
assert.equal(state.mainRunId, 'main-2', 'a delayed old-main heartbeat must not replace the newer run');

const beforeMalformed = state;
state = reduceTargetMonitorBandwidth(state, sample({
  runId: 'bad-total',
  startedAt: BASE_TIME + 8_000_000,
  observedAt: BASE_TIME + 8_000_000,
  totalBytes: 1,
}));
assert.equal(state, beforeMalformed, 'internally inconsistent byte totals are rejected');
assert.equal(normalizeTargetMonitorBandwidth(sample({ failedPolls: 2, polls: 1 })), null);
assert.equal(normalizeTargetMonitorBandwidth(sample({ sequence: -1 })), null);
assert.equal(normalizeTargetMonitorBandwidth(sample({ site: 'Walmart' })), null);

state = stopTargetMonitorBandwidthRuns(state);
summary = targetMonitorBandwidthSummary(state, BASE_TIME + 8_000_000);
assert.equal(summary.running, false,
  'a module-level shutdown must not leave stale runs displaying Measuring forever');
assert.equal(summary.incomplete, true,
  'a module-level shutdown without a native final sample must remain visibly provisional');
const locallyStopped = state;
state = reduceTargetMonitorBandwidth(state, sample({
  runId: 'main-2',
  startedAt: BASE_TIME + 7_200_000,
  observedAt: BASE_TIME + 7_400_000,
  sequence: 2,
  running: false,
  downloadBytes: 200_000,
  uploadBytes: 20_000,
  totalBytes: 220_000,
  proxyDownloadBytes: 200_000,
  proxyUploadBytes: 20_000,
  polls: 2,
  watchedItems: 5,
}));
assert.notEqual(state, locallyStopped, 'a real final sample may refine a locally stopped run');
summary = targetMonitorBandwidthSummary(state, BASE_TIME + 8_000_000);
assert.equal(summary.totalBytes, 220_000);
assert.equal(summary.incomplete, false,
  'a genuine terminal sample must replace the provisional local-stop state');
state = reduceTargetMonitorBandwidth(state, sample({
  runId: 'main-3',
  startedAt: BASE_TIME + 9_000_000,
  observedAt: BASE_TIME + 9_000_000,
}));
assert.equal(state.mainRunId, 'main-3');
assert.equal(targetMonitorBandwidthSummary(state, BASE_TIME + 9_000_000).running, true,
  'a later engine run with a new ID must start measuring normally');

let longRunState = reduceTargetMonitorBandwidth(emptyTargetMonitorBandwidthState(), sample({
  runId: 'long-main',
  downloadBytes: 1,
  totalBytes: 1,
  proxyDownloadBytes: 1,
}));
for (let index = 0; index < 40; index += 1) {
  longRunState = reduceTargetMonitorBandwidth(longRunState, sample({
    monitorId: `target-monitor-edit-${index}`,
    runId: `long-edit-${index}`,
    startedAt: BASE_TIME + index + 1,
    observedAt: BASE_TIME + index + 2,
    running: false,
    downloadBytes: 1,
    totalBytes: 1,
    proxyDownloadBytes: 0,
    directDownloadBytes: 1,
    watchedItems: 1,
  }));
}
summary = targetMonitorBandwidthSummary(longRunState, BASE_TIME + 1_000);
assert.equal(summary.totalBytes, 41,
  'many completed live-edit monitors must never make this-run bandwidth decrease');
assert.equal(summary.runCount, 41,
  'all live-edit monitors contributing to the selected main run must remain represented');
longRunState = reduceTargetMonitorBandwidth(longRunState, sample({
  runId: 'long-main-next',
  startedAt: BASE_TIME + 10_000,
  observedAt: BASE_TIME + 10_000,
}));
assert.ok(Object.keys(longRunState.runs).length <= 33,
  'irrelevant historical runs must be bounded after a newer main run begins');

const maximum = Number.MAX_SAFE_INTEGER;
let saturatedState = reduceTargetMonitorBandwidth(emptyTargetMonitorBandwidthState(), sample({
  runId: 'saturated-main',
  downloadBytes: maximum,
  totalBytes: maximum,
  proxyDownloadBytes: maximum,
}));
saturatedState = reduceTargetMonitorBandwidth(saturatedState, sample({
  monitorId: 'target-monitor-edit-saturated',
  runId: 'saturated-edit',
  startedAt: BASE_TIME + 1,
  observedAt: BASE_TIME + 2,
  running: false,
  downloadBytes: 1,
  totalBytes: 1,
  proxyDownloadBytes: 0,
  directDownloadBytes: 1,
  watchedItems: 1,
}));
summary = targetMonitorBandwidthSummary(saturatedState, BASE_TIME + 3);
assert.equal(summary.saturated, true, 'an aggregate beyond the safe display range must be marked');
assert.equal(summary.totalBytes, maximum);
assert.equal(summary.downloadBytes + summary.uploadBytes, summary.totalBytes,
  'display-capped direction totals must remain internally coherent');
assert.equal(summary.proxyBytes + summary.directBytes, summary.totalBytes,
  'display-capped route totals must remain internally coherent');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const pageHandler = read('frontend/src/components/page-handler.js');
const store = read('frontend/src/components/store.js');
const taskGroups = read('frontend/src/components/pages/task-groups.js');
const appCss = read('frontend/src/App.css');
assert.match(pageHandler, /ipcRenderer\.on\('targetMonitorBandwidth'/);
assert.match(pageHandler, /removeAllListeners\('targetMonitorBandwidth'\)/);
assert.match(store, /case 'targetMonitorBandwidth':/);
assert.match(store, /reduceTargetMonitorBandwidth\(previous, action\.payload\)/);
assert.match(store, /monitorBandwidth: stopTargetMonitorBandwidthRuns\(state\.target\.monitorBandwidth\)/);
assert.match(taskGroups, /targetMonitorBandwidthSummary\(target\.monitorBandwidth, Date\.now\(\)\)/);
assert.match(taskGroups, /TLS transport bytes measured by the monitor engine|TARGET_MONITOR_BANDWIDTH_TOOLTIP/);
assert.match(taskGroups, /aria-describedby="target-monitor-bandwidth-description"/);
assert.match(taskGroups, /id="target-monitor-bandwidth-description"/);
assert.doesNotMatch(taskGroups, /title=\{TARGET_MONITOR_BANDWIDTH_TOOLTIP\}/,
  'measurement semantics must not be available only through a pointer-hover title');
assert.match(taskGroups, /Bandwidth not measured yet/);
assert.match(taskGroups, /No traffic is being shown as zero/);
assert.match(taskGroups, /monitor runs/);
assert.doesNotMatch(taskGroups, /overlapping monitors/);
assert.match(taskGroups, /Stopped · last sample/,
  'a missing terminal sample must not be described as an exact completed run');
assert.match(taskGroups, /Display limit reached/,
  'safe-integer saturation must be disclosed in the visible bandwidth UI');
assert.match(taskGroups, /bandwidth\.polls\.toLocaleString\(\)\} poll/,
  'the primary poll count must be explicitly labelled');
assert.match(appCss, /\.engine-monitor-bandwidth-stats/);
assert.match(appCss, /\.engine-monitor-bandwidth-note/);

console.log('Target monitor cumulative bandwidth reducer and aggregation passed');
