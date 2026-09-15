#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const taskGroups = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'pages', 'task-groups.js'),
  'utf8',
);
const taskRuntime = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'target-task-runtime.js'),
  'utf8',
);
const styles = fs.readFileSync(path.join(project, 'frontend', 'src', 'App.css'), 'utf8');
const bankMetrics = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'target-bank-metrics.mjs'),
  'utf8',
);

assert.match(taskGroups, /selectedTaskId: ''/);
assert.match(taskGroups, /renderTaskDetail\(group, task\)/);
assert.match(taskGroups, /className=\{`group-task-row group-task-row-clickable\$\{selected \? ' selected' : ''\}`\}/);
assert.match(taskGroups, /toggleSelectVisibleTasks/);
assert.match(taskGroups, /renderGroupDropPulse/);
assert.match(taskGroups, /TaskGroupDropBoard/);
assert.match(taskGroups, /openGroupBucket/);
assert.match(taskGroups, /showGroupOverview/);
assert.match(taskGroups, /groupView: running \? 'overview' : 'list'/);
assert.match(taskGroups, /drop-board/);
assert.equal(
  (taskGroups.match(/Manage tasks/g) || []).length,
  1,
  'overview should expose a single Manage tasks control in the page header',
);
assert.match(taskGroups, /Drop overview/);
assert.doesNotMatch(taskGroups, /drop-board-setup/);
assert.match(taskRuntime, /TARGET_DROP_BUCKETS/);
assert.match(taskRuntime, /taskMatchesDropBucket/);
assert.match(styles, /\.drop-board-card-atc\.active/);
assert.match(styles, /\.drop-board \{/);
assert.match(taskGroups, /renderProxySelectOptions/);
assert.match(taskGroups, /Folders/);
assert.match(taskRuntime, /summarizeGroupDropPulse/);
assert.match(taskGroups, /Adding to cart/);
assert.match(taskGroups, /Carted this wave/);
assert.match(taskGroups, /Successful checkouts this run/);
assert.match(taskGroups, /Failed this wave/);
assert.match(styles, /\.group-drop-pulse/);
assert.match(styles, /\.group-drop-stat-submit\.active/);
assert.match(styles, /\.group-drop-stat-fail\.active/);
assert.match(styles, /\.target-task-status-watching \{ color: var\(--target-status-watch\)/);
assert.doesNotMatch(styles, /\.target-task-status-idle,\s*\.target-task-status-watching/);
assert.match(taskGroups, /updateTasksProxy/);
assert.match(taskGroups, /Set proxy/);
assert.match(taskGroups, /Select all visible tasks/);
assert.match(taskGroups, /setSkuPriority/);
assert.match(taskGroups, /watchListSummary/);
assert.match(taskGroups, /Mark as priority/);
assert.match(taskGroups, /addWatchedSkus/);
assert.match(taskGroups, /removeSku/);
assert.match(taskGroups, /aria-label=\{`Remove Target SKU \$\{sku\}`\}/);
assert.doesNotMatch(taskGroups, /group-sku-input/);
assert.match(styles, /\.target-sku-priority/);
assert.match(styles, /\.target-sku-watch-row/);
assert.match(styles, /\.target-sku-remove/);
assert.match(styles, /\.group-task-bulk-bar/);
assert.match(taskGroups, /openTask = task => this\.setState\(\{ selectedTaskId: task\.id/);
assert.match(taskGroups, /host\.openTask\(task\)/);
assert.match(taskRuntime, /export function mapTaskRowShellState/);
assert.match(taskGroups, /connect\(mapTaskRowShellState\)/);
assert.match(taskGroups, /TaskGroupTaskLiveCells/);
assert.doesNotMatch(
  (taskGroups.match(/class TaskGroupTaskLiveCellsView[\s\S]*?const TaskGroupTaskLiveCells/) || [''])[0],
  /InlineSelect/,
  'status paints must not remount the per-task proxy select',
);
assert.match(
  (taskGroups.match(/class TaskGroupTaskRowView[\s\S]*?const TaskGroupTaskRow/) || [''])[0],
  /InlineSelect/,
);
assert.match(taskGroups, /targetTaskSessionCaption\(account, this\.props\.proxyStatus \|\| status, otpRequest\)/,
  'task rows do not show a saved-session label');
assert.match(styles, /\.task-session-signed-in/);
assert.match(taskGroups, /this\.props\.taskLogs/);
assert.match(taskGroups, /only this task/);
assert.match(taskGroups, /Broker, farmer, and monitor startup remain in the shared log below/);
assert.match(taskGroups, /<SharedEngineLog/);
assert.match(taskGroups, /renderSharedEngineLog\(source = this\.props\)/);
assert.match(taskGroups, /<VirtualLogView/);
assert.match(taskGroups, /showOperatorLogs/);
assert.match(taskGroups, /<GroupMonitorStatus/);
assert.match(taskGroups, /<GroupMonitorStatus hideLabel/);
assert.doesNotMatch(
  taskGroups.replace(/renderGroupMonitor[\s\S]*?renderGroupFacts/, ''),
  /renderGroupFacts[\s\S]*?<GroupMonitorStatus \/>/,
  'group header facts must not repeat the live monitor status chip',
);
assert.match(styles, /\.group-ops-monitor-watching/);
assert.match(styles, /\.group-ops-monitor \{/);
assert.match(styles, /\.task-log-view-virtual/);
assert.match(styles, /\.task-log-virtual-pad/);
assert.match(taskGroups, /this\.renderHarvesterDrawer\(\)/);
assert.match(taskGroups, /aria-label="Close Cookie Harvesters"/);
assert.match(bankMetrics, /Opening the shared cookie bank/);
assert.doesNotMatch(taskGroups, /Wine, Windows Node, and the cookie broker are starting/);
assert.doesNotMatch(taskGroups, /\|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);
assert.match(styles, /\.group-task-row-clickable:focus-visible/);
assert.match(styles, /\.cookie-bank-starting/);
assert.match(styles, /\.cookie-bank-error/);
assert.match(styles, /\.cookie-bank-stopped/);
assert.match(styles, /\.cookie-bank-broker/);
assert.doesNotMatch(styles, /\.cookie-bank-health/);
assert.match(styles, /\.tasks-workspace-with-harvester-dock/);
assert.match(styles, /\.target-harvester-drawer-layer/);

console.log('Target task-group detail and broker-startup smoke test passed');
